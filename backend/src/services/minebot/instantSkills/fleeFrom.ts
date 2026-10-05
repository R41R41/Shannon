import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { setMovements } from '../utils/setMovements.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { isHostileEntity } from '../utils/hostileMobHints.js';
import { isExposedTo } from '../utils/threatExposure.js';
import { escapeMayWork } from '../utils/escapeHeading.js';
const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:fleeFrom');
type FleeTarget = { position: Vec3; name: string; id?: number; /** The live hostile, when the target is one: its exposure is judged from it. */ entity?: any };
const ESCAPE_DIRECTIONS = 16;
const MAX_ESCAPE_WAYPOINTS = 16;
const MAX_WAYPOINT_TIME_MS = 5_000;
const MIN_PHYSICAL_PROGRESS = 0.75;
/** How close to a pursuer a way out may pass: a creeper starts its fuse at three blocks, most others strike from there. */
const PASS_CLEARANCE = 3;
/** How fast a pursuer is taken to close in (blocks a second; zombies and creepers walk about 2.3 when chasing), and the body to run. */
const PURSUER_SPEED = 2.5;
const RUN_SPEED = 5.6;
/** The longest the search for each way out may take, and how many are looked at before it says there is none. */
const ROUTE_CHECK_MS = 250;
const MAX_ROUTE_CHECKS = 6;

/**
 * Where on a route a pursuer could be met: the first point it could reach before the body has run past it, with the
 * pursuer coming straight at it from where it is now. A way out of a dead-end gallery runs back past what is coming
 * down it; ranked by where it ends, that was the "escape", and the body sprinted into a creeper's blast (paid run L84,
 * mining iron: 38 minutes, one death, the run over).
 */
export function routeMeetsPursuer(start: Vec3, path: Array<{ x: number; y: number; z: number }>, pursuers: Array<{ position: Vec3; name: string }>)
  : { name: string; at: Vec3; distance: number } | null {
  let run = 0;
  let previous = start;
  for (const node of path) {
    const at = new Vec3(node.x, node.y, node.z);
    run += previous.distanceTo(at);
    previous = at;
    const seconds = run / RUN_SPEED;
    for (const pursuer of pursuers) {
      const now = start.distanceTo(pursuer.position);
      const reach = Math.min(PASS_CLEARANCE, Math.max(0, now - 0.5)) + PURSUER_SPEED * seconds;
      if (at.distanceTo(pursuer.position) < reach && at.distanceTo(pursuer.position) < now) {
        return { name: pursuer.name, at, distance: now };
      }
    }
  }
  return null;
}

type EscapeWaypoint = { x: number; z: number; score: number };

/** Rank finite retreat points by clearance at the end and along a direct approach. */
function escapeWaypoints(position: Vec3, targets: FleeTarget[], distance: number): EscapeWaypoint[] {
  const nearest = targets.reduce((value, target) =>
    Math.min(value, position.distanceTo(target.position)), Infinity);
  const step = Math.min(24, Math.max(8, distance - nearest + 3));
  const waypoints: EscapeWaypoint[] = [];

  for (let index = 0; index < ESCAPE_DIRECTIONS; index++) {
    const angle = (index * 2 * Math.PI) / ESCAPE_DIRECTIONS;
    const x = Math.floor(position.x + Math.cos(angle) * step);
    const z = Math.floor(position.z + Math.sin(angle) * step);
    const dx = x - position.x;
    const dz = z - position.z;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq < 1) continue;

    let endClearance = Infinity;
    let directRouteClearance = Infinity;
    for (const target of targets) {
      const enemy = target.position;
      endClearance = Math.min(endClearance,
        Math.hypot(x - enemy.x, position.y - enemy.y, z - enemy.z));
      const fraction = Math.max(0, Math.min(1,
        ((enemy.x - position.x) * dx + (enemy.z - position.z) * dz) / lengthSq));
      directRouteClearance = Math.min(directRouteClearance, Math.hypot(
        position.x + fraction * dx - enemy.x,
        position.y - enemy.y,
        position.z + fraction * dz - enemy.z,
      ));
    }
    waypoints.push({ x, z, score: endClearance + 2 * directRouteClearance });
  }

  return waypoints.sort((a, b) => b.score - a.score);
}

