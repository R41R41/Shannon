import fs from 'node:fs';
import { companionBaseUrl } from './CompanionBodyClient.js';

/**
 * The production bot's companion body mode (docs/minebot-companion-body.md): on one dedicated, persistent world the
 * normal Shannon Minebot is her Minecraft body, and her one mind (the shannon-ios companion) speaks for her there.
 * Off unless every setting is given; an incomplete or invalid setting keeps it off (fail closed) with a reason that
 * never carries the token. The mode never applies to a server of the built-in table (the YouTube and shared worlds).
 */
export interface CompanionBodyRawSettings {
  url?: string;
  tokenFile?: string;
  serverId?: string;
  serverName?: string;
  serverPort?: string;
  /** The game version mineflayer speaks there (`1.21.11`); the built-in names carry it as their prefix instead. */
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
    /** The Minebot server name the mode applies to (`shannon-home`); never a built-in one. */
    serverName: string;
    serverPort: number;
    serverVersion: string;
    /** That world's UI mod (loopback), or null for the default port. */
    uiModBaseUrl: string | null;
  };

const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const VERSION = /^\d+\.\d+(?:\.\d+)?$/;

export function parseCompanionBodySettings(raw: CompanionBodyRawSettings, options: {
  /** The built-in servers (name → port): never the companion world. */
  builtInServers: Record<string, number>;
  /** A loopback http origin or null (MinebotConfig's parseUiModBaseUrl). */
  parseUiModBaseUrl: (value: string) => string | null;
}): CompanionBodySettings {
  const value = (key: keyof CompanionBodyRawSettings) => (raw[key] ?? '').trim();
  const required = ['url', 'tokenFile', 'serverId', 'serverName', 'serverPort', 'serverVersion'] as const;
  if ([...required, 'uiModBaseUrl' as const].every(key => !value(key))) return { enabled: false, reason: null };
  const missing = required.find(key => !value(key));
  if (missing) return { enabled: false, reason: `COMPANION_BODY_CONFIG_INCOMPLETE:${missing}` };
  let url: string;
  try { url = companionBaseUrl(value('url')); } catch { return { enabled: false, reason: 'COMPANION_BODY_URL_MUST_BE_LOOPBACK' }; }
  if (!SERVER_ID.test(value('serverId'))) return { enabled: false, reason: 'COMPANION_BODY_SERVER_ID_INVALID' };
  const serverName = value('serverName');
  if (!SERVER_NAME.test(serverName)) return { enabled: false, reason: 'COMPANION_BODY_SERVER_NAME_INVALID' };
  if (Object.prototype.hasOwnProperty.call(options.builtInServers, serverName)) {
    return { enabled: false, reason: 'COMPANION_BODY_SERVER_NAME_BUILT_IN' };
  }
  const serverPort = Number(value('serverPort'));
  if (!Number.isInteger(serverPort) || serverPort < 1024 || serverPort > 65535) return { enabled: false, reason: 'COMPANION_BODY_SERVER_PORT_INVALID' };
  if (Object.values(options.builtInServers).includes(serverPort)) return { enabled: false, reason: 'COMPANION_BODY_SERVER_PORT_BUILT_IN' };
  if (!VERSION.test(value('serverVersion'))) return { enabled: false, reason: 'COMPANION_BODY_SERVER_VERSION_INVALID' };
  let uiModBaseUrl: string | null = null;
  if (value('uiModBaseUrl')) {
    uiModBaseUrl = options.parseUiModBaseUrl(value('uiModBaseUrl'));
    if (!uiModBaseUrl) return { enabled: false, reason: 'COMPANION_BODY_UI_MOD_URL_INVALID' };
  }
  return { enabled: true, url, tokenFile: value('tokenFile'), serverId: value('serverId'), serverName, serverPort,
    serverVersion: value('serverVersion'), uiModBaseUrl };
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
