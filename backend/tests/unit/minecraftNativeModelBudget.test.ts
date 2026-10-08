import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reserveMinecraftModelRequest } from '../../src/services/minebot/cognition/MinecraftModelBudget.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const fixture = (tokens: number) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-native-reservation-')); dirs.push(dir);
  return { MINECRAFT_MODEL_BUDGET_FILE: path.join(dir, 'budget.json'),
    MINECRAFT_MODEL_DAILY_REQUEST_LIMIT: '2', MINECRAFT_MODEL_DAILY_TOKEN_RESERVATION: String(tokens) };
};
describe('native Minecraft model reservations', () => {
  it('reserves native max_tokens in full before dispatch and keeps the same ledger across restart', () => {
    const body = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8192, messages: [{ role: 'user', content: 'fixture' }] });
    const expected = Buffer.byteLength(body, 'utf8') + 8192 + 4096;
    const env = fixture(expected * 2);
    reserveMinecraftModelRequest(body, env);
    let saved = JSON.parse(fs.readFileSync(env.MINECRAFT_MODEL_BUDGET_FILE, 'utf8'));
    expect(saved.reservedTokens).toBe(expected); expect(saved.requests).toBe(1);
    reserveMinecraftModelRequest(body, { ...env });
    saved = JSON.parse(fs.readFileSync(env.MINECRAFT_MODEL_BUDGET_FILE, 'utf8'));
    expect(saved.reservedTokens).toBe(expected * 2);
    expect(() => reserveMinecraftModelRequest(body, env)).toThrow('EXHAUSTED');
    expect(fs.readFileSync(env.MINECRAFT_MODEL_BUDGET_FILE, 'utf8')).not.toContain('fixture');
    expect(fs.existsSync(env.MINECRAFT_MODEL_BUDGET_FILE + '.lock')).toBe(false);
  });
  it('refuses a native request that only the previous 4096 fallback would have admitted', () => {
    const body = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8192, messages: [] });
    const env = fixture(Buffer.byteLength(body, 'utf8') + 4096 + 4096);
    expect(() => reserveMinecraftModelRequest(body, env)).toThrow('EXHAUSTED');
    expect(fs.existsSync(env.MINECRAFT_MODEL_BUDGET_FILE)).toBe(false);
    expect(fs.existsSync(env.MINECRAFT_MODEL_BUDGET_FILE + '.lock')).toBe(false);
  });
  it.each([0, -1, 1.5, '8192'])('rejects malformed native max_tokens %s before reservation', max_tokens => {
    const env = fixture(100000);
    expect(() => reserveMinecraftModelRequest(JSON.stringify({ max_tokens }), env)).toThrow('OUTPUT_LIMIT_INVALID');
    expect(fs.existsSync(env.MINECRAFT_MODEL_BUDGET_FILE)).toBe(false);
  });
  it('keeps Responses max_output_tokens and the legacy absent-cap fallback unchanged', () => {
    for (const [body, output] of [[JSON.stringify({ max_output_tokens: 100, max_tokens: 8192 }), 100], [JSON.stringify({ provider: 'jev' }), 4096]] as const) {
      const env = fixture(100000); reserveMinecraftModelRequest(body, env);
      expect(JSON.parse(fs.readFileSync(env.MINECRAFT_MODEL_BUDGET_FILE, 'utf8')).reservedTokens).toBe(Buffer.byteLength(body, 'utf8') + output + 4096);
    }
  });
});
