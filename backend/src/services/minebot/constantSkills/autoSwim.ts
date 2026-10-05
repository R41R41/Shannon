import { createLogger } from '../../../utils/logger.js';
import { ConstantSkill, CustomBot } from '../types.js';
import { actionDelay } from '../execution/observedWait.js';
import { Vec3 } from 'vec3';
import { holdsWater } from '../utils/waterBlocks.js';
import { airRunningOut, centreInColumn, markSurfacingStalled, retraceFeasible, retraceWaypoint, steerAlongRoute, steerToward, surfacingStalled, swimRouteFeasible, swimRouteToAir } from '../utils/breathingReflex.js';
import { eyeHeight } from '../utils/bodyPose.js';

const STALL_MS = 1500;

const log = createLogger('Minebot:Skill:autoSwim');

const isSolid = (block: any) => !!block && block.boundingBox === 'block';
const isPassable = (block: any) => !!block && block.boundingBox !== 'block';

/**
 * Nearest column (within 4 blocks) where swimming up from head level reaches
 * air without hitting a solid block, and whose cell at head level is not
 * walled off. Swimming straight up under a single block at the waterline left
 * a paid run bobbing below it until it drowned, with open air one block away.
 * A view of the water's shape only: whether the body can get there is asked of
 * routeToAir, which the surfacing reflexes steer by.
 */
export function nearestOpenSurface(bot: { blockAt(position: Vec3): any }, head: Vec3, radius = 4, maxRise = 8): Vec3 | null {
  let best: { at: Vec3; distance: number } | null = null;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const distance = Math.hypot(dx, dz);
      if (distance > radius || (best && distance >= best.distance)) continue;
      const column = head.offset(dx, 0, dz);
      if (!isPassable(bot.blockAt(column))) continue;
      for (let rise = 0; rise <= maxRise; rise++) {
        const block = bot.blockAt(column.offset(0, rise, 0));
        if (!block || isSolid(block)) break;
        if (!holdsWater(block)) { best = { at: column.offset(0, rise, 0), distance }; break; }
      }
    }
  }
  return best?.at ?? null;
}

/** The head cell itself or the one above it is solid: straight up is closed. */
export function ceilingOverhead(bot: { blockAt(position: Vec3): any }, head: Vec3): boolean {
  return isSolid(bot.blockAt(head)) || isSolid(bot.blockAt(head.offset(0, 1, 0)));
}

/**
 * Whether swimming can reach air at all from here: straight up, or sideways
 * to open water within reach. Under an ice sheet it cannot, and a skill that
 * held jump against the ice kept the body from the only thing that helps,
 * breaking the ice overhead, until the bot drowned (paid run L25).
 */
export function surfacingPossible(bot: { blockAt(position: Vec3): any; entity?: { position: Vec3 } }): boolean {
  const position = bot.entity?.position;
  if (!position) return true;
  const head = position.offset(0, eyeHeight(bot as any), 0).floored();
  if (surfacingStalled(bot)) return false;
  try { return !ceilingOverhead(bot, head) || retraceFeasible(bot as any) || swimRouteFeasible(bot as any); } catch { return true; }
}

/**
 * 自動浮上スキル
 * 水中で酸素が半分以下になったら自動で水面に浮上する
 */
