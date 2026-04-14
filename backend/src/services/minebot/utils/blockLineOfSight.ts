/**
 * ブロックへの視線（Line of Sight）チェック＆自動除去。
 * レイキャストで遮蔽物を検出し、掘削可能なら自動で掘って再チェックする。
 */

import { Vec3 } from 'vec3';
import type { CustomBot } from '../types/CustomBot.js';
import { createLogger } from '../../../utils/logger.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';

const log = createLogger('Minebot:LOS');

export interface LOSResult {
  clear: boolean;
  /** 遮蔽がある場合、遮っているブロック名 */
  obstructionName?: string;
  /** 遮蔽がある場合、遮っているブロックの座標 */
  obstructionPos?: Vec3;
  /** LLM に返すエラーメッセージ */
  message?: string;
  /** 自動除去で掘ったブロック一覧 */
  dugBlocks?: string[];
}

/**
 * 指定座標のブロックが bot から見えるか（視線が遮られていないか）チェック。
 * ボットの目の中心 → 対象ブロックの中心 の一直線上に固体ブロックがなければ OK。
 */
export function checkBlockLineOfSight(
  bot: CustomBot,
  targetPos: Vec3,
  maxDistance: number = 5,
): LOSResult {
  const block = bot.blockAt(targetPos);
  if (!block) {
    return { clear: false, message: `座標(${targetPos.x},${targetPos.y},${targetPos.z})にブロックがありません` };
  }

  const eyePos = bot.entity.position.offset(0, bot.entity.height, 0);
  const targetCenter = targetPos.offset(0.5, 0.5, 0.5);
  const dist = eyePos.distanceTo(targetCenter);
  if (dist > maxDistance) {
    return {
      clear: false,
      message: `対象ブロック(${block.name})が遠すぎます（距離${dist.toFixed(1)}、最大${maxDistance}）`,
    };
  }

  // 目の中心 → ブロックの中心 へのレイキャスト
  const dir = targetCenter.minus(eyePos);
  const len = dir.norm();
  if (len < 0.01) return { clear: true };

  const step = dir.scaled(1 / len);
  const STEP_SIZE = 0.2;
  const eyeBlockX = Math.floor(eyePos.x);
  const eyeBlockY = Math.floor(eyePos.y);
  const eyeBlockZ = Math.floor(eyePos.z);

  for (let t = STEP_SIZE; t < len; t += STEP_SIZE) {
    const point = eyePos.plus(step.scaled(t));
    const bx = Math.floor(point.x);
    const by = Math.floor(point.y);
    const bz = Math.floor(point.z);

    // ボットの頭があるブロック自体はスキップ
    if (bx === eyeBlockX && by === eyeBlockY && bz === eyeBlockZ) continue;
    // ターゲットブロックに到達 → 遮蔽なし
    if (bx === Math.floor(targetPos.x) && by === Math.floor(targetPos.y) && bz === Math.floor(targetPos.z)) {
      return { clear: true };
    }

    const hitBlock = bot.blockAt(new Vec3(bx, by, bz));
    if (!hitBlock) continue;
    if (hitBlock.boundingBox === 'empty') continue;
    if (isLOSTransparent(hitBlock.name)) continue;

    return {
      clear: false,
      obstructionName: hitBlock.name,
      obstructionPos: hitBlock.position,
      message:
        `${block.name}(${targetPos.x},${targetPos.y},${targetPos.z})への視線が` +
        `${hitBlock.name}(${hitBlock.position.x},${hitBlock.position.y},${hitBlock.position.z})に遮られています。`,
    };
  }

  return { clear: true };
}

/** 掘削してはいけないブロック（液体・構造物・ユーティリティ等） */
const NO_DIG_BLOCKS = new Set([
  'water', 'flowing_water', 'lava', 'flowing_lava',
  'bedrock', 'end_portal_frame', 'end_portal', 'nether_portal',
  'spawner',
  ...PROTECTED_UTILITY_BLOCKS,
]);

/**
 * 視線を確保する。遮蔽物があれば最適ツールを装備して掘削し、
 * LLM にリトライを促すメッセージを返す。
 */
