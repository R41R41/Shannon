import { findLoadedBlocks } from '../utils/loadedBlockScan.js';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { CustomBot, InstantSkill } from '../types.js';
import {
  DEPOSIT_BEFORE_EMPTY_SLOTS_FALLS_TO,
  emptySlotCountSafe,
  INVENTORY_FULL_RECOVERY_HINT_JA,
  shouldPauseMiningForDeposit,
  slotsForDrops,
} from '../utils/inventorySpillDetection.js';
import { assertActionActive, reportActionProgress } from '../execution/ActionExecution.js';
import { collectDrops, expectedBlockDrops, inventoryCounts, type CollectionPolicy } from '../execution/collectDrops.js';
import { canDigFromHere, DIG_REACH } from '../utils/blockInteractionReach.js';
import { estimateBlockApproachCost, minedApproachCost } from '../utils/blockApproachCost.js';
import { dropBurnsIn } from '../utils/dropFate.js';
import { digMsWithBestTool as bestToolDigMs } from '../utils/bestToolDigTime.js';
import { descentFloor, nightGateRefusal } from '../utils/nightGate.js';
import { axeAdviceNote, isWood, spareToolNote } from '../utils/toolWear.js';
import { explainNoRoom, makeRoom, TIDY_TIME_MS, tidyPackNow } from '../utils/inventoryRoom.js';
import { ensureToolUses, pickaxeUsesFor } from '../utils/toolStock.js';
import { solidCellsBetween } from '../utils/blockApproachCost.js';
import { hostileNear } from './craftOne.js';
import { noteUnreachable, recentlyUnreachable, THREAT_REFUSAL_MS } from '../utils/unreachableTargets.js';

/** The pack is tidied only with this much of the action left (TIDY_TIME_MS), and with no hostile this near. */
const TIDY_SAFE_RANGE = 16;
/** The pack is tidied again no sooner than this after the last time (a tunnel through rock fills it again as it goes). */
const TIDY_AGAIN_MS = 20_000;
/** The room made just before a dig (roomForDig): this many free slots at most are asked for. */
const DIG_ROOM_SLOTS = 3;
/** Uses of the pickaxe a block mined is counted to take (the stone dug on the way as well), and the most digs counted for the way to the first ore. */
const USES_PER_BLOCK = 1.2;
const APPROACH_DIG_CAP = 48;
/** Tries of setting down and digging again the gravel carried for a flint (one in ten each: 30 leave none 4% of the time). */
const FLINT_CYCLES = 30;
/** The action's time each try leaves for the result to be told. */
const FLINT_RESERVE_MS = 8_000;
/** Candidates ranked by the rock between (utils/blockApproachCost) on each pick; the rest by distance alone, behind them. */
const REFINED_CANDIDATES = 48;
/** A deferred drop falls at most this far, and comes to rest this near the body (see canDeferBatchCollection). */
const DEFER_FALL_LIMIT = 6;
const DEFER_REST_RANGE = 6;
/** Deferred drops are gathered in one walk once this many blocks are dug. */
const DEFER_GATHER_EVERY = 8;

const log = createLogger('Minebot:Skill:mineBlock');

/**
 * A dig (or the clearing of the line to it) the exposure guard refused for a hostile it would let in: that ore is put behind the
 * others for a minute (the mob moves on), and the next one is tried. Run 18 (D30) stopped at one ore of ten when the stone in front
 * of the first was refused for a zombie.
 */
function refusedForThreat(result: { failureType?: string; result?: unknown }): boolean {
  return result.failureType === 'threat_exposed' || /掘削中止: .*身体が見える・届く/.test(String(result.result ?? ''));
}


class MineBlock extends InstantSkill {
  private mcData: any;

  /**
   * Only defer pickup when each block has a solid floor and the whole batch is
   * level. Tree trunks, cliff faces and mixed-height veins still need pickup
   * after every dig: their drops can fall to a different ledge before the bot
   * returns. Keep the deferred group small so collectDrops can reach every
   * spawned item within its bounded pickup passes.
   */
  private canDeferBatchCollection(_blockName: string, targets: Vec3[]): boolean {
    if (targets.length < 2) return false;
    // Where each drop will come to rest: straight down from its block (the batch's other blocks counted as dug) to the first solid
    // floor. Deferred only when every one rests close by and near the body's height, out of any liquid: the face of a vein, a trunk,
    // a pit dug at the feet. A drop that would fall far (a ledge, a ravine) or into water is still taken at once. Collected after
    // every dig, a vein of iron took 2-7 s a block more than its digging (run 19 10:34-10:40; lab, 2026-10-20).
    const dug = new Set(targets.map(target => `${target.x},${target.y},${target.z}`));
    const feet = this.bot.entity.position;
    return targets.every(target => {
      for (let depth = 1; depth <= DEFER_FALL_LIMIT; depth++) {
        const below = new Vec3(target.x, target.y - depth, target.z);
        if (dug.has(`${below.x},${below.y},${below.z}`)) continue;
        const block = this.bot.blockAt(below);
        if (!block) return false;
        if (['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column'].includes(block.name)) return false;
        if (block.boundingBox !== 'block') continue;
        const rest = below.offset(0.5, 1, 0.5);
        return rest.distanceTo(feet) <= DEFER_REST_RANGE && Math.abs(rest.y - feet.y) <= 3;
      }
      return false;
    });
  }

