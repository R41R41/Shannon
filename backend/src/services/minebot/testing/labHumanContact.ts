import fs from 'node:fs';
import path from 'node:path';

// How people reach the body in an isolated lab: game chat, and the ShannonUIMod installed on a public lab
// (scripts/minecraft-isolated-lab.mjs with MINECRAFT_LAB_UI_MOD=true). Pure parts only; the HTTP side is
// LabUiModBridge.

/** The lab world's config/shannonuimod.json as the probe uses it. The token is never logged. */
export interface LabUiModConfig {
  backendPort: number;
  httpServerPort: number;
  /** Empty when the file has none: the mod then cannot call the backend, which refuses it. */
  backendToken: string;
  botPlayerName: string;
}

const LOOPBACK = ['127.0.0.1', 'localhost'];

/** null when the world has no UI mod config. Throws on a config the probe must not use (errors never carry the token). */
export function readLabUiModConfig(worldDirectory: string): LabUiModConfig | null {
  const file = path.join(worldDirectory, 'config', 'shannonuimod.json');
  if (!fs.existsSync(file)) return null;
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('UI_MOD_CONFIG_INVALID:json'); }
  if (!raw || typeof raw !== 'object') throw new Error('UI_MOD_CONFIG_INVALID:json');
  // The mod's own defaults are the main bot's ports, so a lab must name its own.
  const port = (key: string) => {
    const value = raw[key];
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`UI_MOD_CONFIG_INVALID:${key}`);
    return value as number;
  };
  // Both directions are plain HTTP on this machine; the mod's push server has no authentication.
  if (!LOOPBACK.includes(raw.backendHost ?? 'localhost')) throw new Error('UI_MOD_CONFIG_INVALID:backendHost');
  if (!LOOPBACK.includes(raw.httpServerBindAddress ?? '127.0.0.1')) throw new Error('UI_MOD_CONFIG_INVALID:httpServerBindAddress');
  const backendPort = port('backendPort');
  const httpServerPort = port('httpServerPort');
  if (backendPort === httpServerPort) throw new Error('UI_MOD_CONFIG_INVALID:ports');
  return { backendPort, httpServerPort,
    backendToken: typeof raw.backendToken === 'string' ? raw.backendToken : '',
    botPlayerName: typeof raw.botPlayerName === 'string' ? raw.botPlayerName : 'I_am_Shannon' };
}

/** The backend only accepts a bearer token of 32+ characters without whitespace. */
export function uiModTokenUsable(token: string): boolean {
  return token.length >= 32 && !/\s/.test(token);
}

const ADDRESS = /^\s*(シャノン|しゃのん|shannon)/i;

/** A line of game chat meant for Shannon: it starts with her name. */
export function isAddressedToShannon(message: string | null | undefined): boolean {
  return ADDRESS.test(message ?? '');
}

export type LabWatcherMode = 'spectator' | 'free';

/** spectator (default): people who join only watch. free: their game mode is left alone, to play alongside. */
export function parseLabWatcherMode(value: string | undefined): LabWatcherMode {
  const mode = value?.trim() || 'spectator';
  if (mode !== 'spectator' && mode !== 'free') throw new Error('MINECRAFT_LAB_WATCHERS_INVALID');
  return mode;
}

/** One log line per message for the operator's monitor; what people type cannot start a line of its own. */
export function humanChatLogLine(player: string, message: string): string {
  const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
  return `CAMPAIGN_HUMAN_CHAT ${oneLine(player).replace(/ /g, '_') || '?'} ${oneLine(message).slice(0, 60)}`;
}
