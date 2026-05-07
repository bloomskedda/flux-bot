if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const cron = require("node-cron");
const { Pool } = require("pg");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const PREFIX = "!";
const MOD_PREFIX = "?";
const FLUX_PURPLE = 0x7b2cff;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function formatNumber(num) {
  if (num === null || num === undefined) return "Hidden";
  return Number(num).toLocaleString();
}

function formatSigned(num) {
  const n = Number(num || 0);
  return `${n >= 0 ? "+" : ""}${formatNumber(n)}`;
}

function formatPercent(current, previous) {
  if (!previous || previous === 0) return "No previous data";
  const percent = ((current - previous) / previous) * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function getMedal(index) {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return `#${index + 1}`;
}

function getLeaderboardSettings(periodArg) {
  if (periodArg === "weekly") {
    return {
      title: "Top Channels - Weekly",
      description: "View count gains for the last 7 days",
      ms: 7 * 24 * 60 * 60 * 1000,
    };
  }

  if (periodArg === "monthly") {
    return {
      title: "Top Channels - Monthly",
      description: "View count gains for the last 30 days",
      ms: 30 * 24 * 60 * 60 * 1000,
    };
  }

  return {
    title: "Top Channels - 24 Hours",
    description: "View count gains for the last 24 hours",
    ms: 24 * 60 * 60 * 1000,
  };
}

function getStatsPeriodSettings(period) {
  if (period === "weekly") {
    return {
      label: "Weekly",
      currentLabel: "Last 7 days",
      previousLabel: "Previous 7 days",
      ms: 7 * 24 * 60 * 60 * 1000,
    };
  }

  if (period === "monthly") {
    return {
      label: "Monthly",
      currentLabel: "Last 30 days",
      previousLabel: "Previous 30 days",
      ms: 30 * 24 * 60 * 60 * 1000,
    };
  }

  return {
    label: "Daily",
    currentLabel: "Last 24 hours",
    previousLabel: "Previous 24 hours",
    ms: 24 * 60 * 60 * 1000,
  };
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      uploads_playlist_id TEXT,
      subscribers BIGINT,
      views BIGINT,
      videos BIGINT,
      added_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stats (
      id SERIAL PRIMARY KEY,
      channel_id TEXT NOT NULL,
      views BIGINT NOT NULL,
      subscribers BIGINT,
      timestamp BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitors (
      youtube_channel_id TEXT PRIMARY KEY,
      discord_channel_id TEXT NOT NULL,
      youtube_url TEXT NOT NULL,
      youtube_name TEXT NOT NULL,
      youtube_avatar TEXT,
      uploads_playlist_id TEXT NOT NULL,
      webhook_id TEXT NOT NULL,
      webhook_token TEXT NOT NULL,
      last_video_id TEXT,
      added_at BIGINT NOT NULL
    );
  `);

  console.log("Database ready.");
}

async function getAllChannels() {
  const result = await pool.query("SELECT * FROM channels");
  return result.rows;
}

async function getChannelFromDatabase(channelId) {
  const result = await pool.query("SELECT * FROM channels WHERE channel_id = $1", [
    channelId,
  ]);

  return result.rows[0] || null;
}

async function saveChannel(channel) {
  await pool.query(
    `
    INSERT INTO channels (
      channel_id, url, name, avatar, uploads_playlist_id,
      subscribers, views, videos, added_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (channel_id)
    DO UPDATE SET
      url = EXCLUDED.url,
      name = EXCLUDED.name,
      avatar = EXCLUDED.avatar,
      uploads_playlist_id = EXCLUDED.uploads_playlist_id,
      subscribers = EXCLUDED.subscribers,
      views = EXCLUDED.views,
      videos = EXCLUDED.videos;
    `,
    [
      channel.channelId,
      channel.url,
      channel.name,
      channel.avatar,
      channel.uploadsPlaylistId,
      channel.subscribers,
      channel.views,
      channel.videos,
      channel.addedAt,
    ]
  );
}

async function removeChannel(channelId) {
  await pool.query("DELETE FROM stats WHERE channel_id = $1", [channelId]);
  await pool.query("DELETE FROM channels WHERE channel_id = $1", [channelId]);
}

async function getAllMonitors() {
  const result = await pool.query("SELECT * FROM monitors");
  return result.rows;
}

async function getExistingWebhookForDiscordChannel(discordChannelId) {
  const result = await pool.query(
    `
    SELECT webhook_id, webhook_token
    FROM monitors
    WHERE discord_channel_id = $1
    AND webhook_id IS NOT NULL
    AND webhook_token IS NOT NULL
    LIMIT 1
    `,
    [discordChannelId]
  );

  if (result.rows.length === 0) return null;

  return {
    id: result.rows[0].webhook_id,
    token: result.rows[0].webhook_token,
  };
}

async function getOrCreateFluxWebhook(discordChannel) {
  const savedWebhook = await getExistingWebhookForDiscordChannel(discordChannel.id);

  if (savedWebhook) {
    try {
      const webhook = await client.fetchWebhook(savedWebhook.id, savedWebhook.token);
      if (webhook) return webhook;
    } catch {
      console.log("Saved webhook no longer works. Creating/finding another one...");
    }
  }

  try {
    const channelWebhooks = await discordChannel.fetchWebhooks();
    const existingFluxWebhook = channelWebhooks.find(
      (webhook) => webhook.name === "Flux" && webhook.token
    );

    if (existingFluxWebhook) return existingFluxWebhook;
  } catch {
    console.log("Could not fetch existing webhooks. Trying to create one...");
  }

  return discordChannel.createWebhook({
    name: "Flux",
    avatar: client.user.displayAvatarURL(),
  });
}

async function saveMonitor(monitor) {
  await pool.query(
    `
    INSERT INTO monitors (
      youtube_channel_id, discord_channel_id, youtube_url, youtube_name,
      youtube_avatar, uploads_playlist_id, webhook_id, webhook_token,
      last_video_id, added_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (youtube_channel_id)
    DO UPDATE SET
      discord_channel_id = EXCLUDED.discord_channel_id,
      youtube_url = EXCLUDED.youtube_url,
      youtube_name = EXCLUDED.youtube_name,
      youtube_avatar = EXCLUDED.youtube_avatar,
      uploads_playlist_id = EXCLUDED.uploads_playlist_id,
      webhook_id = EXCLUDED.webhook_id,
      webhook_token = EXCLUDED.webhook_token,
      last_video_id = EXCLUDED.last_video_id;
    `,
    [
      monitor.youtubeChannelId,
      monitor.discordChannelId,
      monitor.youtubeUrl,
      monitor.youtubeName,
      monitor.youtubeAvatar,
      monitor.uploadsPlaylistId,
      monitor.webhookId,
      monitor.webhookToken,
      monitor.lastVideoId,
      monitor.addedAt,
    ]
  );
}

async function removeMonitor(channelId) {
  await pool.query("DELETE FROM monitors WHERE youtube_channel_id = $1", [
    channelId,
  ]);
}

async function updateMonitorLastVideo(channelId, videoId) {
  await pool.query(
    "UPDATE monitors SET last_video_id = $1 WHERE youtube_channel_id = $2",
    [videoId, channelId]
  );
}

async function saveStats(channelId, stats) {
  await pool.query(
    `
    INSERT INTO stats (channel_id, views, subscribers, timestamp)
    VALUES ($1, $2, $3, $4)
    `,
    [channelId, stats.views, stats.subscribers, Date.now()]
  );
}

async function getStatsForChannel(channelId) {
  const result = await pool.query(
    "SELECT * FROM stats WHERE channel_id = $1 ORDER BY timestamp ASC",
    [channelId]
  );

  return result.rows;
}

async function fetchYouTubeJson(apiUrl) {
  const res = await fetch(apiUrl);
  const data = await res.json();

  if (data.error) {
    throw new Error(`YouTube API error: ${data.error.message}`);
  }

  return data;
}

async function fetchChannelById(channelId) {
  const apiUrl =
    `https://www.googleapis.com/youtube/v3/channels` +
    `?part=snippet,statistics,contentDetails&id=${encodeURIComponent(channelId)}` +
    `&key=${process.env.YOUTUBE_API_KEY}`;

  const data = await fetchYouTubeJson(apiUrl);

  if (!data.items || data.items.length === 0) return null;
  return data.items[0];
}

async function fetchChannelByHandle(handle) {
  const cleanHandle = handle.replace(/^@/, "");
  const attempts = [cleanHandle, `@${cleanHandle}`];

  for (const handleAttempt of attempts) {
    const apiUrl =
      `https://www.googleapis.com/youtube/v3/channels` +
      `?part=snippet,statistics,contentDetails&forHandle=${encodeURIComponent(handleAttempt)}` +
      `&key=${process.env.YOUTUBE_API_KEY}`;

    const data = await fetchYouTubeJson(apiUrl);

    if (data.items && data.items.length > 0) {
      return data.items[0];
    }
  }

  return null;
}

async function fetchChannelByUsername(username) {
  const apiUrl =
    `https://www.googleapis.com/youtube/v3/channels` +
    `?part=snippet,statistics,contentDetails&forUsername=${encodeURIComponent(username)}` +
    `&key=${process.env.YOUTUBE_API_KEY}`;

  const data = await fetchYouTubeJson(apiUrl);

  if (!data.items || data.items.length === 0) return null;
  return data.items[0];
}

async function searchChannel(query) {
  const cleanQuery = query.replace(/^@/, "");

  const apiUrl =
    `https://www.googleapis.com/youtube/v3/search` +
    `?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(cleanQuery)}` +
    `&key=${process.env.YOUTUBE_API_KEY}`;

  const data = await fetchYouTubeJson(apiUrl);

  if (!data.items || data.items.length === 0) return null;

  const channelId = data.items[0].snippet.channelId;
  return fetchChannelById(channelId);
}

function parseYouTubeUrl(input) {
  const cleaned = input.trim().replace(/[<>]/g, "");

  let parsed;

  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error("Invalid YouTube URL.");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);

  if (parts[0] === "channel" && parts[1]) {
    return {
      type: "channelId",
      value: parts[1],
      cleanUrl: `https://www.youtube.com/channel/${parts[1]}`,
    };
  }

  const handlePart = parts.find((part) => part.startsWith("@"));

  if (handlePart) {
    const handle = handlePart.replace(/^@/, "");
    return {
      type: "handle",
      value: handle,
      cleanUrl: `https://www.youtube.com/@${handle}`,
    };
  }

  if (parts[0] === "user" && parts[1]) {
    return {
      type: "username",
      value: parts[1],
      cleanUrl: `https://www.youtube.com/user/${parts[1]}`,
    };
  }

  if ((parts[0] === "c" || parts[0] === "shorts") && parts[1]) {
    return {
      type: "search",
      value: parts[1],
      cleanUrl: cleaned,
    };
  }

  if (parts[0]) {
    return {
      type: "search",
      value: parts[0],
      cleanUrl: cleaned,
    };
  }

  throw new Error("Unsupported YouTube URL.");
}

async function getChannelFromUrl(url) {
  const parsed = parseYouTubeUrl(url);
  let channel = null;

  if (parsed.type === "channelId") {
    channel = await fetchChannelById(parsed.value);
  }

  if (parsed.type === "handle") {
    channel = await fetchChannelByHandle(parsed.value);

    if (!channel) {
      channel = await searchChannel(parsed.value);
    }
  }

  if (parsed.type === "username") {
    channel = await fetchChannelByUsername(parsed.value);

    if (!channel) {
      channel = await searchChannel(parsed.value);
    }
  }

  if (parsed.type === "search") {
    channel = await searchChannel(parsed.value);
  }

  if (!channel) {
    throw new Error(`Channel not found for URL: ${url}`);
  }

  return {
    url: parsed.cleanUrl,
    channelId: channel.id,
    name: channel.snippet.title,
    avatar:
      channel.snippet.thumbnails.high?.url ||
      channel.snippet.thumbnails.default?.url,
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
  const channel = await fetchChannelById(channelId);

  if (!channel) return null;

  return {
    views: Number(channel.statistics.viewCount),
    subscribers: channel.statistics.hiddenSubscriberCount
      ? null
      : Number(channel.statistics.subscriberCount),
  };
}

async function getLatestVideo(uploadsPlaylistId) {
  const apiUrl =
    `https://www.googleapis.com/youtube/v3/playlistItems` +
    `?part=snippet&playlistId=${encodeURIComponent(uploadsPlaylistId)}` +
    `&maxResults=1&key=${process.env.YOUTUBE_API_KEY}`;

  const data = await fetchYouTubeJson(apiUrl);

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

  const channels = await getAllChannels();

  for (const channel of channels) {
    try {
      const stats = await fetchChannelStats(channel.channel_id);
      if (!stats) continue;

      await saveStats(channel.channel_id, stats);
      console.log(`Updated ${channel.name}`);
    } catch (error) {
      console.log(`Failed to update ${channel.name}: ${error.message}`);
    }
  }
}

async function checkUploads() {
  console.log("Checking monitored uploads...");

  const monitors = await getAllMonitors();

  for (const monitor of monitors) {
    try {
      const latest = await getLatestVideo(monitor.uploads_playlist_id);
      if (!latest) continue;

      if (!monitor.last_video_id) {
        await updateMonitorLastVideo(monitor.youtube_channel_id, latest.videoId);
        continue;
      }

      if (latest.videoId !== monitor.last_video_id) {
        await updateMonitorLastVideo(monitor.youtube_channel_id, latest.videoId);

        const webhook = await client.fetchWebhook(
          monitor.webhook_id,
          monitor.webhook_token
        );

        const embed = new EmbedBuilder()
          .setTitle("New Upload Detected")
          .setDescription(`**${monitor.youtube_name}** uploaded a new video.`)
          .setColor(FLUX_PURPLE)
          .setThumbnail(monitor.youtube_avatar)
          .setImage(latest.thumbnail)
          .addFields(
            {
              name: "Video",
              value: `[${latest.title}](${latest.url})`,
            },
            {
              name: "Channel",
              value: `[${monitor.youtube_name}](${monitor.youtube_url})`,
            }
          )
          .setFooter({ text: "Flux • YouTube upload monitor" })
          .setTimestamp(new Date(latest.publishedAt));

        await webhook.send({
          username: "Flux",
          avatarURL: client.user.displayAvatarURL(),
          embeds: [embed],
        });

        console.log(`New upload sent for ${monitor.youtube_name}`);
      }
    } catch (error) {
      console.log(
        `Upload check failed for ${monitor.youtube_name}: ${error.message}`
      );
    }
  }
}

async function getLeaderboard(periodMs) {
  const channels = await getAllChannels();
  const cutoff = Date.now() - periodMs;
  const results = [];

  for (const channel of channels) {
    const history = await getStatsForChannel(channel.channel_id);

    const recent = history.length > 0 ? history[history.length - 1] : null;
    let old = null;

    if (history.length > 0) {
      old = history
        .filter((s) => Number(s.timestamp) <= cutoff)
        .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0];

      if (!old) old = history[0];
    }

    const currentViews = recent ? Number(recent.views) : Number(channel.views || 0);
    const currentSubscribers =
      recent && recent.subscribers !== null
        ? Number(recent.subscribers)
        : channel.subscribers === null
        ? null
        : Number(channel.subscribers);

    const oldViews = old ? Number(old.views) : currentViews;
    const gain = currentViews - oldViews;

    results.push({
      name: channel.name,
      url: channel.url,
      avatar: channel.avatar,
      gain,
      views: currentViews,
      subscribers: currentSubscribers,
    });
  }

  return results.sort((a, b) => b.gain - a.gain);
}

function getSnapshotAtOrBefore(history, timestamp) {
  return history
    .filter((item) => Number(item.timestamp) <= timestamp)
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0];
}

async function buildStatsResultEmbed(channelId, period) {
  const settings = getStatsPeriodSettings(period);
  const channel = await getChannelFromDatabase(channelId);

  if (!channel) {
    return new EmbedBuilder()
      .setTitle("Channel Analytics")
      .setDescription("This channel is not saved in the database yet.")
      .setColor(FLUX_PURPLE);
  }

  const history = await getStatsForChannel(channelId);

  if (history.length === 0) {
    return new EmbedBuilder()
      .setTitle(`${channel.name} Analytics`)
      .setDescription("No stats saved yet. Wait for the next hourly stats update.")
      .setColor(FLUX_PURPLE)
      .setThumbnail(channel.avatar || null);
  }

  const now = Date.now();
  const currentStart = now - settings.ms;
  const previousStart = now - settings.ms * 2;

  const latest = history[history.length - 1];
  const currentStartSnapshot = getSnapshotAtOrBefore(history, currentStart) || history[0];
  const previousStartSnapshot = getSnapshotAtOrBefore(history, previousStart);

  const currentViewsGain =
    Number(latest.views) - Number(currentStartSnapshot.views);

  const currentSubsGain =
    latest.subscribers === null || currentStartSnapshot.subscribers === null
      ? null
      : Number(latest.subscribers) - Number(currentStartSnapshot.subscribers);

  let previousViewsGain = null;
  let previousSubsGain = null;

  if (previousStartSnapshot) {
    previousViewsGain =
      Number(currentStartSnapshot.views) - Number(previousStartSnapshot.views);

    previousSubsGain =
      currentStartSnapshot.subscribers === null ||
      previousStartSnapshot.subscribers === null
        ? null
        : Number(currentStartSnapshot.subscribers) -
          Number(previousStartSnapshot.subscribers);
  }

  const embed = new EmbedBuilder()
    .setTitle(`${channel.name} Analytics - ${settings.label}`)
    .setDescription(`[Open YouTube Channel](${channel.url})`)
    .setColor(FLUX_PURPLE)
    .setThumbnail(channel.avatar || null)
    .addFields(
      {
        name: settings.currentLabel,
        value:
          `📊 Views gained: **${formatSigned(currentViewsGain)}**\n` +
          `👥 Subscribers gained: **${
            currentSubsGain === null ? "Hidden" : formatSigned(currentSubsGain)
          }**`,
      },
      {
        name: settings.previousLabel,
        value:
          previousViewsGain === null
            ? "Not enough saved history yet."
            : `📊 Views gained: **${formatSigned(previousViewsGain)}**\n` +
              `👥 Subscribers gained: **${
                previousSubsGain === null ? "Hidden" : formatSigned(previousSubsGain)
              }**`,
      },
      {
        name: "Comparison",
        value:
          previousViewsGain === null
            ? "Comparison will work once Flux has enough saved history."
            : `📊 Views difference: **${formatPercent(
                currentViewsGain,
                previousViewsGain
              )}**\n` +
              `👥 Subscribers difference: **${
                currentSubsGain === null || previousSubsGain === null
                  ? "Hidden"
                  : formatPercent(currentSubsGain, previousSubsGain)
              }**`,
      },
      {
        name: "Current Totals",
        value:
          `🎯 Total views: **${formatNumber(latest.views)}**\n` +
          `👥 Subscribers: **${formatNumber(latest.subscribers)}**`,
      }
    )
    .setFooter({ text: "Flux • Channel analytics" })
    .setTimestamp();

  return embed;
}

async function buildStatsChooser(channel) {
  const embed = new EmbedBuilder()
    .setTitle(`${channel.name} Analytics`)
    .setDescription("Choose the timeframe you want to view.")
    .setColor(FLUX_PURPLE)
    .setThumbnail(channel.avatar || null)
    .addFields({
      name: "Available timeframes",
      value: "Daily, Weekly, Monthly",
    })
    .setFooter({ text: "Flux • Click a button below" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`stats:daily:${channel.channelId}`)
      .setLabel("Daily")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`stats:weekly:${channel.channelId}`)
      .setLabel("Weekly")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`stats:monthly:${channel.channelId}`)
      .setLabel("Monthly")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embed, row };
}

