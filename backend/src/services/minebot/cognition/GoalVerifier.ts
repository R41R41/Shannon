import { Vec3 } from 'vec3';
import { holdsWater } from '../utils/waterBlocks.js';
import { captureWorldObservation } from './worldFrame.js';
import type { WorldObservation } from './types.js';
import { isThreatEntity } from '../utils/hostileMobHints.js';
import { isExposedTo } from '../utils/threatExposure.js';
import { BURIED_AT, eyeHeight } from '../utils/bodyPose.js';

export type GoalPredicate =
  | { kind: 'inventory'; item: string; count: number }
  | { kind: 'produced'; item: string; count: number }
  | { kind: 'block'; dimension: string; position: { x: number; y: number; z: number }; block: string }
  | { kind: 'position'; dimension: string; position: { x: number; y: number; z: number }; radius: number }
  | { kind: 'defeated'; entityId: number; dimension: string }
  | { kind: 'hostiles_clear'; radius: number }
  | { kind: 'breathing_safe' }
  | { kind: 'boss_defeated'; entity: 'ender_dragon'; dimension: 'the_end' };
export interface GoalContract { goal: string; predicates: GoalPredicate[] }
export interface GoalProof { status: 'verified' | 'mismatch' | 'unknown'; checkedAt: string; evidence: Array<{ predicate: GoalPredicate; status: string; actual: unknown }> }
const dimensionKey = (value: string | null) => value?.replace(/^minecraft:/, '') ?? 'unknown';

/** Mineflayer usually divides air_supply by 15, but dry land can report 400 in 1.21.11. */
export function verifyNativeBreathingSafety(bot: any): { status: 'verified' | 'mismatch' | 'unknown'; actual: unknown } {
  const world = captureWorldObservation(bot);
  const oxygenRaw = world.oxygen;
  // Preserve the low-air 0–20 range while treating above-range native values
  // as full air. A high value alone never proves safety: water, body blocks,
  // health, and block coverage are checked independently below.
  const oxygen = oxygenRaw === null ? null : Math.min(20, oxygenRaw);
  const inWater = bot?.entity?.isInWater;
  const actual: Record<string, unknown> = { health: world.health, oxygenRaw, oxygen, oxygenMax: 20, inWater,
    footBlock: null, headBlock: null };
  if (!world.position || world.health === null || oxygen === null || typeof inWater !== 'boolean'
    || typeof bot?.blockAt !== 'function' || oxygen < 0) return { status: 'unknown', actual };

  const { x, y, z } = world.position;
  let foot: any; let head: any;
  try {
    foot = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y + 0.1), Math.floor(z)));
    head = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y + eyeHeight(bot)), Math.floor(z)));
  } catch { return { status: 'unknown', actual }; }
  actual.footBlock = foot?.name ?? null;
  actual.headBlock = head?.name ?? null;
  if (!foot || !head || typeof foot.boundingBox !== 'string' || typeof head.boundingBox !== 'string') {
    return { status: 'unknown', actual };
  }
  // Buried is a block in the feet's cell or the one right over it; a ceiling higher up only crouches the body.
  let over: any = null;
  try { over = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y + BURIED_AT), Math.floor(z))); } catch { /* judged from the rest */ }
  const obstructed = foot.boundingBox === 'block' || head.boundingBox === 'block' || over?.boundingBox === 'block';
  actual.obstructed = obstructed;
  // Air is safe when the head is out of the water, wherever the feet are.
  // Requiring the whole body out could not be met in open water with no
  // footing in reach, and the emergency that waited for it never ended (paid
  // run L21). An idle body now treads water, so the head stays out.
  const headSubmerged = holdsWater(head);
  actual.headSubmerged = headSubmerged;
  return { status: world.health > 0 && oxygen >= 18 && !headSubmerged && !obstructed ? 'verified' : 'mismatch', actual };
}

/**
 * The widest circle "no hostile near" may be asked for. The emergency's own radius is held to the same number:
 * raised past it on one side only, every emergency for a far ghast was refused as an invalid goal before the
 * planner saw it, and the body stood for two minutes with its task held and nothing acting (paid run L77j).
 */
