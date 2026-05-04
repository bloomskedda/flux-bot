if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const fs = require("fs");
const cron = require("node-cron");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const CHANNELS_FILE = "./channels.json";
const STATS_FILE = "./stats.json";
const MONITORS_FILE = "./monitors.json";
const PREFIX = "!";
const FLUX_PURPLE = 0x7b2cff;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function loadJson(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadChannels() {
  return loadJson(CHANNELS_FILE);
}

function saveChannels(channels) {
  saveJson(CHANNELS_FILE, channels);
}

function loadStats() {
  return loadJson(STATS_FILE);
}

function saveStats(stats) {
  saveJson(STATS_FILE, stats);
}

function loadMonitors() {
  return loadJson(MONITORS_FILE);
}

function saveMonitors(monitors) {
  saveJson(MONITORS_FILE, monitors);
}

function formatNumber(num) {
  if (num === null || num === undefined) return "Hidden";
  return Number(num).toLocaleString();
}

function getMedal(index) {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return `#${index + 1}`;
}

async function getChannelFromUrl(url) {
  let apiUrl;

  if (url.includes("/channel/")) {
    const channelId = url.split("/channel/")[1].split(/[/?#]/)[0];
    apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&id=${channelId}&key=${process.env.YOUTUBE_API_KEY}`;
  } else if (url.includes("@")) {
    const handle = url.split("@")[1].split(/[/?#]/)[0];
    apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&forHandle=@${handle}&key=${process.env.YOUTUBE_API_KEY}`;
  } else {
    throw new Error("Unsupported YouTube URL");
  }

  const res = await fetch(apiUrl);
  const data = await res.json();

  if (!data.items || data.items.length === 0) {
    throw new Error("Channel not found");
  }

  const channel = data.items[0];

  return {
    url,
    channelId: channel.id,
    name: channel.snippet.title,
    avatar: channel.snippet.thumbnails.high.url,
    uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads,
    subscribers: channel.statistics.hiddenSubscriberCount
      ? null
      : Number(channel.statistics.subscriberCount),
    views: Number(channel.statistics.viewCount),
    videos: Number(channel.statistics.videoCount),
    addedAt: Date.now(),
  };
}

async function fetchChannelStats(channelId) {
  const apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${process.env.YOUTUBE_API_KEY}`;

  const res = await fetch(apiUrl);
  const data = await res.json();

  if (!data.items || data.items.length === 0) return null;

  const stats = data.items[0].statistics;

  return {
    views: Number(stats.viewCount),
    subscribers: stats.hiddenSubscriberCount
      ? null
      : Number(stats.subscriberCount),
  };
}

async function getLatestVideo(uploadsPlaylistId) {
  const apiUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=1&key=${process.env.YOUTUBE_API_KEY}`;

  const res = await fetch(apiUrl);
  const data = await res.json();

  if (!data.items || data.items.length === 0) return null;

  const item = data.items[0].snippet;
  const videoId = item.resourceId.videoId;

  return {
    videoId,
    title: item.title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnail: item.thumbnails?.high?.url || item.thumbnails?.default?.url,
    publishedAt: item.publishedAt,
  };
}

async function updateStats() {
  console.log("Updating channel stats...");

  const channels = loadChannels();
  const statsHistory = loadStats();

  for (const channel of channels) {
    try {
      const stats = await fetchChannelStats(channel.channelId);
      if (!stats) continue;

      statsHistory.push({
        channelId: channel.channelId,
        views: stats.views,
        subscribers: stats.subscribers,
        timestamp: Date.now(),
      });

      console.log(`Updated ${channel.name}`);
    } catch {
      console.log(`Failed to update ${channel.name}`);
    }
  }

  saveStats(statsHistory);
}

async function checkUploads() {
  console.log("Checking monitored uploads...");

  const monitors = loadMonitors();
  let changed = false;

  for (const monitor of monitors) {
    try {
      const latest = await getLatestVideo(monitor.uploadsPlaylistId);
      if (!latest) continue;

      if (!monitor.lastVideoId) {
        monitor.lastVideoId = latest.videoId;
        changed = true;
        continue;
      }

      if (latest.videoId !== monitor.lastVideoId) {
        monitor.lastVideoId = latest.videoId;
        changed = true;

        const webhook = await client.fetchWebhook(
          monitor.webhookId,
          monitor.webhookToken
        );

        const embed = new EmbedBuilder()
          .setTitle("New Upload Detected")
          .setDescription(`**${monitor.youtubeName}** uploaded a new video.`)
          .setColor(FLUX_PURPLE)
          .setThumbnail(monitor.youtubeAvatar)
          .setImage(latest.thumbnail)
          .addFields(
            {
              name: "Video",
              value: `[${latest.title}](${latest.url})`,
            },
            {
              name: "Channel",
              value: `[${monitor.youtubeName}](${monitor.youtubeUrl})`,
            }
          )
          .setFooter({ text: "Flux • YouTube upload monitor" })
          .setTimestamp(new Date(latest.publishedAt));

        await webhook.send({
          username: "Flux",
          avatarURL: client.user.displayAvatarURL(),
          embeds: [embed],
        });

        console.log(`New upload sent for ${monitor.youtubeName}`);
      }
    } catch {
      console.log(`Upload check failed for ${monitor.youtubeName}`);
    }
  }

  if (changed) saveMonitors(monitors);
}

function getLeaderboard(periodMs) {
  const stats = loadStats();
  const channels = loadChannels();
  const cutoff = Date.now() - periodMs;
  const results = [];

  for (const channel of channels) {
    const history = stats
      .filter((s) => s.channelId === channel.channelId)
      .sort((a, b) => a.timestamp - b.timestamp);

    const recent = history[history.length - 1];
    const old = history.find((s) => s.timestamp >= cutoff);

    if (!recent || !old) continue;

    results.push({
      name: channel.name,
      url: channel.url,
      avatar: channel.avatar,
      gain: recent.views - old.views,
      views: recent.views,
      subscribers: recent.subscribers,
    });
  }

  return results.sort((a, b) => b.gain - a.gain);
}

function buildLeaderboardEmbed() {
  const data = getLeaderboard(24 * 60 * 60 * 1000).slice(0, 10);

  const embed = new EmbedBuilder()
    .setTitle("Top Channels - 24 Hours")
    .setDescription("View count gains for the last 24 hours")
    .setColor(FLUX_PURPLE)
    .setFooter({ text: "Flux • Updates every 1 minute" })
    .setTimestamp();

  if (data.length > 0 && data[0].avatar) {
    embed.setThumbnail(data[0].avatar);
  }

  if (data.length === 0) {
    embed.addFields({
      name: "No data yet",
      value: "Wait a bit for stats to be collected.",
    });
    return embed;
  }

  data.forEach((channel, index) => {
    embed.addFields({
      name: `${getMedal(index)} [${channel.name}](${channel.url})`,
      value:
        `📊 **+${formatNumber(channel.gain)}** views\n` +
        `🎯 **${formatNumber(channel.views)}** total views\n` +
        `👥 **${formatNumber(channel.subscribers)}** subscribers`,
    });
  });

  return embed;
}

function buildCommandsEmbed() {
  return new EmbedBuilder()
    .setTitle("Flux Commands")
    .setDescription("Here are all available Flux commands.")
    .setColor(FLUX_PURPLE)
    .addFields(
      {
        name: "!add <YouTube channel URL>",
        value: "Adds a YouTube channel to the stats tracker.",
      },
      {
        name: "!leaderboard",
        value: "Shows the top tracked channels by view gains in the last 24 hours.",
      },
      {
        name: "!monitoradd <Discord channel ID> <YouTube channel URL>",
        value: "Monitors a YouTube channel and sends new upload notifications using a webhook.",
      },
      {
        name: "!monitorremove <YouTube channel URL>",
        value: "Removes a YouTube channel from upload monitoring.",
      },
      {
        name: "!testnotify",
        value: "Sends a test upload notification using the first monitor.",
      },
      {
        name: "!commands",
        value: "Shows this command list.",
      }
    )
    .setFooter({ text: "Flux • YouTube tracking system" })
    .setTimestamp();
}

async function sendTestNotification(message) {
  const monitors = loadMonitors();

  if (monitors.length === 0) {
    return message.reply("No monitors found. Add one first with `!monitoradd <Discord channel ID> <YouTube channel URL>`.");
  }

  try {
    const monitor = monitors[0];

    const webhook = await client.fetchWebhook(
      monitor.webhookId,
      monitor.webhookToken
    );

    const embed = new EmbedBuilder()
      .setTitle("Test Notification")
      .setDescription("This is a test upload notification from Flux.")
      .setColor(FLUX_PURPLE)
      .setThumbnail(monitor.youtubeAvatar)
      .setImage("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
      .addFields(
        {
          name: "Video",
          value: "[Test Video Title](https://youtube.com/watch?v=dQw4w9WgXcQ)",
        },
        {
          name: "Channel",
          value: `[${monitor.youtubeName}](${monitor.youtubeUrl})`,
        }
      )
      .setFooter({ text: "Flux • Test notification" })
      .setTimestamp();

    await webhook.send({
      username: "Flux",
      avatarURL: client.user.displayAvatarURL(),
      embeds: [embed],
    });

    return message.reply("✅ Test notification sent.");
  } catch (error) {
    console.error(error);
    return message.reply("❌ Failed to send test notification.");
  }
}

client.once("ready", async () => {
  console.log(`Bot is online as ${client.user.tag}`);

  await updateStats();
  await checkUploads();

  cron.schedule("*/1 * * * *", async () => {
    await updateStats();
    await checkUploads();
  });
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === "commands") {
    return message.reply({ embeds: [buildCommandsEmbed()] });
  }

  if (command === "testnotify") {
    return sendTestNotification(message);
  }

  if (command === "add") {
    const url = args[0];
    if (!url) return message.reply("Use: `!add <YouTube channel URL>`");

    try {
      const channels = loadChannels();
      const channel = await getChannelFromUrl(url);

      if (channels.some((c) => c.channelId === channel.channelId)) {
        return message.reply("Already tracked.");
      }

      channels.push(channel);
      saveChannels(channels);
      await updateStats();

      return message.reply(`Added **${channel.name}**`);
    } catch (error) {
      console.error(error);
      return message.reply("Error adding channel.");
    }
  }

  if (command === "leaderboard") {
    return message.reply({ embeds: [buildLeaderboardEmbed()] });
  }

  if (command === "monitoradd") {
    const discordChannelId = args[0];
    const youtubeUrl = args[1];

    if (!discordChannelId || !youtubeUrl) {
      return message.reply(
        "Use: `!monitoradd <Discord channel ID> <YouTube channel URL>`"
      );
    }

    try {
      const discordChannel = await client.channels.fetch(discordChannelId);

      if (!discordChannel || !discordChannel.isTextBased()) {
        return message.reply("That Discord channel ID is not valid.");
      }

      const youtubeChannel = await getChannelFromUrl(youtubeUrl);
      const latest = await getLatestVideo(youtubeChannel.uploadsPlaylistId);

      const monitors = loadMonitors();

      if (monitors.some((m) => m.youtubeChannelId === youtubeChannel.channelId)) {
        return message.reply("That YouTube channel is already being monitored.");
      }

      const webhook = await discordChannel.createWebhook({
        name: "Flux",
        avatar: client.user.displayAvatarURL(),
      });

      monitors.push({
        discordChannelId,
        youtubeUrl,
        youtubeChannelId: youtubeChannel.channelId,
        youtubeName: youtubeChannel.name,
        youtubeAvatar: youtubeChannel.avatar,
        uploadsPlaylistId: youtubeChannel.uploadsPlaylistId,
        webhookId: webhook.id,
        webhookToken: webhook.token,
        lastVideoId: latest ? latest.videoId : null,
        addedAt: Date.now(),
      });

      saveMonitors(monitors);

      return message.reply(
        `✅ Monitoring **${youtubeChannel.name}**.\nNew upload notifications will be sent in <#${discordChannelId}>.`
      );
    } catch (error) {
      console.error(error);
      return message.reply(
        "Could not create monitor. Make sure Flux has **Manage Webhooks** permission in that channel."
      );
    }
  }

  if (command === "monitorremove") {
    const youtubeUrl = args[0];

    if (!youtubeUrl) {
      return message.reply("Use: `!monitorremove <YouTube channel URL>`");
    }

    try {
      const youtubeChannel = await getChannelFromUrl(youtubeUrl);
      let monitors = loadMonitors();

      const before = monitors.length;
      monitors = monitors.filter(
        (m) => m.youtubeChannelId !== youtubeChannel.channelId
      );

      if (monitors.length === before) {
        return message.reply("That YouTube channel is not being monitored.");
      }

      saveMonitors(monitors);

      return message.reply(`✅ Removed monitor for **${youtubeChannel.name}**.`);
    } catch {
      return message.reply("Could not remove monitor.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);