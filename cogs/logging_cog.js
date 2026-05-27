const { 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  PermissionFlagsBits,
  AuditLogEvent,
  AttachmentBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ThumbnailBuilder
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { MAIN_COLOR, LOG_SETTINGS_FILE, SUCCESS_COLOR, ERROR_COLOR, INFO_COLOR, PERMISSION_ERROR_EMBED } = require('../core/config');
const { 
  serialize_channel, 
  is_registered, 
  checkAdminPermission,
  load_json,
  save_json
} = require('../core/utils');

// Initialize database
const dbPath = path.join(process.cwd(), 'xiadb.db');
const db = new sqlite3.Database(dbPath);
db.configure("busyTimeout", 5000); // Wait up to 5 seconds if DB is locked

const agreedGuilds = new Set();
const logSettingsCache = new Map(); // guildId -> { channels: {}, excluded_channels: [] }
const activePurges = new Map(); // channelId -> { reason, executor, userFilter }

function saveLogSettings(guildId, data) {
  const gId = guildId.toString();
  logSettingsCache.set(gId, data);
  const channelsStr = JSON.stringify(data.channels || {});
  const excludedStr = JSON.stringify(data.excluded_channels || []);
  const purgeFormat = data.purge_format || 'html';
  db.run(
    "INSERT OR REPLACE INTO log_settings (guild_id, channels, excluded_channels, purge_format) VALUES (?, ?, ?, ?)",
    [gId, channelsStr, excludedStr, purgeFormat],
    (err) => {
      if (err) console.error("[DB log_settings] Save error:", err);
    }
  );
}

// Load agreed guilds on startup
function loadAgreements() {
  return new Promise((resolve) => {
    db.all("SELECT guild_id FROM server_agreements WHERE agreed = 1", [], (err, rows) => {
      if (err) {
        // Table might not exist yet during the very first run, handle gracefully
        resolve();
      } else {
        agreedGuilds.clear();
        if (rows) {
          for (const row of rows) {
            agreedGuilds.add(row.guild_id.toString());
          }
        }
        console.log(`[Agreement] Loaded ${agreedGuilds.size} agreed guilds for message collection.`);
        resolve();
      }
    });
  });
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY, 
    channel_id TEXT, 
    guild_id TEXT,
    author_id TEXT, 
    content TEXT, 
    timestamp TEXT
  )`);

  // Migrate older database schemas gracefully
  db.run("ALTER TABLE messages ADD COLUMN guild_id TEXT", (err) => {
    // Column already exists, safe to ignore
  });

  db.run(`CREATE TABLE IF NOT EXISTS server_agreements (
    guild_id TEXT PRIMARY KEY,
    agreed INTEGER,
    agreed_by TEXT,
    timestamp TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS log_settings (
    guild_id TEXT PRIMARY KEY,
    channels TEXT,
    excluded_channels TEXT
  )`);

  db.run("ALTER TABLE log_settings ADD COLUMN purge_format TEXT DEFAULT 'html'", (err) => {
    // Column already exists, safe to ignore
  });

  // Index channel_id to optimize historical scan queries
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id)`);

  // Migrate older JSON settings to sqlite3
  try {
    const fs = require('fs');
    const settingsPath = path.join(process.cwd(), 'log_settings.json');
    if (fs.existsSync(settingsPath)) {
      console.log("[Migration] Found log_settings.json. Migrating to SQLite...");
      const oldSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      for (const [gId, data] of Object.entries(oldSettings)) {
        const channelsStr = JSON.stringify(data.channels || {});
        const excludedStr = JSON.stringify(data.excluded_channels || []);
        db.run(
          "INSERT OR REPLACE INTO log_settings (guild_id, channels, excluded_channels) VALUES (?, ?, ?)",
          [gId, channelsStr, excludedStr]
        );
      }
      fs.renameSync(settingsPath, settingsPath + '.bak');
      console.log("[Migration] Successfully migrated log_settings.json to SQLite database!");
    }
  } catch (e) {
    console.error("[Migration] Error migrating settings:", e);
  }

  // Populate memory cache
  db.all("SELECT * FROM log_settings", [], (err, rows) => {
    if (!err && rows) {
      for (const row of rows) {
        logSettingsCache.set(row.guild_id, {
          channels: JSON.parse(row.channels || '{}'),
          excluded_channels: JSON.parse(row.excluded_channels || '[]'),
          purge_format: row.purge_format || 'html'
        });
      }
      console.log(`[Cache] Loaded log settings for ${logSettingsCache.size} guilds from SQLite database.`);
    }
  });

  // Instantly load agreements
  loadAgreements();
});

// Helper DB functions
function saveMessageToDb(message) {
  if (!message.guild) return;
  const guildId = message.guild.id.toString();
  if (!agreedGuilds.has(guildId)) {
    console.log(`[Debug saveMessageToDb] ⚠️ SKIPPED: Guild "${message.guild.name}" (${guildId}) has NOT agreed to message collection. Please run "/동의 메시지수집 선택:동의" first!`);
    return;
  }

  let content = message.content || "";
  
  // Save attachment details if any exist so deleted files can be tracked
  if (message.attachments && message.attachments.size > 0) {
    const attachmentUrls = message.attachments.map(a => `[첨부파일: ${a.name}](${a.url})`).join("\n");
    if (content && content !== "") {
      content += "\n" + attachmentUrls;
    } else {
      content = attachmentUrls;
    }
  }

  // Save embeds if any exist so deleted bot embeds or rich embeds can be fully logged
  if (message.embeds && message.embeds.length > 0) {
    const embedsText = formatEmbeds(message.embeds);
    if (content && content !== "") {
      content += "\n\n" + embedsText;
    } else {
      content = embedsText;
    }
  }

  const authorId = message.author ? message.author.id.toString() : "0";
  const timestamp = new Date().toISOString();
  db.run(
    "INSERT OR REPLACE INTO messages (message_id, channel_id, guild_id, author_id, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    [message.id.toString(), message.channel.id.toString(), guildId, authorId, content, timestamp],
    (err) => {
      if (err) {
        console.error("[Debug saveMessageToDb] ❌ Error saving message to DB:", err);
      } else {
        console.log(`[Debug saveMessageToDb] ✅ SUCCESS: Saved message "${message.id}" from "${message.author?.tag || 'Unknown author'}" in guild "${message.guild.name}"`);
      }
    }
  );
}

function saveMessagesToDbBulk(messagesArray) {
  const filteredMessages = messagesArray.filter(msg => msg.guild && agreedGuilds.has(msg.guild.id.toString()));
  if (filteredMessages.length === 0) return;

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    const stmt = db.prepare("INSERT OR REPLACE INTO messages (message_id, channel_id, guild_id, author_id, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)");
    
    for (const msg of filteredMessages) {
      let content = msg.content || "";
      if (msg.attachments && msg.attachments.size > 0) {
        const attachmentUrls = msg.attachments.map(a => `[첨부파일: ${a.name}](${a.url})`).join("\n");
        if (content && content !== "") {
          content += "\n" + attachmentUrls;
        } else {
          content = attachmentUrls;
        }
      }

      if (msg.embeds && msg.embeds.length > 0) {
        const embedsText = formatEmbeds(msg.embeds);
        if (content && content !== "") {
          content += "\n\n" + embedsText;
        } else {
          content = embedsText;
        }
      }

      const authorId = msg.author ? msg.author.id.toString() : "0";
      const timestamp = new Date().toISOString();

      stmt.run([msg.id.toString(), msg.channel.id.toString(), msg.guild.id.toString(), authorId, content, timestamp]);
    }

    stmt.finalize();
    db.run("COMMIT", (err) => {
      if (err) {
        console.error("[Sync DB] Failed to commit transaction:", err);
      }
    });
  });
}

function getMessageFromDb(messageId) {
  return new Promise((resolve) => {
    db.get(
      "SELECT content, author_id, channel_id FROM messages WHERE message_id = ?",
      [messageId.toString()],
      (err, row) => {
        if (err) {
          console.error("Error getting message from DB:", err);
          resolve(null);
        } else {
          resolve(row || null);
        }
      }
    );
  });
}

function deleteMessageFromDb(messageId) {
  db.run(
    "DELETE FROM messages WHERE message_id = ?",
    [messageId.toString()],
    (err) => {
      if (err) console.error("Error deleting message from DB:", err);
    }
  );
}

async function syncGuildHistory(client, targetGuildId = null) {
  console.log(`[Sync] Starting highly-optimized parallel message synchronization... Target Guild: ${targetGuildId || 'ALL'}`);
  const syncPromises = [];
  const allMessagesToSave = [];
  
  const guildsToSync = targetGuildId 
    ? (client.guilds.cache.has(targetGuildId) ? [[targetGuildId, client.guilds.cache.get(targetGuildId)]] : [])
    : client.guilds.cache;

  for (const [guildId, guild] of guildsToSync) {
    // Check if the guild has consented to message collection
    if (!agreedGuilds.has(guildId.toString())) {
      console.log(`[Sync] Skipping guild "${guild.name}" (${guildId}) - No message collection consent.`);
      continue;
    }

    console.log(`[Sync] Scanning guild: ${guild.name} (${guild.id})`);
    
    // Fetch channels
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) continue;

    for (const [channelId, channel] of channels) {
      // Ensure it is a text channel and the bot has permission to read/fetch messages
      if (!channel || !channel.isTextBased()) continue;

      // Push channel sync task to parallel execution array
      syncPromises.push((async () => {
        try {
          // Fetch existing message IDs in this channel from the database
          const existingIds = new Set();
          await new Promise(resolve => {
            db.all("SELECT message_id FROM messages WHERE channel_id = ?", [channel.id.toString()], (err, rows) => {
              if (rows) {
                for (const row of rows) {
                  existingIds.add(row.message_id.toString());
                }
              }
              resolve();
            });
          });

          let lastId = null;
          let fetchIterations = 0;
          const maxIterations = 3; // Sync last 300 messages per channel
          let hasEncounteredExisting = false;

          while (fetchIterations < maxIterations && !hasEncounteredExisting) {
            const fetchOptions = { limit: 100 };
            if (lastId) {
              fetchOptions.before = lastId;
            }

            const messages = await channel.messages.fetch(fetchOptions).catch(() => null);
            if (!messages || messages.size === 0) break;

            for (const [msgId, message] of messages) {
              // If the message is already in our DB, all messages older than it are also saved!
              // Stop downloading/processing this channel immediately.
              if (existingIds.has(msgId.toString())) {
                hasEncounteredExisting = true;
                break;
              }
              allMessagesToSave.push(message);
            }

            if (hasEncounteredExisting) break;

            lastId = messages.lastKey();
            fetchIterations++;

            // Wait 100ms between fetches in the SAME channel to respect Discord rate limits
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } catch (e) {
          // Silent catch for channel fetch rate-limits or permission gaps
        }
      })());
    }
  }

  // Run all channel sync tasks concurrently in the background!
  Promise.all(syncPromises).then(() => {
    if (allMessagesToSave.length > 0) {
      // Write only new offline messages to DB in a single high-performance transaction
      saveMessagesToDbBulk(allMessagesToSave);
      console.log(`[Sync] Optimization success! Only saved new offline messages in bulk transaction: ${allMessagesToSave.length}`);
    } else {
      console.log(`[Sync] Optimization success! 0 new messages to save. Database is fully up-to-date!`);
    }
  }).catch(err => {
    console.error("[Sync] Error during parallel synchronization:", err);
  });
}

// Format date in Korea Time (KST)
function formatKST(date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    const val = (type) => parts.find(p => p.type === type).value;
    return `${val('year')}-${val('month')}-${val('day')} ${val('hour')}:${val('minute')}:${val('second')}`;
  } catch (e) {
    return date.toISOString();
  }
}

// Format Embeds into a highly readable human text block for logs
function formatEmbeds(embeds) {
  if (!embeds || embeds.length === 0) return "임베드 없음";
  
  return embeds.map((embed, idx) => {
    if (!embed) return `[임베드 #${idx + 1}] (데이터 없음)`;
    const data = embed.data || embed;
    let str = `[임베드 #${idx + 1}]`;
    if (data.title) str += `\n**제목:** ${data.title}`;
    if (data.description) str += `\n**설명:** ${data.description}`;
    if (data.url) str += `\n**URL:** ${data.url}`;
    if (data.fields && data.fields.length > 0) {
      const fieldsStr = data.fields.map(f => f ? `- **${f.name}:** ${f.value}` : "").filter(Boolean).join('\n');
      str += `\n**필드:**\n${fieldsStr}`;
    }
    return str;
  }).join('\n\n');
}

async function getLogChannel(client, guildId, logType) {
  const guildData = logSettingsCache.get(guildId.toString());
  if (guildData && guildData.channels) {
    const channelData = guildData.channels[logType];
    if (channelData && channelData.id) {
      try {
        let ch = client.channels.cache.get(channelData.id);
        if (!ch) {
          ch = await client.channels.fetch(channelData.id).catch(() => null);
        }
        if (!ch) return null;

        // If thread method is configured and it's a TextChannel that supports threads, find/create the sub-thread
        if (channelData.method === 'thread' && ch.threads) {
          const logTypeLabels = {
            'log_chat': '💬-채팅-로그',
            'log_voice': '🔊-음성-로그',
            'log_enter_exit': '🚪-입퇴장-로그',
            'log_ban': '🛡️-차단-로그',
            'log_thread': '🧵-스레드-로그',
            'log_channel': '📁-채널-로그',
            'log_update': '📢-봇공지-로그',
            'log_reaction': '🎭-반응-로그',
            'log_role': '🏷️-역할-로그',
            'log_timeout': '🔇-타임아웃-로그',
            'log_sanction': '⚖️-제재-로그',
            'log_nickname': '👤-닉네임-로그'
          };
          const threadName = logTypeLabels[logType] || `${logType}-로그`;
          
          let thread = ch.threads.cache.find(t => t.name === threadName);
          if (!thread) {
            const activeThreads = await ch.threads.fetchActive().catch(() => null);
            thread = activeThreads?.threads.find(t => t.name === threadName);
          }
          if (!thread) {
            const archivedThreads = await ch.threads.fetchArchived().catch(() => null);
            thread = archivedThreads?.threads.find(t => t.name === threadName);
          }
          if (!thread) {
            thread = await ch.threads.create({
              name: threadName,
              autoArchiveDuration: 10080, // 7 days (or max allowed)
              reason: '시아 봇 로그 스레드 자동 생성'
            }).catch(() => null);

            if (thread) {
              await ch.send({
                content: `**[${client.user.username}]**이 **[${threadName}]**을 생성했어요.\nㄴ ${thread.toString()}`
              }).catch(() => null);

              const logTypeNames = {
                'log_chat': '채팅 로그',
                'log_voice': '음성 로그',
                'log_enter_exit': '입/퇴장 로그',
                'log_ban': '차단 로그',
                'log_thread': '스레드 로그',
                'log_channel': '채널 로그',
                'log_update': '봇 업데이트 공지',
                'log_reaction': '반응 로그',
                'log_role': '역할 로그',
                'log_timeout': '타임아웃 로그',
                'log_sanction': '제재 로그',
                'log_nickname': '닉네임 로그'
              };
              const logTypeName = logTypeNames[logType] || `${logType} 로그`;
              await thread.send({
                content: `📌 **[${logTypeName}]**가 생성되었습니다.`
              }).catch(() => null);
            }
          }
          if (thread) {
            if (thread.archived) {
              await thread.setArchived(false).catch(() => null);
            }
            return thread;
          }
        }
        return ch;
      } catch (e) {
        console.error("[getLogChannel] Error finding/creating thread:", e);
        return null;
      }
    }
  }
  return null;
}

