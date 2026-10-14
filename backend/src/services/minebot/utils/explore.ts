/** Cardinal headings for exploring, each with the headings to its left and right (mineflayer: yaw 0 faces north, -z). */
export interface Heading { name: 'north' | 'south' | 'east' | 'west'; dx: number; dz: number; left: Heading; right: Heading }

const north = { name: 'north', dx: 0, dz: -1 } as Heading, east = { name: 'east', dx: 1, dz: 0 } as Heading;
const south = { name: 'south', dx: 0, dz: 1 } as Heading, west = { name: 'west', dx: -1, dz: 0 } as Heading;
Object.assign(north, { left: west, right: east }); Object.assign(east, { left: north, right: south });
Object.assign(south, { left: east, right: west }); Object.assign(west, { left: south, right: north });
const HEADINGS: Record<string, Heading> = { north, south, east, west };

/** The heading named, or the one the body faces (snapped to a cardinal); null for a name that is none of the four. */
export function exploreHeading(direction: string | undefined, yaw: number): Heading | null {
  if (direction) return HEADINGS[direction.toLowerCase()] ?? null;
  // mineflayer yaw: 0 = north (-z), PI/2 = west (-x), PI = south, -PI/2 = east.
  const turns = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
  return [north, west, south, east][turns];
}

/** Legs of about 48 blocks up to the distance asked for; the last one shorter. */
export function exploreLegs(heading: Heading, maxDistance: number): number[] {
  const legs: number[] = [];
  for (let left = maxDistance; left > 0; left -= 48) legs.push(Math.min(48, left));
  return legs;
}
