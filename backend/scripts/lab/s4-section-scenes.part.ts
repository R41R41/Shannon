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
  // What the planner can learn at the arrival without walking: does find-structure see the spawner from here (the client holds the chunks within the view distance)?
  const seen = await runSkill('find-structure', { structureType: 'blaze_spawner' }, 20);
  const seenText = String(seen.receipt?.result ?? '');
  note(`find-structure blaze_spawner from the arrival: ${s4Short(seenText, 260)}`);
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
  return { reached, spawnerSeenFromArrival: /ブレイズの湧き場を発見/u.test(seenText), seconds: r1((Date.now() - started) / 1000), endDistance: r1(s4Planar(goal)), endY: s4Feet(), maxDigAsked: maxDig, maxPlaceAsked: maxPlace, ...metrics, deathsHere: deaths - deaths0, stops: stops.slice(0, 14) };
});

scene('route_stronghold', 'S9 on the real seed: the walk from the spawn to the first-ring stronghold by go hops along the straight line the eyes give', async note => {
  const from = (process.env.HUNT_FROM ? process.env.HUNT_FROM.split(',').map(Number) : sites.spawn) as number[] | undefined, goal = (sites.strongholdSurface ?? sites.strongholdPortalCenter) as number[] | undefined;
  if (!from || !goal) throw new Error('no spawn / strongholdSurface in the sites');
  const deaths0 = deaths;
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true'); await ask('gamerule doDaylightCycle false'); await ask('time set day'); await ask('weather clear');
  // HUNT_KIT=run59: the pack of run59 (160 cobblestone and 90 cobbled deepslate to lay) in place of the plan's S9 kit
  const run59 = process.env.HUNT_KIT === 'run59';
  if (run59) await s4EquipRun59(); else await equip(S4_KIT_S9, { armor: 'iron', shield: true });
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
  let slowRun = 0, stuck = false, maxPlace = 20, maxDig = 40, maxStep = 110, usedStep = 0;
  try {
    while (Date.now() - started < limitMs && s4Alive(deaths0)) {
      const here = actor.entity.position as Vec3;
      const remain = Math.hypot(goal[0] - (here.x), goal[2] - (here.z));
      if (remain < 32) { note('within 32 m of the stronghold'); break; }
      let step = Math.min(maxStep, remain), column: { y: number; water: boolean } | null = null, tx = 0, tz = 0;
      for (; step >= 24 && !column; step = Math.floor(step * 0.7)) {
        // The planner looks at the map and takes the land that leads toward the stronghold: the first dry column from the straight line outwards (up to 100 degrees off), else the water straight ahead.
        let fallback: { tx: number; tz: number; column: { y: number; water: boolean } } | null = null;
        const base = Math.atan2(goal[2] - here.z, goal[0] - here.x);
        for (const deg of [0, 25, -25, 50, -50, 75, -75, 100, -100]) {
          const a = base + deg * Math.PI / 180;
          const x = Math.round(here.x + Math.cos(a) * step), z = Math.round(here.z + Math.sin(a) * step);
          if (remain - Math.hypot(goal[0] - x, goal[2] - z) < step * 0.25) continue;
          const col = surfaceAt(x, z);
          if (!col) continue;
          if (!col.water) { tx = x; tz = z; column = col; break; }
          fallback ??= { tx: x, tz: z, column: col };
        }
        if (!column && fallback) { tx = fallback.tx; tz = fallback.tz; column = fallback.column; }
        if (column) usedStep = step;
      }
      if (!column) { stops.push(`${Math.round((Date.now() - started) / 1000)}s no loaded column ahead (${Math.round(here.x)},${Math.round(here.z)})`); await sleep(3000); if (stops.length > 8) break; continue; }
      const hp0 = Number(actor.health), before = remain, hopStart = Date.now();
      const run = await act(`hop#${metrics.hops + 1}`, [{ do: 'go', to: { x: tx, y: column.water ? column.y : column.y + 1, z: tz }, range: 2, seconds: 100, canPlace: run59 ? ['cobblestone', 'cobbled_deepslate'] : ['cobblestone'], maxDrop: 4, maxPlace, maxDig, ...(column.water ? { waterOk: true } : {}) }], 130);
      metrics.hops++; if (run.ok) metrics.okHops++; if (column.water) metrics.waterHops++;
      metrics.hpLost += Math.max(0, hp0 - Number(actor.health)); metrics.lowestHp = Math.min(metrics.lowestHp, Number(actor.health));
      const after = Math.hypot(goal[0] - actor.entity.position.x, goal[2] - actor.entity.position.z), gained = before - after;
      pace.push(`${Math.round(gained)}m/${Math.round((Date.now() - hopStart) / 1000)}s${column.water ? '~' : ''}${run.ok ? '' : '!'}`);
      if (gained < 10) { slowRun++; metrics.slowHops++; } else slowRun = 0;
      // Short legs after a search that timed out (the body's own advice: relay points), longer again once legs are walked.
      if (!run.ok && /search_timeout/u.test(s4Why(run))) maxStep = Math.max(40, Math.floor(maxStep * 0.6));
      else if (gained >= 0.6 * usedStep && maxStep < 110) maxStep = Math.min(110, Math.round(maxStep * 1.3));
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

scene('dig_to_room', 'S9 to S10 on the real seed: from the surface above the stronghold down to its portal room by go, as the head\'s knowledge says (maxDig, canDig, canPlace; 170 blocks on c1)', async note => {
  const top = (sites.strongholdSurface ?? sites.strongholdPortalCenter) as number[] | undefined, room = sites.strongholdPortalCenter as number[] | undefined;
  const stand = (sites.strongholdStand ?? room) as number[] | undefined;
  if (!top || !room || !stand) throw new Error('no strongholdSurface / strongholdPortalCenter / strongholdStand in the sites');
  const deaths0 = deaths;
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true'); await ask('time set day'); await ask('weather clear');
  // The kit of S9 plus a spare pickaxe: one iron pickaxe breaks after about 250 digs, and 170 levels of stairs need more than that.
  await equip({ diamond_pickaxe: 1, iron_pickaxe: 2, iron_sword: 1, water_bucket: 1, cobblestone: 64, torch: 16, cooked_beef: 24 }, { armor: 'iron', shield: true });
  await placeActor('overworld', top[0], top[1] + 1, top[2], 24);
  const limitMs = (timedSeconds || 900) * 1000, started = Date.now(), startY = s4Feet();
  const metrics = { acts: 0, okActs: 0, hpLost: 0, lowestHp: 20, startY, toY: stand[1], depth: startY - stand[1] };
  const stops: string[] = [], progress: string[] = [];
  let maxDig = 120, maxPlace = 24, sameStop = 0, lastStop = '';
  // The head gives 12 block names at most (its knowledge: "stone, dirt, gravel and up to 12"); a stop that names another block puts it in, in place of the last one.
  const canDig = ['stone', 'dirt', 'grass_block', 'gravel', 'sand', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobblestone', 'stone_bricks'];
  const arrived = () => { const here = actor.entity?.position as Vec3 | undefined; return !!here && Math.hypot(here.x - (stand[0] + 0.5), here.z - (stand[2] + 0.5)) < 4 && Math.abs(here.y - stand[1]) < 4; };
  try {
    while (Date.now() - started < limitMs && s4Alive(deaths0) && !arrived() && metrics.acts < 14) {
      const hp0 = Number(actor.health), y0 = s4Feet();
      const run = await act(`descend#${metrics.acts + 1}`, [{ do: 'go', to: { x: stand[0], y: stand[1], z: stand[2] }, range: 1.5, seconds: 110, maxDig, maxPlace, canDig: [...canDig], canPlace: ['cobblestone'] }], 150);
      metrics.acts++; if (run.ok) metrics.okActs++;
      metrics.hpLost += Math.max(0, hp0 - Number(actor.health)); metrics.lowestHp = Math.min(metrics.lowestHp, Number(actor.health));
      progress.push(`${y0}->${s4Feet()}${run.ok ? '' : '!'}`);
      if (!run.ok) {
        const why = s4Why(run);
        stops.push(`${Math.round((Date.now() - started) / 1000)}s y${s4Feet()} ${why}`);
        if (/limit_dig/u.test(why) && maxDig < 200) maxDig = Math.min(200, maxDig + 60);
        if (/limit_place/u.test(why) && maxPlace < 100) maxPlace = Math.min(100, maxPlace + 30);
        const named = /が ([a-z_]+) で登れない（掘ってよい物に無い）/u.exec(why)?.[1] ?? /cannot_dig: ([a-z_]+)/u.exec(why)?.[1] ?? /dead_end[^]*?([a-z]+(?:_[a-z]+)+)/u.exec(why)?.[1];
        if (named && !canDig.includes(named)) { if (canDig.length >= 12) canDig.pop(); canDig.push(named); note(`canDig gets ${named} (the line said so)`); }
        const key = s4Key(why); sameStop = key === lastStop ? sameStop + 1 : 1; lastStop = key;
        await sleep(1500);
        if (sameStop >= 4) { note(`the same stop four times: ${why}`); break; }
      } else sameStop = 0;
      await s4Eat();
    }
  } finally { await ask('gamerule doMobSpawning false'); }
  return { arrived: arrived(), endY: s4Feet(), horizontalFromRoom: r1(s4Planar(room)), seconds: r1((Date.now() - started) / 1000), maxDigAsked: maxDig, canDigFinal: canDig.join(','), ...metrics, deathsHere: deaths - deaths0, progress: progress.join(' '), stops: stops.slice(0, 12) };
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
  const metrics = { placed: 0, tries: 0, passes: 0, hpLost: 0, lowestHp: 20, startDistance: r1(s4Planar(centre)) };
  const hasEye = async (frame: { x: number; y: number; z: number }) => /Test passed/u.test(await ask(`execute in minecraft:overworld if block ${frame.x} ${frame.y} ${frame.z} minecraft:end_portal_frame[eye=true]`, 6000));
  // Passes over the frames still empty on the server, as the head asks again for the missing ones (the room's silverfish spawner interrupts a hand with a reflex).
  for (let pass = 1; pass <= 4 && s4Alive(deaths0); pass++) {
    const empty: typeof frames = [];
    for (const frame of frames) if (!await hasEye(frame)) empty.push(frame);
    if (!empty.length) break;
    metrics.passes = pass;
    note(`pass ${pass}: ${empty.length} frames still empty`);
    const here = actor.entity.position as Vec3;
    empty.sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z));
    for (const frame of empty) {
      if (!s4Alive(deaths0)) break;
      const hp0 = Number(actor.health);
      const run = await act(`frame#${metrics.tries + 1}`, [{ do: 'go', to: { x: frame.x, y: frame.y, z: frame.z }, range: 3, seconds: 25, canPlace: ['cobblestone'], maxPlace: 8 }, { do: 'use', item: 'ender_eye', at: [{ x: frame.x, y: frame.y, z: frame.z }] }], 60);
      metrics.tries++; if (run.ok) metrics.placed++;
      metrics.hpLost += Math.max(0, hp0 - Number(actor.health)); metrics.lowestHp = Math.min(metrics.lowestHp, Number(actor.health));
      if (!run.ok && /falling_above|dead_end|no_floor/u.test(s4Why(run))) turns++;
    if (!run.ok) stops.push(`pass ${pass} frame ${frame.x},${frame.z}: ${s4Why(run)}`);
    }
  }
  const eyesServer = await filled();
  note(`frames with an eye on the server: ${eyesServer}/12 after ${metrics.passes} passes; stops ${stops.length}`);
  const portalTries: string[] = [];
  let entered = false;
  // The head's knowledge: walk (not go) onto the portal cell, from the ring.
  for (const hand of [{ do: 'walk', to: { x: centre[0], y: centre[1], z: centre[2] }, range: 0.5 }, { do: 'walk', to: { x: centre[0], y: centre[1], z: centre[2] }, range: 0.5 }]) {
    if (!s4Alive(deaths0) || eyesServer < 12) break;
    const run = await act(`portal-${hand.do}`, [hand], 45);
    await sleep(4000);
    portalTries.push(`${hand.do}:${run.ok ? 'ok' : 'NO'} ${dimensionOf()} ${s4Short(run.lines[0] ?? run.error ?? '', 140)}`);
    if (dimensionOf() === 'the_end') { entered = true; break; }
  }
  return { eyesServer, placed: metrics.placed, entered, dimension: dimensionOf(), seconds: r1((Date.now() - started) / 1000), ...metrics, deathsHere: deaths - deaths0, portalTries, stops: stops.slice(0, 12) };
});


/** The blaze camp as a head plays it: the body's own words steer (a fire it names is dug out, a place it calls unsafe is left for the next cell), up to three rods or the clock. */
async function blazeCampHead(kind: 'fight' | 'hold', note: (text: string) => void): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined, spawner = sites.blazeSpawner as number[] | undefined;
  if (!stand || !spawner) throw new Error('no blazeStand / blazeSpawner in the sites');
  const deaths0 = deaths;
  const limitMs = (timedSeconds || 600) * 1000;
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
  await equip({ diamond_sword: 1, iron_pickaxe: 1, shield: 2, cooked_beef: 24, golden_apple: 3, cobblestone: 64 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const rods0 = await countServer('blaze_rod'), started = Date.now(), shield0 = shieldUsed();
  const found = await runSkill('find-structure', { structureType: 'blaze_spawner' }, 20);
  const cells = [...String(found.receipt?.result ?? '').matchAll(/\((-?\d+), (-?\d+), (-?\d+)\) [\d.]+m・壁/gu)].map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
  if (!cells.length) cells.push([stand[0], stand[1], stand[2]]);
  note(`camp cells ${JSON.stringify(cells)}`);
  const metrics = { acts: 0, okActs: 0, fireDug: 0, cellChanges: 0, hpLost: 0, lowestHp: 20, rods: 0, kills: 0, eats: 0 };
  const stops: string[] = [];
  let cell = 0, failStreak = 0;
  while (Date.now() - started < limitMs && s4Alive(deaths0) && metrics.rods < 3) {
    const here = cells[cell % cells.length]!;
    const go = { do: 'go', to: { x: here[0], y: here[1], z: here[2] }, range: 0.6, seconds: 20 };
    const hands = kind === 'hold' ? [go, { do: 'attack', target: 'blaze', hold: true, seconds: 25 }, { do: 'pickup', range: 8 }] : [go, { do: 'fight', target: 'blaze', seconds: 25, retreatHp: 8 }, { do: 'pickup', range: 8 }];
    const hp0 = Number(actor.health);
    const run = await act(`${kind}#${metrics.acts + 1}`, hands, 70, { accept: ['blaze'] });
    metrics.acts++; if (run.ok) { metrics.okActs++; failStreak = 0; } else failStreak++;
    metrics.hpLost += Math.max(0, hp0 - Number(actor.health)); metrics.lowestHp = Math.min(metrics.lowestHp, Number(actor.health));
    const text = run.lines.join(' ');
    metrics.kills += (text.match(/倒した (\d+)/gu) ?? []).reduce((sum, hit) => sum + Number(hit.replace(/\D+/gu, '')), 0) + (text.match(/fight 済 blaze/gu) ?? []).length;
    metrics.rods = (await countServer('blaze_rod')) - rods0;
    if (!run.ok) {
      stops.push(`${Math.round((Date.now() - started) / 1000)}s ${s4Why(run)}`);
      const fire = /火 \((-?\d+),(-?\d+),(-?\d+)\) は dig で消せる/u.exec(text);
      if (fire) { await act('putout', [{ do: 'dig', at: [{ x: Number(fire[1]), y: Number(fire[2]), z: Number(fire[3]) }] }], 15); metrics.fireDug++; }
      else if (/unsafe|fire の隣/u.test(text) || failStreak >= 2) { cell++; metrics.cellChanges++; }
      await sleep(1500);
    }
    if (Number(actor.health) < 12 || Number(actor.food) < 14) { await act('eat', [{ do: 'eat' }], 15); metrics.eats++; }
    if (Number(actor.health) < 9) { note(`health ${actor.health}: the camp stops`); break; }
    if (failStreak >= 8) { note('eight failed acts in a row: the camp is lost'); break; }
  }
  return { seconds: r1((Date.now() - started) / 1000), ...metrics, shieldWear: shieldUsed() - shield0, deathsHere: deaths - deaths0, stops: stops.slice(0, 12) };
}
scene('blaze_head_fight', 'blaze camp as a head plays it (fight): the body\'s own advice steers: fire dug out, unsafe cells changed; three rods or the clock', note => blazeCampHead('fight', note));
scene('blaze_head_hold', 'blaze camp as a head plays it (attack hold): the same loop', note => blazeCampHead('hold', note));

// S4 (run61 d0161-d0183): "leave from 33 blocks under the surface to the surface in one go". The head's way (vertical stairs, seal_water, repeated as often as it stops),
// a dry pillar, a go. `water` puts a block of water (7 x 6 x 7) around the way, 12 blocks up, as the water the head met at y21-25.
async function surfaceExit(mode: 'stairs' | 'pillar' | 'go', water: boolean, note: (text: string) => void): Promise<Record<string, unknown>> {
  const top = (sites.exitSurface ?? sites.spawn) as number[] | undefined;
  if (!top) throw new Error('no exitSurface / spawn in the sites');
  const deaths0 = deaths, depth = 33, surfaceY = top[1], y0 = surfaceY - depth, x = top[0], z = top[2];
  await ask('difficulty normal'); await ask('gamerule doMobSpawning false'); await ask('time set day'); await ask('weather clear');
  await equip({ diamond_pickaxe: 1, iron_sword: 1, water_bucket: 1, cobblestone: 64, cooked_beef: 16 }, { armor: 'iron', shield: true });
  await placeActor('overworld', x, surfaceY + 1, z, 24);
  // a stone mass round the way, a 3 x 3 x 3 room at the bottom (the rest is what the world has: stone, deepslate, caves)
  await ask(`execute in minecraft:overworld run fill ${x - 3} ${y0 - 1} ${z - 3} ${x + 3} ${y0 + 3} ${z + 3} minecraft:stone`);
  await ask(`execute in minecraft:overworld run fill ${x - 1} ${y0} ${z - 1} ${x + 1} ${y0 + 2} ${z + 1} minecraft:air`);
  if (water) await ask(`execute in minecraft:overworld run fill ${x - 3} ${y0 + 12} ${z - 3} ${x + 3} ${y0 + 17} ${z + 3} minecraft:water replace minecraft:stone`);
  await ask(`execute in minecraft:overworld run tp ${ACTOR} ${x + 0.5} ${y0} ${z + 0.5}`);
  await sleep(2500);
  const limitMs = 300_000, started = Date.now(), startY = s4Feet(), tops: string[] = [], stops: string[] = [];
  const metrics = { acts: 0, okActs: 0, hpLost: 0, lowestHp: 20, minY: startY, maxDrop: 0 };
  const canDig = ['stone', 'deepslate', 'tuff', 'andesite', 'diorite', 'granite', 'dirt', 'gravel', 'sand', 'cobblestone'];
  const reached = () => s4Feet() >= surfaceY - 1;
  let lastY = startY, turns = 0;
  while (Date.now() - started < limitMs && s4Alive(deaths0) && !reached() && metrics.acts < 10) {
    const hp0 = Number(actor.health), y0a = s4Feet();
    const hand = mode === 'go' ? { do: 'go', to: { x, y: surfaceY, z }, range: 1.5, seconds: 120, maxDig: 60, maxPlace: 40, canDig, canPlace: ['cobblestone'] }
      : { do: 'vertical', dir: 'up', shape: mode === 'stairs' ? 'stairs' : 'pillar', ...(mode === 'stairs' ? { toward: ['north', 'east', 'south', 'west'][turns % 4] } : {}), toY: surfaceY, liquid: 'seal_water', range: 2, seconds: 120, canDig, canPlace: ['cobblestone'] };
    const run = await act(`exit-${mode}#${metrics.acts + 1}`, [hand], 150, { stopIf: { hostileWithin: 6, hpBelow: 12 } });
    metrics.acts++; if (run.ok) metrics.okActs++;
    metrics.hpLost += Math.max(0, hp0 - Number(actor.health)); metrics.lowestHp = Math.min(metrics.lowestHp, Number(actor.health));
    metrics.minY = Math.min(metrics.minY, s4Feet()); metrics.maxDrop = Math.max(metrics.maxDrop, lastY - s4Feet()); lastY = s4Feet();
    tops.push(`${y0a}->${s4Feet()}@${Math.round((Date.now() - started) / 1000)}s${run.ok ? '' : '!'}`);
    if (!run.ok) stops.push(`${Math.round((Date.now() - started) / 1000)}s y${s4Feet()} ${s4Why(run)}`);
    await sleep(1500);
  }
  return { mode, water, reached: reached(), startY, endY: s4Feet(), surfaceY, seconds: r1((Date.now() - started) / 1000), ...metrics, deathsHere: deaths - deaths0, progress: tops.join(' '), stops: stops.slice(0, 10) };
}
scene('exit_stairs', 'surface exit: 33 blocks, vertical stairs seal_water (the head\'s hand), dry', note => surfaceExit('stairs', false, note));
scene('exit_stairs_water', 'surface exit: vertical stairs seal_water with a block of water 12 up', note => surfaceExit('stairs', true, note));
scene('exit_pillar', 'surface exit: vertical pillar, dry', note => surfaceExit('pillar', false, note));
scene('exit_go', 'surface exit: go to the surface with maxDig, dry', note => surfaceExit('go', false, note));
