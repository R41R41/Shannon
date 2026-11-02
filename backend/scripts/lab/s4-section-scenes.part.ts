// ===== S4: the walks of the sections on the real seed ===================================================================================
// Inserted into a copy of S2's hunt probe by s4-section-probe.sh (before its "run" part), so the helpers of that file are in scope: ask, equip, placeActor, act, runSkill,
// actor, sites, scene, dimensionOf, timedSeconds, deaths, disconnected, sleep, r1, Vec3. No model: a scripted stand-in plays the head's part by naming a place and the limits,
// and the way (what to tread, dig, lay) is the body's. What it finds are the stops a section would meet on this seed, before a run with the head gets there.
// Scenes: route_fortress (S6: the Nether, arrival to the blaze stand), route_stronghold (S9: the overworld, spawn to the stronghold, 1.4 km on c1), dig_to_room (S9 to S10: the
// surface above the room down to its depth), frames_enter (S10: twelve eyes into the twelve frames, then into the portal).

const s4Planar = (to: number[]): number => { const at = actor.entity?.position as Vec3 | undefined; return at ? Math.hypot(at.x - (to[0] + 0.5), at.z - (to[2] + 0.5)) : Number.NaN; };
const s4Alive = (deathsAtStart: number) => Number(actor.health) > 0 && deaths === deathsAtStart && !disconnected;
const s4Feet = () => Math.floor(Number(actor.entity?.position?.y ?? Number.NaN));
const S4_KIT_S6 = { iron_sword: 1, diamond_pickaxe: 1, iron_pickaxe: 1, bow: 1, arrow: 32, water_bucket: 1, flint_and_steel: 1, cobblestone: 64, torch: 16, cooked_beef: 16 };
const S4_KIT_S9 = { diamond_pickaxe: 1, iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, bow: 1, arrow: 32, water_bucket: 1, cobblestone: 64, torch: 16, cooked_beef: 24, white_bed: 1 };
const S4_KIT_S10 = { diamond_pickaxe: 1, iron_sword: 1, water_bucket: 1, cobblestone: 64, cooked_beef: 8, ender_eye: 12 };
const s4Short = (text: string, n = 200) => text.replace(/\s+/gu, ' ').slice(0, n);
async function s4Eat(): Promise<void> { if (Number(actor.health) < 12 || Number(actor.food) < 14) await act('eat', [{ do: 'eat' }], 15); }
/** The closed reason a stopped act gives (`... 止まった <reason>`), or the first words of its first line. */
/** A stop with its numbers taken out: the same stop at another place is the same stop. */
const s4Key = (why: string): string => why.replace(/-?\d+(\.\d+)?/gu, '#').slice(0, 120);
const s4Why = (run: ActRun): string => { const line = run.lines.find(text => /止まった|stopped|NO|failed/u.test(text)) ?? run.lines[0] ?? run.error ?? ''; return s4Short(`${run.stoppedBy ?? ''} ${run.stoppedWhy ?? ''} ${line}`, 220); };

