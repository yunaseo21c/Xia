const { 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  PermissionFlagsBits,
  AttachmentBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  MessageFlags,
  ThumbnailBuilder
} = require('discord.js');
const { MAIN_COLOR, USER_DATA_FILE, PERMISSION_ERROR_EMBED } = require('../core/config');
const { load_json, save_json, checkAdminPermission } = require('../core/utils');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Setup DB and custom tables
const dbPath = path.join(process.cwd(), 'xiadb.db');
const db = new sqlite3.Database(dbPath);
db.configure("busyTimeout", 5000);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS server_custom_admins (
    guild_id TEXT,
    user_id TEXT,
    PRIMARY KEY (guild_id, user_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS server_custom_admin_roles (
    guild_id TEXT,
    role_id TEXT,
    PRIMARY KEY (guild_id, role_id)
  )`);
});

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function isBotOwner(interaction) {
  if (!interaction.client.application.owner) {
    await interaction.client.application.fetch().catch(() => null);
  }
  const owner = interaction.client.application.owner;
  if (!owner) return false;
  
  if (owner.members) {
    return owner.members.has(interaction.user.id);
  }
  return owner.id === interaction.user.id;
}

module.exports = {
  name: 'Admin',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('청소')
        .setDescription('메시지를 대량으로 삭제하고 이력을 HTML 로그 파일로 추출합니다.')
        .addIntegerOption(option => 
          option.setName('개수')
            .setDescription('삭제할 메시지 개수 (시작/끝메시지 지정 시 생략 가능)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(100)
        )
        .addStringOption(option =>
          option.setName('시작메시지')
            .setDescription('삭제를 시작할 메시지의 ID 또는 링크')
            .setRequired(false)
        )
        .addStringOption(option =>
          option.setName('끝메시지')
            .setDescription('삭제를 끝마칠 메시지의 ID 또는 링크')
            .setRequired(false)
        )
        .addUserOption(option =>
          option.setName('유저')
            .setDescription('특정 유저가 작성한 메시지만 삭제')
            .setRequired(false)
        )
        .addStringOption(option =>
          option.setName('사유')
            .setDescription('청소 처리 사유')
            .setRequired(false)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const count = interaction.options.getInteger('개수');
        const startInput = interaction.options.getString('시작메시지');
        const endInput = interaction.options.getString('끝메시지');
        const targetUser = interaction.options.getUser('유저');
        const reason = interaction.options.getString('사유') || "사유 없음";
        const channel = interaction.channel;
        function parseMessageId(str) {
          if (!str) return null;
          const linkMatch = str.match(/\/channels\/\d+\/\d+\/(\d+)/);
          if (linkMatch) return linkMatch[1];
          const idMatch = str.trim().match(/^\d{17,20}$/);
          if (idMatch) return idMatch[0];
          return null;
        }

        // Validate format of inputs before deferReply
        if (startInput && !parseMessageId(startInput)) {
          return interaction.reply({ content: "❌ **올바르지 않은 시작 메시지 형식입니다. 메시지 링크 혹은 17~20자리의 메시지 ID(숫자)를 입력해 주세요.**", ephemeral: true });
        }
        if (endInput && !parseMessageId(endInput)) {
          return interaction.reply({ content: "❌ **올바르지 않은 끝 메시지 형식입니다. 메시지 링크 혹은 17~20자리의 메시지 ID(숫자)를 입력해 주세요.**", ephemeral: true });
        }

        await interaction.deferReply();
        const reply = await interaction.fetchReply().catch(() => null);

        try {
          const startId = parseMessageId(startInput);
          const endId = parseMessageId(endInput);

          if (!count && !startId && !endId) {
            return interaction.editReply({ content: "❌ 삭제할 메시지의 개수 또는 시작/끝 메시지 범위를 설정해 주세요." });
          }

          // Fetch messages based on criteria
          let startMsg = null;
          let endMsg = null;

          if (startId) {
            startMsg = await channel.messages.fetch(startId).catch(() => null);
            if (!startMsg) return interaction.editReply({ content: "❌ **시작 메시지를 찾을 수 없습니다. 올바른 메시지 ID 또는 링크인지 확인해 주세요.**" });
          }
          if (endId) {
            endMsg = await channel.messages.fetch(endId).catch(() => null);
            if (!endMsg) return interaction.editReply({ content: "❌ **끝 메시지를 찾을 수 없습니다. 올바른 메시지 ID 또는 링크인지 확인해 주세요.**" });
          }

          // Fetch messages iteratively with highly optimized range query logic
          let fetchedMessages = [];

          if (startMsg && endMsg) {
            const newerMsg = startMsg.createdTimestamp > endMsg.createdTimestamp ? startMsg : endMsg;
            const olderMsg = startMsg.createdTimestamp > endMsg.createdTimestamp ? endMsg : startMsg;

            fetchedMessages.push(newerMsg);
            let lastId = newerMsg.id;

            for (let i = 0; i < 15; i++) {
              const batch = await channel.messages.fetch({ limit: 100, before: lastId }).catch(() => null);
              if (!batch || batch.size === 0) break;

              const batchArray = Array.from(batch.values());
              fetchedMessages.push(...batchArray);
              lastId = batchArray[batchArray.length - 1].id;

              // Stop fetching early if the oldest message in the batch is older than the older message
              if (batchArray[batchArray.length - 1].createdTimestamp < olderMsg.createdTimestamp) {
                break;
              }
            }
          } else if (startMsg) {
            // Only startMsg specified: fetch from newest down until we cross startMsg's timestamp
            let lastId = null;
            for (let i = 0; i < 15; i++) {
              const options = { limit: 100 };
              if (lastId) options.before = lastId;
              const batch = await channel.messages.fetch(options).catch(() => null);
              if (!batch || batch.size === 0) break;

              const batchArray = Array.from(batch.values());
              fetchedMessages.push(...batchArray);
              lastId = batchArray[batchArray.length - 1].id;

              if (batchArray[batchArray.length - 1].createdTimestamp < startMsg.createdTimestamp) {
                break;
              }
            }
          } else if (endMsg) {
            // Only endMsg specified: fetch starting from endMsg going backwards
            fetchedMessages.push(endMsg);
            let lastId = endMsg.id;
            for (let i = 0; i < 15; i++) {
              const batch = await channel.messages.fetch({ limit: 100, before: lastId }).catch(() => null);
              if (!batch || batch.size === 0) break;

              const batchArray = Array.from(batch.values());
              fetchedMessages.push(...batchArray);
              lastId = batchArray[batchArray.length - 1].id;
            }
          } else {
            // No range specified: standard count-based fetch from top going backwards
            let lastId = null;
            const maxCycles = Math.ceil(count / 100);
            for (let i = 0; i < maxCycles; i++) {
              const options = { limit: 100 };
              if (lastId) options.before = lastId;
              const batch = await channel.messages.fetch(options).catch(() => null);
              if (!batch || batch.size === 0) break;

              const batchArray = Array.from(batch.values());
              fetchedMessages.push(...batchArray);
              lastId = batchArray[batchArray.length - 1].id;
            }
          }

          const filtered = reply ? fetchedMessages.filter(m => m.id !== reply.id) : fetchedMessages;
          let messageArray = Array.from(filtered.values());

          // Apply range boundaries if specified
          if (startMsg && endMsg) {
            const minTime = Math.min(startMsg.createdTimestamp, endMsg.createdTimestamp);
            const maxTime = Math.max(startMsg.createdTimestamp, endMsg.createdTimestamp);
            messageArray = messageArray.filter(m => m.createdTimestamp >= minTime && m.createdTimestamp <= maxTime);
          } else if (startMsg) {
            // From startMsg's timestamp to the newest message
            messageArray = messageArray.filter(m => m.createdTimestamp >= startMsg.createdTimestamp);
          } else if (endMsg) {
            // From the oldest fetched message up to endMsg's timestamp
            messageArray = messageArray.filter(m => m.createdTimestamp <= endMsg.createdTimestamp);
          }

          // Apply user filter if specified
          if (targetUser) {
            messageArray = messageArray.filter(m => m.author?.id === targetUser.id);
          }

          // Slice to exact requested count unless range is specified
          const toDelete = (startMsg || endMsg) ? messageArray : messageArray.slice(0, count);

          if (toDelete.length === 0) {
            return interaction.editReply({ content: "❌ 입력한 조건에 부합하여 삭제할 수 있는 메시지가 없습니다." });
          }

          // Register in the active purges map to share context with the bulkDelete event logger
          const loggingCog = require('./logging_cog');
          loggingCog.activePurges.set(channel.id, {
            reason,
            executor: interaction.user,
            userFilter: targetUser
          });

          // Perform smart delete (bulk delete for < 14 days, individual delete for >= 14 days)
          const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
          const youngMessages = toDelete.filter(m => m.createdTimestamp >= fourteenDaysAgo);
          const oldMessages = toDelete.filter(m => m.createdTimestamp < fourteenDaysAgo);

          let actualDeletedCount = 0;

          if (youngMessages.length > 0) {
            const deleted = await channel.bulkDelete(youngMessages, true).catch(() => new Map());
            actualDeletedCount += deleted.size;
          }

          if (oldMessages.length > 0) {
            await Promise.all(oldMessages.map(msg => msg.delete().catch(() => null)));
            actualDeletedCount += oldMessages.length;
          }
          
          if (actualDeletedCount === 0) {
            loggingCog.activePurges.delete(channel.id);
            return interaction.editReply({ content: "❌ 삭제할 수 있는 메시지가 존재하지 않거나 오류가 발생했습니다." });
          }

          // Manually send consolidated bulk delete log
          const { Collection } = require('discord.js');
          const deletedCollection = new Collection();
          toDelete.forEach(m => deletedCollection.set(m.id, m));
          await loggingCog.logPurge(interaction.client, deletedCollection, channel, interaction.user, reason);

          // Clean up the active purges cache for this channel
          loggingCog.activePurges.delete(channel.id);

          const embed = new EmbedBuilder()
            .setDescription(`🧹 **${channel}** 채널에서 메시지 **${actualDeletedCount}개**를 성공적으로 삭제했습니다. (5초 후 자동 삭제)`)
            .setColor(MAIN_COLOR);
          
          await interaction.editReply({ embeds: [embed] });

          setTimeout(() => {
            interaction.deleteReply().catch(() => null);
          }, 5000);
        } catch (e) {
          console.error(e);
          await interaction.editReply({ content: `오류가 발생했습니다: ${e.message}` });
        }
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('가입')
        .setDescription('Team Everyways 서비스 이용약관에 동의합니다.'),
      async execute(interaction) {
        const userId = interaction.user.id.toString();
        const data = load_json(USER_DATA_FILE);

        if (userId in data) {
          const container = new ContainerBuilder()
            .setAccentColor(0x3B82F6) // MAIN_COLOR equivalent
            .addSectionComponents(
              new SectionBuilder()
                .setThumbnailAccessory(
                  new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
                )
                .addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(
                    `# <:error_404:1218502278676480010> 이미 가입됨\n\n` +
                    `이미 가입되어 있습니다.`
                  )
                )
            );
          return interaction.reply({
            components: [container],
            flags: [MessageFlags.IsComponentsV2],
            ephemeral: true
          });
        }

        const container = new ContainerBuilder()
          .setAccentColor(0x3B82F6) // MAIN_COLOR equivalent
          .addSectionComponents(
            new SectionBuilder()
              .setThumbnailAccessory(
                new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# <:setting:1218535782176784394> 이용약관 동의\n\n` +
                  `[여기](https://softgameskr.notion.site/Team-Everyways-50fb7161ac7f49f699d360bd982fa296?pvs=4)에서 이용약관을 확인하세요.\n` +
                  `미확인시 생기는 불이익은 책임지지 않습니다.`
                )
              )
          );

        const agreeBtn = new ButtonBuilder()
          .setCustomId('agree')
          .setLabel('동의')
          .setStyle(ButtonStyle.Success);

        const disagreeBtn = new ButtonBuilder()
          .setCustomId('disagree')
          .setLabel('미동의')
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(agreeBtn, disagreeBtn);
        container.addActionRowComponents(row);

        const response = await interaction.reply({ 
          components: [container],
          flags: [MessageFlags.IsComponentsV2]
        });

        // Simple button collector with 60s timeout
        const collector = response.createMessageComponentCollector({ 
          time: 60000 
        });

        collector.on('collect', async i => {
          if (i.user.id !== interaction.user.id) {
            return i.reply({ content: '이 버튼은 가입 명령어를 사용한 유저 본인만 조작할 수 있습니다.', ephemeral: true });
          }

          if (i.customId === 'agree') {
            const currentData = load_json(USER_DATA_FILE);
            currentData[userId] = "ok";
            save_json(USER_DATA_FILE, currentData);

            const agreeContainer = new ContainerBuilder()
              .setAccentColor(0x10B981) // SUCCESS_COLOR equivalent
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005198143-e5283b519a7f?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# <:information:1218535780415180950> 가입 완료\n\n` +
                      `이제 Team Everyways의 서비스를 모두 이용할 수 있습니다.`
                    )
                  )
              );

            await i.update({
              components: [agreeContainer],
              flags: [MessageFlags.IsComponentsV2]
            });
            collector.stop();
          } else if (i.customId === 'disagree') {
            const disagreeContainer = new ContainerBuilder()
              .setAccentColor(0xEF4444) // ERROR_COLOR equivalent
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005198140-d5a4bb80a1c6?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# <:error_404:1218502278676480010> 가입 불가\n\n` +
                      `동의 하셔야 사용 가능합니다.`
                    )
                  )
              );

            await i.update({
              components: [disagreeContainer],
              flags: [MessageFlags.IsComponentsV2]
            });
            collector.stop();
          }
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('관리자')
        .setDescription('봇의 관리 기능 권한을 부여할 대상 유저 또는 역할을 관리합니다.')
        .addSubcommand(sub =>
          sub.setName('추가')
            .setDescription('관리자 권한을 부여할 유저를 추가합니다.')
            .addUserOption(opt =>
              opt.setName('대상')
                .setDescription('관리자 권한을 부여할 유저')
                .setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('삭제')
            .setDescription('관리자 권한을 해제할 유저를 삭제합니다.')
            .addUserOption(opt =>
              opt.setName('대상')
                .setDescription('관리자 권한을 해제할 유저')
                .setRequired(true)
            )
        )
        .addSubcommandGroup(group =>
          group.setName('역할')
            .setDescription('관리자 권한을 부여할 역할을 관리합니다.')
            .addSubcommand(sub =>
              sub.setName('추가')
                .setDescription('관리자 권한을 부여할 역할을 추가합니다.')
                .addRoleOption(opt =>
                  opt.setName('대상')
                    .setDescription('관리자 권한을 부여할 역할')
                    .setRequired(true)
                )
            )
            .addSubcommand(sub =>
              sub.setName('삭제')
                .setDescription('관리자 권한을 해제할 역할을 삭제합니다.')
                .addRoleOption(opt =>
                  opt.setName('대상')
                    .setDescription('관리자 권한을 해제할 역할')
                    .setRequired(true)
                )
            )
        )
        .addSubcommand(sub =>
          sub.setName('목록')
            .setDescription('현재 등록된 커스텀 관리자 유저 및 역할 목록을 확인합니다.')
        ),
      async execute(interaction) {
        // Only true Administrators with server permissions can register or modify delegated admins
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const subgroup = interaction.options.getSubcommandGroup(false);
        const guildId = interaction.guild.id.toString();

        const sqlite3 = require('sqlite3').verbose();
        const dbPath = require('path').join(process.cwd(), 'xiadb.db');
        const db = new sqlite3.Database(dbPath);
        db.configure("busyTimeout", 5000);

        if (subgroup === '역할') {
          const role = interaction.options.getRole('대상');
          const roleId = role.id.toString();

          if (subcommand === '추가') {
            db.run(
              "INSERT OR IGNORE INTO server_custom_admin_roles (guild_id, role_id) VALUES (?, ?)",
              [guildId, roleId],
              async (err) => {
                db.close();
                if (err) {
                  console.error(err);
                  return interaction.reply({ content: `오류가 발생했습니다: ${err.message}`, ephemeral: true });
                }
                const embed = new EmbedBuilder()
                  .setTitle("✅ 커스텀 관리자 역할 추가 완료")
                  .setDescription(`이제 **${role.name}** 역할을 가진 멤버들은 봇의 관리 기능을 이용할 수 있습니다.`)
                  .setColor(MAIN_COLOR);
                await interaction.reply({ embeds: [embed] });
              }
            );
          } else if (subcommand === '삭제') {
            db.run(
              "DELETE FROM server_custom_admin_roles WHERE guild_id = ? AND role_id = ?",
              [guildId, roleId],
              async (err) => {
                db.close();
                if (err) {
                  console.error(err);
                  return interaction.reply({ content: `오류가 발생했습니다: ${err.message}`, ephemeral: true });
                }
                const embed = new EmbedBuilder()
                  .setTitle("✅ 커스텀 관리자 역할 삭제 완료")
                  .setDescription(`**${role.name}** 역할의 봇 관리 권한이 철회되었습니다.`)
                  .setColor(MAIN_COLOR);
                await interaction.reply({ embeds: [embed] });
              }
            );
          }
        } else {
          if (subcommand === '추가') {
            const user = interaction.options.getUser('대상');
            const userId = user.id.toString();

            db.run(
              "INSERT OR IGNORE INTO server_custom_admins (guild_id, user_id) VALUES (?, ?)",
              [guildId, userId],
              async (err) => {
                db.close();
                if (err) {
                  console.error(err);
                  return interaction.reply({ content: `오류가 발생했습니다: ${err.message}`, ephemeral: true });
                }
                const embed = new EmbedBuilder()
                  .setTitle("✅ 커스텀 관리자 추가 완료")
                  .setDescription(`이제 **${user.toString()}**님은 봇의 관리 기능을 이용할 수 있습니다.`)
                  .setColor(MAIN_COLOR);
                await interaction.reply({ embeds: [embed] });
              }
            );
          } else if (subcommand === '삭제') {
            const user = interaction.options.getUser('대상');
            const userId = user.id.toString();

            db.run(
              "DELETE FROM server_custom_admins WHERE guild_id = ? AND user_id = ?",
              [guildId, userId],
              async (err) => {
                db.close();
                if (err) {
                  console.error(err);
                  return interaction.reply({ content: `오류가 발생했습니다: ${err.message}`, ephemeral: true });
                }
                const embed = new EmbedBuilder()
                  .setTitle("✅ 커스텀 관리자 삭제 완료")
                  .setDescription(`**${user.toString()}**님의 봇 관리 권한이 철회되었습니다.`)
                  .setColor(MAIN_COLOR);
                await interaction.reply({ embeds: [embed] });
              }
            );
          } else if (subcommand === '목록') {
            db.all(
              "SELECT user_id FROM server_custom_admins WHERE guild_id = ?",
              [guildId],
              (err, userRows) => {
                if (err) {
                  db.close();
                  console.error(err);
                  return interaction.reply({ content: `오류가 발생했습니다: ${err.message}`, ephemeral: true });
                }

                db.all(
                  "SELECT role_id FROM server_custom_admin_roles WHERE guild_id = ?",
                  [guildId],
                  async (err, roleRows) => {
                    db.close();
                    if (err) {
                      console.error(err);
                      return interaction.reply({ content: `오류가 발생했습니다: ${err.message}`, ephemeral: true });
                    }

                    const userMentions = userRows.length > 0 
                      ? userRows.map(r => `<@${r.user_id}>`).join(', ') 
                      : "*등록된 개별 관리자 유저 없음*";

                    const roleMentions = roleRows.length > 0 
                      ? roleRows.map(r => `<@&${r.role_id}>`).join(', ') 
                      : "*등록된 관리자 역할 없음*";

                    const embed = new EmbedBuilder()
                      .setTitle(`🛡️ ${interaction.guild.name} 시아 커스텀 관리자 설정 현황`)
                      .addFields(
                        { name: "👤 지정된 관리 유저", value: userMentions, inline: false },
                        { name: "🏷️ 지정된 관리 역할", value: roleMentions, inline: false }
                      )
                      .setColor(MAIN_COLOR)
                      .setFooter({ text: "💡 기본 Discord Administrator 권한을 가진 유저는 상시 모든 명령어를 사용할 수 있습니다." })
                      .setTimestamp();

                    await interaction.reply({ embeds: [embed] });
                  }
                );
              }
            );
          }
        }
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('개발자전용')
        .setDescription('봇 개발자(소유자) 전용 시스템 관리 및 테스트 명령어입니다.')
        .addSubcommand(sub =>
          sub.setName('코인지급')
            .setDescription('특정 유저에게 시아코인을 지급하거나 차감합니다.')
            .addUserOption(opt =>
              opt.setName('대상')
                .setDescription('시아코인을 조정할 대상 유저')
                .setRequired(true)
            )
            .addIntegerOption(opt =>
              opt.setName('수량')
                .setDescription('조정할 코인 액수 (음수 시 차감)')
                .setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('사전검색')
            .setDescription('단어가 로컬 사전, EXTRA 풀 및 라이브 사전에 존재하는지 검사합니다.')
            .addStringOption(opt =>
              opt.setName('단어')
                .setDescription('검색 및 검증할 단어')
                .setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('세션초기화')
            .setDescription('특정 채널의 끝말잇기 세션을 강제로 삭제하여 초기화합니다.')
            .addChannelOption(opt =>
              opt.setName('채널')
                .setDescription('세션을 강제 복구할 끝말잇기 채널 (미입력 시 현재 채널)')
                .setRequired(false)
            )
        )
        .addSubcommand(sub =>
          sub.setName('서버목록')
            .setDescription('현재 봇이 서비스 중인 모든 서버의 활성 목록을 확인합니다.')
        )
        .addSubcommand(sub =>
          sub.setName('시스템상태')
            .setDescription('봇의 구동 시간, 프로세스 메모리, CPU 로드 등을 종합 진단합니다.')
        ),
      async execute(interaction) {
        // 봇 개발자(소유자) 보안 검증
        if (!(await isBotOwner(interaction))) {
          return interaction.reply({
            content: "❌ **이 명령어는 봇 개발자(소유자) 전용 명령어입니다.** 일반 서버 관리자나 사용자는 사용할 수 없습니다.",
            ephemeral: true
          });
        }

        const subcommand = interaction.options.getSubcommand();
        const guild = interaction.guild;

        if (subcommand === '코인지급') {
          const targetUser = interaction.options.getUser('대상');
          const amount = interaction.options.getInteger('수량');
          const targetUserId = targetUser.id;

          // 1. 유저 존재 확인/등록
          db.run("INSERT OR IGNORE INTO economy (user_id, money) VALUES (?, 1000)", [targetUserId], (err) => {
            if (err) {
              console.error(err);
              return interaction.reply({ content: `❌ DB 처리 중 오류가 발생했습니다: ${err.message}`, ephemeral: true });
            }

            // 2. 돈 수정
            db.run("UPDATE economy SET money = money + ? WHERE user_id = ?", [amount, targetUserId], (err) => {
              if (err) {
                console.error(err);
                return interaction.reply({ content: `❌ DB 처리 중 오류가 발생했습니다: ${err.message}`, ephemeral: true });
              }

              // 3. 갱신된 잔액 조회
              db.get("SELECT money FROM economy WHERE user_id = ?", [targetUserId], async (err, row) => {
                if (err) {
                  console.error(err);
                  return interaction.reply({ content: `❌ 잔액 조회 중 오류가 발생했습니다: ${err.message}`, ephemeral: true });
                }

                const balance = row ? row.money : 1000;
                const embed = new EmbedBuilder()
                  .setTitle("🪙 시아코인 개발자 강제 지급/차감")
                  .setDescription(`개발자 권한으로 **${targetUser.toString()}** 님의 코인을 조정했습니다.`)
                  .addFields(
                    { name: "조정 액수", value: `${amount > 0 ? '+' : ''}${amount.toLocaleString()} 시아코인`, inline: true },
                    { name: "최종 잔액", value: `**${balance.toLocaleString()}** 시아코인`, inline: true }
                  )
                  .setColor(MAIN_COLOR)
                  .setTimestamp();

                await interaction.reply({ embeds: [embed] });
              });
            });
          });
        } 
        
        else if (subcommand === '사전검색') {
          const word = interaction.options.getString('단어').trim();
          if (word.length < 2) {
            return interaction.reply({ content: "❌ 단어는 최소 2글자 이상이어야 합니다.", ephemeral: true });
          }

          await interaction.deferReply();
          
          const wordchain = require('./wordchain');
          if (!wordchain) {
            return interaction.editReply({ content: "❌ 끝말잇기 모듈을 불러올 수 없습니다." });
          }

          const firstChar = word.charAt(0);
          const inLocalDict = !!(wordchain.dictionary[firstChar] && wordchain.dictionary[firstChar].includes(word));
          const inExtraWords = !!(wordchain.EXTRA_WORDS && wordchain.EXTRA_WORDS.has(word));
          
          let liveDef = null;
          if (wordchain.fetchWordDefinition) {
            liveDef = await wordchain.fetchWordDefinition(word);
          }
          const inLiveDict = !!liveDef;

          const passed = inLocalDict || inExtraWords || inLiveDict;

          const embed = new EmbedBuilder()
            .setTitle(`📖 사전 검색 검증 - "${word}"`)
            .setDescription(`끝말잇기 검증망에 따른 해당 단어의 분석 결과입니다.`)
            .addFields(
              { name: "1. 32만 로컬 사전", value: inLocalDict ? "✅ 존재함" : "❌ 없음", inline: true },
              { name: "2. EXTRA 신조어 풀", value: inExtraWords ? "✅ 존재함" : "❌ 없음", inline: true },
              { name: "3. Daum 사전 크롤링", value: inLiveDict ? "✅ 검색됨" : "❌ 검색 안 됨", inline: true },
              { name: "최종 통과 여부", value: passed ? "🟢 **통과 가능 (유효한 단어)**" : "🔴 **탈락 (사전 누락 단어)**", inline: false }
            )
            .setColor(passed ? SUCCESS_COLOR : ERROR_COLOR)
            .setTimestamp();

          if (liveDef) {
            embed.addFields({ name: "📖 Daum 사전 뜻풀이", value: liveDef.length > 1000 ? liveDef.slice(0, 1000) + '...' : liveDef });
          }

          await interaction.editReply({ embeds: [embed] });
        } 
        
        else if (subcommand === '세션초기화') {
          const targetChannel = interaction.options.getChannel('채널') || interaction.channel;
          const wordchain = require('./wordchain');

          if (!wordchain || !wordchain.sessions) {
            return interaction.reply({ content: "❌ 끝말잇기 코그가 활성화되어 있지 않거나 세션 저장소에 접근할 수 없습니다.", ephemeral: true });
          }

          const hasSession = wordchain.sessions.has(targetChannel.id);
          if (!hasSession) {
            return interaction.reply({ content: `❌ ${targetChannel.toString()} 채널에서 진행 중인 끝말잇기 게임이 존재하지 않습니다.`, ephemeral: true });
          }

          const session = wordchain.sessions.get(targetChannel.id);
          wordchain.sessions.delete(targetChannel.id);

          if (session.messageId) {
            const oldMsg = await targetChannel.messages.fetch(session.messageId).catch(() => null);
            if (oldMsg) {
              const failEmbed = new EmbedBuilder()
                .setTitle("💥 끝말잇기 게임 강제 초기화")
                .setDescription("개발자 강제 명령으로 이 채널의 끝말잇기 게임 세션이 완전히 초기화되었습니다. 🔄")
                .setColor(ERROR_COLOR)
                .setTimestamp();
              await oldMsg.edit({ embeds: [failEmbed], components: [] }).catch(() => null);
            }
          }

          const embed = new EmbedBuilder()
            .setTitle("🔄 끝말잇기 세션 강제 초기화 완료")
            .setDescription(`**${targetChannel.toString()}** 채널의 끝말잇기 세션을 강제로 삭제했습니다.\n이 채널의 게임 흐름이 완전히 초기화되었으며, 새로운 게임을 시작할 준비가 되었습니다.`)
            .setColor(SUCCESS_COLOR)
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });
        } 
        
        else if (subcommand === '서버목록') {
          const guilds = interaction.client.guilds.cache;
          const guildList = Array.from(guilds.values());

          let description = `현재 시아가 서비스 중인 서버 목록입니다. (총 **${guildList.length}개** 서버)\n\n`;

          guildList.forEach((g, idx) => {
            description += `**${idx + 1}. ${g.name}**\n`;
            description += `  • ID: \`${g.id}\`\n`;
            description += `  • 유저 수: \`${g.memberCount.toLocaleString()}명\`\n`;
            description += `  • 소유자: <@${g.ownerId}> (ID: \`${g.ownerId}\`)\n\n`;
          });

          if (description.length > 4000) {
            description = description.slice(0, 3900) + "\n\n*(서버 목록이 너무 길어 일부 생략되었습니다)*";
          }

          const embed = new EmbedBuilder()
            .setTitle("🌐 시아 서비스 활성 서버 목록")
            .setDescription(description)
            .setColor(MAIN_COLOR)
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });
        } 
        
        else if (subcommand === '시스템상태') {
          const os = require('os');
          const uptime = process.uptime();
          const days = Math.floor(uptime / (24 * 60 * 60));
          const hours = Math.floor((uptime % (24 * 60 * 60)) / (60 * 60));
          const minutes = Math.floor((uptime % (60 * 60)) / 60);
          const seconds = Math.floor(uptime % 60);

          const uptimeStr = `${days}일 ${hours}시간 ${minutes}분 ${seconds}초`;
          const memoryUsage = process.memoryUsage();
          const heapUsedMB = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
          const heapTotalMB = (memoryUsage.heapTotal / 1024 / 1024).toFixed(2);
          const rssMB = (memoryUsage.rss / 1024 / 1024).toFixed(2);

          const systemLoad = os.loadavg().map(v => v.toFixed(2)).join(', ');
          const freeMemGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
          const totalMemGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);

          const embed = new EmbedBuilder()
            .setTitle("⚡ 시아 시스템 상태 진단")
            .setDescription("현재 봇의 호스트 환경 및 내부 프로세스 실시간 상태 정보입니다.")
            .addFields(
              { name: "⏰ 봇 가동 시간 (Uptime)", value: `\`${uptimeStr}\``, inline: false },
              { name: "🧠 프로세스 메모리", value: `• RSS: \`${rssMB} MB\`\n• Heap Used: \`${heapUsedMB} MB\` / \`${heapTotalMB} MB\``, inline: true },
              { name: "🖥️ 호스트 OS 리소스", value: `• CPU Load (1/5/15m): \`${systemLoad}\`\n• Memory: \`${freeMemGB} GB\` / \`${totalMemGB} GB\` (Free/Total)`, inline: true },
              { name: "🔌 Discord API 상태", value: `• Gateway Ping: \`${interaction.client.ws.ping}ms\`\n• 캐싱된 서버 수: \`${interaction.client.guilds.cache.size}개\`\n• 캐싱된 유저 수: \`${interaction.client.users.cache.size}명\``, inline: false }
            )
            .setColor(MAIN_COLOR)
            .setTimestamp();

          await interaction.reply({ embeds: [embed] });
        }
      }
    }
  ]
};
