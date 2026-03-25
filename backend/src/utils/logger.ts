/**
 * Shared structured logger utility.
 *
 * Each log line includes:
 *   - Timestamp (JST, ms precision)
 *   - Log level (INFO / ERROR / WARN / SUCCESS / DEBUG)
 *   - LOG_ID  (session-scoped sequential ID for tracing)
 *   - Message body
 *
 * Format (terminal):
 *   2026-02-16 19:30:45.123 [INFO   ] #0001 Server started   (with ANSI colors)
 *
 * Format (file):
 *   2026-02-16 19:30:45.123 [INFO   ] #0001 Server started   (plain text)
 *
 * File logging:
 *   import { logger, initFileLogging } from '../../utils/logger.js';
 *   initFileLogging('/path/to/logs');  // call once at startup
 *
 * Service-specific logs:
 *   createLogger('Minebot:Client')  → also writes to minebot-YYYYMMDD.log
 *   createLogger('Twitter:API')     → also writes to twitter-YYYYMMDD.log
 *   createLogger('Discord:Voice')   → also writes to discord-YYYYMMDD.log
 *
 * Usage:
 *   logger.info('Server started', 'blue');
 *   logger.error('Connection failed');
 *   logger.success('Task completed');
 */
import { existsSync, mkdirSync, createWriteStream, type WriteStream } from 'fs';
import { join } from 'path';
import type { Color } from '@shannon/common';

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------
const ANSI: Record<Color, string> = {
  white: '\x1b[37m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function colorize(text: string, color: Color): string {
  return `${ANSI[color]}${text}${RESET}`;
}

/** Strip all ANSI escape codes from a string */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Service categories for per-service log files
// ---------------------------------------------------------------------------
export type ServiceCategory = 'twitter' | 'minebot' | 'discord' | 'website';

const SERVICE_STREAMS: Map<ServiceCategory, { stream: WriteStream | null; dateKey: string }> = new Map();

function getServiceFileName(service: ServiceCategory): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${service}-${y}${mo}${d}.log`;
}

function ensureServiceStream(service: ServiceCategory): WriteStream | null {
  if (!logDir) return null;

  const fileName = getServiceFileName(service);
  const entry = SERVICE_STREAMS.get(service);

  if (entry && entry.dateKey === fileName) return entry.stream;

  if (entry?.stream) entry.stream.end();

  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  const stream = createWriteStream(join(logDir, fileName), { flags: 'a' });
  SERVICE_STREAMS.set(service, { stream, dateKey: fileName });
  return stream;
}

function writeToServiceFile(
  service: ServiceCategory,
  line: string,
  jsonPayload?: { level: Level; message: string; service: ServiceCategory; error?: string },
): void {
  if (!logDir) return;
  const stream = ensureServiceStream(service);
  if (!stream) return;

  if (LOG_FORMAT === 'json' && jsonPayload) {
    const entry = { timestamp: new Date().toISOString(), ...jsonPayload };
    stream.write(JSON.stringify(entry) + '\n');
  } else {
    stream.write(stripAnsi(line) + '\n');
  }
}

/** Infer service category from a createLogger prefix */
function inferService(prefix: string): ServiceCategory | undefined {
  const lower = prefix.toLowerCase();
  if (lower.startsWith('minebot:') || lower.startsWith('minecraft:')) return 'minebot';
  if (lower.startsWith('discord:')) return 'discord';
  if (lower.startsWith('twitter:')) return 'twitter';
  if (lower.startsWith('website:') || lower.startsWith('web:') || lower.startsWith('publicchat:')) return 'website';
  return undefined;
}

// ---------------------------------------------------------------------------
// Log level filtering for file output
// ---------------------------------------------------------------------------

/**
 * LOG_FILE_MIN_LEVEL: minimum level written to log file.
 *   'debug' — write everything (DEBUG / INFO / WARN / ERROR / SUCCESS)
 *   'info'  — skip DEBUG (default, keeps log files clean in prod)
 * Set via env: LOG_FILE_MIN_LEVEL=debug
 */
const LOG_FILE_MIN_LEVEL: 'debug' | 'info' =
  (process.env.LOG_FILE_MIN_LEVEL === 'debug') ? 'debug' : 'info';

/**
 * LOG_FORMAT: ログファイルの出力形式。
 *   'text'  — 従来のプレーンテキスト形式（デフォルト）
 *   'json'  — 1行1JSONオブジェクト（ELK/CloudWatch等との連携用）
 * Set via env: LOG_FORMAT=json
 */
const LOG_FORMAT: 'text' | 'json' =
  (process.env.LOG_FORMAT === 'json') ? 'json' : 'text';

function shouldWriteToFile(level: Level): boolean {
  if (LOG_FILE_MIN_LEVEL === 'debug') return true;
  return level !== 'DEBUG';
}

// ---------------------------------------------------------------------------
// File logging (optional, call initFileLogging() to enable)
// ---------------------------------------------------------------------------
let fileStream: WriteStream | null = null;
let currentLogDate = '';

/** Directory for log files (set by initFileLogging) */
let logDir = '';

function getLogFileName(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `prod-${y}${mo}${d}.log`;
}

function ensureFileStream(): void {
  if (!logDir) return;

  const fileName = getLogFileName();
  const dateKey = fileName;

  // Rotate on date change
  if (dateKey !== currentLogDate) {
    if (fileStream) {
      fileStream.end();
    }
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    fileStream = createWriteStream(join(logDir, fileName), { flags: 'a' });
    currentLogDate = dateKey;
  }
}

function writeToFile(
  line: string,
  jsonPayload?: { level: Level; message: string; error?: string },
  service?: ServiceCategory,
): void {
  if (!logDir) return;
  ensureFileStream();
  if (LOG_FORMAT === 'json' && jsonPayload) {
    const entry = {
      timestamp: new Date().toISOString(),
      ...jsonPayload,
    };
    fileStream?.write(JSON.stringify(entry) + '\n');
  } else {
    fileStream?.write(stripAnsi(line) + '\n');
  }

  if (service) {
    writeToServiceFile(service, line, jsonPayload ? { ...jsonPayload, service } : undefined);
  }
}

/**
 * Enable file logging. Call once at startup.
 * Logs are written as plain text (no ANSI codes) to `<dir>/prod-YYYYMMDD.log`.
 * Service-specific logs go to `<dir>/{service}-YYYYMMDD.log`.
 * Files rotate automatically at midnight (JST).
 */
export function initFileLogging(dir: string): void {
  logDir = dir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  ensureFileStream();
  console.log(`📁 File logging enabled: ${dir}`);
}

// ---------------------------------------------------------------------------
// Log ID (session-scoped sequential counter)
// ---------------------------------------------------------------------------
let logCounter = 0;

function nextLogId(): string {
  logCounter += 1;
  return String(logCounter).padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Timestamp (JST)
// ---------------------------------------------------------------------------
function timestamp(): string {
  const now = new Date();
  // JST = UTC+9
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const mi = String(jst.getUTCMinutes()).padStart(2, '0');
  const s = String(jst.getUTCSeconds()).padStart(2, '0');
  const ms = String(jst.getUTCMilliseconds()).padStart(3, '0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms}`;
}

