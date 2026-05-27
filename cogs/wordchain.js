const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { MAIN_COLOR, SUCCESS_COLOR, ERROR_COLOR, PERMISSION_ERROR_EMBED } = require('../core/config');
const { checkAdminPermission } = require('../core/utils');

// Shared Database Setup
const dbPath = path.join(process.cwd(), 'xiadb.db');
const db = new sqlite3.Database(dbPath);
db.configure("busyTimeout", 5000);

// Initialize Wordchain Tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS wordchain_scores (
    user_id TEXT,
    guild_id TEXT,
    max_score INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, guild_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS wordchain_settings (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT
  )`);
});

// Load the massive Korean standard dictionary containing 320,000+ words
const dictionary = require('../core/dictionary.json');

// 두음법칙 Map (Initial Sound Rule adjustments)
const soundLaw = {
  "라": "나", "락": "낙", "란": "난", "랄": "날", "람": "남", "랍": "납", "랑": "낭", "래": "내", "랭": "냉", "랸": "얀",
  "려": "여", "력": "역", "련": "연", "렬": "열", "렴": "염", "엽": "엽", "령": "영", "례": "예",
  "로": "노", "록": "녹", "론": "논", "롱": "농", "뢰": "뇌", "료": "요", "룡": "용",
  "루": "누", "류": "유", "륙": "육", "륜": "윤", "률": "율", "륭": "융",
  "르": "느", "릉": "능", "리": "이", "린": "인", "림": "임", "립": "입", "링": "잉",
  "녀": "여", "념": "염", "녕": "영", "뇨": "요", "뉴": "유", "율": "율"
};

// Apply Korean Initial Sound Rule
function getValidStarts(lastChar) {
  const starts = [lastChar];
  if (soundLaw[lastChar]) {
    starts.push(soundLaw[lastChar]);
  }
  return starts;
}

// Scrape Daum Dictionary for real-time word definition
async function fetchWordDefinition(word) {
  try {
    const res = await fetch(`https://dic.daum.net/search.do?q=${encodeURIComponent(word)}`);
    if (!res.ok) return null;
    const html = await res.text();
    const matches = [...html.matchAll(/<span class=\"txt_search\">([\s\S]*?)<\/span>/g)];
    const defs = matches
      .map(m => m[1].replace(/<[^>]*>/g, '').trim())
      .filter(Boolean);
    if (defs.length > 0) {
      return defs.slice(0, 2).map((d, idx) => `${idx + 1}. ${d}`).join('\n');
    }
  } catch (e) {
    console.error("Error fetching word definition:", e);
  }
  return null;
}

