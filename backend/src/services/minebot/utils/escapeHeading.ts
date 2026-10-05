export interface PlanePoint { x: number; z: number }

const HEADINGS = 24;
/** How much better another heading must score before the one being run is given up. */
const COMMITMENT = 1.5;
/** A heading within about 40 degrees of one that led nowhere is taken to lead nowhere too. */
const BLOCKED_COSINE = 0.77;

/** Closest the straight run from `from` along `heading` for `run` blocks comes to `threat`. */
function closestApproach(from: PlanePoint, heading: PlanePoint, run: number, threat: PlanePoint): number {
  const tx = threat.x - from.x, tz = threat.z - from.z;
  const along = Math.max(0, Math.min(run, tx * heading.x + tz * heading.z));
  return Math.hypot(tx - heading.x * along, tz - heading.z * along);
}

/**
 * The way to run from several pursuers at once: the heading whose run stays
 * farthest from every one of them, and ends farthest from the nearest. With
 * one pursuer that is straight away from it. With pursuers on two sides it is
 * the gap between them, where adding up a push away from each gives nothing:
 * the pushes cancel, what is left is noise, and its sign flips as the mobs
 * shuffle. A body with three mobs round it ran three blocks one way and three
 * back for its last five seconds (paid run L65).
 *
 * The heading already being run is kept unless another is clearly better, so
 * that the body gets somewhere before it turns. Headings the body has tried
 * and got nowhere on (`blocked`: a cliff, water, a wall) are left out, with
 * those close to them, unless that leaves none.
 */
export function escapeHeading(from: PlanePoint, threats: PlanePoint[], previous?: PlanePoint | null, run = 12,
  blocked: PlanePoint[] = []): PlanePoint {
  if (!threats.length) return previous ?? { x: 0, z: 0 };
  const open = (heading: PlanePoint) => !blocked.some(way => heading.x * way.x + heading.z * way.z > BLOCKED_COSINE);
  const score = (heading: PlanePoint) => {
    let closest = Infinity, endsAt = Infinity;
    for (const threat of threats) {
      closest = Math.min(closest, closestApproach(from, heading, run, threat));
      endsAt = Math.min(endsAt, Math.hypot(threat.x - (from.x + heading.x * run), threat.z - (from.z + heading.z * run)));
    }
    return closest + 0.2 * endsAt;
  };
  const all = Array.from({ length: HEADINGS }, (_, index) => {
    const angle = (index / HEADINGS) * 2 * Math.PI;
    return { x: Math.cos(angle), z: Math.sin(angle) };
  });
  const candidates = all.some(open) ? all.filter(open) : all;
  let best = candidates[0], bestScore = -Infinity;
  for (const heading of candidates) {
    const value = score(heading);
    if (value > bestScore) { best = heading; bestScore = value; }
  }
  const length = previous ? Math.hypot(previous.x, previous.z) : 0;
  if (previous && length > 0) {
    const kept = { x: previous.x / length, z: previous.z / length };
    // The same object back, so that a caller can tell a heading kept from a heading chosen.
    if (open(kept) && score(kept) + COMMITMENT >= bestScore) return Math.abs(length - 1) < 1e-9 ? previous : kept;
  }
  return best;
}

/**
 * How far the nearest pursuer has to be before an escape may stop to work.
 * A block dug or a pillar raised holds the body in one place for a second or
 * more; a mob on foot covers over two metres in that second, and one that has
 * reached the body stands in the cell the block was to go in. Nearer than
 * this an escape is a run and nothing else: a route that pillared up a bank
 * with a zombie two blocks behind ended with the body jumping in place until
 * it died (paid run L65).
 */
export const ESCAPE_WORK_CLEARANCE = 10;
export const escapeMayWork = (nearestPursuerMetres: number): boolean => nearestPursuerMetres >= ESCAPE_WORK_CLEARANCE;
