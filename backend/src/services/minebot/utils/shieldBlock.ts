import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { BALL_NAME, advance, type BallTrack } from './fireballDeflect.js';
import { installToldVelocity, toldVelocity } from './toldVelocity.js';
import { answerWith } from './reflexAnswers.js';
import { isEngaged } from './engagement.js';
import { isLikelyHostileMobName } from './hostileMobHints.js';
import { reservationOf, shieldPort } from '../execution/ActionExecution.js';

const log = createLogger('Minebot:ShieldBlock');

/**
 * Raising the shield at what is flying at the body.
 *
 * Most of what has killed the body from afar was shot at it: a skeleton's arrows (paid runs L77c to L77g, and
 * the overworld's nights before them), a blaze's fireballs (L77j, L77k, L77l). A shield stops all of these
 * whole, and the body that carried one never raised it: blocking was a tool call for the planner, and an arrow
 * is in the air for half a second. Like the ghast's ball, this is no plan, it is a reflex.
 *
 * Each tick the things in flight are followed. The server speaks of a projectile when it is shot (where, and
 * how fast) and then seldom, so from its last word each is carried forward here by the game's own rule for its
 * kind: an arrow keeps 99% of its speed and falls a twentieth of a block a tick; a fireball gains a tenth along
 * its path and keeps 95%. One that will pass within reach of the body is met: the look goes to it (a shield
 * stops what comes from in front), the body stops walking so that the look does not carry it off, and the
 * shield is raised. The server counts a shield as up five ticks after it is raised, so it goes up as soon as
 * the shot is seen to be coming, and comes down a few ticks after the last one has passed.
 *
 * Only with a shield in the off hand (the body puts one it carries there itself, see auto-wear-armor). A
 * ghast's ball is left to the reflex that strikes it back, while that one is on.
 *
 * And in a fight the planner chose, between the body's own blows: a hostile within a blow's reach is met with
 * the shield up, and the body strikes from behind it (a blow lands with the shield raised: lab, 2026-11-03). Two wither skeletons took an iron-clad body from full health to dead in sixteen
 * seconds while its shield hung on its arm (lab). Not outside such a fight: a raised shield slows the body to
 * a crawl, and one running away needs its legs.
 */
/** Ticks ahead a shot is followed. A skeleton's arrow from sixteen blocks takes ten. */
const LOOK_AHEAD_TICKS = 24;
/** How near the body's middle a shot has to pass to be taken as coming at it. */
const HIT_DISTANCE = 1.6;
/**
 * How long before a shot arrives the shield goes up. The server counts it as up after five ticks; the rest is
 * margin. Not sooner: while it is up the look and the legs are the shield's, and a slow fireball seen a second
 * and more ahead held a body that was digging itself a shelter (lab continuation L77r).
 */
const RAISE_AHEAD_TICKS = 12;
/** Ticks the shield stays up after nothing more is coming (a blaze shoots three in a second). */
const HOLD_TICKS = 6;
const BODY_MIDDLE = 0.9;
const HORIZONTAL = ['forward', 'back', 'left', 'right', 'sprint'] as const;
/** Things in flight that are no attack: what the body throws, and what only looks like a shot. */
/** How near a hostile has to stand for the shield to be kept up between blows. */
const GUARD_DISTANCE = 4;
const HARMLESS = new Set(['ender_pearl', 'eye_of_ender', 'experience_bottle', 'egg', 'snowball', 'fishing_bobber', 'firework_rocket', 'splash_potion', 'lingering_potion']);

/** A shot one tick on, by the game's rule for its kind. */
export function flyOn(kind: string, shot: BallTrack): BallTrack {
  if (kind.includes('fireball') || kind === 'wither_skull') return advance(shot);
  const position = shot.position.plus(shot.velocity);
  return { position, velocity: new Vec3(shot.velocity.x * 0.99, shot.velocity.y * 0.99 - 0.05, shot.velocity.z * 0.99) };
}