// 사람들이 자주 쓰는 단어들 추가 풀 (보조 단어장)
const EXTRA_WORDS = new Set([
  // 지명/국가/도시
  "서울", "부산", "인천", "대구", "대전", "광주", "울산", "세종", "경기도", "강원도", "충청도", "전라도", "경상도", "제주도",
  "한국", "미국", "일본", "중국", "영국", "프랑스", "독일", "러시아", "이탈리아", "캐나다", "호주", "스페인", "브라질", "멕시코",
  "아시아", "유럽", "아프리카", "아메리카", "오세아니아", "도쿄", "베이징", "런던", "파리", "뉴욕", "워싱턴", "시드니", "로마",
  // 음식/과일/채소
  "김치", "라면", "비빔밥", "불고기", "떡볶이", "삼겹살", "갈비", "치킨", "피자", "파스타", "햄버거", "샌드위치", "초밥", "우동",
  "짜장면", "짬뽕", "탕수육", "만두", "순대", "족발", "보쌈", "김밥", "떡국", "만둣국", "수제비", "칼국수", "냉면", "쫄면",
  "사과", "배", "포도", "바나나", "딸기", "수박", "참외", "멜론", "복숭아", "자두", "귤", "오렌지", "레몬", "라임", "자몽", "망고",
  "체리", "블루베리", "토마토", "가지", "오이", "당근", "양파", "마늘", "고추", "파", "무", "배추", "상추", "시금치", "감자", "고구마",
  // 동물/곤충/식물
  "호랑이", "사자", "표범", "치타", "늑대", "여우", "곰", "반달곰", "북극곰", "판다", "너구리", "코알라", "캥거루", "원숭이", "침팬지",
  "고릴라", "오랑우탄", "코끼리", "기린", "하마", "코뿔소", "얼룩말", "사슴", "노루", "고라니", "멧돼지", "토끼", "다람쥐", "청서",
  "개", "고양이", "햄스터", "기니피그", "페럿", "고슴도치", "말", "소", "돼지", "양", "염소", "닭", "오리", "거위", "칠면조",
  "독수리", "매", "부엉이", "올빼미", "까마귀", "까치", "참새", "비둘기", "갈매기", "백로", "황새", "두루미", "펭귄", "타조",
  "뱀", "개구리", "두꺼비", "맹꽁이", "도롱뇽", "거북", "자라", "악어", "도마뱀", "카멜레온", "이구아나",
  "상어", "고래", "돌고래", "범고래", "참치", "연어", "광어", "우럭", "도미", "고등어", "꽁치", "갈치", "조기", "멸치",
  "문어", "오징어", "낙지", "꼴뚜기", "쭈꾸미", "꽃게", "대게", "랍스터", "새우", "조개", "굴", "전복", "소라", "멍게", "해삼",
  "장미", "튤립", "백합", "국화", "해바라기", "코스모스", "카네이션", "안개꽃", "무궁화", "벚꽃", "진달래", "개나리", "철쭉",
  "소나무", "대나무", "참나무", "단풍나무", "은행나무", "버드나무", "벚나무", "야자수", "선인장", "허브", "민들레", "클로버",
  // 일상/기술/게임/디스코드/시아
  "시아", "컴퓨터", "노트북", "스마트폰", "핸드폰", "전화기", "텔레비전", "냉장고", "세탁기", "에어컨", "청소기", "전자레인지",
  "인터넷", "웹사이트", "유튜브", "구글", "네이버", "카카오", "애플", "삼성", "마이크로소프트", "인공지능", "로봇", "챗봇",
  "디스코드", "채널", "서버", "메시지", "이모지", "역할", "권한", "멤버", "어드민", "관리자", "스레드", "카테고리", "음성", "화면",
  "게임", "마인크래프트", "리그오브레전드", "오버워치", "발로란트", "배틀그라운드", "메이플스토리", "던전앤파이터", "로스트아크",
  "피아노", "바이올린", "첼로", "플루트", "클라리넷", "트럼펫", "기타", "드럼", "베이스", "신디사이저", "하프", "오보에",
  "야구", "축구", "농구", "배구", "테니스", "배드민턴", "탁구", "골프", "볼링", "당구", "수영", "육상", "마라톤", "체조",
  "학교", "초등학교", "중학교", "고등학교", "대학교", "대학원", "선생님", "교수님", "학생", "교실", "운동장", "체육관",
  "직장", "회사", "사무실", "사장님", "부장님", "과장님", "대리님", "사원", "동료", "회의", "출근", "퇴근", "휴가", "출장",
  "사랑", "행복", "기쁨", "슬픔", "화남", "짜증", "우울", "감동", "재미", "즐거움", "평화", "희망", "용기", "믿음", "우정",
  "하늘", "바다", "강", "산", "계곡", "호수", "섬", "구름", "태양", "달", "별", "은하수", "우주", "지구", "행성", "혜성",
  "봄", "여름", "가을", "겨울", "눈", "비", "바람", "태풍", "번개", "천둥", "안개", "무지개", "노을", "새벽", "아침", "점심", "저녁", "밤",
  "과자", "초콜릿", "사탕", "젤리", "아이스크림", "케이크", "빵", "도넛", "쿠키", "마카롱", "타르트", "푸딩", "음료수", "주스",
  "커피", "녹차", "홍차", "우유", "요구르트", "치즈", "버터", "잼", "꿀", "시럽", "소스", "양념", "소금", "설탕", "식초",
  "연필", "지우개", "볼펜", "샤프", "자", "가위", "풀", "테이프", "노트", "공책", "스케치북", "도화지", "물감", "붓", "크레파스",
  "책", "소설", "시", "수필", "만화책", "잡지", "신문", "도서관", "서점", "독서", "작가", "화가", "음악가", "가수", "배우",
  "영화", "드라마", "예능", "다큐내터리", "애니메이션", "영화관", "극장", "공연", "콘서트", "뮤지컬", "연극", "전시회", "미술관",
  "시계", "안경", "선글라스", "우산", "양산", "가방", "배낭", "지갑", "열쇠", "손수건", "화장지", "물티슈", "칫솔", "치약", "비누",
  "샴푸", "린스", "바디워시", "로션", "크림", "선크림", "화장품", "향수", "거울", "빗", "드라이기", "수건", "이불", "베개", "침대",
  "의자", "책상", "소파", "식탁", "옷장", "서랍장", "신발장", "화장대", "책장", "선반", "조명", "스탠드", "커튼", "블라인드",
  "옷", "티셔츠", "셔츠", "블라우스", "바지", "청바지", "슬랙스", "스커트", "치마", "원피스", "재킷", "코트", "패딩", "점퍼",
  "양말", "신발", "운동화", "구두", "샌들", "슬리퍼", "장화", "모자", "목도리", "장갑", "벨트", "넥타이", "귀걸이", "목걸이", "반지"
]);

