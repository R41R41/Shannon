import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { z } from 'zod';
import { endermanRoofSites, netherrackNear, noteRoofLaid } from '../../src/services/minebot/utils/huntEndermanCamp.js';
import Probe, { runProbe } from '../../src/services/minebot/instantSkills/probe.js';

// probe kind=roofsite (S6, 11/5): the roof sites ranked by the endermen whose eyes are seen from them. A wall to the east hides the one there from the body's own
// cell; a site a few blocks north sees past the wall's end.
function body(blocks: Record<string, string>, entities: any[]) {
  const all: Record<number, any> = {};
  for (const e of entities) all[e.id] = e;
  return {
    entity: { position: new Vec3(0.5, 64, 0.5) }, entities: all, registry: {},
    blockAt: (p: Vec3) => {
      const name = blocks[`${p.x},${p.y},${p.z}`] ?? (p.y < 64 ? 'stone' : 'air');
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
    },
  };
}
const enderman = (id: number, x: number, z: number) => ({ id, name: 'enderman', position: new Vec3(x, 64, z), isValid: true });

describe('endermanRoofSites', () => {
  it('offers roofsite through the public kind schema while retaining bedsite and existing probes', () => {
    const skill = new Probe(body({}, []) as any);
    const schema = skill.params.find(param => param.name === 'kind')?.schema;
    expect(schema).toBeInstanceOf(z.ZodEnum);
    if (!(schema instanceof z.ZodEnum)) throw new Error('probe kind must have a public enum schema');
    for (const kind of ['roofsite', 'bedsite', 'den', 'lane', 'worksite']) expect(schema.safeParse(kind).success).toBe(true);
    expect(schema.safeParse('choose_roof_and_walk').success).toBe(false);
    expect(skill.description).toContain('roofsite');
    expect(skill.description).toContain('bedsite');
  });

  it('dispatches a public roofsite request into factual sites without moving or constructing', async () => {
    const bot = body({}, [enderman(41, 20.5, 0.5)]);
    const start = bot.entity.position.clone();
    const result = await runProbe(bot, { kind: 'roofsite', radius: 8 });
    expect(result.success).toBe(true);
    const report = JSON.parse(result.result);
    expect(report).toMatchObject({ v: 1, kind: 'roofsite', endermen: 1 });
    expect(report.sites).toHaveLength(5);
    expect(report.sites[0]).toMatchObject({ seen: 1, seenIds: [41] });
    expect(report.text).toContain('屋根の場所の候補');
    expect(bot.entity.position.equals(start)).toBe(true);
    // This fixture has no movement, construction or combat methods; a public probe needs only reads.
  });

  it('puts first the site that sees the most eyes, and says how many it sees', () => {
    const wall: Record<string, string> = {};
    for (let z = -6; z <= 3; z++) for (let y = 64; y <= 70; y++) wall[`5,${y},${z}`] = 'stone';
    const bot = body(wall, [enderman(1, 20.5, 0.5)]);
    const { sites, endermen } = endermanRoofSites(bot, 8);
    expect(endermen).toBe(1);
    expect(sites[0].seen).toBe(1);
    expect(sites[0].seenIds).toEqual([1]);
    expect(sites[0].cell.x > 5 || sites[0].cell.z > 3).toBe(true);   // past the wall or its end
    const every = endermanRoofSites(bot, 8, 400).sites;
    expect(every.find(s => s.cell.x === 0 && s.cell.z === 0)?.seen).toBe(0);   // the body's own cell does not see it
  });

  it('with no eyes in sight, puts the open side before the thicket and says how open (end1109p02)', () => {
    const forest: Record<string, string> = {};
    for (let x = -40; x <= 2; x += 2) for (let z = -40; z <= 40; z += 2) for (let y = 64; y <= 70; y++) if (!(x === 0 && z === 0)) forest[`${x},${y},${z}`] = 'warped_stem';
    const bot = body(forest, []);
    const every = endermanRoofSites(bot, 8, 400).sites;
    expect(every[0].cell.x).toBeGreaterThan(2);
    expect(every[0].open).toBeGreaterThan(0);
    const west = every.filter(s => s.cell.x < 0);
    expect(west.length).toBeGreaterThan(0);
    expect(Math.max(...west.map(s => s.open))).toBeLessThan(every[0].open);
    expect(endermanRoofSites(body({}, []), 6, 1).sites[0].open).toBe(100);
  });

  it('says how far above where the endermen stand a site is, and the probe line says it (end1109p02: a roof 8 above them)', async () => {
    const low = { id: 5, name: 'enderman', position: new Vec3(30.5, 56, 0.5), isValid: true };
    const bot = body({}, [low]);
    expect(endermanRoofSites(bot, 6, 1).sites[0].above).toBe(8);
    expect(endermanRoofSites(body({}, [enderman(6, 30.5, 0.5)]), 6, 1).sites[0].above).toBe(0);
    const report = JSON.parse((await runProbe(bot, { kind: 'roofsite', radius: 6 })).result);
    expect(report.text).toContain('エンダーマンの立つ高さより 8 上');
  });

  it('a site 4 above where they stand comes after one at their level, though it sees more (end1109p03)', () => {
    // A hill 4 high to the east (x 3..8): its top sees all five; the level ground west sees them too but is farther. They stand at y 64.
    const hill: Record<string, string> = {};
    for (let x = 3; x <= 8; x++) for (let z = -8; z <= 8; z++) for (let y = 64; y <= 67; y++) hill[`${x},${y},${z}`] = 'netherrack';
    const five = [1, 2, 3, 4, 5].map(i => enderman(i, 30.5, -10.5 + i * 4));
    const sites = endermanRoofSites(body(hill, five), 8, 400).sites;
    expect(sites[0].above).toBeLessThanOrEqual(2);
  });

  it('none in sight anywhere: every site says 0, nearest and cheapest first', () => {
    const { sites } = endermanRoofSites(body({}, []), 6);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every(s => s.seen === 0)).toBe(true);
  });

  it('caps the eyes counted per site when asked, keeping the order (the fight stop line reads only a good site)', () => {
    const bot = body({}, [enderman(1, 20.5, 0.5), enderman(2, -20.5, 0.5), enderman(3, 0.5, 20.5)]);
    const full = endermanRoofSites(bot, 6, 1).sites[0];
    const capped = endermanRoofSites(bot, 6, 1, 2).sites[0];
    expect(full.seen).toBe(3);
    expect(capped.seen).toBe(2);
  });
});

