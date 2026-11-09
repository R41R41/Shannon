import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { endermanRoofSites } from '../../src/services/minebot/utils/huntEndermanCamp.js';
import { sightSiteHint } from '../../src/services/minebot/utils/primitives/fight.js';

// end1109p09 (11/9, warped forest): six enderman_not_visible stops in 110 s named a roof site that would see 0 endermen (open 38%, 14-17 below
// where they stood) while 4-6 stood hidden within 48 m. The way on is now the sites round the nearest hidden one, or the way to it.
function body(blocks: Record<string, string>, entities: any[]) {
  const all: Record<number, any> = {};
  for (const e of entities) all[e.id] = e;
  return {
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, entities: all, registry: {},
    blockAt: (p: Vec3) => {
      const name = blocks[`${p.x},${p.y},${p.z}`] ?? (p.y < 64 ? 'stone' : 'air');
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
    },
  };
}
const enderman = (id: number, x: number, y: number, z: number) => ({ id, name: 'enderman', position: new Vec3(x, y, z), isValid: true, height: 2.9, width: 0.6 });
// A plateau 16 high from x=20 on: from the low ground near the body its top cannot be seen.
function plateau(): Record<string, string> {
  const blocks: Record<string, string> = {};
  for (let x = 20; x <= 48; x++) for (let z = -16; z <= 16; z++) for (let y = 64; y <= 79; y++) blocks[`${x},${y},${z}`] = 'stone';
  return blocks;
}

describe('sightSiteHint: the way on when no eyes are in sight', () => {
  it('reads the roof sites round another cell when asked (an enderman\'s feet)', () => {
    const bot = body(plateau(), [enderman(7, 30.5, 80, 0.5), enderman(8, 42.5, 80, 8.5)]);
    const sites = endermanRoofSites(bot, 10, 5, 4, { x: 30, y: 80, z: 0 }).sites;
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every(s => s.cell.y >= 78 && s.cell.x >= 20)).toBe(true);
  });

  it('does not name a site that sees none while one stands hidden: names one round the nearest hidden one, on its level', () => {
    const bot = body(plateau(), [enderman(7, 30.5, 80, 0.5), enderman(8, 42.5, 80, 8.5)]);
    const low = endermanRoofSites(bot, 16, 1, 4).sites[0];
    expect(low.seen).toBe(0);
    const words = sightSiteHint(bot);
    expect(words).toContain('（#7 の近く）');
    expect(words).not.toContain('見込み 0 体');
    expect(words).toMatch(/^屋根の場所 \(\d+,8\d,-?\d+\)/u);
  });

  it('with no site that sees any round it either: the way to the nearest hidden one, its height and probe roofsite', () => {
    // A ring of stone round it on the plateau hides its eyes from every site.
    const blocks = plateau();
    for (let x = 28; x <= 32; x++) for (let z = -2; z <= 2; z++) if (Math.max(Math.abs(x - 30), Math.abs(z)) === 2) for (let y = 80; y <= 84; y++) blocks[`${x},${y},${z}`] = 'stone';
    const bot = body(blocks, [enderman(7, 30.5, 80, 0.5)]);
    const words = sightSiteHint(bot);
    expect(words).toContain('最寄りの #7 は 東 34m (30,80,0)・16 上');
    expect(words).toContain('probe kind=roofsite');
    expect(words).not.toContain('見込み 0 体');
  });

  it('a site that sees one is still named first', () => {
    const bot = body({}, [enderman(9, 20.5, 64, 0.5)]);
    expect(sightSiteHint(bot)).toMatch(/^屋根の場所 \(.+見込み 1 体/u);
  });
});
