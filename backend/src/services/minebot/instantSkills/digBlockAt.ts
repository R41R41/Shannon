import { Vec3 } from 'vec3';
import { chooseTool } from '../utils/toolChoice.js';
import { keepCheapTool } from '../utils/toolStock.js';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { assertActionActive, currentAction, reportActionProgress } from '../execution/ActionExecution.js';
import { eyeCell } from '../utils/bodyPose.js';
import { collectDrops, expectedBlockDrops, inventoryCounts, type CollectionPolicy } from '../execution/collectDrops.js';
import { waitForObservation, type ObservationSource } from '../execution/observedWait.js';
import { canDigFromHere } from '../utils/blockInteractionReach.js';
import { digBlockVerified, ServerDigUnconfirmedError } from '../utils/digBlockVerified.js';
import { LavaReleaseError, lavaReleasedBy } from '../utils/lavaSafety.js';
import { ThreatExposedError } from '../utils/exposureGuard.js';
import { dropBurnsIn, lavaBesideOrOver } from '../utils/dropFate.js';
import { activateItemFacing } from '../utils/activateItemFacing.js';
import { liquidAimPoints } from '../utils/liquidAim.js';
import { holdsWater } from '../utils/waterBlocks.js';
import { fallIsDangerous, stepOffDrop } from '../utils/edgeGuard.js';
import { actionDelay } from '../execution/observedWait.js';

const log = createLogger('Minebot:Skill:digBlockAt');

/**
 * 原子的スキル: 近くのブロックを掘る（座標指定版）
 */