// ---------------------------------------------------------------------------
// Level tags (fixed width 7 chars including brackets)
// ---------------------------------------------------------------------------
type Level = 'INFO' | 'ERROR' | 'WARN' | 'SUCCESS' | 'DEBUG';

const LEVEL_COLORS: Record<Level, Color> = {
  INFO: 'white',
  ERROR: 'red',
  WARN: 'yellow',
  SUCCESS: 'green',
  DEBUG: 'cyan',
};

function formatPrefix(level: Level): string {
  const ts = `${DIM}${timestamp()}${RESET}`;
  const tag = colorize(`[${level.padEnd(7)}]`, LEVEL_COLORS[level]);
  const id = `${DIM}#${nextLogId()}${RESET}`;
  return `${ts} ${tag} ${id}`;
}

// ---------------------------------------------------------------------------
// Internal logging with optional service routing
// ---------------------------------------------------------------------------
function _info(message: string, color?: Color, service?: ServiceCategory): void {
  const body = color ? colorize(message, color) : message;
  const line = `${formatPrefix('INFO')} ${body}`;
  console.log(line);
  writeToFile(line, { level: 'INFO', message }, service);
}

function _error(message: string, error?: unknown, service?: ServiceCategory): void {
  const errStr = error
    ? String(error instanceof Error ? error.stack || error.message : error)
    : undefined;
  const fullMessage = errStr ? `${message} ${errStr}` : message;
  const line = `${formatPrefix('ERROR')} ${colorize(fullMessage, 'red')}`;
  console.error(line);
  writeToFile(line, { level: 'ERROR', message: fullMessage, error: errStr }, service);
  if (error && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
}

function _warn(message: string, service?: ServiceCategory): void {
  const line = `${formatPrefix('WARN')} ${colorize(message, 'yellow')}`;
  console.log(line);
  writeToFile(line, { level: 'WARN', message }, service);
}

function _success(message: string, service?: ServiceCategory): void {
  const line = `${formatPrefix('SUCCESS')} ${colorize(message, 'green')}`;
  console.log(line);
  writeToFile(line, { level: 'SUCCESS', message }, service);
}

function _debug(message: string, service?: ServiceCategory): void {
  const line = `${formatPrefix('DEBUG')} ${colorize(message, 'cyan')}`;
  console.log(line);
  if (shouldWriteToFile('DEBUG')) writeToFile(line, { level: 'DEBUG', message }, service);
}

// ---------------------------------------------------------------------------
// Public API (same signatures as before)
// ---------------------------------------------------------------------------
export const logger = {
  info: (message: string, color?: Color) => _info(message, color),
  error: (message: string, error?: unknown) => _error(message, error),
  warn: (message: string) => _warn(message),
  success: (message: string) => _success(message),
  debug: (message: string) => _debug(message),
  colorize,
};

// ---------------------------------------------------------------------------
// Named logger type (returned by createLogger)
// ---------------------------------------------------------------------------
export type NamedLogger = Omit<typeof logger, 'colorize'>;

// ---------------------------------------------------------------------------
// Factory: create a logger with a fixed prefix
// ---------------------------------------------------------------------------
/**
 * Creates a logger that prepends `[prefix]` to every message.
 * Service category is auto-detected from the prefix (Minebot:*, Discord:*, Twitter:*)
 * and logs are additionally written to `{service}-YYYYMMDD.log`.
 *
 * @param prefix - The prefix to prepend (e.g. 'Minebot:TaskRuntime')
 * @param service - Optional explicit service override; auto-inferred if omitted
 *
 * @example
 *   const log = createLogger('Minebot:TaskRuntime');
 *   log.info('タスク開始');
 *   // → prod-YYYYMMDD.log + minebot-YYYYMMDD.log
 */
export function createLogger(prefix: string, service?: ServiceCategory): NamedLogger {
  const tag = `[${prefix}]`;
  const svc = service ?? inferService(prefix);
  return {
    info: (message: string, color?: Color) => _info(`${tag} ${message}`, color, svc),
    error: (message: string, error?: unknown) => _error(`${tag} ${message}`, error, svc),
    warn: (message: string) => _warn(`${tag} ${message}`, svc),
    success: (message: string) => _success(`${tag} ${message}`, svc),
    debug: (message: string) => _debug(`${tag} ${message}`, svc),
  };
}
