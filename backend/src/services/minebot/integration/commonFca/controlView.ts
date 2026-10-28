import { physicalRoots } from '../../execution/ActionExecution.js';
import { bridgeOf, meleeEpisodeView } from '../../utils/floorReflexes.js';
import { combatMarkOf } from '../../utils/combatOwner.js';
import type { ControlHolder, ControlView } from './continueContract.js';

/**
 * Who holds the body now (continue contracts, 4), for the observation's `state.control`. The truth is the root action that moves the body (the
 * execution layer's); this only names it: a command, a reflex, the bridge after a reflex's cap, a cleanup, or nobody. It adds no fifth owner.
 */
export interface CommandTag { command: string; item?: string; life: number; since: number }
export interface ControlSources {
  /** The commands the control body is running (by id), with the item and the life each was made for. */
  commands: ReadonlyMap<string, CommandTag>;
  /** A stop or release being carried out. */
  cleanup: { command: string; since: number } | null;
  /** Commands waiting for a reflex to let go. */
  waiting: ReadonlyMap<string, { since: number; behind: string }>;
}
const iso = (at: number) => new Date(at).toISOString();

export function controlViewOf(bot: object, sources: ControlSources, now = Date.now()): ControlView {
  const roots = physicalRoots(bot);
  const reflexRoot = roots.filter(root => root.safetyLease).sort((a, b) => b.priority - a.priority)[0];
  const commandRoot = roots.find(root => !root.safetyLease);
  const episode = meleeEpisodeView(bot, now);
  let holder: ControlHolder;
  if (reflexRoot) {
    const mark = (bot as { floorReflexes?: { handTarget?: { capability: string; target: number } } }).floorReflexes?.handTarget;
    holder = { kind: 'reflex', actionId: reflexRoot.actionId, reflex: reflexRoot.capability, priority: reflexRoot.priority,
      ...(mark && mark.capability === reflexRoot.capability ? { target: mark.target } : {}), since: iso(reflexRoot.startedAt),
      ...(episode ? { episode: true } : {}) };
  } else if (commandRoot) {
    const tag = [...sources.commands.entries()].sort((a, b) => b[1].since - a[1].since)[0];
    holder = { kind: 'command', actionId: commandRoot.actionId, command: tag?.[0] ?? commandRoot.capability, ...(tag?.[1].item ? { item: tag[1].item } : {}),
      life: tag?.[1].life ?? 0, since: iso(commandRoot.startedAt) };
  } else if (sources.cleanup) {
    holder = { kind: 'cleanup', command: sources.cleanup.command, since: iso(sources.cleanup.since) };
  } else {
    const bridge = bridgeOf(bot, now);
    holder = bridge ? { kind: 'bridge', after: bridge.after, hold: bridge.hold, ...(bridge.target !== undefined ? { target: bridge.target } : {}), since: iso(bridge.since), until: iso(bridge.until) }
      : { kind: 'idle' };
  }
  const mark = combatMarkOf(bot, now);
  return { holder,
    ...(episode ? { reflexEpisode: { reflex: episode.reflex, ...(episode.target !== undefined ? { target: episode.target } : {}), hands: episode.hands, hits: episode.hits, since: iso(episode.since) } } : {}),
    ...(mark ? { combatMark: { skill: mark.skill, ...(mark.target !== undefined ? { target: mark.target } : {}), until: iso(mark.until) } } : {}),
    waiting: [...sources.waiting.entries()].map(([command, wait]) => ({ command, since: iso(wait.since), behind: wait.behind })) };
}
