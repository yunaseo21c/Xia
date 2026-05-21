const { 
  SlashCommandBuilder, 
  ContextMenuCommandBuilder,
  ApplicationCommandType,
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

// Initialize Moderation Tables
db.serialize(() => {
  // Warnings Table
  db.run(`CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    user_id TEXT,
    moderator_id TEXT,
    reason TEXT,
    timestamp TEXT,
    guild_warn_id INTEGER
  )`);

  // Try to add the column in case the table already exists without it
  db.run(`ALTER TABLE warnings ADD COLUMN guild_warn_id INTEGER`, (err) => {
    // Ignore "duplicate column name" error
  });

  // Warning Sanctions Table
  db.run(`CREATE TABLE IF NOT EXISTS server_warning_sanctions (
    guild_id TEXT,
    warning_count INTEGER,
    action_type TEXT,
    duration_value INTEGER,
    PRIMARY KEY (guild_id, warning_count)
  )`);
});

// Guild Log Channel Helper
async function getGuildLogChannel(client, guildId) {
  return new Promise((resolve) => {
    db.get("SELECT channels FROM log_settings WHERE guild_id = ?", [guildId.toString()], (err, row) => {
      if (!err && row && row.channels) {
        try {
          const channels = JSON.parse(row.channels);
          const channelData = channels['log_ban'] || channels['log_chat'];
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
  name: 'Moderation',
  description: '서버 관리 및 보안 관리 도구 (경고, 차단, 블랙리스트 등)',
  
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('경고')
        .setDescription('유저에게 경고를 줍니다.')
        .addUserOption(option => 
          option.setName('대상').setDescription('경고를 줄 유저').setRequired(true)
        )
        .addStringOption(option => 
          option.setName('사유').setDescription('경고 사유').setRequired(false)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }
        const targetUser = interaction.options.getUser('대상');
        const reason = interaction.options.getString('사유') || '사유 미지정';
        const guild = interaction.guild;
        const user = interaction.user;

        db.run(
          "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, timestamp, guild_warn_id) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(guild_warn_id), 0) + 1 FROM warnings WHERE guild_id = ?))",
          [guild.id, targetUser.id, user.id, reason, new Date().toISOString(), guild.id],
          function(err) {
            if (err) {
              return interaction.reply({ content: '❌ 경고 저장 중 오류가 발생했습니다.', ephemeral: true });
            }

            const lastInsertedId = this.lastID;

            db.get("SELECT guild_warn_id FROM warnings WHERE id = ?", [lastInsertedId], (err, warnRow) => {
              const guildWarnId = warnRow ? warnRow.guild_warn_id : 'N/A';

              db.get("SELECT COUNT(*) as count FROM warnings WHERE guild_id = ? AND user_id = ?", [guild.id, targetUser.id], async (err, row) => {
                const count = row ? row.count : 1;
                
                const embed = new EmbedBuilder()
                  .setTitle('⚠️ 유저 경고 부여')
                  .setDescription(`${targetUser} 님에게 경고가 부여되었습니다.`)
                  .addFields(
                    { name: '경고 ID', value: `\`#${guildWarnId}\``, inline: true },
                    { name: '대상 유저', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
                    { name: '누적 경고 횟수', value: `**${count}회**`, inline: true },
                    { name: '처리 관리자', value: `${user.tag}`, inline: true },
                    { name: '경고 사유', value: reason, inline: false }
                  )
                  .setColor(MAIN_COLOR)
                  .setTimestamp();

                await interaction.reply({ embeds: [embed] });

              // Check and apply custom warning sanctions
              db.get(
                "SELECT action_type, duration_value FROM server_warning_sanctions WHERE guild_id = ? AND warning_count = ?",
                [guild.id.toString(), count],
                async (err, sanctionRow) => {
                  if (err) {
                    console.error("Error fetching warning sanctions:", err);
                    return;
                  }
                  
                  if (sanctionRow) {
                    const member = guild.members.cache.get(targetUser.id);
                    if (!member) return;

                    const actionType = sanctionRow.action_type;
                    const durationValue = sanctionRow.duration_value; // In minutes

                    if (actionType === 'timeout') {
                      if (member.moderatable) {
                        try {
                          const ms = durationValue * 60 * 1000;
                          await member.timeout(ms, `누적 경고 ${count}회 도달 자동 제재`);
                          
                          // Format duration nicely
                          let durationStr = `${durationValue}분`;
                          if (durationValue >= 1440 && durationValue % 1440 === 0) {
                            durationStr = `${durationValue / 1440}일`;
                          } else if (durationValue >= 60 && durationValue % 60 === 0) {
                            durationStr = `${durationValue / 60}시간`;
                          }

                          const autoEmbed = new EmbedBuilder()
                            .setTitle('🛡️ 누적 경고 자동 제재 (타임아웃)')
                            .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달하여 **${durationStr} 타임아웃** 제재를 받았습니다.`)
                            .setColor(ERROR_COLOR)
                            .setTimestamp();
                          await interaction.followUp({ embeds: [autoEmbed] });
                        } catch (e) {
                          console.error("Error executing auto-timeout sanction:", e);
                        }
                      }
                    } else if (actionType === 'kick') {
                      if (member.kickable) {
                        try {
                          await member.kick(`누적 경고 ${count}회 도달 자동 제재`);
                          const autoEmbed = new EmbedBuilder()
                            .setTitle('🛡️ 누적 경고 자동 제재 (추방)')
                            .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달하여 **서버에서 추방** 처리되었습니다.`)
                            .setColor(ERROR_COLOR)
                            .setTimestamp();
                          await interaction.followUp({ embeds: [autoEmbed] });
                        } catch (e) {
                          console.error("Error executing auto-kick sanction:", e);
                        }
                      }
                    } else if (actionType === 'ban') {
                      if (member.bannable) {
                        try {
                          const autoReason = `누적 경고 ${count}회 도달 자동 제재`;
                          interaction.client.banCache = interaction.client.banCache || new Map();
                          interaction.client.banCache.set(`${guild.id}-${targetUser.id}`, {
                            reason: autoReason,
                            executor: `${interaction.client.user.toString()} (시스템 자동 제재)`
                          });
                          await guild.members.ban(targetUser.id, { reason: autoReason });
                          const autoEmbed = new EmbedBuilder()
                            .setTitle('🛡️ 누적 경고 자동 제재 (차단)')
                            .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달하여 **서버에서 차단(밴)** 처리되었습니다.`)
                            .setColor(ERROR_COLOR)
                            .setTimestamp();
                          await interaction.followUp({ embeds: [autoEmbed] });
                        } catch (e) {
                          if (interaction.client.banCache) {
                            interaction.client.banCache.delete(`${guild.id}-${targetUser.id}`);
                          }
                          console.error("Error executing auto-ban sanction:", e);
                        }
                      }
                    }
                  }
                }
              );
            });
          });
        }
      );
    }
    },
    {
      data: new SlashCommandBuilder()
        .setName('경고조회')
        .setDescription('유저의 누적 경고 정보를 조회합니다.')
        .addUserOption(option => 
          option.setName('대상').setDescription('조회할 유저').setRequired(true)
        ),
      async execute(interaction) {
        const targetUser = interaction.options.getUser('대상');
        const guild = interaction.guild;
        const isSelf = targetUser.id === interaction.user.id;
        const isAdmin = await checkAdminPermission(interaction.member);

        if (!isSelf && !isAdmin) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        db.all("SELECT guild_warn_id, reason, moderator_id, timestamp FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY guild_warn_id DESC", [guild.id, targetUser.id], (err, rows) => {
          if (err) {
            return interaction.reply({ content: '❌ 경고 조회 중 데이터베이스 오류가 발생했습니다.', ephemeral: true });
          }

          const count = rows ? rows.length : 0;
          const embed = new EmbedBuilder()
            .setTitle(`🔍 ${targetUser.username} 님의 누적 경고`)
            .setDescription(`${targetUser} 님의 누적 경고 횟수는 현재 **${count}회**입니다.`)
            .setColor(MAIN_COLOR)
            .setTimestamp();

          if (count > 0) {
            const list = rows.slice(0, 10).map(row => 
              `\`#${row.guild_warn_id}\` 사유: \`${row.reason}\` (처리자: <@${row.moderator_id}>, 날짜: ${new Date(row.timestamp).toLocaleDateString()})`
            ).join('\n');
            embed.addFields({ name: '최근 경고 기록 (최대 10개)', value: list });
          } else {
            embed.addFields({ name: '경고 기록', value: '깨끗합니다! 등록된 경고가 없습니다. ✨' });
          }

          return interaction.reply({ embeds: [embed] });
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('경고초기화')
        .setDescription('유저의 모든 누적 경고를 차감/초기화합니다.')
        .addUserOption(option => 
          option.setName('대상').setDescription('경고를 초기화할 유저').setRequired(true)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }
        const targetUser = interaction.options.getUser('대상');
        const guild = interaction.guild;

        db.run("DELETE FROM warnings WHERE guild_id = ? AND user_id = ?", [guild.id, targetUser.id], function(err) {
          if (err) {
            return interaction.reply({ content: '❌ 경고 초기화 중 데이터베이스 오류가 발생했습니다.', ephemeral: true });
          }

          const embed = new EmbedBuilder()
            .setTitle('✨ 경고 초기화 완료')
            .setDescription(`${targetUser} 님의 모든 누적 경고가 깨끗이 초기화되었습니다.`)
            .setColor(SUCCESS_COLOR)
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('경고삭제')
        .setDescription('서버별 경고 ID를 지정하여 특정 경고를 삭제(차감)합니다.')
        .addIntegerOption(option => 
          option.setName('경고id').setDescription('삭제할 경고의 서버별 ID (예: 5)').setRequired(true)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const guildId = interaction.guildId.toString();
        const guildWarnId = interaction.options.getInteger('경고id');

        db.get("SELECT user_id, reason, timestamp FROM warnings WHERE guild_id = ? AND guild_warn_id = ?", [guildId, guildWarnId], (err, row) => {
          if (err || !row) {
            return interaction.reply({ content: `❌ 이 서버에서 경고 ID **#${guildWarnId}**에 해당하는 기록을 찾을 수 없습니다.`, ephemeral: true });
          }

          db.run("DELETE FROM warnings WHERE guild_id = ? AND guild_warn_id = ?", [guildId, guildWarnId], async function(err) {
            if (err) {
              return interaction.reply({ content: '❌ 경고 삭제 중 오류가 발생했습니다.', ephemeral: true });
            }

            const targetUser = await interaction.client.users.fetch(row.user_id).catch(() => null);
            const userTag = targetUser ? `${targetUser.tag} (${targetUser.id})` : row.user_id;

            const embed = new EmbedBuilder()
              .setTitle('✨ 특정 경고 삭제 완료')
              .setDescription(`경고 ID **#${guildWarnId}**번 기록이 성공적으로 삭제(차감)되었습니다.`)
              .addFields(
                { name: '대상 유저', value: userTag, inline: true },
                { name: '기존 경고 사유', value: row.reason, inline: true },
                { name: '기존 경고 날짜', value: new Date(row.timestamp).toLocaleDateString(), inline: true }
              )
              .setColor(SUCCESS_COLOR)
              .setTimestamp();

            return interaction.reply({ embeds: [embed] });
          });
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('경고검색')
        .setDescription('서버별 경고 ID로 특정 경고의 상세 정보를 검색합니다.')
        .addIntegerOption(option => 
          option.setName('경고id').setDescription('검색할 경고의 서버별 ID (예: 5)').setRequired(true)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const guildId = interaction.guildId.toString();
        const guildWarnId = interaction.options.getInteger('경고id');

        db.get("SELECT user_id, moderator_id, reason, timestamp FROM warnings WHERE guild_id = ? AND guild_warn_id = ?", [guildId, guildWarnId], async (err, row) => {
          if (err || !row) {
            return interaction.reply({ content: `❌ 이 서버에서 경고 ID **#${guildWarnId}**에 해당하는 기록을 찾을 수 없습니다.`, ephemeral: true });
          }

          const targetUser = await interaction.client.users.fetch(row.user_id).catch(() => null);
          const moderator = await interaction.client.users.fetch(row.moderator_id).catch(() => null);

          const embed = new EmbedBuilder()
            .setTitle(`🔍 경고 상세 정보 (#${guildWarnId})`)
            .addFields(
              { name: '대상 유저', value: targetUser ? `${targetUser} (${targetUser.tag})` : row.user_id, inline: true },
              { name: '처리 관리자', value: moderator ? `${moderator} (${moderator.tag})` : row.moderator_id, inline: true },
              { name: '경고 날짜', value: new Date(row.timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), inline: true },
              { name: '경고 사유', value: row.reason, inline: false }
            )
            .setColor(MAIN_COLOR)
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('경고목록')
        .setDescription('이 서버에 누적된 전체 경고 목록을 조회합니다.')
        .addUserOption(option => 
          option.setName('대상').setDescription('특정 유저의 경고 목록만 조회하려면 선택하세요.').setRequired(false)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const guildId = interaction.guildId.toString();
        const targetUser = interaction.options.getUser('대상');

        let query = "SELECT guild_warn_id, user_id, moderator_id, reason, timestamp FROM warnings WHERE guild_id = ? ORDER BY guild_warn_id DESC";
        let params = [guildId];

        if (targetUser) {
          query = "SELECT guild_warn_id, user_id, moderator_id, reason, timestamp FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY guild_warn_id DESC";
          params = [guildId, targetUser.id];
        }

        db.all(query, params, async (err, rows) => {
          if (err) {
            return interaction.reply({ content: '❌ 경고 목록 조회 중 오류가 발생했습니다.', ephemeral: true });
          }

          if (!rows || rows.length === 0) {
            const emptyEmbed = new EmbedBuilder()
              .setTitle(targetUser ? `📋 ${targetUser.username} 님의 경고 목록` : '📋 서버 전체 경고 목록')
              .setDescription('등록된 경고 기록이 없습니다. ✨')
              .setColor(MAIN_COLOR)
              .setTimestamp();
            return interaction.reply({ embeds: [emptyEmbed] });
          }

          const totalPages = Math.ceil(rows.length / 10);
          let currentPage = 1;

          const generatePage = (page) => {
            const startIndex = (page - 1) * 10;
            const pageWarnings = rows.slice(startIndex, startIndex + 10);

            const embed = new EmbedBuilder()
              .setTitle(targetUser ? `📋 ${targetUser.username} 님의 경고 목록` : '📋 서버 전체 경고 목록')
              .setColor(MAIN_COLOR)
              .setFooter({ text: `페이지 ${page} / ${totalPages} • 총 경고 수: ${rows.length}개` })
              .setTimestamp();

            const list = pageWarnings.map(row => 
              `\`#${row.guild_warn_id}\` <@${row.user_id}> | 사유: \`${row.reason}\` (처리자: <@${row.moderator_id}>, ${new Date(row.timestamp).toLocaleDateString()})`
            ).join('\n');

            embed.setDescription(list);

            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('warn_list_prev')
                .setLabel('◀️ 이전')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 1),
              new ButtonBuilder()
                .setCustomId('warn_list_next')
                .setLabel('▶️ 다음')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === totalPages)
            );

            return { embeds: [embed], components: totalPages > 1 ? [row] : [] };
          };

          const replyMessage = await interaction.reply(generatePage(currentPage));
          if (totalPages <= 1) return;

          const collector = replyMessage.createMessageComponentCollector({
            filter: (i) => i.user.id === interaction.user.id,
            time: 60000
          });

          collector.on('collect', async (i) => {
            if (i.customId === 'warn_list_prev') {
              currentPage--;
            } else if (i.customId === 'warn_list_next') {
              currentPage++;
            }
            await i.update(generatePage(currentPage));
          });

          collector.on('end', () => {
            const disabledRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('prev_disabled').setLabel('◀️ 이전').setStyle(ButtonStyle.Secondary).setDisabled(true),
              new ButtonBuilder().setCustomId('next_disabled').setLabel('▶️ 다음').setStyle(ButtonStyle.Secondary).setDisabled(true)
            );
            interaction.editReply({ components: [disabledRow] }).catch(() => null);
          });
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('추방')
        .setDescription('유저를 서버에서 추방합니다.')
        .addUserOption(option => 
          option.setName('대상').setDescription('추방할 유저').setRequired(true)
        )
        .addStringOption(option => 
          option.setName('사유').setDescription('추방 사유').setRequired(false)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }
        const targetUser = interaction.options.getUser('대상');
        const reason = interaction.options.getString('사유') || '사유 미지정';
        const guild = interaction.guild;
        const user = interaction.user;
        const member = guild.members.cache.get(targetUser.id);

        if (!member) {
          return interaction.reply({ content: '❌ 서버에서 해당 유저를 찾을 수 없습니다.', ephemeral: true });
        }

        if (!member.kickable) {
          return interaction.reply({ content: '❌ 봇의 권한이 부족하여 해당 유저를 추방할 수 없습니다.', ephemeral: true });
        }

        await member.kick(reason);

        const embed = new EmbedBuilder()
          .setTitle('👢 유저 추방 완료')
          .setDescription(`${targetUser.tag} 님이 서버에서 성공적으로 추방되었습니다.`)
          .addFields(
            { name: '대상 유저', value: `${targetUser} (${targetUser.id})`, inline: true },
            { name: '처리 관리자', value: `${user}`, inline: true },
            { name: '사유', value: reason }
          )
          .setColor(MAIN_COLOR)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('차단')
        .setDescription('유저를 서버에서 차단(밴)합니다.')
        .addStringOption(option => 
          option.setName('대상').setDescription('차단할 유저의 ID 또는 멘션 (예: 123456789012345678)').setRequired(true)
        )
        .addStringOption(option => 
          option.setName('사유').setDescription('차단 사유').setRequired(false)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }
        const targetInput = interaction.options.getString('대상');
        const idMatch = targetInput.match(/\d{17,19}/);
        if (!idMatch) {
          return interaction.reply({ content: '❌ 올바른 유저 ID 또는 멘션을 입력해주세요.', ephemeral: true });
        }
        const targetId = idMatch[0];
        const reason = interaction.options.getString('사유') || '사유 미지정';
        const guild = interaction.guild;
        const user = interaction.user;

        // Try to fetch the user object to display their details nicely
        let targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
        const userDisplay = targetUser ? `${targetUser}` : `<@${targetId}>`;
        const userTag = targetUser ? `${targetUser.tag} (${targetId})` : `외부/미캐싱 유저 (${targetId})`;

        // Cache the ban reason & executor locally to avoid audit log latency and race conditions
        interaction.client.banCache = interaction.client.banCache || new Map();
        interaction.client.banCache.set(`${guild.id}-${targetId}`, {
          reason,
          executor: `${user.toString()} (${user.tag})`
        });

        try {
          await guild.members.ban(targetId, { reason });
        } catch (e) {
          if (interaction.client.banCache) {
            interaction.client.banCache.delete(`${guild.id}-${targetId}`);
          }
          return interaction.reply({ content: '❌ 봇의 권한이 부족하거나 유효하지 않은 유저 ID여서 차단할 수 없습니다.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle('🚫 유저 차단 완료')
          .setDescription(`${userDisplay} 님이 서버에서 영구 차단되었습니다.`)
          .addFields(
            { name: '대상 유저', value: userTag, inline: true },
            { name: '처리 관리자', value: `${user}`, inline: true },
            { name: '사유', value: reason }
          )
          .setColor(ERROR_COLOR)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('차단해제')
        .setDescription('유저의 차단(밴)을 해제합니다.')
        .addStringOption(option => 
          option.setName('대상').setDescription('차단 해제할 유저의 ID 또는 멘션 (예: 123456789012345678)').setRequired(true)
        )
        .addStringOption(option => 
          option.setName('사유').setDescription('차단 해제 사유').setRequired(false)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }
        const targetInput = interaction.options.getString('대상');
        const idMatch = targetInput.match(/\d{17,19}/);
        if (!idMatch) {
          return interaction.reply({ content: '❌ 올바른 유저 ID 또는 멘션을 입력해주세요.', ephemeral: true });
        }
        const targetId = idMatch[0];
        const reason = interaction.options.getString('사유') || '사유 미지정';
        const guild = interaction.guild;
        const user = interaction.user;

        // Try to fetch the user object to display their details nicely
        let targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
        const userDisplay = targetUser ? `${targetUser}` : `<@${targetId}>`;
        const userTag = targetUser ? `${targetUser.tag} (${targetId})` : `외부/미캐싱 유저 (${targetId})`;

        // Cache the unban reason & executor locally to avoid audit log latency and race conditions
        interaction.client.unbanCache = interaction.client.unbanCache || new Map();
        interaction.client.unbanCache.set(`${guild.id}-${targetId}`, {
          reason,
          executor: `${user.toString()} (${user.tag})`
        });

        try {
          await guild.bans.remove(targetId, reason);
        } catch (e) {
          if (interaction.client.unbanCache) {
            interaction.client.unbanCache.delete(`${guild.id}-${targetId}`);
          }
          return interaction.reply({ content: '❌ 차단 목록에서 해당 ID의 유저를 찾을 수 없거나 봇의 권한이 부족합니다.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle('🔓 유저 차단 해제 완료')
          .setDescription(`${userDisplay} 님의 차단이 성공적으로 해제되었습니다.`)
          .addFields(
            { name: '대상 유저', value: userTag, inline: true },
            { name: '처리 관리자', value: `${user}`, inline: true },
            { name: '사유', value: reason }
          )
          .setColor(SUCCESS_COLOR)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('타임아웃')
        .setDescription('유저를 일정 시간 동안 타임아웃(뮤트)합니다.')
        .addUserOption(option => 
          option.setName('대상').setDescription('타임아웃할 유저').setRequired(true)
        )
        .addIntegerOption(option => 
          option.setName('시간').setDescription('타임아웃 시간 (분 단위)').setRequired(true)
        )
        .addStringOption(option => 
          option.setName('사유').setDescription('타임아웃 사유').setRequired(false)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }
        const targetUser = interaction.options.getUser('대상');
        const durationMinutes = interaction.options.getInteger('시간');
        const reason = interaction.options.getString('사유') || '사유 미지정';
        const guild = interaction.guild;
        const user = interaction.user;
        const member = guild.members.cache.get(targetUser.id);

        if (!member) {
          return interaction.reply({ content: '❌ 서버에서 해당 유저를 찾을 수 없습니다.', ephemeral: true });
        }

        if (!member.moderatable) {
          return interaction.reply({ content: '❌ 봇의 권한이 부족하여 해당 유저를 타임아웃할 수 없습니다.', ephemeral: true });
        }

        await member.timeout(durationMinutes * 60 * 1000, reason);

        const embed = new EmbedBuilder()
          .setTitle('⏳ 유저 타임아웃 완료')
          .setDescription(`${targetUser.tag} 님이 **${durationMinutes}분** 동안 타임아웃 제재를 받았습니다.`)
          .addFields(
            { name: '대상 유저', value: `${targetUser} (${targetUser.id})`, inline: true },
            { name: '제재 시간', value: `${durationMinutes}분`, inline: true },
            { name: '사유', value: reason }
          )
          .setColor(MAIN_COLOR)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('경고제재')
        .setDescription('누적 경고 횟수에 따른 자동 제재 조치(타임아웃/추방/차단)를 관리합니다.')
        .addSubcommand(sub =>
          sub.setName('설정')
            .setDescription('특정 경고 횟수 도달 시 자동 제재 조치를 설정합니다.')
            .addIntegerOption(opt =>
              opt.setName('누적횟수')
                .setDescription('제재를 적용할 누적 경고 횟수')
                .setRequired(true)
                .setMinValue(1)
            )
            .addStringOption(opt =>
              opt.setName('유형')
                .setDescription('자동 제재 조치 유형')
                .setRequired(true)
                .addChoices(
                  { name: '타임아웃 (Timeout)', value: 'timeout' },
                  { name: '추방 (Kick)', value: 'kick' },
                  { name: '차단 (Ban)', value: 'ban' }
                )
            )
            .addIntegerOption(opt =>
              opt.setName('시간')
                .setDescription('타임아웃 시간 값 (타임아웃 선택 시 필수)')
                .setRequired(false)
                .setMinValue(1)
            )
            .addStringOption(opt =>
              opt.setName('단위')
                .setDescription('타임아웃 시간 단위 (타임아웃 선택 시 필수)')
                .setRequired(false)
                .addChoices(
                  { name: '일 (Days)', value: 'days' },
                  { name: '시간 (Hours)', value: 'hours' },
                  { name: '분 (Minutes)', value: 'minutes' }
                )
            )
        )
        .addSubcommand(sub =>
          sub.setName('삭제')
            .setDescription('지정된 경고 횟수의 자동 제재 설정을 삭제합니다.')
            .addIntegerOption(opt =>
              opt.setName('누적횟수')
                .setDescription('삭제할 누적 경고 횟수')
                .setRequired(true)
                .setMinValue(1)
            )
        )
        .addSubcommand(sub =>
          sub.setName('목록')
            .setDescription('현재 설정된 누적 경고 자동 제재 목록을 확인합니다.')
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id.toString();

        if (subcommand === '설정') {
          const warningCount = interaction.options.getInteger('누적횟수');
          const actionType = interaction.options.getString('유형');
          const timeVal = interaction.options.getInteger('시간');
          const unit = interaction.options.getString('단위');

          if (actionType === 'timeout') {
            if (!timeVal || !unit) {
              return interaction.reply({ content: "❌ 타임아웃 제재 시에는 **시간**과 **단위** 옵션을 모두 입력하셔야 합니다.", ephemeral: true });
            }
          }

          let durationInMinutes = 0;
          if (actionType === 'timeout') {
            if (unit === 'days') {
              durationInMinutes = timeVal * 1440;
            } else if (unit === 'hours') {
              durationInMinutes = timeVal * 60;
            } else {
              durationInMinutes = timeVal;
            }
          }

          db.run(
            "INSERT OR REPLACE INTO server_warning_sanctions (guild_id, warning_count, action_type, duration_value) VALUES (?, ?, ?, ?)",
            [guildId, warningCount, actionType, durationInMinutes],
            function(err) {
              if (err) {
                console.error(err);
                return interaction.reply({ content: "❌ 제재 설정을 저장하는 도중 오류가 발생했습니다.", ephemeral: true });
              }

              let actionName = actionType === 'timeout' ? '타임아웃' : (actionType === 'kick' ? '추방' : '차단');
              let durationText = actionType === 'timeout' ? ` (${timeVal}${unit === 'days' ? '일' : (unit === 'hours' ? '시간' : '분')})` : '';

              const embed = new EmbedBuilder()
                .setTitle("🛡️ 경고 자동 제재 설정 완료")
                .setDescription(`누적 경고 횟수에 따른 자동 제재 조치가 설정되었습니다.`)
                .addFields(
                  { name: "누적 경고 횟수", value: `**${warningCount}회**`, inline: true },
                  { name: "제재 유형", value: `**${actionName}${durationText}**`, inline: true }
                )
                .setColor(SUCCESS_COLOR)
                .setTimestamp();

              return interaction.reply({ embeds: [embed] });
            }
          );
        } else if (subcommand === '삭제') {
          const warningCount = interaction.options.getInteger('누적횟수');

          db.run(
            "DELETE FROM server_warning_sanctions WHERE guild_id = ? AND warning_count = ?",
            [guildId, warningCount],
            function(err) {
              if (err) {
                console.error(err);
                return interaction.reply({ content: "❌ 제재 설정을 삭제하는 도중 오류가 발생했습니다.", ephemeral: true });
              }

              if (this.changes === 0) {
                return interaction.reply({ content: `❌ 누적 경고 **${warningCount}회**에 대한 제재 설정이 존재하지 않습니다.`, ephemeral: true });
              }

              const embed = new EmbedBuilder()
                .setTitle("🗑️ 경고 자동 제재 삭제 완료")
                .setDescription(`누적 경고 **${warningCount}회** 도달 시 적용되던 자동 제재 설정이 삭제되었습니다.`)
                .setColor(SUCCESS_COLOR)
                .setTimestamp();

              return interaction.reply({ embeds: [embed] });
            }
          );
        } else if (subcommand === '목록') {
          db.all(
            "SELECT warning_count, action_type, duration_value FROM server_warning_sanctions WHERE guild_id = ? ORDER BY warning_count ASC",
            [guildId],
            (err, rows) => {
              if (err) {
                console.error(err);
                return interaction.reply({ content: "❌ 제재 목록을 조회하는 도중 오류가 발생했습니다.", ephemeral: true });
              }

              const embed = new EmbedBuilder()
                .setTitle("📋 누적 경고 자동 제재 목록")
                .setColor(MAIN_COLOR)
                .setTimestamp();

              if (!rows || rows.length === 0) {
                embed.setDescription("설정된 자동 제재 조치가 없습니다. `/경고제재 설정` 명령어로 첫 번째 규칙을 만들어보세요 !");
                return interaction.reply({ embeds: [embed] });
              }

              let desc = "경고가 누적되었을 때 자동으로 실행될 조치 규칙 목록입니다:\n\n";
              rows.forEach(row => {
                let actionName = row.action_type === 'timeout' ? '타임아웃' : (row.action_type === 'kick' ? '추방' : '차단');
                let durationText = '';
                if (row.action_type === 'timeout') {
                  const val = row.duration_value;
                  if (val >= 1440 && val % 1440 === 0) {
                    durationText = ` (${val / 1440}일)`;
                  } else if (val >= 60 && val % 60 === 0) {
                    durationText = ` (${val / 60}시간)`;
                  } else {
                    durationText = ` (${val}분)`;
                  }
                }
                desc += `• 경고 **${row.warning_count}회** 누적 시 ➡️ **${actionName}${durationText}**\n`;
              });

              embed.setDescription(desc);
              return interaction.reply({ embeds: [embed] });
            }
          );
        }
      }
    },

    {
      data: new ContextMenuCommandBuilder()
        .setName('메시지 신고')
        .setType(ApplicationCommandType.Message),
      async execute(interaction) {
        const targetMessage = interaction.options.getMessage('message');
        const guild = interaction.guild;
        const user = interaction.user;

        if (!targetMessage) {
          return interaction.reply({ content: '❌ 신고 대상 메시지를 찾을 수 없습니다.', ephemeral: true });
        }

        const logChannel = await getGuildLogChannel(interaction.client, guild.id);
        if (!logChannel) {
          return interaction.reply({ 
            content: '❌ 서버에 채팅 로그(log_chat) 채널이 설정되어 있지 않아 신고를 완료할 수 없습니다. 관리자에게 문의하세요.', 
            ephemeral: true 
          });
        }

        const container = new ContainerBuilder()
          .setAccentColor(0xEF4444) // ERROR_COLOR equivalent
          .addSectionComponents(
            new SectionBuilder()
              .setThumbnailAccessory(
                new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&q=80&w=256&h=256')
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# 🚨 메시지 신고 접수\n\n` +
                  `서버 관리진에게 메시지 신고 카드가 전송되었습니다.\n\n` +
                  `• **신고자**: ${user} (ID: ${user.id})\n` +
                  `• **피신고자 (작성자)**: ${targetMessage.author} (ID: ${targetMessage.author.id})\n` +
                  `• **채널**: ${targetMessage.channel}\n\n` +
                  `### 📝 메시지 내용\n` +
                  `${targetMessage.content || '(내용 없음 / 임베드 또는 첨부파일)'}\n\n` +
                  `🔗 **메시지 링크**: [바로가기](${targetMessage.url})`
                )
              )
          );

        const { StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
        const rowButtons = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`report_delete_${targetMessage.channel.id}_${targetMessage.id}`)
            .setLabel('메시지 삭제')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('report_dismiss')
            .setLabel('무시')
            .setStyle(ButtonStyle.Success)
        );

        const timeoutSelect = new StringSelectMenuBuilder()
          .setCustomId(`report_timeout_select_${targetMessage.author.id}`)
          .setPlaceholder('⚡ 작성자 타임아웃 시간 선택...')
          .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('1분').setValue('60000').setDescription('1분간 활동 제한').setEmoji('⏱️'),
            new StringSelectMenuOptionBuilder().setLabel('5분').setValue('300000').setDescription('5분간 활동 제한').setEmoji('⏱️'),
            new StringSelectMenuOptionBuilder().setLabel('10분').setValue('600000').setDescription('10분간 활동 제한').setEmoji('⏱️'),
            new StringSelectMenuOptionBuilder().setLabel('30분').setValue('1800000').setDescription('30분간 활동 제한').setEmoji('⏱️'),
            new StringSelectMenuOptionBuilder().setLabel('1시간').setValue('3600000').setDescription('1시간 동안 활동 제한').setEmoji('⏱️'),
            new StringSelectMenuOptionBuilder().setLabel('1일').setValue('86400000').setDescription('24시간 동안 활동 제한').setEmoji('⏱️'),
            new StringSelectMenuOptionBuilder().setLabel('1주일').setValue('604800000').setDescription('7일 동안 활동 제한').setEmoji('⏱️')
          );

        const rowSelect = new ActionRowBuilder().addComponents(timeoutSelect);

        container.addActionRowComponents(rowButtons);
        container.addActionRowComponents(rowSelect);

        await logChannel.send({
          components: [container],
          flags: [MessageFlags.IsComponentsV2]
        });
        return interaction.reply({ content: '✅ 해당 메시지를 관리진에게 성공적으로 신고하였습니다.', ephemeral: true });
      }
    }
  ],

  // Binds event listeners
  listeners: {


    // Handle Report Buttons and Reaction Deletion approval clicks
    async interactionCreate(client, interaction) {
      if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
      const customId = interaction.customId;
      const guild = interaction.guild;
      const member = interaction.member;

      // Ensure clicker is moderator
      if (customId.startsWith('report_') || customId.startsWith('delapprove_')) {
        if (!(await checkAdminPermission(member))) {
          return interaction.reply({ content: '❌ 이 버튼이나 메뉴를 사용할 권한이 없습니다. (관리자 권한 필요)', ephemeral: true });
        }
      }

      if (customId.startsWith('report_delete_')) {
        const parts = customId.split('_');
        const channelId = parts[2];
        const messageId = parts[3];
        
        try {
          const channel = guild.channels.cache.get(channelId);
          if (channel) {
            const msg = await channel.messages.fetch(messageId);
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
                        `# 🚨 메시지 신고 접수 (처리 완료)\n\n` +
                        `✅ **처리 완료**: 메시지가 성공적으로 삭제되었습니다.\n\n` +
                        `• **처리자**: ${interaction.user} (${interaction.user.tag})`
                      )
                    )
                );
              
              await interaction.update({
                components: [successContainer],
                flags: [MessageFlags.IsComponentsV2]
              });
            }
          }
        } catch (e) {
          await interaction.reply({ content: `❌ 메시지 삭제 실패: ${e.message}`, ephemeral: true });
        }
      } 
      
      else if (customId.startsWith('report_timeout_select_')) {
        const targetUserId = customId.split('_')[3];
        const duration = parseInt(interaction.values[0], 10);
        const durationLabels = {
          60000: '1분',
          300000: '5분',
          600000: '10분',
          1800000: '30분',
          3600000: '1시간',
          86400000: '1일',
          604800000: '1주일'
        };
        const durationLabel = durationLabels[duration] || `${duration / 1000}초`;
        
        try {
          const targetMember = await guild.members.fetch(targetUserId);
          if (targetMember && targetMember.moderatable) {
            await targetMember.timeout(duration, `신고 누적으로 인한 ${durationLabel} 타임아웃 (집행자: ${interaction.user.tag})`);
            
            const successContainer = new ContainerBuilder()
              .setAccentColor(0x10B981) // SUCCESS_COLOR equivalent
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005198143-e5283b519a7f?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# 🚨 메시지 신고 접수 (처리 완료)\n\n` +
                      `✅ **처리 완료**: 피신고자가 **${durationLabel}** 동안 타임아웃 처리되었습니다.\n\n` +
                      `• **처리자**: ${interaction.user} (${interaction.user.tag})`
                    )
                  )
              );
            
            await interaction.update({
              components: [successContainer],
              flags: [MessageFlags.IsComponentsV2]
            });
          } else {
            await interaction.reply({ content: '❌ 해당 유저를 타임아웃할 수 없거나 서버에 권한이 부족합니다.', ephemeral: true });
          }
        } catch (e) {
          await interaction.reply({ content: `❌ 타임아웃 실패: ${e.message}`, ephemeral: true });
        }
      } 
      
      else if (customId === 'report_dismiss') {
        const successContainer = new ContainerBuilder()
          .setAccentColor(0x3B82F6) // MAIN_COLOR equivalent
          .addSectionComponents(
            new SectionBuilder()
              .setThumbnailAccessory(
                new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# 🚨 메시지 신고 접수 (처리 완료)\n\n` +
                  `ℹ️ **종료**: 관리진에 의해 이 신고는 무시되었습니다.\n\n` +
                  `• **처리자**: ${interaction.user} (${interaction.user.tag})`
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
