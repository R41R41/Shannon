import { nativeActionHost } from '../execution/ActionExecution.js';

/** Passive, lab-owned notices. No observer means the lazy snapshot is never read. */
export interface ShootDiagnostic { stage: string; [key: string]: unknown }
const observers = new WeakMap<object, Set<(event: ShootDiagnostic) => void>>();
export function hasShootDiagnostics(bot: object): boolean { return !!observers.get(nativeActionHost(bot))?.size; }
export function watchShootDiagnostics(bot: object, observer: (event: ShootDiagnostic) => void): () => void {
  const host = nativeActionHost(bot), rows = observers.get(host) ?? new Set();
  rows.add(observer); observers.set(host, rows);
  let stopped = false;
  return () => {
    if (stopped) return; stopped = true;
    rows.delete(observer);
    if (!rows.size && observers.get(host) === rows) observers.delete(host);
  };
}
export function noteShootDiagnostic(bot: object, detail: () => ShootDiagnostic): void {
  const rows = observers.get(nativeActionHost(bot)); if (!rows?.size) return;
  try {
    const event = detail();
    for (const observer of [...rows]) { try { observer(structuredClone(event)); } catch { /* no result enters the hand */ } }
  } catch { /* reading diagnostics cannot fail, refuse or authorize a shot */ }
}

const point = (p: any) => p ? { x: p.x, y: p.y, z: p.z } : null;
/** Only values already present on native entities. The entity box is a dimensional estimate, not a server part oracle. */
export function shootDiagnosticState(bot: any, target: any) {
  const width = Number.isFinite(target?.width) ? target.width : null, height = Number.isFinite(target?.height) ? target.height : null;
  const p = target?.position;
  return { actor: { position: point(bot.entity?.position), velocity: point(bot.entity?.velocity),
    onGround: typeof bot.entity?.onGround === 'boolean' ? bot.entity.onGround : null, yaw: bot.entity?.yaw ?? null, pitch: bot.entity?.pitch ?? null },
    target: target ? { id: target.id, name: target.name, position: point(p), width, height,
      entityBoxEstimate: p && width !== null && height !== null ? { min: { x: p.x - width / 2, y: p.y, z: p.z - width / 2 },
        max: { x: p.x + width / 2, y: p.y + height, z: p.z + width / 2 } } : null } : null };
}
