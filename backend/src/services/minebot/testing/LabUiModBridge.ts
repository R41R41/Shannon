import type { TaskTreeState } from '@shannon/common';
import { CONFIG } from '../config/MinebotConfig.js';
import type { EventReactionSystem } from '../eventReaction/EventReactionSystem.js';
import { MinebotHttpServer } from '../http/MinebotHttpServer.js';
import type { MinebotTaskRuntime } from '../runtime/MinebotTaskRuntime.js';
import type { CustomBot } from '../types.js';
import { uiModTokenUsable, type LabUiModConfig } from './labHumanContact.js';

/**
 * The isolated campaign probe's side of ShannonUIMod, as SkillAgent does it for the main bot: the state
 * pushes (task tree, task list, constant skills, reaction settings, the bot's chat) and the mod's calls
 * into a MinebotHttpServer. Pushes are best effort: the run never waits on, or fails with, the mod.
 */
export interface LabUiModBridge {
  publishTaskTree(tree: TaskTreeState): void;
  pushConstantSkills(): Promise<void>;
  pushReactionSettings(): Promise<void>;
  /** Whether the mod can call in (a usable token and a listening server). */
  readonly incoming: boolean;
  stop(): Promise<void>;
}

/** Requests from the mod that act on the body or its tasks; read-only ones and chat are not among them. */
const CONTROL_PATHS = new Set(['/throw_item', '/task_delete', '/task_prioritize', '/task_continue']);

export async function startLabUiModBridge(options: {
  config: LabUiModConfig;
  bot: CustomBot;
  runtime: MinebotTaskRuntime;
  reactions: EventReactionSystem;
  onChatMessage: (sender: string, message: string) => Promise<void>;
  /** A control request the mod made and the backend carried out. */
  onControl?: (path: string) => void;
  onWarning?: (code: string) => void;
  timeoutMs?: number;
}): Promise<LabUiModBridge> {
  const { config, bot, runtime, reactions } = options;
  const baseUrl = `http://127.0.0.1:${config.httpServerPort}`;
  // The chat skill and anything else that reads CONFIG.UI_MOD_BASE_URL now reaches this lab's mod.
  CONFIG.setUiModBaseUrlOverride(baseUrl);
  const push = createUiModPusher(baseUrl, options.timeoutMs ?? 2000);
  const pushConstantSkills = () => push('/constant_skills', bot.constantSkills.getSkills().map(skill =>
    ({ skillName: skill.skillName, description: skill.description, status: skill.status })));
  const pushReactionSettings = () => push('/reaction_settings', reactions.getSettingsState());

  let server: MinebotHttpServer | null = null;
  if (!uiModTokenUsable(config.backendToken)) options.onWarning?.('UI_MOD_TOKEN_MISSING');
  else {
    server = new MinebotHttpServer(bot, pushConstantSkills, pushReactionSettings,
      { machineToken: () => config.backendToken, settingsLocked: true });
    server.setTaskRuntime(runtime);
    server.setEventReactionSystem(reactions);
    server.setOnChatMessageCallback(options.onChatMessage);
    server.start(config.backendPort);
    const listening = server.getServer()!;
    try {
      // The error listener stays: a later socket error must not become an uncaught 'error' event.
      await new Promise<void>((resolve, reject) => { listening.once('listening', resolve); listening.on('error', reject); });
      listening.on('request', (req, res) => res.on('finish', () => {
        const route = String(req.url ?? '').split('?')[0];
        if (req.method === 'POST' && CONTROL_PATHS.has(route) && res.statusCode < 400) options.onControl?.(route);
      }));
    } catch {
      options.onWarning?.('UI_MOD_BACKEND_PORT_UNAVAILABLE');
      await server.stop().catch(() => undefined);
      server = null;
    }
  }

  runtime.setTaskListUpdateCallback(state => { void push('/task_list', state); });
  await Promise.all([pushConstantSkills(), pushReactionSettings(), push('/task_list', runtime.getTaskListState())]);
  return {
    publishTaskTree: tree => { void push('/task', tree); },
    pushConstantSkills,
    pushReactionSettings,
    incoming: server !== null,
    stop: async () => {
      runtime.setTaskListUpdateCallback(() => {});
      CONFIG.setUiModBaseUrlOverride(null);
      // The mod may hold a keep-alive connection open; the report must not wait on it.
      server?.getServer()?.closeAllConnections();
      await Promise.race([server?.stop(), new Promise(resolve => setTimeout(resolve, 1000).unref())]);
    },
  };
}

/**
 * POSTs JSON to the mod and never throws. While one push to a path is in flight, only the newest of the
 * pushes after it is kept: the task tree and list change many times a second and only the latest matters.
 */
export function createUiModPusher(baseUrl: string, timeoutMs: number): (route: string, value: unknown) => Promise<void> {
  const inFlight = new Set<string>();
  const waiting = new Map<string, string>();
  const send = async (route: string, body: string): Promise<void> => {
    inFlight.add(route);
    try {
      const response = await fetch(`${baseUrl}${route}`, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
      await response.body?.cancel();
    } catch { /* the mod is optional */ } finally {
      inFlight.delete(route);
      const next = waiting.get(route);
      if (next !== undefined) { waiting.delete(route); void send(route, next); }
    }
  };
  return (route, value) => {
    let body: string;
    try { body = JSON.stringify(value); } catch { return Promise.resolve(); }
    if (inFlight.has(route)) { waiting.set(route, body); return Promise.resolve(); }
    return send(route, body);
  };
}