class AutoSwim extends ConstantSkill {
  private isSwimmingUp: boolean = false;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-swim';
    this.description = '水中で酸素が減ったら自動で浮上する（溺死防止）';
    this.interval = 100;  // 100msごとにチェック（高速反応）
    this.status = true;   // デフォルトでON
    this.priority = 10;   // 最高優先度
    this.containMovement = true;
    this.isCritical = true; // InstantSkill実行中でも動作する（生存スキル）
  }

  async runImpl(forceSurface = false) {
    try {
      // auto-followがアクティブな場合はスキップ（AutoFollowのswim()が酸素管理も行う）
      const autoFollow = this.bot.constantSkills.getSkill('auto-follow');
      if (autoFollow && autoFollow.status && autoFollow.isLocked
        && !forceSurface && !this.shouldPreempt()) {
        // AutoFollowが水中移動中なので、そちらに任せる
        if (this.isSwimmingUp) {
          this.isSwimmingUp = false;
          this.bot.setControlState('jump', false);
        }
        return;
      }

      const oxygen = this.bot.oxygenLevel ?? 20;
      const isInWater = (this.bot.entity as any)?.isInWater || false;

      // 水中かつ酸素が半分以下（10未満）→ 浮上開始。The way to air may be longer than half the
      // air covers (back along a tunnel, out from under a ceiling): then it starts as soon as the air is short for it.
      if (isInWater && (oxygen < 10 || forceSurface && oxygen < 20 || this.airShortForTheWay()) && !this.isSwimmingUp && surfacingPossible(this.bot)) {
        log.info(`🏊 自動浮上開始！酸素: ${oxygen}/20`, 'cyan');
        this.isSwimmingUp = true;
      }

      // 浮上中は酸素が完全回復（20）するまで継続
      let progress: { from: Vec3; at: number } | null = null;
      while (this.isSwimmingUp) {
        if (!surfacingPossible(this.bot)) {
          log.warn('🏊 頭上が塞がれ、近くに開いた水面も無い: 浮上では空気に届かないので身体を返す');
          this.isSwimmingUp = false;
          this.bot.setControlState('jump', false);
          this.bot.setControlState('forward', false);
        } else if ((this.bot.oxygenLevel ?? 20) >= 20) {
          // 完全回復したら停止
          log.success('🏊 浮上完了！酸素完全回復: 20/20');
          this.isSwimmingUp = false;
          this.bot.setControlState('jump', false);
          this.bot.setControlState('forward', false);
        } else {
          // まだ回復してない → 浮上継続。The jump key is set once, by the branch below that steers: pressed here and
          // let go by the steering in the same pass, it still counted as a press (the client queues it), and a
          // body that had to dive under a shelf to reach the air was kicked up against the roof on every pass
          // (paid run L66 drowned six cells from air).
          const currentPos = this.bot.entity.position;
          const head = currentPos.offset(0, eyeHeight(this.bot as any), 0).floored();
          let route: Vec3[] | null = null;
          let ceiling = false;
          try {
            ceiling = ceilingOverhead(this.bot, head);
            if (ceiling) route = swimRouteToAir(this.bot as any);
          } catch { /* an unreadable world must not stop surfacing: keep swimming straight up */ }
          // The body must be seen to move: pushing at a wall or a rim is not surfacing.
          if (!progress) progress = { from: currentPos.clone(), at: Date.now() };
          else if (currentPos.distanceTo(progress.from) >= 0.3) progress = { from: currentPos.clone(), at: Date.now() };
          else if (Date.now() - progress.at >= STALL_MS) {
            log.warn('🏊 天井の下で浮上が進まない: 泳いでは空気に届かないので身体を返し、頭上を掘って出る');
            markSurfacingStalled(this.bot);
            continue;
          }
          const back = ceiling && !route?.length && retraceFeasible(this.bot as any) ? retraceWaypoint(this.bot as any) : null;
          if (route?.length) {
            // A ceiling over the head: swim, cell by cell, the way the body fits through to air.
            steerAlongRoute(this.bot as any, route);
          } else if (back) {
            // No air within the search's reach: the way it came is the way that is open.
            steerToward(this.bot as any, back);
          } else {
            // Straight up, from under the middle of the column (a hole one block wide catches a shoulder).
            this.bot.setControlState('jump', true);
            centreInColumn(this.bot as any);
          }
          await actionDelay(this.bot, 100);
        }
      }
    } catch (error) {
      log.error('autoSwimエラー', error);
    } finally {
      this.isSwimmingUp = false;
      // Root cancellation already contains controls; normal completion releases jump.
      try { this.bot.setControlState('jump', false); this.bot.setControlState('forward', false); this.bot.setControlState('sneak', false); } catch { /* cancelled motor port */ }
    }
  }

  private airShortForTheWay(): boolean {
    try { return airRunningOut(this.bot as any); } catch { return false; }
  }

  protected shouldPreempt(): boolean {
    return (Boolean((this.bot.entity as any)?.isInWater && ((this.bot.oxygenLevel ?? 20) < 10 || this.airShortForTheWay())) && surfacingPossible(this.bot)) || this.isSwimmingUp;
  }
}

export default AutoSwim;