/** Whether a shot will pass through the body, and in how many ticks. */
export function impact(body: Vec3, kind: string, shot: BallTrack): { ticks: number; distance: number } | null {
  const middle = body.offset(0, BODY_MIDDLE, 0);
  let track = shot, nearest = Infinity, at = 0;
  for (let tick = 0; tick <= LOOK_AHEAD_TICKS; tick++) {
    // Between two ticks the shot covers a block or more: the nearest point of that step, not only its ends.
    const step = track.velocity, to = middle.minus(track.position);
    const along = step.norm() > 0.001 ? Math.max(0, Math.min(1, to.dot(step) / step.dot(step))) : 0;
    const distance = track.position.plus(step.scaled(along)).distanceTo(middle);
    if (distance < nearest) { nearest = distance; at = tick + along; }
    if (distance > nearest + 3) break;
    track = flyOn(kind, track);
  }
  return nearest <= HIT_DISTANCE ? { ticks: at, distance: nearest } : null;
}

/** The kind of mob standing where a shot began (a shot leaves from its shooter), or null when nothing stood there. */
export function shooterAt(bot: Pick<ShieldBot, 'entities' | 'entity'>, origin: Vec3, shotId: number): string | null {
  let nearest: string | null = null, nearestDistance = 6;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity?.position || !entity.name || entity.id === shotId || entity.id === bot.entity?.id) continue;
    if (['projectile', 'object', 'orb', 'other', 'global'].includes(String(entity.type))) continue;
    const distance = entity.position.offset(0, (entity.height ?? 1.8) / 2, 0).distanceTo(origin);
    if (distance < nearestDistance) { nearest = String(entity.name).toLowerCase(); nearestDistance = distance; }
  }
  return nearest;
}

/** Whether something hostile stands within a blow's reach of the body. */
function hostileInReach(bot: ShieldBot): boolean {
  const at = bot.entity?.position;
  if (!at) return false;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity?.position || entity.id === bot.entity?.id || entity.type === 'projectile') continue;
    if (entity.type !== 'hostile' && !isLikelyHostileMobName(String(entity.name ?? '').toLowerCase())) continue;
    if (entity.position.distanceTo(at) <= GUARD_DISTANCE) return true;
  }
  return false;
}

interface ShieldBot {
  _client?: { on(event: string, listener: (...args: any[]) => void): unknown };
  entity?: { id?: number; position: Vec3 };
  entities?: Record<string, any>;
  health?: number;
  inventory?: { slots: Array<{ name: string; durabilityUsed?: number; maxDurability?: number; slot?: number } | null | undefined> };
  registry?: { version?: { '>='(version: string): boolean }; itemsByName?: { shield?: { maxDurability?: number } } };
  getEquipmentDestSlot?(destination: string): number;
  look?(yaw: number, pitch: number, force?: boolean): unknown;
  attack?(...args: unknown[]): unknown;
  activateItem?(offHand?: boolean): unknown;
  deactivateItem?(): unknown;
  getControlState?(control: string): boolean;
  setControlState?(control: string, state: boolean): void;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  usingHeldItem?: boolean;
  fireballDeflect?: { enabled: boolean };
  shieldBlock?: ShieldBlockState;
}
/** `raised` counts the times the shield went up; `upTicks` the ticks it was held. */
export interface ShieldBlockState { enabled: boolean; guard: boolean; raised: number; guards: number; upTicks: number; up: boolean; last?: string;
  /** Server-confirmed blocks (source unspecified), and small_fireball damage confirmed by a health fall; never raise/trajectory guesses. */
  shieldCaught?: number; shieldMissed?: number;
  /** サーバーのslot更新と左手の破損通知で確かめた摩耗の累計。持ち替え・死亡でも戻さない。 */
  shieldWear?: number;
  /** A-6 (2, 9): the times the shield was lowered, and the times `deactivateItem` was called on the body; the handover's "kept" is read from these. */
  lowered?: number; deactivateCalls?: number }

/**
 * Continue contracts (4): the shield's right belongs to the owner of the body (the root action that moves it). While an owner has delegated the
 * shield (a fight, an attack, a handover) the resident shield raises and lowers it through that owner's motor port: an owner that has lapsed
 * refuses it. With no owner delegating, the resident shield acts on its own as before.
 */
