import { createHash } from 'node:crypto';
import type { BodyTaskContext } from './bodyControlContract.js';
import type { MinecraftControlCommand, MinecraftSkillDefinition } from './minecraftControlContract.js';
import { isDying } from '../../utils/dragonParts.js';
import { dragonPhaseOf } from '../../utils/dragonState.js';

export const GOAL_EVIDENCE_SKILL: MinecraftSkillDefinition = {
  name: 'goal-evidence', readOnly: true,
  description: '現在の元タスクに結び付いたnative死亡観測と所持数を読む。エンドラ討伐の証拠は、The Endで体がエンドラに与えた被害（剣・矢・ベッドの爆発。サーバーが体を原因と名指した被害、または体の攻撃の直後のエンドラの被弾）の後に、同じエンドラの死（死の演出の終わりを含む）を接続中に観測したことだけ。未観測・別タスク・再接続・被害を与えていない死は達成ではない。途中の節目（今いる次元、この接続で入った次元、ネザー到達、ブレイズロッド・エンダーパール・エンダーアイの所持数）も milestones で返す（節目は討伐の証拠ではない）。advancement end/kill_dragon がこの接続で入ったことは boss.advancement に添える（裏付けで、証拠そのものではない）。',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};
const dimension = (bot: any) => String(bot.game?.dimension ?? '').replace(/^minecraft:/u, '');
const dragon = (entity: any) => entity?.name === 'ender_dragon';
const contractKey = (context: BodyTaskContext) => createHash('sha256')
  .update(JSON.stringify([context.scopeKey, context.taskId, context.bodyId, context.goal, context.completionCondition])).digest('hex');

/** A blow's hurt is the body's when the dragon is hurt within this long of the swing at it. */
const SWING_HURT_MS = 700;
/** A bed's blast is the body's when the dragon is hurt within this long of the blast, and the blast was at the bed the body used. */
const BLAST_HURT_MS = 1500;
/** A bed used and a blast at its place are one event when the blast's centre is within this of the bed. */
const BLAST_AT_BED = 3;
/** The dragon dies in its dying phase 200 ticks after the last blow, and a death seen later than this after the body's last damage is not the body's. */
export const DEATH_GRACE_MS = 60_000;
/** A death announced by the server as the entity's removal while the dragon was dying (its death animation ends in a removal). */
type DeathSeen = 'entityDead' | 'dying_gone';
type Via = 'sword' | 'arrow' | 'explosion' | 'server_named';
type Witness = { entity: any; id: number; uuid?: string; sessionId: string; generation: number; attackedAt: string; commandId: string;
  /** The body's last swing at the dragon or one of its parts (ms), and the last damage that is the body's (ms), with how it was known. */
  swungAt: number | null; lastDamageAt: number | null; via: Set<Via>; damages: number };
type Proof = { connectionId: string; bodyId: string; entityId: number; entityUuid: string | null; sessionId: string; generation: number; attackedAt: string; observedAt: string; commandId: string;
  via: Via[]; damages: number; lastDamageAt: string; deathSeen: DeathSeen };
type Advancement = { state: 'earned_during_connection' | 'not_earned' | 'earned_before_connection' | 'unknown'; at?: string };

const KILL_DRAGON = 'minecraft:end/kill_dragon';

/**
 * Ephemeral native evidence: no planner, model assertion, world command, or lifetime kill ledger.
 *
 * The proof of a dragon kill is the body's own damage to THIS dragon and then THIS dragon's death, in this connection and this task's context:
 *  - the damage is the body's when the server names the body as its cause (`damage_event`: a sword or an arrow), when the dragon is hurt just after the
 *    body's swing at it or at one of its parts (`bot.attack`, a part's id is the body's + 1..8), or just after a bed the body used blew beside it;
 *  - the death is the entity's death (`entityDead`), or its removal while it was in its dying phase (the end of the death animation), seen within
 *    DEATH_GRACE_MS of that damage: the blow's hand may have ended, and the command with it, long before the dragon finished dying;
 *  - a reconnect, a new life, another dimension, another task or a damage that was not the body's is never proof (unknown, not false success).
 * The advancement `end/kill_dragon` is read from the server's advancement packets and told beside the proof when it came in during this connection.
 */
