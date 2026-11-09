import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';

vi.mock('../../src/services/minebot/execution/ActionExecution.js', () => ({ activeActionCapabilities: () => ['act'] }));

const { judgeAppliedTick, fallIsDangerous } = await import('../../src/services/minebot/utils/edgeGuard.js');

const VERSION = '1.21.11';
const mcData = minecraftData(VERSION);
const Block = (blockLoader as any)(VERSION);

/** A ledge: feet at 72 for z >= 0, a valley floor 6 below (feet 66) for z < 0. */
const blockAt = (pos: Vec3) => {
  const y = Math.floor(pos.y), z = Math.floor(pos.z);
  const top = z >= 0 ? 71 : 65;
  return new Block(mcData.blocksByName[y <= top ? 'netherrack' : 'air'].id, 0, 0);
};
const stepping = (health: number) => ({
  entity: { position: new Vec3(0.5, 72, -0.12), velocity: new Vec3(0, -0.08, -0.28), onGround: true },
  health, blockAt, getControlState: (name: string) => name === 'forward', setControlState: vi.fn(),
});

describe('end1109f22: a go given maxDrop is let down a rim the guard used to hold it at', () => {
  it('a 6-block drop: refused by default, let go with the allowance at health 20, refused when it would leave under 8', () => {
    expect(fallIsDangerous(6, 20)).toBe(true);
    expect(fallIsDangerous(6, 20, 9)).toBe(false);
    expect(fallIsDangerous(11, 20, 11)).toBe(false);   // 8 points, 12 left
    expect(fallIsDangerous(6, 10, 9)).toBe(true);      // 3 points would leave 7
    expect(fallIsDangerous(Infinity, 20, 11)).toBe(true);
    expect(fallIsDangerous(12, 20, 9)).toBe(true);     // deeper than asked
    expect(judgeAppliedTick(stepping(20) as any, { position: new Vec3(0.5, 72, 0.16), onGround: true }, null)).toBe(6);
    expect(judgeAppliedTick(stepping(20) as any, { position: new Vec3(0.5, 72, 0.16), onGround: true }, null, 9)).toBeNull();
    expect(judgeAppliedTick(stepping(10) as any, { position: new Vec3(0.5, 72, 0.16), onGround: true }, null, 9)).toBe(6);
  });
});
