/**
 * Performs the operations the owner asks for in the management window
 * (shannon-ios docs/ops-contract.md, stage 2). This runtime pulls one command at a
 * time from the Shannon app API, performs it through the service command registry or
 * the scheduler, and reports a fixed code. The window never connects here.
 *
 * The app API keeps the allowlist; it is checked again here, so a change over there
 * cannot widen what this runtime does.
 */
export type OpsCommandType = 'service.start' | 'service.stop' | 'schedule.run' | 'minecraft.start' | 'minecraft.stop' | 'minebot.start';
export type OpsCommandOutcome = 'done' | 'failed' | 'refused';
export type OpsCommandCode =
  | 'not_registered' | 'already_running' | 'already_stopped' | 'lab_running' | 'timeout' | 'error' | 'unsupported' | 'not_allowed';
export type OpsObservedStatus = 'running' | 'stopped' | 'degraded' | 'unknown';

export interface OpsCommand { id: string; type: OpsCommandType; target: string }
export interface OpsCommandResult { outcome: OpsCommandOutcome; code?: OpsCommandCode }

export interface OpsCommandActions {
  /** Sends `start`, `stop` or `status` to a registered service; false when no handler is registered. */
  dispatch(service: string, command: 'start' | 'stop' | 'status', serverName?: string): Promise<boolean>;
  /** The state a service last reported, after a `status` command. */
  statusOf(service: string): OpsObservedStatus | undefined;
  scheduleNames(): readonly string[];
  runSchedule(name: string): Promise<void>;
  /** A paid lab run is in progress on this machine. */
  labRunning(): Promise<boolean>;
}

const START_ALLOWED = new Set(['discord', 'twitter', 'youtube', 'youtube:live_chat', 'notion', 'minecraft', 'minebot']);
// Stopping discord would take Shannon offline there. The Minebot body is started with `minebot.start` and a server
// (owner decision 2026-10-02): it begins using a paid planner, which the console confirms first.
const MINEBOT_BODY = 'minebot:bot';
const STOP_ALLOWED = new Set(['twitter', 'youtube', 'youtube:live_chat', 'notion', 'minebot', 'minebot:bot', 'minecraft']);
const LAB = /^(?:minecraft:)?progressive-lab-/u;
const MINECRAFT_SERVER = /^minecraft:[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/u;

export function opsCommandAllowed(command: OpsCommand): boolean {
  if (typeof command.target !== 'string' || LAB.test(command.target)) return false;
  switch (command.type) {
    case 'service.start': return START_ALLOWED.has(command.target);
    case 'service.stop': return STOP_ALLOWED.has(command.target);
    case 'minecraft.start': case 'minecraft.stop': case 'minebot.start': return MINECRAFT_SERVER.test(command.target);
    case 'schedule.run': return command.target.length > 0 && command.target.length <= 80;
    default: return false;
  }
}

/** Performs one command. It never throws; every ending is one of the contract's codes. */
export async function performOpsCommand(command: OpsCommand, actions: OpsCommandActions): Promise<OpsCommandResult> {
  if (!opsCommandAllowed(command)) return { outcome: 'refused', code: 'not_allowed' };
  try {
    if (command.type === 'schedule.run') {
      if (!actions.scheduleNames().includes(command.target)) return { outcome: 'refused', code: 'not_registered' };
      await actions.runSchedule(command.target);
      return { outcome: 'done' };
    }
    if (command.type === 'minebot.start') return await startMinebotBody(command.target, actions);
    const start = command.type.endsWith('.start');
    if (command.type === 'minecraft.start' && await actions.labRunning()) return { outcome: 'refused', code: 'lab_running' };
    if (!(await actions.dispatch(command.target, 'status'))) return { outcome: 'refused', code: 'not_registered' };
    const before = actions.statusOf(command.target);
    if (start && before === 'running') return { outcome: 'refused', code: 'already_running' };
    if (!start && before === 'stopped') return { outcome: 'refused', code: 'already_stopped' };
    await actions.dispatch(command.target, start ? 'start' : 'stop');
    await actions.dispatch(command.target, 'status');
    const after = actions.statusOf(command.target);
    return after === (start ? 'running' : 'stopped') ? { outcome: 'done' } : { outcome: 'failed', code: 'error' };
  } catch {
    return { outcome: 'failed', code: 'error' };
  }
}

/** The body joins one running server. Nothing is started while a paid lab run is in progress. */
async function startMinebotBody(server: string, actions: OpsCommandActions): Promise<OpsCommandResult> {
  if (await actions.labRunning()) return { outcome: 'refused', code: 'lab_running' };
  if (!(await actions.dispatch(server, 'status')) || !(await actions.dispatch(MINEBOT_BODY, 'status'))) return { outcome: 'refused', code: 'not_registered' };
  if (actions.statusOf(server) !== 'running') return { outcome: 'refused', code: 'already_stopped' };
  if (actions.statusOf(MINEBOT_BODY) === 'running') return { outcome: 'refused', code: 'already_running' };
  await actions.dispatch(MINEBOT_BODY, 'start', server.slice('minecraft:'.length));
  await actions.dispatch(MINEBOT_BODY, 'status');
  return actions.statusOf(MINEBOT_BODY) === 'running' ? { outcome: 'done' } : { outcome: 'failed', code: 'error' };
}

export interface OpsCommandPullerConfig { url: string; token: string; timeoutMs: number; performMilliseconds?: number }

export type OpsPullResult = 'idle' | 'performed' | 'unavailable';

/**
 * Claims one command, performs it and reports. A command that takes longer than the
 * report deadline is reported as `timeout`: the app API never hands a command out twice.
 */
export function createOpsCommandPuller(config: OpsCommandPullerConfig, actions: OpsCommandActions, fetcher: typeof fetch = fetch) {
  const base = commandsUrl(config.url.trim());
  const token = config.token.trim();
  if (!base || token.length < 32) return null;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = (path: string, body: unknown) => fetcher(`${base}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs),
  });
  let busy = false;
  return {
    async pull(): Promise<OpsPullResult> {
      if (busy) return 'idle';
      busy = true;
      try {
        const claimed = await post('/claim', { scopeKey: 'owner' });
        if (claimed.status !== 200) return 'unavailable';
        const command = ((await claimed.json()) as { command?: OpsCommand | null }).command;
        if (!command || typeof command.id !== 'string') return 'idle';
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          performOpsCommand(command, actions),
          new Promise<OpsCommandResult>(resolve => { timer = setTimeout(() => resolve({ outcome: 'failed', code: 'timeout' }), config.performMilliseconds ?? 90_000); }),
        ]);
        if (timer) clearTimeout(timer);
        await post(`/${encodeURIComponent(command.id)}/report`, { scopeKey: 'owner', outcome: result.outcome, ...(result.code ? { code: result.code } : {}) }).catch(() => undefined);
        return 'performed';
      } catch {
        return 'unavailable';
      } finally {
        busy = false;
      }
    },
  };
}

function commandsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/v1/platform/turns') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '::1'].includes(url.hostname))) return null;
    url.pathname = '/v1/platform/ops/commands';
    return url.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}
