import type Anthropic from '@anthropic-ai/sdk';
import type { RequestEnvelope } from '@shannon/common';
import type { CustomBot } from '../types/CustomBot.js';
import { CONFIG } from '../config/MinebotConfig.js';
import { getNearestHostileInfo } from './hostileProximity.js';
import { isLikelyHostileMobName } from './hostileMobHints.js';

type Tool = Anthropic.Tool;

export type MinebotToolPolicyMode =
  | 'normal'
  | 'hostile_warning'
  | 'defensive_low_hp'
  | 'emergency_survival';

const AGGRESSIVE_TOOL_NAMES = new Set([
  'attack-continuously',
  'attack_continuously',
  'combat-engage',
  'combat_engage',
  'combat',
  'attack-nearest',
  'attack_nearest',
  'shoot-bow',
  'shoot_bow',
]);

const BLOCKED_ROUTINE_NAMES = new Set(['routine-hunt-animal', 'routine_hunt_animal']);

function hyphenName(name: string): string {
  return name.replace(/_/g, '-');
}

function isAggressiveToolName(name: string): boolean {
  if (AGGRESSIVE_TOOL_NAMES.has(name)) return true;
  return AGGRESSIVE_TOOL_NAMES.has(hyphenName(name));
}

function isBlockedRoutineName(name: string): boolean {
  if (BLOCKED_ROUTINE_NAMES.has(name)) return true;
  return BLOCKED_ROUTINE_NAMES.has(hyphenName(name));
}

/**
 * ShannonExecutor に渡す直前のツール一覧を、生存ポリシーに応じて削る。
 */
export function filterToolsByMinebotPolicy(tools: Tool[], mode: MinebotToolPolicyMode): Tool[] {
  if (mode === 'normal') return tools;

  const stripChat = mode === 'emergency_survival';
  const stripAggressive =
    mode === 'hostile_warning' ||
    mode === 'defensive_low_hp' ||
    mode === 'emergency_survival';

  return tools.filter((t) => {
    const n = t.name;
    if (stripChat && (n === 'chat' || hyphenName(n) === 'chat')) return false;
    if (
      (mode === 'hostile_warning' ||
        mode === 'defensive_low_hp' ||
        mode === 'emergency_survival') &&
      isBlockedRoutineName(n)
    ) {
      return false;
    }
    if (!stripAggressive) return true;
    if (n.startsWith('routine-') || n.startsWith('routine_')) return true;
    return !isAggressiveToolName(n);
  });
}

export function resolveMinebotToolPolicy(
  bot: CustomBot | undefined,
  envelope: RequestEnvelope,
): MinebotToolPolicyMode {
  const meta = envelope.metadata as { minebotToolPolicy?: MinebotToolPolicyMode } | undefined;
  if (meta?.minebotToolPolicy === 'normal') return 'normal';
  if (meta?.minebotToolPolicy) return meta.minebotToolPolicy;
  if (envelope.tags?.includes('emergency')) return 'emergency_survival';
  if (!bot?.entity) return 'normal';

  const hp = bot.health ?? 20;
  if (hp > CONFIG.COMBAT_DEFENSIVE_MAX_HP) return 'normal';

  const info = getNearestHostileInfo(bot, CONFIG.COMBAT_DEFENSIVE_HOSTILE_SCAN_RANGE);
  if (info && info.distance <= CONFIG.COMBAT_DEFENSIVE_HOSTILE_DISTANCE) {
    return 'defensive_low_hp';
  }
  return 'normal';
}

/** How near a hostile has to be to be "within a blow" of the body. */
const BLOW_REACH = 3.5;

/**
 * InstantSkill 側の最終防衛（ツールフィルタをすり抜けた場合）。
 *
 * What is refused in an emergency is a fight: going at something that fights back. Killing an animal for
 * food is the eating the emergency itself asks for. Refused along with the fights, a starving body was
 * told by its emergency to hunt and by its attack skills not to (paid run L61). `targetName` is what
 * the caller means to attack; without one the attack is taken to be at whatever is hostile.
 */
export function shouldRefuseAggressiveCombat(bot: CustomBot, targetName?: string | null, standing = false): string | null {
  // Striking from where the body stands at what comes within its reach is not going to a fight either: it
  // goes nowhere. That is how a body fights from a place the other cannot get at it (a pillar three blocks up,
  // a cage with a slit), and an emergency is when it has most reason to.
  if (standing) return null;
  const st = bot.minebotControlState;
  const hunting = typeof targetName === 'string' && targetName.trim() !== '' && !isLikelyHostileMobName(targetName.trim().toLowerCase());
  if ((st === 'emergency_llm' || st === 'emergency_reflect') && !hunting) {
    // A fight the body's own measures favour is a way out of the emergency, not a breach of it: one mob that
    // will not go away is got rid of (the emergency message gives the race; see describeFightOdds).
    let favoured = false;
    try { favoured = (bot as unknown as { fightFavoured?: () => boolean }).fightFavoured?.() === true; } catch { favoured = false; }
    if (favoured) return null;
    // And what is already within a blow of the body may be struck back, whatever the race says. Refused that,
    // a body with a wither skeleton a block away and nowhere left to run was told to flee, and died with its
    // sword in its hand (lab continuation L77p). The refusal is of going to a fight, not of being in one.
    try {
      const near = getNearestHostileInfo(bot, BLOW_REACH + 1);
      if (near && near.distance <= BLOW_REACH) return null;
    } catch { /* no body to measure from */ }
    return '緊急対応中の攻撃は、実測で「倒す方が早い」相手が1〜2体の時だけです（いまは当てはまりません。すでに殴り合いの距離にいる相手への反撃は可）。逃走・遮蔽・食事など生存行動を選んでください。';
  }

  const hp = bot.health ?? 20;
  if (hp <= CONFIG.COMBAT_DEFENSIVE_MAX_HP) {
    const info = getNearestHostileInfo(bot, CONFIG.COMBAT_DEFENSIVE_HOSTILE_SCAN_RANGE);
    if (info && info.distance <= CONFIG.COMBAT_DEFENSIVE_HOSTILE_DISTANCE) {
      return `HPが低く敵が近い（約${info.distance.toFixed(1)}m）ため攻撃は禁止されています。flee-from で距離を取ってください。`;
    }
  }
  return null;
}
