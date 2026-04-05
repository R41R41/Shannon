import type Anthropic from '@anthropic-ai/sdk';
import type { RequestEnvelope } from '@shannon/common';
import type { CustomBot } from '../types/CustomBot.js';
import { CONFIG } from '../config/MinebotConfig.js';
import { getNearestHostileInfo } from './hostileProximity.js';

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

/** InstantSkill 側の最終防衛（ツールフィルタをすり抜けた場合） */
export function shouldRefuseAggressiveCombat(bot: CustomBot): string | null {
  const st = bot.minebotControlState;
  if (st === 'emergency_llm' || st === 'emergency_reflect') {
    return '緊急対応中は迎撃せず、逃走・食事・待機など生存行動のみ行ってください。';
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
