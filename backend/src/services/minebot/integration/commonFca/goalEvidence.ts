import { createHash } from 'node:crypto';
import type { BodyTaskContext } from './bodyControlContract.js';
import type { MinecraftControlCommand, MinecraftSkillDefinition } from './minecraftControlContract.js';

export const GOAL_EVIDENCE_SKILL: MinecraftSkillDefinition = {
  name: 'goal-evidence', readOnly: true,
  description: '現在の元タスクに結び付いたnative死亡観測と所持数を読む。攻撃後にThe Endで実際に観測したドラゴンの死亡だけが証拠。未観測・別タスク・再接続は達成ではない。',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};
const dimension = (bot: any) => String(bot.game?.dimension ?? '').replace(/^minecraft:/u, '');
const dragon = (entity: any) => entity?.name === 'ender_dragon';
const contractKey = (context: BodyTaskContext) => createHash('sha256')
  .update(JSON.stringify([context.scopeKey, context.taskId, context.bodyId, context.goal, context.completionCondition])).digest('hex');
type Witness = { entity: any; id: number; uuid?: string; sessionId: string; generation: number; attackedAt: string; commandId: string };
type Proof = { connectionId: string; bodyId: string; entityId: number; entityUuid: string | null; sessionId: string; generation: number; attackedAt: string; observedAt: string; commandId: string };
/** Ephemeral native evidence: no planner, model assertion, world command, or lifetime kill ledger. */
export class NativeGoalEvidence {
  private current: { context: BodyTaskContext; key: string; connectionId: string; deadline: number } | null = null;
  private readonly proofs = new Map<string, Proof>();
  private readonly attacks = new Map<number, Witness>();
  private disconnected = false;
  private readonly originalAttack;
  private readonly attackTap;
  constructor(private readonly bot: any, private readonly now: () => number = Date.now) {
    this.originalAttack = bot.attack;
    this.attackTap = (...args: any[]) => {
      const result = this.originalAttack.apply(bot, args);
      this.attacked(args[0]); // Only a real successful native attack invocation is evidence.
      return result;
    };
    if (typeof this.originalAttack === 'function') bot.attack = this.attackTap;
    bot.on('entityDead', this.onDeath); bot.on('entityGone', this.onGone);
    bot.on('respawn', this.onRespawn); bot.on('end', this.onEnd);
  }
  enter(command: MinecraftControlCommand): void {
    const key = contractKey(command.context);
    const old = this.current;
    if (old && old.connectionId !== command.connectionId) this.proofs.clear();
    if (!old || old.key !== key || old.connectionId !== command.connectionId || old.context.sessionId !== command.context.sessionId
      || old.context.generation !== command.context.generation || old.deadline <= this.now()) this.attacks.clear();
    this.current = { key, context: structuredClone(command.context), connectionId: command.connectionId, deadline: Date.parse(command.deadlineAt) };
  }
  cancel(context: BodyTaskContext): void {
    if (this.current?.key === contractKey(context) && this.current.context.sessionId === context.sessionId && this.current.context.generation === context.generation) {
      this.attacks.clear(); this.current.deadline = this.now();
    }
  }
  private attacked(entity: any): void {
    const current = this.current;
    if (this.disconnected || !current || current.deadline <= this.now() || dimension(this.bot) !== 'the_end'
      || !dragon(entity) || !Number.isSafeInteger(entity.id) || this.bot.entities?.[entity.id] !== entity) return;
    this.attacks.set(entity.id, { entity, id: entity.id, ...(typeof entity.uuid === 'string' ? { uuid: entity.uuid } : {}),
      sessionId: current.context.sessionId, generation: current.context.generation,
      attackedAt: new Date(this.now()).toISOString(), commandId: this.commandId });
  }
  private commandId = '';
  /** Keep source operation identity separate from the immutable task key. */
  begin(command: MinecraftControlCommand): void { this.enter(command); this.commandId = command.id; }
  private readonly onDeath = (entity: any) => {
    const current = this.current, witness = this.attacks.get(entity?.id);
    if (!current || this.disconnected || current.deadline <= this.now() || dimension(this.bot) !== 'the_end' || !dragon(entity)
      || !witness || witness.entity !== entity || witness.uuid !== (typeof entity.uuid === 'string' ? entity.uuid : undefined)
      || witness.sessionId !== current.context.sessionId || witness.generation !== current.context.generation) return;
    this.proofs.set(`${current.connectionId}:${current.key}`, { connectionId: current.connectionId, bodyId: current.context.bodyId, entityId: entity.id, entityUuid: witness.uuid ?? null,
      sessionId: witness.sessionId, generation: witness.generation, attackedAt: witness.attackedAt,
      observedAt: new Date(this.now()).toISOString(), commandId: witness.commandId });
    this.attacks.delete(entity.id);
    // Bounded connection-local retention; dropping a proof causes unknown, never false success.
    if (this.proofs.size > 128) this.proofs.delete(this.proofs.keys().next().value!);
  };
  private readonly onGone = (entity: any) => { this.attacks.delete(entity?.id); };
  private readonly onRespawn = () => { this.attacks.clear(); };
  private readonly onEnd = () => { this.disconnected = true; this.attacks.clear(); this.proofs.clear(); this.current = null; };
  snapshot() {
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
        status: proof && !this.disconnected ? 'witnessed' : 'unknown', witness: proof ?? null },
      inventory: { coverage: known ? 'known' : 'unknown', counts },
    };
  }
  dispose(): void {
    if (this.bot.attack === this.attackTap) this.bot.attack = this.originalAttack;
    this.bot.removeListener('entityDead', this.onDeath); this.bot.removeListener('entityGone', this.onGone);
    this.bot.removeListener('respawn', this.onRespawn); this.bot.removeListener('end', this.onEnd);
    this.onEnd();
  }
}
