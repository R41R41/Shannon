import { Vec3 } from 'vec3';
import { chooseTool } from '../utils/toolChoice.js';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { digBlockVerified } from '../utils/digBlockVerified.js';
import { LavaReleaseError } from '../utils/lavaSafety.js';
import { ThreatExposedError } from '../utils/exposureGuard.js';
import { actionDelay } from '../execution/observedWait.js';
import { holdsWater } from '../utils/waterBlocks.js';

const log = createLogger('Minebot:Skill:towerUp');

const PLACEABLE_BLOCKS = [
  'cobblestone', 'dirt', 'stone', 'netherrack',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
  'acacia_planks', 'dark_oak_planks', 'mangrove_planks',
  'deepslate', 'cobbled_deepslate', 'sandstone', 'andesite',
  'diorite', 'granite', 'tuff', 'sand', 'gravel',
];

function isEmptyBlock(block: any): boolean {
  return !block || block.boundingBox === 'empty';
}

const isWater = (block: any) => holdsWater(block);

/**
 * 原子的スキル: 直上登り（タワー）
 * ジャンプしながら足元にブロックを設置して垂直に登る。
 */
class TowerUp extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'tower-up';
    this.description = '真上に登ります（直上掘り対応）。頭上にブロックがあれば自動で掘削してから登るため、地下から地上へ垂直に脱出する「直上掘り」にも使えます。'
      + '水中では泳ぎ上がりながら足元の水にブロックを置き、水面の上まで足場を積んで脱出できます。高さ1〜20を指定。';
    this.params = [
      {
        name: 'height',
        type: 'number',
        description: '登るブロック数（1〜20、デフォルト1）',
        required: false,
        default: 1,
      },
      {
        name: 'blockName',
        type: 'string',
        description: '使用するブロック名（省略時はインベントリから自動選択）',
        required: false,
      },
    ];
  }

  async runImpl(height?: number, blockName?: string) {
    const targetHeight = Math.max(1, Math.min(20, Math.round(height ?? 1)));
    log.info(`🗼 直上登り開始: 高さ ${targetHeight}ブロック`);

    const item = blockName
      ? this.bot.inventory.items().find(i => i.name === blockName)
      : this.bot.inventory.items().find(i => PLACEABLE_BLOCKS.includes(i.name));

    if (!item) {
      return {
        success: false,
        result: `インベントリに設置可能なブロックがありません。${blockName ? `${blockName}を入手してください。` : `必要: ${PLACEABLE_BLOCKS.slice(0, 5).join(', ')} など`}`,
        failureType: 'missing_item',
        recoverable: true,
      };
    }

    const available = this.bot.inventory.items()
      .filter(i => blockName ? i.name === blockName : PLACEABLE_BLOCKS.includes(i.name))
      .reduce((total, stack) => total + stack.count, 0);
    if (available < targetHeight) {
      return {
        success: false,
        result: `${blockName ?? '設置可能なブロック'} が合計${available}個しかなく、高さ${targetHeight}には足りません`,
        failureType: 'missing_item',
        recoverable: true,
      };
    }

    try {
      await this.bot.equip(item, 'hand');
    } catch (e) {
      return {
        success: false,
        result: `ブロック(${item.name})の装備に失敗: ${e instanceof Error ? e.message : e}`,
        failureType: 'equip_failed',
        recoverable: true,
      };
    }

    const startY = Math.floor(this.bot.entity.position.y);
    log.info(`直上登り開始位置: feet=${this.bot.entity.position.toArray().map(n => n.toFixed(3)).join(',')}` +
      ` velocity=${this.bot.entity.velocity.toArray().map(n => n.toFixed(3)).join(',')}` +
      ` controls=${['forward', 'back', 'left', 'right', 'jump']
        .filter(name => this.bot.getControlState(name as any)).join(',') || 'none'}` +
      ` pathfinderGoal=${!!(this.bot.pathfinder as typeof this.bot.pathfinder & { goal?: unknown }).goal}` +
      ` moving=${this.bot.pathfinder.isMoving()}`);
    let placed = 0;

    for (let step = 0; step < targetHeight; step++) {
      if (this.shouldInterrupt()) break;

      // 設置用ブロックを装備し直す（掘削後にツールのままになっている可能性）
      const currentItem = this.bot.inventory.items().find(i => i.name === item.name);
      if (!currentItem) {
        const alt = this.bot.inventory.items().find(i => PLACEABLE_BLOCKS.includes(i.name));
        if (!alt) {
          log.warn(`⚠ 設置用ブロックが尽きた: ${placed}/${targetHeight}`);
          break;
        }
        try { await this.bot.equip(alt, 'hand'); } catch { /* ignore */ }
      } else if (this.bot.heldItem?.name !== currentItem.name) {
        try { await this.bot.equip(currentItem, 'hand'); } catch { /* ignore */ }
      }

      const ok = await this.tryTowerOneBlock();
      if (!ok) {
        log.warn(`⚠ 直上登り: ステップ ${step + 1}/${targetHeight} 失敗`);
        // Stopped by what is overhead rather than by a failed placement: say so, whatever the height reached.
        if (this.overheadRefusal) {
          const reason = this.overheadRefusal;
          this.overheadRefusal = null;
          return {
            success: false,
            result: `直上登りを${placed}段で中止（現在Y=${Math.floor(this.bot.entity.position.y)}）。${reason}`,
            failureType: this.overheadRefusalType,
            recoverable: true,
          };
        }
        if (placed === 0) {
          return {
            success: false,
            result: `直上登り失敗: 1ブロック目に失敗（現在Y=${Math.floor(this.bot.entity.position.y)}）。頭上に掘削不可のブロックがあるか、設置用ブロックが不足している可能性`,
            failureType: 'place_failed',
            recoverable: true,
          };
        }
        break;
      }
      placed++;

      if (step + 1 < targetHeight) {
        await actionDelay(this.bot, 150);
      }
    }

    const finalY = Math.floor(this.bot.entity.position.y);
    const actualRise = finalY - startY;
    const pos = this.bot.entity.position;
    const posStr = `(${Math.floor(pos.x)}, ${finalY}, ${Math.floor(pos.z)})`;

    if (placed === targetHeight) {
      return {
        success: true,
        result: `直上登り完了: ${placed}ブロック上昇（Y: ${startY} → ${finalY}）現在位置: ${posStr}`,
      };
    }

    return {
      success: placed > 0,
      result: `直上登り: ${placed}/${targetHeight}ブロック設置成功（Y: ${startY} → ${finalY}）現在位置: ${posStr}。残り${targetHeight - placed}ブロックは失敗しました。`,
      failureType: placed === 0 ? 'place_failed' : undefined,
      recoverable: true,
    };
  }

  private static readonly DANGEROUS_BLOCKS = new Set([
    'water', 'flowing_water', 'lava', 'flowing_lava',
  ]);
  private static readonly GRAVITY_BLOCKS = new Set([
    'sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel',
    'anvil', 'chipped_anvil', 'damaged_anvil',
    'dragon_egg', 'pointed_dripstone',
  ]);

  /**
   * 頭上のブロックを掘る（ジャンプ前に空間を確保する）。
   * 掘る前にその上のブロックが危険（水・溶岩）や落下ブロック（砂・砂利）でないか確認する。
   */
  /** Why the last overhead dig was refused (lava it would have let down), for the result. */
  private overheadRefusal: string | null = null;
  private overheadRefusalType = 'lava_adjacent';

  private async clearAbove(): Promise<boolean> {
    const pos = this.bot.entity.position;
    // +2 = ジャンプ時の頭の位置、+3 = その上（着地時の頭の位置）
    for (const dy of [2, 3]) {
      const block = this.bot.blockAt(pos.offset(0, dy, 0));
      if (!block) continue;

      // Already swimming: water overhead is the way up, not a hazard.
      const swimming = !!(this.bot.entity as any).isInWater;
      if (swimming && isWater(block)) continue;
      // そのブロック自体が液体なら中断
      if (TowerUp.DANGEROUS_BLOCKS.has(block.name)) {
        log.warn(`⚠ 頭上に ${block.name}(Y=${block.position.y}) — 直上掘り中断`);
        return false;
      }

      // 空気・草・花・松明など当たり判定のないブロックはスキップ
      if (isEmptyBlock(block)) continue;

      if (!block.diggable || PROTECTED_UTILITY_BLOCKS.has(block.name)) {
        log.warn(`⚠ 頭上の ${block.name}(Y=${block.position.y}) は${PROTECTED_UTILITY_BLOCKS.has(block.name) ? '保護対象' : '掘削不可'}`);
        return false;
      }

      // 掘った後に上から流れてくるもの・落ちてくるものをチェック
      const above = this.bot.blockAt(pos.offset(0, dy + 1, 0));
      if (above) {
        if (TowerUp.DANGEROUS_BLOCKS.has(above.name) && !(swimming && isWater(above))) {
          log.warn(`⚠ ${block.name}(Y=${block.position.y}) の上に ${above.name} — 掘ると流入するため中断`);
          return false;
        }
        if (TowerUp.GRAVITY_BLOCKS.has(above.name)) {
          log.warn(`⚠ ${block.name}(Y=${block.position.y}) の上に ${above.name} — 掘ると落下するため中断`);
          return false;
        }
      }

      log.info(`⛏️ 頭上の ${block.name}(Y=${block.position.y}) を掘削`);

      const tool = this.findBestToolForBlock(block);
      if (tool) {
        try { await this.bot.equip(tool, 'hand'); } catch { /* ignore */ }
      }

      try {
        await digBlockVerified(this.bot, block);
      } catch (e) {
        log.warn(`⚠ 頭上ブロック掘削失敗: ${e instanceof Error ? e.message : e}`);
        if (e instanceof LavaReleaseError || e instanceof ThreatExposedError) { this.overheadRefusal = e.message; this.overheadRefusalType = e.failureType; }
        return false;
      }

      // A falling block or liquid can fill the cell after the original block
      // was broken. Do not jump into a newly occupied or hazardous headspace.
      const afterDig = this.bot.blockAt(block.position);
      if (!afterDig || !isEmptyBlock(afterDig) || (TowerUp.DANGEROUS_BLOCKS.has(afterDig.name) && !(swimming && isWater(afterDig)))) {
        log.warn(`⚠ 頭上の掘削後も ${afterDig?.name ?? 'unknown'} が占有または危険`);
        return false;
      }

      // 掘った後に設置用ブロックを再装備
      const placeItem = this.bot.inventory.items().find(i => PLACEABLE_BLOCKS.includes(i.name));
      if (placeItem) {
        try { await this.bot.equip(placeItem, 'hand'); } catch { /* ignore */ }
      }
    }
    return true;
  }

  private findBestToolForBlock(block: any): any {
    // Cheapest in time and wear (utils/toolChoice): not the best pickaxe in the bag for a bit of stone overhead.
    return chooseTool(block, this.bot.inventory.items(), { effects: this.bot.entity?.effects });
  }

  /**
   * In water a jump only floats the feet to the surface, short of the last
   * flooded cell. Pushing forward into a solid wall gives the vanilla
   * out-of-liquid impulse, which lifts the feet clear (a live flooded-shaft
   * climb stalled one block below the rim without it).
   */
  private async pushAgainstWall(): Promise<boolean> {
    // Only at the surface: pushing a wall while submerged slowed the swim up
    // (vy 0.1 -> 0.03) and no jump window rose a full block.
    const eyes = this.bot.blockAt(this.bot.entity.position.offset(0, 1.62, 0));
    if (!(this.bot.entity as any).isInWater || isWater(eyes)) {
      this.bot.setControlState('forward', false);
      return false;
    }
    const feet = this.bot.entity.position.floored();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const side = this.bot.blockAt(feet.offset(dx, 0, dz));
      if (!side || side.boundingBox !== 'block') continue;
      await this.bot.look(Math.atan2(-dx, -dz), 0, true);
      this.bot.setControlState('forward', true);
      return true;
    }
    return false;
  }

  /**
   * 1ブロック分の直上登り: jump → apex付近で足元にplaceBlock
   * 成功なら true、失敗なら false
   */
  private async tryTowerOneBlock(): Promise<boolean> {
    // 頭上にブロックがあれば先に掘る
    if (!await this.clearAbove()) return false;

    let below = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    if (isWater(below) && (this.bot.entity as any).isInWater) {
      // Floating at the surface of a deep column: let go and sink onto the floor first.
      this.bot.setControlState('jump', false);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !this.shouldInterrupt()
        && isWater(this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0)))
        && isWater(this.bot.blockAt(this.bot.entity.position.offset(0, -2, 0)))) await actionDelay(this.bot, 100);
      below = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    }
    if (isWater(below) && (this.bot.entity as any).isInWater) {
      // Floating over a flooded cell: fill it from the floor beneath, then climb from there.
      const floor = this.bot.blockAt(below!.position.offset(0, -1, 0));
      if (floor && !isEmptyBlock(floor)) {
        try {
          await this.bot.placeBlock(floor, new Vec3(0, 1, 0));
          below = this.bot.blockAt(below!.position);
        } catch (error) {
          log.warn(`⚠ 足元の水(Y=${below!.position.y})に設置できません: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    if (!below || isEmptyBlock(below)) {
      log.warn(`⚠ 足元にブロックがありません（Y=${Math.floor(this.bot.entity.position.y)}）`);
      return false;
    }

    const minFeetY = below.position.y + 1 + 0.26;
    const observations = {
      maxFeetY: this.bot.entity.position.y,
      jumpWindows: 0,
      emptyPlacementCells: 0,
      supportCells: 0,
      placeAttempts: 0,
      firstPlaceError: '',
      lastPlaceError: '',
    };
    const recordPlaceError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!observations.firstPlaceError) observations.firstPlaceError = message;
      observations.lastPlaceError = message;
    };
    const logPlacementWindow = (reference: any) => {
      const feet = this.bot.entity.position;
      const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
        .filter(name => this.bot.getControlState(name as any)).join(',') || 'none';
      log.info(`直上登り設置試行: feet=${feet.toArray().map(n => n.toFixed(3)).join(',')}` +
        ` vy=${this.bot.entity.velocity.y.toFixed(3)} onGround=${this.bot.entity.onGround}` +
        ` ref=${reference.name}@${reference.position.toArray().join(',')}` +
        ` dest=${reference.position.offset(0, 1, 0).toArray().join(',')}` +
        ` held=${this.bot.heldItem?.name ?? 'none'} controls=${controls}` +
        ` pathfinderGoal=${!!(this.bot.pathfinder as typeof this.bot.pathfinder & { goal?: unknown }).goal}` +
        ` moving=${this.bot.pathfinder.isMoving()}`);
    };

    this.bot.setControlState('jump', true);
    const swimming = !!(this.bot.entity as any).isInWater;
    let wallPush = await this.pushAgainstWall();

    let placed = false;
    // Swimming up a block takes about a second; a jump on land a quarter of that.
    const maxAttempts = swimming ? 70 : 28;
    const retryMs = 35;

    for (let i = 0; i < maxAttempts && !placed; i++) {
      await actionDelay(this.bot, retryMs);

      // Placement aims down at the floor; turn back to the wall to keep the impulse.
      if (swimming && i > 0) wallPush = await this.pushAgainstWall();
      const y = this.bot.entity.position.y;
      const vy = this.bot.entity.velocity.y;
      observations.maxFeetY = Math.max(observations.maxFeetY, y);

      if (y < minFeetY) continue;
      if ((vy > 0.14 && !wallPush) || vy < -0.45) continue;
      observations.jumpWindows++;

      const blockToPlaceOn = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
      if (!blockToPlaceOn || !isEmptyBlock(blockToPlaceOn)) {
        continue;
      }
      observations.emptyPlacementCells++;

      const refBlock = this.bot.blockAt(this.bot.entity.position.offset(0, -2, 0));
      if (!refBlock || isEmptyBlock(refBlock)) continue;
      observations.supportCells++;

      try {
        if (observations.placeAttempts === 0) logPlacementWindow(refBlock);
        observations.placeAttempts++;
        await this.bot.placeBlock(refBlock, new Vec3(0, 1, 0));
        placed = true;
      } catch (error) {
        recordPlaceError(error);
        /* retry next tick */
      }
    }

    this.bot.setControlState('jump', false);
    if (swimming) this.bot.setControlState('forward', false);

    if (!placed) {
      await actionDelay(this.bot, 300);

      const belowRetry = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
      if (!belowRetry || isEmptyBlock(belowRetry)) return false;

      const minFeetYRetry = belowRetry.position.y + 1 + 0.26;

      const itemNow = this.bot.inventory.items().find(i => PLACEABLE_BLOCKS.includes(i.name));
      if (itemNow) {
        try { await this.bot.equip(itemNow, 'hand'); } catch { /* ignore */ }
      }

      this.bot.setControlState('jump', true);
      let wallPushRetry = await this.pushAgainstWall();
      for (let j = 0; j < maxAttempts && !placed; j++) {
        if (swimming && j > 0) wallPushRetry = await this.pushAgainstWall();
        await actionDelay(this.bot, retryMs);
        const y2 = this.bot.entity.position.y;
        const vy2 = this.bot.entity.velocity.y;
        observations.maxFeetY = Math.max(observations.maxFeetY, y2);
        if (y2 < minFeetYRetry || (vy2 > 0.14 && !wallPushRetry) || vy2 < -0.45) continue;
        observations.jumpWindows++;

        const blockToPlaceOn2 = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
        if (!blockToPlaceOn2 || !isEmptyBlock(blockToPlaceOn2)) continue;
        observations.emptyPlacementCells++;

        const refBlock2 = this.bot.blockAt(this.bot.entity.position.offset(0, -2, 0));
        if (!refBlock2 || isEmptyBlock(refBlock2)) continue;
        observations.supportCells++;

        try {
          if (observations.placeAttempts === 0) logPlacementWindow(refBlock2);
          observations.placeAttempts++;
          await this.bot.placeBlock(refBlock2, new Vec3(0, 1, 0));
          placed = true;
        } catch (error) { recordPlaceError(error); /* retry */ }
      }
      this.bot.setControlState('jump', false);
      if (swimming) this.bot.setControlState('forward', false);
    }

    if (placed) {
      await actionDelay(this.bot, 200);
    } else {
      const feet = this.bot.entity.position;
      const underfoot = this.bot.blockAt(feet.offset(0, -1, 0));
      const placement = this.bot.blockAt(new Vec3(Math.floor(feet.x), below.position.y + 1, Math.floor(feet.z)));
      log.warn(`直上登り1段失敗: feet=${feet.toArray().map(n => n.toFixed(2)).join(',')}` +
        ` vy=${this.bot.entity.velocity.y.toFixed(3)} held=${this.bot.heldItem?.name ?? 'none'}` +
        ` maxY=${observations.maxFeetY.toFixed(2)} jumpWindows=${observations.jumpWindows}` +
        ` emptyCells=${observations.emptyPlacementCells} supportCells=${observations.supportCells}` +
        ` placeAttempts=${observations.placeAttempts} underfoot=${underfoot?.name ?? 'unknown'}` +
        ` placement=${placement?.name ?? 'unknown'}` +
        (observations.firstPlaceError ? ` firstError=${observations.firstPlaceError}` : '') +
        (observations.lastPlaceError && observations.lastPlaceError !== observations.firstPlaceError
          ? ` lastError=${observations.lastPlaceError}` : ''));
    }

    return placed;
  }
}

export default TowerUp;
