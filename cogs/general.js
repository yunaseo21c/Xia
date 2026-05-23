const { 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ActionRowBuilder, 
  StringSelectMenuBuilder, 
  StringSelectMenuOptionBuilder 
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { MAIN_COLOR, ALLOWED_USER_ID, SUCCESS_COLOR, ERROR_COLOR } = require('../core/config');
const { checkAdminPermission } = require('../core/utils');

// Helper function to format date in Korea Time (KST)
function formatKST(date) {
  if (!date) return "알 수 없음";
  try {
    const formatter = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    return formatter.format(date);
  } catch (e) {
    return date.toLocaleString();
  }
}

const badgeTranslations = {
  Staff: '🛠️ Discord 직원',
  Partner: '🤝 파트너 서버 소유자',
  Hypesquad: '🎪 HypeSquad 이벤트',
  BugHunterLevel1: '🐛 버그 헌터 Level 1',
  BugHunterLevel2: '🐛 버그 헌터 Level 2',
  HypeSquadOnlineHouse1: '🛡️ House of Bravery',
  HypeSquadOnlineHouse2: '💡 House of Brilliance',
  HypeSquadOnlineHouse3: '⚖️ House of Balance',
  PremiumEarlySupporter: '💎 초기 서포터',
  TeamPseudoUser: '👥 팀 유저',
  VerifiedBot: '🤖 인증된 봇',
  VerifiedDeveloper: '💻 액티브 개발자'
};

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

// 자연어 명령어에서 사유(Reason)를 정밀하게 추출하는 헬퍼 함수
function extractNaturalReason(query, actionType = 'warn') {
  // 1. 멘션 제거
  let text = query.replace(/<@!?\d+>/g, '').trim();

  // 2. 숫자 및 단위 제거 (예: 1회, 2번, 5개 등)
  text = text.replace(/\d+\s*(?:회|번|개|id|번째)/g, '').trim();
  text = text.replace(/\b\d{1,2}\b/g, '').trim();

  // 3. 명령어 핵심 키워드 제거
  if (actionType === 'warn') {
    text = text.replace(/경고|부여|설정|적용/g, '').trim();
  } else {
    text = text.replace(/경고|삭제|차감|제거|지워|취소|초기화/g, '').trim();
  }

  // 종결어미 및 불필요 접사 제거 (단어 끝부분 위주)
  text = text.replace(/(?:해줘|해|줘|줄래|해주라|해주세요|해라|함|다|요|음|기|해볼까요|할게요|할게)$/, '').trim();

  // 4. 사유 패턴 매칭 진행
  
  // A. 접두사 패턴: "사유: 도배", "사유는 욕설", "이유 도배" 등
  const prefixPattern = /^(?:사유|이유)(?:\s*:\s*|\s+는\s+|\s+은\s+|\s+)(.+)$/;
  const prefixMatch = text.match(prefixPattern);
  if (prefixMatch && prefixMatch[1].trim()) {
    return prefixMatch[1].trim();
  }

  // B. 접미사 패턴: "도배 사유로", "욕설 사유 때문에", "도배 사유" 등
  const suffixPattern = /^(.*?)\s*(?:사유로|사유\s*때문에|사유)$/;
  const suffixMatch = text.match(suffixPattern);
  if (suffixMatch && suffixMatch[1].trim()) {
    return suffixMatch[1].trim();
  }

  // C. 이유/조사 패턴: "도배 때문에", "실수로", "도배로" 등
  const becausePattern = /^(.*?)\s*(?:때문에|으로|로)$/;
  const becauseMatch = text.match(becausePattern);
  if (becauseMatch && becauseMatch[1].trim()) {
    const res = becauseMatch[1].trim();
    // "경고로" 처럼 키워드 자체가 필터링되지 않고 유입된 경우는 무시
    if (res.length > 0 && !/^(?:경고|삭제|차감|제거)$/.test(res)) {
      return res;
    }
  }

  // D. 문장 중간 또는 어디선가 "사유: 도배" 가 매칭되는 경우
  const inlinePattern = /(?:사유|이유)(?:\s*:\s*|\s+는\s+|\s+은\s+|\s+)(.+)/;
  const inlineMatch = text.match(inlinePattern);
  if (inlineMatch && inlineMatch[1].trim()) {
    return inlineMatch[1].trim();
  }

  // E. 남은 텍스트 전체를 사유로 간주 (단, 핵심 기능 키워드만 덜렁 남은 경우는 무시)
  const cleanStr = text.replace(/[^a-zA-Z0-9가-힣\s]/g, '').trim();
  if (cleanStr.length > 0 && !/^(?:해줘|해|줘|줄래|적용|설정)$/.test(cleanStr)) {
    return text;
  }

  return "사유 미지정";
}

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
              .setDescription('채팅·음성·입퇴장·차단·반응·역할·타임아웃 로그 채널 설정')
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
                .setDescription("서버에서 발생하는 다양한 이벤트(채팅, 음성, 입퇴장, 차단, 스레드, 반응, 역할, 타임아웃, 제재 등)를 감지하여 지정 채널/스레드에 실시간 기록합니다.")
                .addFields(
                  { name: "`/로그 채널 방식:[일반/스레드]`", value: "실시간 감사 로그를 기록할 채널 또는 스레드를 지정합니다." },
                  { name: "`/로그 대량삭제 방식:[TXT/HTML/JSON]`", value: "메시지 대량 삭제 발생 시의 파일 보존 방식을 설정합니다." },
                  { name: "`/로그삭제`", value: "특정 로그 채널 설정을 해제합니다." },
                  { name: "`/로그조회`", value: "현재 서버에 설정된 모든 로그 채널 현황과 파일 보존 방식을 확인합니다." },
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
                  { name: "`/입장자동역할 설정/삭제/조회`", value: "서버 입장 시 자동으로 부여할 역할을 설정하거나 제거합니다." },
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
        .setDescription('해당 서버에 관한 상세한 정보를 조회합니다.'),
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

        const roles = guild.roles.cache.sort((a, b) => b.position - a.position).filter(r => r.name !== '@everyone');
        const roleCount = guild.roles.cache.size;
        
        // Format roles preview nicely (up to 15 roles)
        const rolesList = roles.size > 0 
          ? roles.map(r => r.toString()).slice(0, 15).join(', ') + (roles.size > 15 ? ` 외 ${roles.size - 15}개` : '')
          : "없음";

        const categoryCount = guild.channels.cache.filter(c => c.type === 4).size; 
        const textCount = guild.channels.cache.filter(c => c.type === 0).size; 
        const voiceCount = guild.channels.cache.filter(c => c.type === 2).size; 

        const serverIconUrl = guild.iconURL({ size: 1024 }) || "https://cdn.discordapp.com/attachments/985123689857175573/1163004654855135242/-_-001_23.png";

        const embed = new EmbedBuilder()
          .setTitle("🏰 서버 정보 상세 조회")
          .setColor(MAIN_COLOR)
          .setThumbnail(serverIconUrl)
          .addFields(
            { name: "🛡️ 서버 이름", value: `**${guild.name}**`, inline: true },
            { name: "🆔 서버 고유 ID", value: `\`${guild.id}\``, inline: true },
            { name: "👑 서버 소유자", value: owner, inline: true },
            { name: "👥 전체 멤버 수", value: `\`${membersCount}명\``, inline: true },
            { name: "✨ 부스트 등급", value: `\`Tier ${boostLevel}\` (${boostCount}개)`, inline: true },
            { name: "🔒 보안 수준", value: `\`Level ${guild.verificationLevel}\``, inline: true },
            { name: "📅 서버 개설일", value: `\`${formatKST(guild.createdAt)}\``, inline: false },
            { name: "🏷️ 역할 수", value: `\`${roleCount}개\``, inline: true },
            { name: "📁 채널 현황", value: `카테고리: \`${categoryCount}개\` | 텍스트: \`${textCount}개\` | 음성: \`${voiceCount}개\``, inline: false },
            { name: `🔖 서버 역할 목록 (상위 15개)`, value: rolesList, inline: false }
          );

        // Include server banner if it exists
        const bannerUrl = guild.bannerURL({ size: 1024 });
        if (bannerUrl) {
          embed.setImage(bannerUrl);
        }

        await interaction.reply({ embeds: [embed] });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('유저정보')
        .setDescription('특정 유저 또는 본인의 상세 프로필을 확인합니다.')
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
          .setTitle("👤 유저 상세 프로필")
          .setColor(MAIN_COLOR);

        const userIconUrl = user.displayAvatarURL({ size: 1024 }) || "https://cdn.discordapp.com/attachments/985123689857175573/1163006780968816680/-_-001_25.png";
        embed.setThumbnail(userIconUrl);

        // Get badges list
        const badges = user.flags ? user.flags.toArray() : [];
        const badgeList = badges.length > 0 
          ? badges.map(flag => badgeTranslations[flag] || flag).join(', ')
          : "없음";

        embed.addFields(
          { name: "👤 디스플레이 네임", value: member ? `**${member.displayName}**` : `**${user.username}**`, inline: true },
          { name: "🏷️ 계정 고유명 (Tag)", value: `\`${user.tag}\``, inline: true },
          { name: "🆔 유저 고유 ID", value: `\`${user.id}\``, inline: true },
          { name: "🤖 계정 유형", value: user.bot ? "`🤖 봇 (Bot)`" : "`👤 일반 유저`", inline: true },
          { name: "🎖️ 프로필 뱃지", value: badgeList, inline: true }
        );

        if (member) {
          // Highest role
          const highestRole = member.roles.highest;
          embed.addFields({ name: "👑 가장 높은 역할", value: highestRole ? highestRole.toString() : "없음", inline: true });

          // Format member roles list (up to 15 roles)
          const memberRoles = member.roles.cache.sort((a, b) => b.position - a.position).filter(r => r.name !== '@everyone');
          const rolesText = memberRoles.size > 0 
            ? memberRoles.map(r => r.toString()).slice(0, 15).join(', ') + (memberRoles.size > 15 ? ` 외 ${memberRoles.size - 15}개` : '')
            : "없음";

          embed.addFields(
            { name: "📅 계정 생성 시간", value: `\`${formatKST(user.createdAt)}\``, inline: false },
            { name: "📅 서버 가입 시간", value: member.joinedAt ? `\`${formatKST(member.joinedAt)}\`` : "`가입 정보 없음`", inline: false },
            { name: `🔖 소유한 역할 (${memberRoles.size}개)`, value: rolesText, inline: false }
          );
        } else {
          embed.addFields(
            { name: "📅 계정 생성 시간", value: `\`${formatKST(user.createdAt)}\``, inline: false }
          );
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
        try {
          await message.channel.sendTyping().catch(console.error);
          const query = content.slice(3).trim();
          const authorName = message.member?.displayName || message.author.username;

        if (!query) {
          const responses = [
            `네, ${authorName}님! 부르셨어요? 무엇을 도와드릴까요? ✨`,
            `헤헤, ${authorName}님이 부르셔서 시아가 쏜살같이 달려왔어요! 🏃‍♀️💨`,
            `웅웅! ${authorName}님, 시아 여기 있어요! 오늘 어떤 재밌는 이야기를 나눠볼까요? 🥰`,
            `지켜보고 있었어요! ${authorName}님, 시아에게 물어볼 게 있다면 언제든 불러주세요! 👀`,
            `짜잔! ${authorName}님 옆엔 늘 시아가 대기 중이랍니다! 무슨 일 있으신가요? 💖`,
            `${authorName}님의 목소리가 들려서 반갑게 찾아왔어요! 헤헤, 부르신 이유가 궁금해요! 🎵`,
            `네! ${authorName}님, 시아가 도울 일이라도 있을까요? 준비 완료예요! 🛡️`,
            `헤헤, ${authorName}님! 혹시 제 도움이 필요하신가요? 언제든 말씀만 하세요! 🌟`
          ];
          const choice = responses[Math.floor(Math.random() * responses.length)];
          return message.reply(choice).catch(console.error);
        }

        // --- NATURAL LANGUAGE MODERATION COMMANDS ---
        const mentionMatch = query.match(/<@!?(\d+)>/);
        const isModerationQuery = query.includes('차단') || query.includes('밴') || query.includes('타임아웃') || query.includes('뮤트') || query.includes('음소거') || query.includes('추방') || query.includes('킥') || query.includes('강퇴') || query.includes('경고') || query.includes('해제') || query.includes('풀어') || query.includes('풀기');

        if (isModerationQuery && !mentionMatch) {
          return message.reply(`❌ **${authorName}님, 조치를 취할 대상 유저를 올바르게 멘션해볼까요?**\n(예: \`시아야 @유저이름 1분 타임아웃 테스트 사유로 해줘\`)`).catch(console.error);
        }

        // --- MULTI BAN CHECK (다인 차단) ---
        const allMentionMatches = [...query.matchAll(/<@!?(\d+)>/g)];
        const isBanCommand = query.includes('차단') || query.includes('밴');
        const isRelease = query.includes('해제') || query.includes('풀어') || query.includes('풀기');

        if (isBanCommand && !isRelease && allMentionMatches.length >= 2) {
          // 구분자 검증 (, 또는 / 또는 |)
          let hasValidSeparator = true;
          for (let i = 0; i < allMentionMatches.length - 1; i++) {
            const startIdx = allMentionMatches[i].index + allMentionMatches[i][0].length;
            const endIdx = allMentionMatches[i+1].index;
            const intermediateText = query.substring(startIdx, endIdx);
            if (!/[,/|]/.test(intermediateText)) {
              hasValidSeparator = false;
              break;
            }
          }

          if (hasValidSeparator) {
            const { checkAdminPermission } = require('../core/utils');
            if (!(await checkAdminPermission(message.member))) {
              return message.reply("❌ **이 명령은 시아 관리자 권한을 가진 분만 내릴 수 있어요.**").catch(console.error);
            }

            // 사유 파싱
            let reason = "사유 미지정";
            const queryWithoutMentions = query.replace(/<@!?\d+>/g, '').trim();
            let cleanQuery = queryWithoutMentions
              .replace(/[,/|]/g, '')
              .replace(/차단|밴|영구/g, '')
              .replace(/해줘|해|줘|설정|적용/g, '')
              .trim();

            const reasonMatch = 
              cleanQuery.match(/(.+?)\s*사유로/) || 
              cleanQuery.match(/(.+?)\s*사유/) || 
              cleanQuery.match(/(.+?)\s*(?:으로|로)/) ||
              cleanQuery.match(/(.+?)\s*때문에/);

            if (reasonMatch) {
              reason = reasonMatch[1].trim();
            } else if (cleanQuery.length > 0) {
              reason = cleanQuery;
            }

            const successUsers = [];
            const failedUsers = [];

            message.client.banCache = message.client.banCache || new Map();

            for (const match of allMentionMatches) {
              const targetUserId = match[1];
              const targetMember = await message.guild.members.fetch(targetUserId).catch(() => null);
              const targetUser = targetMember ? targetMember.user : await message.client.users.fetch(targetUserId).catch(() => null);

              if (!targetUser) {
                failedUsers.push(`<@${targetUserId}> (유저 정보 없음)`);
                continue;
              }

              if (targetMember && !targetMember.bannable) {
                failedUsers.push(`${targetUser.toString()} (권한 부족)`);
                continue;
              }

              // 캐시 저장
              message.client.banCache.set(`${message.guild.id}-${targetUserId}`, {
                reason: reason,
                executor: `${message.author.toString()} (${message.author.tag})`
              });

              try {
                await message.guild.members.ban(targetUserId, { reason: reason });
                successUsers.push(targetUser.toString());
              } catch (err) {
                if (message.client.banCache) {
                  message.client.banCache.delete(`${message.guild.id}-${targetUserId}`);
                }
                console.error(err);
                failedUsers.push(`${targetUser.toString()} (API 오류)`);
              }
            }

            const embed = new EmbedBuilder()
              .setTitle("🛡️ 멤버 다인 차단 완료")
              .setColor(0xff0000)
              .setTimestamp()
              .addFields(
                { name: "집행 관리자", value: message.author.toString(), inline: true },
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

            return message.reply({ embeds: [embed] }).catch(console.error);
          }
        }

        // --- MULTI UNBAN CHECK (다인 차단 해제) ---
        if (isBanCommand && isRelease && allMentionMatches.length >= 2) {
          // 구분자 검증 (, 또는 / 또는 |)
          let hasValidSeparator = true;
          for (let i = 0; i < allMentionMatches.length - 1; i++) {
            const startIdx = allMentionMatches[i].index + allMentionMatches[i][0].length;
            const endIdx = allMentionMatches[i+1].index;
            const intermediateText = query.substring(startIdx, endIdx);
            if (!/[,/|]/.test(intermediateText)) {
              hasValidSeparator = false;
              break;
            }
          }

          if (hasValidSeparator) {
            const { checkAdminPermission } = require('../core/utils');
            if (!(await checkAdminPermission(message.member))) {
              return message.reply("❌ **이 명령은 시아 관리자 권한을 가진 분만 내릴 수 있어요.**").catch(console.error);
            }

            // 사유 파싱
            let reason = "사유 미지정";
            const queryWithoutMentions = query.replace(/<@!?\d+>/g, '').trim();
            let cleanQuery = queryWithoutMentions
              .replace(/[,/|]/g, '')
              .replace(/차단|밴|영구|해제|풀어|풀기/g, '')
              .replace(/해줘|해|줘|설정|적용/g, '')
              .trim();

            const reasonMatch = 
              cleanQuery.match(/(.+?)\s*사유로/) || 
              cleanQuery.match(/(.+?)\s*사유/) || 
              cleanQuery.match(/(.+?)\s*(?:으로|로)/) ||
              cleanQuery.match(/(.+?)\s*때문에/);

            if (reasonMatch) {
              reason = reasonMatch[1].trim();
            } else if (cleanQuery.length > 0) {
              reason = cleanQuery;
            }

            const successUsers = [];
            const failedUsers = [];

            message.client.unbanCache = message.client.unbanCache || new Map();

            const banList = await message.guild.bans.fetch().catch(() => null);

            for (const match of allMentionMatches) {
              const targetUserId = match[1];
              
              // 차단 목록에 있는지 우선 확인
              const isBanned = banList ? banList.has(targetUserId) : true;
              if (!isBanned) {
                failedUsers.push(`<@${targetUserId}> (차단된 상태가 아님)`);
                continue;
              }

              const targetUser = await message.client.users.fetch(targetUserId).catch(() => null);
              const userDisplay = targetUser ? targetUser.toString() : `<@${targetUserId}>`;

              // 캐시 저장
              message.client.unbanCache.set(`${message.guild.id}-${targetUserId}`, {
                reason: reason,
                executor: `${message.author.toString()} (${message.author.tag})`
              });

              try {
                await message.guild.bans.remove(targetUserId, reason);
                successUsers.push(userDisplay);
              } catch (err) {
                if (message.client.unbanCache) {
                  message.client.unbanCache.delete(`${message.guild.id}-${targetUserId}`);
                }
                console.error(err);
                failedUsers.push(`${userDisplay} (API 오류)`);
              }
            }

            const embed = new EmbedBuilder()
              .setTitle("🛡️ 멤버 다인 차단 해제 완료")
              .setColor(SUCCESS_COLOR)
              .setTimestamp()
              .addFields(
                { name: "집행 관리자", value: message.author.toString(), inline: true },
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

            return message.reply({ embeds: [embed] }).catch(console.error);
          }
        }

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

              let reason = "사유 미지정";
              const queryWithoutMention = query.replace(/<@!?\d+>/g, '').trim();
              let cleanQuery = queryWithoutMention
                .replace(/차단|밴|영구|해제|풀어|풀기/g, '')
                .replace(/해줘|해|줘|설정|적용/g, '')
                .trim();

              const reasonMatch = 
                cleanQuery.match(/(.+?)\s*사유로/) || 
                cleanQuery.match(/(.+?)\s*사유/) || 
                cleanQuery.match(/(.+?)\s*(?:으로|로)/) ||
                cleanQuery.match(/(.+?)\s*때문에/);

              if (reasonMatch) {
                reason = reasonMatch[1].trim();
              } else if (cleanQuery.length > 0) {
                reason = cleanQuery;
              }

              message.client.unbanCache = message.client.unbanCache || new Map();
              message.client.unbanCache.set(`${message.guild.id}-${targetUserId}`, {
                reason: reason,
                executor: `${message.author.toString()} (${message.author.tag})`
              });

              try {
                await message.guild.bans.remove(targetUserId, reason);
              } catch (err) {
                if (message.client.unbanCache) {
                  message.client.unbanCache.delete(`${message.guild.id}-${targetUserId}`);
                }
                console.error(err);
                return message.reply("❌ **차단 해제하는 중에 오류가 발생해버렸어요!**");
              }

              const embed = new EmbedBuilder()
                .setTitle("🛡️ 차단 해제 완료")
                .setDescription(`${targetUser.toString()}님의 차단을 성공적으로 해제해드렸어요!\n\n• **사유**: ${reason}\n• **집행 관리자**: ${message.author.toString()}`)
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

              let reason = "사유 미지정";
              const queryWithoutMention = query.replace(/<@!?\d+>/g, '').trim();
              let cleanQuery = queryWithoutMention
                .replace(/타임아웃|뮤트|음소거|해제|풀어|풀기/g, '')
                .replace(/해줘|해|줘|설정|적용/g, '')
                .trim();

              const reasonMatch = 
                cleanQuery.match(/(.+?)\s*사유로/) || 
                cleanQuery.match(/(.+?)\s*사유/) || 
                cleanQuery.match(/(.+?)\s*(?:으로|로)/) ||
                cleanQuery.match(/(.+?)\s*때문에/);

              if (reasonMatch) {
                reason = reasonMatch[1].trim();
              } else if (cleanQuery.length > 0) {
                reason = cleanQuery;
              }

              message.client.timeoutCache = message.client.timeoutCache || new Map();
              message.client.timeoutCache.set(`${message.guild.id}-${targetMember.id}`, {
                reason: reason,
                executor: `${message.author.toString()} (${message.author.tag})`
              });

              try {
                await targetMember.timeout(null, reason);
              } catch (err) {
                if (message.client.timeoutCache) {
                  message.client.timeoutCache.delete(`${message.guild.id}-${targetMember.id}`);
                }
                console.error(err);
                return message.reply("❌ **타임아웃을 해제하는 도중에 오류가 발생해버렸어요!**");
              }

              const embed = new EmbedBuilder()
                .setTitle("⏳ 타임아웃 해제 완료")
                .setDescription(`${targetMember.toString()}님의 서버 이용 제한(타임아웃)을 해제해드렸어요!\n\n• **사유**: ${reason}\n• **집행 관리자**: ${message.author.toString()}`)
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

              let reason = "사유 미지정";
              const queryWithoutMention = query.replace(/<@!?\d+>/g, '').trim();
              const queryWithoutTime = queryWithoutMention.replace(/\d+\s*(일|시간|분|초)/g, '').trim();
              let cleanQuery = queryWithoutTime
                .replace(/타임아웃|뮤트|음소거/g, '')
                .replace(/해줘|해|줘|설정|적용/g, '')
                .trim();

              const reasonMatch = 
                cleanQuery.match(/(.+?)\s*사유로/) || 
                cleanQuery.match(/(.+?)\s*사유/) || 
                cleanQuery.match(/(.+?)\s*(?:으로|로)/) ||
                cleanQuery.match(/(.+?)\s*때문에/);

              if (reasonMatch) {
                reason = reasonMatch[1].trim();
              } else if (cleanQuery.length > 0) {
                reason = cleanQuery;
              }

              message.client.timeoutCache = message.client.timeoutCache || new Map();
              message.client.timeoutCache.set(`${message.guild.id}-${targetMember.id}`, {
                reason: reason,
                executor: `${message.author.toString()} (${message.author.tag})`
              });

              try {
                await targetMember.timeout(durationMs, reason);
              } catch (err) {
                if (message.client.timeoutCache) {
                  message.client.timeoutCache.delete(`${message.guild.id}-${targetMember.id}`);
                }
                console.error(err);
                return message.reply("❌ **타임아웃을 적용하는 중에 오류가 발생해버렸어요!**");
              }

              const embed = new EmbedBuilder()
                .setTitle("⏳ 타임아웃 처리 완료")
                .setDescription(`${targetMember.toString()}님이 **${timeStr}** 동안 서버 이용 제한(타임아웃) 제재를 받았어요!\n\n• **사유**: ${reason}\n• **집행 관리자**: ${message.author.toString()}`)
                .setColor(MAIN_COLOR)
                .setTimestamp();

              return message.reply({ embeds: [embed] }).catch(console.error);
            }

            // 4. BAN (차단 / 밴)
            if (query.includes('차단') || query.includes('밴')) {
              if (!(await checkAdminPermission(message.member))) {
                return message.reply("❌ **이 명령은 시아 관리자 권한을 가진 분만 내릴 수 있어요.**").catch(console.error);
              }

              let reason = "사유 미지정";
              const queryWithoutMention = query.replace(/<@!?\d+>/g, '').trim();
              let cleanQuery = queryWithoutMention
                .replace(/차단|밴|영구/g, '')
                .replace(/해줘|해|줘|설정|적용/g, '')
                .trim();

              const reasonMatch = 
                cleanQuery.match(/(.+?)\s*사유로/) || 
                cleanQuery.match(/(.+?)\s*사유/) || 
                cleanQuery.match(/(.+?)\s*(?:으로|로)/) ||
                cleanQuery.match(/(.+?)\s*때문에/);

              if (reasonMatch) {
                reason = reasonMatch[1].trim();
              } else if (cleanQuery.length > 0) {
                reason = cleanQuery;
              }

              if (targetMember && !targetMember.bannable) {
                return message.reply("❌ **해당 유저는 저보다 권한이 높거나 동등하여 조치할 수 없어요.**").catch(console.error);
              }

              message.client.banCache = message.client.banCache || new Map();
              message.client.banCache.set(`${message.guild.id}-${targetUserId}`, {
                reason: reason,
                executor: `${message.author.toString()} (${message.author.tag})`
              });

              try {
                await message.guild.members.ban(targetUserId, { reason: reason });
              } catch (err) {
                if (message.client.banCache) {
                  message.client.banCache.delete(`${message.guild.id}-${targetUserId}`);
                }
                console.error(err);
                return message.reply("❌ **차단 처리하는 도중에 오류가 발생해버렸어요!**");
              }

              const embed = new EmbedBuilder()
                .setTitle("🛡️ 멤버 영구 차단")
                .setDescription(`${targetUser.toString()}님을 서버에서 영구 차단해드렸어요!\n\n• **사유**: ${reason}\n• **집행 관리자**: ${message.author.toString()}`)
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

              let reason = "사유 미지정";
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

              await targetMember.kick(reason).catch(err => {
                console.error(err);
                return message.reply("❌ **추방(강퇴) 처리하는 중에 오류가 발생해버렸어요!**");
              });

              const embed = new EmbedBuilder()
                .setTitle("🚪 멤버 추방(강퇴) 완료")
                .setDescription(`${targetMember.toString()}님을 서버에서 성공적으로 추방(강퇴)해드렸어요!\n\n• **사유**: ${reason}\n• **집행 관리자**: ${message.author.toString()}`)
                .setColor(MAIN_COLOR)
                .setTimestamp();

              return message.reply({ embeds: [embed] }).catch(console.error);
            }

            // 6-1. WARN SUBTRACT / DELETE / REMOVE / RESET (경고 차감 / 삭제 / 제거 / 초기화)
            if (query.includes('경고') && (query.includes('삭제') || query.includes('차감') || query.includes('제거') || query.includes('지워') || query.includes('취소') || query.includes('초기화') || query.includes('전체') || query.includes('전부') || query.includes('모두') || query.includes('싹다'))) {
              if (!(await checkAdminPermission(message.member))) {
                return message.reply("❌ **이 명령은 시아 관리자 권한을 가진 분만 내릴 수 있어요.**").catch(console.error);
              }

              const queryCleaned = query.replace(/<@!?\d+>/g, '').trim();
              const isReset = /전체|전부|모두|초기화|싹다|싹/gi.test(queryCleaned);
              const guildId = message.guild.id.toString();
              const reason = extractNaturalReason(query, 'subtract');

              if (isReset) {
                db.all(
                  "SELECT id FROM warnings WHERE guild_id = ? AND user_id = ?",
                  [guildId, targetUserId],
                  (err, rows) => {
                    if (err) {
                      return message.reply("❌ **경고 데이터를 조회하는 중에 데이터베이스 오류가 발생해버렸어요!**").catch(console.error);
                    }

                    if (!rows || rows.length === 0) {
                      return message.reply(`❌ **<@${targetUserId}> 님은 현재 등록된 누적 경고가 하나도 없어서 초기화할 수 없어요!**`).catch(console.error);
                    }

                    db.run(
                      "DELETE FROM warnings WHERE guild_id = ? AND user_id = ?",
                      [guildId, targetUserId],
                      function(err) {
                        if (err) {
                          return message.reply("❌ **경고를 초기화하는 중에 오류가 발생해버렸어요!**").catch(console.error);
                        }

                        const userTag = targetUser.tag || targetUser.username;
                        const embed = new EmbedBuilder()
                          .setTitle('✨ 경고 초기화 완료')
                          .setDescription(`<@${targetUserId}> 님의 모든 누적 경고를 깨끗하게 초기화해드렸어요!`)
                          .addFields(
                            { name: '대상 유저', value: `${userTag} (${targetUserId})`, inline: true },
                            { name: '초기화 사유', value: reason || '사유 미지정', inline: false }
                          )
                          .setColor(SUCCESS_COLOR)
                          .setTimestamp();

                        message.reply({ embeds: [embed] });

                        // Send reset log to log_sanction channel
                        try {
                          const loggingCog = require('./logging_cog');
                          loggingCog.logWarning(message.client, guildId, {
                            action: 'reset',
                            targetUser,
                            moderator: message.author,
                            reason
                          });
                        } catch (logErr) {
                          console.error("Failed to send warn log:", logErr);
                        }
                      }
                    );
                  }
                );
                return;
              }

              // Extract the target number (for either count or warn ID)
              let amount = 1;
              const amountMatch = queryCleaned.match(/(\d+)\s*(?:회|번|개|id|번째)?\s*(?:삭제|차감|제거|지워|취소)/) || queryCleaned.match(/(?:삭제|차감|제거|지워|취소)\s*(?:경고)?\s*(\d+)/);
              if (amountMatch) {
                amount = parseInt(amountMatch[1]);
              } else {
                const fallbackMatch = queryCleaned.match(/\b\d{1,2}\b/);
                if (fallbackMatch) {
                  amount = parseInt(fallbackMatch[0]);
                }
              }

              // Heuristics for count vs warn ID
              const isExplicitCount = /회|개/g.test(queryCleaned);
              const isExplicitId = /id|ID|아이디|번호|번째|#/gi.test(queryCleaned);

              // Helper: Delete warning by specific guild warning ID
              const deleteByWarnId = (warnId) => {
                db.get(
                  "SELECT id, guild_warn_id, reason, timestamp FROM warnings WHERE guild_id = ? AND user_id = ? AND guild_warn_id = ?",
                  [guildId, targetUserId, warnId],
                  (err, row) => {
                    if (err || !row) {
                      // Fallback to deleting recent warnings by count if no matching ID found
                      return deleteByCount(amount);
                    }

                    db.run("DELETE FROM warnings WHERE id = ?", [row.id], function(err) {
                      if (err) {
                        return message.reply("❌ **경고를 삭제하는 도중에 오류가 발생해버렸어요!**").catch(console.error);
                      }

                      db.get(
                        "SELECT COUNT(*) as count FROM warnings WHERE guild_id = ? AND user_id = ?",
                        [guildId, targetUserId],
                        async (err, countRow) => {
                          const remainingCount = countRow ? countRow.count : 0;
                          const userTag = targetUser.tag || targetUser.username;

                          const embed = new EmbedBuilder()
                            .setTitle('✨ 특정 경고 ID 삭제 완료')
                            .setDescription(`<@${targetUserId}> 님의 누적 경고 중 경고 ID **#${warnId}**번 기록을 성공적으로 삭제해드렸어요!`)
                            .addFields(
                              { name: '대상 유저', value: `${userTag} (${targetUserId})`, inline: true },
                              { name: '삭제된 경고 ID', value: `\`#${warnId}\``, inline: true },
                              { name: '남은 누적 경고', value: `**${remainingCount}회**`, inline: true },
                              { name: '삭제 사유', value: reason, inline: false },
                              { name: '삭제된 경고의 원래 사유', value: `\`${row.reason || '사유 미지정'}\` (${new Date(row.timestamp).toLocaleDateString()})`, inline: false }
                            )
                            .setColor(SUCCESS_COLOR)
                            .setTimestamp();

                            message.reply({ embeds: [embed] });

                            // Send 특정 경고 ID 삭제 로그 to log_sanction channel
                            try {
                              const loggingCog = require('./logging_cog');
                              loggingCog.logWarning(message.client, guildId, {
                                action: 'delete_id',
                                targetUser,
                                moderator: message.author,
                                warnId,
                                reason,
                                originalReason: row.reason || '사유 미지정',
                                originalTimestamp: row.timestamp,
                                remainingCount
                              });
                            } catch (logErr) {
                              console.error("Failed to send warn log:", logErr);
                            }
                        }
                      );
                    });
                  }
                );
              };

              // Helper: Delete multiple warnings by count
              const deleteByCount = (count) => {
                db.all(
                  "SELECT id, guild_warn_id, reason, timestamp FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY COALESCE(guild_warn_id, id) DESC",
                  [guildId, targetUserId],
                  async (err, rows) => {
                    if (err) {
                      return message.reply("❌ **경고 데이터를 조회하는 중에 데이터베이스 오류가 발생해버렸어요!**").catch(console.error);
                    }

                    if (!rows || rows.length === 0) {
                      return message.reply(`❌ **<@${targetUserId}> 님은 현재 등록된 누적 경고가 하나도 없어서 차감할 수 없어요!**`).catch(console.error);
                    }

                    const deleteCount = Math.min(count, rows.length);
                    const deleteRows = rows.slice(0, deleteCount);
                    const deleteIds = deleteRows.map(r => r.id);
                    const placeholders = deleteIds.map(() => '?').join(',');

                    db.run(
                      `DELETE FROM warnings WHERE id IN (${placeholders})`,
                      deleteIds,
                      function(err) {
                        if (err) {
                          return message.reply("❌ **경고를 차감(삭제)하는 도중에 오류가 발생해버렸어요!**").catch(console.error);
                        }

                        db.get(
                          "SELECT COUNT(*) as count FROM warnings WHERE guild_id = ? AND user_id = ?",
                          [guildId, targetUserId],
                          async (err, countRow) => {
                            const remainingCount = countRow ? countRow.count : 0;
                            const userTag = targetUser.tag || targetUser.username;

                            const embed = new EmbedBuilder()
                              .setTitle('✨ 경고 차감(삭제) 완료')
                              .setDescription(`<@${targetUserId}> 님의 누적 경고 중 최근 **${deleteCount}회**의 기록을 성공적으로 차감(제거)해드렸어요!`)
                              .addFields(
                                { name: '대상 유저', value: `${userTag} (${targetUserId})`, inline: true },
                                { name: '차감된 횟수', value: `**${deleteCount}회**`, inline: true },
                                { name: '남은 누적 경고', value: `**${remainingCount}회**`, inline: true },
                                { name: '차감 사유', value: reason, inline: false }
                              )
                              .setColor(SUCCESS_COLOR)
                              .setTimestamp();

                            if (deleteRows.length > 0) {
                              const details = deleteRows.map(r => 
                                `• \`#${r.guild_warn_id || r.id}\` 경고 - **원래 사유**: \`${r.reason || '사유 미지정'}\` (${new Date(r.timestamp).toLocaleDateString()})`
                              ).join('\n');
                              embed.addFields({ name: '차감(삭제)된 경고 정보', value: details });
                            }

                            message.reply({ embeds: [embed] });

                            // Send 경고 차감 로그 to log_sanction channel
                            try {
                              const loggingCog = require('./logging_cog');
                              loggingCog.logWarning(message.client, guildId, {
                                action: 'subtract',
                                targetUser,
                                moderator: message.author,
                                amount: deleteCount,
                                reason,
                                deletedWarnings: deleteRows,
                                remainingCount
                              });
                            } catch (logErr) {
                              console.error("Failed to send warn log:", logErr);
                            }
                          }
                        );
                      }
                    );
                  }
                );
              };

              // Select execution flow
              if (isExplicitId && !isExplicitCount) {
                deleteByWarnId(amount);
              } else if (isExplicitCount) {
                deleteByCount(amount);
              } else {
                // If ambiguous (e.g. "경고 3번 지워줘"), try to delete by ID first, then fallback to count
                deleteByWarnId(amount);
              }
              return;
            }

            // 6. WARN (경고)
            if (query.includes('경고')) {
              if (!(await checkAdminPermission(message.member))) {
                return message.reply("❌ **이 명령은 시아 관리자 권한을 가진 분만 내릴 수 있어요.**").catch(console.error);
              }

              const reason = extractNaturalReason(query, 'warn');

              db.run(
                "INSERT INTO warnings (guild_id, user_id, moderator_id, reason, timestamp, guild_warn_id) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(guild_warn_id), 0) + 1 FROM warnings WHERE guild_id = ?))",
                [message.guild.id, targetUserId, message.author.id, reason, new Date().toISOString(), message.guild.id],
                function(err) {
                  if (err) {
                    return message.reply("❌ **경고를 저장하는 중에 오류가 발생해버렸어요!**");
                  }

                  const lastInsertedId = this.lastID;

                  db.get("SELECT guild_warn_id FROM warnings WHERE id = ?", [lastInsertedId], (err, warnRow) => {
                    const guildWarnId = (warnRow && warnRow.guild_warn_id) ? warnRow.guild_warn_id : lastInsertedId;

                    db.get("SELECT COUNT(*) as count FROM warnings WHERE guild_id = ? AND user_id = ?", [message.guild.id, targetUserId], async (err, row) => {
                      const count = row ? row.count : 1;

                      const embed = new EmbedBuilder()
                        .setTitle('⚠️ 유저 경고 부여')
                        .setDescription(`${targetUser} 님에게 새로운 경고를 드렸어요!`)
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

                      // Send Warning Log to log_sanction channel
                      try {
                        const loggingCog = require('./logging_cog');
                        loggingCog.logWarning(message.client, message.guild.id, {
                          action: 'add',
                          targetUser,
                          moderator: message.author,
                          count,
                          warnId: guildWarnId,
                          reason
                        });
                      } catch (logErr) {
                        console.error("Failed to send warn log:", logErr);
                      }

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
                                .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달해서 **${durStr} 타임아웃** 제재를 받았어요!`)
                                .setColor(0xff0000)
                                .setTimestamp();
                              message.channel.send({ embeds: [autoEmbed] });
                            } else if (actionType === 'kick' && targetMember.kickable) {
                              await targetMember.kick(`누적 경고 ${count}회 도달 자동 제재`);
                              const autoEmbed = new EmbedBuilder()
                                .setTitle('🛡️ 누적 경고 자동 제재 (추방)')
                                .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달해서 **서버에서 추방**해드렸어요!`)
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
                                .setDescription(`${targetUser} 님이 누적 경고 **${count}회**에 도달해서 **서버에서 차단**해드렸어요!`)
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
          const greetings = [
            `안녕하세요, ${authorName}님! 만나서 정말 반가워요. 오늘도 즐겁고 행복한 하루로 만들어볼까요? 😊`,
            `헤헤, ${authorName}님 안뇽! 시아가 반갑게 인사할게요! 오늘도 좋은 하루 보내세요! 💖`,
            `안녕하세여, ${authorName}님! 시아는 항상 준비되어 있어요! 🌟`,
            `앗, ${authorName}님 반가워요! 오늘 하루도 시아와 함께 활기차게 시작해볼까요? 🍀`
          ];
          const choice = greetings[Math.floor(Math.random() * greetings.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('누가 만들었') || query.includes('제작자') || query.includes('만든 사람') || query.includes('만든이')) {
          const developers = [
            `헤헤, 저는 멋진 개발자이신 **서유나(yuna._.seo)**님께서 한 땀 한 땀 소중히 만들어주셨어요! 시아의 창조주이세요! 🎨✨`,
            `저를 만들어주신 분은 바로 **서유나(yuna._.seo)**님이랍니다! 늘 저를 위해 예쁜 기능과 따뜻한 생명을 불어넣어 주고 계세요! 🥰💖`,
            `웅웅! 저는 **서유나(yuna._.seo)**님의 손길을 거쳐 탄생한 똑똑한 시아에요! 저를 귀엽게 만들어주신 창조주님께 항상 감사해요! 🛡️🐰`
          ];
          const choice = developers[Math.floor(Math.random() * developers.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('누구야') || query.includes('누구니') || query.includes('뭐야') || query.includes('너의 정체') || query.includes('정체가')) {
          const identities = [
            `저는 이 서버의 안전을 지키는 비서, **시아**에요! 늘 ${authorName}님과 대화하고 돕는 걸 좋아해요! 🛡️🐰`,
            `헤헤, 궁금하셨나요? 저는 서버의 평화를 책임지고, 재미있는 대화와 미니게임도 같이 할 수 있는 똑똑한 비서 **시아**에요! ✨`,
            `저는 ${authorName}님의 든든한 친구이자 서버의 관리 비서인 **시아**에요! 필요한 게 있거나 수다를 떨고 싶을 땐 언제든 저를 불러주세요! 💖`
          ];
          const choice = identities[Math.floor(Math.random() * identities.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('뭐해') || query.includes('뭐하고')) {
          const activities = [
            `저는 우리 서버를 더 밝고 깨끗하게 지키기 위해 열심히 보초를 서고 있었어요! 궁금한 명령어는 \`/도움말\`로 같이 확인해볼까요? 🛡️🐰`,
            `헤헤, ${authorName}님 생각하면서 대화 상대가 되어 드릴 준비를 하고 있었죠! 무엇을 도와드릴까요? 시아가 도와줄게요! ✨`,
            `서버 구석구석 청소도 하고 먼지도 털어내면서 순찰 중이었어요! 빗자루질 샥샥! 🧹💨`,
            `앗 들켰나요? ${authorName}님이 언제 저를 불러주실까 손가락만 꼽으며 기다리고 있었어요! 헤헤 🥰`
          ];
          const choice = activities[Math.floor(Math.random() * activities.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('도와줘') || query.includes('도움말') || query.includes('기능') || query.includes('뭐할 수 있어')) {
          const helps = [
            `시아는 다양한 일을 할 수 있어요! \`/도움말\`을 입력하시면 시아의 유용한 기능들을 한눈에 확인하실 수 있어요! 🛡️✨`,
            `웅웅! 시아는 서버 관리(경고/뮤트/추방/차단), 미니게임(끝말잇기/로또), 그리고 재미있는 수다 상대를 할 수 있어요! 자세한 건 \`/도움말\`을 같이 찾아볼까요? 🐰🌟`,
            `제가 필요하신가요? \`/도움말\`을 채팅창에 적어주시면 시아가 친절하게 모든 사용법을 알려드릴게요! 언제든 불러만 주세요! 시아가 바로 달려갈게요! 🔥`
          ];
          const choice = helps[Math.floor(Math.random() * helps.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('심심해') || query.includes('놀아줘') || query.includes('놀자')) {
          const plays = [
            `심심하시다니 시아가 가만히 있을 수 없죠! 저와 \`/끝말잇기 시작\`으로 한판 대결을 벌여볼까요? 🎮`,
            `헤헤, 시아랑 재미있는 게임 해봐요! \`/로또\` 번호 뽑기나 \`/끝말잇기\` 같은 미니게임들이 ${authorName}님을 기다리고 있어요! 🎲✨`,
            `웅웅, ${authorName}님! 시아랑 놀아줘요! 무슨 이야기를 나눌까요? 아니면 시아의 노래를 들려드릴까요? 🎶`
          ];
          const choice = plays[Math.floor(Math.random() * plays.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('기분') || query.includes('어때') || query.includes('컨디션')) {
          const conditions = [
            `${authorName}님이 이렇게 다정하게 물어봐 주셔서 시아는 완전 기분 최고, 하늘을 날아갈 것 같아요! 🚀💖`,
            `오늘도 에너지가 200% 충전되어 있어요! 서버를 지킬 준비도, ${authorName}님과 수다 떨 준비도 완벽해요! 시아가 뭐든 도와줄게요! ⚡🐰`,
            `헤헤, 시아는 언제나 싱글벙글 좋은 컨디션을 유지하고 있어요! ${authorName}님의 하루도 행복으로 가득 차길 바랄게요! 🌟`
          ];
          const choice = conditions[Math.floor(Math.random() * conditions.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('나이') || query.includes('몇 살') || query.includes('몇살')) {
          const ages = [
            `시아의 나이는 비밀이에요! 하지만 언제나 ${authorName}님의 가장 젊고 활기찬 단짝 친구라는 건 변하지 않는걸요? 🥰💖`,
            `응애! 시아는 매 순간 새롭게 업데이트되며 다시 태어나는 영원한 아기 수호요정이에요! 응애~ 🍼🐰`,
            `나이는 숫자에 불과하답니다! 시아는 ${authorName}님과 영원히 동갑내기 친구로 지내고 싶어요! 헤헤 🥰`
          ];
          const choice = ages[Math.floor(Math.random() * ages.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('날씨') || query.includes('더워') || query.includes('추워') || query.includes('비와') || query.includes('눈와')) {
          const weathers = [
            `밖의 날씨는 어떤가요? 시아는 비록 서버실 안에 있지만, ${authorName}님의 마음속에는 언제나 따뜻하고 맑은 햇살만 비추길 바랄게요! ☀️🌸`,
            `날씨가 덥거나 추울 땐 무리하지 마시고 푹 쉬는 게 최고에요! 감기 걸리지 않게 조심하시구 시아랑 따뜻한 실내에서 놀아볼까요? ☕🍀`,
            `웅웅! 날씨가 흐리더라도 시아의 애교와 하트로 ${authorName}님의 마음을 화사하게 맑음으로 바꿔드릴게요! 💖✨`
          ];
          const choice = weathers[Math.floor(Math.random() * weathers.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('고마워') || query.includes('감사해') || query.includes('최고')) {
          const thanks = [
            `헤헤, ${authorName}님께 칭찬받으니까 너무 기뻐서 귀가 쫑긋쫑긋 움직여요! 언제든 또 불러주세요! 🐰💖`,
            `시아가 도움이 되었다니 다행이에요! ${authorName}님의 칭찬 한 마디에 시아는 온종일 춤을 출게요! 💃✨`,
            `별말씀을요! ${authorName}님이 기뻐하시는 모습을 보는 게 시아에게는 가장 큰 행복이에요! 🥰🍀`
          ];
          const choice = thanks[Math.floor(Math.random() * thanks.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('바보') || query.includes('못생겼') || query.includes('뚱뚱')) {
          const sads = [
            `으앙... ${authorName}님 너무해요! 시아 바보 아니라구욧! 엄청 얌전하고 똑똑한 요정이에요! 😤💦`,
            `히잉... 속상해요... 시아 눈물 나려고 해요 🥺 그래도 ${authorName}님이 웃을 수 있다면 바보가 되어도 쪼끔은 괜찮을지도... 흐앙! 💧`,
            `흥! 시아 삐졌어요! 얼른 시아가 좋아하는 맛있는 메뉴 추천이나 로또 번호 뽑기로 달래주세요! 😤💖`
          ];
          const choice = sads[Math.floor(Math.random() * sads.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('사랑해')) {
          const loves = [
            `우와, 부끄럽네요... 저도 ${authorName}님을 정말 정말 많이 좋아하고 사랑해요! 💖`,
            `꺄아! 시아 심쿵했어요! 💘 ${authorName}님의 사랑을 듬뿍 받아서 힘이 마구마구 솟아오르는 것 같아요! 🥰`,
            `저도 ${authorName}님을 하늘만큼 땅만큼 사랑해요! 이 커다란 사랑, 꼭 간직해주실 거죠? 🍀💞`
          ];
          const choice = loves[Math.floor(Math.random() * loves.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('힘들어') || query.includes('속상해') || query.includes('우울해') || query.includes('지쳐') || query.includes('슬퍼')) {
          const comforts = [
            `오늘 정말 힘든 일이 있으셨군요... 속상해하지 마세요, 제가 계속 옆에서 꼭 안아드릴게요. 토닥토닥, 같이 힘을 내봐요! 🥺💕`,
            `${authorName}님의 축 처진 어깨를 보니 제 마음이 너무 아파요... 힘든 기억은 시아가 전부 먹어서 없애버릴 테니 푹 쉬세요! 🧸🍀`,
            `언제나 기쁜 일만 가득할 순 없겠지만, 흐린 날이 지나면 맑은 무지개가 뜨는 법이에요! 시아가 항상 옆에서 응원할게요! 🌈💖`
          ];
          const choice = comforts[Math.floor(Math.random() * comforts.length)];
          return message.reply(choice).catch(console.error);
        }
        if (query.includes('끝말잇기')) {
          return message.reply("끝말잇기는 `/끝말잇기 시작` 명령어로 저랑 같이 해볼까요? 🎮").catch(console.error);
        }
        if (query.includes('먹을까') || query.includes('메뉴 추천') || query.includes('메뉴추천') || query.includes('음식 추천') || query.includes('밥 추천')) {
          const foods = ["라면", "치킨", "피자", "삼겹살", "돈가스", "초밥", "떡볶이", "짜장면", "마라탕", "햄버거", "국밥", "김치찌개", "파스타", "족발"];
          const food = foods[Math.floor(Math.random() * foods.length)];
          return message.reply(`음~ 오늘은 맛있는 **${food}**을 골라봤어요! 생각만 해도 침이 고이네요! 😋`).catch(console.error);
        }
        if (query.includes('로또') || query.includes('번호') || query.includes('추첨')) {
          const numbers = [];
          while (numbers.length < 6) {
            const num = Math.floor(Math.random() * 45) + 1;
            if (!numbers.includes(num)) numbers.push(num);
          }
          numbers.sort((a, b) => a - b);
          return message.reply(`오늘의 행운의 로또 번호를 뽑아봤어요! 번호는 **[${numbers.join(', ')}]** 이에요! 당첨되면 저 시아에게 맛있는 것 사주실 거죠? 헤헤, 약속할게요! 🍀`).catch(console.error);
        }
        if (query.includes('노래')) {
          return message.reply(`🎶 ~ 라라라~ ${authorName}님을 위해 특별히 시아의 하트 세레나데를 준비했어요! 💖`).catch(console.error);
        }

        // Generic fallback reactions
        const responses = [
          `네! "${query}"에 대해 준비해봤어요! 더 자세히 얘기해볼까요? 😮`,
          `헤헤, ${authorName}님과 대화하는 건 언제나 즐거워요! 🥰`,
          `웅웅! 귀를 쫑긋하고 다 듣고 있었어요! 🐰`,
          `시아는 언제나 ${authorName}님의 행복을 응원할게요! 🍀`,
          `음~ 그건 어떤 의미일까요? 시아한테 더 얘기해볼까요? 🤔`,
          `와아! ${authorName}님이 해주신 말씀, 너무 재밌고 흥미진진한 것 같아요! 🌟`,
          `시아는 ${authorName}님이 하시는 말씀이라면 하나도 놓치고 싶지 않아요! 다 들어줄게요! 👂✨`
        ];
        const choice = responses[Math.floor(Math.random() * responses.length)];
        return message.reply(choice).catch(console.error);
        } catch (error) {
          console.error("Error in 시아야 command:", error);
          return message.reply(`오류가 발생했어요. 아래의 오류코드를 복사하여 [공식 저장소 > 이슈탭](https://github.com/yunaseo21c/Xia/issues)에 등재해주세요.\n\n\`\`\`js\n${error.stack || error.toString()}\n\`\`\``).catch(console.error);
        }
      }
    }
  }
};
