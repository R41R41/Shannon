import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { MinecraftLifecycleNative, rconCommand } from './minecraftLifecycleNative.js';
import { LifecycleOperationJournal, MinecraftLifecycleOperator } from './minecraftLifecycleOperator.js';

const exec = promisify(execFile);
let operator: MinecraftLifecycleOperator | null = null;
/** Independent of bot lifetime. Default-off; authority is the existing dedicated companion world/device, never model input. */
export async function startConfiguredMinecraftLifecycle(): Promise<void> {
  if (operator || process.env.MINEBOT_LIFECYCLE !== 'on') return;
  if (process.env.MINEBOT_COMMON_FCA !== 'on') throw Error('LIFECYCLE_COMMON_FCA_REQUIRED');
  const [{ CONFIG }, { MinecraftClient }, { MinebotClient }] = await Promise.all([
    import('../minebot/config/MinebotConfig.js'), import('../minecraft/client.js'), import('../minebot/client.js')]);
  const settings = CONFIG.COMPANION_BODY;
  // The deployed management adapter has exactly one dedicated persistent world. Shared/lab servers stay outside its authority.
  if (!settings.enabled || settings.serverName !== 'shannon-home') throw Error('LIFECYCLE_DEDICATED_WORLD_REQUIRED');
  const uuid = process.env.MINEBOT_LIFECYCLE_BOT_UUID?.trim().toLowerCase() ?? '';
  const passwordFile = process.env.MINEBOT_LIFECYCLE_RCON_PASSWORD_FILE;
  const token = fs.readFileSync(settings.tokenFile, 'utf8').trim();
  const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : '';
  const rconPort = Number(process.env.MINEBOT_LIFECYCLE_RCON_PORT);
  if (!password || token.length < 16 || !Number.isInteger(rconPort) || rconPort < 1024 || rconPort > 65535) throw Error('LIFECYCLE_CREDENTIAL_CONFIG');
  const { config } = await import('../../config/env.js');
  const propertiesFile = path.join(config.minecraft.serverBasePath, settings.serverName, 'server.properties');
  const properties = new Map(fs.readFileSync(propertiesFile, 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#')).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split).trim(), line.slice(split + 1).trim()];
  }));
  // Actual owner-configured server properties decide authenticated UUID exemptions; false/ambiguous exempts nobody.
  const onlineMode = properties.get('online-mode') === 'true';
  if (!['true', 'false'].includes(properties.get('online-mode') ?? '') || properties.get('enable-rcon') !== 'true'
    || Number(properties.get('rcon.port')) !== rconPort || properties.get('rcon.password') !== password) throw Error('LIFECYCLE_SERVER_PROPERTIES_MISMATCH');
  const minecraft = MinecraftClient.getInstance(CONFIG.IS_DEV), minebot = MinebotClient.getInstance(CONFIG.IS_DEV);
  const journal = new LifecycleOperationJournal(path.resolve(process.env.MINEBOT_LIFECYCLE_JOURNAL ?? 'saves/minecraft/lifecycle-operations.json'));
  const native = new MinecraftLifecycleNative({ serverId: settings.serverId, botUuid: uuid,
    onlineMode,
    async admission(action) {
      if (action !== 'start' && action !== 'login') return true;
      if (action === 'start' && minecraft.status !== 'running' || action === 'login' && minebot.status !== 'running') return false;
      // Preserve the existing operations console's admission guard for a paid lab process.
      try { const { stdout } = await exec('pgrep', ['-f', 'minecraft-campaign-live-probe'], { timeout: 2000 }); return !stdout.trim(); }
      catch (error) { return (error as NodeJS.ErrnoException).code === 1; }
    },
    async processState() {
      try { await exec('tmux', ['-L', 'shannon-home', 'has-session', '-t', '=shannon-home'], { timeout: 2000 }); return 'running'; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 1 ? 'stopped' : 'unknown'; }
    },
    command: (text, signal) => rconCommand({ port: rconPort, password }, text, signal),
    async start(signal) {
      signal.throwIfAborted();
      // Existing registered service implementation owns the fixed start script/table. No caller controls a path or shell.
      const result = await minecraft.startServer('shannon-home');
      if (!result.success) throw Error('LIFECYCLE_START_UNKNOWN');
    },
    botState() { const state = minebot.lifecycleState(); return { phase: state.phase, uuid: state.uuid, serverId: state.serverName === settings.serverName ? settings.serverId : null }; },
    login: signal => minebot.lifecycleLogin(settings.serverName, signal), logout: signal => minebot.lifecycleLogout(settings.serverName, signal),
    authorize: (command, signal) => operator!.authorize(command, signal),
  });
  operator = new MinecraftLifecycleOperator({ baseUrl: settings.url, token, native, journal });
  operator.start();
}
export function stopConfiguredMinecraftLifecycle(): void { operator?.stop(); operator = null; }
