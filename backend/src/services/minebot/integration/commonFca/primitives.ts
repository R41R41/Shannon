import { Vec3 } from 'vec3';
import { assertActionActive } from '../../execution/ActionExecution.js';
import type { BodyCandidateDraft, BodyFact, BodyObservation, BodyPrecondition } from './bodyControlContract.js';
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const faces = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const position = (v: any) => ({ x: v.x as number, y: v.y as number, z: v.z as number });
const vector = (v: any) => new Vec3(v.x, v.y, v.z);
const blockKey = (v: any) => `block:${v.x}:${v.y}:${v.z}`;
interface PrimitiveState {
  inventory: { slot: number; name: string }[];
  targets: { id: number; name: string }[];
  ray: null | { position: { x: number; y: number; z: number }; name: string; diggable: boolean;
    face: number[] | null; placeable: boolean; space?: { x: number; y: number; z: number } };
}
/** IDs, slots and block faces come from current native observation, never from a provider answer. */
export function primitiveState(bot: any): { state: PrimitiveState; facts: Record<string, BodyFact> } {
  const facts: Record<string, BodyFact> = {};
  const inventory = (bot.inventory?.items?.() ?? []).filter((item: any) => Number.isInteger(item.slot))
    .slice(0, 9).map((item: any) => ({ slot: item.slot, name: String(item.name) }));
  for (const item of inventory) facts[`slot:${item.slot}`] = item.name;
  const targets = (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity !== bot.entity && entity?.position
    && entity.type !== 'player' && entity.type !== 'object' && entity.type !== 'orb'
    && bot.entity?.position && bot.entity.position.distanceTo(entity.position) <= 3).slice(0, 6).map(entity => ({ id: entity.id, name: String(entity.name) }));
  for (const entity of targets) facts[`target:${entity.id}:near`] = entity.name;
  let ray: PrimitiveState['ray'] = null;
  try {
    const block = bot.blockAtCursor?.(4);
    if (block?.position && block.boundingBox === 'block') {
      const face = faces[block.face] ?? null;
      const spacePosition = face ? block.position.offset(...face) : null;
      const space = spacePosition ? bot.blockAt(spacePosition) : null;
      facts[blockKey(block.position)] = block.stateId;
      if (space) facts[blockKey(space.position)] = space.stateId;
      ray = { position: position(block.position), name: String(block.name), diggable: !!bot.canDigBlock?.(block), face,
        placeable: !!face && !!space && ['air', 'cave_air', 'void_air'].includes(space.name)
          && !!bot.registry?.blocksByName?.[bot.heldItem?.name] && bot.entity.position.distanceTo(space.position) > 1,
        ...(space ? { space: position(space.position) } : {}) };
      facts.rayTarget = blockKey(block.position);
    }
  } catch { /* unloaded/unknown ray produces no block candidate */ }
  return { state: { inventory, targets, ray }, facts };
}
export function primitiveCandidates(observation: BodyObservation, now: number): BodyCandidateDraft[] {
  const expiresAt = new Date(now + 5000).toISOString(), facts = observation.facts;
  const common = { arguments: {}, preconditions: [], maxDurationMs: 0, expiresAt };
  const candidates: BodyCandidateDraft[] = ['stop', 'observe', 'return'].map(kind => ({ ...common,
    kind: kind as 'stop' | 'observe' | 'return', label: kind === 'observe' ? '身体とインベントリを再観測する' : kind === 'stop' ? '身体入力を停止する' : '上位FCAへ戻る' }));
  if (!observation.connected || facts.alive !== true) return candidates;
  const base: BodyPrecondition[] = [{ key: 'connected', value: true }, { key: 'alive', value: true }];
  const add = (operation: string, label: string, args: BodyCandidateDraft['arguments'], conditions: BodyPrecondition[] = []) => {
    candidates.push({ kind: 'action', operation, label, arguments: args, preconditions: [...base, ...conditions], maxDurationMs: 1500, expiresAt });
  };
  for (const controls of [['forward'], ['back'], ['left'], ['right'], ['sneak'], ...(facts.onGround ? [['jump'], ['forward', 'jump']] : [])]) {
    add('control', `${controls.join('+')}を150ms保持`, { controls, milliseconds: 150 }, [{ key: 'yaw', value: facts.yaw },
      ...(controls.includes('jump') ? [{ key: 'onGround', value: true }] : [])]);
  }
  for (const change of [-Math.PI / 8, Math.PI / 8]) add('look', change < 0 ? '少し右を見る' : '少し左を見る',
    { yaw: Number(facts.yaw) + change, pitch: facts.pitch });
  for (const change of [-Math.PI / 12, Math.PI / 12]) add('look', change < 0 ? '少し下を見る' : '少し上を見る',
    { yaw: facts.yaw, pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, Number(facts.pitch) + change)) });
  const state = observation.state.primitives as unknown as PrimitiveState;
  if (!state) return candidates;
  for (const item of state.inventory) if (facts.equipped !== item.name) add('equip', `${item.name}を主手に持つ`, { slot: item.slot }, [{ key: `slot:${item.slot}`, value: item.name }]);
  if (facts.equipped) add('use-item', `${facts.equipped}の右入力を250ms保持`, { milliseconds: 250 }, [{ key: 'equipped', value: facts.equipped }]);
  for (const entity of state.targets) add('attack', `近距離の${entity.name} (${entity.id})を一回攻撃`, { entityId: entity.id }, [{ key: `target:${entity.id}:near`, value: entity.name }]);
  const ray = state.ray;
  if (ray) {
    const target = [{ key: blockKey(ray.position), value: facts[blockKey(ray.position)] }, { key: 'rayTarget', value: blockKey(ray.position) }, { key: 'equipped', value: facts.equipped }];
    add('activate-block', `${ray.name}を右クリック（コンテナなら内容を観測可能）`, { position: ray.position }, target);
    if (ray.diggable) add('dig', `${ray.name}を左クリックで最大250ms掘る`, { position: ray.position, milliseconds: 250 }, target);
    if (ray.placeable && ray.face && ray.space) add('place', `${facts.equipped}を観測済みの空きマスに置く`,
      { position: ray.position, face: ray.face }, [...target, { key: blockKey(ray.space), value: facts[blockKey(ray.space)] }]);
  }
  return candidates;
}
export async function executePrimitive(bot: any, motor: any, candidate: BodyCandidateDraft, signal: AbortSignal): Promise<void> {
  const args = candidate.arguments;
  assertActionActive(bot);
  if (candidate.operation === 'control') {
    for (const control of args.controls as string[]) motor.setControlState(control, true);
    try { await pause(Number(args.milliseconds)); assertActionActive(bot); }
    finally { if (!signal.aborted) motor.clearControlStates(); }
  } else if (candidate.operation === 'look') await motor.look(Number(args.yaw), Number(args.pitch), true);
  else if (candidate.operation === 'equip') {
    const item = bot.inventory.slots[Number(args.slot)]; if (!item) throw Error('BODY_ITEM_CHANGED');
    await motor.equip(item, 'hand');
  } else if (candidate.operation === 'use-item') {
    motor.activateItem();
    try { await pause(Number(args.milliseconds)); assertActionActive(bot); }
    finally { if (!signal.aborted) motor.deactivateItem(); }
  } else if (candidate.operation === 'attack') {
    const target = bot.entities[Number(args.entityId)];
    if (!target || bot.entity.position.distanceTo(target.position) > 3) throw Error('BODY_TARGET_CHANGED');
    motor.attack(target);
  } else {
    const block = bot.blockAt(vector(args.position)); if (!block) throw Error('BODY_BLOCK_UNLOADED');
    if (candidate.operation === 'activate-block') await motor.activateBlock(block);
    else if (candidate.operation === 'place') await motor.placeBlock(block, new Vec3(...args.face as [number, number, number]));
    else if (candidate.operation === 'dig') {
      // A short left-button hold may make partial progress. Never claim a block was removed without a fresh observation.
      const digging = Promise.resolve(motor.dig(block, true)).then(() => true, () => false);
      await Promise.race([digging, pause(Number(args.milliseconds))]);
      if (!signal.aborted) motor.stopDigging();
      await digging; assertActionActive(bot);
    } else throw Error('BODY_OPERATION_UNSUPPORTED');
  }
}
