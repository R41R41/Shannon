import { isLlmCentric } from '../utils/llmCentric.js';
import { resyncInventory } from '../utils/inventorySync.js';
import minecraftData from 'minecraft-data';
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { actionDelay } from '../execution/observedWait.js';
import { placeableSpots } from './findPlaceableSpot.js';
import { bodyCells, isFreeCell } from './sleepInBed.js';
import { WORKSTATION_BLOCKS, findStances, planWorkstationSpot, stationAccess, worksiteState } from '../utils/workstationAccess.js';

const { goals } = pathfinder;

/** Cells a block can be placed into, as in vanilla (fluids and non-solid plants are replaced). */
type PlaceResult = { success: boolean; result: string; failureType?: string; recoverable?: boolean };

/** Other cells tried, one after another, when the server takes none of the one the body chose. */
const MAX_PLACE_RETRIES = 2;

const REPLACEABLE_TARGETS = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'bubble_column', 'short_grass',
  'tall_grass', 'fern', 'large_fern', 'dead_bush', 'seagrass', 'tall_seagrass', 'vine', 'glow_lichen', 'snow',
  'fire', 'soul_fire', 'light']);

/**
 * 原子的スキル: 指定座標にブロックを設置
 */
class PlaceBlockAt extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'place-block-at';
    this.description = '指定座標にブロックを1個置く';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'blockName',
        type: 'string',
        description: '設置するブロック名（例: crafting_table, stone, cobblestone）※必須',
        required: true,
      },
      {
        name: 'x',
        type: 'number',
        description: 'X座標（整数）。x・y・z を省略すると、手の届く置ける場所（床の上、自分の体と重ならない所）を自分で選ぶ',
        required: false,
      },
      {
        name: 'y',
        type: 'number',
        description: 'Y座標（整数）',
        required: false,
      },
      {
        name: 'z',
        type: 'number',
        description: 'Z座標（整数）',
        required: false,
      },
    ];
  }

  /**
   * Where to put it when no place was given: the nearest cell within reach that can take it (find-placeable-spot's search), on a
   * floor first, out of the cells the body fills, with the head cell free too for a bed. Run 17 called find-placeable-spot and then
   * place-block-at five times over; three of its placements were refused for a cell its own body stood in.
   */
  private chooseSpot(blockName: string): Vec3 | null {
    const body = bodyCells(this.bot.entity.position);
    const eyes = this.bot.entity.position.offset(0, 1.62, 0);
    const bed = blockName.endsWith('_bed');
    const spots = placeableSpots(this.bot as any, 4, 32)
      .filter(spot => !body.some(cell => cell.x === spot.x && cell.y === spot.y && cell.z === spot.z))
      .filter(spot => !this.avoidCells.some(cell => cell.x === spot.x && cell.y === spot.y && cell.z === spot.z))
      .filter(spot => new Vec3(spot.x + 0.5, spot.y + 0.5, spot.z + 0.5).distanceTo(eyes) <= 4.5)
      // A bed stands on floor under both its halves; the head cell has to be free as well.
      .filter(spot => !bed || (this.bot.blockAt(new Vec3(spot.x, spot.y - 1, spot.z))?.boundingBox === 'block'
        && this.bedHeadFree(new Vec3(spot.x, spot.y, spot.z), body)))
      .sort((a, b) => Number(b.ref === '下') - Number(a.ref === '下') || a.dist - b.dist);
    return spots[0] ? new Vec3(spots[0].x, spots[0].y, spots[0].z) : null;
  }

  /** Cells not to choose again: a workstation just taken up because it hid another (one re-placement only). */
  private avoidCells: Vec3[] = [];
  private replacing = false;

  /**
   * A cell for a crafting table or a furnace (utils/workstationAccess): in use reach and in sight from where the body stands, hiding
   * no workstation that can be used from here, leaving a way out. In a corridor with no such cell, a wall cell beside the body is
   * dug out and the block goes into it. Null: nothing better than the plain search is known.
   */
  private async chooseWorkstationSpot(blockName: string): Promise<{ cell: Vec3; note: string } | null> {
    try {
      const plan = planWorkstationSpot(this.bot as any, blockName, placeableSpots(this.bot as any, 4, 48), { exclude: this.avoidCells });
      for (const entry of plan.slice(0, 4)) {
        if (entry.score >= 1000) break;
        if (!entry.niche) return { cell: entry.cell, note: '' };
        if (this.shouldInterrupt()) return null;
        // collect=false: the drop stays in the niche (the body would otherwise walk into the hole after it, and out of its place).
        const dug = await this.callSkill('dig-block-at', entry.cell.x, entry.cell.y, entry.cell.z, false);
        if (dug.success && isFreeCell(this.bot.blockAt(entry.cell))) return { cell: entry.cell, note: '狭い所なので、壁を1マス掘って置き場所にしました。' };
      }
    } catch (error) { if (this.shouldInterrupt()) throw error; }
    return null;
  }

  /**
   * After a workstation is down: every workstation of the worksite is checked to be usable from here. Hidden ones (the new block in
   * front of a table, a furnace behind it) are put right by a step to a spot from which all are in sight; failing that, a block this
   * call chose itself is taken up and put elsewhere, once. Said when something stays hidden. Empty when all is well.
   */
  private async settleWorksite(blockName: string, placed: Vec3, autoChosen: boolean): Promise<string | { replaced: { success: boolean; result: string; failureType?: string; recoverable?: boolean } }> {
    try {
      const bot = this.bot as any;
      const eyes = this.bot.entity.position.offset(0, 1.62, 0);
      const state = worksiteState(bot);
      const near = state.stations.filter(station => station.position.offset(0.5, 0.5, 0.5).distanceTo(eyes) <= 5.5);
      const hidden = state.unusable.filter(item => item.inReach || (item.position.x === placed.x && item.position.y === placed.y && item.position.z === placed.z));
      if (!hidden.length) return '';
      const label = (item: { name: string; position: Vec3 }) => `${item.name}(${item.position.x}, ${item.position.y}, ${item.position.z})`;
      // A spot from which the nearby ones are all in sight; else at least the hidden ones and the new block.
      const wanted = [near.map(item => item.position), [...hidden.map(item => item.position), placed]];
      for (const targets of wanted) {
        const stance = findStances(bot, targets, { limit: 3 })[0];
        if (!stance || this.shouldInterrupt()) continue;
        await this.callSkill('move-to', stance.feet.x, stance.feet.y, stance.feet.z, 0.5, 'near');
        if (targets.every(target => stationAccess(bot, target).ready)) {
          return `。${hidden.map(label).join('、')}が見えるよう、立ち位置を(${Math.floor(stance.feet.x)}, ${Math.floor(stance.feet.y)}, ${Math.floor(stance.feet.z)})に変えました`;
        }
      }
      // The new block hides another one and no spot sees both: taken up and put elsewhere (once).
      const hiddenByNew = hidden.some(item => !(item.position.x === placed.x && item.position.y === placed.y && item.position.z === placed.z));
      if (autoChosen && hiddenByNew && !this.replacing && !this.shouldInterrupt()) {
        this.replacing = true;
        this.avoidCells.push(placed);
        try {
          const taken = await this.callSkill('dig-block-at', placed.x, placed.y, placed.z, true, 'target', true);
          if (taken.success) {
            const again = await this.runImpl(blockName);
            // The new placement's own answer stands (its position is the one the caller reads); the first is said after it.
            if (again.success) return { replaced: { ...again, result: `${again.result}。先に置いた(${placed.x}, ${placed.y}, ${placed.z})は他の設備を隠したので拾い直して置き直しました` } };
          }
        } finally { this.replacing = false; }
      }
      return `。注意: ${hidden.map(item => `${label(item)}${item.obstruction ? `は${item.obstruction}に遮られて` : 'は'}今の立ち位置から使えません`).join('、')}`
        + '（使う時に自分で立ち位置を変えます）';
    } catch (error) {
      if (this.shouldInterrupt()) throw error;
      return '';
    }
  }

  /** A bed lies the way the body faces as it places it: its head is the cell past the foot, away from the body. */
  private bedHeadFree(foot: Vec3, body: Vec3[]): boolean {
    const at = this.bot.entity.position;
    const dx = foot.x + 0.5 - at.x, dz = foot.z + 0.5 - at.z;
    const head = Math.abs(dx) >= Math.abs(dz) ? foot.offset(Math.sign(dx), 0, 0) : foot.offset(0, 0, Math.sign(dz));
    return isFreeCell(this.bot.blockAt(head)) && this.bot.blockAt(head.offset(0, -1, 0))?.boundingBox === 'block'
      && !body.some(cell => cell.equals(head));
  }

  /** Too far to place from where the body is now: said without waiting for the body, with where the body is. */
  protected preflight(_blockName: string, x: number, y: number, z: number) {
    const position = this.bot.entity?.position;
    if (!position || ![x, y, z].every(Number.isFinite)) return null;
    const distance = position.distanceTo(new Vec3(x, y, z));
    if (distance <= 5) return null;
    return {
      success: false,
      result: `設置場所が遠すぎます（距離: ${distance.toFixed(1)}m、5m以内に近づいてください。現在位置: ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}）`,
      failureType: 'distance_too_far',
      recoverable: true,
    };
  }

  /** How deep the calls of runImpl are (a re-placement or another cell tried calls it again): the cells to avoid are forgotten at the top. */
  private depth = 0;
  private placeRetries = 0;

  async runImpl(blockName: string, x?: number, y?: number, z?: number): Promise<PlaceResult> {
    if (this.depth === 0) { this.avoidCells = []; this.placeRetries = 0; }
    this.depth++;
    try { return await this.placeOnce(blockName, x, y, z); }
    finally { if (--this.depth === 0) { this.avoidCells = []; this.placeRetries = 0; } }
  }

  private async placeOnce(blockName: string, x?: number, y?: number, z?: number): Promise<PlaceResult> {
    try {
      let note = '';
      // パラメータチェック（座標が無ければ、自分で選ぶ）
      let autoChosen = false;
      if (x == null && y == null && z == null && isLlmCentric(this.bot)) {
        // The LLM-centric body chooses no place (MINEBOT_LLM_CENTRIC): the planner names the cell from the map.
        return { success: false, failureType: 'invalid_input', recoverable: false, result: '置く場所（x・y・z）を指定してください（この体は置き場所を自分で選びません）' };
      }
      if (x == null && y == null && z == null) {
        let spot: Vec3 | null = null;
        // A crafting table or a furnace: where it hides no other workstation from here and does not close the way out (a wall cell
        // is dug out for it in a tunnel). Run 20: the second furnace's table stood behind the first furnace.
        if (WORKSTATION_BLOCKS.has(blockName)) {
          const picked = await this.chooseWorkstationSpot(blockName);
          if (picked) { spot = picked.cell; note += picked.note; }
        }
        spot ??= this.chooseSpot(blockName);
        if (!spot) return { success: false, failureType: 'target_not_found', recoverable: true,
          result: `手の届く所に${blockName}を置ける場所がありません（床があり、自分の体と重ならない空きマス）。少し動いてから呼んでください` };
        ({ x, y, z } = spot);
        note += `置き場所(${x}, ${y}, ${z})は自分で選びました。`;
        autoChosen = true;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります（x・y・z を全部省略すると自分で選びます）',
          failureType: 'invalid_input',
          recoverable: false,
        };
      }
      x = x as number; y = y as number; z = z as number;
      // A solid block given where the cell above it is meant (the ground under the spot): one up, said (run 17, D54: grass_block).
      const given = this.bot.blockAt(new Vec3(x, y, z));
      if (given && given.boundingBox === 'block' && isFreeCell(this.bot.blockAt(new Vec3(x, y + 1, z)))
        && !bodyCells(this.bot.entity.position).some(cell => cell.x === x && cell.y === y! + 1 && cell.z === z)) {
        note += `(${x}, ${y}, ${z})は${given.name}で埋まっているため、その上(${x}, ${y + 1}, ${z})に置きます。`;
        y = y + 1;
      }

      const blockType = this.mcData.blocksByName[blockName];
      if (!blockType) {
        return {
          success: false,
          result: `ブロック${blockName}が見つかりません`,
          failureType: 'invalid_block',
          recoverable: false,
        };
      }

      const item = this.bot.inventory
        .items()
        .find((item) => item.name === blockName);

      if (!item) {
        return {
          success: false,
          result: `インベントリに${blockName}がありません`,
          failureType: 'missing_item',
          recoverable: true,
        };
      }

      const targetPos = new Vec3(x, y, z);

      // 距離チェック
      const distance = this.bot.entity.position.distanceTo(targetPos);
      if (distance > 5) {
        return {
          success: false,
          result: `設置場所が遠すぎます（距離: ${distance.toFixed(
            1
          )}m、5m以内に近づいてください）`,
          failureType: 'distance_too_far',
          recoverable: true,
        };
      }

      // 設置場所がすでにブロックで埋まっているかチェック（水・草など置き換え可能なものは埋まっていない扱い）
      const existingBlock = this.bot.blockAt(targetPos);
      if (existingBlock && !REPLACEABLE_TARGETS.has(existingBlock.name)) {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})にはすでに${existingBlock.name}があります`,
          failureType: 'target_occupied',
          recoverable: true,
        };
      }

      // ボット自身がいる位置なら自動で退避してから設置。The whole box of the body, not only the cell its centre is in: standing
      // near an edge it is in the next cell too, and the server refuses a block there (run 17: three "no block has been placed").
      if (bodyCells(this.bot.entity.position).some(cell => cell.x === x && cell.y === y && cell.z === z)) {
        const moved = await this.stepAside(targetPos);
        if (!moved) {
          return {
            success: false,
            result: `座標(${x}, ${y}, ${z})はボット自身がいる位置で、退避先が見つかりません`,
            failureType: 'invalid_target',
            recoverable: true,
          };
        }
      }

      // 参照ブロックを探す（設置する場所の隣接ブロック）
      // 下→側面（東西南北）→上の順で探す
      const offsets: [number, number, number, number, number, number][] = [
        [0, -1, 0, 0, 1, 0],   // 下のブロック → 上向きに設置
        [1, 0, 0, -1, 0, 0],   // 東のブロック → 西向きに設置
        [-1, 0, 0, 1, 0, 0],   // 西のブロック → 東向きに設置
        [0, 0, 1, 0, 0, -1],   // 南のブロック → 北向きに設置
        [0, 0, -1, 0, 0, 1],   // 北のブロック → 南向きに設置
        [0, 1, 0, 0, -1, 0],   // 上のブロック → 下向きに設置
      ];

      let referenceBlock = null;
      let faceVector = new Vec3(0, 1, 0);

      for (const [ox, oy, oz, fx, fy, fz] of offsets) {
        const candidate = this.bot.blockAt(targetPos.offset(ox, oy, oz));
        // A placement face needs a solid block; water or grass beside the target cannot hold one.
        if (candidate && candidate.boundingBox === 'block') {
          referenceBlock = candidate;
          faceVector = new Vec3(fx, fy, fz);
          break;
        }
      }

      if (!referenceBlock) {
        return {
          success: false,
          result:
            `設置場所の周囲に参照ブロックがありません（空中には設置できません）。` +
            `座標(${x},${y},${z})の上下左右前後にソリッドブロックが必要です。` +
            `対処法: 下のブロック(${x},${y - 1},${z})から順に積み上げて設置するか、隣接する位置に先にブロックを置いてください。`,
          failureType: 'unsupported_target',
          recoverable: true,
        };
      }

      const notHeld = await this.holdForPlacing(blockName);
      if (notHeld) return notHeld;
      try {
        await this.bot.placeBlock(referenceBlock, faceVector);
      } catch (actionError: any) {
        const los = await ensureLineOfSight(this.bot, referenceBlock.position);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        // The server placed nothing. One reason is that the body does not hold what its copy of its pack says
        // it holds: a chest "crafted" in that copy only was placed eleven times, each waiting five seconds for a
        // block that never came (paid run L74). The pack is looked at before the failure is reported.
        const hadBefore = this.bot.inventory.items().filter((entry) => entry.name === blockName).reduce((sum, entry) => sum + entry.count, 0);
        let synced = false;
        try { synced = await resyncInventory(this.bot as any); } catch { synced = false; }
        const hasNow = this.bot.inventory.items().filter((entry) => entry.name === blockName).reduce((sum, entry) => sum + entry.count, 0);
        if (synced && hasNow === 0) {
          return { success: false, failureType: 'missing_item', recoverable: true,
            result: `${blockName}は実際には持っていませんでした（所持品をサーバーと照合した結果。写しでは${hadBefore}個）。作り直すか、入手してください` };
        }
        // Something stands in the cell (the body itself, a mob, a dropped block of sand): the server answers nothing.
        if (String(actionError?.message ?? '').includes('did not fire within timeout')) {
          // A cell the body chose itself that the server would not take: the next cell that suits is tried (twice at most), the one that failed left out.
          if (autoChosen && this.placeRetries < MAX_PLACE_RETRIES && !this.shouldInterrupt()) {
            this.placeRetries++;
            this.avoidCells.push(targetPos);
            const again = await this.runImpl(blockName);
            if (again.success) return { ...again, result: `${again.result}（先に選んだ(${x}, ${y}, ${z})は受け付けられなかったので別の場所に置き直しました）` };
            return again;
          }
          return { success: false, failureType: 'place_failed', recoverable: true,
            result: `${blockName}を(${x}, ${y}, ${z})に置けませんでした: サーバーが設置を受け付けませんでした（${blockName}は${hasNow}個持っています）。`
              + '置き先に身体やMobが重なっているか、支えにしたブロックに届いていません。立ち位置か置き先を変えてください' };
        }
        throw actionError;
      }

      // A workstation is used from the spot it was set down from: that nothing else of the worksite is now hidden is checked here.
      const worksite = WORKSTATION_BLOCKS.has(blockName) ? await this.settleWorksite(blockName, targetPos, autoChosen) : '';
      if (typeof worksite !== 'string') return worksite.replaced;
      return {
        success: true,
        result: `${note}${blockName}を(${x}, ${y}, ${z})に設置しました${worksite}`,
      };
    } catch (error: any) {
      // エラーメッセージを詳細化
      let errorDetail = error.message;
      if (error.message.includes('far away')) {
        errorDetail = '設置場所が遠すぎます';
      } else if (error.message.includes('cannot place')) {
        errorDetail = 'ブロックを設置できません（空中、障害物など）';
      } else if (error.message.includes('equipped')) {
        errorDetail = 'アイテムを装備できませんでした';
      } else if (/invalid operation/i.test(error.message)) {
        errorDetail = `所持品の窓の操作が無効でした（開いている窓: ${(this.bot as any).currentWindow?.type ?? 'なし'}）。窓を閉じてからもう一度呼んでください`;
      }

      return {
        success: false,
        result: `設置エラー: ${errorDetail}`,
        failureType: error.message.includes('far away')
          ? 'distance_too_far'
          : error.message.includes('cannot place')
            ? 'unsupported_target'
            : error.message.includes('equipped') || /invalid operation/i.test(error.message)
              ? 'equip_failed'
              : 'place_failed',
        recoverable:
          error.message.includes('far away') ||
          error.message.includes('cannot place') ||
          error.message.includes('equipped') ||
          /invalid operation/i.test(error.message),
      };
    }
  }
  /**
   * The block in hand for placing. A click on the pack goes to the window that is open, in that window's numbering, so a window left
   * open (a crafting table's, a furnace's) turns "equip" into a click on a slot it does not have: "invalid operation", and in run 22 the
   * third furnace was crafted and never set down. The window is closed first; on a failure the pack is made the server's again, the
   * item looked for afresh, and a hotbar item taken by selecting its slot. What is still wrong is said, with what the body saw.
   */
  private async holdForPlacing(blockName: string): Promise<{ success: false; failureType: string; recoverable: boolean; result: string } | null> {
    const bot = this.bot as any;
    const find = () => this.bot.inventory.items().find(entry => entry.name === blockName);
    const closeWindow = async () => {
      if (!bot.currentWindow) return false;
      try { bot.closeWindow(bot.currentWindow); } catch { /* the window may already be going */ }
      await actionDelay(this.bot, 150);
      return true;
    };
    const openedWindow = bot.currentWindow?.type ?? null;
    await closeWindow();
    let failure: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const item = find();
      if (!item) break;
      try {
        if (bot.heldItem?.name === blockName) return null;
        await this.bot.equip(item, 'hand');
        return null;
      } catch (error: any) {
        failure = error;
        if (this.shouldInterrupt()) throw error;
        await closeWindow();
        if (attempt === 0) { try { await resyncInventory(this.bot as any); } catch { /* tried again below */ } }
        // A hotbar item needs no click: its slot is selected.
        const fresh = find();
        if (fresh && typeof fresh.slot === 'number' && fresh.slot >= 36 && fresh.slot <= 44 && typeof bot.setQuickBarSlot === 'function') {
          try { bot.setQuickBarSlot(fresh.slot - 36); await actionDelay(this.bot, 100); if (bot.heldItem?.name === blockName) return null; } catch { /* said below */ }
        }
      }
    }
    if (!failure) {
      return { success: false, failureType: 'missing_item', recoverable: true, result: `インベントリに${blockName}がありません` };
    }
    const item = find();
    const message = String(failure?.message ?? failure);
    return { success: false, failureType: 'equip_failed', recoverable: true,
      result: `${blockName}を手に持てませんでした（${message}）。所持品の窓の操作がサーバーと合っていません`
        + `（最初に開いていた窓: ${openedWindow ?? 'なし'}、${blockName}のスロット: ${item?.slot ?? '不明'}、手に持っているもの: ${bot.heldItem?.name ?? 'なし'}）。`
        + '窓を閉じ、少し待ってからもう一度呼んでください（置く物が手に取れないだけで、置き場所の問題ではありません）' };
  }
  /**
   * 設置対象座標から1ブロック退避する。
   * 隣接4方向で足場があり空気がある安全な場所に移動する。
   */
  private async stepAside(target: Vec3): Promise<boolean> {
    const cardinals = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    ];
    for (const dir of cardinals) {
      const dest = target.plus(dir);
      const ground = this.bot.blockAt(dest.offset(0, -1, 0));
      const feet = this.bot.blockAt(dest);
      const head = this.bot.blockAt(dest.offset(0, 1, 0));
      if (
        ground && ground.name !== 'air' &&
        feet && feet.name === 'air' &&
        head && head.name === 'air'
      ) {
        try {
          await gotoSafe(this.bot, new goals.GoalNear(dest.x + 0.5, dest.y, dest.z + 0.5, 0.5), {
            timeoutMs: 2000,
            stuckAbortCount: 2,
            logStuck: false,
          });
          await actionDelay(this.bot, 200);

          const newPos = this.bot.entity.position;
          const dx = Math.floor(newPos.x) - Math.floor(target.x);
          const dz = Math.floor(newPos.z) - Math.floor(target.z);
          if (dx !== 0 || dz !== 0) return true;
        } catch { /* ignore */ }
      }
    }
    return false;
  }
}

export default PlaceBlockAt;
