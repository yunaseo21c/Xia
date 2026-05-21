const { 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  MessageFlags,
  AttachmentBuilder
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const sharp = require('sharp');
const { MAIN_COLOR, SUCCESS_COLOR, ERROR_COLOR, INFO_COLOR } = require('../core/config');

// Helper to generate a stunning RPG-style visual fish card using SVG & Sharp
async function generateFishCard(username, fish) {
  const colors = {
    '피라미': { grad: ['#3b82f6', '#1d4ed8'], text: '#93c5fd', label: '일반 어종' },
    '고등어': { grad: ['#10b981', '#047857'], text: '#a7f3d0', label: '고급 어종' },
    '오징어': { grad: ['#8b5cf6', '#6d28d9'], text: '#ddd6fe', label: '희귀 어종' },
    '랍스터': { grad: ['#f43f5e', '#be123c'], text: '#fecdd3', label: '영웅 어종' },
    '황금고래': { grad: ['#eab308', '#a16207'], text: '#fef08a', label: '전설 어종' }
  };
  
  const fishColor = colors[fish.name] || { grad: ['#6b7280', '#374151'], text: '#e5e7eb', label: '미지의 어종' };
  const svgWidth = 600;
  const svgHeight = 350;
  
  const escapedUser = username.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );

  const svg = `
    <svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#111827" />
          <stop offset="100%" stop-color="#1f2937" />
        </linearGradient>
        <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${fishColor.grad[0]}" />
          <stop offset="100%" stop-color="${fishColor.grad[1]}" />
        </linearGradient>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="15" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      <rect width="100%" height="100%" rx="24" fill="url(#bgGrad)" />
      
      <path d="M 0,50 L 600,50 M 0,100 L 600,100 M 0,150 L 600,150 M 0,200 L 600,200 M 0,250 L 600,250 M 0,300 L 600,300" stroke="#374151" stroke-width="0.5" opacity="0.3" />
      <path d="M 100,0 L 100,350 M 200,0 L 200,350 M 300,0 L 300,350 M 400,0 L 400,350 M 500,0 L 500,350" stroke="#374151" stroke-width="0.5" opacity="0.3" />

      <rect x="3" y="3" width="594" height="344" rx="21" fill="none" stroke="${fishColor.grad[0]}" stroke-width="3" opacity="0.8" />

      <g transform="translate(40, 45)">
        <rect width="200" height="260" rx="20" fill="url(#cardGrad)" filter="url(#glow)" opacity="0.15" />
        <rect width="200" height="260" rx="20" fill="none" stroke="url(#cardGrad)" stroke-width="2.5" />
        
        <text x="100" y="150" font-family="'Segoe UI Emoji', 'Apple Color Emoji', sans-serif" font-size="90" text-anchor="middle" dominant-baseline="middle">${fish.emoji}</text>
        
        <rect x="50" y="210" width="100" height="28" rx="14" fill="#111827" opacity="0.8" />
        <text x="100" y="228" font-family="'Pretendard', 'Inter', sans-serif" font-size="12" font-weight="bold" fill="${fishColor.text}" text-anchor="middle">${fishColor.label}</text>
      </g>

      <text x="270" y="80" font-family="'Pretendard', 'Inter', sans-serif" font-size="18" font-weight="600" fill="#9ca3af">🏆 ${escapedUser} 님의 수확</text>
      <text x="270" y="140" font-family="'Pretendard', 'Inter', sans-serif" font-size="38" font-weight="800" fill="#ffffff">${fish.name}</text>
      
      <g transform="translate(270, 185)">
        <rect width="280" height="50" rx="12" fill="#1f2937" />
        <text x="20" y="31" font-family="'Pretendard', 'Inter', sans-serif" font-size="16" font-weight="bold" fill="#9ca3af">💰 상점 판매가</text>
        <text x="260" y="32" font-family="'Pretendard', 'Inter', sans-serif" font-size="20" font-weight="bold" fill="#facc15" text-anchor="end">${fish.value.toLocaleString()} 시아코인</text>
      </g>

      <text x="270" y="280" font-family="'Pretendard', 'Inter', sans-serif" font-size="13" fill="#6b7280">SIA AUTOMATED ECONOMY SYSTEM v2.1</text>
      <text x="270" y="300" font-family="'Pretendard', 'Inter', sans-serif" font-size="11" fill="#4b5563">물고기를 상점에 일괄 판매하려면 /판매 명령어를 입력해 주세요.</text>
    </svg>
  `;

  return sharp(Buffer.from(svg))
    .png()
    .toBuffer();
}

