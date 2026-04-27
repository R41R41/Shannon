import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import {
  findDragon, getDragonPhaseName, isDragonPerched, estimateHeadPosition,
  findFountainTop, equipDigTool,
  FOUNTAIN_CENTER_X, FOUNTAIN_CENTER_Z,
} from '../utils/endDragonUtils.js';
import type { SkillResult } from '../types/skillParams.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:dragonMelee');

const ATTACK_REACH = 4.5;
const TAIL_SAFE_DIST = 4;
const FIRE_CLEAR_RADIUS = 6;
const REPOSITION_INTERVAL_MS = 5_000;

class DragonMelee extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'dragon-melee';
    this.description =
      'エンダードラゴンが噴水に着地中に、頭と反対側（尻側）に回り込んで剣/斧で近接攻撃します。周囲の炎も自動除去します。';
    this.maxDurationMs = 60_000;
    this.params = [
      {
        name: 'maxDuration',
        type: 'number',
        description: '最大攻撃時間（秒、デフォルト: 45）',
        required: false,
        default: 45,
      },
    ];
  }

  async runImpl(maxDuration: number = 45): Promise<SkillResult> {
    if (this.bot.game.dimension !== 'the_end') {
      return { success: false, result: 'エンド次元にいません。' };
    }

    const dragon = findDragon(this.bot);
    if (!dragon) {
      return { success: true, result: 'ドラゴンがいません（撃破済み）。' };
    }

    if (!isDragonPerched(dragon)) {
      const phase = getDragonPhaseName(dragon);
      return {
        success: false,
        result: `ドラゴンは噴水に着地していません (${phase})。bed-bomb-cycle を使ってください。`,
        failureType: 'not_perched',
      };
    }

    const fountainTopY = findFountainTop(this.bot);
    const weapon = await this.equipBestMelee();
    log.info(`⚔️ ドラゴン近接攻撃開始 (武器: ${weapon})`);

    await this.clearFireNearFountain(fountainTopY || Math.floor(this.bot.entity.position.y));

    let attackCount = 0;
    const deadline = Date.now() + maxDuration * 1000;
    let lastRepositionTime = 0;

    while (Date.now() < deadline && !this.shouldInterrupt()) {
      const d = findDragon(this.bot);
      if (!d) {
        return {
          success: true,
          result: `エンダードラゴンを撃破しました！${attackCount}回攻撃 (${weapon})`,
        };
      }

      if (!isDragonPerched(d)) {
        const phase = getDragonPhaseName(d);
        log.info(`⚔️ ドラゴンが飛び立ちました (${phase})。近接攻撃終了。`);
        return {
          success: attackCount > 0,
          result: `ドラゴンが飛び立ちました (${phase})。${attackCount}回攻撃 (${weapon})。ベッド爆弾の準備に切り替えてください。`,
          failureType: 'dragon_flew_away',
        };
      }

      const now = Date.now();
      if (now - lastRepositionTime > REPOSITION_INTERVAL_MS) {
        await this.moveToTailSide(d, fountainTopY);
        lastRepositionTime = now;
      }

      const dist = d.position.distanceTo(this.bot.entity.position);
      if (dist > ATTACK_REACH + 1) {
        await this.moveToTailSide(d, fountainTopY);
        lastRepositionTime = Date.now();
      }

      if (dist <= ATTACK_REACH && d.isValid) {
        try {
          await this.bot.lookAt(d.position.offset(0, d.height * 0.5, 0));
          await this.bot.attack(d);
          attackCount++;

          if (attackCount % 10 === 0) {
            log.info(`⚔️ ${attackCount}回攻撃済み (HP: ${this.bot.health.toFixed(1)})`);
          }
        } catch { /* ignore */ }

        const cooldown = weapon.includes('axe') ? 900 : weapon.includes('sword') ? 550 : 200;
        await this.sleep(cooldown);
      } else {
        await this.sleep(200);
      }

      if (this.bot.health < 6) {
        log.warn(`⚔️ HP危険 (${this.bot.health.toFixed(1)})、撤退`);
        return {
          success: attackCount > 0,
          result: `HP低下 (${this.bot.health.toFixed(1)}) により撤退。${attackCount}回攻撃 (${weapon})`,
          failureType: 'hp_critical',
        };
      }
    }

    return {
      success: attackCount > 0,
      result: `近接攻撃完了。${attackCount}回攻撃 (${weapon})`,
    };
  }

  private async moveToTailSide(dragon: any, fountainTopY: number): Promise<void> {
    const headPos = estimateHeadPosition(this.bot, dragon, fountainTopY || 64);

    // 噴水中心を挟んで頭と反対方向
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

    const safeX = FOUNTAIN_CENTER_X + dirX * TAIL_SAFE_DIST;
    const safeZ = FOUNTAIN_CENTER_Z + dirZ * TAIL_SAFE_DIST;

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

  private async clearFireNearFountain(baseY: number): Promise<void> {
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

    log.info(`🔥 炎除去: ${firePositions.length}個`);
    await equipDigTool(this.bot);

    for (const pos of firePositions) {
      if (this.shouldInterrupt()) break;
      const botPos = this.bot.entity.position;
      if (botPos.distanceTo(pos) > 4.5) {
        try {
          await gotoSafe(this.bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), {
            timeoutMs: 2_000,
            stuckAbortCount: 2,
          });
        } catch { /* ignore */ }
      }
      const block = this.bot.blockAt(pos);
      if (block && (block.name === 'fire' || block.name === 'soul_fire')) {
        try { await this.bot.dig(block); } catch { /* ignore */ }
      }
    }

    await this.equipBestMelee();
  }

  private async equipBestMelee(): Promise<string> {
    const priority = [
      'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
      'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
    ];
    for (const name of priority) {
      const item = this.bot.inventory.items().find(i => i.name === name);
      if (item) {
        try {
          await this.bot.equip(item, 'hand');
          return name;
        } catch { /* continue */ }
      }
    }
    return '素手';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default DragonMelee;
