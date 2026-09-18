/**
 * Isolated Discord test-server harness for generated artifacts.
 *
 * This intentionally starts only the LLM graph and Discord adapter. It does
 * not start the scheduler, Twitter, YouTube, Minecraft, or the web server.
 */

if (process.env.SHANNON_ENABLE_DISCORD_ARTIFACT_TEST !== 'true') {
  throw new Error('Set SHANNON_ENABLE_DISCORD_ARTIFACT_TEST=true to run this harness');
}
if (!process.env.DISCORD_TOKEN_TEST) {
  throw new Error('DISCORD_TOKEN_TEST is required');
}
const testChannelId = process.env.TEST_DEV_CHANNEL_ID || process.env.TEST_X_CHANNEL_ID;
if (!process.env.TEST_GUILD_ID || !testChannelId) {
  throw new Error('TEST_GUILD_ID and TEST_DEV_CHANNEL_ID (or TEST_X_CHANNEL_ID) are required');
}

// A test harness must remain safe even if an older config build accidentally
// reads DISCORD_TOKEN. Never expose the production token to this process.
process.env.DISCORD_TOKEN = '';
process.env.IS_DEV = 'True';
process.env.TWITTER_DISABLED = 'true';

const { LLMService } = await import('../dist/services/llm/client.js');
const { DiscordBot } = await import('../dist/services/discord/client.js');
const { config } = await import('../dist/config/env.js');
const { getEventBus } = await import('../dist/services/eventBus/index.js');
const mongoose = (await import('mongoose')).default;

await mongoose.connect(config.mongodbUri);

const llm = LLMService.getInstance(true);
await llm.initialize();

const discord = DiscordBot.getInstance(true);
await discord.start();

console.log(`[DiscordArtifactHarness] Ready for guild ${process.env.TEST_GUILD_ID}`);

const testPrompt = process.env.SHANNON_ARTIFACT_TEST_PROMPT?.trim();
if (testPrompt) {
  const requesterUserId = process.env.SHANNON_ARTIFACT_TEST_USER_ID?.trim();
  if (!requesterUserId) {
    throw new Error('SHANNON_ARTIFACT_TEST_USER_ID is required with SHANNON_ARTIFACT_TEST_PROMPT');
  }
  console.log('[DiscordArtifactHarness] Publishing one synthetic test-server request');
  getEventBus().publish({
    type: 'llm:get_discord_message',
    memoryZone: 'discord:test_server',
    data: {
      type: 'text',
      guildName: 'シャノンテスト用サーバー',
      channelName: 'dev',
      guildId: process.env.TEST_GUILD_ID,
      channelId: testChannelId,
      messageId: `artifact-harness-${Date.now()}`,
      userId: requesterUserId,
      userName: 'Rai（E2Eテスト）',
      text: testPrompt,
      recentMessages: [],
    },
  });
}

const shutdown = async (signal) => {
  console.log(`[DiscordArtifactHarness] ${signal}; stopping`);
  await mongoose.disconnect();
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

await new Promise(() => {});