export class NativeGoalEvidence {
  private current: { context: BodyTaskContext; key: string; connectionId: string; deadline: number } | null = null;
  private readonly proofs = new Map<string, Proof>();
  private readonly attacks = new Map<number, Witness>();
  private disconnected = false;
  /** Dimensions this connection has stood in: the Nether reached is a milestone even after leaving it. */
  private readonly visited = new Set<string>();
  private readonly onDimension = () => { const name = dimension(this.bot); if (name) this.visited.add(name); };
  private readonly originalAttack;
  private readonly attackTap;
  private readonly originalActivate;
  private readonly activateTap;
  /** The advancement packets of this connection: the first one is the state at login, the later ones are news. */
  private advancements: { seen: boolean; earned: Set<string>; during: Map<string, number> } = { seen: false, earned: new Set(), during: new Map() };
  /** A bed the body used in the End (where, when), and the blasts the server announced (centre, when): a blast at the bed is the bed's. */
  private bedUsed: { x: number; y: number; z: number; at: number } | null = null;
  private blast: { x: number; y: number; z: number; at: number; bed: boolean } | null = null;
  constructor(private readonly bot: any, private readonly now: () => number = Date.now) {
    this.originalAttack = bot.attack;
    this.attackTap = (...args: any[]) => {
      const result = this.originalAttack.apply(bot, args);
      this.attacked(args[0]); // Only a real successful native attack invocation is evidence.
      return result;
    };
    if (typeof this.originalAttack === 'function') bot.attack = this.attackTap;
    this.originalActivate = bot.activateBlock;
    this.activateTap = (...args: any[]) => {
      const result = this.originalActivate.apply(bot, args);
      this.bedUsedAt(args[0]);
      return result;
    };
    if (typeof this.originalActivate === 'function') bot.activateBlock = this.activateTap;
    bot.on('entityDead', this.onDeath); bot.on('entityGone', this.onGone); bot.on('entityHurt', this.onHurt);
    bot.on('respawn', this.onRespawn); bot.on('end', this.onEnd);
    bot.on('game', this.onDimension); bot.on('spawn', this.onDimension); this.onDimension();
    try { bot._client?.on?.('damage_event', this.onDamageEvent); bot._client?.on?.('explosion', this.onExplosion); bot._client?.on?.('advancements', this.onAdvancements); } catch { /* a body without the packets */ }
  }
  enter(command: MinecraftControlCommand): void {
    const key = contractKey(command.context);
    const old = this.current;
    if (old && old.connectionId !== command.connectionId) this.proofs.clear();
    // The damage the body dealt outlives the command that dealt it (the dragon dies ten seconds after the last blow): what ends it is another task, session,
    // generation or connection, or the grace (below).
    if (!old || old.key !== key || old.connectionId !== command.connectionId || old.context.sessionId !== command.context.sessionId
      || old.context.generation !== command.context.generation) this.attacks.clear();
    this.expire();
    this.current = { key, context: structuredClone(command.context), connectionId: command.connectionId, deadline: Date.parse(command.deadlineAt) };
  }
  cancel(context: BodyTaskContext): void {
    if (this.current?.key === contractKey(context) && this.current.context.sessionId === context.sessionId && this.current.context.generation === context.generation) {
      this.attacks.clear(); this.current.deadline = this.now();
    }
  }
  /** The witnesses whose last damage is older than the grace, or that never had one and were swung long ago, are gone. */
  private expire(): void {
    const t = this.now();
    for (const [id, witness] of this.attacks) {
      const last = witness.lastDamageAt ?? witness.swungAt ?? 0;
      if (t - last > DEATH_GRACE_MS) this.attacks.delete(id);
    }
  }
  /** The dragon itself for what the body struck: the dragon, or the dragon a part of it belongs to (a part's id is the body's id + 1..8). */
  private dragonOf(entity: any): any | null {
    if (dragon(entity)) return entity;
    if (typeof entity?.dragonId === 'number') { const owner = this.bot.entities?.[entity.dragonId]; return dragon(owner) ? owner : null; }
    return null;
  }
  private witnessFor(entity: any): Witness | null {
    const current = this.current;
    if (this.disconnected || !current || dimension(this.bot) !== 'the_end' || !dragon(entity) || !Number.isSafeInteger(entity.id) || this.bot.entities?.[entity.id] !== entity) return null;
    let witness = this.attacks.get(entity.id);
    if (witness && (witness.entity !== entity || witness.sessionId !== current.context.sessionId || witness.generation !== current.context.generation)) { this.attacks.delete(entity.id); witness = undefined; }
    if (!witness) {
      witness = { entity, id: entity.id, ...(typeof entity.uuid === 'string' ? { uuid: entity.uuid } : {}), sessionId: current.context.sessionId, generation: current.context.generation,
        attackedAt: new Date(this.now()).toISOString(), commandId: this.commandId, swungAt: null, lastDamageAt: null, via: new Set(), damages: 0 };
      this.attacks.set(entity.id, witness);
    }
    return witness;
  }
  private attacked(target: any): void {
    const current = this.current;
    if (!current || current.deadline <= this.now()) return;
    const witness = this.witnessFor(this.dragonOf(target));
    if (witness) witness.swungAt = this.now();
  }
  private damaged(witness: Witness, via: Via): void {
    const t = this.now();
    // The server's name for a hit and the client's hurt animation are two reports of one hit.
    if (witness.lastDamageAt === null || t - witness.lastDamageAt >= 250) witness.damages++;
    witness.lastDamageAt = t; witness.via.add(via);
  }
  private bedUsedAt(block: any): void {
    if (dimension(this.bot) !== 'the_end' || !/_bed$/u.test(String(block?.name ?? '')) || !block?.position) return;
    this.bedUsed = { x: block.position.x + 0.5, y: block.position.y + 0.5, z: block.position.z + 0.5, at: this.now() };
  }
  private readonly onExplosion = (packet: any) => {
    const c = packet?.center ?? (typeof packet?.x === 'number' ? { x: packet.x, y: packet.y, z: packet.z } : null);
    if (!c) return;
    const t = this.now(), bed = this.bedUsed;
    this.blast = { x: c.x, y: c.y, z: c.z, at: t, bed: !!bed && t - bed.at <= BLAST_HURT_MS && Math.hypot(bed.x - c.x, bed.y - c.y, bed.z - c.z) <= BLAST_AT_BED };
  };
  /** The server names who hurt whom: the body as the cause (or the direct one) of damage to the dragon is the body's damage. */
  private readonly onDamageEvent = (packet: any) => {
    const me = this.bot.entity?.id;
    if (typeof me !== 'number' || packet?.entityId === undefined) return;
    const victim = this.bot.entities?.[packet.entityId];
    if (!dragon(victim)) return;
    if (Number(packet.sourceCauseId ?? 0) !== me + 1 && Number(packet.sourceDirectId ?? 0) !== me + 1) return;
    const witness = this.witnessFor(victim);
    if (!witness) return;
    const direct = Number(packet.sourceDirectId ?? 0), directName = direct > 0 ? String(this.bot.entities?.[direct - 1]?.name ?? '') : '';
    this.damaged(witness, direct === me + 1 ? 'sword' : /arrow|trident/u.test(directName) ? 'arrow' : directName === 'end_crystal' ? 'explosion' : 'server_named');
  };
  /** The dragon hurt just after the body's swing, or just after the blast of a bed the body used. */
  private readonly onHurt = (entity: any) => {
    if (!dragon(entity)) return;
    const t = this.now(), witness = this.attacks.get(entity.id);
    if (witness && witness.entity === entity && witness.swungAt !== null && t - witness.swungAt <= SWING_HURT_MS) { this.damaged(witness, 'sword'); return; }
    const blast = this.blast;
    if (blast?.bed && t - blast.at <= BLAST_HURT_MS) { const fresh = this.witnessFor(entity); if (fresh) this.damaged(fresh, 'explosion'); }
  };
  private commandId = '';
  /** Keep source operation identity separate from the immutable task key. */
  begin(command: MinecraftControlCommand): void { this.enter(command); this.commandId = command.id; }
  private prove(entity: any, how: DeathSeen): void {
    const current = this.current, witness = this.attacks.get(entity?.id);
    if (!current || this.disconnected || dimension(this.bot) !== 'the_end' || !dragon(entity) || !witness || witness.entity !== entity
      || witness.uuid !== (typeof entity.uuid === 'string' ? entity.uuid : undefined) || witness.sessionId !== current.context.sessionId || witness.generation !== current.context.generation) return;
    const t = this.now();
    // The blow that kills may be the only one the server named before the death: a swing that is this fresh is the damage.
    if (witness.lastDamageAt === null && how === 'entityDead' && witness.swungAt !== null && t - witness.swungAt <= SWING_HURT_MS) this.damaged(witness, 'sword');
    if (witness.lastDamageAt === null || t - witness.lastDamageAt > DEATH_GRACE_MS) return;
    this.proofs.set(`${current.connectionId}:${current.key}`, { connectionId: current.connectionId, bodyId: current.context.bodyId, entityId: entity.id, entityUuid: witness.uuid ?? null,
      sessionId: witness.sessionId, generation: witness.generation, attackedAt: witness.attackedAt, observedAt: new Date(t).toISOString(), commandId: witness.commandId,
      via: [...witness.via], damages: witness.damages, lastDamageAt: new Date(witness.lastDamageAt).toISOString(), deathSeen: how });
    this.attacks.delete(entity.id);
    // Bounded connection-local retention; dropping a proof causes unknown, never false success.
    if (this.proofs.size > 128) this.proofs.delete(this.proofs.keys().next().value!);
  }
  private readonly onDeath = (entity: any) => { this.prove(entity, 'entityDead'); };
  /**
   * Removed from the client. The dragon's death animation ends in a removal: seen while it was dying (its phase 9, or no health left), after the body's
   * damage, that is its death. Removed otherwise (a chunk unloaded, out of the client's range), the body's damage no longer shows what became of it.
   */
  private readonly onGone = (entity: any) => {
    if (dragon(entity)) {
      let dying = false;
      try { dying = isDying(dragonPhaseOf(this.bot, entity)) || (typeof entity?.metadata?.[9] === 'number' && entity.metadata[9] <= 0); } catch { dying = false; }
      if (dying && this.attacks.has(entity.id)) { this.prove(entity, 'dying_gone'); }
    }
    this.attacks.delete(entity?.id);
  };
  private readonly onRespawn = () => { this.attacks.clear(); };
  private readonly onEnd = () => { this.disconnected = true; this.attacks.clear(); this.proofs.clear(); this.current = null; };
  /** The server's advancement packets: the first of a connection is the state at login (earned before), later ones are news (earned during). */
  private readonly onAdvancements = (packet: any) => {
    const first = !this.advancements.seen || packet?.reset === true;
    if (packet?.reset === true) this.advancements = { seen: true, earned: new Set(), during: new Map() };
    this.advancements.seen = true;
    for (const entry of Array.isArray(packet?.progressMapping) ? packet.progressMapping : []) {
      if (entry?.key !== KILL_DRAGON) continue;
      const criteria = Array.isArray(entry.value) ? entry.value : [];
      const done = criteria.length > 0 && criteria.every((criterion: any) => criterion?.criterionProgress !== undefined && criterion?.criterionProgress !== null);
      if (!done) continue;
      if (first) this.advancements.earned.add(KILL_DRAGON);
      else if (!this.advancements.earned.has(KILL_DRAGON)) this.advancements.during.set(KILL_DRAGON, this.now());
    }
  };
  private advancement(): Advancement {
    if (!this.advancements.seen) return { state: 'unknown' };
    const at = this.advancements.during.get(KILL_DRAGON);
    if (at !== undefined) return { state: 'earned_during_connection', at: new Date(at).toISOString() };
    return { state: this.advancements.earned.has(KILL_DRAGON) ? 'earned_before_connection' : 'not_earned' };
  }
  snapshot() {
    this.expire();
    const current = this.current;
    const proof = current ? this.proofs.get(`${current.connectionId}:${current.key}`) : undefined;
    let items: any[] | null = null;
    try { items = this.bot.inventory?.items?.() ?? null; } catch { /* unknown */ }
    const known = Array.isArray(items) && items.every(item => /^[a-z0-9_]+$/u.test(item?.name ?? '') && Number.isSafeInteger(item?.count) && item.count >= 0);
    const counts: Record<string, number> = Object.create(null);
    if (known) for (const item of items!) counts[item.name] = (counts[item.name] ?? 0) + item.count;
    return { schemaVersion: 1, observedAt: new Date(this.now()).toISOString(),
      bodyId: current?.context.bodyId ?? null, taskId: current?.context.taskId ?? null, scopeKey: current?.context.scopeKey ?? null,
      contextKey: current?.key ?? null, connectionId: current?.connectionId ?? null, sessionId: current?.context.sessionId ?? null,
      connected: !this.disconnected && !!this.bot.entity,
      boss: { entity: 'ender_dragon', dimension: 'the_end', verified: !this.disconnected && !!this.bot.entity && !!proof,
        status: proof && !this.disconnected ? 'witnessed' : 'unknown', witness: proof ?? null, advancement: this.advancement() },
      inventory: { coverage: known ? 'known' : 'unknown', counts },
      // Milestones on the way, as native observations (the Nether stood in, rods and eyes carried); not the goal's proof.
      milestones: { dimension: dimension(this.bot) || null, visited: [...this.visited], netherReached: this.visited.has('the_nether'),
        ...Object.fromEntries([['blazeRods', 'blaze_rod'], ['blazePowder', 'blaze_powder'], ['enderPearls', 'ender_pearl'], ['enderEyes', 'ender_eye']]
          .map(([key, item]) => [key, known ? counts[item] ?? 0 : null])) },
    };
  }
  dispose(): void {
    if (this.bot.attack === this.attackTap) this.bot.attack = this.originalAttack;
    if (this.bot.activateBlock === this.activateTap) this.bot.activateBlock = this.originalActivate;
    this.bot.removeListener('entityDead', this.onDeath); this.bot.removeListener('entityGone', this.onGone); this.bot.removeListener('entityHurt', this.onHurt);
    this.bot.removeListener('respawn', this.onRespawn); this.bot.removeListener('end', this.onEnd);
    this.bot.removeListener('game', this.onDimension); this.bot.removeListener('spawn', this.onDimension);
    try { this.bot._client?.removeListener?.('damage_event', this.onDamageEvent); this.bot._client?.removeListener?.('explosion', this.onExplosion); this.bot._client?.removeListener?.('advancements', this.onAdvancements); } catch { /* gone */ }
    this.onEnd();
  }
}
