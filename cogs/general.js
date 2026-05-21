const { 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ActionRowBuilder, 
  StringSelectMenuBuilder, 
  StringSelectMenuOptionBuilder 
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { MAIN_COLOR, ALLOWED_USER_ID } = require('../core/config');
const { checkAdminPermission } = require('../core/utils');

// Initialize database
const dbPath = path.join(process.cwd(), 'xiadb.db');
const db = new sqlite3.Database(dbPath);
db.configure("busyTimeout", 5000);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS update_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    content TEXT,
    timestamp TEXT
  )`);
});

module.exports = {
  name: 'General',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('핑')
        .setDescription('봇의 응답시간입니다.'),
      async execute(interaction) {
        const latency = Math.round(interaction.client.ws.ping);
        const embed = new EmbedBuilder()
          .setTitle("<:information:1218535780415180950> 핑")
          .setDescription("봇의 응답시간입니다.")
          .setColor(MAIN_COLOR)
          .addFields({ name: "현재 봇 응답시간", value: `${latency}ms` });
        
        await interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('도움말')
        .setDescription('시아의 모든 슬래시 명령어 가이드라인을 확인합니다.'),
      async execute(interaction) {
        const isAdmin = await checkAdminPermission(interaction.member);

        const mainEmbed = new EmbedBuilder()
          .setTitle("📖 시아 가이드 센터")
          .setDescription(
            `안녕하세요! 서버 관리 봇 **시아(Sia)**입니다. ✨\n` +
            `아래 드롭다운 메뉴를 클릭하여 확인하고 싶은 카테고리를 선택해 주세요.\n\n` +
            `💬 카테고리를 선택하시면 **하단에 상세 명령어 가이드 임베드가 추가**됩니다!\n` +
            (isAdmin ? `🔒 **관리자 전용** 카테고리도 표시됩니다.` : `🔒 관리자 전용 카테고리는 등록된 관리자만 열람할 수 있습니다.`)
          )
          .setColor(MAIN_COLOR)
          .setThumbnail(interaction.client.user.displayAvatarURL())
          .setFooter({ text: `시아 봇 • V1.0` });

        const options = [];

        // 관리자만 볼 수 있는 카테고리들
        if (isAdmin) {
          options.push(
            new StringSelectMenuOptionBuilder()
              .setLabel('🛡️ 관리자 설정 (Admin)')
              .setValue('help_admin')
              .setDescription('시아 관리자 유저/역할 등록 및 목록 조회')
              .setEmoji('🛡️'),
            new StringSelectMenuOptionBuilder()
              .setLabel('🪵 실시간 로그 설정 (Logging)')
              .setValue('help_logging')
              .setDescription('채팅·음성·입퇴장·차단·반응·역할 로그 채널 설정')
              .setEmoji('🪵'),
            new StringSelectMenuOptionBuilder()
              .setLabel('🔒 보안 설정 (Security)')
              .setValue('help_security')
              .setDescription('기본역할·자동역할·입장자동역할·채널 잠금·슬로우모드')
              .setEmoji('🔒'),
            new StringSelectMenuOptionBuilder()
              .setLabel('🤖 자동화 설정 (Automod)')
              .setValue('help_automod')
              .setDescription('도배방지 자동 감지 설정')
              .setEmoji('🤖'),
            new StringSelectMenuOptionBuilder()
              .setLabel('⚔️ 모더레이션 (Moderation)')
              .setValue('help_moderation')
              .setDescription('청소·경고·타임아웃·추방·차단·경고제재 자동화')
              .setEmoji('⚔️'),
            new StringSelectMenuOptionBuilder()
              .setLabel('⚙️ 시작하기 및 시스템 (System)')
              .setValue('help_system')
              .setDescription('초기 설정 마법사·동의·업데이트 등록')
              .setEmoji('⚙️')
          );
        }

        // 모든 유저가 볼 수 있는 카테고리들
        options.push(
          new StringSelectMenuOptionBuilder()
            .setLabel('🎮 가상 경제 & 미니게임 (Minigames)')
            .setValue('help_economy')
            .setDescription('가입·돈·낚시·농사·도박·판매·랭킹')
            .setEmoji('🎮'),
          new StringSelectMenuOptionBuilder()
            .setLabel('🧵 끝말잇기 (Wordchain)')
            .setValue('help_thread')
            .setDescription('끝말잇기 게임 및 설정')
            .setEmoji('🧵'),
          new StringSelectMenuOptionBuilder()
            .setLabel('📢 업데이트 로그 (Updates)')
            .setValue('help_updates')
            .setDescription('시아 패치노트 및 개발 진행 상황 조회')
            .setEmoji('📢'),
          new StringSelectMenuOptionBuilder()
            .setLabel('🤖 일반 유틸리티 (General)')
            .setValue('help_general')
            .setDescription('정보·소개·서버정보·유저정보·초대·서포트서버·핑')
            .setEmoji('🌐')
        );

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('help_category_select')
          .setPlaceholder('궁금한 기능 카테고리를 선택하세요...')
          .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);
        const response = await interaction.reply({
          embeds: [mainEmbed],
          components: [row]
        });

        const collector = response.createMessageComponentCollector({
          filter: i => i.user.id === interaction.user.id,
          time: 60000
        });

        collector.on('collect', async i => {
          if (i.customId === 'help_category_select') {
            const selected = i.values[0];

            // 관리자 전용 카테고리 접근 차단
            const adminOnlyCategories = ['help_admin', 'help_logging', 'help_security', 'help_automod', 'help_moderation', 'help_system'];
            if (adminOnlyCategories.includes(selected) && !isAdmin) {
              return i.reply({ content: '🔒 이 카테고리는 **등록된 관리자**만 열람할 수 있습니다.', ephemeral: true });
            }

            const categoryEmbed = new EmbedBuilder().setColor(MAIN_COLOR).setTimestamp();

            if (selected === 'help_admin') {
              categoryEmbed
                .setTitle("🛡️ 관리자 설정 안내")
                .setDescription("시아 명령어를 사용할 수 있는 관리자 유저와 역할을 등록·삭제합니다.")
                .addFields(
                  { name: "`/관리자 추가 [유저]`", value: "특정 유저를 시아 관리자로 등록합니다." },
                  { name: "`/관리자 삭제 [유저]`", value: "등록된 관리자 유저를 해제합니다." },
                  { name: "`/관리자 역할 추가 [역할]`", value: "특정 역할을 관리자 역할로 등록합니다." },
                  { name: "`/관리자 역할 삭제 [역할]`", value: "등록된 관리자 역할을 해제합니다." },
                  { name: "`/관리자 목록`", value: "현재 등록된 관리자 유저 및 역할 목록 조회." }
                );
            } else if (selected === 'help_logging') {
              categoryEmbed
                .setTitle("🪵 실시간 로그 설정 안내")
                .setDescription("서버에서 발생하는 이벤트를 감지하여 지정 채널/스레드에 기록합니다.")
                .addFields(
                  { name: "`/로그 방식:[일반/스레드]`", value: "로그를 기록할 채널 또는 스레드를 설정합니다. (💬채팅·🔊음성·🚪입퇴장·🛡️차단·🧵스레드·🎭반응·🏷️역할 로그)" },
                  { name: "`/로그삭제`", value: "특정 로그 채널 설정을 해제합니다." },
                  { name: "`/로그조회`", value: "현재 서버에 설정된 모든 로그 채널 현황을 확인합니다." },
                  { name: "`/로그제외 추가/삭제/목록`", value: "특정 채널을 채팅 로그 수집에서 제외하거나 다시 포함합니다." },
                  { name: "`/동의 메시지수집`", value: "채팅 로그 수집을 위한 이용약관에 동의하거나 철회합니다. (관리자 필수)" }
                );
            } else if (selected === 'help_security') {
              categoryEmbed
                .setTitle("🔒 보안 설정 안내")
                .setDescription("서버 진입 시 역할 자동 부여 및 채널 잠금/슬로우모드를 설정합니다.")
                .addFields(
                  { name: "`/기본역할 설정 [역할]`", value: "서버에 이미 가입된 모든 멤버에게 부여할 기본 역할을 설정합니다." },
                  { name: "`/기본역할 적용 여부:[참/거짓]`", value: "기본 역할 자동 부여 기능을 켜거나 끕니다." },
                  { name: "`/기본역할 삭제`", value: "설정된 기본 역할을 초기화합니다." },
                  { name: "`/기본역할 조회`", value: "현재 설정된 기본 역할을 확인합니다." },
                  { name: "`/자동역할 설정/삭제/조회`", value: "서버 입장 시 자동으로 부여할 역할을 설정하거나 제거합니다." },
                  { name: "`/입장자동역할 설정/삭제/조회`", value: "봇 재시작 후 미부여된 멤버에게 역할을 소급 적용합니다." },
                  { name: "`/잠금 [유형] [이유]`", value: "채널 또는 서버 전체를 잠금 처리합니다." },
                  { name: "`/잠금해제`", value: "잠금 처리된 채널이나 서버를 해제합니다." },
                  { name: "`/슬로우모드 [초]`", value: "채널에 슬로우모드를 설정합니다. (0초 입력 시 해제)" }
                );
            } else if (selected === 'help_automod') {
              categoryEmbed
                .setTitle("🤖 자동화 설정 안내")
                .setDescription("서버 내 도배 등 규칙 위반 메시지를 자동으로 감지하여 처리합니다.")
                .addFields(
                  { name: "`/도배방지 설정 [상태]`", value: "도배 자동 감지 기능을 켜거나 끕니다." },
                  { name: "`/도배방지 상태`", value: "현재 서버의 도배방지 설정 상태를 확인합니다." }
                );
            } else if (selected === 'help_moderation') {
              categoryEmbed
                .setTitle("⚔️ 모더레이션 안내")
                .setDescription("서버 규율을 위반하는 유저를 제재하고 메시지를 일괄 삭제합니다.")
                .addFields(
                  { name: "`/청소 [개수/시작메시지/끝메시지]`", value: "채널 메시지를 일괄 삭제합니다. 메시지 수, 링크, ID로 범위 지정 가능 (최대 100개)." },
                  { name: "`/경고 [대상] [사유]`", value: "특정 유저에게 경고를 부여합니다." },
                  { name: "`/경고조회 [대상]`", value: "유저의 경고 내역을 조회합니다." },
                  { name: "`/경고목록`", value: "서버 전체 경고 목록 또는 특정 유저의 경고를 조회합니다." },
                  { name: "`/경고삭제 [경고ID]`", value: "특정 경고를 ID로 삭제합니다." },
                  { name: "`/경고초기화 [대상]`", value: "유저의 모든 경고를 초기화합니다." },
                  { name: "`/경고검색 [경고ID]`", value: "경고 ID로 상세 내용을 검색합니다." },
                  { name: "`/경고제재 설정/삭제/목록`", value: "경고 누적 횟수에 따라 자동 타임아웃·추방·차단 제재를 설정합니다." },
                  { name: "`/타임아웃 [대상] [시간] [사유]`", value: "지정한 시간(분)만큼 유저를 타임아웃 처리합니다." },
                  { name: "`/추방 [대상] [사유]`", value: "유저를 서버에서 추방합니다." },
                  { name: "`/차단 [대상] [사유]`", value: "유저를 영구 차단합니다. ID 입력으로 서버 미가입 유저도 차단 가능." },
                  { name: "`/차단해제 [대상] [사유]`", value: "차단된 유저를 해제합니다. ID 입력으로 처리 가능." }
                );
            } else if (selected === 'help_system') {
              categoryEmbed
                .setTitle("⚙️ 시작하기 및 시스템 안내")
                .setDescription("시아 봇의 초기 설정과 운영에 관련된 명령어입니다.")
                .addFields(
                  { name: "`/시작하기`", value: "시아 단계별 초기 설정 마법사를 실행합니다. (약관 동의 → 로그 채널 자동 생성)" },
                  { name: "`/동의 메시지수집`", value: "채팅 수집 약관에 동의하거나 철회합니다." },
                  { name: "`/업데이트 등록 [제목] [내용]`", value: "새 업데이트 내용을 패치노트에 등록합니다." },
                  { name: "`/업데이트 조회`", value: "최근 등록된 업데이트 내역을 조회합니다." }
                );
            } else if (selected === 'help_updates') {
              db.all("SELECT title, content, timestamp FROM update_logs ORDER BY id DESC LIMIT 3", [], (err, rows) => {
                const updateEmbed = new EmbedBuilder()
                  .setTitle("📢 시아 실시간 업데이트 로그")
                  .setDescription("시아의 최근 패치노트와 신규 기능 추가 사항을 실시간 확인하세요!")
                  .setColor(MAIN_COLOR)
                  .setTimestamp();

                if (rows && rows.length > 0) {
                  rows.forEach(row => {
                    const dateStr = new Date(row.timestamp).toLocaleDateString('ko-KR');
                    updateEmbed.addFields({
                      name: `📣 [${dateStr}] ${row.title}`,
                      value: row.content
                    });
                  });
                } else {
                  updateEmbed.addFields({ name: "알림", value: "아직 등록된 업데이트 로그가 존재하지 않습니다." });
                }

                i.update({
                  embeds: [mainEmbed, updateEmbed],
                  components: [row]
                }).catch(() => null);
              });
              return;
            } else if (selected === 'help_economy') {
              categoryEmbed
                .setTitle("🎮 가상 경제 및 미니게임 안내")
                .setDescription("가상 경제 계정을 만들고, 실시간 액션 낚시, 재배, 도박 등을 즐겨보세요!")
                .addFields(
                  { name: "`/가입` & `/탈퇴`", value: "가상 경제 서비스 등록 및 데이터 영구 파기." },
                  { name: "`/돈`", value: "현재 보유한 시아코인 잔액을 확인합니다." },
                  { name: "`/랭킹`", value: "전 서버 통합 자산 랭킹 탑 10을 확인합니다." },
                  { name: "`/낚시`", value: "타이밍에 맞춰 버튼을 눌러 물고기를 낚는 액션 게임! (15초 쿨타임)" },
                  { name: "`/농사`", value: "작물을 재배하고 수확하여 전리품을 획득합니다. (30초 쿨타임)" },
                  { name: "`/가방`", value: "보유 중인 물고기와 농작물 목록을 확인합니다." },
                  { name: "`/판매`", value: "인벤토리의 아이템을 상점에 일괄 판매합니다." },
                  { name: "`/도박 [금액]`", value: "초대박(5x), 대성공(2x), 본전(1.2x), 실패(55%) 확률 도박." }
                );
            } else if (selected === 'help_thread') {
              categoryEmbed
                .setTitle("🧵 끝말잇기 안내")
                .setDescription("프라이빗 스레드에서 시아봇과 끝말잇기 게임을 즐겨보세요!")
                .addFields(
                  { name: "`/끝말잇기`", value: "끝말잇기 게임을 시작합니다. 전용 스레드가 열립니다." },
                  { name: "`/끝말잇기설정`", value: "끝말잇기 스레드의 상세 설정을 변경합니다." }
                );
            } else if (selected === 'help_general') {
              categoryEmbed
                .setTitle("🌐 일반 유틸리티 안내")
                .setDescription("시아의 기본 정보 조회 및 유틸리티 명령어입니다.")
                .addFields(
                  { name: "`/핑`", value: "시아 봇의 현재 응답 속도(레이턴시)를 확인합니다." },
                  { name: "`/정보`", value: "시아의 버전, 서버 수, 업타임 등 통계를 확인합니다." },
                  { name: "`/소개`", value: "시아 봇 소개 및 개발팀 정보를 확인합니다." },
                  { name: "`/서버정보`", value: "현재 서버의 세부 정보(멤버 수, 생성일 등)를 확인합니다." },
                  { name: "`/유저정보 [유저]`", value: "특정 멤버의 계정 생성일, 닉네임 등 정보를 확인합니다." },
                  { name: "`/초대`", value: "시아 봇 초대 링크를 발급합니다." },
                  { name: "`/서포트서버`", value: "공식 지원 서버 입장 링크를 제공합니다." }
                );
            }

            await i.update({
              embeds: [mainEmbed, categoryEmbed],
              components: [row]
            }).catch(() => null);
          }
        });

        collector.on('end', () => {
          const disabledSelect = StringSelectMenuBuilder.from(selectMenu).setDisabled(true);
          interaction.editReply({
            components: [new ActionRowBuilder().addComponents(disabledSelect)]
          }).catch(() => null);
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('업데이트')
        .setDescription('시아의 패치노트 및 업데이트 로그를 조회하거나 등록합니다.')
        .addSubcommand(subcommand =>
          subcommand.setName('등록')
            .setDescription('📣 [개발자 전용] 새로운 업데이트 로그를 등록합니다.')
            .addStringOption(option => option.setName('제목').setDescription('업데이트 제목').setRequired(true))
            .addStringOption(option => option.setName('내용').setDescription('업데이트 내용 (줄바꿈은 \\n 사용)').setRequired(true))
        )
        .addSubcommand(subcommand =>
          subcommand.setName('조회')
            .setDescription('📖 시아의 최신 업데이트 로그 목록을 조회합니다.')
        ),
      async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === '등록') {
          if (interaction.user.id !== ALLOWED_USER_ID) {
            return interaction.reply({ content: "❌ **이 명령어는 시아 공식 개발자만 실행할 수 있습니다.**", ephemeral: true });
          }

          const title = interaction.options.getString('제목');
          const rawContent = interaction.options.getString('내용');
          const content = rawContent.replace(/\\n/g, '\n');
          const timestamp = new Date().toISOString();

          db.run("INSERT INTO update_logs (title, content, timestamp) VALUES (?, ?, ?)", [title, content, timestamp], function(err) {
            if (err) {
              console.error(err);
              return interaction.reply({ content: "❌ 업데이트 로그 등록 중 오류가 발생했습니다.", ephemeral: true });
            }

            const embed = new EmbedBuilder()
              .setTitle("📣 업데이트 로그 등록 완료")
              .setDescription(`성공적으로 새로운 업데이트 로그가 등록되었습니다!\n\n**제목:** \`${title}\``)
              .setColor(MAIN_COLOR)
              .setTimestamp();

            return interaction.reply({ embeds: [embed] });
          });
        }

        else if (subcommand === '조회') {
          db.all("SELECT title, content, timestamp FROM update_logs ORDER BY id DESC LIMIT 5", [], (err, rows) => {
            if (err) {
              console.error(err);
              return interaction.reply({ content: "❌ 업데이트 로그 조회 중 오류가 발생했습니다.", ephemeral: true });
            }

            const embed = new EmbedBuilder()
              .setTitle("📢 시아 최신 업데이트 로그")
              .setColor(MAIN_COLOR)
              .setTimestamp();

            if (rows && rows.length > 0) {
              rows.forEach((row) => {
                const dateStr = new Date(row.timestamp).toLocaleDateString('ko-KR');
                embed.addFields({
                  name: `📌 [${dateStr}] ${row.title}`,
                  value: row.content.substring(0, 1024)
                });
              });
            } else {
              embed.setDescription("등록된 업데이트 로그가 아직 없습니다.");
            }

            return interaction.reply({ embeds: [embed] });
          });
        }
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('정보')
        .setDescription('봇의 정보를 알 수 있습니다.'),
      async execute(interaction) {
        const client = interaction.client;
        const totalUsers = client.guilds.cache.reduce((acc, guild) => acc + (guild.memberCount || 0), 0);
        const totalGuilds = client.guilds.cache.size;

        const embed = new EmbedBuilder()
          .setTitle("<:information:1218535780415180950> 시아 정보") // Updated
          .setColor(MAIN_COLOR)
          .addFields(
            { name: "봇 사용자 수", value: `${totalUsers}명이 사용 중`, inline: false },
            { name: "봇 사용 서버 수", value: `${totalGuilds}개의 서버를 관리 중`, inline: false },
            { name: "개발팀", value: "Team Everyways", inline: false },
            { name: "봇 홈페이지", value: "https://team.softgames.kr", inline: false }
          );

        if (client.user.avatarURL()) {
          embed.setThumbnail(client.user.avatarURL());
        }

        await interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('초대')
        .setDescription('봇 초대링크를 알 수 있습니다.'),
      async execute(interaction) {
        const embed = new EmbedBuilder()
          .setTitle("봇 초대 링크")
          .setDescription("https://discord.com/api/oauth2/authorize?client_id=1096067976068870144&scope=applications.commands%20bot&permissions=8")
          .setColor(MAIN_COLOR);
        
        await interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('서포트서버')
        .setDescription('봇의 서포트서버 링크를 알 수 있습니다.'),
      async execute(interaction) {
        const embed = new EmbedBuilder()
          .setTitle("서포트 서버")
          .setDescription("봇의 서포트 서버에 입장해보세요.")
          .setColor(MAIN_COLOR)
          .addFields({ name: "서포트 서버의 링크는 다음과 같습니다.", value: "https://discord.gg/twwuHcpfft", inline: false });
        
        await interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('소개')
        .setDescription('봇의 소개를 알 수 있습니다.'),
      async execute(interaction) {
        const embed = new EmbedBuilder()
          .setTitle("소개")
          .setDescription("'시아'는 Soft Games™ Official 서버 운영팀이 서버 운영 및 관리를 쉽고 편하게 하려고 만든 봇입니다.\n하지만, 현재 V1이 호스트 문제로 인해 정지되면서 여러분과 작별하게 되었습니다.")
          .setColor(MAIN_COLOR)
          .addFields({ name: "V2 버전의 특별함.", value: "V1이 관리 쪽 이었다면 V2는 관리 기능과 여러분의 디스코드 생활에 편리함을 주는 기능을 가지고 있습니다.", inline: false });
        
        await interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('서버정보')
        .setDescription('해당 서버에 관한 내용을 알 수 있습니다.'),
      async execute(interaction) {
        const guild = interaction.guild;
        if (!guild) {
          return interaction.reply({ content: "이 명령어는 서버 내에서만 사용 가능합니다.", ephemeral: true });
        }

        let owner = "없음";
        try {
          const ownerMember = await guild.fetchOwner();
          owner = ownerMember ? ownerMember.toString() : "없음";
        } catch (e) {
          console.error(e);
        }

        const boostCount = guild.premiumSubscriptionCount || 0;
        const boostLevel = guild.premiumTier;
        const membersCount = guild.memberCount;

        const roleCount = guild.roles.cache.size;
        const categoryCount = guild.channels.cache.filter(c => c.type === 4).size; // ChannelType.GuildCategory is 4
        const textCount = guild.channels.cache.filter(c => c.type === 0).size; // ChannelType.GuildText is 0
        const voiceCount = guild.channels.cache.filter(c => c.type === 2).size; // ChannelType.GuildVoice is 2

        const serverIconUrl = guild.iconURL() || "https://cdn.discordapp.com/attachments/985123689857175573/1163004654855135242/-_-001_23.png";

        const embed = new EmbedBuilder()
          .setTitle("<:information:1218535780415180950> 서버 정보")
          .setColor(MAIN_COLOR)
          .setThumbnail(serverIconUrl)
          .addFields(
            { name: "서버 이름", value: guild.name, inline: true },
            { name: "서버 인원", value: `${membersCount}명`, inline: true },
            { name: "서버 부스트", value: `${boostLevel}레벨, ${boostCount}개`, inline: true },
            { name: "서버 주인", value: owner, inline: true },
            { name: "역할/채널", value: `역할: ${roleCount}개\n카테고리: ${categoryCount}개\n텍스트: ${textCount}개\n음성: ${voiceCount}개`, inline: true },
            { name: "보안 수준", value: guild.verificationLevel.toString(), inline: true }
          );

        await interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('유저정보')
        .setDescription('유저의 정보를 확인 가능합니다.')
        .addUserOption(option => 
          option.setName('유저')
            .setDescription('정보를 확인할 유저')
            .setRequired(false)
        ),
      async execute(interaction) {
        const userOption = interaction.options.getUser('유저');
        const user = userOption || interaction.user;
        const member = interaction.guild ? await interaction.guild.members.fetch(user.id).catch(() => null) : null;
        
        const embed = new EmbedBuilder()
          .setTitle("<:information:1218535780415180950> 유저 정보")
          .setColor(MAIN_COLOR);

        const userIconUrl = user.displayAvatarURL() || "https://cdn.discordapp.com/attachments/985123689857175573/1163006780968816680/-_-001_25.png";
        embed.setThumbnail(userIconUrl);

        const createdAtStr = user.createdAt.toISOString().split('T')[0];
        
        embed.addFields(
          { name: "유저 이름", value: member ? member.displayName : user.username, inline: true },
          { name: "유저 아이디", value: user.id.toString(), inline: true },
          { name: "계정 생성", value: createdAtStr, inline: true }
        );

        if (member && member.joinedAt) {
          const joinedAtStr = member.joinedAt.toISOString().split('T')[0];
          embed.addFields({ name: "서버 입장", value: joinedAtStr, inline: true });
        }

        await interaction.reply({ embeds: [embed] });
      }
    }
  ],
  listeners: {
    async messageCreate(client, message) {
      if (message.author.bot || !message.guild) return;

      const content = message.content.trim();
      if (content.startsWith('시아야')) {
        const query = content.slice(3).trim();

        if (!query) {
          const responses = [
            "네! 부르셨어요? 무엇을 도와드릴까요? ✨",
            "유저님이 부르셔서 언제든 시아가 빠르게 달려왔어요! 🏃‍♀️💨",
            "헤헤, 시아 여기 있어요! 오늘 어떤 재밌는 이야기를 나눠볼까요? 🥰",
            "지켜보고 있었어요! 시아에게 물어볼 것이 있으시다면 언제든 불러주세요! 👀"
          ];
          const choice = responses[Math.floor(Math.random() * responses.length)];
          return message.reply(choice).catch(console.error);
        }

        // --- NATURAL LANGUAGE MODERATION COMMANDS ---
        const mentionMatch = query.match(/<@!?(\d+)>/);
        if (mentionMatch) {
          const targetUserId = mentionMatch[1];
          const targetMember = await message.guild.members.fetch(targetUserId).catch(() => null);
          const targetUser = targetMember ? targetMember.user : await message.client.users.fetch(targetUserId).catch(() => null);

          if (targetUser) {
            const { checkAdminPermission } = require('../core/utils');
            const isRelease = query.includes('해제') || query.includes('풀어') || query.includes('풀기');

            // 1. UNBAN (차단 해제)
            if ((query.includes('차단') || query.includes('밴')) && isRelease) {
              if (!(await checkAdminPermission(message.member))) {
                return message.reply("❌ **이 명령은 시아 관리자 권한을 가진 분만 내릴 수 있어요.**").catch(console.error);
              }

              const banList = await message.guild.bans.fetch().catch(() => null);
              const isBanned = banList ? banList.has(targetUserId) : true;

              if (!isBanned) {
                return message.reply("❌ **해당 유저는 현재 차단된 상태가 아니에요.**").catch(console.error);
              }

              const fullReason = `시아 대화형 명령어 - 관리자: ${message.author.tag}`;
              message.client.unbanCache = message.client.unbanCache || new Map();
              message.client.unbanCache.set(`${message.guild.id}-${targetUserId}`, {
                reason: fullReason,
                executor: `${message.author.toString()} (${message.author.tag})`
              });

              try {
                await message.guild.bans.remove(targetUserId, fullReason);
              } catch (err) {
                if (message.client.unbanCache) {
                  message.client.unbanCache.delete(`${message.guild.id}-${targetUserId}`);
                }
                console.error(err);
                return message.reply("❌ **차단 해제 중 오류가 발생했습니다.**");
              }

              const embed = new EmbedBuilder()
                .setTitle("🛡️ 차단 해제 완료")
                .setDescription(`${targetUser.toString()}님의 차단이 성공적으로 해제되었습니다.\n\n• **집행 관리자**: ${message.author.toString()}`)
                .setColor(MAIN_COLOR)
                .setTimestamp();

              return message.reply({ embeds: [embed] }).catch(console.error);
            }

            // 2. UNTIMEOUT (타임아웃 해제)
            if ((query.includes('타임아웃') || query.includes('뮤트') || query.includes('음소거')) && isRelease) {
              if (!(await checkAdminPermission(message.member))) {
                return message.reply("❌ **이 명령은 시아 관리자 권한을 가진 분만 내릴 수 있어요.**").catch(console.error);
              }

              if (!targetMember) {
                return message.reply("❌ **서버에 존재하지 않는 멤버는 타임아웃을 해제할 수 없어요.**").catch(console.error);
              }

              if (!targetMember.communicationDisabledUntil) {
                return message.reply("❌ **해당 멤버는 현재 타임아웃(이용 제한) 상태가 아니에요.**").catch(console.error);
              }

              if (!targetMember.moderatable) {
                return message.reply("❌ **해당 유저는 저보다 권한이 높거나 동등하여 조치할 수 없어요.**").catch(console.error);
              }

              await targetMember.timeout(null, `시아 대화형 명령어 - 관리자: ${message.author.tag}`).catch(err => {
                console.error(err);
                return message.reply("❌ **타임아웃 해제 중 오류가 발생했습니다.**");
              });

              const embed = new EmbedBuilder()
                .setTitle("⏳ 타임아웃 해제 완료")
                .setDescription(`${targetMember.toString()}님의 서버 이용 제한(타임아웃)이 해제되었습니다.\n\n• **집행 관리자**: ${message.author.toString()}`)
                .setColor(MAIN_COLOR)
                .setTimestamp();

              return message.reply({ embeds: [embed] }).catch(console.error);
            }

            // 3. TIMEOUT (타임아웃 / 뮤트 / 음소거)
            if (query.includes('타임아웃') || query.includes('뮤트') || query.includes('음소거')) {
              if (!(await checkAdminPermission(message.member))) {
                return message.reply("❌ **이 명령은 시아 관리자 권한을 가진 분만 내릴 수 있어요.**").catch(console.error);
              }

              if (!targetMember) {
                return message.reply("❌ **서버에 존재하지 않는 멤버는 타임아웃을 걸 수 없어요.**").catch(console.error);
              }

              let durationMs = 10 * 60 * 1000; // default 10m
              let timeStr = "10분";
              const timeMatch = query.match(/(\d+)\s*(일|시간|분|초)/);
              if (timeMatch) {
                const amount = parseInt(timeMatch[1]);
                const unit = timeMatch[2];
                timeStr = `${amount}${unit}`;
                if (unit === '분') durationMs = amount * 60 * 1000;
                else if (unit === '시간') durationMs = amount * 60 * 60 * 1000;
                else if (unit === '일') durationMs = amount * 24 * 60 * 60 * 1000;
                else if (unit === '초') durationMs = amount * 1000;
              }

              if (!targetMember.moderatable) {
                return message.reply("❌ **해당 유저는 저보다 권한이 높거나 동등하여 조치할 수 없어요.**").catch(console.error);
              }

              await targetMember.timeout(durationMs, `시아 대화형 명령어 - 관리자: ${message.author.tag}`).catch(err => {
                console.error(err);
                return message.reply("❌ **타임아웃 적용 중 오류가 발생했습니다.**");
              });

              const embed = new EmbedBuilder()
                .setTitle("⏳ 타임아웃 처리 완료")
                .setDescription(`${targetMember.toString()}님이 **${timeStr}** 동안 서버 이용이 제한(타임아웃)되었습니다.\n\n• **집행 관리자**: ${message.author.toString()}`)
                .setColor(MAIN_COLOR)
                .setTimestamp();

              return message.reply({ embeds: [embed] }).catch(console.error);
            }

            // 4. BAN (차단 / 밴)
            if (query.includes('차단') || query.includes('밴')) {
              if (!(await checkAdminPermission(message.member))) {
                return message.reply("❌ **이 명령은 시아 관리자 권한을 가진 분만 내릴 수 있어요.**").catch(console.error);
              }

              let reason = "사유 미지정 (시아 대화형)";
              const reasonMatch = query.match(/(.+?)(?:으로|로)\s*차단/);
              if (reasonMatch) {
                reason = reasonMatch[1].replace(/<@!?\d+>/g, '').trim();
              }

              if (targetMember && !targetMember.bannable) {
                return message.reply("❌ **해당 유저는 저보다 권한이 높거나 동등하여 조치할 수 없어요.**").catch(console.error);
              }

              const fullReason = `시아 대화형 명령어 - 관리자: ${message.author.tag} (${reason})`;
              message.client.banCache = message.client.banCache || new Map();
              message.client.banCache.set(`${message.guild.id}-${targetUserId}`, {
                reason: fullReason,
                executor: `${message.author.toString()} (${message.author.tag})`
              });

              try {
                await message.guild.members.ban(targetUserId, { reason: fullReason });
              } catch (err) {
                if (message.client.banCache) {
                  message.client.banCache.delete(`${message.guild.id}-${targetUserId}`);
                }
                console.error(err);
                return message.reply("❌ **차단 처리 중 오류가 발생했습니다.**");
              }

              const embed = new EmbedBuilder()
                .setTitle("🛡️ 멤버 영구 차단")
                .setDescription(`${targetUser.toString()}님이 서버에서 영구 차단되었습니다.\n\n• **사유**: ${reason}\n• **집행 관리자**: ${message.author.toString()}`)
                .setColor(0xff0000)
                .setTimestamp();

              return message.reply({ embeds: [embed] }).catch(console.error);
            }

            // 5. KICK (추방 / 킥 / 강퇴)
            if (query.includes('추방') || query.includes('킥') || query.includes('강퇴')) {
              if (!(await checkAdminPermission(message.member))) {
                return message.reply("❌ **이 명령은 시아 관리자 권한을 가진 분만 내릴 수 있어요.**").catch(console.error);
              }

              if (!targetMember) {
                return message.reply("❌ **서버에 존재하지 않는 멤버는 추방(강퇴)할 수 없어요.**").catch(console.error);
              }

              let reason = "사유 미지정 (시아 대화형)";
              const queryWithoutMention = query.replace(/<@!?\d+>/g, '').trim();

              const reasonMatch = 
                queryWithoutMention.match(/(.+?)\s*사유로\s*(?:강퇴|추방|킥)/) ||
                queryWithoutMention.match(/tkdb\s+(.+?)\s*(?:으로|로)\s*(?:강퇴|추방|킥)/) ||
                queryWithoutMention.match(/(.+?)\s*(?:으로|로)\s*(?:강퇴|추방|킥)/);

              if (reasonMatch) {
                reason = reasonMatch[1].trim();
              }

              if (!targetMember.kickable) {
                return message.reply("❌ **해당 유저는 저보다 권한이 높거나 동등하여 조치할 수 없어요.**").catch(console.error);
              }

              await targetMember.kick(`시아 대화형 명령어 - 관리자: ${message.author.tag} (${reason})`).catch(err => {
                console.error(err);
                return message.reply("❌ **추방(강퇴) 처리 중 오류가 발생했습니다.**");
              });

              const embed = new EmbedBuilder()
                .setTitle("🚪 멤버 추방(강퇴) 완료")
                .setDescription(`${targetMember.toString()}님이 서버에서 추방(강퇴)되었습니다.\n\n• **사유**: ${reason}\n• **집행 관리자**: ${message.author.toString()}`)
                .setColor(MAIN_COLOR)
                .setTimestamp();

              return message.reply({ embeds: [embed] }).catch(console.error);
            }

            // 6. WARN (경고)
            if (query.includes('경고')) {
              if (!(await checkAdminPermission(message.member))) {
                return message.reply("❌ **이 명령은 시아 관리자 권한을 가진 분만 내릴 수 있어요.**").catch(console.error);
              }

              let reason = "사유 미지정 (시아 대화형)";
              const reasonMatch = query.match(/(.+?)(?:으로|로)\s*경고/);
              if (reasonMatch) {
                reason = reasonMatch[1].replace(/<@!?\d+>/g, '').trim();
              }

              db.run(
                "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, timestamp, guild_warn_id) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(guild_warn_id), 0) + 1 FROM warnings WHERE guild_id = ?))",
                [message.guild.id, targetUserId, message.author.id, reason, new Date().toISOString(), message.guild.id],
                function(err) {
                  if (err) {
                    return message.reply("❌ **경고 저장 중 오류가 발생했습니다.**");
                  }

                  const lastInsertedId = this.lastID;

                  db.get("SELECT guild_warn_id FROM warnings WHERE id = ?", [lastInsertedId], (err, warnRow) => {
                    const guildWarnId = warnRow ? warnRow.guild_warn_id : 'N/A';

                    db.get("SELECT COUNT(*) as count FROM warnings WHERE guild_id = ? AND user_id = ?", [message.guild.id, targetUserId], async (err, row) => {
                      const count = row ? row.count : 1;

                      const embed = new EmbedBuilder()
                        .setTitle('⚠️ 유저 경고 부여')
                        .setDescription(`${targetUser} 님에게 경고가 부여되었습니다.`)
                        .addFields(
                          { name: '경고 ID', value: `\`#${guildWarnId}\``, inline: true },
                          { name: '대상 유저', value: `${targetUser.tag || targetUser.username} (${targetUserId})`, inline: true },
                          { name: '누적 경고 횟수', value: `**${count}회**`, inline: true },
                          { name: '처리 관리자', value: `${message.author.tag}`, inline: true },
                          { name: '경고 사유', value: reason, inline: false }
                        )
                        .setColor(MAIN_COLOR)
                        .setTimestamp();

                      message.reply({ embeds: [embed] });

                      // Auto sanction trigger
                      db.get(
                        "SELECT action_type, duration_value FROM server_warning_sanctions WHERE guild_id = ? AND warning_count = ?",
                        [message.guild.id.toString(), count],
                        async (err, sanctionRow) => {
                          if (sanctionRow && targetMember) {
                            const actionType = sanctionRow.action_type;
                            const durationValue = sanctionRow.duration_value;

                            if (actionType === 'timeout' && targetMember.moderatable) {
                              const ms = durationValue * 60 * 1000;
                              await targetMember.timeout(ms, `누적 경고 ${count}회 도달 자동 제재`);
                              let durStr = `${durationValue}분`;
                              const autoEmbed = new EmbedBuilder()
                                .setTitle('🛡️ 누적 경고 자동 제재 (타임아웃)')
                                .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달하여 **${durStr} 타임아웃** 제재를 받았습니다.`)
                                .setColor(0xff0000)
                                .setTimestamp();
                              message.channel.send({ embeds: [autoEmbed] });
                            } else if (actionType === 'kick' && targetMember.kickable) {
                              await targetMember.kick(`누적 경고 ${count}회 도달 자동 제재`);
                              const autoEmbed = new EmbedBuilder()
                                .setTitle('🛡️ 누적 경고 자동 제재 (추방)')
                                .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달하여 **서버에서 추방** 처리되었습니다.`)
                                .setColor(0xff0000)
                                .setTimestamp();
                              message.channel.send({ embeds: [autoEmbed] });
                            } else if (actionType === 'ban' && (!targetMember || targetMember.bannable)) {
                              const autoReason = `누적 경고 ${count}회 도달 자동 제재`;
                              message.client.banCache = message.client.banCache || new Map();
                              message.client.banCache.set(`${message.guild.id}-${targetUserId}`, {
                                reason: autoReason,
                                executor: `${message.client.user.toString()} (시스템 자동 제재)`
                              });

                              try {
                                await message.guild.members.ban(targetUserId, { reason: autoReason });
                              } catch (e) {
                                if (message.client.banCache) {
                                  message.client.banCache.delete(`${message.guild.id}-${targetUserId}`);
                                }
                                throw e;
                              }

                              const autoEmbed = new EmbedBuilder()
                                .setTitle('🛡️ 누적 경고 자동 제재 (차단)')
                                .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달하여 **서버에서 차단** 처리되었습니다.`)
                                .setColor(0xff0000)
                                .setTimestamp();
                              message.channel.send({ embeds: [autoEmbed] });
                            }
                          }
                        }
                      );
                    });
                  });
                }
              );
              return;
            }
          }
        }

        if (query.includes('안녕') || query.includes('반가워')) {
          return message.reply("안녕하세요! 만나서 정말 반가워요. 오늘도 즐겁고 행복한 하루로 만들어볼까요? 😊").catch(console.error);
        }
        if (query.includes('뭐해') || query.includes('뭐하고')) {
          return message.reply("저는 서버를 열심히 지키고 관리하고 있었어요! 궁금한 명령어는 `/도움말`로 확인해 볼까요? 🛡️").catch(console.error);
        }
        if (query.includes('사랑해')) {
          return message.reply("우와, 부끄럽네요... 저도 유저님을 정말 정말 좋아해요! 💖").catch(console.error);
        }
        if (query.includes('힘들어') || query.includes('속상해') || query.includes('우울해')) {
          return message.reply("오늘 힘든 일이 있으셨군요... 제가 계속 곁에 있어 드릴게요. 토닥토닥, 같이 힘을 내볼까요? 🥺💕").catch(console.error);
        }
        if (query.includes('끝말잇기')) {
          return message.reply("끝말잇기는 `/끝말잇기 시작` 명령어로 저와 함께 하실 수 있어요! 얼른 시작해 볼까요? 🎮").catch(console.error);
        }
        if (query.includes('바보')) {
          return message.reply("으앙, 바보 아니라구요! 저는 아주 똑똑한 시아라구요! 😤").catch(console.error);
        }
        if (query.includes('먹을까') || query.includes('메뉴 추천') || query.includes('메뉴추천') || query.includes('음식 추천') || query.includes('밥 추천')) {
          const foods = ["라면", "치킨", "피자", "삼겹살", "돈가스", "초밥", "떡볶이", "짜장면", "마라탕", "햄버거", "국밥", "김치찌개", "파스타", "족발"];
          const food = foods[Math.floor(Math.random() * foods.length)];
          return message.reply(`음~ 오늘은 맛있는 **${food}**을 준비해 봤어요! 생각만 해도 침이 고이네요! 😋`).catch(console.error);
        }
        if (query.includes('로또') || query.includes('번호') || query.includes('추첨')) {
          const numbers = [];
          while (numbers.length < 6) {
            const num = Math.floor(Math.random() * 45) + 1;
            if (!numbers.includes(num)) numbers.push(num);
          }
          numbers.sort((a, b) => a - b);
          return message.reply(`오늘의 행운의 로또 번호를 뽑아봤어요! 번호는 **[${numbers.join(', ')}]** 이에요! 당첨되면 저 시아에게 맛있는 것 사주실 거죠? 🍀`).catch(console.error);
        }
        if (query.includes('노래')) {
          return message.reply("🎶 ~ 라라라~ 유저님을 위해 특별히 시아의 하트 세레나데를 준비했어요! 💖").catch(console.error);
        }

        // Generic fallback reactions
        const responses = [
          `네! "${query}"에 대해 준비해 봤어요! 더 자세히 얘기해 볼까요? 😮`,
          `헤헤, 유저님과 대화하는 건 언제나 즐거워요! 🥰`,
          `웅웅! 귀를 쫑긋하고 다 듣고 있었어요! 🐰`,
          `시아는 언제나 유저님의 행복을 응원하고 있어요! 🍀`,
          `음~ 그건 어떤 의미일까요? 시아는 정말 궁금했어요! 🤔`
        ];
        const choice = responses[Math.floor(Math.random() * responses.length)];
        return message.reply(choice).catch(console.error);
      }
    }
  }
};