export const MAX_HOSTILE_CLEAR_RADIUS = 64;

export function validateGoalContract(value: unknown, goal: string): GoalContract {
  if (!value || typeof value !== 'object') throw new Error('GOAL_CONTRACT_REQUIRED');
  const contract = value as GoalContract;
  if (contract.goal !== goal || !Array.isArray(contract.predicates) || !contract.predicates.length || contract.predicates.length > 32) throw new Error('GOAL_CONTRACT_INVALID');
  for (const predicate of contract.predicates) {
    if (!predicate || typeof predicate !== 'object') throw new Error('GOAL_PREDICATE_INVALID');
    if (predicate.kind === 'inventory' || predicate.kind === 'produced') {
      if (!/^[a-z0-9_]+$/.test(predicate.item) || !Number.isInteger(predicate.count) || predicate.count < 1) throw new Error('GOAL_COUNT_INVALID');
    } else if (predicate.kind === 'block' || predicate.kind === 'position') {
      if (!predicate.dimension || !predicate.position || !['x', 'y', 'z'].every(axis => Number.isFinite(predicate.position[axis as 'x']))) throw new Error('GOAL_POSITION_INVALID: block/position require dimension and finite position.x/y/z');
      if (predicate.kind === 'block' && (!/^[a-z0-9_]+$/.test(predicate.block) || !Object.values(predicate.position).every(Number.isInteger))) throw new Error('GOAL_BLOCK_INVALID');
      if (predicate.kind === 'position' && (!Number.isFinite(predicate.radius) || predicate.radius < 0 || predicate.radius > 64)) throw new Error('GOAL_RADIUS_INVALID');
    } else if (predicate.kind === 'defeated') {
      if (!Number.isInteger(predicate.entityId) || !predicate.dimension) throw new Error('GOAL_ENTITY_INVALID');
    } else if (predicate.kind === 'hostiles_clear') {
      if (!Number.isFinite(predicate.radius) || predicate.radius <= 0 || predicate.radius > MAX_HOSTILE_CLEAR_RADIUS) throw new Error('GOAL_HOSTILE_RADIUS_INVALID');
    } else if (predicate.kind === 'breathing_safe') {
      if (Object.keys(predicate).some(key => key !== 'kind')) throw new Error('GOAL_BREATHING_PREDICATE_INVALID');
    } else if (predicate.kind === 'boss_defeated') {
      if (predicate.entity !== 'ender_dragon' || predicate.dimension !== 'the_end') throw new Error('GOAL_BOSS_INVALID');
    } else throw new Error('GOAL_PREDICATE_UNSUPPORTED');
  }
  return structuredClone(contract);
}

