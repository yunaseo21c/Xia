const { EmbedBuilder } = require('discord.js');

// Load environment variables
require('dotenv').config();

// Tokens
const BETA_TOKEN = process.env.DISCORD_BETA_TOKEN;
const TOKEN = process.env.DISCORD_TOKEN;
const KOREANBOTS_TOKEN = process.env.KOREANBOTS_TOKEN;
const RESTART_WEBHOOK_URL = process.env.RESTART_WEBHOOK_URL;

// Bot Information
const BOT_NAME = '시아'; // Changed from 'Bot Think[V2]' to '시아'
const ALLOWED_USER_ID = '942221019089895427';
const NEW_SERVER_LOG_CHANNEL_ID = '1166634737218109492';

// File Paths
const LOG_SETTINGS_FILE = 'log_settings.json';
const USER_DATA_FILE = 'user_data.json';

// Aesthetics (Colors)
const MAIN_COLOR = 0x2e2c31;
const SUCCESS_COLOR = 0x40C219;
const ERROR_COLOR = 0xff0000;
const INFO_COLOR = 0x0000ff;

// Embeds (Returning new instances to prevent state mutations)
const PERMISSION_ERROR_EMBED = () => new EmbedBuilder()
  .setTitle("<:error_permission:1218502280232308777> 권한 없음")
  .setDescription("해당 명령어를 사용할 수 있는 권한이 없어요...\n역할이 부족한 게 아니라, 아직 **등록이 안 된 사용자**에요!\n`/가입` 명령어를 통해 먼저 가입해볼까요?")
  .setColor(MAIN_COLOR);

const ACCESS_ERROR_EMBED = () => new EmbedBuilder()
  .setTitle("<:error_permission:1218502280232308777> 명령어 액세스 권한 없음")
  .setDescription("해당 명령어를 사용할 수 있는 권한이 없어요...\n역할이 부족한 게 아니라, 아직 **등록이 안 된 사용자**에요!\n`/가입` 명령어를 통해 먼저 가입해볼까요?")
  .setColor(MAIN_COLOR);

module.exports = {
  BETA_TOKEN,
  TOKEN,
  KOREANBOTS_TOKEN,
  RESTART_WEBHOOK_URL,
  BOT_NAME,
  ALLOWED_USER_ID,
  NEW_SERVER_LOG_CHANNEL_ID,
  LOG_SETTINGS_FILE,
  USER_DATA_FILE,
  MAIN_COLOR,
  SUCCESS_COLOR,
  ERROR_COLOR,
  INFO_COLOR,
  PERMISSION_ERROR_EMBED,
  ACCESS_ERROR_EMBED
};
