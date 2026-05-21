const { 
  SlashCommandBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  MessageFlags,
  ThumbnailBuilder
} = require('discord.js');

module.exports = {
  name: 'Music',
  description: '음악을 틀어보세요',

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('음악')
        .setDescription('음악을 틀어보세요 !'),
      async execute(interaction) {
        const container = new ContainerBuilder()
          .setAccentColor(0x3B82F6)
          .addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# 서버의 모든 것, 올인원 봇 '소별이' ✨\n\n` +
                  `관리부터 유틸, 그리고 미니게임까지 봇 하나로 끝내고 싶다면?\n\n` +
                  `지금 바로 소별이를 서버에 초대해 보세요!\n\n` +
                  `### ✨ 왜 소별이를 써야 할까요?\n` +
                  `🎵 [고음질 음악] 끊김 없고 깔끔한 음악 스트리밍\n` +
                  `🛠️ [완벽한 관리] 상세한 로그 레벨링 & 안전한 경고 시스템\n` +
                  `🎮 [미니게임] 농장, 끝말잇기, 짜릿한 슬롯머신과 도박 시스템\n` +
                  `💻 [웹 대시보드] 복잡한 명령어 없이 웹에서 클릭 몇 번으로 간편 설정!`
                )
              )
              .setThumbnailAccessory(
                new ThumbnailBuilder()
                  .setURL('https://sobyeol.kr/_next/image?url=%2Fsmallstar-Photoroom.png&w=128&q=75')
              )
          );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('⭐ 소별이 초대하기')
            .setStyle(ButtonStyle.Link)
            .setURL('https://sobyeol.kr/invite'),
          new ButtonBuilder()
            .setLabel('💬 소별이 공식 서포트 서버')
            .setStyle(ButtonStyle.Link)
            .setURL('https://discord.gg/tCXDXFbswM'),
          new ButtonBuilder()
            .setLabel('🛠️ 소별이 공식 대시보드')
            .setStyle(ButtonStyle.Link)
            .setURL('https://sobyeol.kr/')
        );

        container.addActionRowComponents(row);

        return interaction.reply({
          components: [container],
          flags: [MessageFlags.IsComponentsV2]
        });
      }
    }
  ]
};