  /**
   * 通常鉱石と deepslate 対をまとめて探す（iron_ore と deepslate_iron_ore など）。
   */
  private static oreMiningFamily(mcData: any, blockName: string): string[] {
    const out = new Set<string>([blockName]);
    if (blockName.startsWith('deepslate_') && blockName.includes('ore')) {
      const rest = blockName.slice('deepslate_'.length);
      if (mcData.blocksByName[rest]) out.add(rest);
    } else if (!blockName.startsWith('deepslate_') && blockName.endsWith('_ore')) {
      const deep = `deepslate_${blockName}`;
      if (mcData.blocksByName[deep]) out.add(deep);
    }
    return [...out];
  }

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'mine-block';
    // Longer than the approach it calls (a move ends by itself at 110 seconds and says how far it got): with
    // the same two minutes for both, the order ran out first and all the planner was told was "timeout".
    // A tunnel towards diamonds ended that way twice running, and wore out the pickaxe on the way (paid run L81).
    this.maxDurationMs = 180_000;
    this.description =
      '指定した種類のブロックを近くから探し、都度いまの位置から高低差と露出を含む到達コスト概算が低い候補を選んで採掘します。実経路は移動時に検証し、深い候補も除外しません。手の届く範囲に複数あればまとめて掘って一括回収（バッチ採掘）するため効率的です。`*_ore` は通常石と深層（deepslate_*）をまとめて扱います。ブロック名は正式ID（例: iron_ore, coal_ore, hay_block, oak_log 等）を使用してください。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'blockName',
        type: 'string',
        description: '採掘するブロック名（Minecraft正式ID: coal_ore, iron_ore, deepslate_iron_ore, diamond_ore, oak_log, stone 等。coalやironではなく_ore付きの正式名を使うこと。カンマ区切りで複数の種類も可: birch_log,oak_log）',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: '採掘する個数（デフォルト: 1）',
        default: 1,
      },
      {
        name: 'searchRadius',
        type: 'number',
        description: '検索半径（デフォルト: 32）',
        default: 32,
      },
      { name: 'collectionPolicy', type: 'string', description: 'target=採掘対象のドロップを優先（既定）、all=周辺ドロップも回収', default: 'target' },
    ];
  }

  async runImpl(blockName: string, count: number = 1, searchRadius: number = 32, collectionPolicy: CollectionPolicy = 'target') {
    assertActionActive(this.bot);
    this.quenched = 0;
    reportActionProgress(this.bot, 'precondition', { blockName, count, searchRadius });
    if (!Number.isInteger(count) || count < 1 || !Number.isFinite(searchRadius) || searchRadius <= 0
      || !['target', 'all'].includes(collectionPolicy)) return { success: false,
        failureType: 'invalid_input', recoverable: false, result: '個数は正の整数、検索半径は正の数、回収方針は target / all を指定してください' };
    // Several kinds may be asked for at once, joined by commas ("birch_log,oak_log", as find-blocks takes them): a planner did so
    // and was told the block did not exist (run 16). Each is mined as its own kind; the first is the one the messages name.
    const askedNames = String(blockName ?? '').split(',').map(name => name.trim()).filter(Boolean);
    const unknownNames = askedNames.filter(name => !this.mcData.blocksByName[name]);
    const knownNames = [...new Set(askedNames.filter(name => this.mcData.blocksByName[name]))];
    if (!knownNames.length) {
      const first = unknownNames[0] ?? String(blockName ?? '');
      const allBlocks = Object.keys(this.mcData.blocksByName);
      const suggestions = allBlocks
        .filter((name: string) => name.includes(first.replace('_ore', '').replace('_log', '')))
        .slice(0, 5);
      return {
        success: false,
        result: `ブロック${blockName}が見つかりません${suggestions.length > 0 ? `。正しい名前: ${suggestions.join(', ')}` : ''}。鉱石は coal_ore, iron_ore 等の _ore 付きの名前を使ってください`,
        failureType: 'invalid_block',
        recoverable: false,
      };
    }
    const unknownNote = unknownNames.length ? `（${unknownNames.join(', ')}は無い名前のため除外）` : '';
    blockName = knownNames.join(',');
    const blockTypes = knownNames.map(name => this.mcData.blocksByName[name]);

    const moveTo = this.bot.instantSkills.getSkill('move-to');
    const digBlockAt = this.bot.instantSkills.getSkill('dig-block-at');
    if (!moveTo || !digBlockAt) {
      return {
        success: false,
        result: '採掘に必要なスキル(move-to / dig-block-at)が見つかりません',
        failureType: 'missing_dependency',
        recoverable: false,
      };
    }

    const want = Math.max(1, count);
    // findBlocks の返却順は不定なので候補を多めに取り、ループ毎に「いまの位置」から近い順に選ぶ
    const scanCount = Math.min(384, Math.max(want * 12, want + 48));
    const familyNames = [...new Set(knownNames.flatMap(name => MineBlock.oreMiningFamily(this.mcData, name)))];
    // The night gate (utils/nightGate): at night without the kit, nothing below the floor it sets is a target. Read once, at the start.
    let gate: ReturnType<typeof descentFloor> = null;
    try { gate = descentFloor(this.bot as any); } catch { gate = null; }
    const gatedKeys = new Set<string>();
    const candidateKeySet = new Set<string>();
    const candidates: Array<{ x: number; y: number; z: number; exposed?: boolean }> = [];
    // Ore on a lake floor or in a flooded cave pulled paid runs under water,
    // where mining is ~25x slower and two bots drowned. Skip blocks touching a
    // water source; dry ore is plentiful.
    const submergedKeys = new Set<string>();
    const touchesWaterSource = (p: { x: number; y: number; z: number }) => [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
      new Vec3(0, 0, 1), new Vec3(0, 0, -1)].some(offset => {
      const neighbor = this.bot.blockAt(new Vec3(p.x + offset.x, p.y + offset.y, p.z + offset.z));
      return neighbor?.name === 'water' && (neighbor.metadata === 0 || (neighbor as any).getProperties?.().level === 0);
    });

    const mergeTargetsFromWorld = (): void => {
      reportActionProgress(this.bot, 'search', { blockName, searchRadius, queuedTargets: candidates.length });
      const queuedKeys = new Set(candidates.map(p => `${p.x},${p.y},${p.z}`));
      for (const name of familyNames) {
        const id = this.mcData.blocksByName[name]?.id;
        if (id === undefined) continue;
        const found = typeof (this.bot.world as any)?.getColumns === 'function'
          ? findLoadedBlocks(this.bot as any, [name], searchRadius, scanCount)
          : this.bot.findBlocks({ matching: id, maxDistance: searchRadius, count: scanCount });
        for (const p of found) {
          const k = `${p.x},${p.y},${p.z}`;
          if (queuedKeys.has(k)) continue;
          const blk = this.bot.blockAt(new Vec3(p.x, p.y, p.z));
          if (!blk || !familyNames.includes(blk.name)) continue;
          if (gate && p.y < gate.floor) { gatedKeys.add(k); continue; }
          if (touchesWaterSource(p)) { submergedKeys.add(k); continue; }
          candidateKeySet.add(k);
          queuedKeys.add(k);
          const exposed = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
            new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
            .some(offset => ['air', 'cave_air', 'void_air'].includes(this.bot.blockAt(new Vec3(p.x + offset.x, p.y + offset.y, p.z + offset.z))?.name ?? ''));
          candidates.push({ x: p.x, y: p.y, z: p.z, exposed });
        }
      }
    };

    // ツルハシの有無・耐久を事前チェック
    const needsPickaxe = ['stone', 'ore', 'cobble', 'deepslate', 'brick', 'obsidian', 'concrete', 'terracotta', 'basalt', 'netherrack']
      .some(keyword => blockName.includes(keyword));
    const pickaxes = this.bot.inventory.items().filter(item => item.name.includes('pickaxe'));
    const hasPickaxe = pickaxes.length > 0;
    let toolWarning = '';

    if (needsPickaxe && !hasPickaxe) {
      return {
        success: false,
        failureType: 'missing_tool',
        recoverable: true,
        result:
          `ツルハシを所持していません。${blockName}の採掘にはツルハシが必要です。` +
          '先に craft-one で wooden_pickaxe / stone_pickaxe / iron_pickaxe 等をクラフトしてから再度 mine-block を実行してください。' +
          '（素材例: wooden_pickaxe = planks×3 + stick×2、stone_pickaxe = cobblestone×3 + stick×2）',
      };
    }
    // The pickaxes' wear is looked at once the targets are known (assessPickaxe below), and again as the order goes on.
    const pickaxeList = (): string => this.bot.inventory.items().filter(item => item.name.includes('pickaxe')).map(p => {
      const mx = (p as any).maxDurability;
      const us = (p as any).durabilityUsed;
      return mx != null && us != null ? `${p.name} 耐久${Math.max(0, mx - us)}/${mx}` : p.name;
    }).join(', ');

    // Cheap prerequisites precede the synchronous, radius-dependent scan.
    const harvestable = (type: any) => !type.harvestTools || this.bot.inventory.items().some(item =>
      Object.keys(type.harvestTools).map(Number).includes(item.type));
    if (!blockTypes.some(harvestable)) {
      return { success: false, failureType: 'missing_tool', recoverable: true,
        result: `${blockName}を回収できる適切なツールがありません。先に必要な道具を用意してください` };
    }
    // Of several kinds, only those that drop for the tools carried are looked for.
    if (blockTypes.length > 1) {
      const kept = new Set(blockTypes.filter(harvestable).flatMap((type: any) => MineBlock.oreMiningFamily(this.mcData, type.name)));
      familyNames.splice(0, familyNames.length, ...familyNames.filter(name => kept.has(name)));
    }
    reportActionProgress(this.bot, 'search', { blockName, searchRadius });
    mergeTargetsFromWorld();
    assertActionActive(this.bot);
    if (candidates.length === 0 && gate && gatedKeys.size) {
      return nightGateRefusal(gate, `mine-block（${blockName}は${searchRadius}ブロック以内に${gatedKeys.size}個あるが、どれも y${gate.floor} より下）`);
    }
    if (candidates.length === 0) return { success: false, failureType: 'target_not_found', recoverable: true,
      result: `${searchRadius}ブロック以内に${blockName}が見つかりません${unknownNote}`
        + (submergedKeys.size ? `（水源に接する${submergedKeys.size}個は水中作業になるため除外。水の無い場所を探してください）` : '') };
    const beforeEntityIds = new Set(Object.values(this.bot.entities ?? {}).map(entity => entity.id));
    const expectedItems = [...new Set(blockTypes.flatMap((type: any) => expectedBlockDrops(this.bot, type)))];
    // 採掘前のインベントリをスナップショット（ドロップアイテム検出用）
    const beforeInventory = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      beforeInventory.set(item.name, (beforeInventory.get(item.name) ?? 0) + item.count);
    }

    let mined = 0;
    let handDugCount = 0;
    const failures: string[] = [];
    let lastFailureType: string | undefined;
    let lastRecoverable = false;
    let stoppedForInventoryFull = false;
    let stoppedForInventoryTight = false;
    // One action has a fixed time (two minutes). Obsidian is nine seconds a block with a diamond pickaxe and
    // more over lava: ten of it ran the action out with a block half dug, the water it had poured left
    // standing and two drops lying uncollected (lab, 2026-10-02). A block that cannot be finished and
    // picked up in what is left is not started; what was done is reported and the rest is asked for again.
    const actionStartedAt = Date.now();
    const timeLeftMs = () => (this.maxDurationMs || 120_000) - (Date.now() - actionStartedAt);
    const COLLECT_RESERVE_MS = 8000;
    const OVER_LAVA_EXTRA_MS = 5000;
    const digMsWithBestTool = (block: any): number => bestToolDigMs(this.bot as any, block);
    const noTimeFor = (block: any, at: Vec3) => mined > 0
      && timeLeftMs() < digMsWithBestTool(block) + (dropBurnsIn(this.bot as any, at) ? OVER_LAVA_EXTRA_MS : 0) + COLLECT_RESERVE_MS;
    let stoppedForTime = false;
    /** The least time worth starting a walk to a block with, and what is said when an action ends on the way to one. */
    const APPROACH_MIN_MS = 45_000;
    let approachNote = '';
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;
    /**
     * The target being walked to, kept first while the walk to it gets nearer. Re-sorting from wherever a stair or a failed move
     * left the body picked another diamond of the same vein each time, and each pick began a new stair in a new direction: three
     * stairs and 136 s, the diamonds still not reached (run 16).
     */
    let pinnedKey: string | null = null;
    /** When the pack was last tidied for room in this call (it is tidied again after TIDY_AGAIN_MS if it has filled up). */
    let lastTidyAt = 0;
    this.roomRefused = [];
    /** What this call mines and what that drops: never thrown away for room (see roomForDig). */
    const keptKinds = familyNames.flatMap(name => [name, ...expectedItems]);
    /**
     * The most blocks this call may count as mined before the pickaxes carried are spent (Infinity: no limit). Set by assessPickaxe.
     * Run 20 broke its only stone pickaxe on the twelfth iron ore: the check was of the uses against the ore alone (not the stone dug on
     * the way), and a spare was only advised, never made.
     */
    let durabilityCap = Infinity;
    let stoppedForTool = false;
    const toolNotes: string[] = [];
    const goal = () => Math.min(want, durabilityCap);
    /**
     * Before the digging, and each time round after it: the pickaxes that can break this ore have fewer uses between them than the
     * ore still to mine (USES_PER_BLOCK each) and, at first, the stone on the straight way to the nearest of it. If so, a spare is made
     * when the bag allows (utils/toolStock ensureToolUses); if none can be, the order is cut to what the pickaxes can take, said in
     * the result, rather than dug until one breaks.
     */
    const assessPickaxe = async (first: boolean): Promise<void> => {
      if (!needsPickaxe || !hasPickaxe || want - mined <= 0) return;
      let digs = 0;
      if (first && candidates.length) {
        const here = this.bot.entity.position;
        const nearest = candidates.reduce((a, b) => (Math.hypot(a.x - here.x, a.y - here.y, a.z - here.z) <= Math.hypot(b.x - here.x, b.y - here.y, b.z - here.z) ? a : b));
        // A tunnel through a solid cell digs about two blocks (head and feet), as the approach cost counts it.
        try { digs = Math.min(APPROACH_DIG_CAP, 2 * solidCellsBetween(this.bot as any, here.offset(0, 1.62, 0), nearest)); } catch { digs = 0; }
      }
      const need = Math.ceil((want - mined) * USES_PER_BLOCK) + digs;
      if (pickaxeUsesFor(this.bot.inventory.items() as any, blockTypes as any) >= need) { durabilityCap = Infinity; return; }
      const check = await ensureToolUses(this.bot as any, blockTypes as any, need, (skill, ...args) => this.callSkill(skill, ...args));
      if (check.note && !toolNotes.includes(check.note)) toolNotes.push(check.note);
      if (check.enough) { durabilityCap = Infinity; return; }
      durabilityCap = mined + Math.floor(Math.max(0, check.have - digs) / USES_PER_BLOCK);
    };
    await assessPickaxe(true);
    if (needsPickaxe && durabilityCap <= mined) {
      return {
        success: false,
        failureType: 'tool_durability_low',
        recoverable: true,
        result:
          `${blockName}を掘る前に止めました。${toolNotes.join('。')}。これ以上掘るとツルハシが壊れるため掘っていません。`
          + `craft-one で予備のツルハシ（stone_pickaxe: 丸石3・棒2）を作ってから再度 mine-block を実行してください。（所持ツルハシ: ${pickaxeList()}）`,
      };
    }
    /** Least headway (metres nearer) for a failed approach to count as getting there. */
    const APPROACH_HEADWAY = 3;

    // Nested movement/drop collection can mine another target through the
    // pathfinder. Count actual completed digs, not just direct skill calls.
    const completedTargets = new Set<string>();
    const targetKey = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
    const onDiggingCompleted = (dug: any) => {
      // Mineflayer emits the new AIR block, not the original material.
      if (dug?.position && candidateKeySet.has(targetKey(dug.position))) {
        completedTargets.add(targetKey(dug.position));
        mined = completedTargets.size;
      }
    };
    this.bot.on('diggingCompleted', onDiggingCompleted);

    try {

    while (mined < count) {
      if (this.shouldInterrupt()) break;
      if (candidates.length === 0) {
        mergeTargetsFromWorld();
        if (candidates.length === 0) break;
      }

      // The pickaxes still hold what is left to mine (a spare is made, or the order is cut to what they can take).
      if (mined > 0) await assessPickaxe(false);
      if (mined >= durabilityCap) { stoppedForTool = true; break; }
      const remainingToMine = goal() - mined;
      // Short of room: what tidyPlan names (spare stone, dirt and the like) is thrown away first, and the room looked at again. A
      // ladder probe (2026-10-20) came to ten obsidian with five slots free, full of the rock its descent had dug, and was refused all
      // twenty times it asked. Tidied again when the last time was a while ago: run 20's second mine-block found the tidy "done" from
      // the walk's start and refused after the tunnel had filled the pack again.
      if (shouldPauseMiningForDeposit(this.bot, remainingToMine, expectedItems) && Date.now() - lastTidyAt > TIDY_AGAIN_MS) {
        lastTidyAt = Date.now();
        toolWarning += await this.tidyPack(familyNames.flatMap(name => [name, ...expectedItems]), timeLeftMs());
      }
      // Still short (nothing tidyPlan names): the spare rock goes too, as before each dig.
      if (shouldPauseMiningForDeposit(this.bot, remainingToMine, expectedItems)) {
        toolWarning += await this.roomForDig(keptKinds, Math.min(DIG_ROOM_SLOTS, slotsForDrops(this.bot, remainingToMine, expectedItems)), timeLeftMs());
      }
      if (shouldPauseMiningForDeposit(this.bot, remainingToMine, expectedItems)) {
        if (mined > 0) {
          stoppedForInventoryTight = true;
          break;
        }
        return {
          success: false,
          failureType: 'inventory_full',
          recoverable: true,
          result:
            `インベントリの空きが${emptySlotCountSafe(this.bot)}スロットしかなく、これから掘る分が入りません。先に片づけを試みましたが空きを作れませんでした。`
            + `${explainNoRoom(this.bot as any, keptKinds, this.roomRefused)}${INVENTORY_FULL_RECOVERY_HINT_JA}${toolWarning}`,
        };
      }

      const here = this.bot.entity.position;
      // Geometric nearness alone made a 13m-deeper ore win over a similarly
      // distant ore 2m below, then spent the action budget tunnelling toward
      // it. Estimate vertical travel and excavation cost, but retain every
      // lower/buried candidate as a fallback if the easier route fails. A
      // block already diggable from here needs no approach at all.
      const reachable = new Set(candidates.filter(candidate => {
        const target = new Vec3(candidate.x, candidate.y, candidate.z);
        const block = this.bot.blockAt(target);
        return block && canDigFromHere(this.bot, block, target);
      }).map(candidate => targetKey(candidate)));
      const unreachable = recentlyUnreachable(this.bot);
      // A block whose drop would burn (lava under or beside it) takes water and a foothold to mine; one of
      // the same kind that needs neither comes first.
      const burning = new Set(candidates.filter(candidate => dropBurnsIn(this.bot as any, new Vec3(candidate.x, candidate.y, candidate.z)))
        .map(candidate => targetKey(candidate)));
      // Ranked by the way to them, the rock on the straight line counted (utils/blockApproachCost): an ore in sight first. Read for the
      // nearest few dozen only (by the plain estimate); the rest keep the plain one, with the buried penalty, behind them.
      const eyes = here.offset(0, 1.62, 0);
      const cost = new Map<string, number>();
      const byGeometry = candidates.map(candidate => ({ candidate, plain: estimateBlockApproachCost(here, candidate, candidate.exposed) }))
        .sort((a, b) => a.plain - b.plain);
      byGeometry.forEach(({ candidate, plain }, index) => cost.set(targetKey(candidate),
        index < REFINED_CANDIDATES ? minedApproachCost(this.bot as any, eyes, candidate) : plain + 1000));
      candidates.sort((a, b) => Number(targetKey(b) === pinnedKey) - Number(targetKey(a) === pinnedKey)
        || Number(reachable.has(targetKey(b))) - Number(reachable.has(targetKey(a)))
        || Number(unreachable.has(targetKey(a))) - Number(unreachable.has(targetKey(b)))
        || Number(burning.has(targetKey(a))) - Number(burning.has(targetKey(b)))
        || cost.get(targetKey(a))! - cost.get(targetKey(b))!);

      const pos = candidates.shift()!;
      const target = new Vec3(pos.x, pos.y, pos.z);
      const block = this.bot.blockAt(target);
      if (!block || !familyNames.includes(block.name)) {
        continue;
      }
      if (noTimeFor(block, target)) { stoppedForTime = true; break; }

      if (!canDigFromHere(this.bot, block, target)) {
        // The pathfinder rarely plans a dig several blocks straight down to a
        // buried ore and gives up at once; descend by stairs toward it first,
        // as a player would, then approach.
        const stairMine = this.bot.instantSkills.getSkill('stair-mine');
        const here = this.bot.entity.position;
        const startGap = here.distanceTo(target);
        if (stairMine && target.y < here.y - 3) {
          const dx = target.x + 0.5 - here.x, dz = target.z + 0.5 - here.z;
          const direction = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north');
          await stairMine.run(target.y + 1, direction, 'cobblestone');
        }
        // Not enough of the action left for the walk: said, with where the body is now, instead of a timeout.
        if (timeLeftMs() < APPROACH_MIN_MS) {
          approachNote = `${blockName}(${target.x}, ${target.y}, ${target.z})へ向かう途中で1回の行動の時間が尽きました（いま ${this.bot.entity.position.floored()}、あと約${Math.round(this.bot.entity.position.distanceTo(target))}m）。もう一度 mine-block を呼べば続きから進みます`;
          stoppedForTime = true;
          break;
        }
        // The walk is given what is left of this action (less what the dig and the pickup take): ended by the move itself, it says
        // how far it got; ended by this action's own time-out, nothing is said at all.
        const moveResult = await moveTo.run(target.x, target.y, target.z, DIG_REACH, 'block', timeLeftMs() - COLLECT_RESERVE_MS - 5_000);
        if (!moveResult.success) {
          lastFailureType = moveResult.failureType ?? 'movement_failed';
          lastRecoverable = moveResult.recoverable ?? true;
          // Nearer by the stair and the walk together, whatever the move called its end (a stuck walk in a tunnel, a time-out); but
          // not when the body's guards refused a dig on the way (lava, a mob behind the wall): the same way would be refused again.
          const gained = startGap - this.bot.entity.position.distanceTo(target);
          const refusedOnWay = String(moveResult.result ?? '').includes('掘削を断りました');
          const closer = moveResult.failureType === 'movement_incomplete' || (gained >= APPROACH_HEADWAY && !refusedOnWay);
          failures.push(`移動失敗(${target.x},${target.y},${target.z}): ${moveResult.failureType ?? 'movement_failed'} — ${String(moveResult.result).slice(0, 200)}`);
          // A walk that ran out of time while getting nearer is not a place that cannot be reached: it is
          // gone on with at the next call, not put behind every other candidate.
          if (!closer) recentlyUnreachable(this.bot).set(targetKey(target), Date.now());
          // Nearer and time left: the same target again from here (a new stair toward it), not the next of the vein.
          if (closer && timeLeftMs() >= APPROACH_MIN_MS && consecutiveFailures + 1 < MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures++;
            pinnedKey = targetKey(target);
            candidates.unshift(pos);
            continue;
          }
          if (closer || timeLeftMs() < APPROACH_MIN_MS) {
            approachNote = `${blockName}(${target.x}, ${target.y}, ${target.z})へ向かう途中です（いま ${this.bot.entity.position.floored()}、あと約${Math.round(this.bot.entity.position.distanceTo(target))}m）。もう一度 mine-block を呼べば続きから進みます`;
            stoppedForTime = true;
            break;
          }
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            failures.push(`${MAX_CONSECUTIVE_FAILURES}回連続で到達失敗 — これ以上の候補を試行しません`);
            break;
          }
          continue;
        }
      }

      // ── バッチ採掘: 手の届く範囲の同種ブロックをまとめて掘る ──
      const batchTargets: Vec3[] = [target];
      // candidates から手の届く範囲のブロックも集める
      const maxBatch = Math.min(remainingToMine, 16);
      const kept: Array<{ x: number; y: number; z: number }> = [];
      for (const c of candidates) {
        if (batchTargets.length >= maxBatch) { kept.push(c); continue; }
        const cv = new Vec3(c.x, c.y, c.z);
        const blk = this.bot.blockAt(cv);
        if (blk && canDigFromHere(this.bot, blk, cv)) {
          if (familyNames.includes(blk.name)) {
            batchTargets.push(cv);
            continue;
          }
        }
        kept.push(c);
      }
      candidates.length = 0;
      candidates.push(...kept);

      if (batchTargets.length >= 2) {
        // ── 複数ブロックをまとめて掘る。安全な水平面だけ小分けで回収 ──
        log.info(`⛏️ バッチ採掘: ${batchTargets.length}個の${blockName}を一括で掘削`);
        let batchDug = 0;
        let batchAbortReason: { type: string; result: string } | null = null;
        const deferCollection = this.canDeferBatchCollection(blockName, batchTargets);
        let pendingOrigins: Vec3[] = [];
        let pendingBeforeInventory = inventoryCounts(this.bot);
        let pendingBeforeEntityIds = new Set(Object.values(this.bot.entities ?? {}).map(entity => entity.id));
        const flushPendingDrops = async () => {
          if (pendingOrigins.length === 0) return;
          const collected = await this.collectAllNearbyDrops(
            pendingOrigins, expectedItems, pendingBeforeEntityIds, collectionPolicy, pendingBeforeInventory,
          );
          if (collected.length > 0) log.info(`📦 小バッチ回収: ${collected.join(', ')}`, 'green');
          pendingOrigins = [];
        };

        for (const bt of batchTargets) {
          if (this.shouldInterrupt() || mined >= goal()) break;
          const blk = this.bot.blockAt(bt);
          if (!blk || !familyNames.includes(blk.name)) continue;
          if (noTimeFor(blk, bt)) { stoppedForTime = true; break; }

          // Collecting the previous block's drop may move the bot. A batch
          // selected in reach is not guaranteed to remain in reach afterwards.
          if (!canDigFromHere(this.bot, blk, bt)) {
            // Collect already-dug blocks before any movement can strand their
            // drops, then re-evaluate reach from the new position.
            await flushPendingDrops();
            const movement = await moveTo.run(bt.x, bt.y, bt.z, DIG_REACH, 'block');
            if (!movement.success) {
              lastFailureType = movement.failureType ?? 'movement_failed';
              lastRecoverable = movement.recoverable ?? true;
              consecutiveFailures++;
              failures.push(`移動失敗(${bt.x},${bt.y},${bt.z}): ${movement.result}`);
              recentlyUnreachable(this.bot).set(targetKey(bt), Date.now());
              if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
              continue;
            }
            if (!familyNames.includes(this.bot.blockAt(bt)?.name ?? '')) continue;
          }

          // A block over lava is dug from a foothold with water over it, and its drop is left lying on the
          // floor the water makes under it. Walking down for each one would mean a new foothold each time:
          // those drops are gathered a few at a time too.
          const overLava = !!dropBurnsIn(this.bot as any, bt);
          let collectImmediately = !deferCollection && !overLava;
          if (!collectImmediately && pendingOrigins.length === 0) {
            pendingBeforeInventory = inventoryCounts(this.bot);
            pendingBeforeEntityIds = new Set(Object.values(this.bot.entities ?? {}).map(entity => entity.id));
          }
          toolWarning += await this.roomForDig(keptKinds, Math.min(DIG_ROOM_SLOTS, 1 + pendingOrigins.length), timeLeftMs());
          let digResult = await digBlockAt.run(bt.x, bt.y, bt.z, collectImmediately, collectionPolicy, false, true);
          // 遮蔽物を除去した場合は同じブロックをリトライ
          if (digResult.failureType === 'obstruction_cleared') {
            await flushPendingDrops();
            collectImmediately = true;
            digResult = await digBlockAt.run(bt.x, bt.y, bt.z, true, collectionPolicy);
          }
          if (digResult.failureType === 'lava_danger' && await this.quenchLavaBeside(digResult)) {
            digResult = await digBlockAt.run(bt.x, bt.y, bt.z, true, collectionPolicy);
          }
          if (!digResult.success) await flushPendingDrops();
          if (digResult.failureType === 'missing_tool' || digResult.failureType === 'equip_failed') {
            batchAbortReason = { type: digResult.failureType, result: digResult.result };
            break;
          }
          // Judged block by block: the one under the feet, or one with lava beside it, says nothing of the
          // next. Ending the whole order at the first of them left a body standing on the obsidian it had
          // made with every other piece of it in reach and untouched (lab, 2026-10-02).
          if (digResult.failureType === 'lava_danger' || digResult.failureType === 'drop_would_burn') {
            recentlyUnreachable(this.bot).set(targetKey(bt), Date.now());
          } else if (refusedForThreat(digResult)) noteUnreachable(this.bot, bt, Date.now(), THREAT_REFUSAL_MS);
          // The body is under water and cannot dig there for want of air: no other block of the batch differs.
          if (digResult.failureType === 'air_short') { batchAbortReason = { type: 'air_short', result: digResult.result }; break; }
          if (digResult.success) {
            if (digResult.handDug) handDugCount++;
            completedTargets.add(targetKey(bt));
            batchDug++;
            consecutiveFailures = 0;
            if (!collectImmediately) {
              pendingOrigins.push(bt);
              if (pendingOrigins.length >= DEFER_GATHER_EVERY) await flushPendingDrops();
            }
          } else {
            lastFailureType = digResult.failureType ?? 'dig_failed';
            lastRecoverable = digResult.recoverable ?? true;
            consecutiveFailures++;
            const failure = `採掘失敗(${bt.x},${bt.y},${bt.z}): ${digResult.failureType ?? 'dig_failed'} — ${digResult.result}`;
            if (failures.at(-1) !== failure) failures.push(failure);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
          }
        }

        await flushPendingDrops();

        // Fortune can yield several items from one ore, so a batch inventory
        // total cannot prove that every dug block's drop was retrieved. Always
        // make a final sweep; deferred batches also allow the last drop time
        // to spawn before leaving the area.
        if (batchDug > 0) {
          const collected = await this.collectAllNearbyDrops(batchTargets, expectedItems, beforeEntityIds,
            collectionPolicy, inventoryCounts(this.bot), deferCollection ? 1200 : 0);
          if (collected.length > 0) {
            log.info(`📦 一括回収: ${collected.join(', ')}`, 'green');
          }
        }

        mined = completedTargets.size;
        if (stoppedForTime) break;

        if (batchAbortReason) {
          lastFailureType = batchAbortReason.type;
          lastRecoverable = true;
          failures.push(`${batchAbortReason.type === 'missing_tool' ? 'ツール不足' : batchAbortReason.type === 'equip_failed' ? '装備失敗' : '中止'}: ${batchAbortReason.result}`);
          break;
        }

        // ツルハシ生存チェック
        if (needsPickaxe) {
          const toolCheck = this.checkToolSurvival(want, mined);
          if (toolCheck) return this.withToolNotes(toolCheck, toolNotes);
        }

        // Rescanning can now requeue failed targets. Preserve the existing
        // failure bound across batches instead of looping forever on them.
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          failures.push(`${MAX_CONSECUTIVE_FAILURES}回連続で採掘失敗 — 別のアプローチを検討してください`);
          break;
        }

        // Revalidate queued blocks cheaply before each dig. Rescan only when
        // the queue is exhausted; never scan after the requested count is met.

      } else {
        // ── 単体採掘: 従来通り collect=true で1個ずつ ──
        toolWarning += await this.roomForDig(keptKinds, 1, timeLeftMs());
        let digResult = await digBlockAt.run(target.x, target.y, target.z, true, collectionPolicy);
        if (digResult.failureType === 'obstruction_cleared') {
          digResult = await digBlockAt.run(target.x, target.y, target.z, true, collectionPolicy);
        }
        if (digResult.failureType === 'lava_danger' && await this.quenchLavaBeside(digResult)) {
          digResult = await digBlockAt.run(target.x, target.y, target.z, true, collectionPolicy);
        }
        if (digResult.failureType === 'missing_tool' || digResult.failureType === 'equip_failed') {
          lastFailureType = digResult.failureType;
          lastRecoverable = true;
          failures.push(`${digResult.failureType === 'equip_failed' ? '装備失敗' : 'ツール不足'}: ${digResult.result}`);
          break;
        }
        if (digResult.failureType === 'lava_danger' || digResult.failureType === 'drop_would_burn') {
          recentlyUnreachable(this.bot).set(targetKey(target), Date.now());
        } else if (refusedForThreat(digResult)) noteUnreachable(this.bot, target, Date.now(), THREAT_REFUSAL_MS);
        if (digResult.failureType === 'air_short') {
          lastFailureType = 'air_short'; lastRecoverable = true;
          failures.push(`中止: ${digResult.result}`);
          break;
        }
        if (digResult.success) {
          if (digResult.handDug) handDugCount++;
          completedTargets.add(targetKey(target));
          mined = completedTargets.size;
          consecutiveFailures = 0;

          if (needsPickaxe) {
            const toolCheck = this.checkToolSurvival(want, mined);
            if (toolCheck) return this.withToolNotes(toolCheck, toolNotes);
          }

          reportActionProgress(this.bot, 'confirm', { completed: mined, requested: want }, true);
        } else {
          lastFailureType = digResult.failureType ?? 'dig_failed';
          lastRecoverable = digResult.recoverable ?? true;
          const failure = `採掘失敗(${target.x},${target.y},${target.z}): ${digResult.failureType ?? 'dig_failed'} — ${digResult.result}`;
          if (failures.at(-1) !== failure) failures.push(failure);
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            failures.push(`${MAX_CONSECUTIVE_FAILURES}回連続で採掘失敗 — 別のアプローチを検討してください`);
            break;
          }
        }
      }
    }

    if (stoppedForInventoryFull) {
      return {
        success: mined > 0,
        failureType: 'inventory_full',
        recoverable: true,
        result:
          `${mined > 0 ? `${mined}個のブロックは掘削済みですが、` : ''}インベントリが満杯のため採掘を中断しました。` +
          'ドロップが地上に残っている可能性があります。deposit-to-container で預けて空きを作ってください。' +
          `${failures.length > 0 ? ` 詳細: ${failures.join(', ')}` : ''}${toolWarning}`,
      };
    }

    const tightNote = stoppedForInventoryTight
      ? ` 【満杯前整理】空きが少ないためここで中断しました。先に空きを作ってから続行してください。${INVENTORY_FULL_RECOVERY_HINT_JA}`
      : '';

    if (mined === 0) {
      if (approachNote) {
        return { success: false, failureType: 'movement_incomplete', recoverable: true,
          result: `まだ${blockName}を掘っていません。${approachNote}${toolWarning}` };
      }
      return {
        success: false,
        result: `${blockName}を採掘できませんでした${failures.length > 0 ? `: ${failures.join(', ')}` : ''}`
          + (failures.some(failure => failure.startsWith('移動失敗')) ? '。到達できなかった位置は次回から後回しにします（崖の上などは別の場所の同じ資源を探す）' : ''),
        failureType: lastFailureType ?? 'mine_failed',
        recoverable: lastRecoverable || failures.length === 0,
      };
    }

    // Gravel is dug for its flint: none came, so the gravel carried is set down and dug again until one does (flintFromGravel).
    let flintNote = '';
    if (knownNames.includes('gravel') && !this.bot.inventory.items().some(item => item.name === 'flint')) flintNote = await this.flintFromGravel(timeLeftMs());

    // 採掘後のインベントリ差分からドロップアイテムを検出
    const drops = this.detectDrops(beforeInventory).filter(drop => collectionPolicy === 'all'
      || expectedItems.length === 0 || expectedItems.includes(drop.item));
    const totalDropCount = drops.reduce((sum, d) => sum + d.count, 0);

    if (totalDropCount === 0 && handDugCount > 0) {
      // Not drops_lost: nothing vanished. A block that needs a harvest tool, broken without one, drops nothing by design.
      return {
        success: false,
        result: `${blockName}を${mined}個掘削しましたが、適切なツールを手に持たず素手で掘ったためドロップはありません（消失ではなく仕様）。`
          + `ブロックは破壊済みです。mc.equip-item でツルハシを手に持ってから残りを掘り直してください。${toolWarning}`,
        failureType: 'hand_dug_no_drop',
        recoverable: true,
      };
    }

    if (totalDropCount === 0) {
      return {
        success: true,
        result: `${blockName}を${mined}個掘削しましたが、ドロップアイテムを回収できませんでした（消失・溶岩・落下等の可能性）。ブロック自体は破壊済みです。${toolWarning}`,
        failureType: 'drops_lost',
        recoverable: true,
      };
    }

    const dropsText = `（ドロップ回収: ${drops.map(d => `${d.item} x${d.count}`).join(', ')}）`;

    // ドロップアイテムの現在所持数を付記（LLMが過剰採掘しないようにする）
    const totalsText = this.formatDropTotals(drops);
    // A pack past 30 of its 36 slots: the plain stone and the clutter go (inventoryTidy), so the next ore is not dropped for want of room.
    toolWarning += await this.tidyPack(familyNames.flatMap(name => [name, ...expectedItems]), timeLeftMs());

    const isPartial = mined < count || stoppedForInventoryTight || stoppedForTool;
    // Said beside what was mined: the rest of the kind lies below the night gate's floor (utils/nightGate).
    if (gate && gatedKeys.size) toolWarning += ` 夜の門: y${gate.floor}より下の${gatedKeys.size}個は、防具（胸当てか、鉄以上の部位2つ）を着るまで夜は掘りません`;
    if (unknownNote) toolWarning += unknownNote;
    if (toolNotes.length) toolWarning += ` ${toolNotes.join('。')}`;
    if (stoppedForTool) {
      toolWarning += ` これ以上掘るとツルハシが壊れるため${mined}個で止めました（残りの耐久は${pickaxeList()}）。craft-one で予備のツルハシを作ってから続きを掘ってください`;
    }
    if (needsPickaxe) toolWarning += spareToolNote(this.bot);
    if (knownNames.some(isWood)) toolWarning += axeAdviceNote(this.bot, mined);
    const timeNote = stoppedForTime && mined < count
      ? `1回の行動の時間（${Math.round((this.maxDurationMs || 120_000) / 1000)}秒）を使い切る前に区切りました。掘った分は回収済みです。`
      : '';
    // Flint is a 10% gravel drop; without the hint a planner keeps searching for more gravel.
    if (!flintNote && blockName === 'gravel' && !this.bot.inventory.items().some(item => item.name === 'flint')) {
      flintNote = '。flint（火打石）は砂利1個あたり約10%で落ちる。必要なら所持した砂利をplace-block-atで置き直してdig-block-atで掘り直せる';
    }
    return {
      success: !isPartial,
      result: isPartial
        ? `${blockName}を${count}個中${mined}個${timeNote ? '' : 'のみ'}採掘しました${dropsText}${totalsText}。${timeNote}残り${count - mined}個${timeNote ? 'は、' : 'が不足しています。'}再度 mine-block を実行してください${tightNote}${failures.length > 0 ? `（失敗詳細: ${failures.join(', ')}）` : ''}${toolWarning}${flintNote}`
        : `${blockName}を${mined}個採掘しました${dropsText}${totalsText}${failures.length > 0 ? `（一部失敗: ${failures.join(', ')}）` : ''}${toolWarning}${flintNote}`,
      ...(isPartial && { failureType: stoppedForTool ? 'tool_durability_low' : stoppedForInventoryTight ? 'inventory_full' : 'partial_completion', recoverable: true }),
    };
    } finally {
      this.bot.removeListener('diggingCompleted', onDiggingCompleted);
    }
  }

  /**
   * バッチ掘削後に周辺のドロップアイテムを一括回収する。
   * inventory 差分で確認しながら、近くの item エンティティに歩いて拾う。
   */
  private async collectAllNearbyDrops(origins: Vec3[], expectedItems: string[],
    beforeEntityIds: Set<number>, policy: CollectionPolicy,
    beforeInventory = inventoryCounts(this.bot), spawnWaitMs = 0): Promise<string[]> {
    return collectDrops(this.bot, { origins, expectedItems, beforeEntityIds, policy,
      beforeInventory, spawnWaitMs, radius: 16 });
  }

  /** Lava poured on in this call (see quenchLavaBeside). */
  private quenched = 0;

  /**
   * The lava a refused dig named beside its block, poured on with the water bucket carried (use-item-on-block: it becomes obsidian
   * and the water is taken back), so the dig can go on. Obsidian made over a pool has lava beside it as often as not: a ladder probe
   * (2026-10-20) mined three of ten and was refused for the rest. At most three a call. False when nothing was poured.
   */
  private async quenchLavaBeside(refusal: { result?: unknown }): Promise<boolean> {
    if (this.quenched >= 3 || !this.bot.inventory.items().some(item => item.name === 'water_bucket')
      || String(this.bot.game?.dimension ?? '').includes('nether')) return false;
    const match = /隣の溶岩\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/.exec(String(refusal.result ?? ''));
    if (!match) return false;
    this.quenched++;
    const named = new Vec3(Number(match[1]), Number(match[2]), Number(match[3]));
    try {
      await this.callSkill('use-item-on-block', named.x, named.y, named.z, 'water_bucket');
      // The lava named is what has to be gone (the pour may have gone to another source of the pool).
      return this.bot.blockAt(named)?.name !== 'lava';
    } catch (error) { if (this.shouldInterrupt()) throw error; return false; }
  }

  /**
   * Throws away what tidyPlan names (drop-item: thrown and walked away from), and says what went. Empty when nothing did. Never the
   * kinds this call was asked to mine; not with a hostile near or in an emergency (the throw walks the body about); not when the action
   * has less than TIDY_TIME_MS left (it would be cut off with its mined result unsaid); two kinds at most.
   */
  /**
   * Room for a dig's drop, made just before the dig: with fewer than `slots` (and two at least) free, what tidyPlan names goes, else the
   * largest heap of spare rock (spareRockToDrop), until there is room or nothing more can go. The walk to an ore through rock fills
   * the pack on the way: a descent from y 108 to -59 left no room, and two diamonds and five obsidian were dug and left lying
   * (mb-body's lab, run 21, 2026-10-20); the check before the walk, and the once-only tidy, had both passed. Not with a hostile near,
   * or with under ROOM_TIME_MS of the action left.
   */
  private async roomForDig(asked: string[], slots: number, timeLeftMs: number): Promise<string> {
    // The doing is utils/inventoryRoom's (shared with the skills that could be refused for a full pack). A refused throw is kept, and
    // another kind tried; what was refused is said if the order is refused in the end.
    const outcome = await makeRoom(this.bot as any, (skill, ...args) => this.callSkill(skill, ...args), {
      asked, slots, timeLeftMs, interrupted: () => this.shouldInterrupt(),
      blocked: () => hostileNear(this.bot as any, TIDY_SAFE_RANGE) || String((this.bot as any).minebotControlState ?? '').startsWith('emergency'),
    });
    for (const refusal of outcome.refused) if (!this.roomRefused.includes(refusal)) this.roomRefused.push(refusal);
    return outcome.note;
  }

  /** What drop-item refused in this call, for the refusal an order may end with (see explainNoRoom). */
  private roomRefused: string[] = [];

  /**
   * Flint from the gravel carried: one set down beside the body (place-block-at chooses the spot), dug again, until a flint comes, the
   * gravel runs out, FLINT_CYCLES are done or the action's time is short. A gravel gives flint one time in ten: ten dug left none in a
   * lab copy of run 19's world, and run 15 took 232 s over ten (mb-body's lab, 2026-10-20); here each try is a second or two where
   * the body stands. Says how many tries it took, or why it stopped.
   */
  private async flintFromGravel(timeLeftMs: number): Promise<string> {
    const started = Date.now();
    const has = (name: string) => this.bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
    let tries = 0;
    while (tries < FLINT_CYCLES && has('flint') === 0 && has('gravel') > 0 && !this.shouldInterrupt()
      && timeLeftMs - (Date.now() - started) > FLINT_RESERVE_MS && !hostileNear(this.bot as any, TIDY_SAFE_RANGE)) {
      let placed: { success?: boolean; result?: unknown } | null = null;
      try { placed = await this.callSkill('place-block-at', 'gravel'); } catch (error) { if (this.shouldInterrupt()) throw error; break; }
      const at = /\((-?\d+), (-?\d+), (-?\d+)\)に設置/.exec(String(placed?.result ?? ''));
      if (!placed?.success || !at) break;
      // Gravel set down over air falls: it is dug where it came to rest.
      let spot = new Vec3(Number(at[1]), Number(at[2]), Number(at[3]));
      for (let depth = 0; depth < 4 && this.bot.blockAt(spot)?.name !== 'gravel'; depth++) spot = spot.offset(0, -1, 0);
      if (this.bot.blockAt(spot)?.name !== 'gravel') break;
      let dug: { success?: boolean } | null = null;
      try { dug = await this.callSkill('dig-block-at', spot.x, spot.y, spot.z, true, 'target'); } catch (error) { if (this.shouldInterrupt()) throw error; break; }
      tries++;
      if (!dug?.success) break;
    }
    if (!tries) return '';
    const seconds = Math.round((Date.now() - started) / 1000);
    return has('flint') > 0
      ? `。flint（火打石）が出なかったので、持っている砂利を置いて掘り直し、${tries}回目で出ました（${seconds}秒）`
      : `。flint（火打石）を砂利の置き直しで${tries}回試しましたが出ませんでした（${seconds}秒。砂利の残り${has('gravel')}個）`;
  }

  private async tidyPack(asked: string[], timeLeftMs: number): Promise<string> {
    if (timeLeftMs < TIDY_TIME_MS) return '';
    return tidyPackNow(this.bot as any, (skill, ...args) => this.callSkill(skill, ...args), {
      asked, timeLeftMs, interrupted: () => this.shouldInterrupt(),
      blocked: () => hostileNear(this.bot as any, TIDY_SAFE_RANGE) || String((this.bot as any).minebotControlState ?? '').startsWith('emergency'),
    });
  }

  /** What assessPickaxe found out (a spare made, or none to make) is said with the end of the order a worn pickaxe brought. */
  private withToolNotes(check: any, notes: string[]): any {
    return notes.length ? { ...check, result: `${check.result} ${notes.join('。')}` } : check;
  }

  /**
   * ツルハシの生存・耐久チェック。問題があれば返却オブジェクトを返す。
   */
  private checkToolSurvival(want: number, mined: number): any {
    const pickaxesNow = this.bot.inventory.items().filter(item => item.name.includes('pickaxe'));
    if (pickaxesNow.length === 0) {
      const remaining = want - mined;
      return {
        success: mined > 0,
        failureType: 'missing_tool',
        recoverable: true,
        result:
          `採掘中にツルハシが壊れました（${mined}個掘削済み、残り${remaining}個未採掘）。` +
          'craft-one で新しいツルハシをクラフトしてから mine-block を再実行してください。',
      };
    }
    // The pickaxe with the most left decides, as in stair-mine: a worn-out spare beside a sound one is not a reason to stop (run 17).
    let minRemaining = -Infinity;
    for (const p of pickaxesNow) {
      const mx = (p as any).maxDurability;
      const us = (p as any).durabilityUsed;
      minRemaining = mx != null && mx > 0 && us != null && us >= 0 ? Math.max(minRemaining, mx - us) : Infinity;
      if (minRemaining === Infinity) break;
    }
    const remaining = want - mined;
    if (Number.isFinite(minRemaining) && minRemaining <= 3 && remaining > 0) {
      return {
        success: mined > 0,
        failureType: 'tool_durability_low',
        recoverable: true,
        result:
          `${mined}個採掘しましたが、ツルハシの残り耐久が${minRemaining}しかありません（残り${remaining}個未採掘）。` +
          'craft-one で新しいツルハシをクラフトしてから mine-block を再実行してください。',
      };
    }
    return null;
  }

  /**
   * ドロップアイテムの現在インベントリ所持数をフォーマットする。
   */
  private formatDropTotals(drops: Array<{ item: string; count: number }>): string {
    if (drops.length === 0) return '';
    const currentInventory = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      currentInventory.set(item.name, (currentInventory.get(item.name) ?? 0) + item.count);
    }
    const totals = drops
      .map(d => `${d.item}=${currentInventory.get(d.item) ?? 0}個`)
      .join(', ');
    return `（現在の所持数: ${totals}）`;
  }

  /**
   * 採掘前後のインベントリ差分からドロップアイテムを検出する。
   */
  private detectDrops(beforeInventory: Map<string, number>): Array<{ item: string; count: number }> {
    const afterInventory = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      afterInventory.set(item.name, (afterInventory.get(item.name) ?? 0) + item.count);
    }

    const drops: Array<{ item: string; count: number }> = [];
    for (const [name, afterCount] of afterInventory) {
      const beforeCount = beforeInventory.get(name) ?? 0;
      if (afterCount > beforeCount) {
        drops.push({ item: name, count: afterCount - beforeCount });
      }
    }
    return drops;
  }
}

export default MineBlock;