/** Native non-OP verification. Unknown is not success; estimates and tool prose are not proofs. */
export class GoalVerifier {
  private readonly baseline: WorldObservation;
  private readonly defeated = new Set<string>();
  private readonly defeatedBosses = new Set<string>();
  private readonly attacked = new Set<string>();
  constructor(private readonly bot: any, baseline?: WorldObservation,
    private readonly previous?: { contract: GoalContract; proof: GoalProof }) {
    this.baseline = baseline ?? captureWorldObservation(bot);
    bot?.on?.('minebotTargetAttacked', this.onAttack);
    bot?.on?.('entityDead', this.onDeath);
  }
  private onAttack = (entity: { id?: number }) => {
    if (Number.isInteger(entity?.id)) this.attacked.add(`${dimensionKey(captureWorldObservation(this.bot).dimension)}:${entity.id}`);
  };
  private onDeath = (entity: { id?: number; name?: string; displayName?: string }) => {
    const key = `${dimensionKey(captureWorldObservation(this.bot).dimension)}:${entity?.id}`;
    if (this.attacked.has(key)) {
      this.defeated.add(key);
      const name = (entity?.name ?? entity?.displayName ?? '').toLowerCase().replace(/[\s-]+/g, '_');
      if (key.startsWith('the_end:') && name === 'ender_dragon') this.defeatedBosses.add('the_end:ender_dragon');
    }
  };
  dispose(): void {
    this.bot?.removeListener?.('minebotTargetAttacked', this.onAttack);
    this.bot?.removeListener?.('entityDead', this.onDeath);
  }
  verify(contract?: GoalContract): GoalProof {
    const world = captureWorldObservation(this.bot);
    const evidence = (contract?.predicates ?? []).map(predicate => {
      let actual: unknown = null;
      let status = 'unknown';
      if (predicate.kind === 'inventory' || predicate.kind === 'produced') {
        if (world.facts?.inventory.coverage === 'known'
          && (predicate.kind !== 'produced' || this.baseline.facts?.inventory.coverage === 'known')) {
          const count = (observation: WorldObservation) => observation.inventory.filter(item => item.name === predicate.item).reduce((total, item) => total + item.count, 0);
          actual = count(world) - (predicate.kind === 'produced' ? count(this.baseline) : 0);
          status = (actual as number) >= predicate.count ? 'verified' : 'mismatch';
        }
      } else if (predicate.kind === 'block' && dimensionKey(world.dimension) === dimensionKey(predicate.dimension)) {
        const block = this.bot?.blockAt?.(new Vec3(predicate.position.x, predicate.position.y, predicate.position.z));
        if (block) { actual = block.name; status = actual === predicate.block ? 'verified' : 'mismatch'; }
      } else if (predicate.kind === 'position' && world.position && world.dimension) {
        actual = Math.hypot(world.position.x - predicate.position.x, world.position.y - predicate.position.y, world.position.z - predicate.position.z);
        status = dimensionKey(world.dimension) === dimensionKey(predicate.dimension) && (actual as number) <= predicate.radius ? 'verified' : 'mismatch';
      } else if (predicate.kind === 'defeated') {
        // A defeat is a historical condition, unlike current inventory/block
        // predicates. Restore only proofs of the SAME immutable main contract;
        // never turn a reused entity ID in a new subgoal into kill evidence.
        const historical = this.previous && JSON.stringify(contract) === JSON.stringify(this.previous.contract)
          && this.previous.proof.evidence.some(entry => entry.status === 'verified'
            && entry.predicate.kind === 'defeated' && entry.predicate.entityId === predicate.entityId
            && dimensionKey(entry.predicate.dimension) === dimensionKey(predicate.dimension) && entry.actual === true);
        actual = this.defeated.has(`${dimensionKey(predicate.dimension)}:${predicate.entityId}`) || Boolean(historical);
        // Absence/unload is not death; defeat observation is not kill credit attribution.
        status = actual ? 'verified' : 'unknown';
      } else if (predicate.kind === 'hostiles_clear') {
        // Emergency completion needs the full loaded native entity set. The
        // prompt's nearbyThreats projection is capped and is not proof that
        // all threats within this radius have disappeared.
        const entities = this.bot?.entities;
        if (world.position && world.health !== null && entities && typeof entities === 'object') {
          const threats: Array<number | null> = Object.values(entities as Record<string, any>)
            .filter((entity: any) => entity && entity !== this.bot?.entity
              && !(Number.isInteger(this.bot?.entity?.id) && entity.id === this.bot.entity.id))
            .filter((entity: any) => {
              const name = String(entity.name ?? entity.displayName ?? '').toLowerCase();
              return isThreatEntity({ name, type: entity.type }, this.bot?.registry?.entitiesByName?.[name]?.type);
            })
            // Clear means nothing that can see or reach the body: a mob sealed behind rock does not keep an emergency open.
            .filter((entity: any) => isExposedTo(this.bot as any, entity))
            .map((entity: any) => {
              const pos = entity.position;
              if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return null;
              return Math.hypot(world.position!.x - pos.x, world.position!.y - pos.y, world.position!.z - pos.z);
            });
          const unlocated = threats.some(distance => distance === null);
          const nearestDistance = threats.reduce<number>((nearest, distance) =>
            distance === null ? nearest : Math.min(nearest, distance), Infinity);
          actual = { health: world.health, nearestDistance: Number.isFinite(nearestDistance) ? nearestDistance : null,
            threatsWithinRadius: threats.filter(distance => distance !== null && distance < predicate.radius).length };
          status = world.health <= 0 ? 'mismatch'
            : unlocated ? 'unknown'
              : (actual as { threatsWithinRadius: number }).threatsWithinRadius === 0 ? 'verified' : 'mismatch';
        }
      } else if (predicate.kind === 'breathing_safe') {
        const breathing = verifyNativeBreathingSafety(this.bot);
        actual = breathing.actual;
        status = breathing.status;
      } else if (predicate.kind === 'boss_defeated') {
        const historical = this.previous && JSON.stringify(contract) === JSON.stringify(this.previous.contract)
          && this.previous.proof.evidence.some(entry => entry.status === 'verified'
            && entry.predicate.kind === 'boss_defeated' && entry.predicate.entity === predicate.entity
            && entry.predicate.dimension === predicate.dimension && entry.actual === true);
        actual = this.defeatedBosses.has(`${predicate.dimension}:${predicate.entity}`) || Boolean(historical);
        status = actual ? 'verified' : 'unknown';
      }
      return { predicate, status, actual };
    });
    return { checkedAt: world.observedAt, evidence, status: !evidence.length || evidence.some(item => item.status === 'unknown') ? 'unknown'
      : evidence.every(item => item.status === 'verified') ? 'verified' : 'mismatch' };
  }
}