scene('route_fortress', 'S6 on the real seed: from the Nether arrival to the fortress by go (the place is named, the way is the body\'s), natural mob spawning on', async note => {
  const arrival = sites.netherArrival as number[] | undefined, goal = sites.blazeStand as number[] | undefined, spawner = sites.blazeSpawner as number[] | undefined;
  if (!arrival || !goal || !spawner) throw new Error('no netherArrival / blazeStand / blazeSpawner in the sites');
  const deaths0 = deaths;
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true');
  await equip(S4_KIT_S6, { armor: 'iron', shield: true });
  await placeActor('the_nether', arrival[0], arrival[1], arrival[2], 48);
  const limitMs = (timedSeconds || 900) * 1000, started = Date.now();
  const metrics = { acts: 0, okActs: 0, reflexStops: 0, hpLost: 0, lowestHp: 20, startDistance: r1(s4Planar(goal)), minDistance: r1(s4Planar(goal)), startY: s4Feet() };
  const stops: string[] = [];
  let sameStop = 0, lastStop = '', maxDig = 40, maxPlace = 20;
  note(`start ${actor.entity?.position} (${metrics.startDistance} m from the stand)`);
  try {
    while (Date.now() - started < limitMs && s4Alive(deaths0)) {
      if (s4Planar(spawner) < 24) { note('within 24 m of the spawner: the section\'s end'); break; }
      const hp0 = Number(actor.health);
      const run = await act(`go#${metrics.acts + 1}`, [{ do: 'go', to: { x: goal[0], y: goal[1], z: goal[2] }, range: 3, seconds: 90, canDig: ['netherrack'], canPlace: ['cobblestone'], maxDrop: 4, maxDig, maxPlace }], 120);
      metrics.acts++; if (run.ok) metrics.okActs++;
      if (run.stoppedBy === 'reflex') metrics.reflexStops++;
      metrics.hpLost += Math.max(0, hp0 - Number(actor.health)); metrics.lowestHp = Math.min(metrics.lowestHp, Number(actor.health));
      metrics.minDistance = Math.min(metrics.minDistance, r1(s4Planar(goal)));
      if (!run.ok) {
        const why = s4Why(run);
        stops.push(`${Math.round((Date.now() - started) / 1000)}s ${why}`);
        // The stand-in head reads the stop's own advice, as the head does: a dig or place limit is raised and the go is sent again; any other stop counts toward giving up.
        if (/limit_dig/u.test(why) && maxDig < 200) { maxDig = Math.min(200, maxDig * 2); sameStop = 0; }
        else if (/limit_place/u.test(why) && maxPlace < 100) { maxPlace = Math.min(100, maxPlace * 2); sameStop = 0; }
        else { const key = s4Key(why); sameStop = key === lastStop ? sameStop + 1 : 1; lastStop = key; }
        await sleep(1500);
        if (sameStop >= 4) { note(`the same stop four times: ${why}`); break; }
      } else sameStop = 0;
      await s4Eat();
    }
  } finally { await ask('gamerule doMobSpawning false'); }
  const reached = s4Planar(spawner) < 24;
  return { reached, seconds: r1((Date.now() - started) / 1000), endDistance: r1(s4Planar(goal)), endY: s4Feet(), maxDigAsked: maxDig, maxPlaceAsked: maxPlace, ...metrics, deathsHere: deaths - deaths0, stops: stops.slice(0, 14) };
});

scene('route_stronghold', 'S9 on the real seed: the walk from the spawn to the first-ring stronghold by go hops along the straight line the eyes give', async note => {
  const from = sites.spawn as number[] | undefined, goal = (sites.strongholdSurface ?? sites.strongholdPortalCenter) as number[] | undefined;
  if (!from || !goal) throw new Error('no spawn / strongholdSurface in the sites');
  const deaths0 = deaths;
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true'); await ask('gamerule doDaylightCycle false'); await ask('time set day'); await ask('weather clear');
  await equip(S4_KIT_S9, { armor: 'iron', shield: true });
  await placeActor('overworld', from[0], from[1], from[2], 32);
  const limitMs = (timedSeconds || 1500) * 1000, started = Date.now();
  const total = s4Planar(goal);
  const metrics = { hops: 0, okHops: 0, hpLost: 0, lowestHp: 20, waterHops: 0, slowHops: 0, totalDistance: r1(total) };
  const stops: string[] = [], pace: string[] = [];
  /** The first solid column top at (x, z) in the chunks the client holds: leaves and logs are no ground; water is a surface to swim on; null when the column is not loaded. */
  const surfaceAt = (x: number, z: number): { y: number; water: boolean } | null => {
    for (let y = 318; y > 30; y--) {
      const block = actor.blockAt(new Vec3(x, y, z), false);
      if (!block) return null;
      const name = String(block.name);
      if (name === 'air' || name === 'cave_air' || name === 'void_air' || name === 'snow' || name.endsWith('_leaves') || name.endsWith('_log') || name === 'vine' || name === 'short_grass' || name === 'tall_grass') continue;
      return { y, water: name === 'water' || name === 'kelp' || name === 'seagrass' || name === 'tall_seagrass' };
    }
    return null;
  };
  let slowRun = 0, stuck = false, maxPlace = 20, maxDig = 40;
  try {
    while (Date.now() - started < limitMs && s4Alive(deaths0)) {
      const here = actor.entity.position as Vec3;
      const remain = Math.hypot(goal[0] - (here.x), goal[2] - (here.z));
      if (remain < 32) { note('within 32 m of the stronghold'); break; }
      let step = Math.min(110, remain), column: { y: number; water: boolean } | null = null, tx = 0, tz = 0;
      for (; step >= 24 && !column; step = Math.floor(step * 0.7)) {
        tx = Math.round(here.x + (goal[0] - here.x) / remain * step); tz = Math.round(here.z + (goal[2] - here.z) / remain * step);
        column = surfaceAt(tx, tz);
      }
      if (!column) { stops.push(`${Math.round((Date.now() - started) / 1000)}s no loaded column ahead (${Math.round(here.x)},${Math.round(here.z)})`); await sleep(3000); if (stops.length > 8) break; continue; }
      const hp0 = Number(actor.health), before = remain, hopStart = Date.now();
      const run = await act(`hop#${metrics.hops + 1}`, [{ do: 'go', to: { x: tx, y: column.water ? column.y : column.y + 1, z: tz }, range: 2, seconds: 100, canPlace: ['cobblestone'], maxDrop: 4, maxPlace, maxDig, ...(column.water ? { waterOk: true } : {}) }], 130);
      metrics.hops++; if (run.ok) metrics.okHops++; if (column.water) metrics.waterHops++;
      metrics.hpLost += Math.max(0, hp0 - Number(actor.health)); metrics.lowestHp = Math.min(metrics.lowestHp, Number(actor.health));
      const after = Math.hypot(goal[0] - actor.entity.position.x, goal[2] - actor.entity.position.z), gained = before - after;
      pace.push(`${Math.round(gained)}m/${Math.round((Date.now() - hopStart) / 1000)}s${column.water ? '~' : ''}${run.ok ? '' : '!'}`);
      if (gained < 10) { slowRun++; metrics.slowHops++; } else slowRun = 0;
      if (!run.ok) {
        const why = s4Why(run);
        stops.push(`${Math.round((Date.now() - started) / 1000)}s ${why}`);
        // As the head does with the stop's own advice: a place or dig limit is raised and the hop is sent again.
        if (/limit_place/u.test(why) && maxPlace < 100) maxPlace = Math.min(100, maxPlace * 2);
        if (/limit_dig/u.test(why) && maxDig < 200) maxDig = Math.min(200, maxDig * 2);
        await sleep(1500);
      }
      if (slowRun >= 4) { stuck = true; note(`four hops in a row gained under 10 m: ${stops.at(-1) ?? ''}`); break; }
      await s4Eat();
    }
  } finally { await ask('gamerule doMobSpawning false'); await ask('gamerule doDaylightCycle true'); }
  const end = s4Planar(goal);
  return { reached: end < 32, stuck, seconds: r1((Date.now() - started) / 1000), endDistance: r1(end), endY: s4Feet(), ...metrics, deathsHere: deaths - deaths0, pace: pace.join(' '), stops: stops.slice(0, 14) };
});

