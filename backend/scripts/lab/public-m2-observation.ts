import type { P3 } from '../../src/services/minebot/utils/dragonParts.js';

interface NativeHealthChange {
  entityId: number; sceneTick: number; phase: number | null; health: number; source: 'snapshot' | 'packet';
  body: { position: P3; yaw: number; phase: number | null } | null;
}
/** Timed lab observation only. No health query, phase restriction, keeper reset, or permission to act. */
export function createPublicM2HealthTrace(entityId: number) {
  const state = { entityId, source: 'native_metadata_key9_changes', changes: [] as Array<NativeHealthChange & { delta: number | null }>, dropped: 0 };
  let previous: number | null = null;
  return { state, record(change: NativeHealthChange) {
    if (change.entityId !== entityId || !Number.isInteger(change.sceneTick) || change.sceneTick < 0 || !Number.isFinite(change.health) || change.health === previous) return;
    const delta = previous === null ? null : change.health - previous; previous = change.health;
    if (state.changes.length >= 2048) { state.dropped++; return; }
    state.changes.push(structuredClone({ ...change, delta }));
  } };
}
