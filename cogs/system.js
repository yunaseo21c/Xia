const {
  EmbedBuilder,
  ActivityType,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  MessageFlags,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { BOT_NAME, NEW_SERVER_LOG_CHANNEL_ID, MAIN_COLOR, ERROR_COLOR, PERMISSION_ERROR_EMBED } = require('../core/config');
const { is_registered, checkAdminPermission, serialize_channel } = require('../core/utils');

// Initialize database
const dbPath = path.join(process.cwd(), 'xiadb.db');
const db = new sqlite3.Database(dbPath);

let presenceInterval = null;

async function sendToFirstAvailableChannel(guild, payload) {
  const channels = guild.channels.cache.filter(c => c.isTextBased());
  for (const [id, channel] of channels) {
    try {
      const permissions = channel.permissionsFor(guild.members.me);
      if (permissions && permissions.has('SendMessages')) {
        await channel.send(payload);
        return true;
      }
    } catch (err) {
      // Ignore and check next channel
    }
  }
  return false;
}

module.exports = {
  name: 'System',
  listeners: {
    // Ready Event: Setup presences loop and print diagnostic info
    async ready(client) {
      console.log('-----------------------------------------------------------------------');
      console.log(`${BOT_NAME}가 시작되었습니다.`);

      const totalGuilds = client.guilds.cache.size;
      const totalUsers = client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0);

      console.log(`[!] 참가 중인 서버 : ${totalGuilds}개`);
      console.log(`[!] 서버 인원 총합 : ${totalUsers}명`);
      console.log('-----------------------------------------------------------------------');

      client.guilds.cache.forEach(guild => {
        console.log(`서버 ID: ${guild.id} / 서버 이름: ${guild.name} / 멤버 수: ${guild.memberCount}`);
      });
      console.log('-----------------------------------------------------------------------');

      // Presence loop (every 20 seconds)
      if (presenceInterval) clearInterval(presenceInterval);

      let currentLoop = 0;
      const updatePresence = () => {
        const presences = [
          `👋 안녕하세요, 저는 시아에요 ! | V1.0`,
          `✨ ${client.guilds.cache.size}개의 서버를 관리하고 있어요`
        ];
        const presence = presences[currentLoop % presences.length];
        currentLoop++;

        client.user.setActivity(presence, { type: ActivityType.Playing });
      };

      // Set immediately on startup and run loop
      updatePresence();
      presenceInterval = setInterval(updatePresence, 20000);
    },

    // New Guild Added Event
    async guildCreate(client, guild) {
      // 1. Log to centralized NEW_SERVER_LOG_CHANNEL_ID
      const channel = client.channels.cache.get(NEW_SERVER_LOG_CHANNEL_ID);
      if (channel) {
        await channel.send(`새로운 서버에 ${BOT_NAME}가 추가되었습니다. (현재 서버 수: ${client.guilds.cache.size})`).catch(console.error);
      }

      // 2. Welcome Message Discord V2 Premium Card
      const welcomeContainer = new ContainerBuilder()
        .setAccentColor(MAIN_COLOR)
        .addSectionComponents(
          new SectionBuilder()
            .setThumbnailAccessory(
              new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
            )
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `# 👋 ${BOT_NAME} 사용을 환영해요!\n\n` +
                `**${guild.name}** 서버에 시아가 추가되었습니다! ✨\n\n` +
                `### 📖 처음 사용하시나요?\n` +
                `• **명령어 탐색**: \`/도움말\`을 입력하여 다양한 기능들을 탐색해 보세요!\n` +
                `• **서비스 이용 등록**: 시아의 가상 경제 및 다양한 미니게임 서비스를 가동하기 위해 먼저 \`/가입\` 명령어를 사용해 등록해 주세요.\n` +
                `• **실시간 로그 가동**: 서버 채팅 및 음성 로깅 기능을 켜시려면 서버 관리자가 \`/동의 메시지수집\`을 완료해야 정상적으로 작동합니다.`
              )
            )
        );

      const payload = {
        components: [welcomeContainer],
        flags: [MessageFlags.IsComponentsV2]
      };

      let dmSent = false;
      try {
        const owner = await guild.fetchOwner();
        if (owner) {
          await owner.send(payload);
          dmSent = true;
        }
      } catch (dmErr) {
        console.log(`Failed to send welcome DM to owner of guild ${guild.name} (${guild.id}):`, dmErr.message);
      }

      // If DM failed or was blocked, fallback to sending in the server channel
      if (!dmSent) {
        if (guild.systemChannel) {
          await guild.systemChannel.send(payload).catch(async (chanErr) => {
            console.log(`Failed to send welcome message to system channel:`, chanErr.message);
            await sendToFirstAvailableChannel(guild, payload);
          });
        } else {
          await sendToFirstAvailableChannel(guild, payload);
        }
      }
    }
  },
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('시작하기')
        .setDescription('시아 봇을 이 서버에 맞게 단계별(소개/메시지 수집 동의/로그 채널 자동 생성)로 초기화합니다.'),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], ephemeral: true });
        }

        if (!is_registered(interaction.user.id)) {
          return interaction.reply({ content: "`/가입` 명령어 사용 후 이용 가능합니다.", ephemeral: true });
        }

        // STEP 1: Introduce Sia (시아 소개)
        const step1Container = new ContainerBuilder()
          .setAccentColor(MAIN_COLOR)
          .addSectionComponents(
            new SectionBuilder()
              .setThumbnailAccessory(
                new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# ✨ 시아 자동 설정 마법사 (1/3 단계)\n\n` +
                  `안녕하세요! **${BOT_NAME}** 초기화 및 고속 셋업 도우미입니다. 💖\n\n` +
                  `이 마법사를 사용하면 복잡한 설정 명령어 없이 단 몇 번의 클릭만으로 **메시지 수집 동의**부터 **로그 채널 카테고리 자동 생성**까지 한 번에 완료할 수 있습니다.\n\n` +
                  `• **1단계**: 시아 소개 및 온보딩 안내\n` +
                  `• **2단계**: 메시지 및 개인정보 수집 이용약관 동의\n` +
                  `• **3단계**: 최적화된 시아 시스템 전용 로그 채널 자동 생성`
                )
              )
          );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('onboard_to_step_2')
            .setLabel('다음 단계로 (약관 동의) 👉')
            .setStyle(ButtonStyle.Primary)
        );

        step1Container.addActionRowComponents(row);

        const response = await interaction.reply({
          components: [step1Container],
          flags: [MessageFlags.IsComponentsV2]
        });

        const collector = response.createMessageComponentCollector({ time: 180000 });

        collector.on('collect', async i => {
          if (i.user.id !== interaction.user.id) {
            return i.reply({ content: '설정 마법사는 명령어를 실행한 관리자만 진행할 수 있습니다.', ephemeral: true });
          }

          const loggingCog = require('./logging_cog');

          // Handling Onboarding transitions
          if (i.customId === 'onboard_to_step_2') {
            // STEP 2: Message Collection Agreement (메시지 수집 동의)
            const step2Container = new ContainerBuilder()
              .setAccentColor(MAIN_COLOR)
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1639762681485-074b7f938ba0?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# 💬 개인정보 및 메시지 수집 동의 (2/3 단계)\n\n` +
                      `시아의 실시간 채팅 로깅 기능 작동을 위해서는 메시지 수집 약관 검토 및 승인이 필요합니다.\n\n` +
                      `### 📜 수집 약관 요약:\n` +
                      `• **수집 목적**: 실시간 채팅 로그 전송, 도배 방지, 디스코드 내장 오토모드 감지 및 경고 누적 관리.\n` +
                      `• **보관 위치**: 디스코드 서버 외부에 유출되지 않고 로컬 내부 파일(\`xiadb.db\`) 내에 안전하게 보안 보관됩니다.\n` +
                      `• **철회 방법**: 언제든지 \`/동의 메시지수집\` 명령어를 통해 수집 동의를 즉시 철회하고 모든 데이터를 파기할 수 있습니다.`
                    )
                  )
              );

            const buttonsRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('onboard_agree_step_2')
                .setLabel('약관에 동의하고 계속 진행')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId('onboard_disagree_step_2')
                .setLabel('동의하지 않음')
                .setStyle(ButtonStyle.Danger)
            );

            step2Container.addActionRowComponents(buttonsRow);

            await i.update({
              components: [step2Container],
              flags: [MessageFlags.IsComponentsV2]
            });
          }

          else if (i.customId === 'onboard_agree_step_2') {
            // Write agreement to database
            const guildId = interaction.guildId.toString();
            const adminTag = interaction.user.tag;
            const now = new Date().toISOString();

            await new Promise((resolve) => {
              db.run(
                "INSERT OR REPLACE INTO server_agreements (guild_id, agreed, agreed_by, timestamp) VALUES (?, 1, ?, ?)",
                [guildId, adminTag, now],
                () => {
                  loggingCog.agreedGuilds.add(guildId);
                  resolve();
                }
              );
            });

            // STEP 2.5: Select Log Type (로그 대상 유형 선택)
            const step2_5Container = new ContainerBuilder()
              .setAccentColor(MAIN_COLOR)
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# 🗂️ 로그 전송 대상 유형 선택 (3/4 단계)\n\n` +
                      `약관 동의가 완료되었습니다! 이제 로그가 기록될 채널 방식을 선택해 주세요.\n\n` +
                      `**1. 일반 채널로 설정 (추천)**\n` +
                      `서버 내에 **8개의 독립된 채널**을 생성하여 직관적이고 분리된 관리가 가능합니다.\n\n` +
                      `**2. 스레드로 설정 (깔끔)**\n` +
                      `하나의 상위 채널 **#시아-로그-저장소** 아래에 **8개의 프라이빗 스레드**를 생성하여 서버 채널 목록을 매우 깔끔하게 유지합니다.`
                    )
                  )
              );

            const selectRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('onboard_log_type_channel')
                .setLabel('💬 일반 채널로 생성')
                .setStyle(ButtonStyle.Primary),
              new ButtonBuilder()
                .setCustomId('onboard_log_type_thread')
                .setLabel('🧵 스레드로 생성')
                .setStyle(ButtonStyle.Success)
            );

            step2_5Container.addActionRowComponents(selectRow);

            await i.update({
              components: [step2_5Container],
              flags: [MessageFlags.IsComponentsV2]
            });
          }

          else if (i.customId === 'onboard_log_type_channel') {
            const step3Container = new ContainerBuilder()
              .setAccentColor(MAIN_COLOR)
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# 🛠️ 일반 로그 채널 생성 (4/4 단계)\n\n` +
                      `이제 마지막 단계로, 시아가 서버 내에 전용 카테고리 **[시아 시스템 로그]**와 각각의 기능에 맞는 **12개의 로그 채널**을 자동으로 개설합니다.\n\n` +
                      `• 💬 \`sia-채팅-로그\` : 메시지 수정/삭제 실시간 추적\n` +
                      `• 🔊 \`sia-음성-로그\` : 음성 채널 입장/퇴장/이동 모니터링\n` +
                      `• 🚪 \`sia-입퇴장-로그\` : 멤버 서버 입장 및 퇴장 기록\n` +
                      `• 🛡️ \`sia-차단-로그\` : 멤버 서버 차단 처리 로그\n` +
                      `• 🧵 \`sia-스레드-로그\` : 스레드 생성, 삭제 및 설정 변경 감지\n` +
                      `• 📁 \`sia-채널-로그\` : 채널 생성/삭제 및 설정 변경 실시간 추적\n` +
                      `• 🔄 \`sia-업데이트-로그\` : 봇의 새로운 업데이트 공지 실시간 수신\n` +
                      `• 🎭 \`sia-반응-로그\` : 메시지 반응 추가/삭제 실시간 추적\n` +
                      `• 🏷️ \`sia-역할-로그\` : 역할 생성/삭제/변경 및 유저 역할 변경 감지\n` +
                      `• 🔇 \`sia-타임아웃-로그\` : 멤버 활동 제한(타임아웃) 및 해제 실시간 추적\n` +
                      `• ⚖️ \`sia-제재-로그\` : 유저 제재(경고, 차단, 타임아웃 등) 이력 실시간 로깅\n` +
                      `• 👤 \`sia-닉네임-로그\` : 유저 닉네임 변경 및 변경 수행자 감지`
                    )
                  )
              );

            const createRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('onboard_create_channels')
                .setLabel('⚡ 일반 채널 일괄 자동 생성 시작')
                .setStyle(ButtonStyle.Primary)
            );

            step3Container.addActionRowComponents(createRow);

            await i.update({
              components: [step3Container],
              flags: [MessageFlags.IsComponentsV2]
            });
          }

          else if (i.customId === 'onboard_log_type_thread') {
            const step3Container = new ContainerBuilder()
              .setAccentColor(MAIN_COLOR)
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# 🛠️ 로그 프라이빗 스레드 생성 (4/4 단계)\n\n` +
                      `이제 마지막 단계로, 시아가 서버 내에 통합 보관 채널 **#시아-로그-저장소**를 생성하고 그 아래에 **12개의 프라이빗 스레드**를 자동으로 개설합니다.\n\n` +
                      `• 💬 \`sia-채팅-로그\` : 메시지 수정/삭제 실시간 추적\n` +
                      `• 🔊 \`sia-음성-로그\` : 음성 채널 입장/퇴장/이동 모니터링\n` +
                      `• 🚪 \`sia-입퇴장-로그\` : 멤버 서버 입장 및 퇴장 기록\n` +
                      `• 🛡️ \`sia-차단-로그\` : 멤버 서버 차단 처리 로그\n` +
                      `• 🧵 \`sia-스레드-로그\` : 스레드 생성, 삭제 및 설정 변경 감지\n` +
                      `• 📁 \`sia-채널-로그\` : 채널 생성/삭제 및 설정 변경 실시간 추적\n` +
                      `• 🔄 \`sia-업데이트-로그\` : 봇의 새로운 업데이트 공지 실시간 수신\n` +
                      `• 🎭 \`sia-반응-로그\` : 메시지 반응 추가/삭제 실시간 추적\n` +
                      `• 🏷️ \`sia-역할-로그\` : 역할 생성/삭제/변경 및 유저 역할 변경 감지\n` +
                      `• 🔇 \`sia-타임아웃-로그\` : 멤버 활동 제한(타임아웃) 및 해제 실시간 추적\n` +
                      `• ⚖️ \`sia-제재-로그\` : 유저 제재(경고, 차단, 타임아웃 등) 이력 실시간 로깅\n` +
                      `• 👤 \`sia-닉네임-로그\` : 유저 닉네임 변경 및 변경 수행자 감지`
                    )
                  )
              );

            const createRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('onboard_create_threads')
                .setLabel('⚡ 스레드 일괄 자동 생성 시작')
                .setStyle(ButtonStyle.Success)
            );

            step3Container.addActionRowComponents(createRow);

            await i.update({
              components: [step3Container],
              flags: [MessageFlags.IsComponentsV2]
            });
          }

          else if (i.customId === 'onboard_disagree_step_2') {
            const cancelContainer = new ContainerBuilder()
              .setAccentColor(ERROR_COLOR)
              .addSectionComponents(
                new SectionBuilder()
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# ❌ 설정 마법사가 중단되었습니다.\n\n` +
                      `메시지 수집 약관에 동의하지 않으셨으므로 자동 설정이 취소되었습니다.\n` +
                      `로깅 및 오토모드 기능을 사용하시려면 나중에 다시 \`/시작하기\` 명령어로 시작해 주세요.`
                    )
                  )
              );

            await i.update({
              components: [cancelContainer],
              flags: [MessageFlags.IsComponentsV2]
            });
            collector.stop();
          }

          else if (i.customId === 'onboard_create_channels') {
            await i.deferUpdate();

            const guild = interaction.guild;

            // 1. Create Onboarding Category
            const category = await guild.channels.create({
              name: '시아 시스템 로그',
              type: ChannelType.GuildCategory,
              permissionOverwrites: [
                {
                  id: guild.roles.everyone.id,
                  deny: [PermissionFlagsBits.ViewChannel] // Private category by default
                },
                {
                  id: guild.members.me.id,
                  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels]
                }
              ]
            });

            // 2. Helper to create channels under category
            const createChan = async (name) => {
              return await guild.channels.create({
                name,
                type: ChannelType.GuildText,
                parent: category.id
              });
            };

            const chatChan = await createChan('sia-채팅-로그');
            const voiceChan = await createChan('sia-음성-로그');
            const enterExitChan = await createChan('sia-입퇴장-로그');
            const banChan = await createChan('sia-차단-로그');
            const threadChan = await createChan('sia-스레드-로그');
            const channelChan = await createChan('sia-채널-로그');
            const updateChan = await createChan('sia-업데이트-로그');
            const reactionChan = await createChan('sia-반응-로그');
            const roleChan = await createChan('sia-역할-로그');
            const timeoutChan = await createChan('sia-타임아웃-로그');
            const sanctionChan = await createChan('sia-제재-로그');
            const nicknameChan = await createChan('sia-닉네임-로그');

            // 3. Save configurations into DB
            let guildData = loggingCog.logSettingsCache.get(guild.id.toString());
            if (!guildData) {
              guildData = { channels: {}, excluded_channels: [] };
            }
            if (!guildData.channels) {
              guildData.channels = {};
            }

            guildData.channels['log_chat'] = serialize_channel(chatChan);
            guildData.channels['log_voice'] = serialize_channel(voiceChan);
            guildData.channels['log_enter_exit'] = serialize_channel(enterExitChan);
            guildData.channels['log_ban'] = serialize_channel(banChan);
            guildData.channels['log_thread'] = serialize_channel(threadChan);
            guildData.channels['log_channel'] = serialize_channel(channelChan);
            guildData.channels['log_update'] = serialize_channel(updateChan);
            guildData.channels['log_reaction'] = serialize_channel(reactionChan);
            guildData.channels['log_role'] = serialize_channel(roleChan);
            guildData.channels['log_timeout'] = serialize_channel(timeoutChan);
            guildData.channels['log_sanction'] = serialize_channel(sanctionChan);
            guildData.channels['log_nickname'] = serialize_channel(nicknameChan);

            loggingCog.saveLogSettings(guild.id, guildData);

            // STEP 4: Success Card
            const successContainer = new ContainerBuilder()
              .setAccentColor(0x10B981) // SUCCESS_COLOR equivalent
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# 👑 시아 자동 초기 설정이 완료되었습니다!\n\n` +
                      `축하합니다! **[시아 시스템 로그]** 카테고리 개설 및 **12개의 로깅 연동 채널**이 모두 성공적으로 설정되었습니다. 🎉\n\n` +
                      `### 📊 지정된 채널 목록:\n` +
                      `• 💬 채팅 로그: ${chatChan.toString()}\n` +
                      `• 🔊 음성 로그: ${voiceChan.toString()}\n` +
                      `• 🚪 입퇴장 로그: ${enterExitChan.toString()}\n` +
                      `• 🛡️ 차단 로그: ${banChan.toString()}\n` +
                      `• 🧵 스레드 로그: ${threadChan.toString()}\n` +
                      `• 📁 채널 로그: ${channelChan.toString()}\n` +
                      `• 📢 봇 업데이트 공지: ${updateChan.toString()}\n` +
                      `• 🎭 반응 로그: ${reactionChan.toString()}\n` +
                      `• 🏷️ 역할 로그: ${roleChan.toString()}\n` +
                      `• 🔇 타임아웃 로그: ${timeoutChan.toString()}\n` +
                      `• ⚖️ 제재 로그: ${sanctionChan.toString()}\n` +
                      `• 👤 닉네임 로그: ${nicknameChan.toString()}\n\n` +
                      `*보안 상 모든 로그 채널은 일반 유저가 볼 수 없도록 비공개로 생성되었습니다. 필요에 따라 관리자 역할 권한을 설정해 주세요.*`
                    )
                  )
              );

            await interaction.editReply({
              components: [successContainer],
              flags: [MessageFlags.IsComponentsV2]
            });

            collector.stop();
          }

          else if (i.customId === 'onboard_create_threads') {
            await i.deferUpdate();

            const guild = interaction.guild;

            // 1. Create Onboarding parent channel for threads
            const parentChannel = await guild.channels.create({
              name: 'sia-로그-저장소',
              type: ChannelType.GuildText,
              permissionOverwrites: [
                {
                  id: guild.roles.everyone.id,
                  deny: [PermissionFlagsBits.ViewChannel] // Private by default
                },
                {
                  id: guild.members.me.id,
                  allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ManageChannels,
                    PermissionFlagsBits.CreatePrivateThreads,
                    PermissionFlagsBits.SendMessagesInThreads
                  ]
                }
              ]
            });

            // 2. Helper to create public threads under parent channel (to display default system messages)
            const createThread = async (name) => {
              return await parentChannel.threads.create({
                name,
                type: ChannelType.GuildPublicThread,
                autoArchiveDuration: 10080, // 1 week
                reason: '시아 시스템 로그 스레드'
              });
            };

            const chatChan = await createThread('sia-채팅-로그');
            await chatChan.send({ content: `📌 **sia-채팅-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            const voiceChan = await createThread('sia-음성-로그');
            await voiceChan.send({ content: `📌 **sia-음성-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            const enterExitChan = await createThread('sia-입퇴장-로그');
            await enterExitChan.send({ content: `📌 **sia-입퇴장-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            const banChan = await createThread('sia-차단-로그');
            await banChan.send({ content: `📌 **sia-차단-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            const threadChan = await createThread('sia-스레드-로그');
            await threadChan.send({ content: `📌 **sia-스레드-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            const channelChan = await createThread('sia-채널-로그');
            await channelChan.send({ content: `📌 **sia-채널-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            const updateChan = await createThread('sia-업데이트-로그');
            await updateChan.send({ content: `📌 **sia-업데이트-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            const reactionChan = await createThread('sia-반응-로그');
            await reactionChan.send({ content: `📌 **sia-반응-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            const roleChan = await createThread('sia-역할-로그');
            await roleChan.send({ content: `📌 **sia-역할-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            const timeoutChan = await createThread('sia-타임아웃-로그');
            await timeoutChan.send({ content: `📌 **sia-타임아웃-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            const sanctionChan = await createThread('sia-제재-로그');
            await sanctionChan.send({ content: `📌 **sia-제재-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            const nicknameChan = await createThread('sia-닉네임-로그');
            await nicknameChan.send({ content: `📌 **sia-닉네임-로그** 스레드가 생성 및 활성화되었습니다.` }).catch(() => { });

            // Send a premium, highly detailed portal directory message directly to the parent channel!
            const portalEmbed = new EmbedBuilder()
              .setTitle('📁 시아 통합 로그 저장소 포털')
              .setDescription(
                `이 채널은 **${BOT_NAME}**의 모든 실시간 시스템 로그 스레드들을 한곳에 관리하는 통합 보관소입니다. 🌟\n\n` +
                `아래의 각 프라이빗 스레드 목록을 클릭하면 해당 로그 스트림으로 즉시 연결됩니다.`
              )
              .addFields(
                { name: '💬 실시간 채팅 로그', value: `• ${chatChan.toString()} (\`sia-채팅-로그\`)`, inline: true },
                { name: '🔊 실시간 음성 로그', value: `• ${voiceChan.toString()} (\`sia-음성-로그\`)`, inline: true },
                { name: '🚪 서버 입퇴장 로그', value: `• ${enterExitChan.toString()} (\`sia-입퇴장-로그\`)`, inline: true },
                { name: '🛡️ 유저 차단 로그', value: `• ${banChan.toString()} (\`sia-차단-로그\`)`, inline: true },
                { name: '🧵 시스템 스레드 로그', value: `• ${threadChan.toString()} (\`sia-스레드-로그\`)`, inline: true },
                { name: '📁 실시간 채널 로그', value: `• ${channelChan.toString()} (\`sia-채널-로그\`)`, inline: true },
                { name: '📢 봇 업데이트 공지', value: `• ${updateChan.toString()} (\`sia-업데이트-로그\`)`, inline: true },
                { name: '🎭 반응 로그', value: `• ${reactionChan.toString()} (\`sia-반응-로그\`)`, inline: true },
                { name: '🏷️ 역할 로그', value: `• ${roleChan.toString()} (\`sia-역할-로그\`)`, inline: true },
                { name: '🔇 실시간 타임아웃 로그', value: `• ${timeoutChan.toString()} (\`sia-타임아웃-로그\`)`, inline: true },
                { name: '⚖️ 실시간 제재 로그', value: `• ${sanctionChan.toString()} (\`sia-제재-로그\`)`, inline: true },
                { name: '👤 실시간 닉네임 로그', value: `• ${nicknameChan.toString()} (\`sia-닉네임-로그\`)`, inline: true }
              )
              .setColor(MAIN_COLOR)
              .setTimestamp()
              .setFooter({ text: `${guild.name} • 시아 로그 시스템` });

            await parentChannel.send({ embeds: [portalEmbed] }).catch(console.error);

            // 3. Save configurations into DB
            let guildData = loggingCog.logSettingsCache.get(guild.id.toString());
            if (!guildData) {
              guildData = { channels: {}, excluded_channels: [] };
            }
            if (!guildData.channels) {
              guildData.channels = {};
            }

            guildData.channels['log_chat'] = serialize_channel(chatChan);
            guildData.channels['log_voice'] = serialize_channel(voiceChan);
            guildData.channels['log_enter_exit'] = serialize_channel(enterExitChan);
            guildData.channels['log_ban'] = serialize_channel(banChan);
            guildData.channels['log_thread'] = serialize_channel(threadChan);
            guildData.channels['log_reaction'] = serialize_channel(reactionChan);
            guildData.channels['log_role'] = serialize_channel(roleChan);
            guildData.channels['log_timeout'] = serialize_channel(timeoutChan);
            guildData.channels['log_sanction'] = serialize_channel(sanctionChan);
            guildData.channels['log_nickname'] = serialize_channel(nicknameChan);

            loggingCog.saveLogSettings(guild.id, guildData);

            // STEP 4: Success Card
            const successContainer = new ContainerBuilder()
              .setAccentColor(0x10B981) // SUCCESS_COLOR equivalent
              .addSectionComponents(
                new SectionBuilder()
                  .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&q=80&w=256&h=256')
                  )
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      `# 👑 시아 자동 초기 설정이 완료되었습니다!\n\n` +
                      `축하합니다! **#sia-로그-저장소** 통합 보관 채널 및 **10개의 프라이빗 로깅 스레드**가 모두 성공적으로 설정되었습니다. 🎉\n\n` +
                      `### 📊 지정된 스레드 목록:\n` +
                      `• 💬 채팅 로그: ${chatChan.toString()}\n` +
                      `• 🔊 음성 로그: ${voiceChan.toString()}\n` +
                      `• 🚪 입퇴장 로그: ${enterExitChan.toString()}\n` +
                      `• 🛡️ 차단 로그: ${banChan.toString()}\n` +
                      `• 🧵 스레드 로그: ${threadChan.toString()}\n` +
                      `• 🎭 반응 로그: ${reactionChan.toString()}\n` +
                      `• 🏷️ 역할 로그: ${roleChan.toString()}\n` +
                      `• 🔇 타임아웃 로그: ${timeoutChan.toString()}\n` +
                      `• ⚖️ 제재 로그: ${sanctionChan.toString()}\n` +
                      `• 👤 닉네임 로그: ${nicknameChan.toString()}\n\n` +
                      `*보안 상 모든 로그 스레드는 일반 유저가 볼 수 없도록 비공개로 생성되었습니다. 필요에 따라 관리자 역할 권한을 설정해 주세요.*`
                    )
                  )
              );

            await interaction.editReply({
              components: [successContainer],
              flags: [MessageFlags.IsComponentsV2]
            });

            collector.stop();
          }
        });

        collector.on('end', (collected, reason) => {
          if (reason === 'time') {
            const disabledRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('onboard_timeout')
                .setLabel('설정 가능 시간 초과')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
            );
            interaction.editReply({
              components: [disabledRow],
              flags: [MessageFlags.IsComponentsV2]
            }).catch(() => null);
          }
        });
      }
    }
  ]
};
