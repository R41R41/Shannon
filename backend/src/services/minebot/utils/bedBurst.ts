/** Packet/diagnostic values only. The isolated End probe owns all writes and timing. */
type Cell = { x: number; y: number; z: number };
export type BedBurstPacket = { stage: 'unsneak' | 'look' | 'place' | 'use'; name: 'player_input' | 'look' | 'block_place'; data: Record<string, any> };
export type BedBurstSend = BedBurstPacket & { tick: number; position: Cell; yaw: number; pitch: number; written: boolean };
export type BedBurstEvidence = {
  sent: BedBurstSend[]; blockUpdates: Array<{ tick: number; cell: Cell; name: string; halves: { foot: Cell; head: Cell } | null }>;
  samples: Array<{ tick: number; foot: string | null; head: string | null }>;
  useTick: number | null; detonationTick: number | null; previousDetonationTick: number | null;
  placeSeen: boolean; orientationMatches: boolean | null; orientationMismatch: boolean;
  awaitingPosition: boolean; reach: number | null; dragonOverlap: string | null;
  failure?: string; observationInterrupted?: string; completedTick?: number; useToDetonationTicks?: number | null;
  placeToUseTicks?: number | null; detonationToBurstTicks?: number | null; classification?: ReturnType<typeof classifyBedBurst>;
};

export function emptyBedBurst(previousDetonationTick: number | null): BedBurstEvidence {
  return { sent: [], blockUpdates: [], samples: [], useTick: null, detonationTick: null, previousDetonationTick,
    placeSeen: false, orientationMatches: null, orientationMismatch: false, awaitingPosition: false, reach: null, dragonOverlap: null };
}

/** minecraft-data pc/1.21.11: use_item_on is named block_place by this protocol library.
 * `down` reference in the place hand = foot below, clicked UP (direction 1), centre of top face.
 * Each click has a distinct prediction sequence; the probe allocates them above every observed write. */
export function bedBurstPackets(foot: Cell, head: Cell, yaw: number, pitch: number, onGround: boolean, sequence: number): BedBurstPacket[] {
  if (![...Object.values(foot), ...Object.values(head)].every(Number.isInteger)
    || head.y !== foot.y || Math.abs(head.x - foot.x) + Math.abs(head.z - foot.z) !== 1
    || !Number.isFinite(yaw) || !Number.isFinite(pitch) || Math.abs(pitch) > Math.PI / 2
    || !Number.isInteger(sequence) || sequence < 1 || sequence >= 0x7fffffff) throw new Error('invalid_bed_burst');
  const click = (location: Cell, cursorY: number, seq: number) => ({ hand: 0, location, direction: 1,
    cursorX: 0.5, cursorY, cursorZ: 0.5, insideBlock: false, worldBorderHit: false, sequence: seq });
  return [
    { stage: 'unsneak', name: 'player_input', data: { inputs: { forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false } } },
    { stage: 'look', name: 'look', data: { yaw: Math.fround(180 - yaw * 180 / Math.PI), pitch: Math.fround(-pitch * 180 / Math.PI),
      flags: { onGround, hasHorizontalCollision: false } } },
    { stage: 'place', name: 'block_place', data: click({ ...foot, y: foot.y - 1 }, 1, sequence) },
    // Click the FOOT's top surface. This still explodes at the pillow, and a wrong facing is observable.
    { stage: 'use', name: 'block_place', data: click({ ...foot }, 0.5625, sequence + 1) },
  ];
}

// A receipt tick is not a server tick: M2 reserves one tick beyond the server's
// ten-tick hurt cooldown. This is a minimum, never a deadline or a cadence slot.
export const LANDING_BLAST_GAP_TICKS = 11;
export function bedBurstDue(now: number, previousDetonationTick: number | null, minimumGap = 10): boolean {
  return Number.isInteger(now) && Number.isInteger(minimumGap) && minimumGap >= 10 && (previousDetonationTick === null
    || (Number.isInteger(previousDetonationTick) && now - previousDetonationTick >= minimumGap));
}

/** Server reach is eye -> closest point in the clicked block AABB, 4.5+1.0 in survival.
 * The probe additionally retains its existing, stricter centre-distance 4.5 m safety gate. */
export function bedBurstReach(feet: Cell, foot: Cell, eyeHeight = 1.62): number {
  const eye = { ...feet, y: feet.y + eyeHeight };
  const distance = (cell: Cell) => Math.hypot(...(['x', 'y', 'z'] as const).map(k => Math.max(cell[k] - eye[k], 0, eye[k] - cell[k] - 1)));
  return Math.max(distance({ ...foot, y: foot.y - 1 }), distance(foot));
}

export function classifyBedBurst(e: Pick<BedBurstEvidence, 'placeSeen' | 'orientationMatches' | 'orientationMismatch' | 'detonationTick' | 'awaitingPosition' | 'reach' | 'dragonOverlap' | 'failure'>) {
  const reasons: string[] = [];
  if (e.orientationMismatch) reasons.push('orientation_mismatch');
  if (e.reach !== null && e.reach > 5.5) reasons.push('out_of_reach');
  if (e.awaitingPosition && e.detonationTick === null) reasons.push('awaitingPositionFromClient_possible');
  if (e.dragonOverlap) reasons.push('dragon_overlap');
  if (e.failure) reasons.push(e.failure);
  const placed = e.placeSeen ? 'block_update_confirmed' : e.detonationTick !== null ? 'inferred_from_explosion' : 'unconfirmed';
  const used = e.detonationTick !== null ? 'explosion_confirmed' : 'unconfirmed';
  if (placed === 'unconfirmed') reasons.push('placement_unconfirmed');
  else if (used === 'unconfirmed') reasons.push('use_without_explosion');
  return { placed, used, orientation: e.orientationMismatch ? 'mismatch' : e.orientationMatches ? 'confirmed' : 'unobserved',
    reasons, causeCertainty: 'client_evidence_only; server awaitingPositionFromClient and rejection reason are not transmitted' };
}
