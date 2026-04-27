import minecraftData from 'minecraft-data';
import { Bot } from 'mineflayer';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot } from '../types.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
const { Movements } = pathfinder;

const HAZARD_BLOCKS_AVOID = [
  'lava', 'flowing_lava', 'magma_block', 'fire', 'soul_fire',
];

const BREATH_EXCLUSION_RADIUS = 5;
const BREATH_EXCLUSION_RADIUS_SQ = BREATH_EXCLUSION_RADIUS * BREATH_EXCLUSION_RADIUS;
const BREATH_STEP_COST = 50;
const DRAGON_HEAD_PF_OFFSET = 4;
const DRAGON_HEAD_PF_CONE = 8;

const HARD_BLOCKS_NEED_PICKAXE = [
  'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate',
  'andesite', 'granite', 'diorite', 'tuff', 'calcite', 'dripstone_block',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore',
  'lapis_ore', 'redstone_ore', 'copper_ore',
  'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_gold_ore',
  'deepslate_diamond_ore', 'deepslate_emerald_ore', 'deepslate_lapis_ore',
  'deepslate_redstone_ore', 'deepslate_copper_ore',
  'smooth_stone', 'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks',
  'bricks', 'netherrack', 'basalt', 'blackstone', 'end_stone',
  'obsidian', 'crying_obsidian',
];

export function setMovements(
  bot: CustomBot,
  allow1by1towers = false,
  allowSprinting = true,
  allowParkour = true,
  canOpenDoors = true,
  canDig = true,
  dontMineUnderFallingBlock = true,
  digCost = 1,
  allowFreeMotion = true,
  canSwim = true,
  /** pathfinder の落下許容（大きいと崖を「降りる」経路を取りやすい）。逃走系は 1〜2 推奨 */
  maxDropDown = 4,
  /** 液体ブロックを通る経路のコスト。高いほど水を避ける。4で泳ぎと陸路のバランス */
  liquidCost = 4
) {
  const mcData = minecraftData(bot.version);
  const defaultMove = new Movements(bot as Bot);
  defaultMove.allow1by1towers = allow1by1towers;
  defaultMove.allowSprinting = allowSprinting;
  defaultMove.allowParkour = allowParkour;
  defaultMove.canOpenDoors = canOpenDoors;
  defaultMove.canDig = canDig;
  defaultMove.dontMineUnderFallingBlock = dontMineUnderFallingBlock;
  defaultMove.digCost = digCost;
  defaultMove.allowFreeMotion = allowFreeMotion;
  (defaultMove as any).liquidCost = liquidCost;

  const cantBreak = new Set<number>();
  // 保護対象ブロック（チェスト・かまど・作業台・ベッド等）を壊さない
  for (const name of PROTECTED_UTILITY_BLOCKS) {
    const block = mcData.blocksByName[name];
    if (block) cantBreak.add(block.id);
  }
  // ドアを壊さない
  for (const doorName of ['oak_door', 'birch_door', 'spruce_door', 'jungle_door', 'acacia_door', 'dark_oak_door']) {
    const block = mcData.blocksByName[doorName];
    if (block) cantBreak.add(block.id);
  }

  // ピッカクスなしの場合、硬いブロックを掘らせない
  if (canDig) {
    const hasPickaxe = bot.inventory.items().some((item) => item.name.includes('pickaxe'));
    if (!hasPickaxe) {
      for (const name of HARD_BLOCKS_NEED_PICKAXE) {
        const block = mcData.blocksByName[name];
        if (block) cantBreak.add(block.id);
      }
    }
  }

  defaultMove.blocksCantBreak = cantBreak;

  const avoid = new Set<number>();
  for (const name of HAZARD_BLOCKS_AVOID) {
    const b = mcData.blocksByName[name];
    if (b) avoid.add(b.id);
  }
  defaultMove.blocksToAvoid = avoid;

  (defaultMove as any).canSwim = canSwim;
  defaultMove.maxDropDown = maxDropDown;

  // ドアを openable に追加（pathfinderデフォルトではgateのみ）
  // 注意: pathfinderにバグがあり、blockAt()がnullを返すとエラーになる
  // patch-packageで修正後に有効化する
  if (canOpenDoors) {
    const mcData = minecraftData(bot.version);
    const openable = (defaultMove as any).openable as Set<number>;

    Object.keys(mcData.blocksByName).forEach(name => {
      // 木製ドアのみ（鉄ドアは右クリックで開かない）
      if (name.includes('door') && !name.includes('iron')) {
        const block = mcData.blocksByName[name];
        if (block) {
          openable.add(block.id);
        }
      }
    });
  }

  if (bot.game?.dimension === 'the_end') {
    (defaultMove as any).exclusionAreasStep.push((block: any) => {
      if (!block?.position) return 0;
      const bx = block.position.x;
      const bz = block.position.z;

      for (const entity of Object.values(bot.entities)) {
        if (entity.name !== 'area_effect_cloud') continue;
        const dx = bx - entity.position.x;
        const dz = bz - entity.position.z;
        if (dx * dx + dz * dz < BREATH_EXCLUSION_RADIUS_SQ) return BREATH_STEP_COST;
      }

      const dragon = bot.nearestEntity((e: any) => e.name === 'ender_dragon');
      if (dragon) {
        const yaw = dragon.yaw ?? 0;
        const headX = dragon.position.x - Math.sin(yaw) * DRAGON_HEAD_PF_OFFSET;
        const headZ = dragon.position.z + Math.cos(yaw) * DRAGON_HEAD_PF_OFFSET;
        const faceDirX = -Math.sin(yaw);
        const faceDirZ = Math.cos(yaw);
        for (let step = 0; step <= 3; step++) {
          const cx = headX + faceDirX * step * (DRAGON_HEAD_PF_CONE / 3);
          const cz = headZ + faceDirZ * step * (DRAGON_HEAD_PF_CONE / 3);
          const dx = bx - cx;
          const dz = bz - cz;
          if (dx * dx + dz * dz < BREATH_EXCLUSION_RADIUS_SQ) return BREATH_STEP_COST;
        }
      }

      return 0;
    });
  }

  bot.pathfinder.setMovements(defaultMove);
}