// 32만 개 사전 dictionary.json 연동 다이나믹 무작위 시작 단어 추출기
function getRandomStartWord() {
  const keys = Object.keys(dictionary);
  if (keys.length === 0) return "사랑";

  // 한방 단어 및 끝내기 까다로운 글자 목록 필터링
  const killerEnds = new Set([
    '륨', '늄', '듐', '튬', '륨', '뮴', '슘', '륨', '슭', '녘', '잌', '옼', '콬', '톸', '푝', '뺘',
    '뾔', '똔', '뜽', '즙', '즙', '곬', '돐', '먕', '냑', '냠', '냥', '뇽', '늅', '늉', '늴', '닢'
  ]);

  for (let attempt = 0; attempt < 500; attempt++) {
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    const words = dictionary[randomKey];
    if (words && words.length > 0) {
      const randomWord = words[Math.floor(Math.random() * words.length)];
      
      // 2~3글자의 온전한 한글 명사 필터링
      if (randomWord.length >= 2 && randomWord.length <= 3 && /^[가-힣]+$/.test(randomWord)) {
        const lastChar = randomWord.slice(-1);
        // 한방 글자가 아니고, 다음 글자로 시작하는 사전 풀이 풍부한 단어인지 검증
        if (!killerEnds.has(lastChar) && dictionary[lastChar] && dictionary[lastChar].length > 15) {
          return randomWord;
        }
      }
    }
  }
  
  // 만약의 경우를 대비한 세이프티 백업 풀
  const backups = ["사과", "나무", "자동차", "호랑이", "기차", "하늘", "바다", "사랑", "구름", "노트북", "지우개", "연필", "의자", "책상"];
  return backups[Math.floor(Math.random() * backups.length)];
}

// Active game sessions store
const sessions = new Map();

