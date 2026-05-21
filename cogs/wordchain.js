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
  return "뜻 정보를 불러올 수 없어요 !";
}

// Start a fresh new multiplayer wordchain game
async function startNewGame(channel) {
  const startWords = ["사과", "나무", "자동차", "호랑이", "기차", "하늘", "바다", "사랑"];
  const startWord = startWords[Math.floor(Math.random() * startWords.length)];
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

// Active game sessions store
const sessions = new Map();

module.exports = {
  name: 'Wordchain',
  description: '서로 단어를 이어가는 멀티플레이 끝말잇기 미니게임 및 전용 채널 설정 기능',

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

        const startWords = ["사과", "나무", "자동차", "호랑이", "기차", "하늘", "바다", "사랑"];
        const startWord = startWords[Math.floor(Math.random() * startWords.length)];
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
        const isDedicatedChannel = settingRow && settingRow.channel_id === channelId;
        if (isDedicatedChannel) {
          await message.delete().catch(() => {});
          const notice = await message.channel.send({
            content: `❌ ${message.author} 님, 아래의 **[✏️ 단어 잇기]** 버튼을 눌러 모달창을 통해 단어를 입력해 주세요 !`
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
          
          const modal = new ModalBuilder()
            .setCustomId('wordchain_modal')
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

      // 2. Modal Submission Handling
      if (interaction.isModalSubmit() && customId === 'wordchain_modal') {
        if (!session) {
          return interaction.reply({ content: "❌ 진행 중인 게임 세션이 감지되지 않았어요 !", flags: [MessageFlags.Ephemeral] });
        }

        await interaction.deferReply({ ephemeral: true });

        const text = interaction.fields.getTextInputValue('wordchain_input').trim();

        // Length validation
        if (text.length < 2) {
          return interaction.followUp({ content: "❌ 단어는 최소 2글자 이상이어야 해요 !", flags: [MessageFlags.Ephemeral] });
        }

        // Secondary Consecutive check
        if (session.lastPlayerId === interaction.user.id) {
          return interaction.followUp({ content: "❌ 본인의 단어에 이어서 연속으로 입력할 수 없어요 !", flags: [MessageFlags.Ephemeral] });
        }

        // Validate beginning letter (including Initial Sound Rule)
        const lastChar = session.currentWord.slice(-1);
        const validStarts = getValidStarts(lastChar);
        const userStart = text.charAt(0);

        if (!validStarts.includes(userStart)) {
          const finalScore = session.score;
          sessions.delete(channelId);

          if (session.messageId) {
            const oldMsg = await interaction.channel.messages.fetch(session.messageId).catch(() => {});
            if (oldMsg) await oldMsg.delete().catch(() => {});
          }

          const failEmbed = new EmbedBuilder()
            .setTitle('💥 끝말잇기 탈락 !')
            .setDescription(`${interaction.user} 님이 틀린 단어(\`${text}\`)를 전송하여 게임이 끝났어요 !\n(다음 단어는 \`${validStarts.join('/')}\` (으)로 시작해야 했어요)`)
            .addFields({ name: '최종 스코어', value: `🏆 **${finalScore}턴**` })
            .setColor(ERROR_COLOR)
            .setTimestamp();
          await interaction.channel.send({ embeds: [failEmbed] });

          await startNewGame(interaction.channel);
          return interaction.followUp({ content: "❌ 틀린 단어를 제출해서 게임이 종료되었어요 !", flags: [MessageFlags.Ephemeral] });
        }

        // Dictionary Existence Check
        const wordFirstChar = text.charAt(0);
        const exists = dictionary[wordFirstChar] && dictionary[wordFirstChar].includes(text);
        if (!exists) {
          const finalScore = session.score;
          sessions.delete(channelId);

          if (session.messageId) {
            const oldMsg = await interaction.channel.messages.fetch(session.messageId).catch(() => {});
            if (oldMsg) await oldMsg.delete().catch(() => {});
          }

          const failEmbed = new EmbedBuilder()
            .setTitle('💥 끝말잇기 탈락 !')
            .setDescription(`${interaction.user} 님이 사전에 등록되지 않은 단어(\`${text}\`)를 전송하여 게임이 끝났어요 !`)
            .addFields({ name: '최종 스코어', value: `🏆 **${finalScore}턴**` })
            .setColor(ERROR_COLOR)
            .setTimestamp();
          await interaction.channel.send({ embeds: [failEmbed] });

          await startNewGame(interaction.channel);
          return interaction.followUp({ content: "❌ 국어사전에 존재하지 않는 단어예요 !", flags: [MessageFlags.Ephemeral] });
        }

        // Duplicate Check
        if (session.usedWords.has(text)) {
          const finalScore = session.score;
          sessions.delete(channelId);

          if (session.messageId) {
            const oldMsg = await interaction.channel.messages.fetch(session.messageId).catch(() => {});
            if (oldMsg) await oldMsg.delete().catch(() => {});
          }

          const failEmbed = new EmbedBuilder()
            .setTitle('💥 끝말잇기 탈락 !')
            .setDescription(`${interaction.user} 님이 이미 사용된 중복 단어(\`${text}\`)를 보내서 게임이 끝났어요 !`)
            .addFields({ name: '최종 스코어', value: `🏆 **${finalScore}턴**` })
            .setColor(ERROR_COLOR)
            .setTimestamp();
          await interaction.channel.send({ embeds: [failEmbed] });

          await startNewGame(interaction.channel);
          return interaction.followUp({ content: "❌ 이미 사용된 중복 단어예요 !", flags: [MessageFlags.Ephemeral] });
        }

        // Success! Proceed and clean up previous active message
        if (session.messageId) {
          const oldMsg = await interaction.channel.messages.fetch(session.messageId).catch(() => {});
          if (oldMsg) await oldMsg.delete().catch(() => {});
        }

        // Update session state
        session.usedWords.add(text);
        session.currentWord = text;
        session.score += 1;
        session.lastPlayerId = interaction.user.id;

        // Fetch dictionary definition for the accepted word
        const userWordDef = await fetchWordDefinition(text);
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
          .setFooter({ text: `현재 진행 턴: ${session.score}턴` })
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

        const newMsg = await interaction.channel.send({ embeds: [progressEmbed], components: [row] });
        session.messageId = newMsg.id;

        return interaction.followUp({ content: "✅ 단어가 성공적으로 제출되었어요 !", flags: [MessageFlags.Ephemeral] });
      }
    }
  }
};