function shieldHand(bot: ShieldBot): ShieldBot { return (shieldPort(bot as object) as ShieldBot | null) ?? bot; }
/** The reflex's cap was told a moment ago and the shield it had up goes on for a short while (floorReflexes bridge). */
function bridgeHoldsShield(bot: ShieldBot): boolean {
  const bridge = (bot as { floorReflexes?: { bridge?: { hold?: string; until?: number } } }).floorReflexes?.bridge;
  return !!bridge && bridge.hold === 'shield' && Date.now() < (bridge.until ?? 0);
}

export function installShieldBlock(bot: ShieldBot): void {
  if (bot.shieldBlock || typeof bot.on !== 'function') return;
  const state: ShieldBlockState = bot.shieldBlock = { enabled: true, guard: true, raised: 0, guards: 0, upTicks: 0, up: false, shieldCaught: 0, shieldMissed: 0, shieldWear: 0 };
  // 1.21.5以降は blocks_attacks.block_sound（公式1.21.5更新履歴）。1.21.11のEntityEventには盾の29/30が無く、
  // 受けた本人にも sound_effect が届く（位置は1/8マス単位）。mineflayerのsoundEffectHeardは使わない：
  // node-minecraft-protocolは音のholder idを n-1 で返すが、minecraft-data 1.21.11のsoundsは1始まりで、
  // registry.sounds[soundId] は1つ手前の音（item.shield.block の手前は block.shelf.take_item）を指しうる。
  // 生のpacketで soundId と soundId+1 のどちらかが item.shield.block なら数え、どちらで合ったかを1度だけ記録する
  // （ネザーで足元に棚の音は鳴らない。ずれが無い版では +1 側に盾の割れる音 item.shield.break が入りうる）。
  // 体は走りながら受けるのでサーバーの位置と1〜2tickずれる。足元0.6マス内の成功音だけを数える。
  // 音に攻撃元は無いので種別不明のまま。軌道・構え・摩耗を受けた回数にはしない。
  const blockSound = bot.registry?.version?.['>=']('1.21.5') === true;
  let soundOffsetTold = false;
  bot._client?.on('sound_effect', packet => {
    if (!blockSound || !bot.entity?.position) return;
    const sounds = (bot.registry as { sounds?: Record<number, { name?: string } | undefined> } | undefined)?.sounds;
    const inline = packet.sound?.data?.soundName as string | undefined;
    const soundId = packet.sound ? packet.sound.soundId : packet.soundId;
    const isBlock = (name: unknown) => String(name ?? '').replace(/^minecraft:/u, '') === 'item.shield.block';
    const offset = inline !== undefined ? (isBlock(inline) ? 'inline' : null)
      : typeof soundId !== 'number' ? null
        : isBlock(sounds?.[soundId]?.name) ? '+0' : isBlock(sounds?.[soundId + 1]?.name) ? '+1' : null;
    if (!offset) return;
    const at = new Vec3(packet.x / 8, packet.y / 8, packet.z / 8);
    const near = (p: Vec3) => Math.abs(p.x - at.x) <= 0.6 && Math.abs(p.y - at.y) <= 0.6 && Math.abs(p.z - at.z) <= 0.6;
    if (!near(bot.entity.position)) return;
    // 同じ位置の別の生き物の盾かもしれない音は帰属させない。
    if (Object.values(bot.entities ?? {}).some(entity => entity?.position && entity.id !== bot.entity?.id
      && !['projectile', 'object', 'orb', 'other'].includes(String(entity.type)) && near(entity.position))) return;
    if (!soundOffsetTold) { soundOffsetTold = true; log.info(`🛡 盾で受けた音（音id ${soundId ?? '名前'}、registryの${offset}で item.shield.block）`); }
    state.shieldCaught!++;
  });
  // 古い版の29は受けたentityの通知。新しい版では音だけを使い、同じ受けを二重に数えない。
  bot._client?.on('entity_status', packet => {
    if (packet.entityId !== bot.entity?.id) return;
    if (!blockSound && packet.entityStatus === 29) state.shieldCaught!++;
    // OFFHAND_BREAK=48。最後の打撃はslotのdamage更新を挟まず盾を消すので、残っていた耐久もここで足す。
    // 単なる空slot（持ち替え・死亡・装備の初期化）は破損と推測しない。
    const shield = bot.inventory?.slots?.[45];
    if (packet.entityStatus === 48 && shield?.name === 'shield') {
      const max = shield.maxDurability ?? bot.registry?.itemsByName?.shield?.maxDurability ?? 336;
      state.shieldWear! += Math.max(0, max - Number(shield.durabilityUsed ?? 0));
    }
  });
  // mineflayer inventoryのsetSlot:0はサーバーのset_slotを適用した後（old/newともPrismarine Item）。
  // ローカルなequipのupdateSlotでは数えない。新品への持ち替えでdamageが減っても累計を減らさない。
  bot.on('setSlot:0', (oldItem, newItem) => {
    if ((newItem?.slot ?? oldItem?.slot) !== 45 || oldItem?.name !== 'shield' || newItem?.name !== 'shield') return;
    state.shieldWear! += Math.max(0, Number(newItem.durabilityUsed ?? 0) - Number(oldItem.durabilityUsed ?? 0));
  });
  // damage_event's sourceDirectId is the damaging entity's id + 1 (sourceCauseId is the shooter, not its ball).
  // Only a known small_fireball followed by a health fall counts. Mixed/absorption-only/late or unknown-source notices
  // are left uncounted: neither entityHurt nor a shield being up proves a fireball cost health. Clear at each tick
  // so a notice with no health update cannot be paired with a later burn. This deliberately undercounts ambiguous batches.
  let health = Number(bot.health ?? 20);
  const hurts: boolean[] = [];
  bot._client?.on('damage_event', packet => {
    if (packet.entityId !== bot.entity?.id) return;
    hurts.push(bot.entities?.[packet.sourceDirectId - 1]?.name === 'small_fireball');
  });
  bot.on('health', () => {
    const now = Number(bot.health ?? health);
    if (now < health && hurts.length === 1 && hurts[0]) state.shieldMissed!++;
    health = now; hurts.length = 0;
  });
  bot.on('physicsTick', () => { hurts.length = 0; });
  bot.on('respawn', () => { health = Number(bot.health ?? 20); hurts.length = 0; });
  // The body's own blow goes out from behind the raised shield (S2, 2026-11-03, lab: a still golem struck eight times with the shield up, down and up again lost 40 of 100 each way; the old
  // note that the server refuses such a blow was wrong). Lowering it for the blow left a five-tick gap at each blow.
  installToldVelocity(bot as any);
  // Said to the threat watch: with a shield on the arm, a kind that has hit the body with shots is answered here.
  answerWith(bot, kind => state.enabled && bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('off-hand') ?? 45]?.name === 'shield'
    && (bot as any).shootsAtBody?.(kind) === true);
  const seen = new Map<number, { said: Vec3; saidTick: number; velocity: Vec3; shooterNoted?: boolean }>();
  let tick = 0, lastComing = -Infinity;
  // A-6 (2): while a handover reservation holds the shield (a shield:true reservation), the resident shield does not lower it: the act that takes the body takes the shield up.
  const lower = () => {
    if (state.up && reservationOf(bot as object)?.shield) return;
    if (state.up) { state.up = false; state.lowered = (state.lowered ?? 0) + 1; try { shieldHand(bot).deactivateItem?.(); } catch { /* nothing held */ } }
  };
  state.lowered = 0; state.deactivateCalls = 0;
  if (typeof bot.deactivateItem === 'function') {
    const release = bot.deactivateItem.bind(bot);
    bot.deactivateItem = (...args: unknown[]) => { state.deactivateCalls = (state.deactivateCalls ?? 0) + 1; return (release as (...a: unknown[]) => unknown)(...args); };
  }
  bot.on('physicsTick', () => {
    tick++;
    try {
      if (!state.enabled || !bot.entity || (bot.health ?? 20) <= 0) { lower(); return; }
      const shielded = bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('off-hand') ?? 45]?.name === 'shield';
      let soonest: { entity: any; ticks: number; position: Vec3 } | null = null;
      const alive = new Set<number>();
      for (const entity of Object.values(bot.entities ?? {})) {
        if (!entity?.position || entity.type !== 'projectile') continue;
        const kind = String(entity.name ?? '');
        if (HARMLESS.has(kind) || (kind === BALL_NAME && bot.fireballDeflect?.enabled)) continue;
        alive.add(entity.id);
        let record = seen.get(entity.id);
        if (!record || !record.said.equals(entity.position)) {
          // A new word from the server: the speed it sent with it, or, when it sent none, what the shot covered since its last word.
          const told: Vec3 | undefined = toldVelocity(bot as any, entity.id) ?? entity.velocity;
          let velocity = told && told.norm() > 0.05 ? told.clone() : record && tick > record.saidTick
            ? entity.position.minus(record.said).scaled(1 / (tick - record.saidTick)) : new Vec3(0, 0, 0);
          if (velocity.norm() <= 0.05 && record) velocity = record.velocity;
          record = { said: entity.position.clone(), saidTick: tick, velocity, shooterNoted: record?.shooterNoted };
          seen.set(entity.id, record);
        }
        if (record.velocity.norm() <= 0.05) continue;                    // stuck in the ground, or not yet moving
        let track: BallTrack = { position: record.said, velocity: record.velocity };
        for (let step = record.saidTick; step < tick; step++) track = flyOn(kind, track);
        const coming = impact(bot.entity.position, kind, track);
        if (!coming) continue;
        // Who shot it is learned here, shield or no shield: the kind that stood where the shot began.
        if (!record.shooterNoted) {
          record.shooterNoted = true;
          const shooter = shooterAt(bot, record.said, entity.id);
          if (shooter) (bot as any).shotAtBy?.(shooter);
        }
        if (!soonest || coming.ticks < soonest.ticks) soonest = { entity, ticks: coming.ticks, position: track.position };
      }
      for (const id of seen.keys()) if (!alive.has(id)) seen.delete(id);
      if (!shielded) { lower(); return; }
      // Lowered by another hand (a fight's own deactivateItem, a bow): what the body holds now says so, and the shield goes up again
      // when it is wanted, against what is coming or in a fight's guard.
      if (state.up && bot.usingHeldItem === false) { state.up = false; state.lowered = (state.lowered ?? 0) + 1; }
      if (soonest && soonest.ticks > RAISE_AHEAD_TICKS && !state.up) soonest = null;      // coming, but not yet
      if (soonest) lastComing = tick;
      if (tick - lastComing > HOLD_TICKS) {
        // Nothing in flight. In a fight of the planner's choosing, the shield is kept up against whoever is in
        // reach of a blow; the look and the legs are the fight's own.
        if (state.guard && isEngaged(bot) && hostileInReach(bot)) {
          if (!state.up && !bot.usingHeldItem) { state.up = true; state.guards++; shieldHand(bot).activateItem?.(true); }
          if (state.up) state.upTicks++;
        } else if (!bridgeHoldsShield(bot)) lower();
        return;
      }
      // Something is coming, or has only just passed: the shield is up and turned to it.
      if (soonest) {
        const eyes = bot.entity.position.offset(0, 1.62, 0);
        const dx = soonest.position.x - eyes.x, dy = soonest.position.y - eyes.y, dz = soonest.position.z - eyes.z;
        bot.look?.(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), true);
      }
      for (const control of HORIZONTAL) if (bot.getControlState?.(control)) bot.setControlState?.(control, false);
      // Eating or drawing a bow with the other hand is left to finish; the shield goes up after it.
      if (!state.up && !bot.usingHeldItem) {
        state.up = true;
        state.raised++;
        state.last = soonest ? `${soonest.entity.name} in ${soonest.ticks.toFixed(0)} ticks` : state.last;
        shieldHand(bot).activateItem?.(true);
        log.info(`🛡 盾を構える（${soonest?.entity?.name ?? '飛来物'}、約${soonest ? soonest.ticks.toFixed(0) : '?'}tick後。累計${state.raised}回）`);
      }
      if (state.up) state.upTicks++;
    } catch { /* a reflex never breaks the tick */ }
  });
}

/** Loaded after the reflex that strikes a ghast's ball back, so that for that ball the blow is what stands. */
export function shieldBlockPlugin(bot: unknown): void { installShieldBlock(bot as ShieldBot); }
