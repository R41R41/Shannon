import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

interface Reservation { version: 1; day: string; requests: number; reservedTokens: number }
const memory = new Map<string, Reservation>();
const integer = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('MINECRAFT_MODEL_BUDGET_INVALID');
  return parsed;
};

/** Reserve before transmission, including failed requests. No secrets or prompts
 * are persisted. This is a conservative token reservation, not a billing ledger.
 * A file lock serializes reservations across processes; failure is fail-closed.
 */
export function reserveMinecraftModelRequest(body: string, environment = process.env): void {
  const day = new Date().toISOString().slice(0, 10);
  const file = environment.MINECRAFT_MODEL_BUDGET_FILE;
  const key = file ?? 'process';
  const requestsLimit = integer(environment.MINECRAFT_MODEL_DAILY_REQUEST_LIMIT, 300);
  const tokensLimit = integer(environment.MINECRAFT_MODEL_DAILY_TOKEN_RESERVATION, 2_000_000);
  const request = JSON.parse(body);
  const output = request.max_output_tokens ?? request.max_tokens ?? 4096; // Jev does not expose a hard output cap.
  if (!Number.isSafeInteger(output) || output < 1) throw new Error('MINECRAFT_MODEL_OUTPUT_LIMIT_INVALID');
  const tokens = Buffer.byteLength(body, 'utf8') + output + 4096;
  let lock: number | undefined;
  let temporary: string | undefined;
  try {
    if (file) {
      if (!path.isAbsolute(file)) throw new Error('MINECRAFT_MODEL_BUDGET_ABSOLUTE_PATH_REQUIRED');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      lock = fs.openSync(`${file}.lock`, 'wx', 0o600);
    }
    let state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : memory.get(key);
    if (state && (state.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(state.day)
      || !Number.isSafeInteger(state.requests) || state.requests < 0
      || !Number.isSafeInteger(state.reservedTokens) || state.reservedTokens < 0)) throw new Error('MINECRAFT_MODEL_BUDGET_CORRUPT');
    if (state?.day > day) throw new Error('MINECRAFT_MODEL_BUDGET_CLOCK_REVERSED');
    if (!state || state.day < day) state = { version: 1, day, requests: 0, reservedTokens: 0 };
    if (state.requests + 1 > requestsLimit || state.reservedTokens + tokens > tokensLimit) throw new Error('MINECRAFT_MODEL_BUDGET_EXHAUSTED');
    const next: Reservation = { ...state, requests: state.requests + 1, reservedTokens: state.reservedTokens + tokens };
    if (file) {
      temporary = `${file}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file); temporary = undefined;
      const directoryFd = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
    memory.set(key, next);
  } finally {
    if (temporary) fs.unlinkSync(temporary);
    if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(`${file}.lock`); }
  }
}

export const budgetedMinecraftFetch: typeof fetch = async (url, options) => {
  if (typeof options?.body !== 'string') throw new Error('MINECRAFT_MODEL_BODY_REQUIRED');
  reserveMinecraftModelRequest(options.body);
  return fetch(url, options);
};
