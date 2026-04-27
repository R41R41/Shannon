import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import {
  findDragon, getDragonPhaseName, isDragonFlying, isDragonApproaching,
  isDragonInPerchSequence, isDragonPerched, estimateHeadPosition, getDragonTailSafePos,
  findFountainTop, findBedItem, countBeds, equipDigTool,
  FOUNTAIN_CENTER_X, FOUNTAIN_CENTER_Z, REPLACEABLE_BLOCKS,
  HEAD_BLAST_RANGE,
} from '../utils/endDragonUtils.js';
import type { SkillResult } from '../types/skillParams.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:bedBombCycle');

const HP_RETREAT_THRESHOLD = 8;
const HP_CRITICAL_THRESHOLD = 4;
const BOMB_CYCLE_DELAY_MS = 150;
const RAPID_BOMB_DELAY_MS = 50;
const HEAD_TRACK_INTERVAL_MS = 100;
const FOUNTAIN_TETHER_RADIUS = 6;

const MELEE_ATTACK_REACH = 4.5;
const MELEE_TAIL_DIST = 4;
const MELEE_REPOSITION_MS = 4_000;
const FIRE_CLEAR_RADIUS = 6;

const HEAD_PREDICT_MAX_CURRENT_DIST = 6;

class BedBombCycle extends InstantSkill {
  private fountainTopY = 0;
  private meleeAttacks = 0;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'bed-bomb-cycle';
    this.description =
      'エンドラ戦闘の統合スキル。飛行中は待機、降下中はベッド爆弾、着地中は自動で尻側に回り込んで近接攻撃。フェーズ遷移を全て内部で処理します。';
    this.maxDurationMs = 300_000;
    this.params = [
      {
        name: 'maxBeds',
        type: 'number',
        description: '使用するベッドの最大数（デフォルト: 10）',
        required: false,
        default: 10,
      },
    ];
  }

  async runImpl(maxBeds: number = 10): Promise<SkillResult> {
    try {
      (this.bot as any)._bedBombActive = true;
      this.meleeAttacks = 0;

      if (this.bot.game.dimension !== 'the_end') {
        return { success: false, result: 'エンド次元にいません。' };
      }

      const dragon = findDragon(this.bot);
      if (!dragon) {
        return { success: true, result: 'エンダードラゴンが見つかりません。既に撃破済みです。' };
      }

      this.fountainTopY = findFountainTop(this.bot);
      if (this.fountainTopY === 0) {
        return { success: false, result: '噴水が見つかりません。', failureType: 'no_fountain' };
      }

      let bedsUsed = 0;
      const bedLimit = Math.min(maxBeds, countBeds(this.bot));
      let bombCycles = 0;
      const MAX_BOMB_CYCLES = 20;

      // ════════════════════════════════════════════
      //  メインループ: フェーズに応じて自動切り替え
      // ════════════════════════════════════════════
      while (!this.shouldInterrupt()) {
        const d = findDragon(this.bot);
        if (!d) {
          return this.resultDragonDead(bedsUsed);
        }

        if (this.bot.health < HP_CRITICAL_THRESHOLD) {
          return {
            success: bedsUsed > 0 || this.meleeAttacks > 0,
            result: `HP危険 (${this.bot.health.toFixed(1)})。ベッド${bedsUsed}個使用、近接${this.meleeAttacks}回攻撃。`,
            failureType: 'hp_critical',
          };
        }

        // ── A. ドラゴン飛行中 → 噴水付近で待機 ──
        if (isDragonFlying(d, this.fountainTopY)) {
          log.info('🛏️ [PHASE] 飛行中 → 待機...');
          const waitResult = await this.waitForPhaseChange();
          if (waitResult === 'interrupted') {
            return this.resultInterrupted(bedsUsed);
          }
          if (waitResult === 'dragon_gone') {
            return this.resultDragonDead(bedsUsed);
          }
          continue;
        }

        // ── B. ドラゴン着地中 → 近接攻撃 ──
        if (isDragonPerched(d)) {
          log.info(`🛏️ [PHASE] 着地中 (${getDragonPhaseName(d)}) → 近接攻撃`);
          const meleeResult = await this.meleePhase();
          if (meleeResult === 'dragon_gone') {
            return this.resultDragonDead(bedsUsed);
          }
          if (meleeResult === 'interrupted') {
            return this.resultInterrupted(bedsUsed);
          }
          // dragon_flew_away → ループ先頭に戻って飛行待機
          continue;
        }

        // ── C. 降下/パーチシーケンス中 → ベッド爆弾 ──
        if (bedsUsed >= bedLimit || !findBedItem(this.bot)) {
          log.info('🛏️ [PHASE] ベッドなし/上限到達 → 近接攻撃にフォールバック');
          const meleeResult = await this.meleePhase();
          if (meleeResult === 'dragon_gone') return this.resultDragonDead(bedsUsed);
          if (meleeResult === 'interrupted') return this.resultInterrupted(bedsUsed);
          continue;
        }

        bombCycles++;
        if (bombCycles > MAX_BOMB_CYCLES) {
          log.warn('🛏️ 爆弾サイクル上限到達');
          break;
        }

        log.info(`🛏️ [PHASE] 降下/パーチ中 → ベッド爆弾 #${bombCycles}`);
        const cycleResult = await this.attackCycle(bedLimit - bedsUsed);
        bedsUsed += cycleResult.bedsUsed;

        if (cycleResult.dragonDead) {
          return this.resultDragonDead(bedsUsed);
        }

        if (cycleResult.setupBroken) {
          return {
            success: bedsUsed > 0 || this.meleeAttacks > 0,
            result: `足場が壊れました（ベッド${bedsUsed}個使用、近接${this.meleeAttacks}回）。炎除去と足場の再設置が必要です。`,
            failureType: 'setup_broken',
          };
        }

        if (this.bot.health < HP_RETREAT_THRESHOLD) {
          log.warn(`🛏️ HP低下 (${this.bot.health.toFixed(1)})、撤退して回復`);
          await this.retreatAndHeal();
        }
      }

      return this.resultInterrupted(bedsUsed);
    } catch (error: any) {
      return { success: false, result: `エラー: ${error.message}` };
    } finally {
      (this.bot as any)._bedBombActive = false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  結果ヘルパー
  // ═══════════════════════════════════════════════════════════

  private resultDragonDead(bedsUsed: number): SkillResult {
    return {
      success: true,
      result: `エンダードラゴンを撃破しました！ベッド${bedsUsed}個使用、近接${this.meleeAttacks}回攻撃。`,
    };
  }

  private resultInterrupted(bedsUsed: number): SkillResult {
    return {
      success: bedsUsed > 0 || this.meleeAttacks > 0,
      result: `中断。ベッド${bedsUsed}個使用、近接${this.meleeAttacks}回攻撃。`,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  飛行待機 → フェーズ変化検知
  // ═══════════════════════════════════════════════════════════

  private async waitForPhaseChange(): Promise<'phase_changed' | 'interrupted' | 'dragon_gone'> {
    const MAX_WAIT_MS = 120_000;
    const start = Date.now();
    let lastRepositionTime = 0;

    while (Date.now() - start < MAX_WAIT_MS) {
      if (this.shouldInterrupt()) return 'interrupted';
      const d = findDragon(this.bot);
      if (!d) return 'dragon_gone';

      if (!isDragonFlying(d, this.fountainTopY)) {
        const phase = getDragonPhaseName(d);
        log.info(`🛏️ フェーズ変化検知: ${phase} pos=(${d.position.x.toFixed(1)}, ${d.position.y.toFixed(1)}, ${d.position.z.toFixed(1)})`);
        return 'phase_changed';
      }

      const botPos = this.bot.entity.position;
      const fountainDist = Math.sqrt(botPos.x ** 2 + botPos.z ** 2);
      const now = Date.now();

      if (now - lastRepositionTime > 2000) {
        const tailPos = getDragonTailSafePos(d, botPos.y);
        if (fountainDist <= FOUNTAIN_TETHER_RADIUS) {
          const distToTail = botPos.distanceTo(tailPos);
          if (distToTail > 2.5) {
            lastRepositionTime = now;
            try {
              await gotoSafe(
                this.bot,
                new goals.GoalNear(tailPos.x, tailPos.y, tailPos.z, 1),
                { timeoutMs: 2_000, stuckAbortCount: 2 },
              );
            } catch { /* ignore */ }
          }
        } else {
          log.info(`🛏️ 噴水から離れすぎ (${fountainDist.toFixed(1)}m)。戻ります...`);
          lastRepositionTime = now;
          try {
            await gotoSafe(
              this.bot,
              new goals.GoalNear(tailPos.x, tailPos.y, tailPos.z, 2),
              { timeoutMs: 3_000, stuckAbortCount: 2 },
            );
          } catch { /* ignore */ }
        }
      }

      await this.sleep(200);
    }
    return 'interrupted';
  }

  // ═══════════════════════════════════════════════════════════
  //  近接攻撃フェーズ（着地中に自動で尻側に回り込む）
  // ═══════════════════════════════════════════════════════════

  private async meleePhase(): Promise<'dragon_flew_away' | 'dragon_gone' | 'interrupted'> {
    const weapon = await this.equipBestMelee();
    log.info(`⚔️ 近接攻撃フェーズ開始 (${weapon})`);

    await this.clearFireNearFountain();

    let lastRepositionTime = 0;

    while (!this.shouldInterrupt()) {
      const d = findDragon(this.bot);
      if (!d) return 'dragon_gone';

      if (!isDragonPerched(d)) {
        const phase = getDragonPhaseName(d);
        log.info(`⚔️ ドラゴンが飛び立ちました (${phase})。近接 → 待機に遷移`);
        return 'dragon_flew_away';
      }

      const now = Date.now();
      if (now - lastRepositionTime > MELEE_REPOSITION_MS) {
        await this.moveToTailSide(d);
        lastRepositionTime = now;
      }

      const dist = d.position.distanceTo(this.bot.entity.position);
      if (dist > MELEE_ATTACK_REACH + 1) {
        await this.moveToTailSide(d);
        lastRepositionTime = Date.now();
      }

      if (dist <= MELEE_ATTACK_REACH && d.isValid) {
        try {
          await this.bot.lookAt(d.position.offset(0, d.height * 0.5, 0));
          await this.bot.attack(d);
          this.meleeAttacks++;

          if (this.meleeAttacks % 10 === 0) {
            log.info(`⚔️ ${this.meleeAttacks}回攻撃 (HP: ${this.bot.health.toFixed(1)})`);
          }
        } catch { /* ignore */ }

        const cooldown = weapon.includes('axe') ? 900 : weapon.includes('sword') ? 550 : 200;
        await this.sleep(cooldown);
      } else {
        await this.sleep(200);
      }

      if (this.bot.health < HP_CRITICAL_THRESHOLD) {
        log.warn(`⚔️ HP危険 (${this.bot.health.toFixed(1)})`);
        return 'interrupted';
      }
    }
    return 'interrupted';
  }

  private async moveToTailSide(dragon: any): Promise<void> {
    const headPos = estimateHeadPosition(this.bot, dragon, this.fountainTopY || 64);

    let dirX = FOUNTAIN_CENTER_X - headPos.x;
    let dirZ = FOUNTAIN_CENTER_Z - headPos.z;
    const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (dirLen > 0.1) {
      dirX /= dirLen;
      dirZ /= dirLen;
    } else {
      dirX = 1;
      dirZ = 0;
    }

    const safeX = FOUNTAIN_CENTER_X + dirX * MELEE_TAIL_DIST;
    const safeZ = FOUNTAIN_CENTER_Z + dirZ * MELEE_TAIL_DIST;

    const botPos = this.bot.entity.position;
    const distToTarget = Math.sqrt((botPos.x - safeX) ** 2 + (botPos.z - safeZ) ** 2);
    if (distToTarget < 2) return;

    log.info(
      `⚔️ 尻側へ移動: head=(${headPos.x.toFixed(1)},${headPos.z.toFixed(1)}) → tail=(${safeX.toFixed(1)},${safeZ.toFixed(1)}) dist=${distToTarget.toFixed(1)}`,
    );

    try {
      await gotoSafe(
        this.bot,
        new goals.GoalNear(safeX, botPos.y, safeZ, 2),
        { timeoutMs: 4_000, stuckAbortCount: 2 },
      );
    } catch {
      this.bot.setControlState('forward', true);
      this.bot.setControlState('sprint', true);
      await this.bot.lookAt(new Vec3(safeX, botPos.y + 1.6, safeZ));
      await this.sleep(600);
      this.bot.setControlState('forward', false);
      this.bot.setControlState('sprint', false);
    }
  }

  private async clearFireNearFountain(): Promise<void> {
    const baseY = this.fountainTopY || Math.floor(this.bot.entity.position.y);
    const firePositions: Vec3[] = [];
    for (let dx = -FIRE_CLEAR_RADIUS; dx <= FIRE_CLEAR_RADIUS; dx++) {
      for (let dz = -FIRE_CLEAR_RADIUS; dz <= FIRE_CLEAR_RADIUS; dz++) {
        for (let dy = -2; dy <= 5; dy++) {
          const pos = new Vec3(FOUNTAIN_CENTER_X + dx, baseY + dy, FOUNTAIN_CENTER_Z + dz);
          const block = this.bot.blockAt(pos);
          if (block && (block.name === 'fire' || block.name === 'soul_fire')) {
            firePositions.push(pos);
          }
        }
      }
    }

    if (firePositions.length === 0) return;
    log.info(`🔥 近接前に炎除去: ${firePositions.length}個`);
    await equipDigTool(this.bot);

    for (const pos of firePositions) {
      if (this.shouldInterrupt()) break;
      const botPos = this.bot.entity.position;
      if (botPos.distanceTo(pos) > 4.5) {
        try {
          await gotoSafe(this.bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), {
            timeoutMs: 2_000, stuckAbortCount: 2,
          });
        } catch { /* ignore */ }
      }
      const block = this.bot.blockAt(pos);
      if (block && (block.name === 'fire' || block.name === 'soul_fire')) {
        try { await this.bot.dig(block); } catch { /* ignore */ }
      }
    }
  }

  private async equipBestMelee(): Promise<string> {
    const priority = [
      'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
      'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
    ];
    for (const name of priority) {
      const item = this.bot.inventory.items().find(i => i.name === name);
      if (item) {
        try { await this.bot.equip(item, 'hand'); return name; } catch { /* continue */ }
      }
    }
    return '素手';
  }

  // ═══════════════════════════════════════════════════════════
  //  ベッド爆弾攻撃サイクル
  // ═══════════════════════════════════════════════════════════

  private async attackCycle(maxBeds: number): Promise<{ bedsUsed: number; dragonDead: boolean; setupBroken: boolean }> {
    let bedsUsed = 0;
    let lastDetonationSuccess = false;

    while (bedsUsed < maxBeds && !this.shouldInterrupt()) {
      const dragon = findDragon(this.bot);
      if (!dragon) return { bedsUsed, dragonDead: true, setupBroken: false };

      if (!isDragonInPerchSequence(dragon, this.fountainTopY)) {
        log.info('🛏️ ドラゴンがパーチシーケンス外。次の降下を待ちます。');
        break;
      }

      const bedPos = this.getBedPlacementPosition();
      if (!bedPos) {
        log.warn('🛏️ ベッド設置位置なし。足場が壊れた可能性。');
        return { bedsUsed, dragonDead: false, setupBroken: true };
      }

      // 連続爆破モード: 前回爆破成功なら移動スキップ（頭はまだ近い）
      if (!lastDetonationSuccess) {
        await this.moveToSafeDetonationPos(bedPos);
      }

      const placeResult = await this.placeBedFast(bedPos, lastDetonationSuccess);
      if (!placeResult.placed) {
        log.warn(`🛏️ ベッド設置失敗: ${placeResult.reason}`);
        lastDetonationSuccess = false;
        await this.sleep(200);
        continue;
      }

      const bedBlock = placeResult.bedBlock!;

      // 連続爆破時: 頭がまだ近いなら待機せず即起爆
      let detonated: 'detonated' | 'dragon_gone' | 'left' | 'timeout';
      if (lastDetonationSuccess) {
        detonated = await this.tryImmediateDetonate(bedBlock, bedPos);
        if (detonated === 'timeout') {
          detonated = await this.waitAndDetonate(bedBlock, bedPos);
        }
      } else {
        log.info(`🛏️ ベッド設置完了: (${bedBlock.position.x}, ${bedBlock.position.y}, ${bedBlock.position.z})`);
        detonated = await this.waitAndDetonate(bedBlock, bedPos);
      }

      if (detonated === 'detonated') {
        bedsUsed++;
        lastDetonationSuccess = true;
        log.info(`🛏️ ベッド爆破成功 #${bedsUsed}${bedsUsed > 1 ? ' (連続)' : ''}`);
      } else if (detonated === 'dragon_gone') {
        bedsUsed++;
        return { bedsUsed, dragonDead: true, setupBroken: false };
      } else {
        log.warn(`🛏️ 起爆結果: ${detonated}`);
        lastDetonationSuccess = false;
      }

      if (this.bot.health < HP_CRITICAL_THRESHOLD) {
        log.warn(`🛏️ HP危険 (${this.bot.health.toFixed(1)})、爆破中断`);
        break;
      }

      const postDragon = findDragon(this.bot);
      if (!postDragon) return { bedsUsed, dragonDead: true, setupBroken: false };

      await this.sleep(lastDetonationSuccess ? RAPID_BOMB_DELAY_MS : BOMB_CYCLE_DELAY_MS);
    }

    return { bedsUsed, dragonDead: false, setupBroken: false };
  }

  // ═══════════════════════════════════════════════════════════
  //  ベッド設置位置
  // ═══════════════════════════════════════════════════════════

  private getBedPlacementPosition(): Vec3 | null {
    const onTopPos = new Vec3(FOUNTAIN_CENTER_X, this.fountainTopY + 1, FOUNTAIN_CENTER_Z);
    const onTopBlock = this.bot.blockAt(onTopPos);
    if (onTopBlock && (onTopBlock.name === 'obsidian' || !REPLACEABLE_BLOCKS.has(onTopBlock.name))) {
      const above = onTopPos.offset(0, 1, 0);
      const aboveBlock = this.bot.blockAt(above);
      if (aboveBlock && (REPLACEABLE_BLOCKS.has(aboveBlock.name) || aboveBlock.name.includes('bed'))) {
        return above;
      }
    }

    const maxRadius = 5;
    let bestPos: Vec3 | null = null;
    let bestDist = Infinity;
    for (let r = 1; r <= maxRadius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          for (let dy = -3; dy <= 3; dy++) {
            const pos = new Vec3(
              FOUNTAIN_CENTER_X + dx,
              this.fountainTopY + dy,
              FOUNTAIN_CENTER_Z + dz,
            );
            const block = this.bot.blockAt(pos);
            if (!block) continue;
            if (!REPLACEABLE_BLOCKS.has(block.name) && !block.name.includes('bed')) continue;
            const below = this.bot.blockAt(pos.offset(0, -1, 0));
            if (!below || REPLACEABLE_BLOCKS.has(below.name)) continue;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < bestDist) {
              bestDist = dist;
              bestPos = pos;
            }
          }
        }
      }
      if (bestPos) break;
    }
    return bestPos;
  }

  // ═══════════════════════════════════════════════════════════
  //  安全位置（ドラゴン後方）
  // ═══════════════════════════════════════════════════════════

  private async moveToSafeDetonationPos(bedPos: Vec3): Promise<void> {
    let targetX: number;
    let targetZ: number;

    const dragon = findDragon(this.bot);
    const tailPos = dragon ? getDragonTailSafePos(dragon, this.bot.entity.position.y) : null;
    if (tailPos) {
      targetX = tailPos.x;
      targetZ = tailPos.z;
    } else {
      const dx = bedPos.x - FOUNTAIN_CENTER_X;
      const dz = bedPos.z - FOUNTAIN_CENTER_Z;
      targetX = FOUNTAIN_CENTER_X - dx * 2;
      targetZ = FOUNTAIN_CENTER_Z - dz * 2;
    }

    const fromCenter = Math.sqrt(targetX ** 2 + targetZ ** 2);
    if (fromCenter > FOUNTAIN_TETHER_RADIUS) {
      const scale = FOUNTAIN_TETHER_RADIUS / fromCenter;
      targetX *= scale;
      targetZ *= scale;
    }

    const botPos = this.bot.entity.position;
    const dist = Math.sqrt((botPos.x - targetX) ** 2 + (botPos.z - targetZ) ** 2);
    if (dist < 1.5) return;

    log.info(`🛏️ 後方移動 (dist=${dist.toFixed(1)}m)`);
    try {
      await gotoSafe(
        this.bot,
        new goals.GoalNear(targetX, this.bot.entity.position.y, targetZ, 1),
        { timeoutMs: 3_000, stuckAbortCount: 2 },
      );
    } catch {
      const safePos = new Vec3(targetX, this.bot.entity.position.y, targetZ);
      await this.bot.lookAt(safePos);
      this.bot.setControlState('forward', true);
      await this.sleep(400);
      this.bot.setControlState('forward', false);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  ベッド設置 / 起爆（頭部移動予測付き）
  // ═══════════════════════════════════════════════════════════

  private async placeBed(targetPos: Vec3): Promise<{ placed: boolean; reason?: string; bedBlock?: any }> {
    return this.placeBedFast(targetPos, false);
  }

  /**
   * 連続爆破用の高速ベッド設置。
   * rapidMode=true の場合、sleep を最小化しリトライしない。
   */
  private async placeBedFast(
    targetPos: Vec3,
    rapidMode: boolean,
  ): Promise<{ placed: boolean; reason?: string; bedBlock?: any }> {
    const bedItem = findBedItem(this.bot);
    if (!bedItem) return { placed: false, reason: 'ベッドがない' };

    if (!rapidMode) {
      const targetBlock = this.bot.blockAt(targetPos);
      if (targetBlock && (targetBlock.name === 'fire' || targetBlock.name === 'soul_fire')) {
        await equipDigTool(this.bot);
        try { await this.bot.dig(targetBlock); } catch { /* ignore */ }
        await this.sleep(100);
      }
    }

    const maxAttempts = rapidMode ? 1 : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const freshBedItem = findBedItem(this.bot);
        if (!freshBedItem) return { placed: false, reason: 'ベッドがない' };

        await this.bot.equip(freshBedItem, 'hand');

        const referenceBlock = this.bot.blockAt(targetPos.offset(0, -1, 0));
        if (!referenceBlock || REPLACEABLE_BLOCKS.has(referenceBlock.name)) {
          return { placed: false, reason: `参照ブロックがない (${referenceBlock?.name ?? 'null'})` };
        }

        if (!rapidMode) {
          await this.bot.lookAt(new Vec3(FOUNTAIN_CENTER_X + 0.5, targetPos.y + 0.5, FOUNTAIN_CENTER_Z + 0.5));
          await this.sleep(50);
        }

        await this.bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
        if (!rapidMode) await this.sleep(100);

        const bedBlock = this.findNearestBedBlock(targetPos);
        if (!bedBlock) return { placed: false, reason: 'ベッド検出失敗' };

        return { placed: true, bedBlock };
      } catch (err: any) {
        log.warn(`🛏️ ベッド設置 attempt ${attempt + 1}/${maxAttempts} 失敗: ${err.message}`);
        if (!rapidMode && attempt < maxAttempts - 1) {
          await this.sleep(200);
          const existing = this.findNearestBedBlock(targetPos);
          if (existing) return { placed: true, bedBlock: existing };
        }
      }
    }
    return { placed: false, reason: 'placeBlock 失敗' };
  }

  /**
   * 直前に爆破成功→頭がまだ近い場合に即起爆を試みる。
   * 頭が範囲内ならすぐ activateBlock、範囲外なら 'timeout' を返し
   * 呼び出し元で通常の waitAndDetonate にフォールバック。
   */
  private async tryImmediateDetonate(
    bedBlock: any,
    bedPos: Vec3,
  ): Promise<'detonated' | 'dragon_gone' | 'left' | 'timeout'> {
    const dragon = findDragon(this.bot);
    if (!dragon) return 'dragon_gone';

    if (!isDragonInPerchSequence(dragon, this.fountainTopY)) return 'left';

    const headPos = estimateHeadPosition(this.bot, dragon, this.fountainTopY);
    const headDist = headPos.distanceTo(bedPos);

    if (headDist <= HEAD_BLAST_RANGE * 1.3) {
      log.info(`🛏️ 連続起爆: 頭部距離=${headDist.toFixed(1)}m → 即起爆！`);
      try {
        const currentBed = this.bot.blockAt(bedBlock.position) ?? bedBlock;
        if (currentBed && currentBed.name?.includes('bed')) {
          await this.bot.activateBlock(currentBed);
        }
      } catch (err: any) {
        log.warn(`🛏️ 連続起爆 activateBlock エラー: ${err.message}`);
      }
      return 'detonated';
    }

    log.info(`🛏️ 連続起爆不可 (頭部距離=${headDist.toFixed(1)}m)。通常待機へ。`);
    return 'timeout';
  }

  /**
   * 頭部の接近速度を見て早めに起爆する。
   */
  private async waitAndDetonate(
    bedBlock: any,
    bedPos: Vec3,
  ): Promise<'detonated' | 'dragon_gone' | 'left' | 'timeout'> {
    const MAX_WAIT = 15_000;
    const start = Date.now();
    let prevHeadPos: Vec3 | null = null;
    let prevTime = 0;

    while (Date.now() - start < MAX_WAIT) {
      if (this.shouldInterrupt()) return 'timeout';

      const dragon = findDragon(this.bot);
      if (!dragon) return 'dragon_gone';

      if (!isDragonInPerchSequence(dragon, this.fountainTopY)) {
        try {
          const remainingBed = this.bot.blockAt(bedPos);
          if (remainingBed && remainingBed.name.includes('bed')) {
            await equipDigTool(this.bot);
            await this.bot.dig(remainingBed);
          }
        } catch { /* ignore */ }
        return 'left';
      }

      const headPos = estimateHeadPosition(this.bot, dragon, this.fountainTopY);
      const headDist = headPos.distanceTo(bedPos);
      const now = Date.now();

      // 接近速度から「あと何tick で到達するか」を見て、十分近いときだけ早め起爆
      let earlyDetonate = false;
      if (prevHeadPos && now - prevTime > 0 && headDist <= HEAD_PREDICT_MAX_CURRENT_DIST) {
        const prevDist = prevHeadPos.distanceTo(bedPos);
        const closing = prevDist - headDist;
        // 接近中かつ、あと2tick (200ms) 以内に到達見込み
        if (closing > 0 && headDist / closing <= 2) {
          earlyDetonate = true;
        }
      }
      prevHeadPos = headPos.clone();
      prevTime = now;

      const shouldDetonate = headDist <= HEAD_BLAST_RANGE || earlyDetonate;

      if (shouldDetonate) {
        const reason = headDist <= HEAD_BLAST_RANGE
          ? `現在距離=${headDist.toFixed(1)}m`
          : `早期起爆 (${headDist.toFixed(1)}m, 急接近中)`;
        log.info(`🛏️ 頭部が範囲内 (${reason}) → 起爆！`);
        try {
          const currentBed = this.bot.blockAt(bedBlock.position) ?? bedBlock;
          if (currentBed && currentBed.name?.includes('bed')) {
            await this.bot.activateBlock(currentBed);
          }
        } catch (err: any) {
          log.warn(`🛏️ activateBlock エラー (爆発は成功の可能性あり): ${err.message}`);
        }
        return 'detonated';
      }

      await this.sleep(HEAD_TRACK_INTERVAL_MS);
    }

    try {
      const remainingBed = this.bot.blockAt(bedPos);
      if (remainingBed && remainingBed.name.includes('bed')) {
        log.info('🛏️ 起爆タイムアウト。ベッドを回収。');
        await equipDigTool(this.bot);
        await this.bot.dig(remainingBed);
      }
    } catch { /* ignore */ }
    return 'timeout';
  }

  private findNearestBedBlock(nearPos: Vec3): ReturnType<CustomBot['blockAt']> | null {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          const block = this.bot.blockAt(nearPos.offset(dx, dy, dz));
          if (block && block.name.includes('bed')) return block;
        }
      }
    }
    try {
      return this.bot.findBlock({
        matching: (block: any) => block.name.includes('bed'),
        maxDistance: 5,
      });
    } catch { return null; }
  }

  // ═══════════════════════════════════════════════════════════
  //  撤退・回復
  // ═══════════════════════════════════════════════════════════

  private async retreatAndHeal(): Promise<void> {
    try {
      const botPos = this.bot.entity.position;
      const awayX = botPos.x + (botPos.x >= 0 ? 10 : -10);
      const awayZ = botPos.z + (botPos.z >= 0 ? 10 : -10);
      await gotoSafe(this.bot, new goals.GoalNear(awayX, botPos.y, awayZ, 2), { timeoutMs: 5_000 });
    } catch { /* ignore */ }

    await this.eatHealingItem();

    const healStart = Date.now();
    while (this.bot.health < 16 && Date.now() - healStart < 10_000) {
      if (this.shouldInterrupt()) break;
      await this.sleep(500);
    }
  }

  private async eatHealingItem(): Promise<void> {
    const healingItems = [
      'enchanted_golden_apple', 'golden_apple', 'golden_carrot',
      'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread',
    ];
    for (const itemName of healingItems) {
      const item = this.bot.inventory.items().find(i => i.name === itemName);
      if (item) {
        try {
          await this.bot.equip(item, 'hand');
          this.bot.activateItem();
          await this.sleep(1800);
          this.bot.deactivateItem();
          log.info(`🛏️ ${itemName} を食べました`);
          return;
        } catch { /* ignore */ }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default BedBombCycle;