describe('netherrackNear (h28: the kit cobblestone ran out and the shortage line named no way on)', () => {
  it('names the nearest bare netherrack and how many to dig', () => {
    const bot = body({ '3,64,0': 'netherrack', '6,64,0': 'netherrack' }, []);
    expect(netherrackNear(bot, 6)).toBe('。近くの netherrack (3,64,0)（3.2m）などを dig で 6 個以上掘ってから（ツルハシですぐ掘れる）');
  });
  // end1108h29: one far cell named at a time; seven roofs stopped short. The cells in reach, in one dig, never the floor under the 3x3 about the feet.
  it('names the cells in reach in one dig, nearest first, and not the floor she stands on', () => {
    const hill: Record<string, string> = { '0,63,0': 'netherrack', '1,63,1': 'netherrack' };
    for (let x = 2; x <= 3; x++) for (let y = 64; y <= 65; y++) for (let z = -1; z <= 1; z++) hill[`${x},${y},${z}`] = 'netherrack';
    const words = netherrackNear(body(hill, []), 6);
    expect(words).toMatch(/^。ここから手の届く netherrack 8 マスを 1 手で: dig の at に \(2,65,0\)/u);
    expect(words).not.toContain('(0,63,0)');
    expect(words).not.toContain('(1,63,1)');
    expect(words).toContain('落ちた分は dig が拾う');
  });
  // end1109p09 (warped forest): the floor was nylium and the trees wart blocks; only netherrack was looked for.
  it('counts nylium (dug, it drops netherrack) and wart blocks as roof sources', () => {
    expect(netherrackNear(body({ '3,64,0': 'warped_nylium', '5,64,0': 'netherrack' }, []), 6)).toBe('。近くの warped_nylium（掘ると netherrack） (3,64,0)（3.2m）などを dig で 6 個以上掘ってから（ツルハシですぐ掘れる）');
    const canopy: Record<string, string> = {};
    for (let x = 2; x <= 3; x++) for (let y = 64; y <= 65; y++) for (let z = -1; z <= 1; z++) canopy[`${x},${y},${z}`] = 'warped_wart_block';
    expect(netherrackNear(body(canopy, []), 6)).toMatch(/^。ここから手の届く warped_wart_block 8 マスを 1 手で/u);
  });
  // end1109p10: the kit cobblestone stood in roofs left after failed fights and was never taken back; her own left roof blocks come first.
  it('names her own left roof blocks in reach first, not the roof over her feet nor a laid block since gone', () => {
    const blocks: Record<string, string> = { '2,66,0': 'cobblestone', '2,66,1': 'cobblestone', '3,65,0': 'cobblestone', '0,66,0': 'cobblestone' };
    const bot = body(blocks, []);
    for (const key of ['2,66,0', '2,66,1', '3,65,0', '0,66,0', '-2,65,0']) { const [x, y, z] = key.split(',').map(Number); noteRoofLaid(bot, { x, y, z }, 'cobblestone'); }
    const words = netherrackNear(bot, 3);
    expect(words).toMatch(/^。ここから手の届く 前に自分で張った屋根 3 マスを 1 手で: dig の at に \(2,66,0\)・/u);
    expect(words).not.toContain('(0,66,0)');
    expect(words).not.toContain('(-2,65,0)');
  });
  it('names a left roof farther off, first when it alone covers the shortage', () => {
    const blocks: Record<string, string> = { '3,64,0': 'netherrack', '20,64,0': 'cobblestone', '20,64,1': 'cobblestone', '20,64,2': 'cobblestone' };
    const bot = body(blocks, []);
    for (const z of [0, 1, 2]) noteRoofLaid(bot, { x: 20, y: 64, z }, 'cobblestone');
    expect(netherrackNear(bot, 3)).toBe('。前に自分で張った屋根の 3 個が (20,64,0)（20m）に残る（寄れば dig 1 手で回収）。近くの netherrack (3,64,0)（3.2m）などを dig で 3 個以上掘ってから（ツルハシですぐ掘れる）');
    expect(netherrackNear(bot, 6)).toBe('。近くの netherrack (3,64,0)（3.2m）などを dig で 6 個以上掘ってから（ツルハシですぐ掘れる）。前に自分で張った屋根の 3 個が (20,64,0)（20m）に残る（寄れば dig 1 手で回収）');
    const bare = body({ '20,64,0': 'cobblestone' }, []);
    noteRoofLaid(bare, { x: 20, y: 64, z: 0 }, 'cobblestone');
    expect(netherrackNear(bare, 4)).toBe('。前に自分で張った屋根の 1 個が (20,64,0)（20m）に残る（寄れば dig 1 手で回収）');
  });
  it('says none when only buried netherrack or none is near, and nothing when nothing is short', () => {
    expect(netherrackNear(body({}, []), 4)).toBe('。6m 内に掘れる netherrack は見えない');
    expect(netherrackNear(body({ '3,64,0': 'netherrack' }, []), 0)).toBe('');
  });
});
