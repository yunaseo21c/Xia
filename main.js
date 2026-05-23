const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  Collection, 
  REST, 
  Routes,
  SectionBuilder
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { Koreanbots } = require('koreanbots');
const { BETA_TOKEN, BOT_NAME, KOREANBOTS_TOKEN } = require('./core/config');

// Global Hotfix: Fix SectionBuilder.toJSON() bug where it crashes on serializing undefined accessories
if (SectionBuilder) {
  SectionBuilder.prototype.toJSON = function () {
    const data = {
      ...this.data,
      components: this.components.map((component) => component.toJSON())
    };
    if (this.accessory) {
      data.accessory = this.accessory.toJSON();
    }
    return data;
  };
}

// Initialize Client with all necessary Intents and Partials (for uncached audit-log/message deletion fetches)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.AutoModerationConfiguration,
    GatewayIntentBits.AutoModerationExecution
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.GuildMember,
    Partials.User
  ]
});

// Collections to store commands
client.commands = new Collection();

// 1. Dynamic Cog Loader
function loadCogs() {
  const cogsPath = path.join(__dirname, 'cogs');
  const cogFiles = fs.readdirSync(cogsPath).filter(file => file.endsWith('.js'));

  for (const file of cogFiles) {
    try {
      const cog = require(path.join(cogsPath, file));
      console.log(`Loading cog: ${cog.name || file}`);

      // Register Slash Commands
      if (cog.commands && Array.isArray(cog.commands)) {
        for (const cmd of cog.commands) {
          if (cmd.data && cmd.execute) {
            client.commands.set(cmd.data.name, cmd);
          }
        }
      }

      // Bind Event Listeners
      if (cog.listeners && typeof cog.listeners === 'object') {
        for (const [eventName, listenerFn] of Object.entries(cog.listeners)) {
          // Binds client as first argument to event listener to resemble Pycord cog architecture
          client.on(eventName, (...args) => listenerFn(client, ...args));
        }
      }
    } catch (error) {
      console.error(`Failed to load cog ${file}:`, error);
    }
  }
}

// 2. Deploy Slash Commands to Discord API
async function deploySlashCommands() {
  const commandsData = [];
  client.commands.forEach(command => {
    commandsData.push(command.data.toJSON());
  });

  const rest = new REST({ version: '10' }).setToken(BETA_TOKEN);

  try {
    console.log('Started deploying application (/) commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commandsData }
    );
    console.log('Successfully deployed application (/) commands.');
  } catch (error) {
    console.error('Failed to deploy slash commands:', error);
  }
}

// 3. Ready Event: Initialize Slash commands deployment & KoreanBots Integration
client.once('ready', async () => {
  console.log(`${client.user.tag}로 로그인하였습니다.`);
  
  // Deploy slash commands automatically on startup
  await deploySlashCommands();

  /* 
  // KoreanBots Integration (per https://js-sdk-docs.pages.dev/#사용법)
  try {
    const kbClient = new Koreanbots({
      api: { token: KOREANBOTS_TOKEN },
      clientID: '1096067976068870144'
    });

    // Monkey-patch to prevent crashing if any linked bot does not exist/is deleted on KoreanBots
    const originalFetch = kbClient.bots.fetch.bind(kbClient.bots);
    kbClient.bots.fetch = async (...args) => {
      try {
        return await originalFetch(...args);
      } catch (e) {
        console.log(`[KoreanBots Warning] Bypassed error fetching bot ${args[0]}: ${e.message}`);
        return null;
      }
    };

    const updateStats = (servers) => {
      kbClient.mybot.update({ servers, shards: client.shard?.count })
        .then(res => console.log("서버 수를 정상적으로 업데이트하였습니다!\n반환된 정보: " + JSON.stringify(res)))
        .catch(e => console.log("KoreanBots integration failed (likely 404):", e.message || e));
    };

    // Initial update and periodic interval update (every 10 minutes)
    updateStats(client.guilds.cache.size);
    setInterval(() => updateStats(client.guilds.cache.size), 600000);
  } catch (e) {
    console.error("Failed to initialize KoreanBots:", e);
  }
  */
});

// Function to mask sensitive data and send a premium error embed to Discord log channel
async function sendSystemErrorLog(guild, err, contextName) {
  if (!guild) return;
  try {
    const loggingCog = require('./cogs/logging_cog');
    const getLogChannel = (client, guildId, type) => {
      const guildData = loggingCog.logSettingsCache.get(guildId.toString());
      if (!guildData || !guildData.channels || !guildData.channels[type]) return null;
      return client.channels.cache.get(guildData.channels[type].id) || null;
    };

    const logChannel = getLogChannel(client, guild.id, 'log_update') || getLogChannel(client, guild.id, 'log_chat');
    if (!logChannel) return;

    let errStack = err.stack || err.toString();
    const cwd = process.cwd();
    const cwdEscaped = cwd.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    errStack = errStack.replace(new RegExp(cwdEscaped, 'g'), '[Project_Root]');

    const homeDir = process.env.HOME || '/Users/seoyuna';
    const homeEscaped = homeDir.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    errStack = errStack.replace(new RegExp(homeEscaped, 'g'), '[User_Home]');

    if (BETA_TOKEN) {
      const tokenEscaped = BETA_TOKEN.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      errStack = errStack.replace(new RegExp(tokenEscaped, 'g'), '[SENSITIVE_BETA_TOKEN]');
    }

    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setTitle("⚠️ 시스템 오류(에러 로그)가 감지되었어요 !")
      .setDescription(`**${contextName}** 수행 도중 예외가 발생했어요.`)
      .setColor(0xEF4444)
      .addFields(
        { name: "🔍 오류 메세지", value: `\`\`\`js\n${err.message || err.toString()}\n\`\`\``, inline: false },
        { name: "📜 스택 트레이스 (민감정보 마스킹 완료)", value: `\`\`\`js\n${errStack.substring(0, 1000)}\n\`\`\``, inline: false }
      )
      .setTimestamp();

    await logChannel.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.error("Failed to send error log to discord channel:", e);
  }
}

// 4. Slash Commands Interaction Handler
client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command && typeof command.autocomplete === 'function') {
      try {
        await command.autocomplete(interaction);
      } catch (error) {
        console.error('Error during autocomplete:', error);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand() && !interaction.isContextMenuCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  // Standard discord embeds will be used without Components V2 conversion as per request.

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error executing slash command ${interaction.commandName}:`, error);
    
    const { EmbedBuilder, MessageFlags } = require('discord.js');
    const errorEmbed = new EmbedBuilder()
      .setTitle("⚠️ 오류가 발생했어요")
      .setDescription(`오류가 발생했어요. 아래의 오류코드를 복사하여 [공식 저장소 > 이슈탭](https://github.com/yunaseo21c/Xia/issues)에 등재해주세요.\n\n\`\`\`js\n${error.stack || error.toString()}\n\`\`\``)
      .setColor(0xEF4444)
      .setTimestamp();

    const errorMsg = { embeds: [errorEmbed], flags: [MessageFlags.Ephemeral] };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorMsg).catch(() => {});
    } else {
      await interaction.reply(errorMsg).catch(() => {});
    }

    // Report error to guild moderation logs, masking sensitive info
    await sendSystemErrorLog(interaction.guild, error, `슬래시 명령어 /${interaction.commandName}`);
  }
});


// Start the bot
(() => {
  loadCogs();
  client.login(BETA_TOKEN).catch(err => {
    console.error("Login failed! Double-check the BETA_TOKEN.", err);
  });
})();
