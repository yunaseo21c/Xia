const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { MAIN_COLOR, SUCCESS_COLOR, ERROR_COLOR, PERMISSION_ERROR_EMBED } = require('../core/config');
const { checkAdminPermission } = require('../core/utils');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Initialize database
const dbPath = path.join(process.cwd(), 'xiadb.db');
const db = new sqlite3.Database(dbPath);
db.configure("busyTimeout", 5000);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS server_lockdown (
    guild_id TEXT,
    channel_id TEXT PRIMARY KEY,
    overwrites TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS server_default_roles (
    guild_id TEXT PRIMARY KEY,
    role_id TEXT,
    enabled INTEGER DEFAULT 1
  )`);
  db.run("ALTER TABLE server_default_roles ADD COLUMN enabled INTEGER DEFAULT 1", () => {});
  db.run(`CREATE TABLE IF NOT EXISTS server_join_auto_roles (
    guild_id TEXT PRIMARY KEY,
    role_id TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS server_emergency_security (
    guild_id TEXT PRIMARY KEY,
    invite_block_until TEXT,
    dm_block_until TEXT
  )`);
});

// Helper function to check role permissions & hierarchy
function getRolePermissionWarning(guild, role) {
  const me = guild.members.me;
  if (!me) return "";
  
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return "\n\n⚠️ **주의:** 현재 시아 봇에게 **'역할 관리(Manage Roles)'** 권한이 없습니다! 이 권한이 부여되기 전까지는 실제로 유저가 들어와도 역할을 자동으로 넣어줄 수 없습니다.";
  }
  
  if (role.position >= me.roles.highest.position) {
    return `\n\n⚠️ **주의:** 설정하신 **${role.name}** 역할의 서열이 봇의 최고 역할(**${me.roles.highest.name}**)보다 같거나 높습니다!\nDiscord 권한 규칙 상, 봇은 자신보다 높은 서열의 역할을 유저에게 부여할 수 없습니다. **서버 설정 -> 역할**에서 **'시아'** 역할의 위치를 마우스로 드래그하여 **${role.name}** 역할보다 위로 배치해주세요.`;
  }
  
  return "";
}

// In-memory store for censorship log channels (guildId -> channelId)

module.exports = {
  name: 'Security',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('기본역할')
        .setDescription('서버 일반 유저들이 공통적으로 가지고 있는 기본 역할을 지정합니다.')
        .addSubcommand(subcommand =>
          subcommand.setName('설정')
            .setDescription('일반 유저 공통 기본 역할을 설정합니다.')
            .addRoleOption(option => option.setName('역할').setDescription('지정할 기본 역할').setRequired(true))
        )
        .addSubcommand(subcommand =>
          subcommand.setName('적용')
            .setDescription('기본 역할을 신규 입장 멤버에게 자동으로 부여할지 여부를 설정합니다.')
            .addBooleanOption(option =>
              option.setName('여부')
                .setDescription('참(자동 부여함) 또는 거짓(자동 부여하지 않음)')
                .setRequired(true)
            )
        )
        .addSubcommand(subcommand =>
          subcommand.setName('삭제')
            .setDescription('설정된 일반 유저 공통 기본 역할을 삭제합니다.')
        )
        .addSubcommand(subcommand =>
          subcommand.setName('조회')
            .setDescription('현재 설정된 일반 유저 공통 기본 역할을 확인합니다.')
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId.toString();

        if (subcommand === '설정') {
          const role = interaction.options.getRole('역할');
          const warningMsg = getRolePermissionWarning(interaction.guild, role);
          db.get("SELECT enabled FROM server_default_roles WHERE guild_id = ?", [guildId], async (err, row) => {
            const enabledVal = (row && row.enabled !== undefined && row.enabled !== null) ? row.enabled : 1;
            await new Promise((resolve) => {
              db.run(
                "INSERT OR REPLACE INTO server_default_roles (guild_id, role_id, enabled) VALUES (?, ?, ?)",
                [guildId, role.id, enabledVal],
                () => resolve()
              );
            });
            return interaction.reply(`서버 일반 유저들의 기본 역할이 **${role.name}**(으)로 설정되었습니다.${warningMsg}`);
          });
        } 
        
        else if (subcommand === '적용') {
          const enabledOpt = interaction.options.getBoolean('여부');
          const enabledVal = enabledOpt ? 1 : 0;

          db.get("SELECT role_id FROM server_default_roles WHERE guild_id = ?", [guildId], (err, row) => {
            if (!row || !row.role_id) {
              return interaction.reply({ content: "❌ **설정된 기본 역할이 없습니다. 먼저 \`/기본역할 설정\` 명령어로 역할을 지정해 주세요.**", ephemeral: true });
            }

            db.run(
              "UPDATE server_default_roles SET enabled = ? WHERE guild_id = ?",
              [enabledVal, guildId],
              () => {
                const statusStr = enabledOpt ? "활성화(참)" : "비활성화(거짓)";
                const descriptionStr = enabledOpt 
                  ? "이제 신규 멤버가 서버에 입장할 때 이 기본 역할이 자동으로 부여됩니다."
                  : "기본 역할 정보는 유지되지만, 신규 멤버가 입장할 때 자동으로 부여되지 않습니다.";
                return interaction.reply(`기본 역할 자동 부여 기능이 **${statusStr}** 되었습니다. ${descriptionStr}`);
              }
            );
          });
        }

        else if (subcommand === '삭제') {
          await new Promise((resolve) => {
            db.run(
              "DELETE FROM server_default_roles WHERE guild_id = ?",
              [guildId],
              () => resolve()
            );
          });
          return interaction.reply(`서버 일반 유저 기본 역할 설정이 삭제되었습니다.`);
        } 
        
        else if (subcommand === '조회') {
          db.get("SELECT role_id, enabled FROM server_default_roles WHERE guild_id = ?", [guildId], (err, row) => {
            if (row && row.role_id) {
              const role = interaction.guild.roles.cache.get(row.role_id);
              if (role) {
                const isEnabled = (row.enabled === undefined || row.enabled === null || row.enabled === 1);
                const enabledStr = isEnabled ? "활성화 (참)" : "비활성화 (거짓)";
                return interaction.reply(`현재 설정된 일반 유저 기본 역할은 **${role.name}** (${role.id}) 이며,\n신규 멤버 자동 부여 여부는 **${enabledStr}** 상태입니다.`);
              }
            }
            return interaction.reply(`현재 설정된 기본 역할이 없습니다. \`/기본역할 설정\`으로 등록할 수 있습니다.`);
          });
        }
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('입장자동역할')
        .setDescription('신규 입장 멤버에게 자동으로 부여할 기본 역할을 지정합니다.')
        .addSubcommand(subcommand =>
          subcommand.setName('설정')
            .setDescription('입장 시 자동 부여할 역할을 설정합니다.')
            .addRoleOption(option => option.setName('역할').setDescription('자동 부여할 역할').setRequired(true))
        )
        .addSubcommand(subcommand =>
          subcommand.setName('삭제')
            .setDescription('입장 시 자동 역할 부여 설정을 삭제합니다.')
        )
        .addSubcommand(subcommand =>
          subcommand.setName('조회')
            .setDescription('현재 설정된 입장 시 자동 부여 역할을 확인합니다.')
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId.toString();

        if (subcommand === '설정') {
          const role = interaction.options.getRole('역할');
          const warningMsg = getRolePermissionWarning(interaction.guild, role);
          await new Promise((resolve) => {
            db.run(
              "INSERT OR REPLACE INTO server_join_auto_roles (guild_id, role_id) VALUES (?, ?)",
              [guildId, role.id],
              () => resolve()
            );
          });
          return interaction.reply(`입장 시 자동으로 부여할 역할이 **${role.name}**(으)로 설정되었습니다.${warningMsg}`);
        } 
        
        else if (subcommand === '삭제') {
          await new Promise((resolve) => {
            db.run(
              "DELETE FROM server_join_auto_roles WHERE guild_id = ?",
              [guildId],
              () => resolve()
            );
          });
          return interaction.reply(`입장 시 자동 역할 부여 설정이 삭제되었습니다.`);
        } 
        
        else if (subcommand === '조회') {
          db.get("SELECT role_id FROM server_join_auto_roles WHERE guild_id = ?", [guildId], (err, row) => {
            if (row && row.role_id) {
              const role = interaction.guild.roles.cache.get(row.role_id);
              if (role) {
                return interaction.reply(`현재 설정된 입장 시 자동 부여 역할은 **${role.name}** (${role.id}) 입니다.`);
              }
            }
            return interaction.reply(`현재 설정된 입장 시 자동 부여 역할이 없습니다. \`/입장자동역할 설정\`으로 등록할 수 있습니다.`);
          });
        }
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('잠금')
        .setDescription('현재 채널을 잠가 일반 유저들이 메시지를 보낼 수 없게 제한합니다.')
        .addStringOption(option =>
          option.setName('유형')
            .setDescription('보임 (채널 조회 가능하나 채팅 불가) / 안보임 (채널 조회 자체 불가)')
            .setRequired(true)
            .addChoices(
              { name: '유저들에게 보임 (Visible Lock)', value: 'visible' },
              { name: '유저들에게 안보임 (Hidden Lock)', value: 'hidden' }
            )
        )
        .addStringOption(option =>
          option.setName('이유')
            .setDescription('잠금 처리 사유')
            .setRequired(false)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }
        
        const type = interaction.options.getString('유형');
        const reason = interaction.options.getString('이유') || "사유 없음";
        const channel = interaction.channel;
        const guild = interaction.guild;
        
        await interaction.deferReply();

        try {
          // 1. Take a snapshot of original permission overwrites
          const backupArray = channel.permissionOverwrites.cache.map(o => ({
            id: o.id,
            type: o.type,
            allow: o.allow.bitfield.toString(),
            deny: o.deny.bitfield.toString()
          }));

          await new Promise((resolve) => {
            db.run(
              "INSERT OR REPLACE INTO server_lockdown (guild_id, channel_id, overwrites) VALUES (?, ?, ?)",
              [guild.id, channel.id, JSON.stringify(backupArray)],
              () => resolve()
            );
          });

          // 2. Perform lock permission changes for @everyone and custom default role if registered
          const everyoneId = guild.roles.everyone.id;
          const rolesToLock = [everyoneId];

          const defaultRoleRow = await new Promise((resolve) => {
            db.get("SELECT role_id FROM server_default_roles WHERE guild_id = ?", [guild.id], (err, row) => resolve(row));
          });
          if (defaultRoleRow?.role_id) {
            rolesToLock.push(defaultRoleRow.role_id);
          }

          for (const roleId of rolesToLock) {
            if (type === 'visible') {
              await channel.permissionOverwrites.edit(roleId, {
                ViewChannel: true,
                SendMessages: false,
                AddReactions: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
                SendMessagesInThreads: false
              });
            } else {
              await channel.permissionOverwrites.edit(roleId, {
                ViewChannel: false,
                SendMessages: false,
                AddReactions: false
              });
            }
          }

          const embed = new EmbedBuilder()
            .setTitle(type === 'visible' ? '🔒 채널 잠금 설정 (Visible)' : '🔇 채널 완전 잠금 설정 (Hidden)')
            .setDescription(`이 채널이 비상 격리 잠금 처리되었습니다. 관리자 외에는 채팅 발송이 금지됩니다.`)
            .addFields(
              { name: "잠금 유형", value: type === 'visible' ? "유저들에게 노출됨 (채팅만 금지)" : "유저들에게 숨김 (조회/채팅 금지)", inline: true },
              { name: "잠금 사유", value: reason, inline: true }
            )
            .setColor(0xEF4444)
            .setTimestamp();

          return interaction.editReply({ embeds: [embed] });
        } catch (e) {
          console.error(e);
          return interaction.editReply(`잠금 설정 도중 오류가 발생했습니다: ${e.message}`);
        }
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('잠금해제')
        .setDescription('잠긴 현재 채널을 원래의 역할별 권한 세팅으로 복구합니다.'),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const channel = interaction.channel;
        await interaction.deferReply();

        try {
          db.get("SELECT overwrites FROM server_lockdown WHERE channel_id = ?", [channel.id], async (err, row) => {
            if (err) {
              return interaction.editReply(`잠금해제 중 DB 조회 오류가 발생했습니다: ${err.message}`);
            }

            if (!row || !row.overwrites) {
              return interaction.editReply(`❌ 이 채널의 원본 권한 스냅샷 정보가 없습니다. (이미 잠금해제 상태이거나 시아를 통해 잠금되지 않음)`);
            }

            const original = JSON.parse(row.overwrites);
            
            // Restore permission overwrites precisely
            await channel.permissionOverwrites.set(original.map(o => ({
              id: o.id,
              type: o.type,
              allow: BigInt(o.allow),
              deny: BigInt(o.deny)
            })));

            db.run("DELETE FROM server_lockdown WHERE channel_id = ?", [channel.id]);

            const embed = new EmbedBuilder()
              .setTitle('🔓 채널 잠금 해제 완료')
              .setDescription(`이 채널의 격리 조치가 안전하게 해제되었으며, 잠금 전 원래의 권한 설정으로 완벽히 복원되었습니다. ✨`)
              .setColor(0x10B981)
              .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
          });
        } catch (e) {
          console.error(e);
          return interaction.editReply(`잠금해제 처리 중 예외 오류 발생: ${e.message}`);
        }
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('슬로우모드')
        .setDescription('현재 채널의 슬로우 모드 타이머(Rate Limit)를 조작합니다.')
        .addIntegerOption(option =>
          option.setName('초')
            .setDescription('유저별 메시지 발송 딜레이 간격 (초 단위, 해제는 0)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(21600)
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const seconds = interaction.options.getInteger('초');
        const channel = interaction.channel;

        try {
          await channel.setRateLimitPerUser(seconds, `관리자 ${interaction.user.tag}의 명령어 실행`);
          
          const embed = new EmbedBuilder()
            .setTitle(seconds > 0 ? '⏱️ 슬로우 모드 적용 완료' : '✨ 슬로우 모드 해제 완료')
            .setDescription(seconds > 0 
              ? `이제 이 채널에서 유저는 메시지 한 개를 보낸 후 **${seconds}초**의 대기시간이 생깁니다.` 
              : '채널 메시지 입력 속도 제한이 모두 해제되었습니다!'
            )
            .setColor(seconds > 0 ? MAIN_COLOR : 0x10B981)
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        } catch (e) {
          console.error(e);
          return interaction.reply({ content: `설정 실패: ${e.message}`, ephemeral: true });
        }
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('긴급보안')
        .setDescription('서버 내 초대장 무단 생성 및 봇 DM 송출을 정지하여 보안 사고를 긴급 예방합니다.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand =>
          subcommand.setName('설정')
            .setDescription('긴급보안을 적용하여 초대장 및 봇 DM을 일시적으로 차단합니다.')
            .addIntegerOption(option =>
              option.setName('초대정지시간')
                .setDescription('초대 링크 생성을 정지할 시간 (단위: 분, 0은 무제한 정지안함)')
                .setRequired(true)
                .setMinValue(0)
            )
            .addIntegerOption(option =>
              option.setName('dm정지시간')
                .setDescription('봇이 서버 멤버에게 보내는 DM 알림을 차단할 시간 (단위: 분, 0은 차단안함)')
                .setRequired(true)
                .setMinValue(0)
            )
        )
        .addSubcommand(subcommand =>
          subcommand.setName('해제')
            .setDescription('설정된 긴급보안을 모두 즉시 강제 해제합니다.')
        )
        .addSubcommand(subcommand =>
          subcommand.setName('상태')
            .setDescription('현재 활성화된 긴급보안 상태 및 남은 유효 시간을 체크합니다.')
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId.toString();

        if (subcommand === '설정') {
          const inviteMinutes = interaction.options.getInteger('초대정지시간');
          const dmMinutes = interaction.options.getInteger('dm정지시간');

          const now = Date.now();
          const inviteUntil = inviteMinutes > 0 ? new Date(now + inviteMinutes * 60 * 1000).toISOString() : null;
          const dmUntil = dmMinutes > 0 ? new Date(now + dmMinutes * 60 * 1000).toISOString() : null;

          db.run(
            "INSERT OR REPLACE INTO server_emergency_security (guild_id, invite_block_until, dm_block_until) VALUES (?, ?, ?)",
            [guildId, inviteUntil, dmUntil],
            (err) => {
              if (err) {
                console.error(err);
                return interaction.reply({ content: "❌ 긴급보안을 설정하는 중에 오류가 발생해버렸어요.", ephemeral: true });
              }

              const embed = new EmbedBuilder()
                .setTitle("🚨 긴급 보안 태세 발령 완료")
                .setDescription(`현재 서버의 보안 강화를 위해 비상 조치 프로토콜을 작동했어요!`)
                .addFields(
                  { name: "🛡️ 초대 링크 생성 정지", value: inviteMinutes > 0 ? `🟢 **${inviteMinutes}분 동안** 임시 생성 차단` : "⚪ 비활성 (정지 안 함)", inline: true },
                  { name: "💬 봇 알림용 DM 정지", value: dmMinutes > 0 ? `🟢 **${dmMinutes}분 동안** 봇 DM 차단` : "⚪ 비활성 (정지 안 함)", inline: true }
                )
                .setColor(0xEF4444)
                .setTimestamp();

              return interaction.reply({ embeds: [embed] });
            }
          );
        }

        else if (subcommand === '해제') {
          db.run("DELETE FROM server_emergency_security WHERE guild_id = ?", [guildId], (err) => {
            if (err) {
              console.error(err);
              return interaction.reply({ content: "❌ 긴급보안을 해제하는 도중 오류가 발생해버렸어요.", ephemeral: true });
            }
            const embed = new EmbedBuilder()
              .setTitle("✨ 긴급 보안 태세 해제 완료")
              .setDescription("서버의 긴급보안 모드가 해제되었어요! 이제 모든 기능(초대장 생성, 봇 DM)이 평화로운 일반 모드로 원복됩니다. 🌸")
              .setColor(SUCCESS_COLOR)
              .setTimestamp();
            return interaction.reply({ embeds: [embed] });
          });
        }

        else if (subcommand === '상태') {
          db.get("SELECT invite_block_until, dm_block_until FROM server_emergency_security WHERE guild_id = ?", [guildId], (err, row) => {
            if (err) {
              console.error(err);
              return interaction.reply({ content: "❌ 상태를 조회하는 과정에서 에러가 발생했습니다.", ephemeral: true });
            }

            const now = new Date();
            let inviteStatus = "⚪ 비활성 (안전)";
            let dmStatus = "⚪ 비활성 (안전)";

            if (row) {
              if (row.invite_block_until) {
                const until = new Date(row.invite_block_until);
                if (until > now) {
                  const diff = Math.ceil((until - now) / 60000);
                  inviteStatus = `🔴 **작동 중 (남은 시간: ${diff}분)**`;
                }
              }
              if (row.dm_block_until) {
                const until = new Date(row.dm_block_until);
                if (until > now) {
                  const diff = Math.ceil((until - now) / 60000);
                  dmStatus = `🔴 **작동 중 (남은 시간: ${diff}분)**`;
                }
              }
            }

            const embed = new EmbedBuilder()
              .setTitle("🚨 현재 긴급 보안 태세 상태")
              .setDescription("현재 서버에 기동 중인 긴급 보안 작동 여부입니다.")
              .addFields(
                { name: "🛡️ 초대 링크 생성 차단", value: inviteStatus, inline: true },
                { name: "💬 봇 알림용 DM 차단", value: dmStatus, inline: true }
              )
              .setColor(MAIN_COLOR)
              .setTimestamp();

            return interaction.reply({ embeds: [embed] });
          });
        }
      }
    }
  ],
  listeners: {
    // 1. Auto Role Assignment on Join
    async guildMemberAdd(client, member) {
      if (!member.guild) return;
      const guildId = member.guild.id;

      // 1. Check join auto role (입장자동역할)
      db.get("SELECT role_id FROM server_join_auto_roles WHERE guild_id = ?", [guildId], async (err, row) => {
        if (!err && row && row.role_id) {
          let role = member.guild.roles.cache.get(row.role_id);
          if (!role) {
            role = await member.guild.roles.fetch(row.role_id).catch(() => null);
          }
          if (role) {
            try {
              await member.roles.add(role, "신입 멤버 입장 자동 역할 부여");
              
              // Log the role assignment if entry/exit logging is configured
              db.get("SELECT channels FROM log_settings WHERE guild_id = ?", [guildId], async (err2, logRow) => {
                if (!err2 && logRow && logRow.channels) {
                  try {
                    const channels = JSON.parse(logRow.channels);
                    const channelData = channels['log_enter_exit'] || channels['log_chat'];
                    if (channelData && channelData.id) {
                      let logChannel = client.channels.cache.get(channelData.id);
                      if (!logChannel) {
                        logChannel = await client.channels.fetch(channelData.id).catch(() => null);
                      }
                      if (logChannel) {
                        const embed = new EmbedBuilder()
                          .setTitle("🏷️ 신규 멤버 입장 자동 역할 부여")
                          .setDescription(`${member} (${member.user.tag}) 님에게 서버 입장 자동 부여 역할인 **${role.name}**이(가) 정상 부여되었습니다.`)
                          .setColor(MAIN_COLOR)
                          .setTimestamp();
                        await logChannel.send({ embeds: [embed] }).catch(() => null);
                      }
                    }
                  } catch (e) {}
                }
              });
            } catch (e) {
              console.error(`Failed to assign auto role to ${member.user.tag}:`, e);
              
              // Post failure warning to log channel
              db.get("SELECT channels FROM log_settings WHERE guild_id = ?", [guildId], async (err2, logRow) => {
                if (!err2 && logRow && logRow.channels) {
                  try {
                    const channels = JSON.parse(logRow.channels);
                    const channelData = channels['log_enter_exit'] || channels['log_chat'] || channels['log_update'];
                    if (channelData && channelData.id) {
                      let logChannel = client.channels.cache.get(channelData.id);
                      if (!logChannel) {
                        logChannel = await client.channels.fetch(channelData.id).catch(() => null);
                      }
                      if (logChannel) {
                        let errMsg = "알 수 없는 오류";
                        if (e.code === 50013) {
                          const me = member.guild.members.me;
                          const highestRoleName = me ? me.roles.highest.name : "봇의 역할";
                          errMsg = "❌ **Missing Permissions (권한 부족)**\n" +
                            "• 봇에게 **'역할 관리(Manage Roles)'** 권한이 없거나,\n" +
                            `• 부여하려는 역할(**${role.name}**)의 서열이 봇의 최고 역할(**${highestRoleName}**)보다 같거나 높습니다.\n` +
                            "• **해결법**: 서버 설정 -> 역할에서 **'시아'** 역할의 위치를 이 역할보다 위로 드래그해서 배치해주세요.";
                        } else {
                          errMsg = `오류 내용: ${e.message}`;
                        }
                        const embed = new EmbedBuilder()
                          .setTitle("⚠️ 자동 역할 부여 실패")
                          .setDescription(`신규 입장 멤버 ${member} (${member.user.tag}) 님에게 역할을 부여하는 도중 권한 오류가 발생하여 실패했습니다.\n\n${errMsg}`)
                          .setColor(0xEF4444)
                          .setTimestamp();
                        await logChannel.send({ embeds: [embed] }).catch(() => null);
                      }
                    }
                  } catch (errJson) {}
                }
              });
            }
          }
        }
      });

      // 2. Check default role (기본역할) and assign if enabled (enabled = 1 or undefined)
      db.get("SELECT role_id, enabled FROM server_default_roles WHERE guild_id = ?", [guildId], async (err, row) => {
        if (!err && row && row.role_id) {
          const isEnabled = (row.enabled === undefined || row.enabled === null || row.enabled === 1);
          if (isEnabled) {
            let role = member.guild.roles.cache.get(row.role_id);
            if (!role) {
              role = await member.guild.roles.fetch(row.role_id).catch(() => null);
            }
            if (role) {
              try {
                await member.roles.add(role, "신입 멤버 기본 역할 부여");
                
                // Log the role assignment if entry/exit logging is configured
                db.get("SELECT channels FROM log_settings WHERE guild_id = ?", [guildId], async (err2, logRow) => {
                  if (!err2 && logRow && logRow.channels) {
                    try {
                      const channels = JSON.parse(logRow.channels);
                      const channelData = channels['log_enter_exit'] || channels['log_chat'];
                      if (channelData && channelData.id) {
                        let logChannel = client.channels.cache.get(channelData.id);
                        if (!logChannel) {
                          logChannel = await client.channels.fetch(channelData.id).catch(() => null);
                        }
                        if (logChannel) {
                          const embed = new EmbedBuilder()
                            .setTitle("🏷️ 신규 멤버 기본 역할 부여")
                            .setDescription(`${member} (${member.user.tag}) 님에게 서버 기본 역할인 **${role.name}**이(가) 정상 부여되었습니다.`)
                            .setColor(MAIN_COLOR)
                            .setTimestamp();
                          await logChannel.send({ embeds: [embed] }).catch(() => null);
                        }
                      }
                    } catch (e) {}
                  }
                });
              } catch (e) {
                console.error(`Failed to assign default role to ${member.user.tag}:`, e);
                
                // Post failure warning to log channel
                db.get("SELECT channels FROM log_settings WHERE guild_id = ?", [guildId], async (err2, logRow) => {
                  if (!err2 && logRow && logRow.channels) {
                    try {
                      const channels = JSON.parse(logRow.channels);
                      const channelData = channels['log_enter_exit'] || channels['log_chat'] || channels['log_update'];
                      if (channelData && channelData.id) {
                        let logChannel = client.channels.cache.get(channelData.id);
                        if (!logChannel) {
                          logChannel = await client.channels.fetch(channelData.id).catch(() => null);
                        }
                        if (logChannel) {
                          let errMsg = "알 수 없는 오류";
                          if (e.code === 50013) {
                            const me = member.guild.members.me;
                            const highestRoleName = me ? me.roles.highest.name : "봇의 역할";
                            errMsg = "❌ **Missing Permissions (권한 부족)**\n" +
                              "• 봇에게 **'역할 관리(Manage Roles)'** 권한이 없거나,\n" +
                              `• 부여하려는 역할(**${role.name}**)의 서열이 봇의 최고 역할(**${highestRoleName}**)보다 같거나 높습니다.\n` +
                              "• **해결법**: 서버 설정 -> 역할에서 **'시아'** 역할의 위치를 이 역할보다 위로 드래그해서 배치해주세요.";
                          } else {
                            errMsg = `오류 내용: ${e.message}`;
                          }
                          const embed = new EmbedBuilder()
                            .setTitle("⚠️ 기본 역할 부여 실패")
                            .setDescription(`신규 입장 멤버 ${member} (${member.user.tag}) 님에게 기본 역할을 부여하는 도중 권한 오류가 발생하여 실패했습니다.\n\n${errMsg}`)
                            .setColor(0xEF4444)
                            .setTimestamp();
                          await logChannel.send({ embeds: [embed] }).catch(() => null);
                        }
                      }
                    } catch (errJson) {}
                  }
                });
              }
            }
          }
        }
      });
    },

    async messageCreate(client, message) {
      if (message.author.bot || !message.guild) return;

      // 2. Basic legacy trigger support (+)
      if (message.content === '+') {
        const embed = new EmbedBuilder()
          .setTitle("시아를 선택해주셔서 감사합니다.") // Updated from "Bot Think" to "시아"
          .setDescription("`+명령어`을 입력하여 명령어들을 알아보세요.\n아니면 `/소개`를 입력하여 봇이 개발된 주요 배경을 확인해보세요.")
          .setColor(MAIN_COLOR);
        await message.channel.send({ embeds: [embed] }).catch(console.error);
      }
      
      if (message.content === '+명령어') {
        const embed = new EmbedBuilder()
          .setTitle("<:list:1218502063152037918> 시아 명령어 리스트") // Updated
          .setDescription("시아의 슬래시 명령어를 살펴보세요 (`/도움말` 권장).")
          .setColor(MAIN_COLOR);
        await message.channel.send({ embeds: [embed] }).catch(console.error);
      }
    },

    async inviteCreate(client, invite) {
      if (!invite.guild) return;
      const guildId = invite.guild.id.toString();

      db.get("SELECT invite_block_until FROM server_emergency_security WHERE guild_id = ?", [guildId], async (err, row) => {
        if (row && row.invite_block_until) {
          const until = new Date(row.invite_block_until);
          if (until > new Date()) {
            try {
              await invite.delete("🚨 긴급 보안 태세 가동으로 인한 초대 링크 생성 차단");
              
              // Log to log_channel if setup
              db.get("SELECT channels FROM log_settings WHERE guild_id = ?", [guildId], async (errLog, logRow) => {
                if (!errLog && logRow && logRow.channels) {
                  try {
                    const channels = JSON.parse(logRow.channels);
                    // Use new log_channel or fallback to log_chat/log_update
                    const logChannelData = channels['log_channel'] || channels['log_chat'] || channels['log_update'];
                    if (logChannelData && logChannelData.id) {
                      let logChannel = client.channels.cache.get(logChannelData.id) || await client.channels.fetch(logChannelData.id).catch(() => null);
                      if (logChannel) {
                        const embed = new EmbedBuilder()
                          .setTitle("🚨 긴급 보안 통제: 초대 링크 삭제")
                          .setDescription(`서버 내에서 새로운 초대 링크가 생성되었으나, **긴급 보안 태세**가 작동 중이므로 자동 소멸 차단 처리되었어요!`)
                          .addFields(
                            { name: "초대 코드", value: `\`${invite.code}\``, inline: true },
                            { name: "생성자", value: invite.inviter ? invite.inviter.toString() : "알 수 없음", inline: true },
                            { name: "보안 상태", value: "🔴 초대 차단 작동 중", inline: true }
                          )
                          .setColor(0xEF4444)
                          .setTimestamp();
                        await logChannel.send({ embeds: [embed] }).catch(() => null);
                      }
                    }
                  } catch (eJson) {
                    console.error(eJson);
                  }
                }
              });
            } catch (delErr) {
              console.error("Failed to delete invite under emergency lockdown:", delErr);
            }
          }
        }
      });
    }
  }
};
