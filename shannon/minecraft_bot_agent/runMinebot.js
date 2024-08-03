const mineflayer = require('mineflayer');
const dotenv = require('dotenv');
const SkillExecutor = require('./SkillExecutor');
const collectBlock = require('mineflayer-collectblock').plugin
const { pathfinder } = require('mineflayer-pathfinder');
const minecraftHawkEye = require('minecrafthawkeye').default;
const pvp = require('mineflayer-pvp').plugin
const toolPlugin = require('mineflayer-tool').plugin
const projectile = require("mineflayer-projectile").plugin
const Utils = require('./utils');


dotenv.config();

if (!process.env.MINECRAFT_BOT_USER_NAME || !process.env.MINECRAFT_BOT_PASSWORD) {
  throw new Error('MINECRAFT_BOT_USER_NAME and MINECRAFT_BOT_PASSWORD must be set');
}

const username = process.env.MINECRAFT_BOT_USER_NAME;
// const password = process.env.MINECRAFT_BOT_PASSWORD;

/**
 * @type {import('./types').CustomBot}
 */
const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: Number(process.argv[2]) || 25565,
  username: username,
  auth: 'microsoft',
  disableChatSigning: true,
  checkTimeoutInterval: 60 * 60 * 1000,
  version: "1.20.4"
});


bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock);
bot.loadPlugin(minecraftHawkEye);
bot.loadPlugin(pvp)
bot.loadPlugin(toolPlugin)
bot.loadPlugin(projectile)

bot.on('login', async () => {
    console.log('Bot has logged in.');
});

bot.isTest = process.env.IS_TEST === 'True' || process.argv[3] === 'test';
bot.chatMode = true;
bot.attackEntity = null;
bot.runFromEntity = null;
bot.goal = null;
bot.instantSkills = {};
bot.constantSkills = {};
bot.utils = new Utils(bot);

bot.on('respawn', () => {
  bot.attackEntity = null;
  bot.runFromEntity = null;
  bot.goal = null;
  console.log('Bot has respawned.');
});

const skillExecutor = new SkillExecutor(bot);

async function startBot() {
  const startServerResponse = await skillExecutor.startServer();
  if (!startServerResponse.success) {
    console.log(`botの正常な起動に失敗しました: ${startServerResponse.result}`);
  }
}

startBot().catch(console.error);

process.on('uncaughtException', (error) => {
  console.error('未処理の例外が発生しました:', error.message);
  // 必要に応じて、プロセスを終了しないようにする
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未処理のPromise拒否が発生しました:', reason.message);
  // 必要に応じて、プロセスを終了しないようにする
});