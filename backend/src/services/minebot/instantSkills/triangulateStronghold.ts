import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill, SkillResult } from '../types.js';
import { SkillParam } from '../types/skillParams.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { setMovements } from '../utils/setMovements.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:triangulateStronghold');

interface ThrowRecord {
  x: number;
  z: number;
  dx: number;
  dz: number;
  angleDeg: number;
}

const STRONGHOLD_RINGS = [
  { min: 1280, max: 2816, count: 3 },
  { min: 4352, max: 5888, count: 6 },
  { min: 7424, max: 8960, count: 10 },
  { min: 10496, max: 12032, count: 15 },
  { min: 13568, max: 15104, count: 21 },
  { min: 16640, max: 18176, count: 28 },
  { min: 19712, max: 21248, count: 36 },
  { min: 22784, max: 24320, count: 9 },
] as const;

const EYE_SAMPLE_DELAY_MS = 600;
const EYE_DETECT_TIMEOUT_MS = 5000;
const MIN_HORIZONTAL_MOVE = 0.3;
const EYE_DESPAWN_TIMEOUT_MS = 6000;
const RECOVERY_SCAN_RADIUS = 10;

class TriangulateStronghold extends InstantSkill {
  private throws: ThrowRecord[] = [];

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'triangulate-stronghold';
    this.description =
      'エンダーアイを投げて飛行方向を記録し、2回以上の投擲データから要塞座標を三角測量で計算する。' +
      '1回目: action="throw" で投擲＋方角記録。2回目以降: action="throw" で自動的に三角測量結果も返す。' +
      'action="calculate" で手動再計算。要塞探索ルーチン locate-stronghold から呼ばれることを想定。';
    this.params = [
      {
        name: 'action',
        type: 'string' as const,
        description:
          '"throw": エンダーアイを投げて方角を記録（2回目以降は自動で三角測量結果も返す）, ' +
          '"calculate": 記録済みデータから要塞位置を計算, ' +
          '"status": 現在の記録データを表示, ' +
          '"reset": 記録データをリセット',
        required: true,
      },
    ] satisfies SkillParam[];
  }

  async runImpl(action: string): Promise<SkillResult> {
    switch (action) {
      case 'throw':
        return this.throwEyeAndRecord();
      case 'calculate':
        return this.doCalculate();
      case 'status':
        return this.showStatus();
      case 'reset':
        this.throws = [];
        return { success: true, result: '投擲データをリセットしました。' };
      default:
        return { success: false, result: `不明なアクション: "${action}"。throw / calculate / status / reset のいずれかを指定してください。` };
    }
  }

  // ─── 投擲 + 記録 ───

  private async throwEyeAndRecord(): Promise<SkillResult> {
    if (this.bot.game.dimension !== 'overworld') {
      return { success: false, result: 'エンダーアイはオーバーワールドでのみ使用できます。' };
    }

    const enderEye = this.bot.inventory.items().find(
      (i) => i.name === 'ender_eye',
    );
    if (!enderEye) {
      return { success: false, result: 'インベントリにエンダーアイがありません。' };
    }

    try {
      await this.bot.equip(enderEye, 'hand');
    } catch {
      return { success: false, result: 'エンダーアイの装備に失敗しました。' };
    }

    const direction = await this.trackEyeEntity();
    if (!direction) {
      return { success: false, result: 'エンダーアイの飛行方向を検出できませんでした。再試行してください。' };
    }

    const rec: ThrowRecord = {
      x: direction.originX,
      z: direction.originZ,
      dx: direction.dx,
      dz: direction.dz,
      angleDeg: direction.angleDeg,
    };
    this.throws.push(rec);

    const throwIdx = this.throws.length;
    let resultText =
      `投擲#${throwIdx} 記録完了: 位置(${rec.x.toFixed(1)}, ${rec.z.toFixed(1)}) 方角=${rec.angleDeg.toFixed(1)}°`;

    // エンダーアイの回収を試みる（方角記録後、エンティティの落下を待つ）
    const recovery = await this.tryRecoverEye(direction.eyeEntityId);
    if (recovery === 'recovered') {
      resultText += '\n♻️ エンダーアイを回収しました。';
    } else {
      resultText += '\n💥 エンダーアイは壊れました（20%の確率）。';
    }

    const perpDx = -rec.dz;
    const perpDz = rec.dx;
    const d = 80;
    const opt1x = rec.x + perpDx * d, opt1z = rec.z + perpDz * d;
    const opt2x = rec.x - perpDx * d, opt2z = rec.z - perpDz * d;
    resultText +=
      `\n次の投擲のため移動: ${this.compass(perpDx, perpDz)}方向(${opt1x.toFixed(0)}, ${opt1z.toFixed(0)})` +
      ` または ${this.compass(-perpDx, -perpDz)}方向(${opt2x.toFixed(0)}, ${opt2z.toFixed(0)})` +
      `\n（50ブロック以上離れれば十分。到達不能なら任意の方向でOK）`;

    if (throwIdx >= 2) {
      const tri = this.triangulate();
      if (tri) {
        const botPos = this.bot.entity.position;
        const distFromBot = Math.sqrt(
          (tri.x - botPos.x) ** 2 + (tri.z - botPos.z) ** 2,
        );
        resultText +=
          `\n🎯 要塞推定座標: X=${tri.x.toFixed(0)}, Z=${tri.z.toFixed(0)}` +
          ` (現在地から${distFromBot.toFixed(0)}ブロック, 原点から${tri.distFromOrigin.toFixed(0)}ブロック)`;
        if (tri.ring) {
          resultText += `\nリング${tri.ring.index} (${tri.ring.min}–${tri.ring.max}, ${tri.ring.count}個)`;
        }
        if (tri.confidence) {
          resultText += `\n信頼度: ${tri.confidence}`;
        }
        resultText += `\nチャンク中心: (${(Math.floor(tri.x / 16) * 16 + 8).toFixed(0)}, ${(Math.floor(tri.z / 16) * 16 + 8).toFixed(0)})`;
      } else {
        resultText += '\n⚠️ 投擲方向がほぼ平行のため三角測量に失敗。さらに別方向から投擲してください。';
      }
    } else {
      const est = this.estimateFromRay(rec);
      resultText += `\n${est}`;
    }

    log.info(resultText);
    return { success: true, result: resultText };
  }

  // ─── エンティティ追跡 ───

  private async trackEyeEntity(): Promise<{
    originX: number;
    originZ: number;
    dx: number;
    dz: number;
    angleDeg: number;
    eyeEntityId: number;
  } | null> {
    const existingEyeIds = new Set<number>();
    for (const [id, e] of Object.entries(this.bot.entities)) {
      if ((e as any).name === 'eye_of_ender') existingEyeIds.add(Number(id));
    }

    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.bot.removeListener('entitySpawn', onSpawn);
        log.warn('👁️ eye_of_ender タイムアウト: エンティティが検出されませんでした');
        resolve(null);
      }, EYE_DETECT_TIMEOUT_MS);

      const onSpawn = (entity: any) => {
        if (entity.name !== 'eye_of_ender') return;
        if (existingEyeIds.has(entity.id)) return;
        this.bot.removeListener('entitySpawn', onSpawn);

        const startPos = entity.position.clone();
        log.info(
          `👁️ eye_of_ender 検出 (id=${entity.id}): (${startPos.x.toFixed(2)}, ${startPos.y.toFixed(2)}, ${startPos.z.toFixed(2)})`,
        );

        setTimeout(() => {
          clearTimeout(timeoutHandle);

          let endPos: Vec3;
          try {
            endPos = entity.position.clone();
          } catch {
            log.warn('👁️ eye_of_ender: 追跡中にエンティティが消滅');
            resolve(null);
            return;
          }

          const hdx = endPos.x - startPos.x;
          const hdz = endPos.z - startPos.z;
          const hDist = Math.sqrt(hdx * hdx + hdz * hdz);

          log.info(
            `👁️ eye_of_ender → (${endPos.x.toFixed(2)}, ${endPos.y.toFixed(2)}, ${endPos.z.toFixed(2)}) 水平移動=${hDist.toFixed(2)}`,
          );

          if (hDist < MIN_HORIZONTAL_MOVE) {
            log.warn(`👁️ eye_of_ender: 水平移動が不十分 (${hDist.toFixed(3)} < ${MIN_HORIZONTAL_MOVE})`);
            resolve(null);
            return;
          }

          const ndx = hdx / hDist;
          const ndz = hdz / hDist;
          const angleDeg =
            ((Math.atan2(-ndx, ndz) * 180) / Math.PI + 360) % 360;

          log.info(`👁️ 方角記録: ${angleDeg.toFixed(1)}° (dx=${ndx.toFixed(4)}, dz=${ndz.toFixed(4)})`);
          resolve({ originX: startPos.x, originZ: startPos.z, dx: ndx, dz: ndz, angleDeg, eyeEntityId: entity.id });
        }, EYE_SAMPLE_DELAY_MS);
      };

      this.bot.on('entitySpawn', onSpawn);

      try {
        this.bot.activateItem();
      } catch (err) {
        log.warn(`👁️ activateItem 失敗: ${err}`);
      }
    });
  }

  // ─── エンダーアイ回収 ───

  private async tryRecoverEye(eyeEntityId: number): Promise<'recovered' | 'shattered'> {
    const eyeEntity = this.bot.entities[eyeEntityId];

    if (!eyeEntity) {
      await this.sleep(500);
      return (await this.scanAndPickupEye(this.bot.entity.position)) ? 'recovered' : 'shattered';
    }

    const lastPos = await new Promise<Vec3 | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.bot.removeListener('entityGone', onGone);
        try {
          resolve(eyeEntity.position.clone());
        } catch {
          resolve(null);
        }
      }, EYE_DESPAWN_TIMEOUT_MS);

      const onGone = (gone: any) => {
        if (gone.id !== eyeEntityId) return;
        this.bot.removeListener('entityGone', onGone);
        clearTimeout(timeout);
        try {
          resolve(gone.position?.clone() ?? null);
        } catch {
          resolve(null);
        }
      };

      this.bot.on('entityGone', onGone);
    });

    if (!lastPos) return 'shattered';

    log.info(`👁️ eye_of_ender 消滅 → 最終位置 (${lastPos.x.toFixed(1)}, ${lastPos.y.toFixed(1)}, ${lastPos.z.toFixed(1)})`);

    await this.sleep(500);
    return (await this.scanAndPickupEye(lastPos)) ? 'recovered' : 'shattered';
  }

  private async scanAndPickupEye(nearPos: Vec3): Promise<boolean> {
    let targetEntity: any = null;
    let minDist = RECOVERY_SCAN_RADIUS;

    for (const e of Object.values(this.bot.entities)) {
      if ((e as any).name !== 'item') continue;
      const dist = (e as any).position.distanceTo(nearPos);
      if (dist > RECOVERY_SCAN_RADIUS) continue;

      const dropped = (e as any).getDroppedItem?.();
      if (dropped?.name === 'ender_eye' && dist < minDist) {
        targetEntity = e;
        minDist = dist;
      }
    }

    if (!targetEntity) return false;

    const tPos = targetEntity.position;
    log.info(
      `👁️ エンダーアイ落下検出 (${tPos.x.toFixed(1)}, ${tPos.y.toFixed(1)}, ${tPos.z.toFixed(1)}) → 回収中...`,
    );

    try {
      setMovements(this.bot);
      const goal = new goals.GoalNear(tPos.x, tPos.y, tPos.z, 1.5);
      await gotoSafe(this.bot, goal, { timeoutMs: 8_000, stuckAbortCount: 3, logStuck: false });
      await this.sleep(600);

      if (!this.isEntityAlive(targetEntity)) {
        log.info('👁️ エンダーアイ回収成功');
        return true;
      }

      // まだ残っている場合、もう少し近づく
      const pos2 = targetEntity.position;
      await gotoSafe(
        this.bot,
        new goals.GoalNear(pos2.x, pos2.y, pos2.z, 0.5),
        { timeoutMs: 3_000, stuckAbortCount: 2, logStuck: false },
      );
      await this.sleep(400);

      const picked = !this.isEntityAlive(targetEntity);
      if (picked) log.info('👁️ エンダーアイ回収成功');
      else log.warn('👁️ エンダーアイに近づいたが回収できず');
      return picked;
    } catch (err) {
      log.warn(`👁️ エンダーアイ回収移動失敗: ${err}`);
      return false;
    }
  }

  private isEntityAlive(entity: any): boolean {
    if (!entity || typeof entity.id !== 'number') return false;
    return entity.id in this.bot.entities;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private compass(dx: number, dz: number): string {
    const angle = ((Math.atan2(-dx, dz) * 180 / Math.PI) + 360) % 360;
    const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
    return dirs[Math.round(angle / 45) % 8];
  }

  // ─── 三角測量 ───

  private triangulate(): {
    x: number;
    z: number;
    distFromOrigin: number;
    ring: { index: number; min: number; max: number; count: number } | null;
    confidence: string | null;
  } | null {
    if (this.throws.length < 2) return null;

    if (this.throws.length === 2) {
      return this.intersectTwoRays(this.throws[0], this.throws[1]);
    }

    const intersections: { x: number; z: number }[] = [];
    for (let i = 0; i < this.throws.length; i++) {
      for (let j = i + 1; j < this.throws.length; j++) {
        const r = this.intersectTwoRays(this.throws[i], this.throws[j]);
        if (r) intersections.push({ x: r.x, z: r.z });
      }
    }
    if (intersections.length === 0) return null;

    intersections.sort((a, b) => a.x - b.x);
    const mx = intersections[Math.floor(intersections.length / 2)].x;
    intersections.sort((a, b) => a.z - b.z);
    const mz = intersections[Math.floor(intersections.length / 2)].z;

    const spread = Math.max(
      ...intersections.map((p) => Math.sqrt((p.x - mx) ** 2 + (p.z - mz) ** 2)),
    );
    const distFromOrigin = Math.sqrt(mx * mx + mz * mz);

    let confidence: string | null = null;
    if (spread < 50) confidence = '高';
    else if (spread < 200) confidence = `中（散布${spread.toFixed(0)}ブロック）`;
    else confidence = `低（散布${spread.toFixed(0)}ブロック）`;

    return { x: mx, z: mz, distFromOrigin, ring: this.findRing(distFromOrigin), confidence };
  }

  private intersectTwoRays(
    a: ThrowRecord,
    b: ThrowRecord,
  ): {
    x: number;
    z: number;
    distFromOrigin: number;
    ring: { index: number; min: number; max: number; count: number } | null;
    confidence: string | null;
  } | null {
    const cross = a.dx * b.dz - a.dz * b.dx;
    if (Math.abs(cross) < 1e-6) return null;

    const t = ((b.x - a.x) * b.dz - (b.z - a.z) * b.dx) / cross;
    if (t < 0) return null;

    const ix = a.x + t * a.dx;
    const iz = a.z + t * a.dz;
    const distFromOrigin = Math.sqrt(ix * ix + iz * iz);

    const throwDist = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
    const angleBetween = Math.abs(Math.asin(Math.min(1, Math.abs(cross)))) * (180 / Math.PI);
    const angleRad = angleBetween * Math.PI / 180;
    const estimatedError = angleRad > 0.001
      ? Math.round(distFromOrigin * 0.005 / Math.sin(angleRad))
      : 9999;

    let confidence: string | null;
    if (estimatedError < 80) {
      confidence = `高（誤差±${estimatedError}ブロック推定, ベースライン${throwDist.toFixed(0)}m, 角度差${angleBetween.toFixed(1)}°）`;
    } else if (estimatedError < 250) {
      confidence = `中（誤差±${estimatedError}ブロック推定, ベースライン${throwDist.toFixed(0)}m, 角度差${angleBetween.toFixed(1)}°）`;
    } else {
      confidence = `低（誤差±${estimatedError}ブロック推定, ベースライン${throwDist.toFixed(0)}m, 角度差${angleBetween.toFixed(1)}°。追加投擲推奨）`;
    }

    return { x: ix, z: iz, distFromOrigin, ring: this.findRing(distFromOrigin), confidence };
  }

  // ─── 単投推定 ───

  private estimateFromRay(t: ThrowRecord): string {
    const px = t.x, pz = t.z;
    const ddot = t.dx * t.dx + t.dz * t.dz;
    const pdot = px * t.dx + pz * t.dz;
    const p2 = px * px + pz * pz;

    const results: string[] = [];

    for (let i = 0; i < STRONGHOLD_RINGS.length; i++) {
      const ring = STRONGHOLD_RINGS[i];
      const rMid = (ring.min + ring.max) / 2;

      const disc = pdot * pdot - ddot * (p2 - rMid * rMid);
      if (disc < 0) continue;

      const sqrtDisc = Math.sqrt(disc);
      const t1 = (-pdot - sqrtDisc) / ddot;
      const t2 = (-pdot + sqrtDisc) / ddot;
      const tVal = t1 > 0 ? t1 : t2 > 0 ? t2 : null;
      if (tVal === null || tVal < 0) continue;

      const sx = px + t.dx * tVal;
      const sz = pz + t.dz * tVal;

      results.push(
        `リング${i + 1}: ≈(${sx.toFixed(0)}, ${sz.toFixed(0)}) [${tVal.toFixed(0)}ブロック先, 誤差±${((ring.max - ring.min) / 2).toFixed(0)}]`,
      );
      if (results.length >= 2) break;
    }

    if (results.length === 0) return '単投推定: リング候補なし';
    return `単投推定（参考）: ${results.join(' / ')}`;
  }

  // ─── ユーティリティ ───

  private findRing(
    dist: number,
  ): { index: number; min: number; max: number; count: number } | null {
    for (let i = 0; i < STRONGHOLD_RINGS.length; i++) {
      const r = STRONGHOLD_RINGS[i];
      if (dist >= r.min - 200 && dist <= r.max + 200) {
        return { index: i + 1, min: r.min, max: r.max, count: r.count };
      }
    }
    return null;
  }

  private doCalculate(): SkillResult {
    if (this.throws.length < 2) {
      return { success: false, result: `投擲データが${this.throws.length}件です。最低2回必要。` };
    }
    const tri = this.triangulate();
    if (!tri) {
      return { success: false, result: '三角測量に失敗。投擲方向がほぼ平行です。' };
    }
    const botPos = this.bot.entity.position;
    const distFromBot = Math.sqrt(
      (tri.x - botPos.x) ** 2 + (tri.z - botPos.z) ** 2,
    );
    let resultText =
      `🎯 要塞座標: X=${tri.x.toFixed(0)}, Z=${tri.z.toFixed(0)}` +
      `\n現在地からの距離: ${distFromBot.toFixed(0)}ブロック` +
      `\n原点からの距離: ${tri.distFromOrigin.toFixed(0)}ブロック`;
    if (tri.ring) resultText += `\nリング${tri.ring.index} (${tri.ring.min}–${tri.ring.max}, ${tri.ring.count}個)`;
    if (tri.confidence) resultText += `\n信頼度: ${tri.confidence}`;
    resultText += `\nチャンク中心: (${(Math.floor(tri.x / 16) * 16 + 8).toFixed(0)}, ${(Math.floor(tri.z / 16) * 16 + 8).toFixed(0)})`;
    return { success: true, result: resultText };
  }

  private showStatus(): SkillResult {
    if (this.throws.length === 0) {
      return { success: true, result: '投擲データなし。"throw" でエンダーアイを投げてください。' };
    }
    const lines = this.throws.map(
      (t, i) => `#${i + 1}: (${t.x.toFixed(1)}, ${t.z.toFixed(1)}) → ${t.angleDeg.toFixed(1)}°`,
    );
    let text = `投擲データ ${this.throws.length}件:\n${lines.join('\n')}`;
    if (this.throws.length >= 2) {
      const tri = this.triangulate();
      if (tri) text += `\n\n🎯 推定: X=${tri.x.toFixed(0)}, Z=${tri.z.toFixed(0)}`;
    }
    return { success: true, result: text };
  }
}

export default TriangulateStronghold;