async function logPurgeInternal(client, messages, channel, executor = null, reason = null) {
  if (messages.size === 0) return;

  const guild = channel?.guild || messages.first()?.guild;
  if (!guild) return;

  if (!agreedGuilds.has(guild.id.toString())) return;

  const channelId = channel?.id || messages.first()?.channel?.id;
  if (isChannelExcluded(guild.id, channelId)) return;

  const guildData = logSettingsCache.get(guild.id.toString());
  const purgeFormat = (guildData && guildData.purge_format) || 'html';

  const logChannel = await getLogChannel(client, guild.id, 'log_chat');
  if (!logChannel) {
    for (const [id, message] of messages) {
      deleteMessageFromDb(id);
    }
    return;
  }

  if (channelId === logChannel.id) {
    for (const [id, message] of messages) {
      deleteMessageFromDb(id);
    }
    return;
  }

  // Defer processing slightly to allow audit logs to register if triggered by a command
  await new Promise(resolve => setTimeout(resolve, 1500));

  function escapeHtml(text) {
    if (!text) return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  const rawArray = Array.from(messages.values()).reverse();

  const msgArray = await Promise.all(
    rawArray.map(async (msg) => {
      let author = msg.author;
      let content = msg.content;
      let createdAt = msg.createdAt;

      if (!author || !content) {
        const dbMsg = await getMessageFromDb(msg.id);
        if (dbMsg) {
          content = dbMsg.content;
          if (dbMsg.timestamp) {
            createdAt = new Date(dbMsg.timestamp);
          }
          if (dbMsg.author_id) {
            try {
              const fetchedUser = await client.users.fetch(dbMsg.author_id).catch(() => null);
              if (fetchedUser) {
                author = fetchedUser;
              }
            } catch (e) {}
          }
        }
      }

      return {
        id: msg.id,
        author,
        member: msg.member,
        content: content || "",
        createdAt: createdAt || new Date(),
        attachments: msg.attachments,
        embeds: msg.embeds
      };
    })
  );

  let messageRows = "";
  for (const msg of msgArray) {
    const author = msg.author;
    const avatarUrl = author ? author.displayAvatarURL({ extension: 'png', size: 128 }) : "https://discord.com/assets/5d6a5e2c77eba658428383a152e75e92.svg";
    const displayName = escapeHtml(msg.member?.displayName || author?.username || "알 수 없는 유저");
    const isBot = author ? author.bot : false;
    
    const date = new Date(msg.createdAt || Date.now());
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstDate = new Date(date.getTime() + kstOffset);
    const timeStr = kstDate.toISOString().replace('T', ' ').substring(0, 19);

    let contentHtml = msg.content ? escapeHtml(msg.content) : "(내용 없음)";

    let attachmentsHtml = "";
    if (msg.attachments && msg.attachments.size > 0) {
      msg.attachments.forEach(att => {
        const isImage = att.contentType?.startsWith('image/');
        if (isImage) {
          attachmentsHtml += `
            <div class="attachment-media">
              <img class="image-preview" src="${att.url}" alt="${escapeHtml(att.name)}">
            </div>
          `;
        } else {
          const sizeKB = (att.size / 1024).toFixed(1);
          attachmentsHtml += `
            <div class="attachment-box">
              <div class="attachment-icon">📁</div>
              <div class="attachment-info">
                <a class="attachment-name" href="${att.url}" target="_blank" download>${escapeHtml(att.name)}</a>
                <span class="attachment-size">${sizeKB} KB</span>
              </div>
            </div>
          `;
        }
      });
    }

    let embedsHtml = "";
    if (msg.embeds && msg.embeds.length > 0) {
      for (const embed of msg.embeds) {
        const colorHex = embed.color ? '#' + embed.color.toString(16).padStart(6, '0') : '#1e1f22';
        
        let embedAuthorHtml = "";
        if (embed.author) {
          const authorIcon = embed.author.iconURL ? `<img class="embed-author-icon" src="${embed.author.iconURL}">` : "";
          embedAuthorHtml = `
            <div class="embed-author">
              ${authorIcon}
              <span>${escapeHtml(embed.author.name)}</span>
            </div>
          `;
        }

        let embedTitleHtml = "";
        if (embed.title) {
          if (embed.url) {
            embedTitleHtml = `<a class="embed-title" href="${embed.url}" target="_blank">${escapeHtml(embed.title)}</a>`;
          } else {
            embedTitleHtml = `<div class="embed-title">${escapeHtml(embed.title)}</div>`;
          }
        }

        let embedDescHtml = "";
        if (embed.description) {
          embedDescHtml = `<div class="embed-description">${escapeHtml(embed.description)}</div>`;
        }

        let embedFieldsHtml = "";
        if (embed.fields && embed.fields.length > 0) {
          let fieldsRows = "";
          for (const f of embed.fields) {
            const isInline = f.inline;
            const fieldClass = isInline ? "embed-field" : "embed-field block";
            fieldsRows += `
              <div class="${fieldClass}">
                <div class="embed-field-name">${escapeHtml(f.name)}</div>
                <div class="embed-field-value">${escapeHtml(f.value)}</div>
              </div>
            `;
          }
          embedFieldsHtml = `<div class="embed-fields">${fieldsRows}</div>`;
        }

        let embedFooterHtml = "";
        if (embed.footer) {
          const footerIcon = embed.footer.iconURL ? `<img class="embed-footer-icon" src="${embed.footer.iconURL}">` : "";
          embedFooterHtml = `
            <div class="embed-footer">
              ${footerIcon}
              <span>${escapeHtml(embed.footer.text)}</span>
            </div>
          `;
        }

        let embedThumbnailHtml = "";
        if (embed.thumbnail && embed.thumbnail.url) {
          embedThumbnailHtml = `<img class="embed-thumbnail" src="${embed.thumbnail.url}">`;
        }

        let embedImageHtml = "";
        if (embed.image && embed.image.url) {
          embedImageHtml = `<img class="embed-image" src="${embed.image.url}">`;
        }

        embedsHtml += `
          <div class="embed-box" style="border-left-color: ${colorHex};">
            <div style="display: flex; gap: 16px;">
              <div style="flex-grow: 1; display: flex; flex-direction: column; gap: 8px;">
                ${embedAuthorHtml}
                ${embedTitleHtml}
                ${embedDescHtml}
                ${embedFieldsHtml}
              </div>
              ${embedThumbnailHtml}
            </div>
            ${embedImageHtml}
            ${embedFooterHtml}
          </div>
        `;
      }
    }

    messageRows += `
      <div class="message-group">
        <img class="avatar" src="${avatarUrl}" alt="${displayName}">
        <div class="message-content">
          <div class="author-info">
            <span class="author-name">${displayName}</span>
            ${isBot ? '<span class="bot-badge">봇</span>' : ''}
            <span class="timestamp">${timeStr}</span>
          </div>
          <div class="message-text">${contentHtml}</div>
          ${attachmentsHtml}
          ${embedsHtml}
        </div>
      </div>
    `;
  }

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="ko">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>시아 삭제 메시지 아카이브 - #${escapeHtml(channel?.name || "알수없음")}</title>
      <style>
        body {
          background-color: #313338;
          color: #dbdee1;
          font-family: 'gg sans', 'Noto Sans KR', sans-serif;
          margin: 0;
          padding: 24px;
        }
        .chat-container {
          max-width: 1000px;
          margin: 0 auto;
        }
        .header {
          border-bottom: 1px solid #3f4147;
          padding-bottom: 16px;
          margin-bottom: 24px;
        }
        .header h1 {
          font-size: 24px;
          margin: 0 0 8px 0;
          color: #f2f3f5;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .header-hashtag {
          color: #80848e;
          font-weight: 300;
        }
        .header-meta {
          font-size: 14px;
          color: #949ba4;
        }
        .message-group {
          display: flex;
          gap: 16px;
          margin-bottom: 16px;
          padding: 8px 16px;
          border-radius: 8px;
          transition: background-color 0.1s;
        }
        .message-group:hover {
          background-color: #2e3035;
        }
        .avatar {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          object-fit: cover;
        }
        .message-content {
          flex-grow: 1;
        }
        .author-info {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 4px;
        }
        .author-name {
          font-weight: 600;
          color: #f2f3f5;
        }
        .bot-badge {
          background-color: #5865f2;
          color: #ffffff;
          font-size: 10px;
          font-weight: 600;
          padding: 1px 4px;
          border-radius: 3px;
        }
        .timestamp {
          font-size: 12px;
          color: #949ba4;
        }
        .message-text {
          font-size: 15px;
          line-height: 1.375;
          white-space: pre-wrap;
          word-break: break-all;
        }
        .attachment-box {
          display: flex;
          align-items: center;
          gap: 12px;
          background-color: #2b2d31;
          border: 1px solid #1e1f22;
          border-radius: 4px;
          padding: 12px;
          margin-top: 8px;
          max-width: 520px;
        }
        .attachment-icon {
          font-size: 24px;
        }
        .attachment-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .attachment-name {
          color: #00a8fc;
          text-decoration: none;
          font-weight: 500;
        }
        .attachment-name:hover {
          text-decoration: underline;
        }
        .attachment-size {
          font-size: 12px;
          color: #949ba4;
        }
        .image-preview {
          margin-top: 8px;
          max-width: 400px;
          max-height: 300px;
          border-radius: 4px;
          border: 1px solid #2b2d31;
          object-fit: contain;
        }
        .embed-box {
          margin-top: 8px;
          background-color: #2b2d31;
          border-left: 4px solid #1e1f22;
          border-radius: 4px;
          padding: 12px 16px;
          max-width: 520px;
        }
        .embed-author {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          font-weight: 600;
          color: #f2f3f5;
        }
        .embed-author-icon {
          width: 24px;
          height: 24px;
          border-radius: 50%;
        }
        .embed-title {
          font-size: 16px;
          font-weight: 600;
          color: #00a8fc;
          text-decoration: none;
          margin-top: 4px;
        }
        .embed-title:hover {
          text-decoration: underline;
        }
        .embed-description {
          font-size: 14px;
          margin-top: 8px;
          white-space: pre-wrap;
        }
        .embed-fields {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 8px;
        }
        .embed-field {
          flex: 1 1 100%;
          min-width: 150px;
        }
        .embed-field.inline {
          flex: 1 1 30%;
        }
        .embed-field-name {
          font-size: 13px;
          font-weight: 600;
          color: #949ba4;
          margin-bottom: 2px;
        }
        .embed-field-value {
          font-size: 13px;
        }
        .embed-thumbnail {
          width: 80px;
          height: 80px;
          border-radius: 4px;
          object-fit: cover;
          margin-left: 16px;
        }
        .embed-image {
          margin-top: 8px;
          max-width: 100%;
          border-radius: 4px;
        }
        .embed-footer {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: #949ba4;
          margin-top: 8px;
        }
        .embed-footer-icon {
          width: 20px;
          height: 20px;
          border-radius: 50%;
          object-fit: cover;
        }
      </style>
    </head>
    <body>
      <div class="chat-container">
        <div class="header">
          <h1>
            <span class="header-hashtag">#</span>
            <span>${escapeHtml(channel?.name || "알수없음")}</span>
          </h1>
          <span class="header-meta">삭제된 메시지: ${messages.size}개</span>
        </div>
        <div class="messages">
          ${messageRows}
        </div>
      </div>
    </body>
    </html>
  `;

  let fileBuffer;
  let fileName;
  let fileDescTip = "";

  if (purgeFormat === 'txt') {
    // TXT 포맷 생성 (모바일 가독성 최적화)
    let txtContent = `[시아 삭제 메시지 아카이브 - #${channel?.name || "알수없음"}]\n`;
    txtContent += `삭제된 메시지: ${messages.size}개\n`;
    txtContent += `발생 시각: ${formatKST(new Date())}\n`;
    txtContent += `============================================================\n\n`;

    for (const msg of msgArray) {
      const author = msg.author;
      const displayName = msg.member?.displayName || author?.username || "알 수 없는 유저";
      const tag = author ? author.tag : "0000";
      const authorId = author ? author.id : "0";
      
      const date = new Date(msg.createdAt || Date.now());
      const kstOffset = 9 * 60 * 60 * 1000;
      const kstDate = new Date(date.getTime() + kstOffset);
      const timeStr = kstDate.toISOString().replace('T', ' ').substring(0, 19);

      txtContent += `[${timeStr}] ${displayName} (${tag} / ID: ${authorId})\n`;
      txtContent += `내용: ${msg.content || "(내용 없음)"}\n`;

      if (msg.attachments && msg.attachments.size > 0) {
        msg.attachments.forEach(att => {
          txtContent += `📎 첨부파일: ${att.name} (${(att.size / 1024).toFixed(1)} KB) - URL: ${att.url}\n`;
        });
      }

      if (msg.embeds && msg.embeds.length > 0) {
        txtContent += `🎨 임베드 데이터:\n`;
        msg.embeds.forEach((emb, i) => {
          txtContent += `  [임베드 #${i + 1}]\n`;
          if (emb.title) txtContent += `  - 제목: ${emb.title}\n`;
          if (emb.description) txtContent += `  - 설명: ${emb.description}\n`;
          if (emb.fields && emb.fields.length > 0) {
            emb.fields.forEach(f => {
              txtContent += `  - 필드: ${f.name} => ${f.value}\n`;
            });
          }
        });
      }
      txtContent += `------------------------------------------------------------\n`;
    }
    txtContent += `============================================================\n`;
    fileBuffer = Buffer.from(txtContent, 'utf-8');
    fileName = `purge-log-${channel?.name || "channel"}.txt`;
    fileDescTip = "💡 **첨부된 TXT 파일**을 다운로드하면 스마트폰 등 모바일 텍스트 뷰어 기기에서도 깨짐 현상 없이 아주 편하게 삭제된 대화 기록을 읽을 수 있습니다. 📱";

  } else if (purgeFormat === 'json') {
    // JSON 포맷 생성 (개발자용 구조화 데이터)
    const jsonData = {
      channel: channel?.name || "unknown",
      channel_id: channelId,
      purge_count: messages.size,
      logged_at: new Date().toISOString(),
      messages: msgArray.map(msg => ({
        message_id: msg.id,
        author: msg.author ? {
          id: msg.author.id,
          username: msg.author.username,
          tag: msg.author.tag,
          bot: msg.author.bot
        } : null,
        content: msg.content,
        created_at: msg.createdAt,
        attachments: msg.attachments ? Array.from(msg.attachments.values()).map(a => ({
          name: a.name,
          url: a.url,
          size_bytes: a.size,
          content_type: a.contentType
        })) : [],
        embeds: msg.embeds ? msg.embeds.map(e => e.data || e) : []
      }))
    };
    fileBuffer = Buffer.from(JSON.stringify(jsonData, null, 2), 'utf-8');
    fileName = `purge-log-${channel?.name || "channel"}.json`;
    fileDescTip = "💡 **첨부된 JSON 파일**을 다운로드하면 대량 삭제된 원본 백업 데이터를 파싱 및 기계 판독할 수 있는 원시(Raw) 구조 데이터로 관리할 수 있습니다. 💻";

  } else {
    // HTML 포맷 생성 (기존 디스코드 비주얼 스타일)
    fileBuffer = Buffer.from(htmlContent, 'utf-8');
    fileName = `purge-log-${channel?.name || "channel"}.html`;
    fileDescTip = "💡 **첨부된 HTML 파일**을 다운로드하여 브라우저로 열면 디스코드와 완벽하게 동일한 미려한 디자인 비주얼로 이미지와 임베드 데이터를 편리하게 읽을 수 있습니다. ✨";
  }

  const fileAttachment = new AttachmentBuilder(fileBuffer, { name: fileName });

  const embed = new EmbedBuilder()
    .setTitle(`${guild.name} 메세지 대량 삭제 로그`)
    .setColor(ERROR_COLOR);

  let desc = `${channel?.toString() || "채널"}에서 메세지 **${messages.size}개**가 대량 삭제되었습니다.\n\n${fileDescTip}`;

  if (executor) {
    embed.addFields(
      { name: "실행자", value: `${executor.toString()} (${executor.id})`, inline: true },
      { name: "사유", value: reason || "사유 없음", inline: true }
    );
  }

  embed.setDescription(desc);

  const timestamp = formatKST(new Date());
  embed.setFooter({ text: `${timestamp}` });

  await logChannel.send({ embeds: [embed], files: [fileAttachment] }).catch(console.error);

  for (const [id, message] of messages) {
    deleteMessageFromDb(id);
  }
}

function isChannelExcluded(guildId, channelId) {
  if (!channelId) return false;
  const guildData = logSettingsCache.get(guildId.toString());
  if (guildData && guildData.excluded_channels) {
    return guildData.excluded_channels.includes(channelId.toString());
  }
  return false;
}

module.exports = {
  name: 'Logging',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('로그')
        .setDescription('실시간 로그 및 대량 삭제 방식을 설정합니다.')
        .addSubcommand(subcommand =>
          subcommand.setName('채널')
            .setDescription('실시간 이벤트를 로깅할 채널 및 방식을 지정합니다.')
            .addStringOption(option =>
              option.setName('방식')
                .setDescription('로그 기록 방식 선택 (일반 채널 로그 / 스레드 로그)')
                .setRequired(true)
                .addChoices(
                  { name: '일반 채널 로그', value: 'normal' },
                  { name: '스레드 로그', value: 'thread' }
                )
            )
        )
        .addSubcommand(subcommand =>
          subcommand.setName('대량삭제')
            .setDescription('메시지 대량 삭제 로그의 보존 표시 파일 포맷을 변경합니다.')
            .addStringOption(option =>
              option.setName('방식')
                .setDescription('내역 저장 포맷 방식 (TXT / HTML / JSON)')
                .setRequired(true)
                .addChoices(
                  { name: 'HTML', value: 'html' },
                  { name: 'TXT', value: 'txt' },
                  { name: 'JSON', value: 'json' }
                )
            )
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        if (!is_registered(interaction.user.id)) {
          return interaction.reply({ content: "`/가입` 명령어 사용 후 이용 가능합니다.", ephemeral: true });
        }

        if (!agreedGuilds.has(interaction.guildId.toString())) {
          return interaction.reply({
            content: "❌ **개인정보 수집 및 메시지 동기화 약관에 동의하지 않았습니다.**\n\n로그 설정 기능을 이용하려면 먼저 `/동의 메시지수집` 명령어를 실행하여 서버 관리자(Administrator)가 수집 약관에 동의해 주셔야 합니다.",
            ephemeral: true
          });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId.toString();

        if (subcommand === '대량삭제') {
          const format = interaction.options.getString('방식');
          
          let guildData = logSettingsCache.get(guildId);
          if (!guildData) {
            guildData = { channels: {}, excluded_channels: [], purge_format: 'html' };
          }
          guildData.purge_format = format;
          saveLogSettings(guildId, guildData);

          const labelMap = {
            'html': 'HTML',
            'txt': 'TXT',
            'json': 'JSON'
          };

          const embed = new EmbedBuilder()
            .setTitle('📁 대량 삭제 보존 포맷 변경 완료')
            .setDescription(`이제 메시지 대량 삭제 발생 시, 아카이브 파일이 **${labelMap[format]}** 포맷으로 생성되어 기록됩니다.`)
            .setColor(MAIN_COLOR)
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        }

        const method = interaction.options.getString('방식');

        const container = new ContainerBuilder()
          .setAccentColor(0x3B82F6) // MAIN_COLOR equivalent
          .addSectionComponents(
            new SectionBuilder()
              .setThumbnailAccessory(
                new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# <:setting:1218535782176784394> 로그 채널 설정\n\n` +
                  `설정할 로그 방식을 아래 드롭다운 메뉴에서 선택해 주세요.\n\n` +
                  `• 선택된 기록 방식: **${method === 'thread' ? '스레드 로그' : '일반 채널 로그'}**\n\n` +
                  `⚠️ **주의**: 로그가 기록되길 원하시는 채널 내에서 이 명령어를 사용해 주셔야 해당 채널로 로그 채널이 지정됩니다.`
                )
              )
          );

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('log_type_select')
          .setPlaceholder('설정할 로그 방식을 선택하세요...')
          .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('채팅 로그').setValue('log_chat').setDescription('메시지 수정/삭제 실시간 로깅').setEmoji('💬'),
            new StringSelectMenuOptionBuilder().setLabel('음성 로그').setValue('log_voice').setDescription('음성방 입장/퇴장/이동 실시간 로깅').setEmoji('🔊'),
            new StringSelectMenuOptionBuilder().setLabel('입/퇴장 로그').setValue('log_enter_exit').setDescription('유저 입장 및 퇴장 실시간 로깅').setEmoji('🚪'),
            new StringSelectMenuOptionBuilder().setLabel('차단 로그').setValue('log_ban').setDescription('유저 차단 실시간 로깅').setEmoji('🛡️'),
            new StringSelectMenuOptionBuilder().setLabel('스레드 로그').setValue('log_thread').setDescription('스레드 생성/삭제/업데이트 실시간 로깅').setEmoji('🧵'),
            new StringSelectMenuOptionBuilder().setLabel('채널 로그').setValue('log_channel').setDescription('채널 생성/삭제/설정 변경 실시간 로깅').setEmoji('📁'),
            new StringSelectMenuOptionBuilder().setLabel('봇 업데이트 공지').setValue('log_update').setDescription('봇 새로운 업데이트 공지 소식 수신').setEmoji('📢'),
            new StringSelectMenuOptionBuilder().setLabel('반응 로그').setValue('log_reaction').setDescription('메시지 반응 추가/삭제 실시간 로깅').setEmoji('🎭'),
            new StringSelectMenuOptionBuilder().setLabel('역할 로그').setValue('log_role').setDescription('역할 생성/삭제/설정 변경 및 유저 역할 변경 실시간 로깅').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel('타임아웃 로그').setValue('log_timeout').setDescription('멤버 타임아웃(활동 제한) 및 해제 실시간 로깅').setEmoji('🔇'),
            new StringSelectMenuOptionBuilder().setLabel('제재 로그').setValue('log_sanction').setDescription('유저 제재(경고 부여, 경고 차감/삭제, 초기화) 실시간 로깅').setEmoji('⚖️'),
            new StringSelectMenuOptionBuilder().setLabel('닉네임 로그').setValue('log_nickname').setDescription('유저 닉네임 변경 및 변경 수행자 감지 실시간 로깅').setEmoji('👤')
          );

        const row = new ActionRowBuilder().addComponents(selectMenu);
        container.addActionRowComponents(row);

        const response = await interaction.reply({
          components: [container],
          flags: [MessageFlags.IsComponentsV2]
        });
        
        const collector = response.createMessageComponentCollector({ time: 60000 });

        collector.on('collect', async i => {
          if (i.user.id !== interaction.user.id) {
            return i.reply({ content: '설정은 명령어를 사용한 관리자만 조작 가능합니다.', ephemeral: true });
          }

          if (!i.isStringSelectMenu()) return;
          if (i.customId !== 'log_type_select') return;

          const logType = i.values[0];
          const labelMap = {
            'log_chat': '채팅',
            'log_voice': '음성',
            'log_enter_exit': '입/퇴장',
            'log_ban': '차단',
            'log_thread': '스레드',
            'log_channel': '채널',
            'log_update': '봇 업데이트 공지',
            'log_reaction': '반응',
            'log_role': '역할',
            'log_timeout': '타임아웃',
            'log_sanction': '제재',
            'log_nickname': '닉네임'
          };
          const label = labelMap[logType];

          let guildData = logSettingsCache.get(guildId);
          if (!guildData) {
            guildData = { channels: {}, excluded_channels: [] };
          }
          if (!guildData.channels) {
            guildData.channels = {};
          }
          
          const existingChannelData = guildData.channels[logType];
          if (existingChannelData && existingChannelData.id) {
            // Already registered, ask to overwrite
            const confirmContainer = new ContainerBuilder()
              .setAccentColor(0x3B82F6)
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# ⚠️ 로그 채널 중복 감지\n\n` +
                      `이미 **${label} 로그**로 지정된 채널이 존재합니다:\n` +
                      `• 기존 채널: <#${existingChannelData.id}> (${existingChannelData.name || '알 수 없음'})\n\n` +
                      `로그 채널을 현재 채널인 ${interaction.channel.toString()}(으)로 변경하시겠습니까?\n` +
                      `• 기록 방식: **${method === 'thread' ? '스레드 로그' : '일반 채널 로그'}**`
                    )
                  )
              );

            const buttonsRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('confirm_log_change')
                .setLabel('변경하기')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId('cancel_log_change')
                .setLabel('취소하기')
                .setStyle(ButtonStyle.Danger)
            );

            confirmContainer.addActionRowComponents(buttonsRow);

            await i.update({
              components: [confirmContainer],
              flags: [MessageFlags.IsComponentsV2]
            });

            const buttonCollector = response.createMessageComponentCollector({
              filter: btnInt => btnInt.user.id === interaction.user.id && (btnInt.customId === 'confirm_log_change' || btnInt.customId === 'cancel_log_change'),
              time: 30000,
              max: 1
            });

            buttonCollector.on('collect', async btnInt => {
              if (btnInt.customId === 'confirm_log_change') {
                guildData.channels[logType] = {
                  ...serialize_channel(interaction.channel),
                  method: method
                };
                saveLogSettings(guildId, guildData);

                if (method === 'thread') {
                  await getLogChannel(interaction.client, guildId, logType);
                }

                const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' (KST)';
                
                const successContainer = new ContainerBuilder()
                  .setAccentColor(0x10B981)
                  .addSectionComponents(
                    new SectionBuilder()
                      .setThumbnailAccessory(
                        new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005198143-e5283b519a7f?auto=format&fit=crop&q=80&w=256&h=256')
                      )
                      .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                          `# <:setting:1324295080059867146> ${label} 로그 채널 변경 완료\n\n` +
                          `로그 채널이 현재 채널 ${interaction.channel.toString()}(으)로 성공적으로 변경되었습니다.\n` +
                          `• 기록 방식: **${method === 'thread' ? '스레드 로그' : '일반 채널 로그'}**\n\n` +
                          `*변경 시간: ${timeStr}*`
                        )
                      )
                  );

                await btnInt.update({
                  components: [successContainer],
                  flags: [MessageFlags.IsComponentsV2]
                });
              } else {
                const cancelContainer = new ContainerBuilder()
                  .setAccentColor(0xEF4444)
                  .addSectionComponents(
                    new SectionBuilder()
                      .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                          `# ❌ 로그 채널 변경 취소\n\n` +
                          `설정 변경이 취소되었습니다. 기존의 로그 채널 설정이 그대로 유지됩니다.`
                        )
                      )
                  );

                await btnInt.update({
                  components: [cancelContainer],
                  flags: [MessageFlags.IsComponentsV2]
                });
              }
              collector.stop();
            });

            buttonCollector.on('end', (collected, reason) => {
              if (reason === 'time' && collected.size === 0) {
                const timeoutContainer = new ContainerBuilder()
                  .setAccentColor(0x6B7280)
                  .addSectionComponents(
                    new SectionBuilder()
                      .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                          `# ⌛ 시간 초과\n\n` +
                          `시간이 초과되어 설정 변경이 취소되었습니다.`
                        )
                      )
                  );
                interaction.editReply({
                  components: [timeoutContainer],
                  flags: [MessageFlags.IsComponentsV2]
                }).catch(() => null);
                collector.stop();
              }
            });

          } else {
            guildData.channels[logType] = {
              ...serialize_channel(interaction.channel),
              method: method
            };
            saveLogSettings(guildId, guildData);

            if (method === 'thread') {
              await getLogChannel(interaction.client, guildId, logType);
            }

            const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' (KST)';
            
            const successContainer = new ContainerBuilder()
              .setAccentColor(0x10B981) // SUCCESS_COLOR equivalent
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005198143-e5283b519a7f?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# <:setting:1324295080059867146> ${label} 로그 설정 완료\n\n` +
                      `현재 채널 ${interaction.channel.toString()}이(가) **${label} 로그 채널**로 성공적으로 지정되었습니다.\n` +
                      `• 기록 방식: **${method === 'thread' ? '스레드 로그' : '일반 채널 로그'}**\n\n` +
                      `*설정 시간: ${timeStr}*`
                    )
                  )
              );

            await i.update({
              components: [successContainer],
              flags: [MessageFlags.IsComponentsV2]
            });
            collector.stop();
          }
        });

        collector.on('end', (collected, reason) => {
          if (reason === 'time') {
            const disabledRow = new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('log_type_select_disabled')
                .setPlaceholder('시간이 초과되어 설정할 수 없습니다.')
                .setDisabled(true)
                .addOptions(new StringSelectMenuOptionBuilder().setLabel('시간 초과').setValue('timeout'))
            );
            interaction.editReply({
              components: [disabledRow],
              flags: [MessageFlags.IsComponentsV2]
            }).catch(() => null);
          }
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('로그삭제')
        .setDescription('로그 설정을 해제합니다.'),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        if (!is_registered(interaction.user.id)) {
          return interaction.reply({ content: "`/가입` 명령어 사용 후 이용 가능합니다.", ephemeral: true });
        }

        if (!agreedGuilds.has(interaction.guildId.toString())) {
          return interaction.reply({
            content: "❌ **개인정보 수집 및 메시지 동기화 약관에 동의하지 않았습니다.**\n\n로그 설정 해제 기능을 이용하려면 먼저 `/동의 메시지수집` 명령어를 실행하여 서버 관리자(Administrator)가 수집 약관에 동의해 주셔야 합니다.",
            ephemeral: true
          });
        }

        const container = new ContainerBuilder()
          .setAccentColor(0xEF4444) // ERROR_COLOR equivalent
          .addSectionComponents(
            new SectionBuilder()
              .setThumbnailAccessory(
                new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005198140-d5a4bb80a1c6?auto=format&fit=crop&q=80&w=256&h=256')
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# <:setting:1218535782176784394> 로그 설정 해제\n\n` +
                  `삭제(연동 해제)할 로그 타입을 아래 드롭다운 메뉴에서 선택해 주세요.`
                )
              )
          );

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('log_delete_select')
          .setPlaceholder('해제할 로그 방식을 선택하세요...')
          .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('채팅 로그 해제').setValue('del_chat').setDescription('채팅 로그 연동 해제').setEmoji('💬'),
            new StringSelectMenuOptionBuilder().setLabel('음성 로그 해제').setValue('del_voice').setDescription('음성 로그 연동 해제').setEmoji('🔊'),
            new StringSelectMenuOptionBuilder().setLabel('입/퇴장 로그 해제').setValue('del_enter_exit').setDescription('입/퇴장 로그 연동 해제').setEmoji('🚪'),
            new StringSelectMenuOptionBuilder().setLabel('차단 로그 해제').setValue('del_ban').setDescription('차단 로그 연동 해제').setEmoji('🛡️'),
            new StringSelectMenuOptionBuilder().setLabel('스레드 로그 해제').setValue('del_thread').setDescription('스레드 로그 연동 해제').setEmoji('🧵'),
            new StringSelectMenuOptionBuilder().setLabel('채널 로그 해제').setValue('del_channel').setDescription('채널 로그 연동 해제').setEmoji('📁'),
            new StringSelectMenuOptionBuilder().setLabel('봇 업데이트 공지 해제').setValue('del_update').setDescription('봇 업데이트 공지 연동 해제').setEmoji('📢'),
            new StringSelectMenuOptionBuilder().setLabel('반응 로그 해제').setValue('del_reaction').setDescription('반응 로그 연동 해제').setEmoji('🎭'),
            new StringSelectMenuOptionBuilder().setLabel('역할 로그 해제').setValue('del_role').setDescription('역할 로그 연동 해제').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel('타임아웃 로그 해제').setValue('del_timeout').setDescription('타임아웃 로그 연동 해제').setEmoji('🔇'),
            new StringSelectMenuOptionBuilder().setLabel('제재 로그 해제').setValue('del_sanction').setDescription('제재 로그 연동 해제').setEmoji('⚖️'),
            new StringSelectMenuOptionBuilder().setLabel('닉네임 로그 해제').setValue('del_nickname').setDescription('닉네임 로그 연동 해제').setEmoji('👤'),
            new StringSelectMenuOptionBuilder().setLabel('로그 전체 삭제').setValue('del_all').setDescription('모든 로그 채널 설정을 일괄 해제합니다.').setEmoji('🗑️')
          );

        const row = new ActionRowBuilder().addComponents(selectMenu);
        container.addActionRowComponents(row);

        const response = await interaction.reply({
          components: [container],
          flags: [MessageFlags.IsComponentsV2]
        });
        
        const collector = response.createMessageComponentCollector({ time: 60000 });

        collector.on('collect', async i => {
          if (i.user.id !== interaction.user.id) {
            return i.reply({ content: '삭제는 명령어를 사용한 관리자만 조작 가능합니다.', ephemeral: true });
          }

          if (!i.isStringSelectMenu()) return;
          if (i.customId !== 'log_delete_select') return;

          const delType = i.values[0];
          const guildId = interaction.guildId.toString();

          if (delType === 'del_all') {
            let guildData = logSettingsCache.get(guildId);
            if (guildData && guildData.channels) {
              guildData.channels = {};
              saveLogSettings(guildId, guildData);
            }

            const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' (KST)';
            const deleteContainer = new ContainerBuilder()
              .setAccentColor(0xEF4444)
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005198140-d5a4bb80a1c6?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# <:setting:1324295080059867146> 로그 전체 삭제 완료\n\n` +
                      `이 서버의 모든 로그 채널 설정이 성공적으로 일괄 해제(초기화)되었습니다.\n\n` +
                      `*처리 시간: ${timeStr}*`
                    )
                  )
              );

            await i.update({
              components: [deleteContainer],
              flags: [MessageFlags.IsComponentsV2]
            });
            collector.stop();
            return;
          }

          const logTypeMap = {
            'del_chat': 'log_chat',
            'del_voice': 'log_voice',
            'del_enter_exit': 'log_enter_exit',
            'del_ban': 'log_ban',
            'del_thread': 'log_thread',
            'del_channel': 'log_channel',
            'del_update': 'log_update',
            'del_reaction': 'log_reaction',
            'del_role': 'log_role',
            'del_timeout': 'log_timeout',
            'del_sanction': 'log_sanction',
            'del_nickname': 'log_nickname'
          };
          const logType = logTypeMap[delType];

          const labelMap = {
            'log_chat': '채팅',
            'log_voice': '음성',
            'log_enter_exit': '입/퇴장',
            'log_ban': '차단',
            'log_thread': '스레드',
            'log_channel': '채널',
            'log_update': '봇 업데이트 공지',
            'log_reaction': '반응',
            'log_role': '역할',
            'log_timeout': '타임아웃',
            'log_sanction': '제재',
            'log_nickname': '닉네임'
          };
          const label = labelMap[logType];

          let guildData = logSettingsCache.get(guildId);
          if (guildData && guildData.channels && guildData.channels[logType]) {
            delete guildData.channels[logType];
            saveLogSettings(guildId, guildData);
          }

          const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' (KST)';
          
          const deleteContainer = new ContainerBuilder()
            .setAccentColor(0xEF4444)
            .addSectionComponents(
              new SectionBuilder()
                .setThumbnailAccessory(
                  new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005198140-d5a4bb80a1c6?auto=format&fit=crop&q=80&w=256&h=256')
                )
                .addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(
                    `# <:setting:1324295080059867146> ${label} 로그 삭제 완료\n\n` +
                    `지정된 채널이 **${label} 로그**에서 정상적으로 해제되었습니다.\n\n` +
                    `*처리 시간: ${timeStr}*`
                  )
                )
            );

          await i.update({
            components: [deleteContainer],
            flags: [MessageFlags.IsComponentsV2]
          });
          collector.stop();
        });

        collector.on('end', (collected, reason) => {
          if (reason === 'time') {
            const disabledRow = new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('log_delete_select_disabled')
                .setPlaceholder('시간이 초과되어 삭제할 수 없습니다.')
                .setDisabled(true)
                .addOptions(new StringSelectMenuOptionBuilder().setLabel('시간 초과').setValue('timeout'))
            );
            interaction.editReply({
              components: [disabledRow],
              flags: [MessageFlags.IsComponentsV2]
            }).catch(() => null);
          }
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('로그조회')
        .setDescription('이 서버에 설정된 모든 로그 채널을 조회합니다.'),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const guildId = interaction.guildId.toString();
        const guildData = logSettingsCache.get(guildId);

        const embed = new EmbedBuilder()
          .setTitle('📁 이 서버의 로그 채널 설정 현황')
          .setColor(MAIN_COLOR)
          .setTimestamp();

        const labels = {
          'log_chat': '💬 채팅 로그',
          'log_voice': '🔊 음성 로그',
          'log_enter_exit': '🚪 입/퇴장 로그',
          'log_ban': '🛡️ 차단 로그',
          'log_thread': '🧵 스레드 로그',
          'log_channel': '📁 채널 로그',
          'log_update': '📢 봇 업데이트 공지 로그',
          'log_reaction': '🎭 반응 로그',
          'log_role': '🏷️ 역할 로그',
          'log_timeout': '🔇 타임아웃 로그',
          'log_sanction': '⚖️ 제재 로그',
          'log_nickname': '👤 닉네임 로그'
        };

        const purgeFormat = (guildData && guildData.purge_format) || 'html';
        const formatLabelMap = {
          'html': 'HTML',
          'txt': 'TXT',
          'json': 'JSON'
        };

        let activeCount = 0;
        let desc = `현재 설정된 실시간 시스템 로그 채널 목록입니다.\n\n` +
          `📁 **대량 삭제 아카이브 방식**\n• \`${formatLabelMap[purgeFormat]}\` (\`/로그 대량삭제\`로 변경 가능)\n\n` +
          `========================================\n\n`;

        for (const [key, label] of Object.entries(labels)) {
          let chanMention = '❌ 미설정';
          if (guildData && guildData.channels && guildData.channels[key]) {
            const channelData = guildData.channels[key];
            const chanId = channelData.id;
            let channel = interaction.guild.channels.cache.get(chanId);
            if (!channel) {
              channel = await interaction.client.channels.fetch(chanId).catch(() => null);
            }
            if (channel) {
              if (channelData.method === 'thread') {
                const logTypeLabels = {
                  'log_chat': '💬-채팅-로그',
                  'log_voice': '🔊-음성-로그',
                  'log_enter_exit': '🚪-입퇴장-로그',
                  'log_ban': '🛡️-차단-로그',
                  'log_thread': '🧵-스레드-로그',
                  'log_channel': '📁-채널-로그',
                  'log_update': '📢-봇공지-로그',
                  'log_reaction': '🎭-반응-로그',
                  'log_role': '🏷️-역할-로그',
                  'log_timeout': '🔇-타임아웃-로그',
                  'log_sanction': '⚖️-제재-로그',
                  'log_nickname': '👤-닉네임-로그'
                };
                const threadName = logTypeLabels[key] || `${key}-로그`;
                let thread = channel.threads?.cache.find(t => t.name === threadName);
                if (!thread) {
                  thread = interaction.guild.channels.cache.find(t => t.isThread() && t.parentId === chanId && t.name === threadName);
                }
                if (thread) {
                  chanMention = `${thread.toString()} (ID: \`${thread.id}\`)`;
                } else {
                  try {
                    const activeThreads = await channel.threads.fetchActive().catch(() => null);
                    thread = activeThreads?.threads.find(t => t.name === threadName);
                    if (!thread) {
                      const archivedThreads = await channel.threads.fetchArchived().catch(() => null);
                      thread = archivedThreads?.threads.find(t => t.name === threadName);
                    }
                  } catch (err) {
                    console.error(`Failed to fetch threads for ${key}:`, err);
                  }
                  
                  if (thread) {
                    chanMention = `${thread.toString()} (ID: \`${thread.id}\`)`;
                  } else {
                    chanMention = `${channel.toString()} (스레드 미생성, 상위 ID: \`${chanId}\`)`;
                  }
                }
              } else {
                chanMention = `${channel.toString()} (ID: \`${chanId}\`)`;
              }
              activeCount++;
            } else {
              chanMention = `⚠️ 채널 없음 (ID: \`${chanId}\`)`;
            }
          }
          desc += `**${label}**\n• ${chanMention}\n\n`;
        }

        embed.setDescription(desc);
        embed.setFooter({ text: `활성화된 로그 채널: ${activeCount}개` });

        return interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('로그제외')
        .setDescription('로그 대상에서 제외할 채널을 설정하거나 해제합니다.')
        .addSubcommand(subcommand => 
          subcommand.setName('추가')
            .setDescription('특정 채널을 로그 기록 대상에서 제외합니다.')
            .addChannelOption(option => option.setName('채널').setDescription('제외할 채널').setRequired(true))
        )
        .addSubcommand(subcommand => 
          subcommand.setName('삭제')
            .setDescription('제외된 채널을 다시 로그 기록 대상에 포함시킵니다.')
            .addChannelOption(option => option.setName('채널').setDescription('다시 포함할 채널').setRequired(true))
        )
        .addSubcommand(subcommand => 
          subcommand.setName('목록')
            .setDescription('현재 로그 대상에서 제외된 모든 채널 목록을 확인합니다.')
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        if (!is_registered(interaction.user.id)) {
          return interaction.reply({ content: "`/가입` 명령어 사용 후 이용 가능합니다.", ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId.toString();

        let guildData = logSettingsCache.get(guildId);
        if (!guildData) {
          guildData = { channels: {}, excluded_channels: [] };
        }
        if (!guildData.excluded_channels) {
          guildData.excluded_channels = [];
        }

        if (subcommand === '추가') {
          const channel = interaction.options.getChannel('채널');
          if (guildData.excluded_channels.includes(channel.id)) {
            return interaction.reply({ content: `❌ ${channel.toString()} 채널은 이미 제외 목록에 존재해요 !`, flags: [MessageFlags.Ephemeral] });
          }
          guildData.excluded_channels.push(channel.id);
          saveLogSettings(guildId, guildData);

          const embed = new EmbedBuilder()
            .setTitle('🔇 로그 제외 채널 추가')
            .setDescription(`${channel.toString()} 채널이 로그 기록 제외 목록에 추가되었어요 !\n이제 이 채널에서 발생하는 채팅 수정/삭제 및 기타 이벤트는 로깅되지 않아요.`)
            .setColor(SUCCESS_COLOR)
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        } 
        
        else if (subcommand === '삭제') {
          const channel = interaction.options.getChannel('채널');
          const index = guildData.excluded_channels.indexOf(channel.id);
          if (index === -1) {
            return interaction.reply({ content: `❌ ${channel.toString()} 채널은 제외 목록에 존재하지 않아요 !`, flags: [MessageFlags.Ephemeral] });
          }
          guildData.excluded_channels.splice(index, 1);
          saveLogSettings(guildId, guildData);

          const embed = new EmbedBuilder()
            .setTitle('🔊 로그 제외 채널 삭제')
            .setDescription(`${channel.toString()} 채널이 로그 기록 제외 목록에서 제거되었어요 !\n이제 이 채널에서 발생하는 이벤트가 다시 정상적으로 로깅되어요.`)
            .setColor(SUCCESS_COLOR)
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        } 
        
        else if (subcommand === '목록') {
          const excludedList = guildData.excluded_channels
            .map(id => {
              const chan = interaction.guild.channels.cache.get(id);
              return chan ? `• ${chan.toString()} (\`${id}\`)` : `• 알 수 없는 채널 (\`${id}\`)`;
            });

          const embed = new EmbedBuilder()
            .setTitle('🔇 로그 제외 채널 목록')
            .setColor(MAIN_COLOR)
            .setTimestamp();

          if (excludedList.length > 0) {
            embed.setDescription(excludedList.join('\n'));
          } else {
            embed.setDescription('현재 로그 제외 대상으로 지정된 채널이 없어요 !');
          }

          return interaction.reply({ embeds: [embed] });
        }
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('동의')
        .setDescription('시아 봇 사용 및 개인정보 수집 동의 사항을 관리합니다.')
        .addSubcommand(sub =>
          sub
            .setName('메시지수집')
            .setDescription('이 서버의 메시지 로깅 및 동기화 수집 약관을 검토하고 설정합니다.')
        ),
      async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const guildId = interaction.guild.id.toString();

        const container = new ContainerBuilder()
          .setAccentColor(0x3B82F6) // MAIN_COLOR equivalent
          .addSectionComponents(
            new SectionBuilder()
              .setThumbnailAccessory(
                new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# 📋 개인정보 수집 및 메시지 동기화 약관 동의서\n\n` +
                  `본 디스코드 서버의 원활한 운영 및 모니터링(메시지 삭제/수정 실시간 로깅, 보안 감사 등)을 위하여 시아(Sia) 봇의 **메시지 데이터 수집 및 실시간 동기화 기능**을 활성화하고자 합니다.\n\n` +
                  `법적 효력이 있는 약관 동의를 위해 아래의 수집 목적 및 범위를 명확히 고지하오니, 꼼꼼하게 읽어보신 후 동의 여부를 선택해 주시기 바랍니다.\n\n` +
                  `### 1. 수집 목적 (Purpose of Collection)\n` +
                  `• 실시간 감사 로그 제공 (메시지 삭제/수정 감지 및 로깅)\n` +
                  `• 누락 없는 완벽한 서버 데이터 동기화 및 백그라운드 무결성 유지\n` +
                  `• 도배 방지(Anti-Spam) 및 유해어 필터링 등 보안 모듈 성능 고도화\n\n` +
                  `### 2. 수집 대상 및 범위 (Scope & Data Collected)\n` +
                  `• 대상: 본 서버 내 동의 이후 전송되는 모든 텍스트 메시지 및 첨부파일 메타데이터\n` +
                  `• 수집 항목: 메시지 고유 ID, 작성자 ID 및 태그, 메시지 본문(텍스트), 전송 시간(Timestamp), 채널 ID\n` +
                  `• **※ 비고**: 비밀번호, 개인 식별 정보 등 민감한 데이터는 일절 선별/수집하지 않으며, 수집된 모든 내용은 외부 접근이 불가한 로컬 데이터베이스(\`xiadb.db\`) 내에 안전하게 보관됩니다.\n\n` +
                  `### 3. 보유 및 이용 기간 (Retention & Rights)\n` +
                  `• 서비스 제공 기간 동안 안전하게 보관되며, 아래의 **[미동의/동의철회]** 버튼 클릭 시 해당 서버의 모든 메시지 아카이브는 **즉시 및 영구적으로 복구 불가능하게 파기**됩니다.\n\n` +
                  `### 4. 약관의 효력 (Legal Effect)\n` +
                  `• 본 서버의 **관리자(Administrator)** 권한을 가진 운영진이 아래 **[동의함]** 버튼을 클릭하여 수락을 선언하는 즉시 약관의 효력이 발생합니다.`
                )
              )
          );

        const agreeBtn = new ButtonBuilder()
          .setCustomId('agreement_agree')
          .setLabel('동의함 (Accept)')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success);

        const withdrawBtn = new ButtonBuilder()
          .setCustomId('agreement_withdraw')
          .setLabel('미동의/동의철회 (Decline)')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(agreeBtn, withdrawBtn);
        container.addActionRowComponents(row);

        const response = await interaction.reply({
          components: [container],
          flags: [MessageFlags.IsComponentsV2]
        });

        const filter = i => ['agreement_agree', 'agreement_withdraw'].includes(i.customId) && i.user.id === interaction.user.id;
        const collector = response.createMessageComponentCollector({ filter, time: 60000 });

        collector.on('collect', async i => {
          if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return i.reply({ content: '❌ 이 약관 동의는 서버 관리자(Administrator)만 결정할 수 있습니다.', ephemeral: true });
          }

          const userId = i.user.id.toString();
          const timestamp = new Date().toISOString();

          if (i.customId === 'agreement_agree') {
            db.run(
              "INSERT OR REPLACE INTO server_agreements VALUES (?, 1, ?, ?)",
              [guildId, userId, timestamp],
              async (err) => {
                if (err) {
                  console.error("Error saving agreement:", err);
                  return i.reply({ content: "동의 정보를 데이터베이스에 저장하는 중 오류가 발생했습니다.", ephemeral: true });
                }
                
                agreedGuilds.add(guildId);
                
                const agreedContainer = new ContainerBuilder()
                  .setAccentColor(0x10B981) // SUCCESS_COLOR
                  .addSectionComponents(
                    new SectionBuilder()
                      .setThumbnailAccessory(
                        new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005198143-e5283b519a7f?auto=format&fit=crop&q=80&w=256&h=256')
                      )
                      .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                          `# ✅ 메시지 수집 동의 수락 완료\n\n` +
                          `**${i.guild.name}** 서버의 메시지 수집 약관에 성공적으로 **동의**하셨습니다.\n\n` +
                          `• **작동 상태**: 메시지 실시간 로깅 및 백그라운드 모니터링 가동 중 🟢\n` +
                          `• **데이터 보장**: 이 서버의 채널별 최근 메시지 300개를 백그라운드에서 즉시 동기화하고 있습니다.\n\n` +
                          `약관의 효력이 활성화되었으며, 언제든지 동일 명령어를 통해 동의를 철회할 수 있습니다.\n\n` +
                          `*수행자: ${i.user.tag} • ${formatKST(new Date())}*`
                        )
                      )
                  );

                await i.update({
                  components: [agreedContainer],
                  flags: [MessageFlags.IsComponentsV2]
                });

                // Instantly trigger history sync
                try {
                  syncGuildHistory(i.client, guildId);
                } catch (syncErr) {
                  console.error("Immediate sync error for guild:", guildId, syncErr);
                }
              }
            );
          } else if (i.customId === 'agreement_withdraw') {
            db.run(
              "INSERT OR REPLACE INTO server_agreements VALUES (?, 0, ?, ?)",
              [guildId, userId, timestamp],
              (err) => {
                if (err) {
                  console.error("Error withdrawing agreement:", err);
                  return i.reply({ content: "동의 철회 처리 중 오류가 발생했습니다.", ephemeral: true });
                }
                
                agreedGuilds.delete(guildId);
                
                // Purge collected messages for privacy compliance
                db.run(
                  "DELETE FROM messages WHERE guild_id = ?",
                  [guildId],
                  async (delErr) => {
                    if (delErr) console.error("Error purging guild messages:", delErr);
                    
                    // Purge log channel configurations from log_settings.json for privacy compliance
                    try {
                      const settings = load_json(LOG_SETTINGS_FILE);
                      if (settings[guildId]) {
                        delete settings[guildId];
                        save_json(LOG_SETTINGS_FILE, settings);
                      }
                    } catch (jsonPurgeErr) {
                      console.error("Error purging JSON settings for guild:", guildId, jsonPurgeErr);
                    }
                    
                    const withdrawnContainer = new ContainerBuilder()
                      .setAccentColor(0xEF4444) // ERROR_COLOR
                      .addSectionComponents(
                        new SectionBuilder()
                          .setThumbnailAccessory(
                            new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005198140-d5a4bb80a1c6?auto=format&fit=crop&q=80&w=256&h=256')
                          )
                          .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(
                              `# ❌ 메시지 수집 동의 철회 완료\n\n` +
                              `**${i.guild.name}** 서버의 메시지 수집 동의를 **철회**하셨습니다.\n\n` +
                              `• **작동 상태**: 실시간 메시지 수집 및 로깅 즉시 중단 🔴\n` +
                              `• **데이터 보호 조치**: 이 서버에서 수집되었던 데이터베이스의 모든 메시지 내역이 **즉시 영구 삭제**되었습니다.\n\n` +
                              `*수행자: ${i.user.tag} • ${formatKST(new Date())}*`
                            )
                          )
                      );

                    await i.update({
                      components: [withdrawnContainer],
                      flags: [MessageFlags.IsComponentsV2]
                    });
                  }
                );
              }
            );
          }
        });

        collector.on('end', collected => {
          if (collected.size === 0) {
            const disabledRow = new ActionRowBuilder().addComponents(
              agreeBtn.setDisabled(true),
              withdrawBtn.setDisabled(true)
            );
            const disabledContainer = new ContainerBuilder()
              .setAccentColor(0x3B82F6)
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# 📋 개인정보 수집 및 메시지 동기화 약관 동의서\n\n` +
                      `*(시간이 만료되어 세션이 종료되었습니다. 다시 설정하려면 명령어를 다시 실행해 주세요.)*`
                    )
                  )
              )
              .addActionRowComponents(disabledRow);
            
            interaction.editReply({
              components: [disabledContainer],
              flags: [MessageFlags.IsComponentsV2]
            }).catch(() => null);
          }
        });
      }
    }
  ],
  listeners: {
    // Ready Event: Synchronize historical channel messages on startup in the background
    async ready(client) {
      process.nextTick(async () => {
        try {
          await loadAgreements();
          await syncGuildHistory(client);

          // Run periodic synchronization every 1 minute to make sure no offline messages are missed!
          setInterval(async () => {
            console.log("[Sync] Running periodic background message synchronization...");
            try {
              await syncGuildHistory(client);
            } catch (err) {
              console.error("[Sync] Error in periodic sync task:", err);
            }
          }, 60 * 1000); // 1 minute
        } catch (e) {
          console.error("[Sync] Error in ready sync task:", e);
        }
      });
    },

    // Thread Create Log
    async threadCreate(client, thread) {
      if (!thread.guild || !agreedGuilds.has(thread.guild.id.toString())) return;
      if (isChannelExcluded(thread.guild.id, thread.id) || isChannelExcluded(thread.guild.id, thread.parentId)) return;

      const logChannel = await getLogChannel(client, thread.guild.id, 'log_thread');
      if (!logChannel) return;

      const embed = new EmbedBuilder()
        .setTitle('🧵 스레드 생성됨')
        .setDescription(`새로운 스레드가 생성되었습니다.\n\n• **이름**: ${thread.toString()} (\`${thread.name}\`)\n• **상위 채널**: <#${thread.parentId}>\n• **유형**: ${thread.type === 12 ? '프라이빗 스레드' : '퍼블릭 스레드'}`)
        .setColor(MAIN_COLOR)
        .setTimestamp();

      await logChannel.send({ embeds: [embed] }).catch(() => {});
    },

    // Thread Delete Log
    async threadDelete(client, thread) {
      if (!thread.guild || !agreedGuilds.has(thread.guild.id.toString())) return;
      if (isChannelExcluded(thread.guild.id, thread.id) || isChannelExcluded(thread.guild.id, thread.parentId)) return;

      const logChannel = await getLogChannel(client, thread.guild.id, 'log_thread');
      if (!logChannel) return;

      const embed = new EmbedBuilder()
        .setTitle('🗑️ 스레드 삭제됨')
        .setDescription(`스레드가 삭제되었습니다.\n\n• **이름**: \`${thread.name}\`\n• **상위 채널**: <#${thread.parentId}>\n• **유형**: ${thread.type === 12 ? '프라이빗 스레드' : '퍼블릭 스레드'}`)
        .setColor(ERROR_COLOR)
        .setTimestamp();

      await logChannel.send({ embeds: [embed] }).catch(() => {});
    },

    // Thread Update Log
    async threadUpdate(client, oldThread, newThread) {
      if (!newThread.guild || !agreedGuilds.has(newThread.guild.id.toString())) return;
      if (isChannelExcluded(newThread.guild.id, newThread.id) || isChannelExcluded(newThread.guild.id, newThread.parentId)) return;

      const logChannel = await getLogChannel(client, newThread.guild.id, 'log_thread');
      if (!logChannel) return;

      const changes = [];
      if (oldThread.name !== newThread.name) {
        changes.push(`• **이름 변경**: \`${oldThread.name}\` ➡️ \`${newThread.name}\``);
      }
      if (oldThread.archived !== newThread.archived) {
        changes.push(`• **상태 변경**: ${oldThread.archived ? '📁 보관됨' : '📖 활성화됨'} ➡️ ${newThread.archived ? '📁 보관됨' : '📖 활성화됨'}`);
      }
      if (oldThread.locked !== newThread.locked) {
        changes.push(`• **잠금 변경**: ${oldThread.locked ? '🔒 잠김' : '🔓 풀림'} ➡️ ${newThread.locked ? '🔒 잠김' : '🔓 풀림'}`);
      }

      if (changes.length === 0) return;

      const embed = new EmbedBuilder()
        .setTitle('📝 스레드 설정 업데이트됨')
        .setDescription(`스레드 설정이 변경되었습니다.\n\n• **스레드**: ${newThread.toString()}\n• **상위 채널**: <#${newThread.parentId}>\n\n**[변경 내역]**\n${changes.join('\n')}`)
        .setColor(INFO_COLOR || MAIN_COLOR)
        .setTimestamp();

      await logChannel.send({ embeds: [embed] }).catch(() => {});
    },

    // Message Create: Cache all text messages (including bots to track all chats)
    async messageCreate(client, message) {
      if (!message.guild || !agreedGuilds.has(message.guild.id.toString())) return;
      console.log(`[Debug messageCreate] 📥 Received message from "${message.author?.tag || 'Unknown author'}" (ID: ${message.author?.id}) in channel #${message.channel.name} of guild "${message.guild.name}": "${message.content || '(내용 없음)'}"`);
      saveMessageToDb(message);
    },

    // Message Update (Edit & Caching Log)
    async messageUpdate(client, before, after) {
      // 1. Fast preliminary check: If after is partial, attempt to resolve it
      let author = after.author;
      if (!author && after.partial) {
        try {
          after = await after.fetch();
          author = after.author;
        } catch (e) {
          const dbResult = await getMessageFromDb(after.id);
          if (dbResult) {
            author = await client.users.fetch(dbResult.author_id).catch(() => null);
          }
        }
      }

      if (!author || author.bot || !after.guild || !agreedGuilds.has(after.guild.id.toString())) return;
      if (isChannelExcluded(after.guild.id, after.channel?.id)) return;

      let beforeContent = before.content || "";
      const afterContent = after.content || "";

      // 2. Query the SQLite database if before state is partial/missing content
      if ((before.partial || !beforeContent) && after.id) {
        const dbResult = await getMessageFromDb(after.id);
        if (dbResult) {
          beforeContent = dbResult.content || "";
        }
      }

      // 3. Fast filter: link embed crawling triggers updates where content is identical. 
      // Since regular users cannot manually edit rich embeds, we skip non-content edits.
      const contentChanged = beforeContent !== afterContent;
      if (!contentChanged) return;

      const logChannel = await getLogChannel(client, after.guild.id, 'log_chat');
      if (!logChannel) return;

      const embed = new EmbedBuilder()
        .setTitle(`${after.guild.name} 메세지 수정 로그`)
        .setDescription(`${after.channel.toString()}에서 **${author.toString()}**의 메세지가 수정되었습니다.\n👉 **[메시지 바로가기](${after.url})**`)
        .setColor(SUCCESS_COLOR)
        .addFields(
          { name: "메시지 작성 및 수정자", value: `${author.toString()} (ID: ${author.id})`, inline: false }
        );

      embed.addFields(
        { name: "수정 전 내용", value: beforeContent ? beforeContent.substring(0, 1024) : "(내용 없음)", inline: false },
        { name: "수정 후 내용", value: afterContent ? afterContent.substring(0, 1024) : "(내용 없음)", inline: false }
      );

      const timestamp = formatKST(new Date());
      embed.setFooter({ text: `유저 ID: ${author.id} • 메세지 ID: ${after.id} • ${timestamp}` });

      await logChannel.send({ embeds: [embed] }).catch(console.error);

      // 4. Update the message inside our local database cache so deletions and successive edits reflect it
      saveMessageToDb(after);
    },

    // Message Delete Log
    async messageDelete(client, message) {
      if (!message.guild || !agreedGuilds.has(message.guild.id.toString())) return;
      if (isChannelExcluded(message.guild.id, message.channel?.id)) return;
      if (activePurges.has(message.channel.id)) return;
      console.log(`[Debug messageDelete] 🗑️ Message "${message.id}" was deleted in channel #${message.channel.name} of guild "${message.guild.name}". Checking cache & database...`);

      const dbResult = await getMessageFromDb(message.id);
      if (dbResult) {
        console.log(`[Debug messageDelete] ✅ Message found in database: "${dbResult.content}" (Author ID: ${dbResult.author_id})`);
      } else {
        console.log(`[Debug messageDelete] ⚠️ Message NOT found in database (was not cached or sync completed while offline).`);
      }
      
      // Permanently remove the message from the database after fetching it
      deleteMessageFromDb(message.id);

      const logChannel = await getLogChannel(client, message.guild.id, 'log_chat');
      if (!logChannel) {
        console.log(`[Debug messageDelete] ❌ SKIPPED LOGGING: No 'log_chat' (채팅 로그) channel has been configured for guild "${message.guild.name}" (${message.guild.id}). Please run "/로그" in the log channel!`);
        return;
      }

      // Loop protection guard: Never log deletions of the BOT's OWN messages inside the logging channel!
      const deletedAuthorId = message.author ? message.author.id : (dbResult ? dbResult.author_id : null);
      if (message.channel.id === logChannel.id && deletedAuthorId === client.user.id) {
        console.log(`[Debug messageDelete] 🚫 Ignored: Deletion of the bot's own message occurred inside the logging channel itself.`);
        return;
      }

      let content = "(내용 없음)";
      let authorId = "알 수 없음";
      let authorMention = "알 수 없는 유저";

      if (message.author) {
        content = message.content || "";
        
        // Append attachment details if message was in cache
        if (message.attachments && message.attachments.size > 0) {
          const attachmentUrls = message.attachments.map(a => `[첨부파일: ${a.name}](${a.url})`).join("\n");
          if (content && content !== "") {
            content += "\n" + attachmentUrls;
          } else {
            content = attachmentUrls;
          }
        }

        // Append embed details if message was in cache (supports bot embeds logging!)
        if (message.embeds && message.embeds.length > 0) {
          const embedsText = formatEmbeds(message.embeds);
          if (content && content !== "") {
            content += "\n\n" + embedsText;
          } else {
            content = embedsText;
          }
        }

        if (!content || content === "") {
          content = "(내용 없음)";
        }
        
        authorId = message.author.id;
        authorMention = message.author.toString();
      } else {
        dbResult = await getMessageFromDb(message.id);
        if (dbResult) {
          content = dbResult.content || "(내용 없음)";
          authorId = dbResult.author_id;
          authorMention = `<@${authorId}>`;
        } else {
          // Not in DB and not in cache, skip to avoid incomplete log
          return;
        }
      }

      // Fetch audit logs to find who deleted it
      let deleter = "알 수 없음";
      try {
        // Fetch official Discord server time to bypass any local machine clock skew!
        const res = await fetch("https://discord.com/api/v10/gateway").catch(() => null);
        let currentTime = Date.now();
        if (res && res.headers.get("date")) {
          currentTime = new Date(res.headers.get("date")).getTime();
          console.log(`[Debug AuditLog Search] ⏰ Synced with Discord server time. Clock skew detected: ${Date.now() - currentTime}ms`);
        }

        let auditLogs = null;
        let finalDeleteLog = null;

        // Try up to 2 times with a 1.2-second interval to handle API replication lag
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (attempt > 1) {
            console.log(`[Debug AuditLog Search - Attempt ${attempt}] Retrying in 1.2 seconds due to replication lag...`);
            await new Promise(resolve => setTimeout(resolve, 1200));
          } else {
            // First attempt wait 800ms
            await new Promise(resolve => setTimeout(resolve, 800));
          }

          auditLogs = await message.guild.fetchAuditLogs({
            limit: 5,
            type: AuditLogEvent.MessageDelete
          });

          console.log(`[Debug AuditLog Search - Attempt ${attempt}] Found ${auditLogs.entries.size} entries:`);
          auditLogs.entries.forEach(entry => {
            console.log(`  - Entry ID: ${entry.id}, Executor: ${entry.executor?.tag || 'Unknown'} (ID: ${entry.executor?.id}), Target ID: ${entry.targetId || 'None'}, Time Diff: ${currentTime - entry.createdTimestamp}ms`);
          });

          finalDeleteLog = auditLogs.entries.find(entry => {
            // A. Channel match
            let matchesChannel = false;
            if (entry.extra && entry.extra.channel) {
              const channelId = typeof entry.extra.channel === 'string'
                ? entry.extra.channel
                : (entry.extra.channel.id || entry.extra.channelId || null);
              if (channelId) {
                matchesChannel = channelId === message.channel.id;
              }
            }
            if (!matchesChannel) return false;

            // B. Time match (within 20 seconds of true Discord server time)
            const matchesTime = Math.abs(currentTime - entry.createdTimestamp) < 20000;
            if (!matchesTime) return false;

            // C. Target match (or bot/webhook bypass)
            const isBotOrWebhook = (message.author && message.author.bot) || (dbResult && (dbResult.author_id === authorId || authorId === "0" || authorId === "알 수 없음"));
            const matchesTarget = !entry.targetId || entry.targetId === authorId || isBotOrWebhook;

            return matchesTarget;
          });

          if (finalDeleteLog) break;
        }

        if (finalDeleteLog) {
          deleter = finalDeleteLog.executor.toString();
          console.log(`[Debug AuditLog Search] ✅ MATCH SUCCESS: Executor is "${finalDeleteLog.executor.tag}"`);
        } else {
          // If no moderator deletion logged, it was deleted by the author themselves!
          deleter = authorMention;
          console.log(`[Debug AuditLog Search] ℹ️ NO MATCH: Defaulting to author "${authorMention}" (Self-deletion)`);
        }
      } catch (e) {
        deleter = `${authorMention} (또는 관리자 - '감사 로그 보기' 권한 필요)`;
        console.error(`[Debug AuditLog Search] ❌ Error fetching audit logs:`, e);
      }

      // Parse deleted image attachment if present to display visually in log
      let deletedImage = null;
      if (message.attachments && message.attachments.size > 0) {
        const img = message.attachments.find(a => 
          a.url && /\.(png|jpg|jpeg|gif|webp)(\?.*)?$/i.test(a.url)
        );
        if (img) deletedImage = img.url;
      } else if (content) {
        // Regex to parse image attachment link from serialized markdown text
        const match = content.match(/\[첨부파일: [^\]]+\.(?:png|jpg|jpeg|gif|webp)\]\((https:\/\/cdn\.discordapp\.com\/attachments\/[^\)]+)\)/i);
        if (match && match[1]) {
          deletedImage = match[1];
        }
      }

      const embed = new EmbedBuilder()
        .setTitle(`${message.guild.name} 메세지 삭제 로그`)
        .setDescription(`${message.channel.toString()}에서 **${authorMention}**의 메세지가 삭제되었습니다.`)
        .setColor(ERROR_COLOR)
        .addFields(
          { name: "메시지 작성자", value: `${authorMention} (ID: ${authorId})`, inline: true },
          { name: "삭제한 유저 (삭제자)", value: deleter, inline: true },
          { name: "삭제된 메세지 내용", value: content ? content.substring(0, 1024) : "(내용 없음)", inline: false }
        );

      if (deletedImage) {
        embed.setImage(deletedImage);
      }

      const timestamp = formatKST(new Date());
      embed.setFooter({ text: `유저 ID: ${authorId} • 메세지 ID: ${message.id} • ${timestamp}` });

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Message Bulk Delete Log
    async messageDeleteBulk(client, messages, channel) {
      if (messages.size === 0) return;

      const guild = channel?.guild || messages.first()?.guild;
      if (!guild) return;

      // If this is an active purge, the `/청소` command manually calls `logPurge`
      // with ALL deleted messages (including old ones). We return early here to prevent duplicates.
      if (activePurges.has(channel.id)) {
        for (const [id, message] of messages) {
          deleteMessageFromDb(id);
        }
        return;
      }

      await logPurgeInternal(client, messages, channel);
    },

    // Voice State Update Log
    async voiceStateUpdate(client, before, after) {
      const member = after.member;
      if (!member || member.user.bot || !member.guild || !agreedGuilds.has(member.guild.id.toString())) return;

      const logChannel = await getLogChannel(client, member.guild.id, 'log_voice');
      if (!logChannel) return;

      let action = "";
      let color = MAIN_COLOR;
      let suffix = "";

      if (!before.channelId && after.channelId) {
        action = "음성방에 입장했습니다.";
        color = SUCCESS_COLOR;
        suffix = "입장";
      } else if (before.channelId && !after.channelId) {
        action = "음성방에서 퇴장했습니다.";
        color = ERROR_COLOR;
        suffix = "퇴장";
      } else if (before.channelId && after.channelId && before.channelId !== after.channelId) {
        action = "음성방에서 이동했습니다.";
        color = INFO_COLOR;
        suffix = "이동";
      } else {
        return; // Ignore other states like mute/deafen
      }

      const embed = new EmbedBuilder()
        .setTitle(`${member.guild.name} 서버 음성방 ${suffix} 로그`)
        .setDescription(`${member.toString()}님이 ${action}`)
        .setColor(color);

      if (before.channelId) {
        embed.addFields({ name: "이전 음성 채널", value: `<#${before.channelId}> (ID: \`${before.channelId}\`)`, inline: false });
      }
      if (after.channelId) {
        embed.addFields({ name: "현재 음성 채널", value: `<#${after.channelId}> (ID: \`${after.channelId}\`)`, inline: false });
      }

      const timestamp = formatKST(new Date());
      embed.setFooter({ text: `유저 ID: ${member.id} • ${timestamp}` });

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Guild Member Join Log
    async guildMemberAdd(client, member) {
      if (!member.guild || !agreedGuilds.has(member.guild.id.toString())) return;
      const logChannel = await getLogChannel(client, member.guild.id, 'log_enter_exit');
      if (!logChannel) return;

      let inviteInfoText = "";
      if (member.user.bot) {
        try {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const auditLogs = await member.guild.fetchAuditLogs({
            limit: 5,
            type: AuditLogEvent.BotAdd
          });
          const entry = auditLogs.entries.find(e => e.targetId === member.id);
          if (entry) {
            inviteInfoText = `\n• **초대자**: ${entry.executor.toString()} (${entry.executor.tag})`;
          } else {
            inviteInfoText = `\n• **초대자**: 알 수 없음`;
          }
        } catch (err) {
          console.error("Failed to fetch bot invite audit log:", err);
          inviteInfoText = `\n• **초대자**: 알 수 없음 (감사 로그 권한 필요)`;
        }
      }

      const embed = new EmbedBuilder()
        .setTitle(`${member.guild.name} 서버 입장 로그`)
        .setDescription(`${member.toString()}이(가) ${member.guild.name}에 입장했습니다.${inviteInfoText}`)
        .setColor(SUCCESS_COLOR)
        .addFields(
          { name: "유저 ID", value: `${member.user.username}(${member.id})`, inline: true },
          { name: "계정 생성 날짜", value: formatKST(member.user.createdAt), inline: true }
        );

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Guild Member Remove Log
    async guildMemberRemove(client, member) {
      if (!member.guild || !agreedGuilds.has(member.guild.id.toString())) return;
      const logChannel = await getLogChannel(client, member.guild.id, 'log_enter_exit');
      if (!logChannel) return;

      const timestamp = formatKST(new Date());
      const embed = new EmbedBuilder()
        .setTitle(`${member.guild.name} 서버 퇴장 로그`)
        .setDescription(`${member.toString()}이(가) ${member.guild.name}에서 퇴장했습니다.`)
        .setColor(ERROR_COLOR)
        .addFields(
          { name: "유저 ID", value: `${member.user.username}(${member.id})`, inline: true },
          { name: "퇴장 시각", value: timestamp, inline: true }
        );

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Guild Member Ban Log
    async guildBanAdd(client, ban) {
      if (!ban.guild || !agreedGuilds.has(ban.guild.id.toString())) return;
      const logChannel = await getLogChannel(client, ban.guild.id, 'log_ban');
      if (!logChannel) return;

      let reason = "사유 없음";
      let executor = "알 수 없음";

      const cacheKey = `${ban.guild.id}-${ban.user.id}`;
      const cached = client.banCache?.get(cacheKey);

      if (cached) {
        reason = cached.reason || "사유 없음";
        executor = cached.executor || "알 수 없음";
        client.banCache.delete(cacheKey);
      } else {
        try {
          // Wait briefly to allow the audit log entry to be fully processed/replicated
          await new Promise(resolve => setTimeout(resolve, 1000));
          const auditLogs = await ban.guild.fetchAuditLogs({
            limit: 5,
            type: AuditLogEvent.MemberBanAdd
          });
          const entry = auditLogs.entries.find(e => e.targetId === ban.user.id);
          if (entry) {
            executor = `${entry.executor.toString()} (${entry.executor.tag})`;
            reason = entry.reason || "사유 없음";
          } else {
            // Fallback: Fetch the ban directly via REST API if audit log fetch didn't return a matching entry
            const fetchedBan = await ban.fetch().catch(() => null);
            if (fetchedBan) {
              reason = fetchedBan.reason || "사유 없음";
            }
          }
        } catch (err) {
          console.error("Failed to fetch audit log or ban details for ban log:", err);
          // Fallback to ban's cached reason if all else fails
          reason = ban.reason || "사유 없음";
        }
      }


      const user = ban.user;
      const embed = new EmbedBuilder()
        .setTitle(`${ban.guild.name} 멤버 차단 로그`)
        .setColor(ERROR_COLOR)
        .addFields(
          { name: "유저", value: `${user.toString()}(${user.id})`, inline: true },
          { name: "처리자", value: executor, inline: true },
          { name: "차단 사유", value: reason, inline: false }
        );

      const timestamp = formatKST(new Date());
      embed.setFooter({ text: `차단 시각: ${timestamp}` });

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Guild Member Unban Log
    async guildBanRemove(client, ban) {
      if (!ban.guild || !agreedGuilds.has(ban.guild.id.toString())) return;
      const logChannel = await getLogChannel(client, ban.guild.id, 'log_ban');
      if (!logChannel) return;

      let reason = "사유 없음";
      let executor = "알 수 없음";

      const cacheKey = `${ban.guild.id}-${ban.user.id}`;
      const cached = client.unbanCache?.get(cacheKey);

      if (cached) {
        reason = cached.reason || "사유 없음";
        executor = cached.executor || "알 수 없음";
        client.unbanCache.delete(cacheKey);
      } else {
        try {
          // Wait briefly to allow the audit log entry to be fully processed/replicated
          await new Promise(resolve => setTimeout(resolve, 1000));
          const auditLogs = await ban.guild.fetchAuditLogs({
            limit: 5,
            type: AuditLogEvent.MemberBanRemove
          });
          const entry = auditLogs.entries.find(e => e.targetId === ban.user.id);
          if (entry) {
            executor = `${entry.executor.toString()} (${entry.executor.tag})`;
            reason = entry.reason || "사유 없음";
          }
        } catch (err) {
          console.error("Failed to fetch audit log for unban log:", err);
        }
      }


      const user = ban.user;
      const embed = new EmbedBuilder()
        .setTitle(`${ban.guild.name} 멤버 차단 해제 로그`)
        .setColor(SUCCESS_COLOR)
        .addFields(
          { name: "유저", value: `${user.toString()}(${user.id})`, inline: true },
          { name: "처리자", value: executor, inline: true },
          { name: "해제 사유", value: reason, inline: false }
        );

      const timestamp = formatKST(new Date());
      embed.setFooter({ text: `차단 해제 시각: ${timestamp}` });

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Channel Settings Update Log
    async channelUpdate(client, oldChannel, newChannel) {
      if (!newChannel.guild || !agreedGuilds.has(newChannel.guild.id.toString())) return;
      if (isChannelExcluded(newChannel.guild.id, newChannel.id)) return;

      const logChannel = await getLogChannel(client, newChannel.guild.id, 'log_update');
      if (!logChannel) return;

      let executor = "알 수 없음";
      let reason = "사유 없음";
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const auditLogs = await newChannel.guild.fetchAuditLogs({
          limit: 5,
          type: AuditLogEvent.ChannelUpdate
        });
        const entry = auditLogs.entries.find(e => 
          e.targetId === newChannel.id && 
          Math.abs(Date.now() - e.createdTimestamp) < 15000
        );
        if (entry) {
          executor = `${entry.executor.tag} (${entry.executor.id})`;
          reason = entry.reason || "사유 없음";
        }
      } catch (err) {
        console.error("Failed to fetch audit logs for channel update:", err);
      }

      const embed = new EmbedBuilder()
        .setTitle('🔄 채널 설정 업데이트')
        .setColor(INFO_COLOR || MAIN_COLOR)
        .setTimestamp();

      const changes = [];
      if (oldChannel.name !== newChannel.name) {
        changes.push(`• **채널 이름**: \`#${oldChannel.name}\` ➡️ \`#${newChannel.name}\``);
      }
      if (oldChannel.topic !== newChannel.topic) {
        changes.push(`• **채널 설명(주제)**:\n  - 변경 전: \`${oldChannel.topic || "없음"}\`\n  - 변경 후: \`${newChannel.topic || "없음"}\``);
      }
      if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        changes.push(`• **슬로우 모드**: \`${oldChannel.rateLimitPerUser}초\` ➡️ \`${newChannel.rateLimitPerUser}초\``);
      }
      if (oldChannel.nsfw !== newChannel.nsfw) {
        changes.push(`• **NSFW 설정**: \`${oldChannel.nsfw ? "ON" : "OFF"}\` ➡️ \`${newChannel.nsfw ? "ON" : "OFF"}\``);
      }
      if (oldChannel.parentId !== newChannel.parentId) {
        const oldParent = oldChannel.parent ? `#${oldChannel.parent.name}` : "없음";
        const newParent = newChannel.parent ? `#${newChannel.parent.name}` : "없음";
        changes.push(`• **상위 카테고리**: \`${oldParent}\` ➡️ \`${newParent}\``);
      }

      if (changes.length === 0) return;

      embed.setDescription(`**채널 ${newChannel.toString()}의 설정이 변경되었습니다.**\n\n• **수정자 (수행자)**: ${executor}\n• **수정 사유**: ${reason}\n\n**[변경 내역]**\n${changes.join('\n')}`);
      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Guild Member Update: Timeout Logs & Role/Nickname Updates
    async guildMemberUpdate(client, before, after) {
      if (!after.guild || !agreedGuilds.has(after.guild.id.toString())) return;

      const timestamp = formatKST(new Date());

      // 1. Timeout Changes (logged to log_timeout)
      const oldTimeout = before.communicationDisabledUntil;
      const newTimeout = after.communicationDisabledUntil;

      const oldTime = oldTimeout ? oldTimeout.getTime() : null;
      const newTime = newTimeout ? newTimeout.getTime() : null;

      if (oldTime !== newTime) {
        let logChannel = await getLogChannel(client, after.guild.id, 'log_timeout');
        if (!logChannel) {
          // Fallback to general update log channel if dedicated timeout log is not configured yet
          logChannel = await getLogChannel(client, after.guild.id, 'log_update');
        }
        if (logChannel) {
          let executor = "알 수 없음";
          let reason = "사유 없음";

          const cacheKey = `${after.guild.id}-${after.id}`;
          const cached = client.timeoutCache?.get(cacheKey);

          if (cached) {
            reason = cached.reason || "사유 없음";
            executor = cached.executor || "알 수 없음";
            client.timeoutCache.delete(cacheKey);
          } else {
            try {
              await new Promise(resolve => setTimeout(resolve, 1000));
              const auditLogs = await after.guild.fetchAuditLogs({
                limit: 5,
                type: AuditLogEvent.MemberUpdate
              });
              const entry = auditLogs.entries.find(e => 
                e.targetId === after.id && 
                e.changes.some(c => c.key === 'communication_disabled_until') &&
                Math.abs(Date.now() - e.createdTimestamp) < 15000
              );
              if (entry) {
                executor = `${entry.executor.tag} (${entry.executor.id})`;
                reason = entry.reason || "사유 없음";
              }
            } catch (err) {
              console.error("Failed to fetch audit logs for timeout update:", err);
            }
          }

          if (newTimeout && (!oldTimeout || newTimeout.getTime() > oldTimeout.getTime())) {
            const durationMs = newTimeout.getTime() - Date.now();
            const durationMins = Math.round(durationMs / 60000);
            
            const embed = new EmbedBuilder()
              .setTitle(`🚫 멤버 타임아웃(활동 제한) 로그`)
              .setDescription(`${after.toString()}님이 서버에서 **활동 제한(타임아웃)** 처리되었습니다.`)
              .setColor(ERROR_COLOR)
              .addFields(
                { name: "대상 멤버", value: `${after.user.tag} (${after.id})`, inline: true },
                { name: "처리자", value: executor, inline: true },
                { name: "제한 기간", value: `약 ${durationMins}분 (만료: ${formatKST(newTimeout)})`, inline: true },
                { name: "사유", value: reason, inline: false }
              )
              .setFooter({ text: `일시: ${timestamp}` });

            await logChannel.send({ embeds: [embed] }).catch(console.error);
          } else if (!newTimeout && oldTimeout) {
            const embed = new EmbedBuilder()
              .setTitle(`✅ 멤버 타임아웃 해제 로그`)
              .setDescription(`${after.toString()}님의 **활동 제한(타임아웃)**이 해제되었습니다.`)
              .setColor(SUCCESS_COLOR)
              .addFields(
                { name: "대상 멤버", value: `${after.user.tag} (${after.id})`, inline: true },
                { name: "해제자", value: executor, inline: true },
                { name: "사유", value: reason, inline: false }
              )
              .setFooter({ text: `일시: ${timestamp}` });

            await logChannel.send({ embeds: [embed] }).catch(console.error);
          }
        }
      }

      // 2. Nickname Changes (logged to log_nickname with fallback to log_update)
      if (before.nickname !== after.nickname) {
        let logChannel = await getLogChannel(client, after.guild.id, 'log_nickname');
        if (!logChannel) {
          logChannel = await getLogChannel(client, after.guild.id, 'log_update');
        }
        if (logChannel) {
          let executor = "본인 또는 알 수 없음";
          let oldNick = before.nickname;
          let newNick = after.nickname;

          try {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const auditLogs = await after.guild.fetchAuditLogs({
              limit: 5,
              type: AuditLogEvent.MemberUpdate
            });
            const entry = auditLogs.entries.find(e => 
              e.targetId === after.id && 
              e.changes.some(c => c.key === 'nick') &&
              Math.abs(Date.now() - e.createdTimestamp) < 15000
            );
            if (entry) {
              executor = `${entry.executor.tag} (${entry.executor.id})`;
              const nickChange = entry.changes.find(c => c.key === 'nick');
              if (nickChange) {
                oldNick = nickChange.old;
                newNick = nickChange.new;
              }
            } else {
              executor = `${after.user.tag} (본인 직접 변경)`;
            }
          } catch (err) {
            console.error("Failed to fetch audit logs for nickname update:", err);
          }

          const embed = new EmbedBuilder()
            .setTitle('👤 멤버 닉네임 변경')
            .setDescription(`${after.toString()} 님의 서버 프로필 닉네임이 변경되었습니다.`)
            .setColor(INFO_COLOR || MAIN_COLOR)
            .addFields(
              { name: "변경 전", value: `\`${oldNick || before.user.username}\``, inline: true },
              { name: "변경 후", value: `\`${newNick || after.user.username}\``, inline: true },
              { name: "수행자 (변경자)", value: executor, inline: false }
            )
            .setFooter({ text: `일시: ${timestamp} • 유저 ID: ${after.id}` });

          await logChannel.send({ embeds: [embed] }).catch(console.error);
        }
      }

      // 3. Role Changes (logged to log_role)
      const oldRoles = before.roles.cache;
      const newRoles = after.roles.cache;
      
      const addedRoles = newRoles.filter(role => !oldRoles.has(role.id));
      const removedRoles = oldRoles.filter(role => !newRoles.has(role.id));

      if (addedRoles.size > 0 || removedRoles.size > 0) {
        const logChannel = await getLogChannel(client, after.guild.id, 'log_role');
        if (logChannel) {
          let executor = "알 수 없음";
          let reason = "사유 없음";

          try {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const auditLogs = await after.guild.fetchAuditLogs({
              limit: 5,
              type: AuditLogEvent.MemberRoleUpdate
            });
            const entry = auditLogs.entries.find(e => 
              e.targetId === after.id && 
              Math.abs(Date.now() - e.createdTimestamp) < 15000
            );
            if (entry) {
              executor = `${entry.executor.tag} (${entry.executor.id})`;
              reason = entry.reason || "사유 없음";
            }
          } catch (err) {
            console.error("Failed to fetch audit logs for member role update:", err);
          }

          const embed = new EmbedBuilder()
            .setTitle('🔄 멤버 역할 업데이트')
            .setColor(INFO_COLOR || MAIN_COLOR)
            .addFields(
              { name: "대상 멤버", value: `${after.toString()} (${after.id})`, inline: true },
              { name: "처리자", value: executor, inline: true },
              { name: "사유", value: reason, inline: false }
            )
            .setFooter({ text: `일시: ${timestamp} • 유저 ID: ${after.id}` });

          const changes = [];
          if (addedRoles.size > 0) {
            changes.push(`• **추가된 역할**: ${addedRoles.map(r => r.toString()).join(', ')}`);
          }
          if (removedRoles.size > 0) {
            changes.push(`• **제거된 역할**: ${removedRoles.map(r => r.toString()).join(', ')}`);
          }

          embed.setDescription(`${after.toString()} 님의 역할 변경 사항:\n\n${changes.join('\n')}`);
          await logChannel.send({ embeds: [embed] }).catch(console.error);
        }
      }
    },

    // Server Settings Update Log
    async guildUpdate(client, oldGuild, newGuild) {
      if (!newGuild || !agreedGuilds.has(newGuild.id.toString())) return;
      const logChannel = await getLogChannel(client, newGuild.id, 'log_update');
      if (!logChannel) return;

      const embed = new EmbedBuilder()
        .setTitle('🔄 서버 설정 업데이트')
        .setColor(INFO_COLOR || MAIN_COLOR)
        .setTimestamp();

      const changes = [];
      if (oldGuild.name !== newGuild.name) {
        changes.push(`• **이름**: \`${oldGuild.name}\` ➡️ \`${newGuild.name}\``);
      }
      if (oldGuild.icon !== newGuild.icon) {
        changes.push(`• **서버 아이콘**: 변경됨`);
      }
      if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
        changes.push(`• **보안 등급**: \`${oldGuild.verificationLevel}\` ➡️ \`${newGuild.verificationLevel}\``);
      }
      if (oldGuild.systemChannelId !== newGuild.systemChannelId) {
        changes.push(`• **시스템 메시지 채널**: <#${oldGuild.systemChannelId}> ➡️ <#${newGuild.systemChannelId}>`);
      }

      if (changes.length === 0) return;

      embed.setDescription(`**서버 설정이 변경되었습니다.**\n\n${changes.join('\n')}`);
      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Channel Creation Log
    async channelCreate(client, channel) {
      if (!channel.guild || !agreedGuilds.has(channel.guild.id.toString())) return;
      const logChannel = await getLogChannel(client, channel.guild.id, 'log_channel');
      if (!logChannel) return;

      let executor = "알 수 없음";
      let reason = "사유 없음";
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const auditLogs = await channel.guild.fetchAuditLogs({
          limit: 1,
          type: AuditLogEvent.ChannelCreate
        });
        const entry = auditLogs.entries.first();
        if (entry && entry.targetId === channel.id && Math.abs(Date.now() - entry.createdTimestamp) < 15000) {
          executor = `${entry.executor.tag} (${entry.executor.id})`;
          reason = entry.reason || "사유 없음";
        }
      } catch (err) {
        console.error("Failed to fetch audit logs for channel create:", err);
      }

      const embed = new EmbedBuilder()
        .setTitle('📁 채널 생성됨')
        .setDescription(
          `새로운 채널 **${channel.toString()}**이(가) 생성되었습니다.\n\n` +
          `• **채널 이름**: \`#${channel.name}\`\n` +
          `• **채널 ID**: \`${channel.id}\`\n` +
          `• **채널 유형**: \`${channel.type}\`\n` +
          `• **생성자**: ${executor}\n` +
          `• **사유**: ${reason}`
        )
        .setColor(0x10B981) // Green
        .setTimestamp();

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Channel Deletion Log
    async channelDelete(client, channel) {
      if (!channel.guild || !agreedGuilds.has(channel.guild.id.toString())) return;
      const logChannel = await getLogChannel(client, channel.guild.id, 'log_channel');
      if (!logChannel) return;

      let executor = "알 수 없음";
      let reason = "사유 없음";
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const auditLogs = await channel.guild.fetchAuditLogs({
          limit: 1,
          type: AuditLogEvent.ChannelDelete
        });
        const entry = auditLogs.entries.first();
        if (entry && entry.targetId === channel.id && Math.abs(Date.now() - entry.createdTimestamp) < 15000) {
          executor = `${entry.executor.tag} (${entry.executor.id})`;
          reason = entry.reason || "사유 없음";
        }
      } catch (err) {
        console.error("Failed to fetch audit logs for channel delete:", err);
      }

      const embed = new EmbedBuilder()
        .setTitle('📁 채널 삭제됨')
        .setDescription(
          `채널 **#${channel.name}**이(가) 삭제되었습니다.\n\n` +
          `• **채널 이름**: \`#${channel.name}\`\n` +
          `• **채널 ID**: \`${channel.id}\`\n` +
          `• **삭제자**: ${executor}\n` +
          `• **사유**: ${reason}`
        )
        .setColor(0xEF4444) // Red
        .setTimestamp();

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Channel Settings Update Log
    async channelUpdate(client, oldChannel, newChannel) {
      if (!newChannel.guild || !agreedGuilds.has(newChannel.guild.id.toString())) return;
      if (isChannelExcluded(newChannel.guild.id, newChannel.id)) return;

      const logChannel = await getLogChannel(client, newChannel.guild.id, 'log_channel');
      if (!logChannel) return;

      const embed = new EmbedBuilder()
        .setTitle('🔄 채널 설정 업데이트')
        .setColor(INFO_COLOR || MAIN_COLOR)
        .setTimestamp();

      const changes = [];
      if (oldChannel.name !== newChannel.name) {
        changes.push(`• **채널 이름**: \`#${oldChannel.name}\` ➡️ \`#${newChannel.name}\``);
      }
      if (oldChannel.topic !== newChannel.topic) {
        changes.push(`• **채널 설명(주제)**:\n  - 변경 전: \`${oldChannel.topic || "없음"}\`\n  - 변경 후: \`${newChannel.topic || "없음"}\``);
      }
      if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        changes.push(`• **슬로우 모드**: \`${oldChannel.rateLimitPerUser}초\` ➡️ \`${newChannel.rateLimitPerUser}초\``);
      }
      if (oldChannel.nsfw !== newChannel.nsfw) {
        changes.push(`• **NSFW 설정**: \`${oldChannel.nsfw ? "ON" : "OFF"}\` ➡️ \`${newChannel.nsfw ? "ON" : "OFF"}\``);
      }
      if (oldChannel.parentId !== newChannel.parentId) {
        const oldParent = oldChannel.parent ? `#${oldChannel.parent.name}` : "없음";
        const newParent = newChannel.parent ? `#${newChannel.parent.name}` : "없음";
        changes.push(`• **상위 카테고리**: \`${oldParent}\` ➡️ \`${newParent}\``);
      }

      if (changes.length === 0) return;

      embed.setDescription(`**채널 ${newChannel.toString()}의 설정이 변경되었습니다.**\n\n${changes.join('\n')}`);
      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Role Settings Update Log
    async roleUpdate(client, oldRole, newRole) {
      if (!newRole.guild || !agreedGuilds.has(newRole.guild.id.toString())) return;
      const logChannel = await getLogChannel(client, newRole.guild.id, 'log_role');
      if (!logChannel) return;

      let executor = "알 수 없음";
      let reason = "사유 없음";
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const auditLogs = await newRole.guild.fetchAuditLogs({
          limit: 5,
          type: AuditLogEvent.RoleUpdate
        });
        const entry = auditLogs.entries.find(e => 
          e.targetId === newRole.id && 
          Math.abs(Date.now() - e.createdTimestamp) < 15000
        );
        if (entry) {
          executor = `${entry.executor.tag} (${entry.executor.id})`;
          reason = entry.reason || "사유 없음";
        }
      } catch (err) {
        console.error("Failed to fetch audit logs for role update:", err);
      }

      const embed = new EmbedBuilder()
        .setTitle('🔄 역할 설정 업데이트')
        .setColor(newRole.color || INFO_COLOR || MAIN_COLOR)
        .setTimestamp();

      const changes = [];
      if (oldRole.name !== newRole.name) {
        changes.push(`• **역할 이름**: \`${oldRole.name}\` ➡️ \`${newRole.name}\``);
      }
      if (oldRole.color !== newRole.color) {
        changes.push(`• **역할 색상**: \`#${oldRole.color.toString(16)}\` ➡️ \`#${newRole.color.toString(16)}\``);
      }
      if (oldRole.hoist !== newRole.hoist) {
        changes.push(`• **온라인 멤버와 분리 표시**: \`${oldRole.hoist ? "ON" : "OFF"}\` ➡️ \`${oldRole.hoist ? "ON" : "OFF"}\``);
      }
      if (oldRole.mentionable !== newRole.mentionable) {
        changes.push(`• **멘션 허용 여부**: \`${oldRole.mentionable ? "ON" : "OFF"}\` ➡️ \`${oldRole.mentionable ? "ON" : "OFF"}\``);
      }
      if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
        changes.push(`• **권한 설정 변경됨**`);
      }

      if (changes.length === 0) return;

      embed.setDescription(`**역할 ${newRole.toString()}의 설정이 변경되었습니다.**\n\n• **처리자**: ${executor}\n• **사유**: ${reason}\n\n**[변경 내역]**\n${changes.join('\n')}`);
      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Role Creation Log
    async roleCreate(client, role) {
      if (!role.guild || !agreedGuilds.has(role.guild.id.toString())) return;
      const logChannel = await getLogChannel(client, role.guild.id, 'log_role');
      if (!logChannel) return;

      let executor = "알 수 없음";
      let reason = "사유 없음";
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const auditLogs = await role.guild.fetchAuditLogs({
          limit: 1,
          type: AuditLogEvent.RoleCreate
        });
        const entry = auditLogs.entries.first();
        if (entry && entry.targetId === role.id && Math.abs(Date.now() - entry.createdTimestamp) < 15000) {
          executor = `${entry.executor.tag} (${entry.executor.id})`;
          reason = entry.reason || "사유 없음";
        }
      } catch (err) {
        console.error("Failed to fetch audit logs for role create:", err);
      }

      const embed = new EmbedBuilder()
        .setTitle('➕ 역할 생성됨')
        .setDescription(
          `새로운 역할 **${role.toString()}**이(가) 생성되었습니다.\n\n` +
          `• **역할 이름**: \`${role.name}\`\n` +
          `• **역할 ID**: \`${role.id}\`\n` +
          `• **생성자**: ${executor}\n` +
          `• **사유**: ${reason}`
        )
        .setColor(0x10B981) // Green
        .setTimestamp();

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Role Deletion Log
    async roleDelete(client, role) {
      if (!role.guild || !agreedGuilds.has(role.guild.id.toString())) return;
      const logChannel = await getLogChannel(client, role.guild.id, 'log_role');
      if (!logChannel) return;

      let executor = "알 수 없음";
      let reason = "사유 없음";
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const auditLogs = await role.guild.fetchAuditLogs({
          limit: 1,
          type: AuditLogEvent.RoleDelete
        });
        const entry = auditLogs.entries.first();
        if (entry && entry.targetId === role.id && Math.abs(Date.now() - entry.createdTimestamp) < 15000) {
          executor = `${entry.executor.tag} (${entry.executor.id})`;
          reason = entry.reason || "사유 없음";
        }
      } catch (err) {
        console.error("Failed to fetch audit logs for role delete:", err);
      }

      const embed = new EmbedBuilder()
        .setTitle('➖ 역할 삭제됨')
        .setDescription(
          `역할 **${role.name}**이(가) 삭제되었습니다.\n\n` +
          `• **역할 이름**: \`${role.name}\`\n` +
          `• **역할 ID**: \`${role.id}\`\n` +
          `• **삭제자**: ${executor}\n` +
          `• **사유**: ${reason}`
        )
        .setColor(0xEF4444) // Red
        .setTimestamp();

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Message Reaction Add Log
    async messageReactionAdd(client, reaction, user) {
      if (user.bot) return;

      // Handle partials
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch (error) {
          console.error('[messageReactionAdd] Failed to fetch partial reaction:', error);
          return;
        }
      }

      const message = reaction.message;
      if (!message.guild || !agreedGuilds.has(message.guild.id.toString())) return;
      if (isChannelExcluded(message.guild.id, message.channel.id)) return;

      const logChannel = await getLogChannel(client, message.guild.id, 'log_reaction');
      if (!logChannel) return;

      let contentPreview = message.content || "";
      let authorMention = message.author ? `${message.author.toString()} (${message.author.tag})` : '알 수 없음';
      let authorId = message.author ? message.author.id : '알 수 없음';

      // DB 소급 조회로 유실된 메시지 정보 복구
      if (!contentPreview || authorMention === '알 수 없음') {
        const dbMsg = await getMessageFromDb(message.id);
        if (dbMsg) {
          if (!contentPreview) contentPreview = dbMsg.content || "";
          if (authorMention === '알 수 없음' && dbMsg.author_id) {
            authorId = dbMsg.author_id;
            const fetchedUser = await client.users.fetch(dbMsg.author_id).catch(() => null);
            if (fetchedUser) {
              authorMention = `${fetchedUser.toString()} (${fetchedUser.tag})`;
            } else {
              authorMention = `<@${dbMsg.author_id}> (ID: ${dbMsg.author_id})`;
            }
          }
        }
      }

      const emoji = reaction.emoji;
      const emojiDisplay = emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name;

      let emojiUrl = null;
      if (emoji.id) {
        const ext = emoji.animated ? 'gif' : 'png';
        emojiUrl = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
      } else {
        const hex = Array.from(emoji.name)
          .map(char => char.codePointAt(0).toString(16))
          .join('-');
        emojiUrl = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${hex}.png`;
      }

      if (contentPreview.length > 500) {
        contentPreview = contentPreview.substring(0, 500) + "...";
      }
      if (!contentPreview && message.embeds.length > 0) {
        contentPreview = "*[임베드 메시지]*";
      } else if (!contentPreview && message.attachments.size > 0) {
        contentPreview = "*[첨부파일 메시지]*";
      } else if (!contentPreview) {
        contentPreview = "*[내용 없음]*";
      }

      const embed = new EmbedBuilder()
        .setTitle('🎭 반응 추가됨')
        .setDescription(
          `**${user.toString()} (${user.tag})** 님이 메시지에 반응을 추가했습니다.\n\n` +
          `• **추가된 반응**: ${emojiDisplay} (이름: \`${emoji.name}\`${emoji.id ? `, ID: \`${emoji.id}\`` : ''})\n` +
          (emojiUrl ? `• **이모지 이미지 (CDN)**: [바로가기](${emojiUrl})\n` : '') +
          `• **대상 메시지 작성자**: ${authorMention}\n` +
          `• **대상 채널**: ${message.channel.toString()}\n` +
          `• **메시지 내용 바로가기**: [클릭하여 이동](${message.url})\n\n` +
          `**메시지 내용 미리보기:**\n\`\`\`\n${contentPreview}\n\`\`\``
        )
        .setThumbnail(emojiUrl)
        .setColor(0x10B981) // Green
        .setTimestamp();

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    },

    // Message Reaction Remove Log
    async messageReactionRemove(client, reaction, user) {
      if (user.bot) return;

      // Handle partials
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch (error) {
          console.error('[messageReactionRemove] Failed to fetch partial reaction:', error);
          return;
        }
      }

      const message = reaction.message;
      if (!message.guild || !agreedGuilds.has(message.guild.id.toString())) return;
      if (isChannelExcluded(message.guild.id, message.channel.id)) return;

      const logChannel = await getLogChannel(client, message.guild.id, 'log_reaction');
      if (!logChannel) return;

      let contentPreview = message.content || "";
      let authorMention = message.author ? `${message.author.toString()} (${message.author.tag})` : '알 수 없음';
      let authorId = message.author ? message.author.id : '알 수 없음';

      // DB 소급 조회로 유실된 메시지 정보 복구
      if (!contentPreview || authorMention === '알 수 없음') {
        const dbMsg = await getMessageFromDb(message.id);
        if (dbMsg) {
          if (!contentPreview) contentPreview = dbMsg.content || "";
          if (authorMention === '알 수 없음' && dbMsg.author_id) {
            authorId = dbMsg.author_id;
            const fetchedUser = await client.users.fetch(dbMsg.author_id).catch(() => null);
            if (fetchedUser) {
              authorMention = `${fetchedUser.toString()} (${fetchedUser.tag})`;
            } else {
              authorMention = `<@${dbMsg.author_id}> (ID: ${dbMsg.author_id})`;
            }
          }
        }
      }

      const emoji = reaction.emoji;
      const emojiDisplay = emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name;

      let emojiUrl = null;
      if (emoji.id) {
        const ext = emoji.animated ? 'gif' : 'png';
        emojiUrl = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
      } else {
        const hex = Array.from(emoji.name)
          .map(char => char.codePointAt(0).toString(16))
          .join('-');
        emojiUrl = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${hex}.png`;
      }

      if (contentPreview.length > 500) {
        contentPreview = contentPreview.substring(0, 500) + "...";
      }
      if (!contentPreview && message.embeds.length > 0) {
        contentPreview = "*[임베드 메시지]*";
      } else if (!contentPreview && message.attachments.size > 0) {
        contentPreview = "*[첨부파일 메시지]*";
      } else if (!contentPreview) {
        contentPreview = "*[내용 없음]*";
      }

      const embed = new EmbedBuilder()
        .setTitle('🎭 반응 제거됨')
        .setDescription(
          `**${user.toString()} (${user.tag})** 님이 메시지에서 반응을 제거했습니다.\n\n` +
          `• **제거된 반응**: ${emojiDisplay} (이름: \`${emoji.name}\`${emoji.id ? `, ID: \`${emoji.id}\`` : ''})\n` +
          (emojiUrl ? `• **이모지 이미지 (CDN)**: [바로가기](${emojiUrl})\n` : '') +
          `• **대상 메시지 작성자**: ${authorMention}\n` +
          `• **대상 채널**: ${message.channel.toString()}\n` +
          `• **메시지 내용 바로가기**: [클릭하여 이동](${message.url})\n\n` +
          `**메시지 내용 미리보기:**\n\`\`\`\n${contentPreview}\n\`\`\``
        )
        .setThumbnail(emojiUrl)
        .setColor(0xEF4444) // Red
        .setTimestamp();

      await logChannel.send({ embeds: [embed] }).catch(console.error);
    }
  },
  agreedGuilds,
  logSettingsCache,
  saveLogSettings,
  activePurges,
  logPurge: logPurgeInternal,
  logWarning: logWarningEvent
};