export async function ensureLineOfSight(
  bot: CustomBot,
  targetPos: Vec3,
  maxDistance: number = 5,
  maxDig: number = 3,
): Promise<LOSResult> {
  const dugBlocks: string[] = [];

  for (let attempt = 0; attempt <= maxDig; attempt++) {
    const los = checkBlockLineOfSight(bot, targetPos, maxDistance);
    if (los.clear) {
      if (dugBlocks.length > 0) {
        // 遮蔽物を掘った場合 → リトライ促進メッセージを返す
        const targetBlock = bot.blockAt(targetPos);
        const targetName = targetBlock?.name ?? 'ブロック';
        return {
          clear: false,
          dugBlocks,
          message:
            `視線を遮っていた${dugBlocks.join(', ')}を破壊しました。`
            + `${targetName}(${targetPos.x},${targetPos.y},${targetPos.z})は見えるようになりました。`
            + `同じ座標で同じスキルをもう一度使用してください。`,
        };
      }
      return { clear: true };
    }

    if (!los.obstructionPos || attempt === maxDig) {
      los.dugBlocks = dugBlocks.length > 0 ? dugBlocks : undefined;
      if (dugBlocks.length > 0 && los.message) {
        los.message += ` （${dugBlocks.join(', ')}は破壊済み。同じスキルをもう一度使用してください）`;
      }
      return los;
    }

    const obsBlock = bot.blockAt(los.obstructionPos);
    if (!obsBlock || !obsBlock.diggable || NO_DIG_BLOCKS.has(obsBlock.name)) {
      const reason = !obsBlock ? '存在しない'
        : !obsBlock.diggable ? '掘削不可'
        : '保護対象';
      return {
        clear: false,
        obstructionName: los.obstructionName,
        obstructionPos: los.obstructionPos,
        dugBlocks: dugBlocks.length > 0 ? dugBlocks : undefined,
        message:
          `${los.obstructionName}(${los.obstructionPos.x},${los.obstructionPos.y},${los.obstructionPos.z})が視線を遮っていますが${reason}のため除去できません。` +
          '対象ブロックが見える位置に移動してください',
      };
    }

    // 最適なツールを装備してから掘削
    const tool = findBestToolForBlock(bot, obsBlock);
    if (tool) {
      try {
        await bot.equip(tool, 'hand');
        log.info(`🔧 遮蔽物用に${tool.name}を装備`);
      } catch { /* 装備失敗しても続行 */ }
    }

    log.info(
      `⛏️ 視線遮蔽物 ${obsBlock.name}(${obsBlock.position.x},${obsBlock.position.y},${obsBlock.position.z}) を掘削`,
    );

    try {
      await bot.lookAt(obsBlock.position.offset(0.5, 0.5, 0.5));
      await bot.dig(obsBlock);
      dugBlocks.push(obsBlock.name);
    } catch (e) {
      return {
        clear: false,
        obstructionName: los.obstructionName,
        obstructionPos: los.obstructionPos,
        dugBlocks: dugBlocks.length > 0 ? dugBlocks : undefined,
        message:
          `遮蔽物 ${obsBlock.name}(${obsBlock.position.x},${obsBlock.position.y},${obsBlock.position.z}) の掘削に失敗: ` +
          `${e instanceof Error ? e.message : e}`,
      };
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return checkBlockLineOfSight(bot, targetPos, maxDistance);
}

/** 遮蔽物を掘るのに最適なツールをインベントリから選ぶ */
function findBestToolForBlock(bot: CustomBot, block: any): any {
  const items = bot.inventory.items();
  const blockName = (block.name ?? '').toLowerCase();

  let toolType: string | null = null;
  if (['stone', 'ore', 'cobble', 'deepslate', 'brick', 'obsidian', 'concrete',
    'terracotta', 'basalt', 'netherrack', 'granite', 'diorite', 'andesite', 'tuff',
    'sandstone', 'prismarine', 'purpur', 'quartz', 'blackstone', 'calcite', 'dripstone',
  ].some(kw => blockName.includes(kw))) {
    toolType = 'pickaxe';
  } else if (['log', 'wood', 'plank', 'fence', 'door', 'chest', 'barrel', 'sign',
    'bookshelf', 'bamboo',
  ].some(kw => blockName.includes(kw))) {
    toolType = 'axe';
  } else if (['dirt', 'sand', 'gravel', 'clay', 'snow', 'soul', 'mud', 'farmland',
    'mycelium', 'podzol', 'rooted',
  ].some(kw => blockName.includes(kw))) {
    toolType = 'shovel';
  }

  if (!toolType) return null;

  const tiers = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden'];
  for (const tier of tiers) {
    const name = `${tier}_${toolType}`;
    const matches = items.filter(i => i.name === name);
    if (matches.length > 0) {
      return matches.reduce((best, cur) => {
        const bestDur = (best as any).maxDurability - ((best as any).durabilityUsed ?? 0);
        const curDur = (cur as any).maxDurability - ((cur as any).durabilityUsed ?? 0);
        return curDur > bestDur ? cur : best;
      });
    }
  }

  return null;
}

/** インタラクション時に視線を遮らない透過ブロック */
function isLOSTransparent(name: string): boolean {
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return true;
  if (name === 'water' || name === 'flowing_water') return true;
  if (name === 'lava' || name === 'flowing_lava') return true;
  if (name.includes('glass')) return true;  // glass, glass_pane, stained_glass, tinted_glass
  if (name === 'ice') return true;
  if (name === 'scaffolding') return true;
  return false;
}