// Shared Database Setup
const dbPath = path.join(process.cwd(), 'xiadb.db');
const db = new sqlite3.Database(dbPath);
db.configure("busyTimeout", 5000);

// Initialize Economy Tables (Migrate to Global / User-centric keys)
db.serialize(() => {
  // Check if old columns/indexes exist, drop tables for a fresh clean migration if necessary
  db.run(`CREATE TABLE IF NOT EXISTS economy (
    user_id TEXT PRIMARY KEY,
    money INTEGER DEFAULT 1000,
    last_fish TEXT,
    last_farm TEXT,
    last_daily TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS inventory (
    user_id TEXT,
    item_name TEXT,
    item_count INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, item_name)
  )`);
});

// Helper: Ensure User exists in DB globally
function ensureUser(userId) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT OR IGNORE INTO economy (user_id, money) VALUES (?, 1000)",
      [userId],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

// Helper: Get User Money globally
function getUserMoney(userId) {
  return new Promise((resolve) => {
    db.get(
      "SELECT money FROM economy WHERE user_id = ?",
      [userId],
      (err, row) => {
        if (err || !row) resolve(1000);
        else resolve(row.money);
      }
    );
  });
}

// Helper: Update User Money globally
function updateUserMoney(userId, amount) {
  return new Promise((resolve) => {
    db.run(
      "UPDATE economy SET money = money + ? WHERE user_id = ?",
      [amount, userId],
      () => resolve()
    );
  });
}

// Fish rates and values in 시아코인
const FISHES = [
  { emoji: '🐟', name: '피라미', value: 40, chance: 40 },
  { emoji: '🐠', name: '고등어', value: 100, chance: 30 },
  { emoji: '🦑', name: '오징어', value: 220, chance: 15 },
  { emoji: '🦞', name: '랍스터', value: 550, chance: 10 },
  { emoji: '🐳', name: '황금고래', value: 2000, chance: 5 }
];

// Crop rates and values in 시아코인
const CROPS = [
  { emoji: '🥔', name: '감자', value: 70, chance: 45 },
  { emoji: '🍠', name: '고구마', value: 140, chance: 30 },
  { emoji: '🥕', name: '당근', value: 280, chance: 15 },
  { emoji: '🌿', name: '인삼', value: 750, chance: 8 },
  { emoji: '🌟', name: '황금산삼', value: 3000, chance: 2 }
];

function getRandomReward(list) {
  const rand = Math.random() * 100;
  let cumulative = 0;
  for (const item of list) {
    cumulative += item.chance;
    if (rand <= cumulative) {
      return item;
    }
  }
  return list[0];
}

