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
const { checkAdminPermission, getNextWarnId, extractNaturalReason } = require('../core/utils');

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

  // Warning Sequences Table (Auto-increment sequence keeper)
  db.run(`CREATE TABLE IF NOT EXISTS warning_sequences (
    guild_id TEXT PRIMARY KEY,
    last_warn_id INTEGER
  )`);

  // Try to add the column in case the table already exists without it
  db.run(`ALTER TABLE warnings ADD COLUMN guild_warn_id INTEGER`, (err) => {
    // Ignore "duplicate column name" error
  });
  db.run(`ALTER TABLE warnings ADD COLUMN type TEXT DEFAULT 'warn'`, (err) => {
    // Ignore duplicate
  });
  db.run(`ALTER TABLE warnings ADD COLUMN duration INTEGER`, (err) => {
    // Ignore duplicate
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
        const rawReason = interaction.options.getString('사유');
        const reason = rawReason ? extractNaturalReason(rawReason, 'warn') : '사유 미지정';
        const guild = interaction.guild;
        const user = interaction.user;

        const nextWarnId = await getNextWarnId(db, guild.id).catch(err => {
          console.error(err);
          return null;
        });

        if (nextWarnId === null) {
          return interaction.reply({ content: '❌ 경고 시퀀스를 생성하는 중에 데이터베이스 오류가 발생해버렸어요...', ephemeral: true });
        }

        db.run(
          "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, timestamp, guild_warn_id, type) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [guild.id, targetUser.id, user.id, reason, new Date().toISOString(), nextWarnId, 'warn'],
          function(err) {
            if (err) {
              return interaction.reply({ content: '❌ 경고 저장 중에 오류가 발생해버렸어요... 다시 한 번 시도해볼까요?', ephemeral: true });
            }

            const guildWarnId = nextWarnId;

            db.get("SELECT COUNT(*) as count FROM warnings WHERE guild_id = ? AND user_id = ?", [guild.id, targetUser.id], async (err, row) => {
              const count = row ? row.count : 1;
                
                const embed = new EmbedBuilder()
                  .setTitle('⚠️ 유저 경고 부여')
                  .setDescription(`${targetUser} 님에게 새로운 경고를 드렸어요!`)
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

                // Send Warning Log to log_sanction channel
                try {
                  const loggingCog = require('./logging_cog');
                  loggingCog.logWarning(interaction.client, guild.id, {
                    action: 'add',
                    targetUser,
                    moderator: user,
                    count,
                    warnId: guildWarnId,
                    reason
                  });
                } catch (logErr) {
                  console.error("Failed to send warn log:", logErr);
                }

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
                            .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달해서 **${durationStr} 타임아웃** 제재를 받았어요!`)
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
                            .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달해서 **서버에서 추방**해드렸어요!`)
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
                            .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달해서 **서버에서 차단(밴)**해드렸어요!`)
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

        db.all("SELECT COALESCE(guild_warn_id, id) as guild_warn_id, reason, moderator_id, timestamp FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY COALESCE(guild_warn_id, id) DESC", [guild.id, targetUser.id], (err, rows) => {
          if (err) {
            return interaction.reply({ content: '❌ 경고를 조회하는 중에 데이터베이스 오류가 발생해버렸어요!', ephemeral: true });
          }

          const count = rows ? rows.length : 0;
          const embed = new EmbedBuilder()
            .setTitle(`🔍 ${targetUser.username} 님의 누적 경고`)
            .setDescription(`${targetUser} 님의 누적 경고 횟수는 현재 **${count}회**에요!`)
            .setColor(MAIN_COLOR)
            .setTimestamp();

          if (count > 0) {
            const list = rows.slice(0, 10).map(row => 
              `\`#${row.guild_warn_id}\` 사유: \`${row.reason}\` (처리자: <@${row.moderator_id}>, 날짜: ${new Date(row.timestamp).toLocaleDateString()})`
            ).join('\n');
            embed.addFields({ name: '최근 경고 기록 (최대 10개)', value: list });
          } else {
            embed.addFields({ name: '경고 기록', value: '정말 깨끗해요! 등록된 경고가 하나도 없어요. ✨' });
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
            return interaction.reply({ content: '❌ 경고를 초기화하는 중에 데이터베이스 오류가 발생해버렸어요!', ephemeral: true });
          }

          const embed = new EmbedBuilder()
            .setTitle('✨ 경고 초기화 완료')
            .setDescription(`${targetUser} 님의 모든 누적 경고를 전체 삭제해드렸어요!`)
            .setColor(SUCCESS_COLOR)
            .setTimestamp();

          // Send reset log to log_sanction channel
          try {
            const loggingCog = require('./logging_cog');
            loggingCog.logWarning(interaction.client, guild.id, {
              action: 'reset',
              targetUser,
              moderator: interaction.user
            });
          } catch (logErr) {
            console.error("Failed to send warn log:", logErr);
          }

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
            return interaction.reply({ content: `❌ 이 서버에서 경고 ID **#${guildWarnId}**에 해당하는 기록을 찾을 수 없어요... 다시 한 번 확인해볼까요?`, ephemeral: true });
          }

          db.run("DELETE FROM warnings WHERE guild_id = ? AND guild_warn_id = ?", [guildId, guildWarnId], async function(err) {
            if (err) {
              return interaction.reply({ content: '❌ 경고를 삭제하는 중에 오류가 발생해버렸어요!', ephemeral: true });
            }

            const targetUser = await interaction.client.users.fetch(row.user_id).catch(() => null);
            const userTag = targetUser ? `${targetUser.tag} (${targetUser.id})` : row.user_id;

            const embed = new EmbedBuilder()
              .setTitle('✨ 특정 경고 삭제 완료')
              .setDescription(`경고 ID **#${guildWarnId}**번 기록을 성공적으로 삭제(차감)해드렸어요!`)
              .addFields(
                { name: '대상 유저', value: userTag, inline: true },
                { name: '기존 경고 사유', value: row.reason, inline: true },
                { name: '기존 경고 날짜', value: new Date(row.timestamp).toLocaleDateString(), inline: true }
              )
              .setColor(SUCCESS_COLOR)
              .setTimestamp();

            // Send ID delete log to log_sanction channel
            try {
              const loggingCog = require('./logging_cog');
              db.get("SELECT COUNT(*) as count FROM warnings WHERE guild_id = ? AND user_id = ?", [guildId, row.user_id], (err, countRow) => {
                const remainingCount = countRow ? countRow.count : 0;
                loggingCog.logWarning(interaction.client, guildId, {
                  action: 'delete_id',
                  targetUser: targetUser || { id: row.user_id, tag: row.user_id, username: '외부 유저' },
                  moderator: interaction.user,
                  warnId: guildWarnId,
                  reason: '슬래시 명령어로 특정 경고 ID 삭제',
                  originalReason: row.reason || '사유 미지정',
                  originalTimestamp: row.timestamp,
                  remainingCount
                });
              });
            } catch (logErr) {
              console.error("Failed to send warn log:", logErr);
            }

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
            return interaction.reply({ content: `❌ 이 서버에서 경고 ID **#${guildWarnId}**에 해당하는 기록을 찾을 수 없어요... 다시 한 번 확인해볼까요?`, ephemeral: true });
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
        .setName('제재목록')
        .setDescription('서버 내 제재 내역 확인 또는 누적 경고 규칙을 조회합니다.')
        .addSubcommand(sub =>
          sub.setName('확인')
            .setDescription('서버 전체 제재 기록 또는 특정 유저의 제재 기록을 확인합니다.')
            .addUserOption(option => 
              option.setName('대상').setDescription('특정 유저의 제재 기록만 필터링 조회합니다.').setRequired(false)
            )
        )
        .addSubcommand(sub =>
          sub.setName('규칙')
            .setDescription('현재 설정된 누적 경고 자동 제재 규칙 목록을 확인합니다.')
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId.toString();

        if (subcommand === '확인') {
          const targetUser = interaction.options.getUser('대상');

          let query = "SELECT COALESCE(guild_warn_id, id) as guild_warn_id, user_id, moderator_id, reason, timestamp, type, duration FROM warnings WHERE guild_id = ? ORDER BY COALESCE(guild_warn_id, id) DESC";
          let params = [guildId];

          if (targetUser) {
            query = "SELECT COALESCE(guild_warn_id, id) as guild_warn_id, user_id, moderator_id, reason, timestamp, type, duration FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY COALESCE(guild_warn_id, id) DESC";
            params = [guildId, targetUser.id];
          }

          db.all(query, params, async (err, rows) => {
            if (err) {
              return interaction.reply({ content: '❌ 제재 목록을 조회하는 도중에 오류가 발생해버렸어요!', ephemeral: true });
            }

            if (!rows || rows.length === 0) {
              const emptyEmbed = new EmbedBuilder()
                .setTitle(targetUser ? `📋 ${targetUser.username} 님의 제재 기록` : '📋 서버 전체 제재 기록')
                .setDescription('아직 등록된 제재 기록이 하나도 없어요. ✨')
                .setColor(MAIN_COLOR)
                .setTimestamp();
              return interaction.reply({ embeds: [emptyEmbed] });
            }

            const totalPages = Math.ceil(rows.length / 10);
            let currentPage = 1;

            const generatePage = (page) => {
              const startIndex = (page - 1) * 10;
              const pageSanctions = rows.slice(startIndex, startIndex + 10);

              const embed = new EmbedBuilder()
                .setTitle(targetUser ? `📋 ${targetUser.username} 님의 제재 기록` : '📋 서버 전체 제재 기록')
                .setDescription(targetUser ? `${targetUser} 님의 제재 세부 기록 목록입니다.` : '이 서버에서 집행된 관리 제재 내역입니다.')
                .setColor(MAIN_COLOR)
                .setFooter({ text: `페이지 ${page} / ${totalPages} • 총 제재 수: ${rows.length}개` })
                .setTimestamp();

              pageSanctions.forEach(row => {
                const type = row.type || 'warn';
                let typeLabel = '⚠️ 경고';
                let extraText = '';
                if (type === 'ban') typeLabel = '🚫 차단';
                else if (type === 'timeout') {
                  typeLabel = '⏳ 타임아웃';
                  extraText = row.duration ? ` (${row.duration}분)` : '';
                }
                else if (type === 'kick') typeLabel = '👢 추방';
                else if (type === 'unban') typeLabel = '🔓 차단해제';
                else if (type === 'untimeout') typeLabel = '⏳ 타임해제';

                embed.addFields({
                  name: `📌 [제재 #${row.guild_warn_id}] ${typeLabel}${extraText}`,
                  value: `• **대상 유저**: <@${row.user_id}>\n• **처리 관리자**: <@${row.moderator_id}>\n• **제재 사유**: \`${row.reason}\`\n• **일시**: ${new Date(row.timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
                  inline: false
                });
              });

              const buttonRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId('sanction_list_prev')
                  .setLabel('◀️ 이전')
                  .setStyle(ButtonStyle.Secondary)
                  .setDisabled(page === 1),
                new ButtonBuilder()
                  .setCustomId('sanction_list_next')
                  .setLabel('▶️ 다음')
                  .setStyle(ButtonStyle.Secondary)
                  .setDisabled(page === totalPages)
              );

              return { embeds: [embed], components: totalPages > 1 ? [buttonRow] : [] };
            };

            const replyMessage = await interaction.reply(generatePage(currentPage));
            if (totalPages <= 1) return;

            const collector = replyMessage.createMessageComponentCollector({
              filter: (i) => i.user.id === interaction.user.id,
              time: 60000
            });

            collector.on('collect', async (i) => {
              if (i.customId === 'sanction_list_prev') {
                currentPage--;
              } else if (i.customId === 'sanction_list_next') {
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
        } else if (subcommand === '규칙') {
          db.all(
            "SELECT warning_count, action_type, duration_value FROM server_warning_sanctions WHERE guild_id = ? ORDER BY warning_count ASC",
            [guildId],
            (err, rows) => {
              if (err) {
                console.error(err);
                return interaction.reply({ content: "❌ 제재 규칙을 조회하는 도중에 오류가 발생해버렸어요!", ephemeral: true });
              }

              const embed = new EmbedBuilder()
                .setTitle("📋 누적 경고 자동 제재 규칙 목록")
                .setColor(MAIN_COLOR)
                .setTimestamp();

              if (!rows || rows.length === 0) {
                embed.setDescription("설정된 자동 제재 규칙 조치가 하나도 없어요. `/경고제재 설정` 명령어로 첫 번째 규칙을 같이 만들어볼까요?");
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
          return interaction.reply({ content: '❌ 서버에서 해당 유저분을 찾을 수 없어요... 올바른 유저를 입력해볼까요?', ephemeral: true });
        }

        if (!member.kickable) {
          return interaction.reply({ content: '❌ 봇의 권한이 부족해서 해당 유저분을 추방할 수 없어요!', ephemeral: true });
        }

        await member.kick(reason);

        // Save kick to sanctions log
        const nextId = await getNextWarnId(db, guild.id).catch(() => null);
        if (nextId) {
          db.run(
            "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, timestamp, guild_warn_id, type) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [guild.id.toString(), targetUser.id.toString(), user.id.toString(), reason, new Date().toISOString(), nextId, 'kick']
          );
        }

        const embed = new EmbedBuilder()
          .setTitle('👢 유저 추방 완료')
          .setDescription(`${targetUser.tag} 님을 서버에서 성공적으로 추방해드렸어요!`)
          .addFields(
            { name: '제재 ID', value: `\`#${nextId || '발급 실패'}\``, inline: true },
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
        const reason = interaction.options.getString('사유') || '사유 미지정';
        const guild = interaction.guild;
        const user = interaction.user;

        // Check for multiple targets separated by , / |
        const separatorRegex = /[,/|]/;
        const parts = targetInput.split(separatorRegex).map(p => p.trim()).filter(Boolean);

        if (parts.length >= 2) {
          // Multi-ban logic
          const successUsers = [];
          const failedUsers = [];

          interaction.client.banCache = interaction.client.banCache || new Map();

          // Defer reply as bulk banning can take a bit longer than 3 seconds
          await interaction.deferReply();

          for (const part of parts) {
            const idMatch = part.match(/\d{17,19}/);
            if (!idMatch) {
              failedUsers.push(`\`${part}\` (올바르지 않은 ID/멘션 포맷이에요)`);
              continue;
            }
            const targetId = idMatch[0];

            let targetMember = await guild.members.fetch(targetId).catch(() => null);
            if (targetMember && !targetMember.bannable) {
              failedUsers.push(`<@${targetId}> (봇보다 권한이 높거나 추방 불가능한 유저에요)`);
              continue;
            }

            let targetUser = targetMember ? targetMember.user : await interaction.client.users.fetch(targetId).catch(() => null);
            const userDisplay = targetUser ? `${targetUser.toString()}` : `<@${targetId}>`;

            // Cache the ban metadata
            interaction.client.banCache.set(`${guild.id}-${targetId}`, {
              reason,
              executor: `${user.toString()} (${user.tag})`
            });

            try {
              await guild.members.ban(targetId, { reason });
              successUsers.push(userDisplay);

              // Save ban record to DB
              const nextId = await getNextWarnId(db, guild.id).catch(() => null);
              if (nextId) {
                db.run(
                  "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, timestamp, guild_warn_id, type) VALUES (?, ?, ?, ?, ?, ?, ?)",
                  [guild.id.toString(), targetId.toString(), user.id.toString(), reason, new Date().toISOString(), nextId, 'ban']
                );
              }
            } catch (e) {
              if (interaction.client.banCache) {
                interaction.client.banCache.delete(`${guild.id}-${targetId}`);
              }
              console.error(e);
              failedUsers.push(`${userDisplay} (API 오류가 발생했어요)`);
            }
          }

          const embed = new EmbedBuilder()
            .setTitle("🛡️ 멤버 다인 차단 완료")
            .setColor(ERROR_COLOR)
            .setTimestamp()
            .addFields(
              { name: "집행 관리자", value: user.toString(), inline: true },
              { name: "차단 사유", value: reason, inline: true }
            );

          let desc = "";
          if (successUsers.length > 0) {
            desc += `✅ **차단 성공 (${successUsers.length}명)**\n${successUsers.join(', ')}\n\n`;
          }
          if (failedUsers.length > 0) {
            desc += `❌ **차단 실패 (${failedUsers.length}명)**\n${failedUsers.join('\n')}\n`;
          }

          embed.setDescription(desc || "조치된 대상이 아무도 없어요.");
          return interaction.editReply({ embeds: [embed] });
        } else {
          // Single ban logic
          const idMatch = targetInput.match(/\d{17,19}/);
          if (!idMatch) {
            return interaction.reply({ content: '❌ 올바른 유저 ID나 멘션을 입력해볼까요?', ephemeral: true });
          }
          const targetId = idMatch[0];

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

          let nextId = null;
          try {
            await guild.members.ban(targetId, { reason });
            // Save ban record to DB
            nextId = await getNextWarnId(db, guild.id).catch(() => null);
            if (nextId) {
              db.run(
                "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, timestamp, guild_warn_id, type) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [guild.id.toString(), targetId.toString(), user.id.toString(), reason, new Date().toISOString(), nextId, 'ban']
              );
            }
          } catch (e) {
            if (interaction.client.banCache) {
              interaction.client.banCache.delete(`${guild.id}-${targetId}`);
            }
            return interaction.reply({ content: '❌ 봇의 권한이 부족하거나 유효하지 않은 유저 ID여서 차단할 수 없어요!', ephemeral: true });
          }

          const embed = new EmbedBuilder()
            .setTitle('🚫 유저 차단 완료')
            .setDescription(`${userDisplay} 님을 서버에서 영구 차단해드렸어요!`)
            .addFields(
              { name: '제재 ID', value: `\`#${nextId || '발급 실패'}\``, inline: true },
              { name: '대상 유저', value: userTag, inline: true },
              { name: '처리 관리자', value: `${user}`, inline: true },
              { name: '사유', value: reason }
            )
            .setColor(ERROR_COLOR)
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        }
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
        const reason = interaction.options.getString('사유') || '사유 미지정';
        const guild = interaction.guild;
        const user = interaction.user;

        // Check for multiple targets separated by , / |
        const separatorRegex = /[,/|]/;
        const parts = targetInput.split(separatorRegex).map(p => p.trim()).filter(Boolean);

        if (parts.length >= 2) {
          // Multi-unban logic
          const successUsers = [];
          const failedUsers = [];

          interaction.client.unbanCache = interaction.client.unbanCache || new Map();

          // Defer reply as bulk unbanning can take a bit longer than 3 seconds
          await interaction.deferReply();

          const banList = await guild.bans.fetch().catch(() => null);

          for (const part of parts) {
            const idMatch = part.match(/\d{17,19}/);
            if (!idMatch) {
              failedUsers.push(`\`${part}\` (올바르지 않은 ID/멘션 포맷이에요)`);
              continue;
            }
            const targetId = idMatch[0];

            const isBanned = banList ? banList.has(targetId) : true;
            if (!isBanned) {
              failedUsers.push(`<@${targetId}> (차단된 상태가 아니에요)`);
              continue;
            }

            let targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
            const userDisplay = targetUser ? `${targetUser.toString()}` : `<@${targetId}>`;

            // Cache the unban metadata
            interaction.client.unbanCache.set(`${guild.id}-${targetId}`, {
              reason,
              executor: `${user.toString()} (${user.tag})`
            });

            try {
              await guild.bans.remove(targetId, reason);
              successUsers.push(userDisplay);
            } catch (e) {
              if (interaction.client.unbanCache) {
                interaction.client.unbanCache.delete(`${guild.id}-${targetId}`);
              }
              console.error(e);
              failedUsers.push(`${userDisplay} (API 오류가 발생했어요)`);
            }
          }

          const embed = new EmbedBuilder()
            .setTitle("🛡️ 멤버 다인 차단 해제 완료")
            .setColor(SUCCESS_COLOR)
            .setTimestamp()
            .addFields(
              { name: "집행 관리자", value: user.toString(), inline: true },
              { name: "해제 사유", value: reason, inline: true }
            );

          let desc = "";
          if (successUsers.length > 0) {
            desc += `✅ **차단 해제 성공 (${successUsers.length}명)**\n${successUsers.join(', ')}\n\n`;
          }
          if (failedUsers.length > 0) {
            desc += `❌ **차단 해제 실패 (${failedUsers.length}명)**\n${failedUsers.join('\n')}\n`;
          }

          embed.setDescription(desc || "조치된 대상이 아무도 없어요.");
          return interaction.editReply({ embeds: [embed] });
        } else {
          // Single unban logic
          const idMatch = targetInput.match(/\d{17,19}/);
          if (!idMatch) {
            return interaction.reply({ content: '❌ 올바른 유저 ID나 멘션을 입력해볼까요?', ephemeral: true });
          }
          const targetId = idMatch[0];

          let targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
          const userDisplay = targetUser ? `${targetUser}` : `<@${targetId}>`;
          const userTag = targetUser ? `${targetUser.tag} (${targetId})` : `외부/미캐싱 유저 (${targetId})`;

          interaction.client.unbanCache = interaction.client.unbanCache || new Map();
          interaction.client.unbanCache.set(`${guild.id}-${targetId}`, {
            reason,
            executor: `${user.toString()} (${user.tag})`
          });

          let nextId = null;
          try {
            await guild.bans.remove(targetId, reason);
            // Save unban record to DB
            nextId = await getNextWarnId(db, guild.id).catch(() => null);
            if (nextId) {
              db.run(
                "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, timestamp, guild_warn_id, type) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [guild.id.toString(), targetId.toString(), user.id.toString(), reason, new Date().toISOString(), nextId, 'unban']
              );
            }
          } catch (e) {
            if (interaction.client.unbanCache) {
              interaction.client.unbanCache.delete(`${guild.id}-${targetId}`);
            }
            return interaction.reply({ content: '❌ 차단 목록에서 해당 ID의 유저분을 찾을 수 없거나 봇의 권한이 부족해요!', ephemeral: true });
          }

          const embed = new EmbedBuilder()
            .setTitle('🔓 유저 차단 해제 완료')
            .setDescription(`${userDisplay} 님의 차단을 성공적으로 해제해드렸어요!`)
            .addFields(
              { name: '제재 ID', value: `\`#${nextId || '발급 실패'}\``, inline: true },
              { name: '대상 유저', value: userTag, inline: true },
              { name: '처리 관리자', value: `${user}`, inline: true },
              { name: '사유', value: reason }
            )
            .setColor(SUCCESS_COLOR)
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        }
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
          return interaction.reply({ content: '❌ 서버에서 해당 유저분을 찾을 수 없어요... 올바른 유저를 지정해볼까요?', ephemeral: true });
        }

        if (!member.moderatable) {
          return interaction.reply({ content: '❌ 봇의 권한이 부족해서 해당 유저분을 타임아웃할 수 없어요!', ephemeral: true });
        }

        await member.timeout(durationMinutes * 60 * 1000, reason);

        // Save timeout to sanctions log
        const nextId = await getNextWarnId(db, guild.id).catch(() => null);
        if (nextId) {
          db.run(
            "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, timestamp, guild_warn_id, type, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [guild.id.toString(), targetUser.id.toString(), user.id.toString(), reason, new Date().toISOString(), nextId, 'timeout', durationMinutes]
          );
        }

        const embed = new EmbedBuilder()
          .setTitle('⏳ 유저 타임아웃 완료')
          .setDescription(`${targetUser.tag} 님이 **${durationMinutes}분** 동안 타임아웃 제재를 받았어요!`)
          .addFields(
            { name: '제재 ID', value: `\`#${nextId || '발급 실패'}\``, inline: true },
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
              return interaction.reply({ content: "❌ 타임아웃 제재 시에는 **시간**과 **단위** 옵션을 모두 입력해주셔야 해요!", ephemeral: true });
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
                 return interaction.reply({ content: "❌ 제재 설정을 저장하는 도중에 오류가 발생해버렸어요!", ephemeral: true });
              }

              let actionName = actionType === 'timeout' ? '타임아웃' : (actionType === 'kick' ? '추방' : '차단');
              let durationText = actionType === 'timeout' ? ` (${timeVal}${unit === 'days' ? '일' : (unit === 'hours' ? '시간' : '분')})` : '';

              const embed = new EmbedBuilder()
                .setTitle("🛡️ 경고 자동 제재 설정 완료")
                .setDescription(`누적 경고 횟수에 따른 자동 제재 조치를 설정해드렸어요!`)
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
                 return interaction.reply({ content: "❌ 제재 설정을 삭제하는 도중에 오류가 발생해버렸어요!", ephemeral: true });
              }

              if (this.changes === 0) {
                 return interaction.reply({ content: `❌ 누적 경고 **${warningCount}회**에 대한 제재 설정이 존재하지 않아요... 다시 확인해볼까요?`, ephemeral: true });
              }

              const embed = new EmbedBuilder()
                .setTitle("🗑️ 경고 자동 제재 삭제 완료")
                .setDescription(`누적 경고 **${warningCount}회** 도달 시 적용되던 자동 제재 설정을 삭제해드렸어요!`)
                .setColor(SUCCESS_COLOR)
                .setTimestamp();

              return interaction.reply({ embeds: [embed] });
            }
          );
        }
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('사유수정')
        .setDescription('특정 제재 기록의 사유를 수정합니다.')
        .addIntegerOption(opt =>
          opt.setName('id')
            .setDescription('수정할 제재 기록의 고유 ID (예: 5)')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('사유')
            .setDescription('새로 등록할 제재 사유')
            .setRequired(true)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const guildId = interaction.guildId.toString();
        const guildWarnId = interaction.options.getInteger('id');
        const rawNewReason = interaction.options.getString('사유');
        const newReason = extractNaturalReason(rawNewReason, 'warn');

        db.get(
          "SELECT user_id, reason, type, timestamp FROM warnings WHERE guild_id = ? AND guild_warn_id = ?",
          [guildId, guildWarnId],
          (err, row) => {
            if (err) {
              console.error(err);
              return interaction.reply({ content: '❌ 제재 데이터를 조회하는 도중에 데이터베이스 오류가 발생해버렸어요!', ephemeral: true });
            }

            if (!row) {
              return interaction.reply({ content: `❌ 이 서버에서 제재 ID **#${guildWarnId}**에 해당하는 제재 기록을 찾을 수 없어요.`, ephemeral: true });
            }

            db.run(
              "UPDATE warnings SET reason = ? WHERE guild_id = ? AND guild_warn_id = ?",
              [newReason, guildId, guildWarnId],
              function(err) {
                if (err) {
                  console.error(err);
                  return interaction.reply({ content: '❌ 제재 사유를 수정하는 도중에 오류가 발생해버렸어요!', ephemeral: true });
                }

                const type = row.type || 'warn';
                let typeLabel = '⚠️ 경고';
                if (type === 'ban') typeLabel = '🚫 차단';
                else if (type === 'timeout') typeLabel = '⏳ 타임아웃';
                else if (type === 'kick') typeLabel = '👢 추방';
                else if (type === 'unban') typeLabel = '🔓 차단해제';
                else if (type === 'untimeout') typeLabel = '⏳ 타임해제';

                const embed = new EmbedBuilder()
                  .setTitle('📝 제재 사유 수정 완료')
                  .setDescription(`제재 ID **#${guildWarnId}**의 사유를 성공적으로 수정해드렸어요!`)
                  .addFields(
                    { name: '대상 유저', value: `<@${row.user_id}>`, inline: true },
                    { name: '제재 유형', value: `**${typeLabel}**`, inline: true },
                    { name: '기존 사유', value: `\`${row.reason || '사유 미지정'}\``, inline: false },
                    { name: '변경된 사유', value: `**\`${newReason}\`**`, inline: false }
                  )
                  .setColor(SUCCESS_COLOR)
                  .setTimestamp();

                // Send edit log to log_sanction channel
                interaction.client.users.fetch(row.user_id)
                  .then(targetUser => {
                    try {
                      const loggingCog = require('./logging_cog');
                      loggingCog.logWarning(interaction.client, guildId, {
                        action: 'edit_reason',
                        targetUser,
                        moderator: interaction.user,
                        warnId: guildWarnId,
                        typeLabel,
                        oldReason: row.reason,
                        reason: newReason
                      });
                    } catch (logErr) {
                      console.error("Failed to send warn edit log:", logErr);
                    }
                  })
                  .catch(fetchErr => {
                    console.error("Failed to fetch user for sanction edit logging:", fetchErr);
                    try {
                      const loggingCog = require('./logging_cog');
                      loggingCog.logWarning(interaction.client, guildId, {
                        action: 'edit_reason',
                        targetUser: { id: row.user_id, tag: `알 수 없는 유저 (${row.user_id})`, username: `알 수 없는 유저` },
                        moderator: interaction.user,
                        warnId: guildWarnId,
                        typeLabel,
                        oldReason: row.reason,
                        reason: newReason
                      });
                    } catch (logErr) {
                      console.error("Failed to send fallback warn edit log:", logErr);
                    }
                  });

                return interaction.reply({ embeds: [embed] });
              }
            );
          }
        );
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
          return interaction.reply({ content: '❌ 신고 대상 메시지를 찾을 수 없어요!', ephemeral: true });
        }

        const logChannel = await getGuildLogChannel(interaction.client, guild.id);
        if (!logChannel) {
          return interaction.reply({ 
            content: '❌ 서버에 채팅 로그(log_chat) 채널이 설정되어 있지 않아 신고를 완료할 수 없어요! 관리자님께 문의해볼까요?', 
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
        return interaction.reply({ content: '✅ 해당 메시지를 관리진분들께 성공적으로 신고해드렸어요!', ephemeral: true });
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
          return interaction.reply({ content: '❌ 이 버튼이나 메뉴를 사용할 권한이 없어요! 관리자 권한이 필요해요.', ephemeral: true });
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
          await interaction.reply({ content: `❌ 메시지를 삭제하지 못했어요: ${e.message}`, ephemeral: true });
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
            await interaction.reply({ content: '❌ 해당 유저분을 타임아웃할 수 없거나 봇의 권한이 부족해요!', ephemeral: true });
          }
        } catch (e) {
          await interaction.reply({ content: `❌ 타임아웃 처리를 실패해버렸어요: ${e.message}`, ephemeral: true });
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
