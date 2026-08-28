import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { PostWeatherAgent } from '../../../../../src/services/llm/agents/postWeatherAgent';

describe('PostWeatherAgent Integration', () => {
  const forecastPath = path.join(process.cwd(), 'saves/prompts/forecast.md');
  const weatherToEmojiPath = path.join(
    process.cwd(),
    'saves/prompts/weather_to_emoji.md'
  );
  let originalForecast: string | null = null;
  let originalWeatherToEmoji: string | null = null;

  beforeAll(() => {
    if (fs.existsSync(forecastPath)) {
      originalForecast = fs.readFileSync(forecastPath, 'utf-8');
    }
    if (fs.existsSync(weatherToEmojiPath)) {
      originalWeatherToEmoji = fs.readFileSync(weatherToEmojiPath, 'utf-8');
    }
  });

  it.skip('should create weather post', async () => {
    const agent = await PostWeatherAgent.create();
    const result = await agent.createPost();
    console.log(result);
  }, 30000);

  afterAll(() => {
    if (originalForecast) {
      fs.writeFileSync(forecastPath, originalForecast);
    }
    if (originalWeatherToEmoji) {
      fs.writeFileSync(weatherToEmojiPath, originalWeatherToEmoji);
    }
  });
});