scene('dig_to_room', 'S9 to S10 on the real seed: from the surface above the stronghold down to the depth of its portal room by vertical (170 blocks on c1)', async note => {
  const top = (sites.strongholdSurface ?? sites.strongholdPortalCenter) as number[] | undefined, room = sites.strongholdPortalCenter as number[] | undefined;
  if (!top || !room) throw new Error('no strongholdSurface / strongholdPortalCenter in the sites');
  const deaths0 = deaths, toY = room[1] + 4;
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true'); await ask('time set day'); await ask('weather clear');
  await equip({ diamond_pickaxe: 1, iron_sword: 1, water_bucket: 2, cobblestone: 64, torch: 16, cooked_beef: 16 }, { armor: 'iron', shield: true });
  await placeActor('overworld', top[0], top[1] + 1, top[2], 24);
  const limitMs = (timedSeconds || 900) * 1000, started = Date.now(), startY = s4Feet();
  const metrics = { acts: 0, okActs: 0, hpLost: 0, lowestHp: 20, startY, toY, depth: startY - toY };
  const stops: string[] = [], progress: string[] = [];
  let sameStop = 0, lastStop = '';
  try {
    while (Date.now() - started < limitMs && s4Alive(deaths0) && s4Feet() > toY) {
      const hp0 = Number(actor.health), y0 = s4Feet();
      const run = await act(`vertical#${metrics.acts + 1}`, [{ do: 'vertical', dir: 'down', shape: 'shaft', toY, canDig: ['stone', 'dirt', 'gravel', 'snow_block', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'coal_ore', 'iron_ore', 'copper_ore'], liquid: 'seal_water', maxDig: 200, maxPlace: 100, seconds: 120 }], 150);
      metrics.acts++; if (run.ok) metrics.okActs++;
      metrics.hpLost += Math.max(0, hp0 - Number(actor.health)); metrics.lowestHp = Math.min(metrics.lowestHp, Number(actor.health));
      progress.push(`${y0}->${s4Feet()}${run.ok ? '' : '!'}`);
      if (!run.ok) { const why = s4Why(run); stops.push(`${Math.round((Date.now() - started) / 1000)}s y${s4Feet()} ${why}`); const key = s4Key(why); sameStop = key === lastStop ? sameStop + 1 : 1; lastStop = key; await sleep(1500); if (sameStop >= 3) { note(`the same stop three times: ${why}`); break; } } else sameStop = 0;
      await s4Eat();
    }
  } finally { await ask('gamerule doMobSpawning false'); }
  return { reachedDepth: s4Feet() <= toY, endY: s4Feet(), horizontalFromRoom: r1(s4Planar(room)), seconds: r1((Date.now() - started) / 1000), ...metrics, deathsHere: deaths - deaths0, progress: progress.join(' '), stops: stops.slice(0, 12) };
});

