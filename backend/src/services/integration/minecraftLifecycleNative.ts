import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { MinecraftLifecycleCommand, MinecraftLifecycleReceipt, MinecraftLifecycleState } from './minecraftLifecycleContract.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** Uses a configured account UUID only. Offline servers exempt nobody, including a name resembling Shannon. */
export function guardedStopCommand(botUuid: string, onlineMode: boolean): string {
  if (!UUID.test(botUuid)) throw Error('LIFECYCLE_BOT_UUID_INVALID');
  if (!onlineMode) return 'execute unless entity @a run stop';
  const bytes = Buffer.from(botUuid.replace(/-/g, ''), 'hex');
  const words = [0, 4, 8, 12].map(offset => bytes.readInt32BE(offset));
  return `execute unless entity @a[nbt=!{UUID:[I;${words.join(',')}]}] run stop`;
}
/** Minecraft's native list-uuids output; mismatches never become a zero-player observation. */
export function nativePlayers(text: string): readonly string[] | null {
  const match = /^There are (\d+) of a max of \d+ players online:(.*)$/s.exec(text.trim());
  if (!match) return null;
  const players = match[2].match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi)?.map(v => v.toLowerCase()) ?? [];
  return players.length === Number(match[1]) && new Set(players).size === players.length ? players : null;
}

/** Small bounded RCON transport. Every command is supplied by this module, never by a model or API caller. */
export function rconCommand(config: { port: number; password: string }, command: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !config.password || command.length > 512) return reject(Error('LIFECYCLE_RCON_CONFIG'));
    const socket = createConnection({ host: '127.0.0.1', port: config.port });
    let pending = Buffer.alloc(0), output = '', authorized = false, finished = false;
    const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timeout); signal?.removeEventListener('abort', aborted); socket.destroy(); error ? reject(Object.assign(error, { responseText: output })) : resolve(output); };
    const aborted = () => finish(Error('LIFECYCLE_RCON_ABORTED'));
    const timeout = setTimeout(() => finish(Error('LIFECYCLE_RCON_TIMEOUT')), 2500);
    const packet = (id: number, type: number, body: string) => {
      const payload = Buffer.from(body, 'utf8'), message = Buffer.alloc(payload.length + 14);
      message.writeInt32LE(payload.length + 10, 0); message.writeInt32LE(id, 4); message.writeInt32LE(type, 8); payload.copy(message, 12); return message;
    };
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) return aborted();
    socket.on('connect', () => socket.write(packet(1, 3, config.password)));
    socket.on('error', error => finish(Object.assign(Error('LIFECYCLE_RCON_UNAVAILABLE'), { code: (error as NodeJS.ErrnoException).code })));
    socket.on('close', () => { if (!finished) finish(Error('LIFECYCLE_RCON_CLOSED')); });
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length + output.length > 262144) return finish(Error('LIFECYCLE_RCON_TOO_LARGE'));
      while (pending.length >= 4) {
        const size = pending.readInt32LE(0); if (size < 10 || size > 262144) return finish(Error('LIFECYCLE_RCON_PACKET'));
        if (pending.length < size + 4) break;
        const frame = pending.subarray(0, size + 4); pending = pending.subarray(size + 4);
        const id = frame.readInt32LE(4), type = frame.readInt32LE(8);
        if (frame[frame.length - 1] || frame[frame.length - 2]) return finish(Error('LIFECYCLE_RCON_PACKET'));
        if (id === -1) return finish(Error('LIFECYCLE_RCON_AUTH'));
        if (!authorized && id === 1 && type === 2) {
          authorized = true; socket.write(Buffer.concat([packet(2, 2, command), packet(3, 2, '')]));
        } else if (authorized && id === 2 && type === 0) output += frame.toString('utf8', 12, frame.length - 2);
        else if (authorized && id === 3) return finish();
      }
    });
  });
}