// Start a fresh new multiplayer wordchain game
async function startNewGame(channel) {
  const startWord = getRandomStartWord();
  const lastChar = startWord.slice(-1);
  const def = await fetchWordDefinition(startWord);

  const startEmbed = new EmbedBuilder()
    .setTitle('🎮 새로운 끝말잇기 시작 !')
    .setDescription(`사람들끼리 서로 번갈아 가며 단어를 이어가는 멀티플레이 모드예요 !\n아래 **[✏️ 단어 잇기]** 버튼을 눌러 단어를 입력해 주세요 ! 🥰\n\n*(게임을 처음부터 다시 하려면 관리자분이 **[🔄 처음부터 다시]** 버튼을 눌러주세요 !)*`)
    .addFields(
      { name: `첫 시작 단어`, value: `👉 **${startWord}**`, inline: true },
      { name: `💡 단어 뜻`, value: def || '뜻 정보를 불러오지 못했어요.', inline: false }
    )
    .setColor(MAIN_COLOR)
    .setFooter({ text: `마지막 글자 "${lastChar}" (으)로 시작하는 2글자 이상의 단어를 보내주세요 !` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wordchain_btn_submit')
      .setLabel('✏️ 단어 잇기')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('wordchain_btn_restart')
      .setLabel('🔄 처음부터 다시')
      .setStyle(ButtonStyle.Danger)
  );

  const sentMessage = await channel.send({ embeds: [startEmbed], components: [row] }).catch(() => {});
  if (sentMessage) {
    sessions.set(channel.id, {
      currentWord: startWord,
      usedWords: new Set([startWord]),
      score: 0,
      lastPlayerId: null,
      messageId: sentMessage.id
    });
  }
}

// 최고 점수 갱신 및 탈락 처리 헬퍼 함수
async function handleGameOver(interaction, session, title, description, reasonWord) {
  const finalScore = session.score;
  const channel = interaction.channel;
  const channelId = channel.id;
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;
  
  // 즉각 세션 제거로 후속 입력 차단
  sessions.delete(channelId);

  db.get(
    "SELECT max_score FROM wordchain_scores WHERE user_id = ? AND guild_id = ?",
    [userId, guildId],
    async (err, row) => {
      let isNewRecord = false;
      let prevMax = 0;
      
      if (err) {
        console.error("DB error fetching score:", err);
      } else if (row) {
        prevMax = row.max_score;
        if (finalScore > prevMax) {
          isNewRecord = true;
        }
      } else {
        isNewRecord = finalScore > 0;
      }

      if (isNewRecord) {
        db.run(
          "INSERT OR REPLACE INTO wordchain_scores (user_id, guild_id, max_score) VALUES (?, ?, ?)",
          [userId, guildId, finalScore]
        );
      }

      // 1. 기존 메시지를 지우지 않고 탈락 카드로 수정(Edit)
      if (session.messageId) {
        const oldMsg = await channel.messages.fetch(session.messageId).catch(() => {});
        if (oldMsg) {
          const failEmbed = new EmbedBuilder()
            .setTitle(`💥 끝말잇기 게임 종료 (${title})`)
            .setDescription(description)
            .addFields(
              { name: '틀린 단어', value: `❌ \`${reasonWord}\``, inline: true },
              { name: '최종 스코어', value: `🏆 **${finalScore}턴**`, inline: true }
            )
            .setColor(ERROR_COLOR)
            .setTimestamp();

          if (isNewRecord && finalScore > 0) {
            failEmbed.addFields({
              name: '🎉 개인 최고 기록 경신 !',
              value: `이 서버에서 ${interaction.user} 님의 최고 기록이 **${prevMax}턴**에서 **${finalScore}턴**으로 경신되었어요 ! 대단해요 ! 👏`,
              inline: false
            });
          }

          // 버튼 전수 제거하고 에디트!
          await oldMsg.edit({ embeds: [failEmbed], components: [] }).catch(() => {});
        }
      }

      // 2. 모달 인터랙션 완료 응답
      await interaction.deferUpdate().catch(() => {});

      // 3. 딜레이 후 자연스럽게 새 게임 시작 카드 전송
      setTimeout(async () => {
        await startNewGame(channel);
      }, 1000);
    }
  );
}

module.exports = {
  name: 'Wordchain',
  description: '서로 단어를 이어가는 멀티플레이 끝말잇기 미니게임 및 전용 채널 설정 기능',
  sessions: sessions, // 외부(admin.js 등) 세션 초기화용 접근 속성 활성화
  dictionary: dictionary,
  EXTRA_WORDS: EXTRA_WORDS,
  fetchWordDefinition: fetchWordDefinition,

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('끝말잇기')
        .setDescription('끝말잇기 게임을 시작합니다.'),
      async execute(interaction) {
        const { user, guild, channel } = interaction;

        if (sessions.has(channel.id)) {
          return interaction.reply({ content: '❌ 이미 이 채널에서 끝말잇기 게임이 진행 중입니다.', flags: [MessageFlags.Ephemeral] });
        }

        const startWord = getRandomStartWord();
        const lastChar = startWord.slice(-1);
        
        const def = await fetchWordDefinition(startWord);
        const embed = new EmbedBuilder()
          .setTitle('🎮 끝말잇기 게임 시작 !')
          .setDescription(`${user} 님이 시작한 멀티플레이 끝말잇기 대결입니다 !\n서로 번갈아 가며 단어를 이어가 주세요. 🥰\n아래 **[✏️ 단어 잇기]** 버튼을 눌러 단어를 제출해 볼까요?\n\n규칙:\n1. 이전 단어의 **마지막 글자**로 시작하는 단어를 입력하세요.\n2. **두 음절 이상의 표준 단어**만 인정됩니다.\n3. 연속으로 두 번 단어를 보낼 수 없습니다.`)
          .addFields(
            { name: '첫 단어', value: `👉 **${startWord}**`, inline: true },
            { name: '📖 단어 뜻', value: def || '뜻 정보를 불러오지 못했어요.', inline: false }
          )
          .setColor(MAIN_COLOR)
          .setFooter({ text: `마지막 글자 "${lastChar}" (으)로 시작하는 2글자 이상의 단어를 보내주세요 !` })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('wordchain_btn_submit')
            .setLabel('✏️ 단어 잇기')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('wordchain_btn_restart')
            .setLabel('🔄 처음부터 다시')
            .setStyle(ButtonStyle.Danger)
        );

        const replyMessage = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
        
        sessions.set(channel.id, {
          currentWord: startWord,
          usedWords: new Set([startWord]),
          score: 0,
          lastPlayerId: null,
          messageId: replyMessage.id
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('끝말잇기설정')
        .setDescription('서버의 끝말잇기 전용 채널을 지정하거나 해제합니다.')
        .addSubcommand(subcommand =>
          subcommand.setName('지정')
            .setDescription('끝말잇기 전용 채널을 설정합니다.')
            .addChannelOption(option => option.setName('채널').setDescription('끝말잇기를 진행할 전용 채널').setRequired(true))
        )
        .addSubcommand(subcommand =>
          subcommand.setName('해제')
            .setDescription('설정된 끝말잇기 전용 채널을 해제합니다.')
        ),
      async execute(interaction) {
        if (!(await checkAdminPermission(interaction.member))) {
          return interaction.reply({ embeds: [PERMISSION_ERROR_EMBED()], flags: [MessageFlags.Ephemeral] });
        }
        const subcommand = interaction.options.getSubcommand();
        const guild = interaction.guild;

        if (subcommand === '지정') {
          const channel = interaction.options.getChannel('채널');
          db.run(
            "INSERT OR REPLACE INTO wordchain_settings (guild_id, channel_id) VALUES (?, ?)",
            [guild.id, channel.id],
            async (err) => {
              if (err) return interaction.reply({ content: '❌ 데이터베이스 저장 중 오류가 발생했습니다.', flags: [MessageFlags.Ephemeral] });

              const embed = new EmbedBuilder()
                .setTitle('🎮 끝말잇기 전용 채널 설정 완료')
                .setDescription(`${channel} 채널이 이 서버의 **끝말잇기 전용 채널**로 설정되었습니다 !\n이제부터 이 채널에서 사람들이 버튼 모달창을 통해 서로 단어를 이어가며 놀 수 있어요 ! 🤖🔥`)
                .setColor(MAIN_COLOR)
                .setTimestamp();
              await interaction.reply({ embeds: [embed] });

              // Instantly start the game in the channel
              await startNewGame(channel);
            }
          );
        } else if (subcommand === '해제') {
          db.run("DELETE FROM wordchain_settings WHERE guild_id = ?", [guild.id], (err) => {
            if (err) return interaction.reply({ content: '❌ 데이터베이스 삭제 중 오류가 발생했습니다.', flags: [MessageFlags.Ephemeral] });

            const embed = new EmbedBuilder()
              .setTitle('✨ 끝말잇기 전용 채널 해제 완료')
              .setDescription('끝말잇기 전용 채널 설정이 성공적으로 제거되었습니다.')
              .setColor(SUCCESS_COLOR)
              .setTimestamp();
            return interaction.reply({ embeds: [embed] });
          });
        }
      }
    }
  ],

  listeners: {
    // Delete raw text messages inside the dedicated channel to prevent manual bypasses
    async messageCreate(client, message) {
      if (message.author.bot || !message.guild) return;

      const channelId = message.channel.id;
      const guildId = message.guild.id;

      db.get("SELECT channel_id FROM wordchain_settings WHERE guild_id = ?", [guildId], async (err, settingRow) => {
        if (err) return;
        const isDedicatedChannel = settingRow && settingRow.channel_id === channelId;
        if (isDedicatedChannel) {
          await message.delete().catch(() => {});
          const notice = await message.channel.send({
            content: `❌ ${message.author} 님, 아래 of **[✏️ 단어 잇기]** 버튼을 눌러 모달창을 통해 단어를 입력해 주세요 !`
          }).catch(() => {});
          setTimeout(() => notice.delete().catch(() => {}), 5000);
        }
      });
    },

    // Handle Button clicks and Modal submissions
    async interactionCreate(client, interaction) {
      if (!interaction.isButton() && !interaction.isModalSubmit()) return;

      const customId = interaction.customId;
      const channelId = interaction.channelId;
      const session = sessions.get(channelId);

      // 1. Button Handling
      if (interaction.isButton()) {
        if (customId === 'wordchain_btn_submit') {
          if (!session) {
            return interaction.reply({ content: "❌ 현재 진행 중인 끝말잇기 게임이 없어요 !", flags: [MessageFlags.Ephemeral] });
          }

          // Consecutive Turn Check
          if (session.lastPlayerId === interaction.user.id) {
            return interaction.reply({ content: "❌ 본인의 단어에 이어서 연속으로 입력할 수 없어요 ! 다른 사람의 차례를 기다려주세요 !", flags: [MessageFlags.Ephemeral] });
          }

          // Open Modal
          const lastChar = session.currentWord.slice(-1);
          const validStarts = getValidStarts(lastChar);
          
          // 동시성 제어: 모달 ID에 스냅샷 락(currentWord) 탑재!
          const modal = new ModalBuilder()
            .setCustomId(`wordchain_modal_${session.currentWord}`)
            .setTitle('🎮 끝말잇기 단어 입력');

          const wordInput = new TextInputBuilder()
            .setCustomId('wordchain_input')
            .setLabel(`다음 단어 ("${validStarts.join('/')}" 으/로 시작)`)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('이곳에 이어갈 단어를 입력해 주세요 !')
            .setMinLength(2)
            .setMaxLength(15)
            .setRequired(true);

          const firstActionRow = new ActionRowBuilder().addComponents(wordInput);
          modal.addComponents(firstActionRow);
          
          return interaction.showModal(modal);
        }

        if (customId === 'wordchain_btn_restart') {
          // Restart authorization check
          if (!(await checkAdminPermission(interaction.member))) {
            return interaction.reply({ content: "❌ 게임을 처음부터 다시 시작하는 권한은 서버 관리자만 가능해요 !", flags: [MessageFlags.Ephemeral] });
          }

          // Confirmed Administrator. Restart game!
          await interaction.deferUpdate();

          if (session && session.messageId) {
            const oldMsg = await interaction.channel.messages.fetch(session.messageId).catch(() => {});
            if (oldMsg) await oldMsg.delete().catch(() => {});
          }

          sessions.delete(channelId);
          await startNewGame(interaction.channel);
        }
      }

      // 2. Modal Submission Handling (customId가 스냅샷 락 패턴과 일치하는지 확인)
      if (interaction.isModalSubmit() && customId.startsWith('wordchain_modal_')) {
        if (!session) {
          return interaction.reply({ content: "❌ 진행 중인 게임 세션이 감지되지 않았어요 !", flags: [MessageFlags.Ephemeral] });
        }

        const expectedWord = customId.replace('wordchain_modal_', '');

        // [동시성 낙관적 락 체크]
        // 모달창을 띄운 시점의 세션 단어와 현재 세션의 실제 단어가 달라졌다면 레이스 컨디션 발생!
        if (expectedWord !== session.currentWord) {
          return interaction.reply({
            content: `❌ 이미 다른 사람이 먼저 단어를 제출하여 단어 잇기 흐름이 변경되었습니다 !\n(제출 시도 시점 단어: **${expectedWord}** ➡️ 현재 최신 단어: **${session.currentWord}**)\n\n다시 아래의 **[✏️ 단어 잇기]** 버튼을 눌러 제출해 주세요 ! 🥰`,
            flags: [MessageFlags.Ephemeral]
          });
        }

        const text = interaction.fields.getTextInputValue('wordchain_input').trim();

        // Length validation
        if (text.length < 2) {
          return interaction.reply({ content: "❌ 단어는 최소 2글자 이상이어야 해요 !", flags: [MessageFlags.Ephemeral] });
        }

        // Secondary Consecutive check
        if (session.lastPlayerId === interaction.user.id) {
          return interaction.reply({ content: "❌ 본인의 단어에 이어서 연속으로 입력할 수 없어요 !", flags: [MessageFlags.Ephemeral] });
        }

        // Validate beginning letter (including Initial Sound Rule)
        const lastChar = session.currentWord.slice(-1);
        const validStarts = getValidStarts(lastChar);
        const userStart = text.charAt(0);

        if (!validStarts.includes(userStart)) {
          await handleGameOver(
            interaction,
            session,
            '시작 글자 오류',
            `${interaction.user} 님이 시작 글자가 틀린 단어(\`${text}\`)를 전송하여 게임이 끝났어요 !\n(다음 단어는 \`${validStarts.join('/')}\` (으)로 시작해야 했어요 🥺)`,
            text
          );
          return;
        }

        // Duplicate Check
        if (session.usedWords.has(text)) {
          await handleGameOver(
            interaction,
            session,
            '이미 사용된 단어',
            `${interaction.user} 님이 이미 사용된 중복 단어(\`${text}\`)를 보내서 게임이 끝났어요 ! 🥺`,
            text
          );
          return;
        }

        // Dictionary & EXTRA & Daum Scraper 하이브리드 단어 인정 검증 프로토콜
        const wordFirstChar = text.charAt(0);
        let exists = (dictionary[wordFirstChar] && dictionary[wordFirstChar].includes(text)) || EXTRA_WORDS.has(text);
        let liveDef = null;

        if (!exists) {
          // 로컬 사전에 없을 경우 Daum 사전 실시간 크롤링으로 구제 시도
          liveDef = await fetchWordDefinition(text);
          if (liveDef) {
            exists = true;
          }
        }

        if (!exists) {
          await handleGameOver(
            interaction,
            session,
            '사전 누락 단어',
            `${interaction.user} 님이 사전에 등록되지 않은 단어(\`${text}\`)를 전송하여 게임이 끝났어요 ! 🥺`,
            text
          );
          return;
        }

        // Success! Proceed and edit the previous active message
        let oldMsg = null;
        if (session.messageId) {
          oldMsg = await interaction.channel.messages.fetch(session.messageId).catch(() => {});
        }

        // Update session state
        session.usedWords.add(text);
        session.currentWord = text;
        session.score += 1;
        session.lastPlayerId = interaction.user.id;

        // Fetch dictionary definition for the accepted word
        const userWordDef = liveDef || await fetchWordDefinition(text);
        const nextStartChar = text.slice(-1);

        const progressEmbed = new EmbedBuilder()
          .setTitle('🎮 끝말잇기 진행 중 !')
          .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
          .setDescription(
            `👤 ${interaction.user} 님이 단어를 성공적으로 이어갔어요 !\n\n` +
            `👉 **단어**: \`${text}\`\n` +
            `📖 **단어 뜻**:\n${userWordDef || '뜻 정보를 불러오지 못했어요.'}\n\n` +
            `💡 다음 사람은 **"${nextStartChar}"** (으)로 시작해 주세요 !`
          )
          .setColor(SUCCESS_COLOR)
          .setFooter({ text: `현재 진행 턴: ${session.score}턴 | 마지막 입력: ${interaction.user.username}` })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('wordchain_btn_submit')
            .setLabel('✏️ 단어 잇기')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('wordchain_btn_restart')
            .setLabel('🔄 처음부터 다시')
            .setStyle(ButtonStyle.Danger)
        );

        // 1. 기존 메시지의 버튼 컴포넌트를 제거하여 과거 입력을 방지
        if (oldMsg) {
          await oldMsg.edit({ components: [] }).catch(() => {});
        }

        // 2. 완성된 것은 새로운 메시지로 발송
        const newMsg = await interaction.channel.send({ embeds: [progressEmbed], components: [row] }).catch(() => {});
        if (newMsg) {
          session.messageId = newMsg.id;
        }

        // 모달창 닫기 및 인터랙션 매끄럽게 처리 완료
        return interaction.deferUpdate().catch(() => {});
      }
    }
  }
};
