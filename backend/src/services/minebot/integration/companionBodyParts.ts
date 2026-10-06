import {
  advancementId, chatLines, deathCause, timeOfDayPart,
  type CompanionBodyClient, type CompanionBodyNow, type CompanionTurn,
} from './CompanionBodyClient.js';

// The pieces of "Minebot as Shannon's Minecraft body" (shannon-ios docs/minecraft-body-contract.md) that the lab run
// (scripts/minecraft-campaign-live-probe.ts) and the production bot (MinebotCompanionBody) share: what the body
// notices about itself (advancements, death), the body's present sent with each turn, saying her reply, and one turn.

/** The parts of a mineflayer bot these read. */
export interface CompanionBodyBot {
  username?: string;
  health?: number;
  food?: number;
  game?: { dimension?: unknown } | null;
  time?: { timeOfDay?: unknown } | null;
  players?: Record<string, unknown> | null;
  chat(message: string): void;
  on(event: 'message', listener: (message: any) => void): unknown;
  removeListener(event: 'message', listener: (message: any) => void): unknown;
}

const firstArgument = (message: any) => String(message?.with?.[0]?.text ?? message?.with?.[0] ?? '');

/**
 * Her own advancements (kept newest last, at most five) and her death, read from the vanilla announcements that
 * name her. The death message's translation key names the damage type: that is the cause reported to her mind.
 */
export function watchCompanionBodyEvents(bot: CompanionBodyBot, options: {
  name: () => string | undefined;
  onDeath?: (cause: string) => void;
}): { recentAdvancements: string[]; dispose: () => void } {
  const recentAdvancements: string[] = [];
  const listener = (message: any) => {
    const key = String(message?.translate ?? '');
    const name = options.name();
    if (!name || firstArgument(message) !== name) return;
    if (key.startsWith('chat.type.advancement.')) {
      const title = message?.with?.[1]?.with?.[0]?.translate ?? message?.with?.[1]?.translate ?? '';
      const id = advancementId(String(title));
      if (id && !recentAdvancements.includes(id)) {
        recentAdvancements.push(id);
        if (recentAdvancements.length > 5) recentAdvancements.shift();
      }
    }
    if (key.startsWith('death.')) options.onDeath?.(deathCause(key));
  };
  bot.on('message', listener);
  return { recentAdvancements, dispose: () => { bot.removeListener('message', listener); } };
}

/** Other players are on the server (the audience of her death). */
export function othersOnline(bot: Pick<CompanionBodyBot, 'players' | 'username'>): boolean {
  return Object.keys(bot.players ?? {}).some(name => name !== bot.username);
}

/**
 * What her body is doing now: game state only, never coordinates or the inventory. `task` is the body's own short
 * line; the contract gives it to other people's turns only while `busyWith` is `campaign` or `idle`.
 */
export function companionBodyNow(bot: Pick<CompanionBodyBot, 'game' | 'health' | 'food' | 'time'>, present: {
  task?: string;
  busyWith: NonNullable<CompanionBodyNow['busyWith']>;
  /** Newest last, as watchCompanionBodyEvents keeps them; sent newest first. */
  recentAdvancements?: readonly string[];
}): CompanionBodyNow {
  const dimension = String(bot.game?.dimension ?? '').replace(/^minecraft:/, '');
  const task = present.task?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  const advancements = (present.recentAdvancements ?? []).slice(-5).reverse();
  return {
    ...(task ? { task } : {}),
    ...(['overworld', 'the_nether', 'the_end'].includes(dimension) ? { dimension: dimension as CompanionBodyNow['dimension'] } : {}),
    health: Math.round(bot.health ?? 0), food: Math.round(bot.food ?? 0),
    ...(typeof bot.time?.timeOfDay === 'number' ? { timeOfDay: timeOfDayPart(bot.time.timeOfDay) } : {}),
    ...(advancements.length ? { recentAdvancements: advancements } : {}),
    busyWith: present.busyWith,
  };
}

/**
 * Says her reply in game chat (split at sentence ends, at most `maxLines` lines; a longer reply is cut with …) and
 * pushes the whole reply to the UI mod's chat tab. The push is fire-and-forget with a 2 second limit.
 */
export function speakCompanionReply(bot: Pick<CompanionBodyBot, 'chat'>, reply: string, options: {
  uiModBaseUrl?: string | null;
  lineLimit?: number;
  maxLines?: number;
  fetcher?: typeof fetch;
} = {}): string[] {
  const limit = options.lineLimit ?? 256;
  let lines = chatLines(reply, limit);
  const maxLines = options.maxLines ?? Infinity;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = `${last.slice(0, Math.max(1, limit - 1))}…`;
  }
  for (const line of lines) bot.chat(line);
  if (options.uiModBaseUrl) {
    void (options.fetcher ?? fetch)(`${options.uiModBaseUrl}/bot_chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: reply }), signal: AbortSignal.timeout(2000) }).catch(() => {});
  }
  return lines;
}

/**
 * What her mind made of one line a player wrote to her. `request`: queued as a request on her mind (the claim loop
 * takes it); `task`: the body should do `goal` itself (she already answered); `stop`: stop what it is doing.
 */
export type CompanionTurnOutcome =
  | { kind: 'unavailable' }
  | { kind: 'answered'; turn: CompanionTurn; action: 'none' | 'request' | 'task' | 'stop'; goal: string; requestId: string | null };

/** One turn: her mind answers and the reply is said; null-answer means the body answers itself as before. */
export async function takeCompanionTurn(client: Pick<CompanionBodyClient, 'turn'>,
  input: Parameters<CompanionBodyClient['turn']>[0], speak: (reply: string) => void): Promise<CompanionTurnOutcome> {
  const turn = await client.turn(input);
  if (!turn) return { kind: 'unavailable' };
  speak(turn.reply);
  const goal = turn.intent?.kind === 'task' ? turn.intent.goal.trim() : '';
  const requestId = turn.intent?.kind === 'task' ? turn.intent.request?.id ?? null : null;
  const action = requestId ? 'request' : goal ? 'task' : turn.intent?.kind === 'stop' ? 'stop' : 'none';
  return { kind: 'answered', turn, action, goal, requestId };
}
