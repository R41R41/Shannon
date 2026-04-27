import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import {
  FOUNTAIN_CENTER_X, FOUNTAIN_CENTER_Z, REPLACEABLE_BLOCKS,
  findFountainTop, digUntilGone, findDragon, isDragonPerched,
} from '../utils/endDragonUtils.js';
import type { SkillResult } from '../types/skillParams.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:setupFountainShield');

class SetupFountainShield extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'setup-fountain-shield';
    this.description =
      'エンドの噴水（出口ポータル）の上にオブシディアンの足場とサポートブロックを設置します。ベッド設置用の土台を作ります。';
    this.params = [];
  }

  async runImpl(): Promise<SkillResult> {
    if (this.bot.game.dimension !== 'the_end') {
      return { success: false, result: 'エンド次元にいません。' };
    }

    const dragon = findDragon(this.bot);
    if (dragon && isDragonPerched(dragon)) {
      return {
        success: false,
        result: 'ドラゴンが噴水に着地中のため設置できません。ドラゴンが飛び立つのを待ってから再試行してください。',
      };
    }

    const fountainTopY = findFountainTop(this.bot);
    if (fountainTopY === 0) {
      return { success: false, result: '噴水が見つかりません。(0, ?, 0) に岩盤がありません。' };
    }

    await this.moveToFountain(fountainTopY);

    const obsidianPos = await this.placeObsidianShield(fountainTopY);
    if (!obsidianPos) {
      return {
        success: false,
        result: 'オブシディアンの設置に失敗しました。インベントリにオブシディアンがあるか確認してください。',
      };
    }

    const bedPos = this.getBedPlacementPosition(fountainTopY, obsidianPos);

    const lines: string[] = [];
    lines.push(`オブシディアン設置: (${obsidianPos.x}, ${obsidianPos.y}, ${obsidianPos.z})`);
    lines.push(`噴水トップY: ${fountainTopY}`);
    if (bedPos) {
      lines.push(`ベッド設置候補: (${bedPos.x}, ${bedPos.y}, ${bedPos.z})`);
    } else {
      lines.push('ベッド設置候補: 見つかりませんでした（炎除去が必要かもしれません）');
    }

    return { success: true, result: lines.join('\n') };
  }

  private async moveToFountain(fountainTopY: number): Promise<void> {
    const botPos = this.bot.entity.position;
    const dist = Math.sqrt(
      (botPos.x - FOUNTAIN_CENTER_X) ** 2 + (botPos.z - FOUNTAIN_CENTER_Z) ** 2,
    );
    if (dist < 3) return;

    log.info(`🛏️ 噴水まで移動 (距離: ${dist.toFixed(1)}m)`);
    try {
      await gotoSafe(
        this.bot,
        new goals.GoalNear(FOUNTAIN_CENTER_X, fountainTopY, FOUNTAIN_CENTER_Z, 2),
        { timeoutMs: 8_000, stuckAbortCount: 4 },
      );
    } catch {
      log.warn('🛏️ パスファインダー失敗、直接移動を試行');
      await this.bot.lookAt(new Vec3(FOUNTAIN_CENTER_X + 0.5, fountainTopY, FOUNTAIN_CENTER_Z + 0.5));
      this.bot.setControlState('forward', true);
      await this.sleep(1500);
      this.bot.setControlState('forward', false);
    }
  }

  private async placeObsidianShield(fountainTopY: number): Promise<Vec3 | null> {
    const pillarTop = new Vec3(FOUNTAIN_CENTER_X, fountainTopY, FOUNTAIN_CENTER_Z);
    const onTopPos = pillarTop.offset(0, 1, 0);
    const onTopBlock = this.bot.blockAt(onTopPos);

    if (onTopBlock && onTopBlock.name === 'obsidian') {
      log.info('🛏️ 既存オブシディアン検出 (柱上)');
      await this.placeSupportBlockAdjacent(onTopPos);
      return onTopPos;
    }

    if (onTopBlock && REPLACEABLE_BLOCKS.has(onTopBlock.name)) {
      if (onTopBlock.name === 'fire' || onTopBlock.name === 'soul_fire') {
        await digUntilGone(this.bot, onTopPos);
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        const obsidianItem = this.bot.inventory.items().find(i => i.name === 'obsidian');
        if (!obsidianItem) return null;
        try {
          const refBlock = this.bot.blockAt(pillarTop);
          if (!refBlock) return null;
          await this.bot.equip(obsidianItem, 'hand');
          await this.bot.lookAt(onTopPos.offset(0.5, 0.5, 0.5));
          await this.sleep(50);
          await this.bot.placeBlock(refBlock, new Vec3(0, 1, 0));
          log.info(`🛏️ オブシディアン設置 (柱上): (${onTopPos.x}, ${onTopPos.y}, ${onTopPos.z})`);
          await this.sleep(100);
          await this.placeSupportBlockAdjacent(onTopPos);
          return onTopPos;
        } catch (err: any) {
          log.warn(`🛏️ 柱上設置 attempt ${attempt + 1}/3 失敗: ${err.message}`);
          const placed = this.bot.blockAt(onTopPos);
          if (placed && placed.name === 'obsidian') {
            log.info('🛏️ タイムアウトだが設置済みと検出');
            await this.placeSupportBlockAdjacent(onTopPos);
            return onTopPos;
          }
          await this.sleep(300);
        }
      }
    }

    const sideFaces = [
      new Vec3(0, 0, -1), new Vec3(0, 0, 1),
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    ];

    for (const face of sideFaces) {
      const targetPos = pillarTop.offset(face.x, 0, face.z);
      const targetBlock = this.bot.blockAt(targetPos);
      if (!targetBlock || !REPLACEABLE_BLOCKS.has(targetBlock.name)) continue;
      if (targetBlock.name === 'fire' || targetBlock.name === 'soul_fire') {
        const gone = await digUntilGone(this.bot, targetPos);
        if (!gone) continue;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const refBlock = this.bot.blockAt(pillarTop);
          if (!refBlock) break;
          const freshObs = this.bot.inventory.items().find(i => i.name === 'obsidian');
          if (!freshObs) return null;
          await this.bot.equip(freshObs, 'hand');
          await this.bot.lookAt(targetPos.offset(0.5, 0.5, 0.5));
          await this.sleep(50);
          await this.bot.placeBlock(refBlock, face);
          log.info(`🛏️ オブシディアン設置 (柱側面): (${targetPos.x}, ${targetPos.y}, ${targetPos.z})`);
          return targetPos;
        } catch (err: any) {
          log.warn(`🛏️ 側面設置 attempt ${attempt + 1} 失敗: ${err.message}`);
          const placed = this.bot.blockAt(targetPos);
          if (placed && placed.name === 'obsidian') {
            log.info('🛏️ タイムアウトだが側面設置済みと検出');
            return targetPos;
          }
          await this.sleep(200);
        }
      }
    }
    return null;
  }

  private async placeSupportBlockAdjacent(basePos: Vec3): Promise<boolean> {
    const supportItems = ['obsidian', 'cobblestone', 'end_stone', 'cobbled_deepslate', 'stone', 'dirt'];
    let supportItem: any = null;
    for (const name of supportItems) {
      supportItem = this.bot.inventory.items().find(i => i.name === name);
      if (supportItem) break;
    }
    if (!supportItem) return false;

    const faces = [new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(1, 0, 0), new Vec3(-1, 0, 0)];
    for (const face of faces) {
      const adjPos = basePos.offset(face.x, 0, face.z);
      const adjBlock = this.bot.blockAt(adjPos);
      if (!adjBlock || !REPLACEABLE_BLOCKS.has(adjBlock.name)) continue;
      try {
        const refBlock = this.bot.blockAt(basePos);
        if (!refBlock || REPLACEABLE_BLOCKS.has(refBlock.name)) continue;
        await this.bot.equip(supportItem, 'hand');
        await this.bot.lookAt(adjPos.offset(0.5, 0.5, 0.5));
        await this.sleep(50);
        await this.bot.placeBlock(refBlock, face);
        log.info(`🛏️ サポートブロック設置: (${adjPos.x}, ${adjPos.y}, ${adjPos.z})`);
        return true;
      } catch { continue; }
    }
    return false;
  }

  private getBedPlacementPosition(fountainTopY: number, obsidianPos: Vec3): Vec3 | null {
    const above = obsidianPos.offset(0, 1, 0);
    const block = this.bot.blockAt(above);
    if (block && (REPLACEABLE_BLOCKS.has(block.name) || block.name.includes('bed'))) {
      return above;
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
              fountainTopY + dy,
              FOUNTAIN_CENTER_Z + dz,
            );
            const b = this.bot.blockAt(pos);
            if (!b) continue;
            if (!REPLACEABLE_BLOCKS.has(b.name) && !b.name.includes('bed')) continue;
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default SetupFountainShield;
