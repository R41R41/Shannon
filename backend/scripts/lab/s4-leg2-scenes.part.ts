
// ===== S4 (2026-11-03): run59's leg 2 on c1, measured in the lab ==========================================================================================================
// What status/run59-leg2-plan.md asked for: the second blaze spawner B (202,83,62) with run59's pack; the Nether road (biomes, piglins, hoglins, ghasts) from the arrival to the fortress and
// on to the warped forest; the Nether side of a gate built on the surface at (160,75,28); and the road to the stronghold through the Nether. No model: a scripted stand-in plays the head's part
// (the places and the limits its knowledge gives: canDig netherrack, basalt, blackstone; canPlace cobblestone, netherrack; maxDig 200, maxPlace 100; hops of 110 s), the way is the body's.
// The pack is run59's of 23:29 (a stone sword and axe, a shield, an iron helmet and leggings, a diamond pickaxe worn to 312 of 1561, 7 cooked porkchops, 160 cobblestone, 10 obsidian,
// a flint and steel, a water bucket). Inserted after s4-section-scenes.part.ts by s4-section-probe.sh, so its helpers are in scope too. Read each scene's notes from probe.log and report.json.
const S4_RUN59 = { stone_sword: 1, stone_axe: 1, 'diamond_pickaxe[minecraft:damage=312]': 1, cooked_porkchop: 7, potato: 6, cobblestone: 160, cobbled_deepslate: 90, obsidian: 10, flint_and_steel: 1, water_bucket: 1, white_bed: 1, gold_ingot: 1 };
const s4EquipOriginal = equip;
async function s4EquipRun59(extra: Record<string, number> = {}): Promise<void> {
  await s4EquipOriginal({ ...S4_RUN59, ...extra }, { armor: 'none', shield: true });
  await ask(`item replace entity ${ACTOR} armor.head with minecraft:iron_helmet`);
  await ask(`item replace entity ${ACTOR} armor.legs with minecraft:iron_leggings`);
  await sleep(500);
}
/** Runs a scene with run59's pack in place of the kit S2's protocols give themselves (they call equip(...) by name). */
async function s4WithRun59Kit<T>(run: () => Promise<T>): Promise<T> {
  // @ts-ignore a function declaration's binding is writable; the protocols of S2 call equip() with a pack of their own, here they get run59's
  equip = (_items?: Record<string, number>, _options?: unknown) => s4EquipRun59();
  try { return await run(); } finally {
    // @ts-ignore
    equip = s4EquipOriginal;
  }
}
const s4Tp = async (dimension: 'overworld' | 'the_nether', x: number, y: number, z: number, clearance = 24): Promise<void> => {
  await ask(`execute in minecraft:${dimension} run forceload add ${Math.floor(x) - clearance} ${Math.floor(z) - clearance} ${Math.floor(x) + clearance} ${Math.floor(z) + clearance}`); await sleep(3000);
  await ask(`execute in minecraft:${dimension} run tp ${ACTOR} ${x + 0.5} ${y} ${z + 0.5}`); await sleep(2500);
};

