import fs from 'node:fs';
import { companionBaseUrl } from './CompanionBodyClient.js';

/**
 * The production bot's companion body mode (docs/minebot-companion-body.md): on one dedicated, persistent world the
 * normal Shannon Minebot is her Minecraft body, and her one mind (the shannon-ios companion) speaks for her there.
 * Off unless the companion URL, token file, server id and server name are given; an incomplete or invalid setting
 * keeps it off (fail closed) with a reason that never carries the token. The mode applies to Shannon's own world
 * (`shannon-home`) or a new server name, never to a shared server of the table (the YouTube and test worlds).
 */
export interface CompanionBodyRawSettings {
  url?: string;
  tokenFile?: string;
  serverId?: string;
  serverName?: string;
  /** Needed only for a server the bot does not know yet; for a known one it must match the table if given. */
  serverPort?: string;
  /** The game version mineflayer speaks there (`1.21.11`); same rule as the port. */
  serverVersion?: string;
  uiModBaseUrl?: string;
}

export type CompanionBodySettings =
  | { enabled: false; reason: string | null }
  | {
    enabled: true;
    /** Loopback origin of the companion. */
    url: string;
    tokenFile: string;
    /** The id her mind knows the world by (SHANNON_MINECRAFT_BODY_JSON `servers[].serverId`). */
    serverId: string;
    /** The Minebot server name the mode applies to (`shannon-home`). */
    serverName: string;
    serverPort: number;
    serverVersion: string;
    /** That world's UI mod (loopback), or null for the table's port. */
    uiModBaseUrl: string | null;
  };

const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const VERSION = /^\d+\.\d+(?:\.\d+)?$/;

export function parseCompanionBodySettings(raw: CompanionBodyRawSettings, options: {
  /** Every server the bot knows: name → port and game version. */
  knownServers: Record<string, { port: number; version: string | undefined }>;
  /** The known servers the mode may apply to (Shannon's own world); every other one is shared and refused. */
  companionWorlds: readonly string[];
  /** A loopback http origin or null (MinebotConfig's parseUiModBaseUrl). */
  parseUiModBaseUrl: (value: string) => string | null;
}): CompanionBodySettings {
  const value = (key: keyof CompanionBodyRawSettings) => (raw[key] ?? '').trim();
  const all = ['url', 'tokenFile', 'serverId', 'serverName', 'serverPort', 'serverVersion', 'uiModBaseUrl'] as const;
  if (all.every(key => !value(key))) return { enabled: false, reason: null };
  const missing = (['url', 'tokenFile', 'serverId', 'serverName'] as const).find(key => !value(key));
  if (missing) return { enabled: false, reason: `COMPANION_BODY_CONFIG_INCOMPLETE:${missing}` };
  let url: string;
  try { url = companionBaseUrl(value('url')); } catch { return { enabled: false, reason: 'COMPANION_BODY_URL_MUST_BE_LOOPBACK' }; }
  if (!SERVER_ID.test(value('serverId'))) return { enabled: false, reason: 'COMPANION_BODY_SERVER_ID_INVALID' };
  const serverName = value('serverName');
  if (!SERVER_NAME.test(serverName)) return { enabled: false, reason: 'COMPANION_BODY_SERVER_NAME_INVALID' };
  const known = Object.prototype.hasOwnProperty.call(options.knownServers, serverName) ? options.knownServers[serverName] : null;
  if (known && !options.companionWorlds.includes(serverName)) return { enabled: false, reason: 'COMPANION_BODY_SERVER_NAME_SHARED' };
  if (!known && !value('serverPort')) return { enabled: false, reason: 'COMPANION_BODY_CONFIG_INCOMPLETE:serverPort' };
  if (!known && !value('serverVersion')) return { enabled: false, reason: 'COMPANION_BODY_CONFIG_INCOMPLETE:serverVersion' };
  const serverPort = value('serverPort') ? Number(value('serverPort')) : known!.port;
  if (!Number.isInteger(serverPort) || serverPort < 1024 || serverPort > 65535) return { enabled: false, reason: 'COMPANION_BODY_SERVER_PORT_INVALID' };
  if (known && serverPort !== known.port) return { enabled: false, reason: 'COMPANION_BODY_SERVER_PORT_MISMATCH' };
  if (Object.entries(options.knownServers).some(([name, server]) => name !== serverName && server.port === serverPort)) {
    return { enabled: false, reason: 'COMPANION_BODY_SERVER_PORT_SHARED' };
  }
  const serverVersion = value('serverVersion') || known?.version || '';
  if (!VERSION.test(serverVersion)) return { enabled: false, reason: 'COMPANION_BODY_SERVER_VERSION_INVALID' };
  if (known?.version && serverVersion !== known.version) return { enabled: false, reason: 'COMPANION_BODY_SERVER_VERSION_MISMATCH' };
  let uiModBaseUrl: string | null = null;
  if (value('uiModBaseUrl')) {
    uiModBaseUrl = options.parseUiModBaseUrl(value('uiModBaseUrl'));
    if (!uiModBaseUrl) return { enabled: false, reason: 'COMPANION_BODY_UI_MOD_URL_INVALID' };
  }
  return { enabled: true, url, tokenFile: value('tokenFile'), serverId: value('serverId'), serverName, serverPort, serverVersion, uiModBaseUrl };
}

/** The body's device token, read when the bot connects. Null when unreadable or too short; the value is never logged. */
export function readCompanionBodyToken(file: string, read: (file: string) => string = path => fs.readFileSync(path, 'utf8')): string | null {
  try {
    const token = read(file).trim();
    return token.length >= 16 && !/\s/.test(token) ? token : null;
  } catch {
    return null;
  }
}
