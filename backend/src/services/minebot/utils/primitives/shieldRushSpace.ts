import { Vec3 } from 'vec3';
import type { Cell } from '../localMap.js';

export interface RushArea { center: Cell; radius: number; maxDrop: number }
const BAD = /^(lava|water|fire|soul_fire|magma_block|cactus|powder_snow|campfire|soul_campfire|sweet_berry_bush|wither_rose)$/u;
const key = (p: Cell) => `${p.x},${p.y},${p.z}`;
export const point = (p: Cell) => new Vec3(p.x, p.y, p.z);
export const middle = (p: Cell) => new Vec3(Math.floor(p.x) + 0.5, Math.floor(p.y), Math.floor(p.z) + 0.5);

/** Loaded, dry, full block floors only. No digging, building, diagonal corners or unknown cells. */
export class RushSpace {
  constructor(private readonly bot: any, readonly area: RushArea) {}
  inside(p: Cell): boolean {
    return Math.hypot(p.x - this.area.center.x, p.z - this.area.center.z) <= this.area.radius
      && Math.abs(p.y - this.area.center.y) <= this.area.radius;
  }
  private read(x: number, y: number, z: number): any {
    try { return this.bot.blockAt(new Vec3(x, y, z), false); } catch { return null; }
  }
  stand(p: Cell): boolean {
    if (!this.inside(p)) return false;
    for (const x of new Set([Math.floor(p.x - 0.31), Math.floor(p.x + 0.31)])) {
      for (const z of new Set([Math.floor(p.z - 0.31), Math.floor(p.z + 0.31)])) {
        const floor = this.read(x, Math.floor(p.y) - 1, z);
        if (!floor || BAD.test(floor.name) || floor.boundingBox !== 'block') return false;
        // Partial shapes are deliberately refused as floors (stairs/slabs need a different motor model).
        if (floor.shapes && !floor.shapes.some((s: number[]) => s.join(',') === '0,0,0,1,1,1')) return false;
        for (let y = Math.floor(p.y); y <= Math.ceil(p.y + 1.8) - 1; y++) {
          const b = this.read(x, y, z);
          if (!b || BAD.test(b.name) || b.boundingBox === 'block' || b.shapes?.length) return false;
        }
      }
    }
    return true;
  }
  /** The whole swept body, including headroom on a step and the landing of an allowed drop. */
  edge(a: Cell, b: Cell): boolean {
    if (!this.stand(a) || !this.stand(b) || b.y - a.y > 1 || a.y - b.y > this.area.maxDrop) return false;
    const high = Math.max(a.y, b.y);
    for (let i = 1; i < 5; i++) {
      const p = { x: a.x + (b.x - a.x) * i / 5, y: high, z: a.z + (b.z - a.z) * i / 5 };
      for (const x of new Set([Math.floor(p.x - 0.31), Math.floor(p.x + 0.31)])) {
        for (const z of new Set([Math.floor(p.z - 0.31), Math.floor(p.z + 0.31)])) {
          for (let y = high; y < high + (b.y > a.y ? 2.8 : 1.8); y++) {
            const block = this.read(x, Math.floor(y), z);
            if (!block || BAD.test(block.name) || block.boundingBox === 'block' || block.shapes?.length) return false;
          }
        }
      }
    }
    return true;
  }
  /** Bounded breadth first search within the planner's area, to a planner supplied destination. */
  route(from: Cell, to: Cell): Vec3[] | null {
    const start = middle(from), end = middle(to);
    if (!this.stand(start) || !this.stand(end)) return null;
    const queue = [start], parent = new Map<string, Vec3 | null>([[key(start), null]]);
    for (let i = 0; i < queue.length && i < 2048; i++) {
      const p = queue[i];
      if (p.equals(end)) {
        const path: Vec3[] = [];
        for (let at: Vec3 | null = p; at; at = parent.get(key(at)) ?? null) path.unshift(at);
        return path;
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let dy = 1; dy >= -this.area.maxDrop; dy--) {
          const next = p.offset(dx, dy, dz), k = key(next);
          if (parent.has(k) || !this.edge(p, next)) continue;
          parent.set(k, p); queue.push(next);
        }
      }
    }
    return null;
  }
  /** The body must also have a floor where each shooter could knock it one block. */
  braced(p: Cell, shooters: any[]): boolean {
    return this.stand(p) && shooters.every(e => {
      const dx = p.x - e.position.x, dz = p.z - e.position.z, d = Math.hypot(dx, dz);
      return d < 0.01 || [0.25, 0.5, 0.75, 1].every(t => this.stand({ x: p.x + dx / d * t, y: p.y, z: p.z + dz / d * t }));
    });
  }
}