/** The second spawner of the sites file, with the first camp cell the body's own reading names round it (read in spectator mode); the sites' blazeSpawner/blazeStand are put to it for the run. */
async function s4OnSpawnerB<T>(note: (text: string) => void, run: () => Promise<T>): Promise<T> {
  const first = sites.blazeSpawner as number[];
  const others = ((sites.blazeSpawners ?? []) as number[][]).filter(entry => entry[0] !== first[0] || entry[1] !== first[1] || entry[2] !== first[2]);
  const spawner = others[0];
  if (!spawner) throw new Error('no second spawner in the sites');
  await ask('difficulty peaceful'); await ask('gamemode spectator ' + ACTOR);
  await placeActor('the_nether', spawner[0], spawner[1] + 2, spawner[2], 40);
  await sleep(3000);
  const read = bodyReader(actor) as any;
  const cells = campSite(read, { x: spawner[0], y: spawner[1], z: spawner[2] }, 4).cells;
  note(`spawner B ${JSON.stringify(spawner)}: camp cells ${JSON.stringify(cells.map(c => [c.x, c.y, c.z, `walls ${c.walls} pits ${c.pits}`]))}`);
  const cell = cells[0];
  if (!cell) throw new Error('no camp cell round spawner B');
  const saved = { spawner: sites.blazeSpawner, stand: sites.blazeStand };
  sites.blazeSpawner = spawner; sites.blazeStand = [cell.x, cell.y, cell.z];
  try { return await run(); } finally { sites.blazeSpawner = saved.spawner; sites.blazeStand = saved.stand; }
}
scene('s4_blaze_b_body', 'spawner B with run59\'s pack: S2\'s protocol with the body\'s own retreat (fight, no retreatHp, no stopIf), 40 s fights, 5 s of thinking between acts', note => s4WithRun59Kit(() => s4OnSpawnerB(note, () => blazeProtocol('fight', note, { body: true }))));
scene('s4_blaze_b_hold', 'spawner B with run59\'s pack: S2\'s protocol with attack hold (stopIf hpBelow 12 -> hideout -> eat -> back)', note => s4WithRun59Kit(() => s4OnSpawnerB(note, () => blazeProtocol('hold', note))));
scene('s4_blaze_b_fight', 'spawner B with run59\'s pack: S2\'s protocol with fight (stopIf hpBelow 12 -> hideout -> eat -> back)', note => s4WithRun59Kit(() => s4OnSpawnerB(note, () => blazeProtocol('fight', note))));
scene('s4_blaze_a_body', 'spawner A (the staged stand) with run59\'s pack: the same body-retreat protocol, for the comparison with B', note => s4WithRun59Kit(() => blazeProtocol('fight', note, { body: true })));
scene('s4_blaze_a_hold', 'spawner A with run59\'s pack: the same hold protocol, for the comparison with B', note => s4WithRun59Kit(() => blazeProtocol('hold', note)));

