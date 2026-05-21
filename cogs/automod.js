const { 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  PermissionFlagsBits,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  MessageFlags,
  ThumbnailBuilder
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { MAIN_COLOR, SUCCESS_COLOR, ERROR_COLOR, PERMISSION_ERROR_EMBED } = require('../core/config');
const { checkAdminPermission } = require('../core/utils');

// Shared Database Setup
const dbPath = path.join(process.cwd(), 'xiadb.db');
const db = new sqlite3.Database(dbPath);
db.configure("busyTimeout", 5000);

// Initialize Automod Tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS anti_spam_settings (
    guild_id TEXT PRIMARY KEY,
    enabled INTEGER
  )`);
});

// Cache for anti-spam
const messageTimestamps = new Map(); // `${guildId}_${userId}` -> Array of timestamps [ms]
const messageContentCache = new Map(); // `${guildId}_${userId}` -> { content: string, count: number, firstSent: number }

// Guild Log Channel Helper
async function getGuildLogChannel(client, guildId) {
  return new Promise((resolve) => {
    db.get("SELECT channels FROM log_settings WHERE guild_id = ?", [guildId.toString()], (err, row) => {
      if (!err && row && row.channels) {
        try {
          const channels = JSON.parse(row.channels);
          const channelData = channels['log_chat'];
          if (channelData && channelData.id) {
            const ch = client.channels.cache.get(channelData.id);
            if (ch) return resolve(ch);
          }
        } catch (e) {
          console.error(e);
        }
      }
      resolve(null);
    });
  });
}

module.exports = {
  name: 'Automod',
  description: '자동 도배 방지, 이모지 삭제 승인 요청 기능',

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('도배방지')
        .setDescription('서버의 자동 도배 방지 시스템을 설정 및 제어합니다.')
        .addSubcommand(subcommand =>
          subcommand.setName('설정')
            .setDescription('도배 방지 작동 상태를 변경합니다.')
            .addStringOption(option =>
              option.setName('상태')
                .setDescription('도배 방지 작동 상태 선택')
                .setRequired(true)
                .addChoices(
                  { name: '활성화', value: 'on' },
                  { name: '비활성화', value: 'off' }
                )
            )
        )
        .addSubcommand(subcommand =>
          subcommand.setName('상태')
            .setDescription('현재 서버의 도배 방지 상태를 조회합니다.')
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId.toString();

        if (subcommand === '설정') {
          const status = interaction.options.getString('상태');
          const enabled = status === 'on' ? 1 : 0;

          await new Promise((resolve) => {
            db.run(
              "INSERT OR REPLACE INTO anti_spam_settings (guild_id, enabled) VALUES (?, ?)",
              [guildId, enabled],
              () => resolve()
            );
          });

          const embed = new EmbedBuilder()
            .setTitle(enabled ? '🛡️ 도배 방지 시스템 활성화' : '🔓 도배 방지 시스템 비활성화')
            .setDescription(enabled
              ? '이제 실시간 메시지 발송 속도 및 동일 구문 중복 전송을 모니터링하여 도배 유저를 **자동 타임아웃** 조치합니다.'
              : '서버의 도배 방지 보안 필터링이 일시 해제되었습니다.'
            )
            .setColor(enabled ? SUCCESS_COLOR : ERROR_COLOR)
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        } else if (subcommand === '상태') {
          db.get("SELECT enabled FROM anti_spam_settings WHERE guild_id = ?", [guildId], (err, row) => {
            const enabled = row ? row.enabled === 1 : true; // Default to enabled (1)

            const embed = new EmbedBuilder()
              .setTitle('🛡️ 도배 방지 작동 상태 조회')
              .setDescription(`현재 서버의 도배 방지 시스템 작동 상태는 **${enabled ? '🟢 활성화' : '🔴 비활성화'}** 입니다.`)
              .setColor(MAIN_COLOR)
              .setTimestamp();

            return interaction.reply({ embeds: [embed] });
          });
        }
      }
    }
  ],

  listeners: {
    // 1. Forbidden word filtering & Anti-spam (도배방지)
    async messageCreate(client, message) {
      if (message.author.bot || !message.guild || !message.member) return;

      const guildId = message.guild.id;
      const userId = message.author.id;
      const key = `${guildId}_${userId}`;
      const now = Date.now();

      // Check moderate permissions to skip admins/mods for comfort
      if (message.member.permissions.has(PermissionFlagsBits.ModerateMembers) || (await checkAdminPermission(message.member))) return;

      // Query database to check if anti-spam is enabled for this server
      const isSpamEnabled = await new Promise((resolve) => {
        db.get("SELECT enabled FROM anti_spam_settings WHERE guild_id = ?", [guildId], (err, row) => {
          resolve(row ? row.enabled === 1 : true); // default enabled (1)
        });
      });

      if (!isSpamEnabled) return;

      // Anti-Spam (도배방지) A: Message Frequency (5 messages in 3 seconds)
      if (!messageTimestamps.has(key)) {
        messageTimestamps.set(key, []);
      }
      const timestamps = messageTimestamps.get(key);
      timestamps.push(now);

      // Keep only last 3 seconds
      const recentTimestamps = timestamps.filter(t => now - t < 3000);
      messageTimestamps.set(key, recentTimestamps);

      let isSpamming = false;
      let spamReason = "";

      if (recentTimestamps.length > 5) {
        isSpamming = true;
        spamReason = "🚨 **단시간 내 도배 감지** (3초 내에 5회 초과 전송)";
      }

      // Anti-Spam B: Repeated exact content (3 exact consecutive matches in 5 seconds)
      const content = message.content.trim().toLowerCase();
      if (content && content.length > 0) {
        if (!messageContentCache.has(key)) {
          messageContentCache.set(key, { content: "", count: 0, firstSent: 0 });
        }
        const cached = messageContentCache.get(key);

        if (cached.content === content && now - cached.firstSent < 5000) {
          cached.count += 1;
        } else {
          cached.content = content;
          cached.count = 1;
          cached.firstSent = now;
        }

        if (cached.count >= 3) {
          isSpamming = true;
          spamReason = "🚨 **동일 메시지 반복 전송 감지** (5초 내에 3회 중복 전송)";
          messageContentCache.delete(key); // Clear to prevent continuous triggers
        }
      }

      // Execute Action on Spamming
      if (isSpamming) {
        try {
          // Delete spam message
          await message.delete().catch(() => {});

          // Timeout user for 10 minutes
          await message.member.timeout(10 * 60 * 1000, `자동 제재: 도배 감지 (${spamReason})`);

          // Insert warning into database
          db.run(
            "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, timestamp) VALUES (?, ?, 'SYSTEM', ?, ?)",
            [guildId, userId, `도배 자동 제재: ${spamReason}`, new Date().toISOString()]
          );

          const alertEmbed = new EmbedBuilder()
            .setTitle('🛡️ 도배 유저 자동 격리 조치')
            .setDescription(`${message.author} 님이 도배 방지 필터에 감지되어 즉시 **10분 타임아웃** 제재를 받았습니다.`)
            .addFields(
              { name: '도배 유형', value: spamReason }
            )
            .setColor(ERROR_COLOR)
            .setTimestamp();

          // Send to channel
          const alertMsg = await message.channel.send({ embeds: [alertEmbed] });
          setTimeout(() => alertMsg.delete().catch(() => {}), 15000); // Clean alert after 15s

          // Send to Log
          const logChannel = await getGuildLogChannel(client, guildId);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('🛡️ 도배 유저 자동 제재 알림')
              .setDescription(`${message.author} (${userId}) 유저가 채팅 도배로 제재되었습니다.`)
              .addFields(
                { name: '유형', value: spamReason },
                { name: '대응 조치', value: '메시지 즉시 자동 삭제 및 10분 타임아웃 처리' }
              )
              .setColor(ERROR_COLOR)
              .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (e) {
          console.error("Spam handling failed:", e);
        }
        return; // Halt execution
      }
    },

    // 3. Emoji 🗑 Reaction Deletion Approval Request
    async messageReactionAdd(client, reaction, user) {
      if (user.bot || !reaction.message.guild) return;

      // Resolve partial reaction/message to access content
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch (e) {
          console.error("Failed to fetch partial reaction:", e);
          return;
        }
      }
      if (reaction.message.partial) {
        try {
          await reaction.message.fetch();
        } catch (e) {
          console.error("Failed to fetch partial message:", e);
          return;
        }
      }

      // Check if emoji is 🗑
      if (reaction.emoji.name === '🗑') {
        const message = reaction.message;
        const guildId = message.guild.id;

        // Fetch Log Channel for deletion requests
        const logChannel = await getGuildLogChannel(client, guildId);
        if (!logChannel) return;

        // Clear user reaction to keep channel neat
        await reaction.users.remove(user).catch(() => {});

        const container = new ContainerBuilder()
          .setAccentColor(0x3B82F6) // MAIN_COLOR equivalent
          .addSectionComponents(
            new SectionBuilder()
              .setThumbnailAccessory(
                new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1604147706283-d7119b5b822c?auto=format&fit=crop&q=80&w=256&h=256')
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# 🗑 메시지 삭제 승인 요청\n\n` +
                  `어떤 유저가 아래 메시지의 강제 삭제 승인을 접수하였습니다.\n\n` +
                  `• **요청자**: ${user} (ID: ${user.id})\n` +
                  `• **메시지 작성자**: ${message.author} (ID: ${message.author.id})\n` +
                  `• **채널**: ${message.channel}\n\n` +
                  `### 📝 메시지 내용\n` +
                  `${message.content || '(내용 없음 / 임베드 또는 첨부파일)'}\n\n` +
                  `🔗 **메시지 링크**: [바로가기](${message.url})`
                )
              )
          );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`delapprove_yes_${message.channel.id}_${message.id}`)
            .setLabel('삭제 승인')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('delapprove_no')
            .setLabel('거절 및 취소')
            .setStyle(ButtonStyle.Success)
        );

        container.addActionRowComponents(row);

        await logChannel.send({
          components: [container],
          flags: [MessageFlags.IsComponentsV2]
        });
      }
    },

    // Handle Reaction Deletion buttons
    async interactionCreate(client, interaction) {
      if (!interaction.isButton()) return;
      const customId = interaction.customId;
      const guild = interaction.guild;
      const member = interaction.member;

      if (!customId.startsWith('delapprove_')) return;

      // Check Moderator Permission
      if (!(await checkAdminPermission(member))) {
        return interaction.reply({ content: '❌ 이 버튼을 사용할 권한이 없습니다. (관리자 권한 필요)', ephemeral: true });
      }

      if (customId.startsWith('delapprove_yes_')) {
        const parts = customId.split('_');
        const channelId = parts[2];
        const messageId = parts[3];

        try {
          const channel = guild.channels.cache.get(channelId);
          if (channel) {
            const msg = await channel.messages.fetch(messageId).catch(() => null);
            if (msg) {
              await msg.delete();
              
              const successContainer = new ContainerBuilder()
                .setAccentColor(0x10B981) // SUCCESS_COLOR equivalent
                .addSectionComponents(
                  new SectionBuilder()
                    .setThumbnailAccessory(
                      new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005198143-e5283b519a7f?auto=format&fit=crop&q=80&w=256&h=256')
                    )
                    .addTextDisplayComponents(
                      new TextDisplayBuilder().setContent(
                        `# 🗑 메시지 삭제 승인 요청 (처리 완료)\n\n` +
                        `✅ **삭제 완료**: 메시지가 강제 삭제 조치되었습니다.\n\n` +
                        `• **승인 관리자**: ${interaction.user} (${interaction.user.tag})`
                      )
                    )
                );
              
              await interaction.update({
                components: [successContainer],
                flags: [MessageFlags.IsComponentsV2]
              });
            } else {
              await interaction.reply({ content: '❌ 해당 메시지를 찾을 수 없습니다. (이미 삭제되었을 수 있습니다)', ephemeral: true });
            }
          }
        } catch (e) {
          await interaction.reply({ content: `❌ 메시지 삭제 실패: ${e.message}`, ephemeral: true });
        }
      } 
      
      else if (customId === 'delapprove_no') {
        const successContainer = new ContainerBuilder()
          .setAccentColor(0x3B82F6) // MAIN_COLOR equivalent
          .addSectionComponents(
            new SectionBuilder()
              .setThumbnailAccessory(
                new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# 🗑 메시지 삭제 승인 요청 (처리 완료)\n\n` +
                  `ℹ️ **요청 거절**: 삭제 승인 요청이 거절 및 취소되었습니다.\n\n` +
                  `• **처리 관리자**: ${interaction.user} (${interaction.user.tag})`
                )
              )
          );
        
        await interaction.update({
          components: [successContainer],
          flags: [MessageFlags.IsComponentsV2]
        });
      }
    }
  }
};