async function buildLeaderboardEmbed(periodArg) {
  const settings = getLeaderboardSettings(periodArg);
  const data = (await getLeaderboard(settings.ms)).slice(0, 10);

  const embed = new EmbedBuilder()
    .setTitle(settings.title)
    .setDescription(settings.description)
    .setColor(FLUX_PURPLE)
    .setFooter({ text: "Flux • Stats update every hour" })
    .setTimestamp();

  if (data.length > 0 && data[0].avatar) {
    embed.setThumbnail(data[0].avatar);
  }

  if (data.length === 0) {
    embed.addFields({
      name: "No channels yet",
      value: "Add channels with `!add <YouTube channel URL>`.",
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
        name: "!remove <YouTube channel URL>",
        value: "Removes a YouTube channel from the stats leaderboard tracker.",
      },
      {
        name: "!leaderboard",
        value: "Shows the top tracked channels by view gains in the last 24 hours.",
      },
      {
        name: "!leaderboard weekly",
        value: "Shows the top tracked channels by view gains in the last 7 days.",
      },
      {
        name: "!leaderboard monthly",
        value: "Shows the top tracked channels by view gains in the last 30 days.",
      },
      {
        name: "!stats <YouTube channel URL>",
        value: "Shows channel analytics with daily, weekly, and monthly buttons.",
      },
      {
        name: "!monitoradd <Discord channel ID> <YouTube channel URL>",
        value:
          "Monitors a YouTube channel and sends new upload notifications using a shared webhook.",
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
        name: "?purge <number>",
        value:
          "Deletes a specific number of recent messages. Requires Manage Messages.",
      },
      {
        name: "?purge all",
        value:
          "Deletes as many recent messages as Discord allows. Requires Manage Messages.",
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
  const monitors = await getAllMonitors();

  if (monitors.length === 0) {
    return message.reply(
      "No monitors found. Add one first with `!monitoradd <Discord channel ID> <YouTube channel URL>`."
    );
  }

  try {
    const monitor = monitors[0];

    const webhook = await client.fetchWebhook(
      monitor.webhook_id,
      monitor.webhook_token
    );

    const embed = new EmbedBuilder()
      .setTitle("Test Notification")
      .setDescription("This is a test upload notification from Flux.")
      .setColor(FLUX_PURPLE)
      .setThumbnail(monitor.youtube_avatar)
      .setImage("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
      .addFields(
        {
          name: "Video",
          value: "[Test Video Title](https://youtube.com/watch?v=dQw4w9WgXcQ)",
        },
        {
          name: "Channel",
          value: `[${monitor.youtube_name}](${monitor.youtube_url})`,
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
    return message.reply(`❌ Failed to send test notification: ${error.message}`);
  }
}

async function handlePurgeCommand(message, args) {
  if (!message.guild) return;

  if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    return message.reply("❌ You need **Manage Messages** permission to use this.");
  }

  const botMember = message.guild.members.me;

  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    return message.reply(
      "❌ I need **Manage Messages** permission to delete messages."
    );
  }

  const option = args[0];

  if (!option) {
    return message.reply("Use: `?purge <number>` or `?purge all`");
  }

  if (option.toLowerCase() === "all") {
    let totalDeleted = 0;

    while (true) {
      const fetchedMessages = await message.channel.messages.fetch({
        limit: 100,
      });

      if (fetchedMessages.size === 0) break;

      const deletableMessages = fetchedMessages.filter(
        (msg) => Date.now() - msg.createdTimestamp < 14 * 24 * 60 * 60 * 1000
      );

      if (deletableMessages.size === 0) break;

      const deleted = await message.channel.bulkDelete(deletableMessages, true);
      totalDeleted += deleted.size;

      if (deleted.size < 100) break;
    }

    const confirmation = await message.channel.send(
      `🧹 Deleted **${totalDeleted}** messages.`
    );

    setTimeout(() => {
      confirmation.delete().catch(() => {});
    }, 5000);

    return;
  }

  const amount = Number(option);

  if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
    return message.reply("Please enter a number between **1** and **100**.");
  }

  const fetchedMessages = await message.channel.messages.fetch({
    limit: amount + 1,
  });

  const deleted = await message.channel.bulkDelete(fetchedMessages, true);

  const confirmation = await message.channel.send(
    `🧹 Deleted **${deleted.size}** messages.`
  );

  setTimeout(() => {
    confirmation.delete().catch(() => {});
  }, 5000);
}

client.once("ready", async () => {
  console.log(`Bot is online as ${client.user.tag}`);

  await initDatabase();

  await updateStats();
  await checkUploads();

  cron.schedule("0 * * * *", async () => {
    await updateStats();
  });

  cron.schedule("*/5 * * * *", async () => {
    await checkUploads();
  });
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const [type, period, channelId] = interaction.customId.split(":");

  if (type !== "stats") return;

  await interaction.deferUpdate();

  const embed = await buildStatsResultEmbed(channelId, period);

  return interaction.editReply({
    embeds: [embed],
    components: [],
  });
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith(MOD_PREFIX)) {
    const args = message.content.slice(MOD_PREFIX.length).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();

    if (command === "purge") {
      return handlePurgeCommand(message, args);
    }
  }

  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  if (command === "commands") {
    return message.reply({ embeds: [buildCommandsEmbed()] });
  }

  if (command === "testnotify") {
    return sendTestNotification(message);
  }

  if (command === "add") {
    const url = args[0];

    if (!url) {
      return message.reply("Use: `!add <YouTube channel URL>`");
    }

    try {
      const channel = await getChannelFromUrl(url);

      await saveChannel(channel);

      await saveStats(channel.channelId, {
        views: channel.views,
        subscribers: channel.subscribers,
      });

      return message.reply(
        `✅ Added **${channel.name}** to the leaderboard tracker.`
      );
    } catch (error) {
      console.error(error);
      return message.reply(`Error adding channel: ${error.message}`);
    }
  }

  if (command === "stats") {
    const url = args[0];

    if (!url) {
      return message.reply("Use: `!stats <YouTube channel URL>`");
    }

    try {
      const channel = await getChannelFromUrl(url);

      await saveChannel(channel);

      const history = await getStatsForChannel(channel.channelId);

      if (history.length === 0) {
        await saveStats(channel.channelId, {
          views: channel.views,
          subscribers: channel.subscribers,
        });
      }

      const { embed, row } = await buildStatsChooser(channel);

      await message.delete().catch(() => {});

      return message.channel.send({
        embeds: [embed],
        components: [row],
      });
    } catch (error) {
      console.error(error);
      return message.reply(`Could not load stats: ${error.message}`);
    }
  }

  if (command === "remove") {
    const url = args[0];

    if (!url) {
      return message.reply("Use: `!remove <YouTube channel URL>`");
    }

    try {
      const channel = await getChannelFromUrl(url);

      await removeChannel(channel.channelId);

      return message.reply(
        `✅ Removed **${channel.name}** from the leaderboard tracker.`
      );
    } catch (error) {
      console.error(error);
      return message.reply(`Could not remove that channel: ${error.message}`);
    }
  }

  if (command === "leaderboard") {
    const periodArg = args[0]?.toLowerCase();

    if (periodArg && !["weekly", "monthly"].includes(periodArg)) {
      return message.reply(
        "Use one of these:\n`!leaderboard`\n`!leaderboard weekly`\n`!leaderboard monthly`"
      );
    }

    const embed = await buildLeaderboardEmbed(periodArg);
    return message.reply({ embeds: [embed] });
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

      const webhook = await getOrCreateFluxWebhook(discordChannel);

      await saveMonitor({
        discordChannelId,
        youtubeUrl: youtubeChannel.url,
        youtubeChannelId: youtubeChannel.channelId,
        youtubeName: youtubeChannel.name,
        youtubeAvatar: youtubeChannel.avatar,
        uploadsPlaylistId: youtubeChannel.uploadsPlaylistId,
        webhookId: webhook.id,
        webhookToken: webhook.token,
        lastVideoId: latest ? latest.videoId : null,
        addedAt: Date.now(),
      });

      return message.reply(
        `✅ Monitoring **${youtubeChannel.name}**.\nNew upload notifications will be sent in <#${discordChannelId}>.`
      );
    } catch (error) {
      console.error(error);
      return message.reply(`Could not create monitor: ${error.message}`);
    }
  }

  if (command === "monitorremove") {
    const youtubeUrl = args[0];

    if (!youtubeUrl) {
      return message.reply("Use: `!monitorremove <YouTube channel URL>`");
    }

    try {
      const youtubeChannel = await getChannelFromUrl(youtubeUrl);

      await removeMonitor(youtubeChannel.channelId);

      return message.reply(`✅ Removed monitor for **${youtubeChannel.name}**.`);
    } catch (error) {
      console.error(error);
      return message.reply(`Could not remove monitor: ${error.message}`);
    }
  }
});

const cleanedDiscordToken = process.env.DISCORD_TOKEN
  ?.replace("DISCORD_TOKEN=", "")
  .replace(/^["']|["']$/g, "")
  .trim();

console.log("Discord token loaded:", cleanedDiscordToken ? "YES" : "NO");
console.log("Discord token length:", cleanedDiscordToken?.length || 0);

client.login(cleanedDiscordToken);