// ---- the Nether road: what is seen on it, and what the ground is ---------------------------------------------------------------------------------------------------------
const S4_MOBS = new Set(['ghast', 'piglin', 'piglin_brute', 'hoglin', 'zoglin', 'zombified_piglin', 'wither_skeleton', 'blaze', 'magma_cube', 'skeleton', 'enderman', 'strider', 'creeper', 'zombie', 'spider', 'drowned', 'phantom']);
interface S4Seen { name: string; closest: number; firstAt: number }
/** Every half second: the creatures the client holds (by id: the closest they came, when first seen), and every two seconds the body's place. */
function s4Watch(): { stop: () => { seen: Map<number, S4Seen>; trail: Array<[number, number, number]>; lowestHp: number } } {
  const seen = new Map<number, S4Seen>(), trail: Array<[number, number, number]> = [], t0 = Date.now();
  let ticks = 0, lowestHp = Number(actor.health);
  const timer = setInterval(() => {
    const me = actor.entity?.position as Vec3 | undefined;
    if (!me) return;
    if (ticks++ % 4 === 0) trail.push([r1(me.x), r1(me.y), r1(me.z)]);
    lowestHp = Math.min(lowestHp, Number(actor.health));
    for (const entity of Object.values((actor.entities ?? {}) as Record<string, any>)) {
      const name = String(entity?.name ?? '');
      if (!S4_MOBS.has(name) || !entity.position) continue;
      const distance = r1(entity.position.distanceTo(me)), prev = seen.get(entity.id);
      if (!prev) seen.set(entity.id, { name, closest: distance, firstAt: Math.round((Date.now() - t0) / 1000) });
      else if (distance < prev.closest) prev.closest = distance;
    }
  }, 500);
  return { stop: () => { clearInterval(timer); return { seen, trail, lowestHp }; } };
}
const s4MobCounts = (seen: Map<number, S4Seen>): Record<string, unknown> => {
  const tally = (limit: number) => { const out: Record<string, number> = {}; for (const mob of seen.values()) if (mob.closest <= limit) out[mob.name] = (out[mob.name] ?? 0) + 1; return out; };
  return { everSeen: tally(1e9), within48: tally(48), within16: tally(16) };
};
const S4_BIOME_SHORT: Record<string, string> = { nether_wastes: 'wastes', crimson_forest: 'crimson', warped_forest: 'warped', soul_sand_valley: 'soulsand', basalt_deltas: 'basalt' };
let s4BiomeShown = 0;
/** The biome at a place by the server's own answer (`execute if biome`): one of the five of the Nether (their order is the likeliest first), else 'other'. */
async function s4BiomeAt(dimension: 'the_nether' | 'overworld', x: number, y: number, z: number): Promise<string> {
  for (const biome of Object.keys(S4_BIOME_SHORT)) {
    const text = await ask(`execute in minecraft:${dimension} if biome ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} minecraft:${biome}`, 8000);
    if (/Test passed/u.test(text)) return S4_BIOME_SHORT[biome]!;
    if (/Unknown|Incorrect|Expected|Invalid/u.test(text)) { if (s4BiomeShown++ < 2) log(`NOTE biome query refused: ${text.replace(/\s+/gu, ' ').slice(0, 200)}`); return '?'; }
  }
  return 'other';
}
/** The biomes along a line of places, one sample for every `spacing` metres walked (the server's answer): metres by biome, and the run of them in order. */
async function s4Biomes(dimension: 'the_nether' | 'overworld', points: Array<[number, number, number]>, spacing = 8): Promise<{ metres: Record<string, number>; sequence: string; samples: number }> {
  const metres: Record<string, number> = {}, runs: Array<{ biome: string; metres: number }> = [];
  let last: [number, number, number] | null = null, since = Infinity, samples = 0;
  for (const point of points) {
    if (last) since += Math.hypot(point[0] - last[0], point[2] - last[2]);
    last = point;
    if (since < spacing * 0.9) continue;
    const credited = Number.isFinite(since) ? Math.round(since) : spacing;
    since = 0;
    const biome = await s4BiomeAt(dimension, point[0], point[1], point[2]);
    samples++;
    metres[biome] = (metres[biome] ?? 0) + credited;
    const tail = runs.at(-1);
    if (tail && tail.biome === biome) tail.metres += credited; else runs.push({ biome, metres: credited });
  }
  return { metres, sequence: runs.map(item => `${item.biome} ${item.metres}`).join(' > '), samples };
}
const s4Line = (from: number[], to: number[], spacing = 8): Array<[number, number, number]> => {
  const length = Math.max(1, Math.hypot(to[0]! - from[0]!, to[2]! - from[2]!)), count = Math.ceil(length / spacing);
  return Array.from({ length: count + 1 }, (_, index) => { const t = index / count; return [Math.round(from[0]! + (to[0]! - from[0]!) * t), Math.round(from[1]! + (to[1]! - from[1]!) * t), Math.round(from[2]! + (to[2]! - from[2]!) * t)] as [number, number, number]; });
};
const S4_PASSABLE = (name: string): boolean => name === 'air' || name === 'cave_air' || name === 'void_air';
/** A floor the body could stand on in the column (x, z), the one nearest the height `nearY`, read from the chunks the client holds; null when nothing there is loaded or standable. */
function s4NetherFloor(x: number, z: number, nearY: number): number | null {
  let best: number | null = null;
  for (let y = Math.min(122, Math.floor(nearY) + 30); y >= Math.max(2, Math.floor(nearY) - 40); y--) {
    const feet = actor.blockAt(new Vec3(x, y, z), false), head = actor.blockAt(new Vec3(x, y + 1, z), false), ground = actor.blockAt(new Vec3(x, y - 1, z), false);
    if (!feet || !head || !ground) continue;
    if (!S4_PASSABLE(String(feet.name)) || !S4_PASSABLE(String(head.name))) continue;
    const below = String(ground.name);
    if (S4_PASSABLE(below) || below === 'lava' || below === 'magma_block' || below === 'fire' || below === 'soul_fire' || below === 'water') continue;
    if (best === null || Math.abs(y - nearY) < Math.abs(best - nearY)) best = y;
  }
  return best;
}
const s4Glyph = (x: number, y: number, z: number): string => {
  const name = actor.blockAt(new Vec3(x, y, z), false)?.name;
  if (!name) return '?';
  const p = actor.entity.position;
  if (Math.floor(p.x) === x && Math.floor(p.y) === y && Math.floor(p.z) === z) return '@';
  if (S4_PASSABLE(name)) return '.';
  if (name === 'lava') return '~';
  if (name === 'magma_block') return 'M';
  if (name === 'netherrack') return '#';
  if (name === 'soul_sand' || name === 'soul_soil') return 's';
  if (name === 'fire' || name === 'soul_fire') return 'f';
  if (name.includes('basalt') || name.includes('blackstone')) return 'b';
  if (name.includes('nether_brick')) return 'B';
  if (name === 'obsidian' || name === 'crying_obsidian') return 'O';
  if (name === 'nether_portal') return 'P';
  if (name === 'cobblestone') return 'c';
  if (name.includes('quartz')) return 'q';
  if (name === 'glowstone') return 'g';
  if (name.includes('warped') || name.includes('crimson') || name.includes('nylium') || name.includes('wart')) return 'w';
  return 'x';
};
const s4MapAround = (label: string, radius = 8, up = 2, down = 3): void => {
  const p = actor.entity.position, bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  for (let y = by + up; y >= by - down; y--) {
    log(`MAP ${label} y=${y} (${y - by >= 0 ? '+' : ''}${y - by})  x ${bx - radius}..${bx + radius} across, z ${bz - radius} (top)..${bz + radius}`);
    for (let z = bz - radius; z <= bz + radius; z++) { let row = ''; for (let x = bx - radius; x <= bx + radius; x++) row += s4Glyph(x, y, z); log(`MAP ${String(z).padStart(5)} ${row}`); }
  }
};
/** Lava in the chunks the client holds, round a place: the number of its blocks within 6, 12 and 24 of it, the nearest one, and the height range of the lava of the area (the lava sea is at y 31). */
function s4Lava(cx: number, cy: number, cz: number, radius = 24): Record<string, unknown> {
  const counts = { within6: 0, within12: 0, within24: 0 };
  let nearest = Infinity, nearestAt: number[] | null = null, highest = -1, lowest = 999, loaded = 0;
  for (let x = cx - radius; x <= cx + radius; x++) for (let z = cz - radius; z <= cz + radius; z++) {
    for (let y = Math.max(1, cy - 40); y <= Math.min(126, cy + 20); y++) {
      const block = actor.blockAt(new Vec3(x, y, z), false);
      if (!block) continue;
      loaded++;
      if (block.name !== 'lava') continue;
      const distance = Math.hypot(x - cx, y - cy, z - cz);
      if (distance <= 6) counts.within6++;
      if (distance <= 12) counts.within12++;
      if (distance <= 24) counts.within24++;
      if (distance < nearest) { nearest = distance; nearestAt = [x, y, z]; }
      highest = Math.max(highest, y); lowest = Math.min(lowest, y);
    }
  }
  return { ...counts, nearest: Number.isFinite(nearest) ? r1(nearest) : null, nearestAt, lavaYRange: highest >= 0 ? [lowest, highest] : null, blocksLooked: loaded };
}
interface S4WalkOut { reached: boolean; seconds: number; endDistance: number; endY: number; hops: number; okHops: number; hpLost: number; lowestHp: number; stops: string[]; pace: string; trail: Array<[number, number, number]>; mobs: Record<string, unknown> }
/** The walk of a head in the Nether: hops of at most 90 m along the line to the goal, each to a floor the loaded chunks show (the nearest to the body's height, the land to either side when the line has none), by go with the limits its knowledge gives; the stops are read and answered as the body's words say. */
async function s4NetherWalk(goal: number[], options: { limitMs: number; deaths0: number; label: string; note: (text: string) => void; reachMetres?: number; ignoreY?: boolean }): Promise<S4WalkOut> {
  // The hop's reach starts at 90 m (the head's knowledge); a stop that says the search did not finish (search_timeout, an act that came back with nothing) or a hop that gained next to nothing
  // makes the next hops shorter, down to 12 m (the body's own advice: "a relay point within 10 m"), and a hop that gained well makes them longer again.
  let hopMax = 90;
  const reachMetres = options.reachMetres ?? 8, started = Date.now(), watch = s4Watch();
  const stops: string[] = [], pace: string[] = [];
  const canDig = ['netherrack', 'basalt', 'blackstone'];
  let hops = 0, okHops = 0, hpLost = 0, sameStop = 0, lastStop = '', lowest = Number(actor.health);
  const maxDig = 200, maxPlace = 100;
  try {
    while (Date.now() - started < options.limitMs && s4Alive(options.deaths0) && hops < 30) {
      const here = actor.entity.position as Vec3, remain = s4Planar(goal);
      if (remain <= reachMetres && (options.ignoreY || Math.abs(here.y - goal[1]!) < 12)) break;
      let target = { x: goal[0]!, y: goal[1]!, z: goal[2]! };
      // The last hop, with the goal's own column in the loaded chunks: the floor there (a goal of a height not known beforehand, a head reads it off the map as it comes into view).
      if (remain <= hopMax && options.ignoreY) target.y = s4NetherFloor(goal[0]!, goal[2]!, here.y) ?? target.y;
      if (remain > hopMax) {
        let found: { x: number; y: number; z: number } | null = null;
        const base = Math.atan2(goal[2]! - here.z, goal[0]! - here.x);
        for (let step = hopMax; step >= 30 && !found; step = Math.floor(step * 0.7)) {
          for (const deg of [0, 25, -25, 50, -50, 75, -75]) {
            const a = base + deg * Math.PI / 180, tx = Math.round(here.x + Math.cos(a) * step), tz = Math.round(here.z + Math.sin(a) * step);
            if (remain - Math.hypot(goal[0]! - tx, goal[2]! - tz) < step * 0.3) continue;
            const y = s4NetherFloor(tx, tz, here.y);
            if (y !== null) { found = { x: tx, y, z: tz }; break; }
          }
        }
        target = found ?? { x: Math.round(here.x + Math.cos(base) * 60), y: Math.floor(here.y), z: Math.round(here.z + Math.sin(base) * 60) };
      }
      const hp0 = Number(actor.health), before = remain, hopStart = Date.now();
      const run = await act(`${options.label}#${hops + 1}`, [{ do: 'go', to: target, range: 3, seconds: 110, canDig: [...canDig], canPlace: ['cobblestone', 'netherrack'], maxDrop: 4, maxDig, maxPlace }], 150);
      hops++; if (run.ok) okHops++;
      hpLost += Math.max(0, hp0 - Number(actor.health)); lowest = Math.min(lowest, Number(actor.health));
      const gained = before - s4Planar(goal);
      pace.push(`${Math.round(gained)}m/${Math.round((Date.now() - hopStart) / 1000)}s${run.ok ? '' : '!'}`);
      const reach = Math.min(hopMax, before);
      if (!run.ok) {
        const why = s4Why(run);
        stops.push(`${Math.round((Date.now() - started) / 1000)}s ${why || '(no line: the act came back with nothing)'}`);
        const named = /が ([a-z_]+) で登れない（掘ってよい物に無い）/u.exec(why)?.[1];
        if (named && !canDig.includes(named) && canDig.length < 12) { canDig.push(named); options.note(`canDig gets ${named} (the line said so)`); }
        const shrink = (/search_timeout/u.test(why) || !why.trim() || gained < 3) && hopMax > 12;
        if (shrink) { hopMax = Math.max(12, Math.floor(hopMax * 0.4)); sameStop = 0; options.note(`the next hops are at most ${hopMax} m (${why.slice(0, 60) || 'no line'})`); }
        else { const key = s4Key(why); sameStop = key === lastStop ? sameStop + 1 : 1; lastStop = key; }
        await sleep(1500);
        if (sameStop >= 4) { options.note(`the same stop four times: ${why}`); break; }
      } else { sameStop = 0; if (gained >= 0.6 * reach && hopMax < 90) hopMax = Math.min(90, Math.round(hopMax * 1.6)); }
      if (Number(actor.health) < 6) { options.note(`health ${actor.health}: the walk stops`); break; }
      await s4Eat();
    }
  } finally {
    const watched = watch.stop();
    s4LastWalk = { reached: s4Planar(goal) <= reachMetres, seconds: r1((Date.now() - started) / 1000), endDistance: r1(s4Planar(goal)), endY: s4Feet(), hops, okHops, hpLost: r1(hpLost), lowestHp: r1(Math.min(lowest, watched.lowestHp)), stops: stops.slice(0, 14), pace: pace.join(' '), trail: watched.trail, mobs: s4MobCounts(watched.seen) };
  }
  return s4LastWalk!;
}
let s4LastWalk: S4WalkOut | null = null;
/** A walk with what was seen and the biomes under the body's own trail (the server's answer at every 8th metre). */
async function s4Survey(label: string, goal: number[], note: (text: string) => void, limitMs: number): Promise<Record<string, unknown>> {
  const deaths0 = deaths;
  const walk = await s4NetherWalk(goal, { limitMs, deaths0, label, note });
  const biomes = await s4Biomes('the_nether', walk.trail);
  note(`${label}: ${walk.reached ? 'reached' : 'NOT reached'} in ${walk.seconds}s, ${walk.endDistance} m left, hops ${walk.okHops}/${walk.hops}, hp lost ${walk.hpLost} (lowest ${walk.lowestHp}); mobs ${JSON.stringify(walk.mobs)}; biomes ${biomes.sequence}`);
  return { ...walk, trail: undefined, trailPoints: walk.trail.length, biomes, deathsHere: deaths - deaths0 };
}
const s4RunLimit = (fallback: number): number => (timedSeconds || fallback) * 1000;
scene('s4_leg1_staged', 'the Nether road from the staged arrival (15,110,12) to the fortress stand: the walk of a head with run59\'s pack, natural spawning on; mobs seen and the biomes under the trail', async note => {
  const arrival = sites.netherArrival as number[], goal = sites.blazeStand as number[];
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true');
  await s4EquipRun59();
  await placeActor('the_nether', arrival[0]!, arrival[1]!, arrival[2]!, 48);
  return s4Survey('leg1', goal, note, s4RunLimit(600));
});
scene('s4_leg2', 'the Nether road from the fortress stand to the warped forest (249 m): the walk of a head with run59\'s pack, natural spawning on; mobs seen and the biomes under the trail', async note => {
  const from = sites.blazeStand as number[], goal = sites.warpedStand as number[];
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true');
  await s4EquipRun59();
  await placeActor('the_nether', from[0]!, from[1]!, from[2]!, 48);
  // The stand is the blaze camp inside the fortress: a body that has just got its rods leaves with the fortress's creatures about it (the first sample of this scene died there in 30 s,
  // wither skeletons and blazes within 16 m). HUNT_LEG2_CLEAR=1 starts it with those killed, to measure the road itself.
  if (process.env.HUNT_LEG2_CLEAR === '1') for (const kind of ['wither_skeleton', 'blaze', 'skeleton', 'magma_cube']) await ask(`execute in minecraft:the_nether run kill @e[type=minecraft:${kind}]`);
  return s4Survey('leg2', goal, note, s4RunLimit(900));
});
scene('s4_survey_line', 'no body walks: the biomes along the straight lines gate exit -> fortress, arrival -> fortress and fortress -> warped forest, and the nearest bastion and fortress from points on them (the server\'s own answers)', async note => {
  const arrival = sites.netherArrival as number[], fort = sites.blazeStand as number[], warped = sites.warpedStand as number[];
  const exit = [20, 75, 3];
  await ask('difficulty peaceful');
  const lines: Array<{ name: string; from: number[]; to: number[] }> = [{ name: 'gate-exit>fortress', from: exit, to: fort }, { name: 'arrival>fortress', from: arrival, to: fort }, { name: 'fortress>warped', from: fort, to: warped }];
  const biomes: Record<string, unknown> = {};
  for (const line of lines) { const found = await s4Biomes('the_nether', s4Line(line.from, line.to), 8); biomes[line.name] = found; note(`${line.name}: ${found.sequence}`); }
  const structures: Array<Record<string, unknown>> = [];
  for (const [name, at] of [['exit', exit], ['arrival', arrival], ['mid', [80, 76, 40]], ['fortress', fort], ['between', [225, 60, -25]], ['warped', warped]] as Array<[string, number[]]>) {
    for (const kind of ['bastion_remnant', 'fortress']) {
      const text = await ask(`execute in minecraft:the_nether positioned ${at[0]} ${at[1]} ${at[2]} run locate structure minecraft:${kind}`, 40_000, true);
      // The answer is a translatable message: the numbers are in its json (x, "~", z, then the distance), as locateFrom reads them.
      const numbers = [...text.matchAll(/"(-?\d{1,6})"|"text":"(-?\d{1,6})"|:(-?\d{1,6})[,}\]]/gu)].map(hit => Number(hit[1] ?? hit[2] ?? hit[3]));
      if (name === 'exit' && kind === 'bastion_remnant') note(`locate answer sample: ${text.replace(/\s+/gu, ' ').slice(0, 500)}`);
      structures.push({ from: name, kind, nearest: numbers.length >= 3 ? { x: numbers[0], z: numbers[1], blocks: numbers[2] } : text.replace(/\s+/gu, ' ').slice(0, 160) });
    }
  }
  note(`structures: ${JSON.stringify(structures)}`);
  return { biomes, structures };
});