export const GOAL_CONTRACT_TOOL = {
  name: 'set-goal-contract',
  description: 'Minecraftの依頼を検証可能な完了条件へ変換する。goalはユーザーの原文そのまま。作業開始前に設定し、完了条件を後から弱めない。inventory=最終所持数、produced=開始時からの増分、block=設置/採掘後のブロック、position=到達、defeated=攻撃した特定対象の死亡観測（撃破貢献の証明ではない）、hostiles_clear=現在読み込まれた敵対Mobが指定半径内にいないこと（将来の安全は保証しない）、breathing_safe=酸素18/20以上・水外・身体の占有ブロックが非固体であることのnative確認、boss_defeated=The Endで攻撃したエンダードラゴンの死亡観測。生成途中で後から消費する素材はサブタスクのpostconditionsにする。曖昧な目標はユーザーに確認する。',
  input_schema: { type: 'object' as const, properties: {
    goal: { type: 'string' }, predicates: { type: 'array', minItems: 1, maxItems: 32, items: { anyOf: [
      { type: 'object', properties: { kind: { type: 'string', enum: ['inventory', 'produced'] }, item: { type: 'string' }, count: { type: 'integer', minimum: 1 } }, required: ['kind', 'item', 'count'] },
      ...(['block', 'position'] as const).map(kind => ({ type: 'object', properties: {
        kind: { type: 'string', enum: [kind] }, dimension: { type: 'string', description: 'Required dimension from native observation, e.g. overworld. Never omit this field.' },
        position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
        ...(kind === 'block' ? { block: { type: 'string' } } : { radius: { type: 'number', minimum: 0, maximum: 64 } }),
      }, required: ['kind', 'dimension', 'position', kind === 'block' ? 'block' : 'radius'] })),
      { type: 'object', properties: { kind: { type: 'string', enum: ['defeated'] }, entityId: { type: 'integer' }, dimension: { type: 'string' } }, required: ['kind', 'entityId', 'dimension'] },
      { type: 'object', properties: { kind: { type: 'string', enum: ['hostiles_clear'] }, radius: { type: 'number', exclusiveMinimum: 0, maximum: 64 } }, required: ['kind', 'radius'] },
      { type: 'object', properties: { kind: { type: 'string', enum: ['breathing_safe'] } }, required: ['kind'], additionalProperties: false },
      { type: 'object', properties: { kind: { type: 'string', enum: ['boss_defeated'] }, entity: { type: 'string', enum: ['ender_dragon'] }, dimension: { type: 'string', enum: ['the_end'] } }, required: ['kind', 'entity', 'dimension'] },
    ] } },
  }, required: ['goal', 'predicates'] },
};