export interface LifecycleNativePorts {
  serverId: string; botUuid: string; onlineMode: boolean;
  /** Exact configured process identity, not a cached Web status. Error maps to unknown, never stopped. */
  processState(): Promise<'running' | 'stopped' | 'unknown'>;
  command(text: string, signal?: AbortSignal): Promise<string>;
  start(signal: AbortSignal): Promise<void>;
  botState(): { phase: 'joined' | 'absent' | 'unknown'; serverId: string | null; uuid: string | null };
  login(signal: AbortSignal): Promise<void>;
  logout(signal: AbortSignal): Promise<void>;
  now?(): number;
  /** Allows no replacement actions while a native operation remains unresolved. */
  operationHeld?(): boolean;
  /** Rechecks the original lease, sources and own-time pause/budget after fresh native reads, immediately before effect. */
  authorize(command: MinecraftLifecycleCommand, signal: AbortSignal): Promise<boolean>;
  /** Existing machine admission guard, before final authority recheck (for example a paid isolated lab already running). */
  admission?(action: MinecraftLifecycleCommand['action']): Promise<boolean>;
}
export class MinecraftLifecycleNative {
  private busy = false;
  constructor(readonly ports: LifecycleNativePorts) {
    guardedStopCommand(ports.botUuid, ports.onlineMode);
  }
  private now(): number { return (this.ports.now ?? Date.now)(); }
  async observe(): Promise<MinecraftLifecycleState> {
    const local = this.ports.botState();
    let running: MinecraftLifecycleState['running'] = 'unknown', players: readonly string[] | null = null;
    try {
      const process = await this.ports.processState();
      if (process === 'running') { players = nativePlayers(await this.ports.command('list uuids')); if (players) running = 'running'; }
      else if (process === 'stopped') {
        // A live RCON listener contradicts the process report; refusal proves stopped only for the configured port.
        try { await this.ports.command('list uuids'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') running = 'stopped'; }
      }
    } catch { /* stays unknown; process/RCON uncertainty is not absence */ }
    const localMatches = local.serverId === this.ports.serverId && local.uuid === this.ports.botUuid;
    const bot = local.phase === 'absent' ? 'absent' : localMatches && players?.includes(this.ports.botUuid) && local.phase === 'joined' ? 'joined' : 'unknown';
    return { serverId: this.ports.serverId, observedAt: new Date(this.now()).toISOString(), running, bot,
      otherPlayers: players ? players.filter(uuid => !this.ports.onlineMode || uuid !== this.ports.botUuid).length : running === 'stopped' ? 0 : null };
  }
  async execute(c: MinecraftLifecycleCommand, signal: AbortSignal): Promise<MinecraftLifecycleReceipt> {
    let state = await this.observe();
    const receipt = (outcome: MinecraftLifecycleReceipt['outcome'], code: MinecraftLifecycleReceipt['code'], inputsReleased = true, stopGuard?: MinecraftLifecycleReceipt['stopGuard']): MinecraftLifecycleReceipt => ({
      id: c.id, connectionId: c.connectionId, serverId: c.serverId, action: c.action, outcome, code, inputsReleased, state, observedAt: new Date(this.now()).toISOString(), ...(stopGuard ? { stopGuard } : {}) });
    if (c.serverId !== this.ports.serverId || this.busy || this.ports.operationHeld?.()) return receipt('refused', 'state_unknown');
    if (!Number.isFinite(Date.parse(c.issuedAt)) || Date.parse(c.issuedAt) > this.now() || Date.parse(c.issuedAt) >= Date.parse(c.deadlineAt)
      || !Number.isFinite(Date.parse(c.deadlineAt)) || signal.aborted || Date.parse(c.deadlineAt) <= this.now()) return receipt('cancelled', 'deadline');
    this.busy = true;
    try {
      if (c.action === 'start' && state.running === 'running') return receipt('completed', 'already_running');
      if (c.action === 'stop' && state.running === 'stopped') return receipt('completed', 'already_stopped');
      if (c.action === 'login' && state.bot === 'joined') return receipt('completed', 'already_joined');
      if (c.action === 'logout' && state.bot === 'absent') return receipt('completed', 'already_absent');
      // Logging out also cancels a pending reconnect. It is scoped to the configured native body, and requires no server shutdown.
      if (c.action !== 'logout' && (state.running === 'unknown' || state.bot === 'unknown')
        || c.action === 'login' && state.running !== 'running') return receipt('refused', 'state_unknown');
      if (c.action === 'stop' && state.otherPlayers !== 0) return receipt('refused', state.otherPlayers === null ? 'state_unknown' : 'players_present');
      if (this.ports.admission && !await this.ports.admission(c.action)) return receipt('refused', 'state_unknown');
      if (!await this.ports.authorize(c, signal) || signal.aborted || Date.parse(c.deadlineAt) <= this.now()) return receipt('cancelled', 'authority_revoked');
      const checkedAt = new Date(this.now()).toISOString();
      let stopAccepted = false;
      // One native server command evaluates @a and executes stop on the same server thread/tick. No API snapshot can grant stop.
      if (c.action === 'stop') {
        try { stopAccepted = (await this.ports.command(guardedStopCommand(this.ports.botUuid, this.ports.onlineMode), signal)).trim() === 'Stopping the server'; }
        catch (error) { stopAccepted = (error as { responseText?: string }).responseText?.trim() === 'Stopping the server'; }
      }
      else if (c.action === 'start') await this.ports.start(signal);
      else if (c.action === 'login') await this.ports.login(signal);
      else await this.ports.logout(signal);
      for (let i = 0; i < 80; i++) {
        state = await this.observe();
        if (c.action === 'start' && state.running === 'running' || c.action === 'stop' && stopAccepted && state.running === 'stopped'
          || c.action === 'login' && state.bot === 'joined' || c.action === 'logout' && state.bot === 'absent') {
          return receipt('completed', 'changed', true, c.action === 'stop' ? { admissionClosed: true, otherPlayers: 0, checkedAt } : undefined);
        }
        if (c.action === 'stop' && state.running === 'running' && state.otherPlayers !== null && state.otherPlayers > 0) return receipt('refused', 'players_present');
        if (c.action === 'stop' && !stopAccepted && state.running === 'stopped') return receipt('unknown', 'state_unknown', false);
        if (signal.aborted || Date.parse(c.deadlineAt) <= this.now()) break;
        await delay(250);
      }
      return receipt('unknown', signal.aborted ? 'authority_revoked' : 'state_unknown', false);
    } catch { state = await this.observe(); return receipt('unknown', 'error', false); }
    finally { this.busy = false; }
  }
}