// ---- the gate on the surface and the Nether side of it ------------------------------------------------------------------------------------------------------------------
/** The top solid block of a column in the chunks the client holds (leaves, logs, snow and grass are not the ground). */
function s4SurfaceY(x: number, z: number): number | null {
  for (let y = 150; y > 40; y--) {
    const block = actor.blockAt(new Vec3(x, y, z), false);
    if (!block) return null;
    const name = String(block.name);
    if (S4_PASSABLE(name) || name === 'snow' || name.endsWith('_leaves') || name.endsWith('_log') || name === 'vine' || name === 'short_grass' || name === 'tall_grass' || name === 'fern') continue;
    return y;
  }
  return null;
}
/** The gate of run59's task 1, built by the portal hand where the plan says (an inside cell at HUNT_GATE_AT, default 160,75,28) and gone into. */
async function s4GateEnter(note: (text: string) => void): Promise<{ entered: boolean; gate: { x: number; y: number; z: number; axis: string } | null; attempts: string[]; surfaceY: number | null }> {
  const spec = (process.env.HUNT_GATE_AT ?? '160,75,28').split(',').map(Number);
  const asked = { x: spec[0]!, y: spec[1]!, z: spec[2]! };
  await ask('difficulty normal'); await ask('gamerule doMobSpawning false'); await ask('time set noon'); await ask('gamerule doDaylightCycle false'); await ask('weather clear');
  await ask('gamemode spectator ' + ACTOR);
  await s4Tp('overworld', asked.x, 110, asked.z - 3, 28);
  await sleep(2000);
  const surfaceY = s4SurfaceY(asked.x, asked.z);
  const columns = [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [2, 0]].map(([dx, dz]) => s4SurfaceY(asked.x + dx!, asked.z + dz!));
  note(`the ground at the gate: top solid y ${surfaceY} (columns round it ${columns.join(',')}); the plan's inside cell is at y ${asked.y}`);
  const standY = (surfaceY ?? asked.y - 1) + 1;
  await ask(`execute in minecraft:overworld run tp ${ACTOR} ${asked.x + 0.5} ${standY} ${asked.z - 2.5}`); await sleep(1500);
  await s4EquipRun59();
  await sleep(2500);
  const attempts: string[] = [];
  const tries: Array<{ y: number; axis: 'x' | 'z' }> = [{ y: asked.y, axis: 'x' }, { y: asked.y, axis: 'z' }];
  if (surfaceY !== null && surfaceY + 2 !== asked.y) tries.push({ y: surfaceY + 2, axis: 'x' }, { y: surfaceY + 2, axis: 'z' });
  let gate: { x: number; y: number; z: number; axis: string } | null = null;
  for (const attempt of tries) {
    const cell = { x: asked.x, y: attempt.y, z: asked.z };
    const run = await act(`gate-${attempt.axis}-y${attempt.y}`, [{ do: 'portal', at: [cell], axis: attempt.axis, enter: true, canPlace: ['cobblestone'], maxPlace: 16, seconds: 100 }], 130);
    attempts.push(`axis ${attempt.axis} y ${attempt.y}: ${run.ok ? 'ok' : 'NO'} ${s4Short(run.lines[0] ?? run.error ?? '', 200)}`);
    gate = { ...cell, axis: attempt.axis };
    await sleep(3000);
    if (dimensionOf() === 'the_nether') break;
    // The frame stands and burns but the body is not in it: a walk onto the inside's lower cell, as the head's knowledge says.
    const lit = actor.blockAt(new Vec3(cell.x, cell.y, cell.z), false)?.name === 'nether_portal';
    if (lit) {
      for (let walks = 0; walks < 2 && dimensionOf() !== 'the_nether'; walks++) {
        const walk = await act('gate-walk', [{ do: 'walk', to: { x: cell.x, y: cell.y, z: cell.z }, range: 0.5 }], 45);
        attempts.push(`walk into the burning gate: ${walk.ok ? 'ok' : 'NO'} ${s4Short(walk.lines[0] ?? walk.error ?? '', 160)}`);
        await sleep(5000);
      }
      if (dimensionOf() === 'the_nether') break;
    }
    if (!/blocked|invalid_input/u.test(run.lines.join(' '))) break;      // a refusal of the place is tried at the next; anything else is what the gate is
  }
  if (dimensionOf() !== 'the_nether') {
    // The place the plan names does not take the frame: the head looks again for one that does (open air over a floor, a way in), as near as it finds, and asks the hand there.
    const spot = s4FindGateSpot(14);
    if (spot) {
      const run = await act(`gate-near-${spot.axis}`, [{ do: 'portal', at: [{ x: spot.x, y: spot.y, z: spot.z }], axis: spot.axis, enter: true, canPlace: ['cobblestone'], maxPlace: 16, seconds: 100 }], 130);
      attempts.push(`another place ${spot.x},${spot.y},${spot.z} axis ${spot.axis} (${r1(spot.moved)} off): ${run.ok ? 'ok' : 'NO'} ${s4Short(run.lines[0] ?? run.error ?? '', 200)}`);
      gate = { x: spot.x, y: spot.y, z: spot.z, axis: spot.axis };
      await sleep(3000);
    } else attempts.push('no other place within 14 m takes a frame');
  }
  return { entered: dimensionOf() === 'the_nether', gate, attempts, surfaceY };
}
scene('s4_gate_exit', 'run59 leg 2: the gate on the surface (portal hand at 160,75,28) and the Nether side: where the body comes out, the lava round it; then the walk to the fortress stand with the mobs seen and the biomes', async note => {
  const goal = sites.blazeStand as number[], deaths0 = deaths, arrival = sites.netherArrival as number[];
  const started = Date.now();
  const gate = await s4GateEnter(note);
  note(`the gate: ${gate.attempts.join(' | ')}`);
  if (!gate.entered) return { entered: false, ...gate };
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true');
  await sleep(4000);
  const p = actor.entity.position as Vec3;
  const exit = { x: r1(p.x), y: r1(p.y), z: r1(p.z) };
  note(`the Nether side: the body stands at ${exit.x},${exit.y},${exit.z} (the overworld gate's x/8, z/8 is ${gate.gate!.x / 8},${gate.gate!.z / 8}); the staged arrival of the lab is ${arrival.join(',')}`);
  const lava = s4Lava(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  note(`lava round the exit: ${JSON.stringify(lava)}`);
  s4MapAround('exit', 9, 2, 3);
  let portalBlocks = 0;
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -2; dy <= 4; dy++) if (actor.blockAt(new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz), false)?.name === 'nether_portal') portalBlocks++;
  const base = { entered: true, gate: gate.gate, surfaceY: gate.surfaceY, attempts: gate.attempts, exit, portalBlocksSeen: portalBlocks, distanceToStagedArrival: r1(Math.hypot(p.x - arrival[0]!, p.z - arrival[2]!)), lava, deathsHere: deaths - deaths0 };
  if ((process.env.HUNT_GATE_WALK ?? 'on') === 'off' || !s4Alive(deaths0)) return base;
  const survey = await s4Survey('exit>fortress', goal, note, Math.max(60_000, s4RunLimit(600) - (Date.now() - started)));
  return { ...base, survey };
});