/**
 * 原子的スキル: エンティティ・座標・敵対Mob群から逃げる
 * 有限の退避地点を複数試し、現在の対象との安全距離を確認する
 */
class FleeFrom extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'flee-from';
    this.description =
      '指定したエンティティ、座標、または敵対Mob全体から逃げます。安全な距離まで離れます。';
    this.params = [
      {
        name: 'target',
        type: 'string',
        description:
          '逃げる対象。"hostile"/"all-hostiles"（敵対Mob全体）、エンティティ名（例: "zombie", "Player123"）、または座標（例: "100,64,200"）',
      },
      {
        name: 'minDistance',
        type: 'number',
        description: '最低限離れる距離（ブロック数、デフォルト: 32）',
        default: 32,
      },
      {
        name: 'timeout',
        type: 'number',
        description: 'タイムアウト時間（ミリ秒、デフォルト: 10000=10秒）',
        default: 10000,
      },
      {
        name: 'entityName',
        type: 'string',
        description: '（非推奨）targetと同じ。後方互換性のため残しています。',
      },
    ];
  }

  async runImpl(
    target: string,
    minDistance: number = 32,
    timeout: number = 10000,
    entityName?: string // 後方互換性のため
  ) {
    // entityNameが渡された場合はtargetとして使用（後方互換性）
    const actualTarget = target || entityName;
    const hostileGroup = /^(hostile|all-hostiles)$/i.test(actualTarget?.trim() || '');
    let initialDistance: number | null = null;

    try {

      if (!actualTarget) {
        return {
          success: false,
          result: '逃げる対象を指定してください（target引数にエンティティ名または座標を指定）',
        };
      }

      // 敵対Mob群は既存の接近検知と同じ分類で全体を評価する。
      const everyTarget = this.resolveTargets(actualTarget, hostileGroup);
      // Only what can see or reach the body is fled from. With rock all round between them there is
      // nowhere to flee to and no need: six such orders in a row moved 0 m underground (paid run L33).
      const targets = everyTarget.filter(target => !target.entity || isExposedTo(this.bot as any, target.entity));
      const sealedNear = everyTarget.filter(target => !targets.includes(target)
        && this.bot.entity.position.distanceTo(target.position) < minDistance);
      if (sealedNear.length && !targets.some(target => this.bot.entity.position.distanceTo(target.position) < minDistance)) {
        const nearest = sealedNear.reduce((a, b) => this.bot.entity.position.distanceTo(a.position) <= this.bot.entity.position.distanceTo(b.position) ? a : b);
        return { success: true,
          result: `逃げる必要はありません: ${sealedNear.map(target => target.name).join('、')}は固体ブロックで隔てられていて、視線も通路もありません`
            + `（最も近い${nearest.name}まで${this.bot.entity.position.distanceTo(nearest.position).toFixed(1)}m）。`
            + 'このまま作業を続けられます。壁を掘り抜くと届くようになるので、その方向へ掘る時だけ注意してください' };
      }

      if (!hostileGroup && everyTarget.length === 0) {
        return {
          success: false,
          result: `"${actualTarget}"が見つかりません`,
        };
      }

      const name = hostileGroup ? '敵対Mob全体' : targets[0].name;
      const pursuers = new Set(targets.map(target => target.id).filter((id): id is number => id != null));
      const currentDistance = this.nearestDistance(targets);
      initialDistance = currentDistance;

      if (targets.length === 0) {
        return { success: true, result: '近くに敵対Mobは見当たりません' };
      }

      if (currentDistance >= minDistance) {
        return {
          success: true,
          result: `既に${name}から十分離れています（最短距離: ${currentDistance.toFixed(
            1
          )}m）`,
        };
      }

      // Routes that avoid water and do not dig (slow). Climbing by laying blocks is for when nothing is
      // near enough to arrive while the body stands still (see escapeMayWork); set again for each leg.
      const configure = (nearest: number) => setMovements(
        this.bot,
        escapeMayWork(nearest), // allow1by1towers
        true, // allowSprinting: 逃げるときはダッシュ
        false, // allowParkour: 崖飛び越えを避ける
        true, // canOpenDoors
        false, // canDig: 逃げるときは掘らない（遅い）
        true, // dontMineUnderFallingBlock
        100, // digCost: 掘るコストを高く（避ける）
        false, // allowFreeMotion: 水中移動は遅いので避ける
        false, // canSwim: 水を避けて逃げる（水中は危険）
        2, // maxDropDown
        10, // liquidCost
        escapeMayWork(nearest) // canPlace: a bridge is laid crouching backward at a crawl (paid run L110)
      );

      log.info(`🏃 ${name}から逃走開始（目標距離: ${minDistance}ブロック以上）`);

      // GoalInvert / GoalCompositeAll<GoalInvert> は終点が無限に広く、
      // pathfinder が空経路を「成功」と返しても一歩も逃げられない。
      // 対象が単体でも群でも有限の退避地点を使い、実位置と現在の対象を検証する。
      const deadline = Date.now() + timeout;
      let finalTargets = targets;
      let finalDistance = currentDistance;
      let fleeResult: Awaited<ReturnType<typeof gotoSafe>> = { success: false, error: 'timeout' };
      const attemptedWaypoints = new Set<string>();
      let traveled = 0;
      let routesChecked = 0;
      const cutOff: string[] = [];

      for (let attempt = 0; attempt < MAX_ESCAPE_WAYPOINTS; attempt++) {
        const remaining = Math.max(0, deadline - Date.now());
        if (remaining <= 0) break;

        const beforeBotPosition = this.bot.entity.position.clone();
        const waypoint = escapeWaypoints(beforeBotPosition, finalTargets, minDistance)
          .find(({ x, z }) => !attemptedWaypoints.has(`${x},${z}`));
        if (!waypoint) break;
        attemptedWaypoints.add(`${waypoint.x},${waypoint.z}`);
        configure(finalDistance);
        // XZ goal permits a safe terrain height without requiring the target's Y.
        const fleeGoal = new goals.GoalNearXZ(waypoint.x, waypoint.z, 2);
        // The route itself, before a step is run along it: one that passes where a pursuer gets to first is no way out.
        // Every hostile counts here, not only the one named: fleeing a hoglin, the body ran into two piglins (L88b).
        const around = hostileGroup ? [] : this.resolveTargets('hostile', true).filter(other => !finalTargets.some(target => target.id === other.id));
        const exposed = [...finalTargets, ...around].filter(target => !target.entity || isExposedTo(this.bot as any, target.entity));
        if (typeof (this.bot.pathfinder as any).getPathTo === 'function' && exposed.length && routesChecked < MAX_ROUTE_CHECKS) {
          routesChecked++;
          let route: Array<{ x: number; y: number; z: number }> = [];
          try { route = (this.bot.pathfinder as any).getPathTo((this.bot.pathfinder as any).movements, fleeGoal, ROUTE_CHECK_MS)?.path ?? []; } catch { route = []; }
          const met = routeMeetsPursuer(beforeBotPosition, route, exposed);
          if (met) {
            cutOff.push(`${met.name}（いま${met.distance.toFixed(1)}m）のそば (${Math.floor(met.at.x)},${Math.floor(met.at.y)},${Math.floor(met.at.z)})`);
            if (routesChecked >= MAX_ROUTE_CHECKS || !escapeWaypoints(beforeBotPosition, finalTargets, minDistance).some(({ x, z }) => !attemptedWaypoints.has(`${x},${z}`))) break;
            continue;
          }
        }
        try {
          fleeResult = await gotoSafe(this.bot, fleeGoal, {
            timeoutMs: Math.min(remaining, MAX_WAYPOINT_TIME_MS),
            stuckAbortCount: 4,
          });
        } finally {
          // goto() can resolve on an empty partial path while its goal is still
          // active. Clear only our goal before replanning or releasing ownership.
          this.clearFleeGoal(fleeGoal);
        }

        // Mob は移動し、新しい敵も現れるため、現在の全対象で事後条件を確認する。
        finalTargets = this.resolveTargets(actualTarget, hostileGroup);
        finalDistance = this.nearestDistance(finalTargets);
        traveled += beforeBotPosition.distanceTo(this.bot.entity.position);
        if (finalDistance >= minDistance) {
          return {
            success: true,
            result: `${name}から逃げました（最短距離: ${currentDistance.toFixed(1)}m → ${Number.isFinite(finalDistance) ? `${finalDistance.toFixed(1)}m` : '視界外'}、自分の移動: ${traveled.toFixed(0)}m）`,
          };
        }
        // 有限の退避点でも到達不可や空経路があり得るので次の方向を試す。
      }

      if (cutOff.length && traveled < MIN_PHYSICAL_PROGRESS) {
        return {
          success: false, failureType: 'no_escape_route', recoverable: true,
          result: `逃げ道がありません: 調べた${cutOff.length}本の逃げ道はどれも、追ってくる相手が先に着く所を通ります（${[...new Set(cutOff)].slice(0, 3).join('、')}）。`
            + '行き止まりの通路などで、走ればそちらへ突っ込みます。走らずに、その場で相手との間を塞ぐ（build-around-self の slit_shelter、手元のブロックを置く）か、dig-shelter で入ってください',
        };
      }
      return {
        success: false,
        result: `逃走未完了: ${traveled < MIN_PHYSICAL_PROGRESS && fleeResult.success ? '経路は終了しましたが実際には移動していません' : fleeResult.success ? '安全距離に達していません' : this.failureReason(fleeResult.error)}。${name}との最短距離: ${currentDistance.toFixed(1)}m → ${finalDistance.toFixed(1)}m（目標: ${minDistance}m、近くの対象: ${finalTargets.filter(({ position }) => this.bot.entity.position.distanceTo(position) < minDistance).length}体、自分の移動: ${traveled.toFixed(0)}m）${this.newcomerNote(pursuers, finalTargets, currentDistance)}`,
      };
    } catch (error: any) {
      const errorDetail = this.failureReason(error instanceof Error ? error.message : String(error));
      const finalTargets = actualTarget ? this.resolveTargets(actualTarget, hostileGroup) : [];
      const finalDistance = this.nearestDistance(finalTargets);
      if (initialDistance !== null && finalDistance >= minDistance) {
        return {
          success: true,
          result: `${hostileGroup ? '敵対Mob全体' : actualTarget}から逃げました（最短距離: ${initialDistance.toFixed(1)}m → ${Number.isFinite(finalDistance) ? `${finalDistance.toFixed(1)}m` : '視界外'}）`,
        };
      }

      return {
        success: false,
        result: `逃走失敗: ${errorDetail}${initialDistance !== null && Number.isFinite(finalDistance) ? `（最短距離: ${initialDistance.toFixed(1)}m → ${finalDistance.toFixed(1)}m、目標: ${minDistance}m）` : ''}`,
      };
    }
  }

  /**
   * "Nearest hostile 15.6m → 12.7m" read as a failed escape when the two
   * original pursuers had been left behind and a third had walked up from
   * elsewhere (paid run L18, at night). Say which of the two happened.
   */
  private newcomerNote(pursuers: Set<number>, now: FleeTarget[], initialDistance: number): string {
    if (pursuers.size === 0 || now.length === 0) return '';
    const distance = (target: FleeTarget) => this.bot.entity.position.distanceTo(target.position);
    const nearest = now.reduce((a, b) => distance(a) <= distance(b) ? a : b);
    if (nearest.id == null || pursuers.has(nearest.id)) return '';
    const original = now.filter(target => target.id != null && pursuers.has(target.id));
    const left = original.length ? `${Math.min(...original.map(distance)).toFixed(1)}m` : '視界外';
    return `。当初の対象からは${initialDistance.toFixed(1)}m → ${left}に離れたが、逃走中に別の${nearest.name}が${distance(nearest).toFixed(1)}mに現れた`;
  }

  private clearFleeGoal(goal: InstanceType<typeof goals.GoalNearXZ>): void {
    // Another controller may have replaced the goal during an await. Never
    // cancel that controller's path when this skill releases its own lease.
    if (this.bot.pathfinder.goal !== goal) return;
    try { this.bot.pathfinder.stop(); } catch { /* best effort */ }
    try { this.bot.pathfinder.setGoal(null); } catch { /* best effort */ }
  }

  private resolveTargets(target: string, hostileGroup: boolean): FleeTarget[] {
    if (!hostileGroup) {
      const resolved = this.resolveTarget(target);
      return resolved ? [resolved] : [];
    }

    return Object.values(this.bot.entities)
      .filter((entity: any) => entity?.position && entity !== this.bot.entity &&
        (entity.id == null || entity.id !== this.bot.entity.id) &&
        isHostileEntity(entity, this.bot as any))
      .map((entity: any) => ({ position: entity.position.clone(), name: String(entity.name), id: typeof entity.id === 'number' ? entity.id : undefined, entity }));
  }

  private nearestDistance(targets: { position: Vec3 }[]): number {
    return targets.reduce((nearest, { position }) =>
      Math.min(nearest, this.bot.entity.position.distanceTo(position)), Infinity);
  }

  private failureReason(error?: string): string {
    if (error === 'no_path' || error?.includes('No path')) {
      return '逃げ道が見つかりません（囲まれているかもしれません）';
    }
    if (error === 'timeout' || error?.includes('timeout')) return 'タイムアウト';
    if (error === 'stuck') return '移動できませんでした';
    return error || '安全距離に達していません';
  }

  /**
   * 対象を解決して位置を取得
   */
  private resolveTarget(
    target: string
  ): FleeTarget | null {
    // 座標形式（x,y,z）かチェック
    const coordMatch = target.match(/^(-?\d+),\s*(-?\d+),\s*(-?\d+)$/);
    if (coordMatch) {
      const x = parseInt(coordMatch[1]);
      const y = parseInt(coordMatch[2]);
      const z = parseInt(coordMatch[3]);
      return {
        position: new Vec3(x, y, z),
        name: `座標(${x}, ${y}, ${z})`,
      };
    }

    // エンティティを検索
    const entity = this.findEntity(target);
    if (entity && entity.position) {
      return {
        position: entity.position.clone(),
        name: entity.name || entity.username || target,
        ...(isHostileEntity(entity, this.bot as any) ? { entity } : {}),
      };
    }

    return null;
  }

  /**
   * 名前でエンティティを検索
   */
  private findEntity(name: string): any | null {
    const lowerName = name.toLowerCase();

    // プレイヤーを検索
    const player = this.bot.players[name]?.entity;
    if (player) {
      return player;
    }

    // 部分一致でプレイヤーを検索
    for (const playerName of Object.keys(this.bot.players)) {
      if (playerName.toLowerCase().includes(lowerName)) {
        const p = this.bot.players[playerName]?.entity;
        if (p) return p;
      }
    }

    // エンティティ（モブなど）を検索
    const entities = Object.values(this.bot.entities) as any[];
    let closestEntity = null;
    let closestDistance = Infinity;

    for (const entity of entities) {
      if (!entity.position || entity === this.bot.entity) continue;

      const entityName = entity.name || entity.username || '';
      if (entityName.toLowerCase().includes(lowerName)) {
        const distance = entity.position.distanceTo(this.bot.entity.position);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestEntity = entity;
        }
      }
    }

    return closestEntity;
  }
}

export default FleeFrom;