module.exports = {
  name: 'Minigames',
  description: '서버 연동형 글로벌 가상 경제 및 미니게임 (낚시, 농사, 도박 등)',

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('낚시')
        .setDescription('바다로 가 낚시를 진행합니다. (15초 재사용 대기시간)'),
      async execute(interaction) {
        const { user } = interaction;
        await ensureUser(user.id);

        db.get("SELECT last_fish FROM economy WHERE user_id = ?", [user.id], async (err, row) => {
          const now = Date.now();
          if (row && row.last_fish) {
            const diff = now - new Date(row.last_fish).getTime();
            if (diff < 15000) {
              const remaining = Math.ceil((15000 - diff) / 1000);
              return interaction.reply({ content: `⏳ 낚시찌가 물에 젖어 있어요! **${remaining}초** 후에 다시 시도할 수 있습니다.`, ephemeral: true });
            }
          }

          // Consume cooldown instantly upon casting the line to prevent spamming
          db.run(
            "UPDATE economy SET last_fish = ? WHERE user_id = ?",
            [new Date().toISOString(), user.id],
            async (updErr) => {
              if (updErr) console.error("Error updating last_fish:", updErr);

              let state = 'waiting'; // 'waiting', 'fake', 'bite', 'escaped', 'caught'
              const initialEmbed = new EmbedBuilder()
                .setTitle('🎣 바다 낚시 시작')
                .setDescription(
                  `${user} 님이 바다를 향해 힘차게 낚싯대를 던졌습니다!\n` +
                  `찌가 흔들리고 **"지금 낚으세요 !"** 멘트가 뜰 때 정확하게 버튼을 클릭하세요.\n\n` +
                  `💬 **가만히 기다리세요... 찌를 지켜보는 중...** 💤`
                )
                .setColor(INFO_COLOR)
                .setTimestamp();

              const actionBtn = new ButtonBuilder()
                .setCustomId('fish_reel')
                .setLabel('기다리는 중... 💤')
                .setStyle(ButtonStyle.Secondary);

              const row = new ActionRowBuilder().addComponents(actionBtn);

              const response = await interaction.reply({
                embeds: [initialEmbed],
                components: [row]
              });

              const collector = response.createMessageComponentCollector({
                filter: i => i.user.id === user.id,
                time: 15000
              });

              let timers = [];
              const clearAllTimers = () => {
                timers.forEach(t => clearTimeout(t));
                timers = [];
              };

              const hasFakeBite = Math.random() < 0.5;

              if (hasFakeBite) {
                // Fake Bite after 2.5 seconds
                const fakeTimer = setTimeout(async () => {
                  state = 'fake';
                  const fakeEmbed = new EmbedBuilder()
                    .setTitle('🎣 바다 낚시 - 입질?!')
                    .setDescription(
                      `${user} 님의 낚시찌가 크게 흔들립니다! 🌊\n` +
                      `하지만 가짜 입질(페이크)일 수 있으니 찌의 상태를 잘 살피세요!\n\n` +
                      `💬 **찌가 물 위아래로 춤을 춥니다! 파르르...**`
                    )
                    .setColor(0xEAB308)
                    .setTimestamp();

                  actionBtn.setLabel('찌가 움직였다?! 🌊').setStyle(ButtonStyle.Danger);
                  await interaction.editReply({
                    embeds: [fakeEmbed],
                    components: [new ActionRowBuilder().addComponents(actionBtn)]
                  }).catch(() => null);

                  const endFakeTimer = setTimeout(async () => {
                    if (state !== 'fake') return;
                    state = 'waiting';
                    const backEmbed = new EmbedBuilder()
                      .setTitle('🎣 바다 낚시 - 대기 중')
                      .setDescription(
                        `휴... 방금 건 단순한 파도였거나 물고기의 페이크였습니다!\n` +
                        `물고기가 아직 미끼 주위를 조심스럽게 서성이고 있으니 가만히 기다리세요.\n\n` +
                        `💬 **다시 잠잠해졌습니다... 지켜보는 중...** 💤`
                      )
                      .setColor(INFO_COLOR)
                      .setTimestamp();

                    actionBtn.setLabel('기다리는 중... 💤').setStyle(ButtonStyle.Secondary);
                    await interaction.editReply({
                      embeds: [backEmbed],
                      components: [new ActionRowBuilder().addComponents(actionBtn)]
                    }).catch(() => null);

                    const realTimer = setTimeout(() => {
                      triggerRealBite();
                    }, 2500);
                    timers.push(realTimer);

                  }, 2000);
                  timers.push(endFakeTimer);

                }, 2500);
                timers.push(fakeTimer);
              } else {
                // Direct Real Bite after 3.5 seconds
                const realTimer = setTimeout(() => {
                  triggerRealBite();
                }, 3500);
                timers.push(realTimer);
              }

              async function triggerRealBite() {
                state = 'bite';
                const biteEmbed = new EmbedBuilder()
                  .setTitle('🚨 🎣 지금 낚으세요 !')
                  .setDescription(
                    `⚠️ **찌가 완전히 물속으로 들어갔습니다! 지금 당장 낚싯대를 낚아채세요!!!**\n\n` +
                    `💬 **⚡ 물고기가 강력하게 미끼를 물었습니다! 지금 당장 클릭하세요!**`
                  )
                  .setColor(0x10B981)
                  .setTimestamp();

                actionBtn.setLabel('지금 낚으세요 !').setStyle(ButtonStyle.Success);
                await interaction.editReply({
                  embeds: [biteEmbed],
                  components: [new ActionRowBuilder().addComponents(actionBtn)]
                }).catch(() => null);

                const escapeTimer = setTimeout(async () => {
                  if (state !== 'bite') return;
                  state = 'escaped';
                  clearAllTimers();
                  collector.stop('escaped');

                  const escapeEmbed = new EmbedBuilder()
                    .setTitle('💨 물고기가 달아났습니다')
                    .setDescription(
                      `너무 꾸물거렸습니다! 😢\n` +
                      `물고기가 낚싯바늘에서 미끼만 아주 영리하게 빼먹고 도망쳤습니다.`
                    )
                    .setColor(ERROR_COLOR)
                    .setTimestamp();

                  actionBtn.setLabel('물고기가 도망침... 💨').setStyle(ButtonStyle.Secondary).setDisabled(true);
                  await interaction.editReply({
                    embeds: [escapeEmbed],
                    components: [new ActionRowBuilder().addComponents(actionBtn)]
                  }).catch(() => null);

                }, 1800);
                timers.push(escapeTimer);
              }

              collector.on('collect', async (i) => {
                clearAllTimers();
                collector.stop('clicked');

                if (state === 'waiting') {
                  const failEmbed = new EmbedBuilder()
                    .setTitle('❌ 낚시 실패 - 조기 챔질')
                    .setDescription(
                      `**급할수록 돌아가세요!** 😢\n` +
                      `물고기가 다가오기도 전에 성급하게 낚싯대를 당겨 물고기가 깜짝 놀라 도망갔습니다.`
                    )
                    .setColor(ERROR_COLOR)
                    .setTimestamp();

                  actionBtn.setLabel('너무 빨랐습니다 ❌').setStyle(ButtonStyle.Secondary).setDisabled(true);
                  await i.update({
                    embeds: [failEmbed],
                    components: [new ActionRowBuilder().addComponents(actionBtn)]
                  }).catch(() => null);
                } 
                
                else if (state === 'fake') {
                  const failEmbed = new EmbedBuilder()
                    .setTitle('❌ 낚시 실패 - 페이크에 속음')
                    .setDescription(
                      `**물고기의 지능적인 승리!** 😢\n` +
                      `물고기의 꼬리치기 가짜 입질(페이크)에 깜빡 속아 낚싯대를 너무 일찍 낚아채 물고기가 달아났습니다.`
                    )
                    .setColor(ERROR_COLOR)
                    .setTimestamp();

                  actionBtn.setLabel('페이크 입질에 낚임 ❌').setStyle(ButtonStyle.Secondary).setDisabled(true);
                  await i.update({
                    embeds: [failEmbed],
                    components: [new ActionRowBuilder().addComponents(actionBtn)]
                  }).catch(() => null);
                } 
                
                else if (state === 'bite') {
                  const caught = getRandomReward(FISHES);
                  
                  db.run(
                    "INSERT OR REPLACE INTO inventory (user_id, item_name, item_count) VALUES (?, ?, COALESCE((SELECT item_count FROM inventory WHERE user_id = ? AND item_name = ?), 0) + 1)",
                    [user.id, caught.name, user.id, caught.name],
                    async (invErr) => {
                      if (invErr) console.error("Error saving fish to inventory:", invErr);

                      try {
                        const cardBuffer = await generateFishCard(user.username, caught);
                        const attachment = new AttachmentBuilder(cardBuffer, { name: 'fish.png' });

                        const successEmbed = new EmbedBuilder()
                          .setTitle('🎉 🎣 낚시 대성공!')
                          .setDescription(
                            `완벽한 타이밍입니다! 찌를 정확하게 낚아채 짜릿한 손맛을 느꼈습니다! ✨\n\n` +
                            `• **획득한 어종**: ${caught.emoji} **${caught.name}**\n` +
                            `• **상점 판매가**: ${caught.value} 시아코인`
                          )
                          .setImage('attachment://fish.png')
                          .setColor(SUCCESS_COLOR)
                          .setFooter({ text: '💡 "/판매" 명령어로 낚은 물고기를 모두 팔 수 있습니다!' })
                          .setTimestamp();

                        actionBtn.setLabel('낚시 성공! ✅').setStyle(ButtonStyle.Success).setDisabled(true);
                        await i.update({
                          embeds: [successEmbed],
                          components: [new ActionRowBuilder().addComponents(actionBtn)],
                          files: [attachment]
                        }).catch(() => null);
                      } catch (cardErr) {
                        console.error("Error creating fish card:", cardErr);
                        // Fallback embed without card image
                        const successEmbed = new EmbedBuilder()
                          .setTitle('🎉 🎣 낚시 대성공!')
                          .setDescription(
                            `완벽한 타이밍입니다! 찌를 정확하게 낚아채 짜릿한 손맛을 느꼈습니다! ✨\n\n` +
                            `• **획득한 어종**: ${caught.emoji} **${caught.name}**\n` +
                            `• **상점 판매가**: ${caught.value} 시아코인`
                          )
                          .setColor(SUCCESS_COLOR)
                          .setFooter({ text: '💡 "/판매" 명령어로 낚은 물고기를 모두 팔 수 있습니다!' })
                          .setTimestamp();

                        actionBtn.setLabel('낚시 성공! ✅').setStyle(ButtonStyle.Success).setDisabled(true);
                        await i.update({
                          embeds: [successEmbed],
                          components: [new ActionRowBuilder().addComponents(actionBtn)]
                        }).catch(() => null);
                      }
                    }
                  );
                }
              });

              collector.on('end', (collected, reason) => {
                clearAllTimers();
                if (reason === 'time') {
                  const timeoutEmbed = new EmbedBuilder()
                    .setTitle('💨 시간 초과')
                    .setDescription(`바다 낚시를 진행하지 않고 멍하니 있다가 물고기가 도망갔습니다. 💤`)
                    .setColor(ERROR_COLOR)
                    .setTimestamp();

                  actionBtn.setLabel('낚시 중단... 💨').setStyle(ButtonStyle.Secondary).setDisabled(true);
                  interaction.editReply({
                    embeds: [timeoutEmbed],
                    components: [new ActionRowBuilder().addComponents(actionBtn)]
                  }).catch(() => null);
                }
              });
            }
          );
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('농사')
        .setDescription('밭에 씨앗을 뿌려 농작물을 수확합니다. (30초 재사용 대기시간)'),
      async execute(interaction) {
        const { user } = interaction;
        await ensureUser(user.id);

        db.get("SELECT last_farm FROM economy WHERE user_id = ?", [user.id], async (err, row) => {
          const now = Date.now();
          if (row && row.last_farm) {
            const diff = now - new Date(row.last_farm).getTime();
            if (diff < 30000) {
              const remaining = Math.ceil((30000 - diff) / 1000);
              return interaction.reply({ content: `⏳ 땅이 아직 숨을 쉬고 있습니다! **${remaining}초** 후에 다시 씨앗을 뿌릴 수 있습니다.`, ephemeral: true });
            }
          }

          const crop = getRandomReward(CROPS);
          
          db.run(
            "INSERT OR REPLACE INTO inventory (user_id, item_name, item_count) VALUES (?, ?, COALESCE((SELECT item_count FROM inventory WHERE user_id = ? AND item_name = ?), 0) + 1)",
            [user.id, crop.name, user.id, crop.name],
            () => {
              db.run(
                "UPDATE economy SET last_farm = ? WHERE user_id = ?",
                [new Date().toISOString(), user.id],
                async () => {
                  const embed = new EmbedBuilder()
                    .setTitle('🌱 농사 결과')
                    .setDescription(`${user} 님이 밭을 성심성의껏 가꾸어 농작물을 수확했습니다!`)
                    .addFields({ name: '수확한 작물', value: `${crop.emoji} **${crop.name}** (상점가: ${crop.value} 시아코인)` })
                    .setColor(SUCCESS_COLOR)
                    .setFooter({ text: '💡 "/판매" 명령어로 수확한 작물을 모두 팔 수 있습니다!' })
                    .setTimestamp();

                  return interaction.reply({ embeds: [embed] });
                }
              );
            }
          );
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('도박')
        .setDescription('가진 시아코인으로 스릴 넘치는 리얼 확률형 도박을 진행합니다.')
        .addIntegerOption(option => 
          option.setName('금액').setDescription('배팅할 시아코인 액수').setRequired(true).setMinValue(10)
        ),
      async execute(interaction) {
        const { user, options } = interaction;
        await ensureUser(user.id);

        const bet = options.getInteger('금액');
        const balance = await getUserMoney(user.id);

        if (balance < bet) {
          return interaction.reply({ content: `❌ 시아코인이 부족합니다! (보유: **${balance.toLocaleString()}** 시아코인)`, ephemeral: true });
        }

        // Send initial spinning visual
        const spinEmbed = new EmbedBuilder()
          .setTitle('🎰 슬롯머신이 작동되는 중...')
          .setDescription(
            `릴이 힘차게 돌아가고 있습니다! 잠시만 기다려 주세요...\n\n` +
            `🎰 **[ 🔄 | 🔄 | 🔄 ]**`
          )
          .setColor(MAIN_COLOR)
          .setTimestamp();

        const response = await interaction.reply({ embeds: [spinEmbed] });

        // Simulate a real-time slot machine spin delay
        setTimeout(async () => {
          const rand = Math.random();
          let winMultiplier = 0;
          let outcome = 'loss';
          let spinLayout = '';
          let resultTitle = '';

          if (rand < 0.02) { // 2% chance for Mega Jackpot (10x)
            winMultiplier = 10;
            outcome = 'megajackpot';
            spinLayout = '💎 | 💎 | 💎';
            resultTitle = '👑 메가 잭팟(MEGA JACKPOT)!!!';
          } else if (rand < 0.07) { // 5% chance for Jackpot (5x)
            winMultiplier = 5;
            outcome = 'jackpot';
            spinLayout = '🍒 | 🍒 | 🍒';
            resultTitle = '🎰 초대박 잭팟(JACKPOT)!!!';
          } else if (rand < 0.25) { // 18% chance for Double Success (2x)
            winMultiplier = 2;
            outcome = 'success';
            spinLayout = '🔔 | 🔔 | 🔔';
            resultTitle = '📈 배팅 대성공!';
          } else if (rand < 0.50) { // 25% chance for Small Win (1.2x)
            winMultiplier = 1.2;
            outcome = 'breakeven';
            spinLayout = '🍇 | 🍇 | 🍊';
            resultTitle = '⚖️ 본전 이상!';
          } else { // 50% chance for Loss (0x)
            winMultiplier = 0;
            outcome = 'loss';
            spinLayout = '🍋 | 🍌 | 🍇';
            resultTitle = '😭 배팅 실패...';
          }

          const change = winMultiplier > 0 ? Math.floor(bet * winMultiplier) - bet : -bet;
          await updateUserMoney(user.id, change);

          const finalBalance = balance + change;

          const embed = new EmbedBuilder()
            .setTitle(resultTitle)
            .setTimestamp();

          if (outcome === 'megajackpot') {
            embed.setDescription(`👑 **기적의 메가 잭팟이 터졌습니다!**\n슬롯머신의 모든 릴이 빛나는 다이아몬드로 가득 찼습니다!\n배팅액의 **10배**인 **${(bet * 10).toLocaleString()}** 시아코인을 획득했습니다! 🎉\n\n🎰 **[ ${spinLayout} ]**`)
              .addFields(
                { name: '배팅액', value: `${bet.toLocaleString()} 시아코인`, inline: true },
                { name: '순수익', value: `+${change.toLocaleString()} 시아코인`, inline: true },
                { name: '보유 자산', value: `**${finalBalance.toLocaleString()}** 시아코인`, inline: false }
              )
              .setColor(SUCCESS_COLOR);
          } else if (outcome === 'jackpot') {
            embed.setDescription(`🎰 **엄청난 확률의 잭팟!**\n삼색 체리가 나란히 일치하여 배팅에 초대박 성공했습니다!\n배팅액의 **5배**인 **${(bet * 5).toLocaleString()}** 시아코인을 획득했습니다! 🎉\n\n🎰 **[ ${spinLayout} ]**`)
              .addFields(
                { name: '배팅액', value: `${bet.toLocaleString()} 시아코인`, inline: true },
                { name: '순수익', value: `+${change.toLocaleString()} 시아코인`, inline: true },
                { name: '보유 자산', value: `**${finalBalance.toLocaleString()}** 시아코인`, inline: false }
              )
              .setColor(SUCCESS_COLOR);
          } else if (outcome === 'success') {
            embed.setDescription(`📈 **골든 벨이 울렸습니다!**\n배팅에 당당히 성공하여 배팅액의 **2배**인 **${(bet * 2).toLocaleString()}** 시아코인을 획득했습니다!\n\n🎰 **[ ${spinLayout} ]**`)
              .addFields(
                { name: '배팅액', value: `${bet.toLocaleString()} 시아코인`, inline: true },
                { name: '순수익', value: `+${change.toLocaleString()} 시아코인`, inline: true },
                { name: '보유 자산', value: `**${finalBalance.toLocaleString()}** 시아코인`, inline: false }
              )
              .setColor(SUCCESS_COLOR);
          } else if (outcome === 'breakeven') {
            embed.setDescription(`⚖️ **아슬아슬한 본전 사수!**\n과일들이 본전을 지켜주어 배팅액의 **1.2배**인 **${Math.floor(bet * 1.2).toLocaleString()}** 시아코인을 얻어 일부 이득을 챙겼습니다!\n\n🎰 **[ ${spinLayout} ]**`)
              .addFields(
                { name: '배팅액', value: `${bet.toLocaleString()} 시아코인`, inline: true },
                { name: '순수익', value: `+${change.toLocaleString()} 시아코인`, inline: true },
                { name: '보유 자산', value: `**${finalBalance.toLocaleString()}** 시아코인`, inline: false }
              )
              .setColor(INFO_COLOR);
          } else {
            embed.setDescription(`😭 **이런... 꽝입니다.**\n릴에 일치하는 문양이 없어 배팅액 **${bet.toLocaleString()}** 시아코인을 모두 잃었습니다. 다시 도전해 보세요!\n\n🎰 **[ ${spinLayout} ]**`)
              .addFields(
                { name: '잃은 액수', value: `${bet.toLocaleString()} 시아코인`, inline: true },
                { name: '보유 자산', value: `**${finalBalance.toLocaleString()}** 시아코인`, inline: true }
              )
              .setColor(ERROR_COLOR);
          }

          await interaction.editReply({ embeds: [embed] }).catch(() => null);
        }, 1200);
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('판매')
        .setDescription('인벤토리에 있는 모든 물고기와 농작물을 상점에 한꺼번에 일괄 판매합니다.'),
      async execute(interaction) {
        const { user } = interaction;
        await ensureUser(user.id);

        db.all("SELECT item_name, item_count FROM inventory WHERE user_id = ?", [user.id], async (err, rows) => {
          if (err || !rows || rows.length === 0) {
            return interaction.reply({ content: '🎒 인벤토리가 완전히 비어 있습니다! 낚시나 농사를 먼저 하고 오세요.', ephemeral: true });
          }

          let totalEarnings = 0;
          const soldDetails = [];

          for (const row of rows) {
            if (row.item_count <= 0) continue;

            const fishObj = FISHES.find(f => f.name === row.item_name);
            const cropObj = CROPS.find(c => c.name === row.item_name);
            const itemObj = fishObj || cropObj;

            if (itemObj) {
              const earnings = itemObj.value * row.item_count;
              totalEarnings += earnings;
              soldDetails.push(`${itemObj.emoji} **${row.item_name}** x${row.item_count}개 (+${earnings} 시아코인)`);
            }
          }

          if (totalEarnings === 0) {
            return interaction.reply({ content: '🎒 인벤토리에 판매할 수 있는 가치 있는 물건이 존재하지 않습니다.', ephemeral: true });
          }

          await updateUserMoney(user.id, totalEarnings);
          db.run("DELETE FROM inventory WHERE user_id = ?", [user.id], () => {
            const embed = new EmbedBuilder()
              .setTitle('💰 상점 일괄 판매 완료')
              .setDescription(`${user} 님이 소지하고 있던 전리품들을 모두 판매해 이득을 챙겼습니다!`)
              .addFields(
                { name: '정산 내역', value: soldDetails.join('\n') },
                { name: '총 정산 금액', value: `🎉 **+${totalEarnings.toLocaleString()}** 시아코인` }
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
        .setName('출석체크')
        .setDescription('매일 하루에 한 번 출석체크를 하고 1,000 시아코인을 받습니다. (글로벌 24시간 쿨타임)'),
      async execute(interaction) {
        const { user } = interaction;
        await ensureUser(user.id);

        db.get("SELECT last_daily FROM economy WHERE user_id = ?", [user.id], async (err, row) => {
          const now = Date.now();
          if (row && row.last_daily) {
            const diff = now - new Date(row.last_daily).getTime();
            const dailyCooldown = 24 * 60 * 60 * 1000;
            if (diff < dailyCooldown) {
              const remainingMs = dailyCooldown - diff;
              const hours = Math.floor(remainingMs / (60 * 60 * 1000));
              const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
              return interaction.reply({ content: `⏳ 출석체크는 서버 통합 24시간당 1회만 가능합니다!\n이미 다른 서버 또는 본 서버에서 수령하셨습니다. 남은 시간: **${hours}시간 ${minutes}분**`, ephemeral: true });
            }
          }

          await updateUserMoney(user.id, 1000);
          db.run(
            "UPDATE economy SET last_daily = ? WHERE user_id = ?",
            [new Date().toISOString(), user.id],
            async () => {
              const balance = await getUserMoney(user.id);
              const embed = new EmbedBuilder()
                .setTitle('🎁 글로벌 출석체크 완료')
                .setDescription(`오늘의 출석 보상 **1,000 시아코인**이 든든하게 입금되었습니다! 💸\n(※ 출석 보상은 모든 서버를 통틀어 단 하루 한 번만 수령 가능합니다)`)
                .addFields({ name: '현재 보유 자산', value: `**${balance.toLocaleString()}** 시아코인` })
                .setColor(SUCCESS_COLOR)
                .setTimestamp();

              return interaction.reply({ embeds: [embed] });
            }
          );
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName('내정보')
        .setDescription('나의 보유 시아코인 및 인벤토리 아이템 상태를 예쁜 카드형태로 확인합니다.'),
      async execute(interaction) {
        const { user } = interaction;
        await ensureUser(user.id);

        const balance = await getUserMoney(user.id);

        db.all("SELECT item_name, item_count FROM inventory WHERE user_id = ?", [user.id], (err, rows) => {
          const embed = new EmbedBuilder()
            .setTitle(`💳 ${user.username} 님의 개인 정보 지갑 (시아 가상 은행)`)
            .addFields({ name: '🪙 보유 시아코인', value: `**${balance.toLocaleString()}** 시아코인`, inline: false })
            .setColor(MAIN_COLOR)
            .setThumbnail(user.displayAvatarURL())
            .setTimestamp();

          const inventoryItems = [];
          if (rows && rows.length > 0) {
            for (const row of rows) {
              if (row.item_count <= 0) continue;
              const fishObj = FISHES.find(f => f.name === row.item_name);
              const cropObj = CROPS.find(c => c.name === row.item_name);
              const itemObj = fishObj || cropObj;

              if (itemObj) {
                inventoryItems.push(`${itemObj.emoji} **${row.item_name}** x${row.item_count}개`);
              }
            }
          }

          if (inventoryItems.length > 0) {
            embed.addFields({ name: '🎒 소지품 가방', value: inventoryItems.join('\n'), inline: false });
          } else {
            embed.addFields({ name: '🎒 소지품 가방', value: '가방이 텅 비어 있습니다! 🎣`/낚시`나 🌱`/농사`를 지어 전리품을 채워보세요.', inline: false });
          }

          return interaction.reply({ embeds: [embed] });
        });
      }
    }
  ]
};