class DigBlockAt extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'dig-block-at';
    this.description = '指定座標のブロックを掘ります。作業台・かまど・ベッドなどの設備は誤って壊さないよう通常は掘りません。'
      + '自分が置いた設備を持ち運ぶために回収する時だけ takeEquipment を true にします。';
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: 'X座標',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: 'Y座標',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: 'Z座標',
        required: true,
      },
      {
        name: 'collect',
        type: 'boolean',
        description: '掘削後にドロップアイテムを自動回収するか（デフォルト: true）。連続で複数ブロック掘る場合はfalseにして最後にpickup-nearest-itemで回収すると効率的',
        default: true,
      },
      { name: 'collectionPolicy', type: 'string', description: 'target=この採掘のドロップを優先（既定）、all=周辺の全ドロップも回収', default: 'target' },
      { name: 'takeEquipment', type: 'boolean', description: '作業台・かまど・ベッドなどの設備を、持ち運ぶために回収する時だけtrue（デフォルト: false）。中身の入った収納やかまどは中身が落ちる', default: false },
    ];
  }

  /**
   * `keepDrop` is for a caller that collects later itself (mine-block gathers a batch in one walk): the drop is
   * wanted though `collect` is false, so it is still kept from lava. Not a parameter the planner sees.
   */
  /**
   * The fall the body would take if this block, one it stands on, were gone: null when it is not under the body or
   * the fall is one it survives. The edge reflex stops a step over a drop; it cannot hold up a body whose floor is
   * dug out from under it. A planner dug down through the block under its feet into a cave over a lava pool, fell six
   * blocks into the lava and died (paid run L96, seventy-five minutes in, the run's diamond pickaxe in hand).
   */
  private footingDrop(pos: Vec3): number | null {
    const position = this.bot.entity?.position;
    if (!position) return null;
    if (Math.floor(position.y - 0.01) !== pos.y) return null;
    const corners = [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]];
    if (!corners.some(([dx, dz]) => Math.floor(position.x + dx) === pos.x && Math.floor(position.z + dz) === pos.z)) return null;
    const without = { blockAt: (at: Vec3) => (Math.floor(at.x) === pos.x && Math.floor(at.y) === pos.y && Math.floor(at.z) === pos.z
      ? { name: 'air', boundingBox: 'empty' } : this.bot.blockAt(at)) as any };
    let drop = 0;
    try { drop = stepOffDrop(without, position.x, position.y, position.z); } catch { return null; }
    return fallIsDangerous(drop, this.bot.health ?? 20) ? drop : null;
  }

  async runImpl(x: number, y: number, z: number, collect: boolean = true, collectionPolicy: CollectionPolicy = 'target', takeEquipment: boolean = false, keepDrop: boolean = collect) {
    try {
      assertActionActive(this.bot);
      this.waterLeftAt = null;
      reportActionProgress(this.bot, 'precondition', { target: [x, y, z] });
      if (!['target', 'all'].includes(collectionPolicy)) return { success: false,
        failureType: 'invalid_input', recoverable: false, result: 'collectionPolicy は target / all を指定してください' };
      // パラメータチェック
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります',
          failureType: 'invalid_input',
          recoverable: false,
        };
      }

      const pos = new Vec3(x, y, z);

      const block = this.bot.blockAt(pos);

      if (!block) {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})にブロックが見つかりません（チャンク未ロードの可能性）`,
          failureType: 'target_not_found',
          recoverable: true,
        };
      }

      // Equipment is protected from being dug by accident (a path, a wide
      // mining order), not from its owner: a bot that could not take its bed,
      // crafting table or furnace along left them behind and walked 88 blocks
      // back for a furnace (paid run L26).
      if (PROTECTED_UTILITY_BLOCKS.has(block.name) && takeEquipment !== true) {
        return {
          success: false,
          result: `${block.name}は設備なので通常は掘りません。自分が置いたものを持ち運ぶために回収するなら takeEquipment: true を指定してください`,
          failureType: 'protected_target',
          recoverable: true,
        };
      }

      // ブロックが掘れるかチェック
      if (block.diggable === false) {
        return {
          success: false,
          result: `${block.name}は掘れません（岩盤など）`,
          failureType: 'undiggable_block',
          recoverable: false,
        };
      }

      // A dear tool about to go on a block a cheaper one would take: the cheaper one is made first when the bag
      // allows (utils/toolStock). Before the reach check, since putting down a table may move the body.
      await keepCheapTool(this.bot as any, [block as any], (skill, ...args) => this.callSkill(skill, ...args));
      assertActionActive(this.bot);

      if (!canDigFromHere(this.bot, block, pos)) {
        return {
          success: false,
          result: 'ブロックは視点からの採掘可能距離外です。move-to の goalType="block" で手の届く立ち位置に移動してください',
          failureType: 'distance_too_far',
          recoverable: true,
        };
      }

      const footing = this.footingDrop(pos);
      if (footing !== null) {
        return {
          success: false,
          result: `${block.name}(${x}, ${y}, ${z})は、いま立っている足元を支えています。掘ると${Number.isFinite(footing) ? `${footing.toFixed(0)}ブロック下まで落ちます` : '溶岩か底の見えない所へ落ちます'}。`
            + '横の足場へ1歩ずれてから掘るか、stair-mine で階段状に掘り下げてください',
          failureType: 'unsafe_footing',
          recoverable: true,
        };
      }

      // 適切なツールを持っているかチェックし、装備する
      let durabilityWarning = '';
      if (block.harvestTools) {
        const toolIds = Object.keys(block.harvestTools).map(Number);
        const validTools = this.bot.inventory
          .items()
          .filter((item) => toolIds.includes(item.type));

        if (validTools.length === 0) {
          // No tool that yields the block. It can still be broken by hand, slowly and for nothing: wanted
          // for its drop, that is refused with the way to do it; wanted only gone (collect=false), it is dug.
          // "No suitable tool" and nothing else left a body in a stone pit with no way out (paid run L73).
          let seconds = 0;
          try { seconds = Math.round(Number(this.bot.digTime(block)) / 1000); } catch { seconds = 0; }
          if (collect) {
            return {
              success: false,
              result: `${block.name}を回収できる道具がありません。通り道を開けるだけなら、collect=false で素手でも掘れます`
                + `（${seconds > 0 ? `約${seconds}秒、` : ''}ブロックは手に入りません）`,
              failureType: 'missing_tool',
              recoverable: true,
            };
          }
          log.info(`✊ ${block.name}を素手で掘ります（${seconds > 0 ? `約${seconds}秒` : '時間は不明'}、回収なし）`);
        } else {
          // The cheapest in time and wear (utils/toolChoice): the iron pickaxe is not spent on stone.
          const tool = chooseTool(block, validTools, { requireHarvest: true, effects: this.bot.entity?.effects }) ?? validTools[0];

          // ツールを装備
          try {
            await this.bot.equip(tool, 'hand');
            log.info(`🔧 ${tool.name}を装備しました`);
          } catch (equipError: any) {
            log.error(`ツール装備エラー: ${equipError.message}`, equipError);
          }

          durabilityWarning = this.checkToolDurabilityWarning(tool);
        }
      } else {
        // harvestToolsがない場合でも、最適なツールを探して装備
        const bestTool = chooseTool(block, this.bot.inventory.items(), { effects: this.bot.entity?.effects });
        if (bestTool) {
          try {
            await this.bot.equip(bestTool, 'hand');
            log.info(`🔧 ${bestTool.name}を装備しました（効率化）`);
          } catch (equipError: any) {
            // 装備失敗しても続行（素手で掘れるブロックの場合）
          }
          durabilityWarning = this.checkToolDurabilityWarning(bestTool);
        }
      }

      const airShort = this.airShortFor(block);
      if (airShort) return { success: false, result: airShort, failureType: 'air_short', recoverable: true };

      // マグマ隣接安全チェック: 掘削後の空洞にマグマが流入する危険がないか
      const lavaDanger = this.checkLavaAdjacentDanger(pos);
      if (lavaDanger) {
        return {
          success: false,
          result: lavaDanger,
          failureType: 'lava_danger',
          recoverable: true,
        };
      }

      const blockName = block.name;

      // Wanted for what it drops: the drop has to survive the fall. Over lava it does not, unless water is
      // standing over the block when it breaks (see keepDropFromLava).
      let poured: Vec3 | null = null;
      if (collect || keepDrop === true) {
        const burn = dropBurnsIn(this.bot as any, pos);
        if (burn) {
          const tool = this.bot.heldItem;
          const prepared = await this.keepDropFromLava(block, burn);
          if ('refusal' in prepared) return prepared.refusal;
          poured = prepared.water;
          const again = tool ? this.bot.inventory.items().find(item => item.type === tool.type) : null;
          if (again) { try { await this.bot.equip(again, 'hand'); } catch { /* dug with what is held */ } }
        }
      }

      const equippedTool = this.bot.heldItem?.name ?? '素手';

      const beforeItems = inventoryCounts(this.bot);
      const beforeEntityIds = new Set(Object.values(this.bot.entities ?? {}).map(entity => entity.id));
      const expectedItems = expectedBlockDrops(this.bot, block);

      let digDurationMs: number;
      try {
        const digStart = Date.now();
        assertActionActive(this.bot);
        reportActionProgress(this.bot, 'dig', { target: pos.toArray(), block: blockName });
        await digBlockVerified(this.bot, block);
        digDurationMs = Date.now() - digStart;
      } catch (digError: any) {
        await this.takeWaterBack(poured);
        assertActionActive(this.bot);
        if (digError instanceof ServerDigUnconfirmedError) {
          return { success: false, result: digError.message, failureType: digError.failureType, recoverable: true };
        }
        if (digError instanceof LavaReleaseError) {
          return { success: false, result: digError.message, failureType: digError.failureType, recoverable: true };
        }
        if (digError instanceof ThreatExposedError) {
          return { success: false, result: digError.message, failureType: digError.failureType, recoverable: true };
        }
        // 掘削失敗 → LOS遮蔽が原因かを診断
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        return { success: false, result: `掘削エラー: ${digError.message}`, failureType: 'dig_failed', recoverable: true };
      }

      reportActionProgress(this.bot, 'confirm', { target: pos.toArray(), block: blockName }, true);
      await waitForObservation(this.bot, () => this.bot.blockAt(pos)?.name !== blockName, 1000,
        [{ source: this.bot as unknown as ObservationSource, event: 'blockUpdate' }]);
      const afterBlock = this.bot.blockAt(pos);
      if (poured) {
        // The water falls into the opening and hardens the lava under it; then it is taken back.
        const under = pos.offset(0, -1, 0);
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && this.bot.blockAt(under)?.name === 'lava') await actionDelay(this.bot, 100);
        await this.takeWaterBack(poured);
      }

      if (afterBlock && afterBlock.name !== 'air' && afterBlock.name !== 'cave_air' && afterBlock.name === blockName) {
        return {
          success: false,
          result: `${blockName}を掘れませんでした（まだ存在しています）。適切なツールが必要かもしれません`,
          failureType: 'dig_failed',
          recoverable: true,
        };
      }

      // 掘削が遅い場合の警告（適切なツールを使っていない可能性）
      const SLOW_DIG_THRESHOLD_MS = 5000;
      const slowWarning = digDurationMs > SLOW_DIG_THRESHOLD_MS
        ? ` ⚠️ 掘削に${(digDurationMs / 1000).toFixed(1)}秒かかりました（使用: ${equippedTool}）。適切なツール（ツルハシ等）を装備すれば大幅に高速化できます`
        : '';

      if (digDurationMs > SLOW_DIG_THRESHOLD_MS) {
        log.warn(`⚠️ 掘削が遅い: ${blockName} を ${equippedTool} で ${(digDurationMs / 1000).toFixed(1)}秒`);
      }

      const left = this.waterLeftAt as Vec3 | null; // set by takeWaterBack during this run
      const waterWarning = left
        ? ` ⚠️ ドロップを溶岩から守るために置いた水(${left.x}, ${left.y}, ${left.z})をバケツへ戻せませんでした（バケツは空です）。その水源を use-item-on-block（bucket）で汲み直してください`
        : '';
      const warnings = [slowWarning, durabilityWarning, waterWarning].filter(Boolean).join('');

      // インベントリに空きがない場合は回収を試みない
      const noEmptySlots = typeof this.bot.inventory.emptySlotCount === 'function'
        && this.bot.inventory.emptySlotCount() === 0;

      if (!collect || noEmptySlots) {
        const note = noEmptySlots && collect
          ? '（インベントリ満杯のため回収スキップ — pickup-nearest-item で後から回収可能）'
          : '（回収スキップ）';
        return {
          success: true,
          result: `${blockName}を掘りました${note}${warnings}`,
        };
      }

      const collected = await collectDrops(this.bot, { origins: [pos], expectedItems,
        beforeInventory: beforeItems, beforeEntityIds, policy: collectionPolicy });

      if (collected.length > 0) {
        return {
          success: true,
          result: `${blockName}を掘りました。${collected.join(', ')}を回収${warnings}`,
        };
      }

      return {
        success: true,
        result: `${blockName}を掘りました（ドロップ未回収 — 壁越しまたは消失の可能性）${warnings}`,
      };
    } catch (error: any) {
      // エラーメッセージを詳細化
      let errorDetail = error.message;
      if (error.message.includes('far away')) {
        errorDetail = 'ブロックが遠すぎます';
      } else if (error.message.includes("can't dig")) {
        errorDetail = 'このブロックは掘れません';
      } else if (error.message.includes('interrupted') || error.message.includes('aborted')) {
        errorDetail = '採掘が中断されました（パスファインダーとの競合の可能性）';
      }

      return {
        success: false,
        result: `掘削エラー: ${errorDetail}`,
        failureType: error.message.includes('far away')
          ? 'distance_too_far'
          : error.message.includes("can't dig")
            ? 'undiggable_block'
            : error.message.includes('interrupted') || error.message.includes('aborted')
              ? 'interrupted'
              : 'dig_failed',
        recoverable:
          error.message.includes('far away') ||
          error.message.includes('interrupted') ||
          error.message.includes('aborted'),
      };
    }
  }

  private getToolDurabilityRemaining(item: any): number {
    const max = item.maxDurability;
    const used = item.durabilityUsed;
    if (max != null && max > 0 && used != null && used >= 0) {
      return Math.max(0, max - used);
    }
    return Infinity;
  }

  /** 装備中のツールの耐久が危険水準なら警告文を返す */
  private checkToolDurabilityWarning(tool: any): string {
    const LOW_DURABILITY_WARN = 10;
    const remaining = this.getToolDurabilityRemaining(tool);
    if (remaining !== Infinity && remaining <= LOW_DURABILITY_WARN) {
      return ` ⚠️ ${tool.name}の残り耐久が${remaining}です。もうすぐ壊れます。予備のツールを craft-one でクラフトしてください`;
    }
    return '';
  }


  /**
   * Makes the drop of a block over lava one that can be picked up, as a person with a bucket of water does:
   * water is put on top of the block, the block is broken under it, and the water falls into the opening and
   * turns the lava beneath (and any beside it) to stone before the drop reaches it. The water spreads over
   * the ground at the level it was put, and a body standing in it is carried off at walking pace for the
   * nine seconds obsidian takes; so the body first stands a block above that level (one block placed under
   * its feet when it is not already higher). Returns where the water was put, to be taken back after.
   */
  private async keepDropFromLava(block: any, burn: Vec3): Promise<{ water: Vec3 | null } | { refusal: { success: false; result: string; failureType: string; recoverable: boolean } }> {
    const pos: Vec3 = block.position;
    const over = pos.offset(0, 1, 0);
    const refuse = (why: string, failureType = 'drop_would_burn') => ({ refusal: { success: false as const, failureType, recoverable: true,
      result: `${block.name}(${pos.x}, ${pos.y}, ${pos.z})を掘ると、ドロップが溶岩(${burn.x}, ${burn.y}, ${burn.z})で焼けて手に入りません。${why}` } });
    const directlyUnder = burn.x === pos.x && burn.z === pos.z && burn.y === pos.y - 1;
    if (burn.y === pos.y + 1) return refuse('溶岩がブロックの真上にあります。先にその溶岩を水で固めてください');
    if (burn.y < pos.y && !directlyUnder) {
      return refuse('溶岩はブロックの真下ではなく、落ちた先にあります（水で受け止められません）。下に溶岩の無い同じブロックを選ぶか、ドロップが不要なら collect=false で掘ってください');
    }
    const top = this.bot.blockAt(over);
    const wet = holdsWater(top);
    if (!wet && (!top || top.boundingBox === 'block')) return refuse('ブロックの上が塞がっていて水を置けません。上のブロックを先に除いてください');
    if (!wet && !this.bot.inventory.items().some(item => item.name === 'water_bucket')) {
      return refuse('水バケツ(water_bucket)を持っていれば、ブロックの上に水を置いてから掘ることで、開いた穴に水が落ちて溶岩を固め、ドロップを回収できます（持っていれば自動で行います）。'
        + 'ドロップが不要なら collect=false で掘れます');
    }
    // Above the level the water will spread at.
    const feetY = Math.floor(this.bot.entity.position.y + 0.001);
    const rise = over.y + 1 - feetY;
    if (rise > 2) return refuse('身体がブロックより低い位置にいます。ブロックより高い位置から掘ってください');
    if (rise > 0) {
      // Standing still first: asked while the body was still stepping down from collecting the last drop,
      // the foothold had nothing under it to be placed on.
      const settled = Date.now() + 1500;
      while (Date.now() < settled && !this.bot.entity.onGround) await actionDelay(this.bot, 50);
      const towerUp = this.bot.instantSkills.getSkill('tower-up');
      const raised = towerUp ? await towerUp.run(rise) : { success: false, result: 'tower-up がありません' };
      if (!raised.success) return refuse(`水に流されない高さ（ブロックの2段上）へ上がれませんでした: ${raised.result}`);
    }
    if (!canDigFromHere(this.bot, block, pos)) {
      return refuse('足場へ上がるとブロックに手が届きません。もっと近く（2ブロック以内）へ寄ってからやり直してください', 'distance_too_far');
    }
    if (wet) return { water: null };
    const bucket = this.bot.inventory.items().find(item => item.name === 'water_bucket');
    try {
      await this.bot.equip(bucket!, 'hand');
      await activateItemFacing(this.bot, pos.offset(0.5, 1, 0.5));
    } catch { /* judged by the water itself */ }
    const placedBy = Date.now() + 1500;
    while (Date.now() < placedBy && !holdsWater(this.bot.blockAt(over))) await actionDelay(this.bot, 100);
    if (!holdsWater(this.bot.blockAt(over))) return refuse('ブロックの上に水を置けませんでした（上面が見える位置から、もう一度試してください）', 'placement_unconfirmed');
    log.info(`💧 ${block.name}(${pos.x},${pos.y},${pos.z})の上に水を置いた（溶岩(${burn.x},${burn.y},${burn.z})にドロップを取られないように）`);
    // Lava beside the block is reached by the water spreading over it, a cell every quarter second.
    const spreadBy = Date.now() + 2500;
    while (Date.now() < spreadBy && lavaBesideOrOver(this.bot as any, pos)) await actionDelay(this.bot, 100);
    if (lavaBesideOrOver(this.bot as any, pos)) {
      await this.takeWaterBack(over);
      return refuse('横の溶岩に水が届かず固まりませんでした。先に use-item-on-block（water_bucket）で横の溶岩を固めてください');
    }
    return { water: over };
  }

  /**
   * A dig started with the head under water has to end before the air does. Under water a block takes five
   * times as long, and five times again for a body that floats; an order for obsidian went on under water
   * until the air was half gone and the drowning emergency took the body, twice (paid run L77). The time is
   * the body's own measure for this block with what it holds, where it is. Not asked of a reflex digging its
   * way to air: that one has no other way and counts its seconds itself.
   */
  private airShortFor(block: any): string | null {
    if ((currentAction(this.bot)?.priority ?? 0) > 0) return null;
    const eyes = eyeCell(this.bot as any);
    if (!eyes || !holdsWater(this.bot.blockAt(eyes))) return null;
    const oxygen = (this.bot as any).oxygenLevel;
    if (typeof oxygen !== 'number') return null;
    let digMs = 0;
    try { digMs = Number(this.bot.digTime(block)) || 0; } catch { digMs = 0; }
    const airMs = Math.max(0, oxygen) * 750;
    if (digMs + 3000 <= airMs) return null;
    return `頭が水の中にあり、${block.name}を掘り終える前に息が切れます（掘るのに約${Math.ceil(digMs / 1000)}秒。水中や浮いた状態では遅くなる。空気は約${Math.floor(airMs / 1000)}秒分）。`
      + '水の外に立ってから掘ってください（leave-water、または足場を置いて水面より上に立つ）';
  }

  /** Where water this dig poured is still standing because it could not be taken back: said in the result. */
  private waterLeftAt: Vec3 | null = null;

  /** Scoops the water put over a block back into the bucket. */
  private async takeWaterBack(water: Vec3 | null): Promise<void> {
    if (!water) return;
    const held = (): string | undefined => this.bot.heldItem?.name;
    // Each point of the source the eyes can see, in turn. Looked at through its centre only, a source seen
    // from a pocket dug into the ceiling lay behind the ceiling's edge: the water was left standing, the body
    // walked into it for the drop and was carried off, and the next path laid a block in the source (paid run L77).
    const visible = liquidAimPoints(this.bot, water).points;
    for (const point of visible.length ? visible.slice(0, 5) : [water.offset(0.5, 0.5, 0.5)]) {
      if (!holdsWater(this.bot.blockAt(water))) return;
      const bucket = this.bot.inventory.items().find(item => item.name === 'bucket');
      if (!bucket) return;
      try {
        await this.bot.equip(bucket, 'hand');
        await activateItemFacing(this.bot, point);
      } catch { /* judged by what is held */ }
      const deadline = Date.now() + 800;
      while (Date.now() < deadline && held() !== 'water_bucket') await actionDelay(this.bot, 100);
      if (held() === 'water_bucket') return;
    }
    this.waterLeftAt = water;
    log.warn(`⚠ 置いた水(${water.x},${water.y},${water.z})をバケツへ戻せなかった（見える点: ${visible.length}）`);
  }

  /**
   * Whether breaking the block would bring lava onto the body, by the rule every dig is held to
   * (`lavaReleasedBy`): lava over or beside the block at the level of the feet or above, or under the block
   * the body stands on. This skill used to refuse any block with lava on any of its six sides, the one
   * under it included. Lava does not rise: the block over a lava source is the one a person takes off to
   * pour water onto it, and a planner with a bucket of water beside a covered source was refused that
   * block twice and left without obsidian (paid run L68).
   */
  private checkLavaAdjacentDanger(targetPos: Vec3): string | null {
    const lava = lavaReleasedBy(this.bot as any, targetPos);
    if (!lava) return null;
    return `⚠️ 危険: このブロック(${targetPos.x},${targetPos.y},${targetPos.z})を掘ると、隣の溶岩(${lava.x},${lava.y},${lava.z})が身体のいる場所へ流れ込みます。`
      + `別の方向から掘るか、先に溶岩を丸石などで塞ぐか、水をかけて固めてください（溶岩源は、水が流れ込むと黒曜石になる）。`;
  }
}

export default DigBlockAt;
