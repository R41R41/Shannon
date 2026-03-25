import minecraftData from 'minecraft-data';
import { Bot } from 'mineflayer';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot } from '../types.js';
const { Movements } = pathfinder;

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
  allowFreeMotion = false,
  canSwim = true
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

  const cantBreak = new Set<number>();
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
  (defaultMove as any).canSwim = canSwim;

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

  bot.pathfinder.setMovements(defaultMove);
}
