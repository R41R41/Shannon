import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import type { SkillResult } from '../types/skillParams.js';
import {
  findDragon, getDragonPhaseName, isDragonFlying, isDragonApproaching,
  isDragonInPerchSequence, isDragonPerched, estimateHeadPosition, findFountainTop,
  countBeds, FOUNTAIN_CENTER_X, FOUNTAIN_CENTER_Z,
} from '../utils/endDragonUtils.js';

class DragonStatus extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'dragon-status';
    this.description =
      'エンダードラゴンの現在状態（フェーズ、位置、頭部位置、噴水情報、ベッド数）を返します。ベッド爆弾の準備状況判断に使います。';
    this.params = [];
  }

  async runImpl(): Promise<SkillResult> {
    if (this.bot.game.dimension !== 'the_end') {
      return { success: false, result: 'エンド次元にいません。' };
    }

    const dragon = findDragon(this.bot);
    const fountainTopY = findFountainTop(this.bot);
    const beds = countBeds(this.bot);
    const botPos = this.bot.entity.position;
    const fountainDist = Math.sqrt(
      (botPos.x - FOUNTAIN_CENTER_X) ** 2 + (botPos.z - FOUNTAIN_CENTER_Z) ** 2,
    );

    const lines: string[] = [];
    lines.push(`ボット位置: (${botPos.x.toFixed(1)}, ${botPos.y.toFixed(1)}, ${botPos.z.toFixed(1)})`);
    lines.push(`噴水までの距離: ${fountainDist.toFixed(1)}m`);
    lines.push(`噴水トップY: ${fountainTopY || '検出失敗'}`);
    lines.push(`ベッド残数: ${beds}個`);
    lines.push(`HP: ${this.bot.health.toFixed(1)}/20`);

    if (!dragon) {
      lines.push('ドラゴン: 不在（撃破済みまたは未スポーン）');
      return { success: true, result: lines.join('\n') };
    }

    const phaseName = getDragonPhaseName(dragon);
    const dragonPos = dragon.position;
    lines.push(`ドラゴン: 存在`);
    lines.push(`  フェーズ: ${phaseName}`);
    lines.push(`  位置: (${dragonPos.x.toFixed(1)}, ${dragonPos.y.toFixed(1)}, ${dragonPos.z.toFixed(1)})`);

    if (fountainTopY > 0) {
      const headPos = estimateHeadPosition(this.bot, dragon, fountainTopY);
      lines.push(`  頭部推定位置: (${headPos.x.toFixed(1)}, ${headPos.y.toFixed(1)}, ${headPos.z.toFixed(1)})`);

      if (isDragonPerched(dragon)) {
        lines.push('  状態: 噴水に完全着地中 ⚠ ベッド/ブロック設置不可 → dragon-melee を実行');
      } else if (isDragonFlying(dragon, fountainTopY)) {
        lines.push('  状態: 飛行中（準備チャンス — 炎除去・足場設置を行うこと）');
      } else if (isDragonApproaching(dragon, fountainTopY)) {
        lines.push('  状態: 降下中（ベッド爆弾の攻撃チャンス）');
      } else if (isDragonInPerchSequence(dragon, fountainTopY)) {
        lines.push('  状態: パーチシーケンス中（攻撃可能）');
      } else {
        lines.push('  状態: その他');
      }
    }

    const obsidianOnFountain = fountainTopY > 0
      ? this.bot.blockAt(new Vec3(FOUNTAIN_CENTER_X, fountainTopY + 1, FOUNTAIN_CENTER_Z))
      : null;
    if (obsidianOnFountain) {
      lines.push(`噴水上ブロック (Y=${fountainTopY + 1}): ${obsidianOnFountain.name}`);
    }

    return { success: true, result: lines.join('\n') };
  }
}

export default DragonStatus;