scene('frames_enter', 'S10 on the real seed: twelve eyes into the twelve frames of the room (all empty), then into the portal and the End', async note => {
  const stand = sites.strongholdStand as number[] | undefined, centre = sites.strongholdPortalCenter as number[] | undefined;
  const frames = (sites.strongholdFrames ?? []) as Array<{ x: number; y: number; z: number; facing: string }>;
  if (!stand || !centre || frames.length < 12) throw new Error('no strongholdStand / strongholdPortalCenter / 12 strongholdFrames in the sites');
  const deaths0 = deaths;
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true');
  await ask(`execute in minecraft:overworld run forceload add ${centre[0] - 40} ${centre[2] - 40} ${centre[0] + 40} ${centre[2] + 40}`); await sleep(3500);
  for (const frame of frames) await ask(`execute in minecraft:overworld run setblock ${frame.x} ${frame.y} ${frame.z} minecraft:end_portal_frame[facing=${frame.facing},eye=false] replace`);
  await equip(S4_KIT_S10, { armor: 'iron', shield: true });
  await placeActor('overworld', stand[0], stand[1], stand[2], 24);
  const filled = async (): Promise<number> => {
    let count = 0;
    for (const frame of frames) { const text = await ask(`execute in minecraft:overworld if block ${frame.x} ${frame.y} ${frame.z} minecraft:end_portal_frame[eye=true]`, 6000); if (/Test passed/u.test(text)) count++; }
    return count;
  };
  const started = Date.now(), stops: string[] = [];
  const metrics = { placed: 0, tries: 0, hpLost: 0, lowestHp: 20, startDistance: r1(s4Planar(centre)) };
  const order = [...frames].sort((a, b) => Math.hypot(a.x - stand[0], a.z - stand[2]) - Math.hypot(b.x - stand[0], b.z - stand[2]));
  for (const frame of order) {
    if (!s4Alive(deaths0)) break;
    const hp0 = Number(actor.health);
    const run = await act(`frame#${metrics.tries + 1}`, [{ do: 'go', to: { x: frame.x, y: frame.y, z: frame.z }, range: 3, seconds: 25 }, { do: 'use', item: 'ender_eye', at: [{ x: frame.x, y: frame.y, z: frame.z }] }], 60);
    metrics.tries++; if (run.ok) metrics.placed++;
    metrics.hpLost += Math.max(0, hp0 - Number(actor.health)); metrics.lowestHp = Math.min(metrics.lowestHp, Number(actor.health));
    if (!run.ok) stops.push(`frame ${frame.x},${frame.z}: ${s4Why(run)}`);
  }
  const eyesServer = await filled();
  note(`frames with an eye on the server: ${eyesServer}/12; stops ${stops.length}`);
  const portalTries: string[] = [];
  let entered = false;
  for (const hand of [{ do: 'go', to: { x: centre[0], y: centre[1], z: centre[2] }, range: 0, seconds: 25 }, { do: 'walk', to: { x: centre[0], y: centre[1], z: centre[2] }, range: 0.5 }]) {
    if (!s4Alive(deaths0) || eyesServer < 12) break;
    const run = await act(`portal-${hand.do}`, [hand], 45);
    await sleep(4000);
    portalTries.push(`${hand.do}:${run.ok ? 'ok' : 'NO'} ${dimensionOf()} ${s4Short(run.lines[0] ?? run.error ?? '', 140)}`);
    if (dimensionOf() === 'the_end') { entered = true; break; }
  }
  return { eyesServer, placed: metrics.placed, entered, dimension: dimensionOf(), seconds: r1((Date.now() - started) / 1000), ...metrics, deathsHere: deaths - deaths0, portalTries, stops: stops.slice(0, 12) };
});