// 경고/제재 이벤트 로깅용 공용 헬퍼 함수
async function logWarningEvent(client, guildId, eventData) {
  try {
    const logChannel = await getLogChannel(client, guildId, 'log_sanction');
    if (!logChannel) return;

    const { action, targetUser, moderator, count, warnId, reason, amount, deletedWarnings, remainingCount } = eventData;
    
    const embed = new EmbedBuilder()
      .setColor(MAIN_COLOR)
      .setTimestamp();

    if (action === 'add') {
      embed.setTitle('⚖️ [제재] 유저 경고 부여')
        .setDescription(`${targetUser} 님에게 새로운 경고가 부여되었습니다.`)
        .addFields(
          { name: '경고 ID', value: `\`#${warnId}\``, inline: true },
          { name: '대상 유저', value: `${targetUser.tag || targetUser.username} (${targetUser.id})`, inline: true },
          { name: '누적 경고 횟수', value: `**${count}회**`, inline: true },
          { name: '처리 관리자', value: `${moderator.tag || moderator.username} (${moderator.id})`, inline: true },
          { name: '경고 사유', value: reason || '사유 미지정', inline: false }
        );
    } else if (action === 'delete_id') {
      embed.setTitle('⚖️ [제재] 특정 경고 ID 삭제')
        .setDescription(`${targetUser} 님의 경고 기록 중 특정 ID 경고가 삭제되었습니다.`)
        .addFields(
          { name: '대상 유저', value: `${targetUser.tag || targetUser.username} (${targetUser.id})`, inline: true },
          { name: '삭제된 경고 ID', value: `\`#${warnId}\``, inline: true },
          { name: '남은 누적 경고', value: `**${remainingCount}회**`, inline: true },
          { name: '삭제 처리자', value: `${moderator.tag || moderator.username} (${moderator.id})`, inline: true },
          { name: '삭제 사유', value: reason || '사유 미지정', inline: false }
        );
      if (eventData.originalReason) {
        embed.addFields({ name: '삭제된 경고의 원래 사유', value: `\`${eventData.originalReason}\` (${eventData.originalTimestamp ? new Date(eventData.originalTimestamp).toLocaleDateString() : '알 수 없음'})`, inline: false });
      }
    } else if (action === 'subtract') {
      embed.setTitle('⚖️ [제재] 누적 경고 차감')
        .setDescription(`${targetUser} 님의 누적 경고 중 최근 기록이 차감되었습니다.`)
        .addFields(
          { name: '대상 유저', value: `${targetUser.tag || targetUser.username} (${targetUser.id})`, inline: true },
          { name: '차감된 횟수', value: `**${amount}회**`, inline: true },
          { name: '남은 누적 경고', value: `**${remainingCount}회**`, inline: true },
          { name: '차감 처리자', value: `${moderator.tag || moderator.username} (${moderator.id})`, inline: true },
          { name: '차감 사유', value: reason || '사유 미지정', inline: false }
        );
      if (deletedWarnings && deletedWarnings.length > 0) {
        const details = deletedWarnings.map(r => 
          `• \`#${r.guild_warn_id || r.id}\` 경고 - **원래 사유**: \`${r.reason || '사유 미지정'}\` (${new Date(r.timestamp).toLocaleDateString()})`
        ).join('\n');
        embed.addFields({ name: '차감된 경고 정보', value: details });
      }
    } else if (action === 'reset') {
      embed.setTitle('⚖️ [제재] 유저 경고 전체 초기화')
        .setDescription(`${targetUser} 님의 모든 누적 경고가 전체 삭제되었습니다.`)
        .addFields(
          { name: '대상 유저', value: `${targetUser.tag || targetUser.username} (${targetUser.id})`, inline: true },
          { name: '처리 관리자', value: `${moderator.tag || moderator.username} (${moderator.id})`, inline: true }
        );
    } else if (action === 'edit_reason') {
      embed.setTitle('⚖️ [제재] 제재 사유 수정')
        .setDescription(`제재 고유 ID **#${warnId}**의 사유가 수정되었습니다.`)
        .addFields(
          { name: '대상 유저', value: targetUser.id ? `<@${targetUser.id}> (${targetUser.tag || targetUser.username})` : `${targetUser.tag || targetUser.username}`, inline: true },
          { name: '제재 유형', value: `**${eventData.typeLabel || '알 수 없음'}**`, inline: true },
          { name: '처리 관리자', value: `${moderator.tag || moderator.username} (${moderator.id})`, inline: true },
          { name: '기존 사유', value: `\`${eventData.oldReason || '사유 미지정'}\``, inline: false },
          { name: '변경된 사유', value: `**\`${reason}\`**`, inline: false }
        );
    }

    await logChannel.send({ embeds: [embed] }).catch(console.error);
  } catch (e) {
    console.error("[logWarningEvent] Error sending warning log:", e);
  }
}