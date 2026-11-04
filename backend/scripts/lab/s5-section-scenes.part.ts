// ===== S5: the whole stretch from the Nether back to the End portal, on the real seed ==========================================================
// Inserted after S4's scenes (s5-section-probe.sh joins s4-section-scenes.part.ts and this file, and hands the two to s4-section-probe.sh), so S4's helpers
// (s4Planar, s4Alive, s4Feet, s4Short, s4Eat, s4Why, s4Key) and the probe's (ask, equip, placeActor, act, runSkill, actor, sites, scene, dimensionOf, timedSeconds,
// deaths, sleep, r1, Vec3, countServer, locateFrom, bearingBetween) are in scope. No model: a scripted stand-in plays the head the way a good player would
// (two throws a short way apart, the eyes picked up, the Nether walk at an eighth, a portal near the stronghold, the room found by the frames, only the empty
// frames filled), and every hand is the body's. The clock runs from the blaze stand to the End.
//
// Env: HUNT_SECONDS=<limit, default 1800>   HUNT_THROWS=<blocks sideways for the second throw, default 24>; the route is the scene: s5_section_nether, s5_section_over, s5_section_auto

const S5_KIT: Record<string, number> = {
  diamond_pickaxe: 1, iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, bow: 1, arrow: 30, water_bucket: 1, flint_and_steel: 1,
  cobblestone: 64, netherrack: 64, white_bed: 10, obsidian: 12, blaze_rod: 7, ender_pearl: 14, cooked_beef: 24, torch: 16, crafting_table: 1,
};
type S5Cell = { x: number; y: number; z: number };
let s5Boxes = 0;
const s5Here = (): S5Cell => { const p = actor.entity.position as Vec3; return { x: Math.floor(p.x), y: Math.floor(p.y + 1e-3), z: Math.floor(p.z) }; };
const s5Name = (x: number, y: number, z: number): string | null => { try { const b = actor.blockAt(new Vec3(x, y, z), false); return b ? String(b.name) : null; } catch { return null; } };
const S5_OPEN = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dead_bush', 'dandelion', 'poppy']);
const S5_BAD_FLOOR = /lava|water|fire|magma|cactus|_leaves$|powder_snow/u;
/** A cell to stand on in the column (x, z): two open cells over a solid floor, searched from `fromY` down to `toY` (the Nether's ceiling is skipped by starting under it). */
function s5StandIn(x: number, z: number, fromY: number, toY: number): S5Cell | null {
  for (let y = fromY; y > toY; y--) {
    const feet = s5Name(x, y, z), head = s5Name(x, y + 1, z), floor = s5Name(x, y - 1, z);
    if (feet === null || head === null || floor === null) return null;
    if (S5_OPEN.has(feet) && S5_OPEN.has(head) && !S5_OPEN.has(floor) && !S5_BAD_FLOOR.test(floor) && !s5HazardNear(x, y, z)) return { x, y, z };
  }
  return null;
}
/** A stand near (x, z): the column itself, else rings round it out to `radius`. */
function s5StandNear(x: number, z: number, fromY: number, toY: number, radius = 6): S5Cell | null {
  for (let r = 0; r <= radius; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const found = s5StandIn(x + dx, z + dz, fromY, toY);
    if (found) return found;
  }
  return null;
}
/** Two eye lines (origin + unit) crossed: the point ahead of both, or null. */
function s5Cross(a: { x: number; z: number; ux: number; uz: number }, b: { x: number; z: number; ux: number; uz: number }): { x: number; z: number; ta: number; tb: number; deg: number } | null {
  const sine = a.ux * b.uz - a.uz * b.ux;
  if (Math.abs(sine) < 1e-6) return null;
  const rx = b.x - a.x, rz = b.z - a.z;
  const ta = (rx * b.uz - rz * b.ux) / sine, tb = (rx * a.uz - rz * a.ux) / sine;
  if (ta <= 0 || tb <= 0) return null;
  return { x: a.x + ta * a.ux, z: a.z + ta * a.uz, ta, tb, deg: Math.asin(Math.min(1, Math.abs(sine))) * 180 / Math.PI };
}

async function s5Section(note: (text: string) => void, routeAsked: string, startAt: "blaze" | "gate" | "eighth" = "blaze"): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined, arrival = sites.netherArrival as number[] | undefined;
  const room = sites.strongholdPortalCenter as number[] | undefined;
  if (!stand || !arrival || !room) throw new Error('no blazeStand / netherArrival / strongholdPortalCenter in the sites');
  const deaths0 = deaths;
  const route = routeAsked;
  const side = Number(process.env.MINECRAFT_HUNT_THROWS ?? 0) || 24;
  const limitMs = (timedSeconds || 1800) * 1000;
  // ---- the gate: a lit portal at the Nether arrival (the run built one there; the lab's world is fresh). Its overworld side is the game's.
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true'); await ask('gamerule doDaylightCycle true'); await ask('weather clear');
  const [gx, gy, gz] = arrival;
  await ask(`execute in minecraft:the_nether run forceload add ${gx - 24} ${gz - 24} ${gx + 24} ${gz + 24}`); await sleep(2500);
  await ask(`execute in minecraft:the_nether run fill ${gx - 3} ${gy - 1} ${gz - 3} ${gx + 4} ${gy - 1} ${gz + 3} minecraft:netherrack`);
  await ask(`execute in minecraft:the_nether run fill ${gx - 3} ${gy} ${gz - 3} ${gx + 4} ${gy + 4} ${gz + 3} minecraft:air`);
  await ask(`execute in minecraft:the_nether run fill ${gx - 1} ${gy - 1} ${gz} ${gx + 2} ${gy + 3} ${gz} minecraft:obsidian`);
  await ask(`execute in minecraft:the_nether run fill ${gx} ${gy} ${gz} ${gx + 1} ${gy + 2} ${gz} minecraft:nether_portal[axis=x]`);
  const gateCell: S5Cell = { x: gx, y: gy, z: gz };
  await equip(S5_KIT, { armor: 'iron', shield: true });
  await ask('time set 1000');
  if (startAt === 'eighth') {
    // Where the Nether walk of the earlier runs ended (the fix's eighth is 6 m on): a floor of netherrack and room over it, as the walk left it (a fresh world has lava there).
    await ask('execute in minecraft:the_nether run forceload add -152 96 -104 144'); await sleep(2500);
    await ask('execute in minecraft:the_nether run fill -131 106 116 -125 106 122 minecraft:netherrack');
    await ask('execute in minecraft:the_nether run fill -131 107 116 -125 110 122 minecraft:air');
    await placeActor('the_nether', -128, 107, 119, 24);
  }
  else if (startAt === 'gate') await placeActor('the_nether', gx, gy, gz + 2, 24); else await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze,distance=..40]');
  const located = await locateFrom(room[0], 100, room[2]);
  const started = Date.now();
  const t = (): number => r1((Date.now() - started) / 1000);
  const phases: Record<string, number> = {};
  const mark = (name: string) => { phases[name] = t(); note(`[${t()}s] ${name} at ${dimensionOf()} ${JSON.stringify(s5Here())} hp ${actor.health}`); };
  const stops: string[] = [];
  const m = { acts: 0, okActs: 0, hpLost: 0, lowestHp: 20, throws: 0, eyesPicked: 0, eyesBroke: 0, eyesSet: 0, framesFull0: 0, digs: 0, places: 0 };
  let failed = '';
  const timeLeft = () => limitMs - (Date.now() - started);
  const alive = () => s4Alive(deaths0) && timeLeft() > 0;
  const run = async (label: string, hands: unknown[], seconds: number, extra: Record<string, unknown> = {}): Promise<ActRun> => {
    const hp0 = Number(actor.health);
    const r = await act(label, hands, seconds, extra);
    m.acts++; if (r.ok) m.okActs++;
    m.hpLost += Math.max(0, hp0 - Number(actor.health)); m.lowestHp = Math.min(m.lowestHp, Number(actor.health));
    const text = r.lines.join(' ');
    for (const hit of text.matchAll(/掘 (\d+)/gu)) m.digs += Number(hit[1]);
    for (const hit of text.matchAll(/置 (\d+)/gu)) m.places += Number(hit[1]);
    if (!r.ok) { stops.push(`${t()}s ${label} ${s4Why(r)}`); if (s5Boxes++ < 6 && /go stopped/u.test(s4Why(r))) await dumpBox(`s5-${label}`, s4Why(r)); }
    if (Number(actor.health) < 12 || Number(actor.food) < 14) await act('eat', [{ do: 'eat' }], 15);
    return r;
  };
  /** go to a place in hops, as the head does: limits raised when a stop asks, the same stop four times is the end. */
  const goTo = async (label: string, goal: () => S5Cell | null, opts: { range: number; canDig: string[]; canPlace: string[]; maxDig?: number; maxPlace?: number; until: () => boolean; maxActs?: number; seconds?: number }): Promise<boolean> => {
    let maxDig = opts.maxDig ?? 40, maxPlace = opts.maxPlace ?? 24, same = 0, last = '';
    for (let i = 0; i < (opts.maxActs ?? 20) && alive(); i++) {
      if (opts.until()) return true;
      const to = goal();
      if (!to) { stops.push(`${t()}s ${label}: no standable goal`); await sleep(2000); continue; }
      const r = await run(`${label}#${i + 1}`, [{ do: 'go', to, range: opts.range, seconds: opts.seconds ?? 100, canDig: opts.canDig, canPlace: opts.canPlace, maxDrop: 4, maxDig, maxPlace }], (opts.seconds ?? 100) + 30);
      if (opts.until()) return true;
      if (!r.ok) {
        const why = s4Why(r);
        if (/limit_dig/u.test(why) && maxDig < 200) { maxDig = Math.min(200, maxDig * 2); same = 0; continue; }
        if (/limit_place/u.test(why) && maxPlace < 100) { maxPlace = Math.min(100, maxPlace * 2); same = 0; continue; }
        const key = s4Key(why); same = key === last ? same + 1 : 1; last = key;
        if (same >= 4) { note(`${label}: the same stop four times: ${why}`); return false; }
        await sleep(1200);
      } else same = 0;
    }
    return opts.until();
  };
  const NETHER_DIG = ['netherrack', 'soul_sand', 'soul_soil', 'basalt', 'blackstone', 'gravel', 'magma_block', 'nether_gold_ore', 'nether_quartz_ore', 'glowstone'];
  const OVER_DIG = ['stone', 'dirt', 'grass_block', 'gravel', 'sand', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobblestone', 'cobbled_deepslate'];
  const BLOCKS = ['netherrack', 'cobblestone', 'cobbled_deepslate', 'dirt'];
  /** Walks into the portal at `cell` and waits for the dimension to change. */
  const enterPortal = async (label: string, cell: S5Cell, want: string): Promise<boolean> => {
    for (let i = 0; i < 3 && alive() && dimensionOf() !== want; i++) {
      await run(`${label}-walk#${i + 1}`, [{ do: 'walk', to: cell, range: 0 }], 40);
      for (const until = Date.now() + 8000; Date.now() < until && dimensionOf() !== want;) await sleep(250);
    }
    await sleep(1500);
    return dimensionOf() === want;
  };
  const eyesHeld = () => Number(packClient().ender_eye ?? 0);
  /** One throw and the eye picked up when it fell. */
  const throwEye = async (label: string): Promise<any> => {
    const r = await run(label, [{ do: 'use', item: 'ender_eye' }], 30);
    const eye = r.json?.eye ?? null;
    m.throws++;
    if (eye?.fate === 'shattered') m.eyesBroke++;
    if (eye?.drop?.id !== undefined) {
      const before = eyesHeld();
      await run(`${label}-pickup`, [{ do: 'pickup', target: eye.drop.id, range: 24 }], 30);
      if (eyesHeld() > before) m.eyesPicked++;
    }
    note(`${label}: ${s4Short(r.lines[0] ?? r.error ?? '', 220)}`);
    return eye;
  };
  let fix: { x: number; z: number } | null = null, overDistance = 0, chosen = '';
  let exit: S5Cell = s5Here();
  let endAt = 0;
  const endM = { nearestDragon: Infinity, endermenNear: 0, balls: new Set<number>(), hits: [] as string[], lastHp: 20, lowestHp: 20, bridgeSeconds: null as number | null, waitSeconds: null as number | null };
  try {
    if (startAt === 'eighth') {
      // Measuring from the Nether eighth on: the fix is what two throws gave in the earlier runs (within 1 to 6 m of /locate).
      fix = located ? { x: located.x, z: located.z } : null;
      if (!fix) { failed = 'no_locate'; throw new Error(failed); }
      chosen = 'nether';
      mark(`start at the Nether eighth; fix ${JSON.stringify(fix)} from /locate`);
      await run('craft-powder', [{ do: 'craft', item: 'blaze_powder', count: 14 }], 30);
      await run('craft-eyes', [{ do: 'craft', item: 'ender_eye', count: 14 }], 30);
      // Two throws a short way apart lose an eye in five on average: the eighth start carries the twelve or thirteen a run has after them.
      await ask(`clear ${ACTOR} minecraft:ender_eye 1`);
    } else {
    // ---- 1. back to the gate
    note(`start at the blaze stand ${JSON.stringify(stand)}; the gate ${JSON.stringify(gateCell)} is ${r1(s4Planar([gx, gy, gz]))} m off; /locate says ${JSON.stringify(located)}`);
    const atGate = await goTo('to-gate', () => gateCell, { range: 3, canDig: NETHER_DIG, canPlace: BLOCKS, until: () => s4Planar([gx, gy, gz]) < 4, maxActs: 12 });
    mark('at the gate');
    if (!atGate) { failed = 'gate_not_reached'; throw new Error(failed); }
    if (route === 'gate-only') throw new Error('gate-only: done');
    if (!await enterPortal('gate-in', gateCell, 'overworld')) { failed = 'gate_not_entered'; throw new Error(failed); }
    mark('overworld');
    exit = s5Here();
    // ---- 2. the eyes: 7 rods -> 14 powder -> 14 eyes (no table needed)
    await run('craft-powder', [{ do: 'craft', item: 'blaze_powder', count: 14 }], 30);
    await run('craft-eyes', [{ do: 'craft', item: 'ender_eye', count: 14 }], 30);
    mark(`eyes made (${eyesHeld()})`);
    // Off the portal's own cells, then the first throw.
    const off = s5StandNear(exit.x + 3, exit.z + 3, exit.y + 6, exit.y - 8, 4);
    if (off) await run('off-portal', [{ do: 'go', to: off, range: 1, seconds: 20, canDig: OVER_DIG, canPlace: BLOCKS, maxDig: 8, maxPlace: 8 }], 40);
    const e1 = await throwEye('throw1');
    if (!e1?.unit) { failed = 'eye1_no_line'; throw new Error(failed); }
    // ---- 3. the second throw a short way to the side of the first line (the lines are exact: 0.003 degrees in the lab)
    const sideways = [{ x: -e1.unit.z, z: e1.unit.x }, { x: e1.unit.z, z: -e1.unit.x }];
    let e2: any = null;
    for (const dir of sideways) {
      const o = e1.origin as { x: number; y: number; z: number };
      const target = s5StandNear(Math.round(o.x + dir.x * side), Math.round(o.z + dir.z * side), Math.floor(o.y) + 12, Math.floor(o.y) - 12, 4);
      if (!target) continue;
      const r = await run('sideways', [{ do: 'go', to: target, range: 1.5, seconds: 40, canDig: OVER_DIG, canPlace: BLOCKS, maxDig: 24, maxPlace: 16 }], 60);
      if (!r.ok && Math.hypot(actor.entity.position.x - o.x, actor.entity.position.z - o.z) < side * 0.6) continue;
      e2 = await throwEye('throw2');
      break;
    }
    if (!e2?.unit) { failed = 'eye2_no_line'; throw new Error(failed); }
    const crossing = s5Cross({ x: e1.origin.x, z: e1.origin.z, ux: e1.unit.x, uz: e1.unit.z }, { x: e2.origin.x, z: e2.origin.z, ux: e2.unit.x, uz: e2.unit.z });
    if (!crossing) { failed = 'no_crossing'; throw new Error(failed); }
    fix = { x: Math.round(crossing.x), z: Math.round(crossing.z) };
    const fixError = located ? r1(Math.hypot(fix.x - located.x, fix.z - located.z)) : null;
    overDistance = Math.round(Math.hypot(fix.x - exit.x, fix.z - exit.z));
    chosen = route === 'auto' ? (overDistance > 600 ? 'nether' : 'over') : route;
    mark(`fix ${JSON.stringify(fix)} (crossing ${r1(crossing.deg)} deg, off /locate ${fixError} m, ${overDistance} m from the exit): route ${chosen}`);
    }
    // ---- 4. to the stronghold
    if (chosen === 'nether') {
      // Back into the gate, the Nether walk at an eighth, a new portal there.
      if (startAt !== 'eighth') {
      if (!await goTo('back-to-portal', () => exit, { range: 2, canDig: OVER_DIG, canPlace: BLOCKS, until: () => Math.hypot(actor.entity.position.x - exit.x - 0.5, actor.entity.position.z - exit.z - 0.5) < 3, maxActs: 4 })) { failed = 'exit_not_reached'; throw new Error(failed); }
      if (!await enterPortal('gate-back', exit, 'the_nether')) { failed = 'gate_back_not_entered'; throw new Error(failed); }
      mark('nether again');
      }
      const nx = Math.round(fix.x / 8), nz = Math.round(fix.z / 8);
      // The head names a place to stand near the eighth, in hops of 90 m at most (the body's own advice after a search_timeout: relay points).
      let hopMax = 90, netherDig = 80;
      const nearEighth = () => Math.hypot(actor.entity.position.x - nx, actor.entity.position.z - nz) < 6;
      for (let hop = 0; hop < 16 && alive() && !nearEighth(); hop++) {
        const here = actor.entity.position as Vec3;
        const remain = Math.hypot(nx - here.x, nz - here.z), step = Math.min(hopMax, remain);
        const ux = (nx - here.x) / remain, uz = (nz - here.z) / remain;
        let goal: S5Cell | null = null;
        for (const s of [step, step * 0.7, step * 0.45]) {
          goal = s5StandNear(Math.round(here.x + ux * s), Math.round(here.z + uz * s), 120, 32, 6);
          if (goal) break;
        }
        if (!goal) { stops.push(`${t()}s nether hop: no stand ahead`); hopMax = Math.max(24, Math.floor(hopMax * 0.6)); await sleep(1500); continue; }
        let r = await run(`nether-hop#${hop + 1}`, [{ do: 'go', to: goal, range: 3, seconds: 100, canDig: NETHER_DIG, canPlace: BLOCKS, maxDrop: 4, maxDig: netherDig, maxPlace: 40 }], 130);
        // As the head does with the stop's own advice: a dig limit is raised and the same hop sent again.
        if (!r.ok && /limit_dig/u.test(s4Why(r)) && netherDig < 200) { netherDig = Math.min(200, netherDig * 2); r = await run(`nether-hop#${hop + 1}b`, [{ do: 'go', to: goal, range: 3, seconds: 100, canDig: NETHER_DIG, canPlace: BLOCKS, maxDrop: 4, maxDig: netherDig, maxPlace: 40 }], 130); }
        if (!r.ok && /search_timeout/u.test(s4Why(r))) hopMax = Math.max(24, Math.floor(hopMax * 0.6));
        else if (r.ok) hopMax = Math.min(90, Math.round(hopMax * 1.3));
      }
      mark(`nether walk done (${r1(Math.hypot(actor.entity.position.x - nx, actor.entity.position.z - nz))} m from the eighth)`);
      if (!nearEighth() && Math.hypot(actor.entity.position.x - nx, actor.entity.position.z - nz) > 24) { failed = 'nether_walk'; throw new Error(failed); }
      // The new portal: a place near the feet where the frame's ten cells and the six inside are open (the head reads the map for that), the bottom row on the ground.
      const before = dimensionOf();
      const spots = s5PortalSpots(s5Here(), 5);
      note(`portal spots: ${JSON.stringify(spots.slice(0, 3))}`);
      for (const spot of spots.slice(0, 3)) {
        for (let i = 0; i < spot.dig.length; i += 6) await run(`portal-clear#${i / 6 + 1}`, [{ do: 'dig', at: spot.dig.slice(i, i + 6) }], 60);
        const r = await run('portal-build', [{ do: 'portal', at: [{ x: spot.x, y: spot.y, z: spot.z }], axis: spot.axis, enter: true, canPlace: BLOCKS, maxPlace: 12, seconds: 110 }], 140);
        for (const until = Date.now() + 10_000; Date.now() < until && dimensionOf() === before;) await sleep(250);
        if (dimensionOf() === 'overworld') break;
        if (r.ok) await enterPortal('portal-new', { x: spot.x, y: spot.y, z: spot.z }, 'overworld');
        if (dimensionOf() === 'overworld') break;
      }
      if (dimensionOf() !== 'overworld') { failed = `portal_build (${spots.length} spots)`; throw new Error('portal_build'); }
      await sleep(1500);
      mark(`overworld near the stronghold (${r1(Math.hypot(actor.entity.position.x - fix.x, actor.entity.position.z - fix.z))} m from the fix; obsidian left ${packClient().obsidian ?? 0})`);
    } else {
      // The overworld walk in hops of 110 m along the line, the surface ahead as the goal.
      let hopMax = 110;
      const near = () => Math.hypot(actor.entity.position.x - fix!.x, actor.entity.position.z - fix!.z) < 40;
      for (let hop = 0; hop < 40 && alive() && !near(); hop++) {
        const here = actor.entity.position as Vec3;
        const remain = Math.hypot(fix.x - here.x, fix.z - here.z), step = Math.min(hopMax, remain);
        const base = Math.atan2(fix.z - here.z, fix.x - here.x);
        let goal: S5Cell | null = null;
        for (const deg of [0, 20, -20, 40, -40, 60, -60]) {
          const a = base + deg * Math.PI / 180;
          goal = s5StandNear(Math.round(here.x + Math.cos(a) * step), Math.round(here.z + Math.sin(a) * step), 200, 40, 3);
          if (goal) break;
        }
        if (!goal) { hopMax = Math.max(30, Math.floor(hopMax * 0.6)); await sleep(1500); continue; }
        const r = await run(`over-hop#${hop + 1}`, [{ do: 'go', to: goal, range: 2.5, seconds: 100, canDig: OVER_DIG, canPlace: BLOCKS, maxDrop: 4, maxDig: 60, maxPlace: 40 }], 130);
        if (!r.ok && /search_timeout/u.test(s4Why(r))) hopMax = Math.max(30, Math.floor(hopMax * 0.6));
        else if (r.ok) hopMax = Math.min(110, Math.round(hopMax * 1.3));
      }
      mark(`overworld walk done (${r1(Math.hypot(actor.entity.position.x - fix.x, actor.entity.position.z - fix.z))} m from the fix)`);
    }
    // ---- 5. the room: the frames are in the loaded columns at every height
    let frames: Array<{ x: number; y: number; z: number; eye: boolean | null }> = [];
    for (let i = 0; i < 6 && alive() && !frames.length; i++) {
      const probe = await runSkill('find-structure', { structureType: 'stronghold', radius: 128, x: fix.x, z: fix.z }, 20);
      const text = String(probe.receipt?.result ?? '');
      frames = [...text.matchAll(/\((-?\d+), (-?\d+), (-?\d+)\)(目あり|目なし)/gu)].map(hit => ({ x: Number(hit[1]), y: Number(hit[2]), z: Number(hit[3]), eye: hit[4] === '目あり' }));
      if (frames.length) break;
      note(`frames: ${s4Short(text, 260)}`);
      const next = /輪[^:]*: \((-?\d+), (-?\d+)\)/u.exec(text);
      if (!next) break;
      const nxz = { x: Number(next[1]), z: Number(next[2]) };
      await goTo('ring', () => s5StandNear(nxz.x, nxz.z, 200, 40, 4), { range: 3, canDig: OVER_DIG, canPlace: BLOCKS, until: () => Math.hypot(actor.entity.position.x - nxz.x, actor.entity.position.z - nxz.z) < 6, maxActs: 4 });
    }
    if (!frames.length) { failed = 'no_frames'; throw new Error(failed); }
    m.framesFull0 = frames.filter(f => f.eye).length;
    const cx = frames.reduce((s, f) => s + f.x, 0) / frames.length, cz = frames.reduce((s, f) => s + f.z, 0) / frames.length, fy = frames[0].y;
    mark(`frames seen: ${frames.length} (eyes in ${m.framesFull0}); room centre ${r1(cx)},${fy},${r1(cz)}; eyes held ${eyesHeld()}, needed ${frames.length - m.framesFull0}`);
    // ---- 6. down to the room: the nearest frame's ring, as the head's knowledge says (go maxDig 120, canDig, canPlace)
    const ringGoal = (): S5Cell => { const f = frames.filter(frame => !frame.eye)[0] ?? frames[0]; return { x: f.x, y: f.y + 1, z: f.z }; };
    const inRoom = () => Math.abs(actor.entity.position.y - (fy + 1)) < 3 && Math.hypot(actor.entity.position.x - cx, actor.entity.position.z - cz) < 8;
    const down = await goTo('descend', ringGoal, { range: 3, canDig: ['stone', 'dirt', 'grass_block', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks'], canPlace: BLOCKS, maxDig: 120, maxPlace: 24, until: inRoom, maxActs: 14, seconds: 110 });
    mark(`descent ${down ? 'done' : 'stopped'}`);
    if (!down) { failed = 'descent'; throw new Error(failed); }
    // ---- 7. the empty frames
    for (let pass = 1; pass <= 3 && alive(); pass++) {
      const empty = frames.filter(f => s5FrameEye(f) === false);
      if (!empty.length) break;
      const here = actor.entity.position as Vec3;
      empty.sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z));
      for (const f of empty) {
        if (!alive() || eyesHeld() === 0) break;
        const r = await run(`frame#${m.eyesSet + 1}`, [{ do: 'go', to: { x: f.x, y: f.y + 1, z: f.z }, range: 3, seconds: 25, canPlace: BLOCKS, maxPlace: 8 }, { do: 'use', item: 'ender_eye', at: [{ x: f.x, y: f.y, z: f.z }] }], 60);
        if (r.ok) m.eyesSet++;
      }
    }
    const full = frames.filter(f => s5FrameEye(f) === true).length;
    mark(`frames full ${full}/${frames.length} (eyes left ${eyesHeld()})`);
    if (full < 12) { failed = `frames ${full}/12`; throw new Error(failed); }
    // ---- 8. in: the centre cell of the portal (walk, from the ring)
    const centre = { x: Math.floor(cx), y: fy, z: Math.floor(cz) };
    for (let i = 0; i < 3 && alive() && dimensionOf() !== 'the_end'; i++) {
      await run(`end-in#${i + 1}`, [{ do: 'walk', to: centre, range: 0.5 }], 40);
      for (const until = Date.now() + 6000; Date.now() < until && dimensionOf() !== 'the_end';) await sleep(250);
    }
    if (dimensionOf() !== 'the_end') { failed = 'end_not_entered'; throw new Error(failed); }
    mark('the End');
    endAt = Date.now();
    // ---- 9. the first minute in the End, with no resistance: off the obsidian platform to the island, and to a place 8 to 10 m from the podium to wait for the first perch.
    const endWatch = setInterval(() => {
      const position = actor.entity?.position; if (!position) return;
      const health = Number(actor.health);
      const ents = Object.values(actor.entities) as any[];
      const dragon = ents.find(e => e?.name === 'ender_dragon' && e.position);
      if (dragon) endM.nearestDragon = Math.min(endM.nearestDragon, r1(position.distanceTo(dragon.position)));
      endM.endermenNear = Math.max(endM.endermenNear, ents.filter(e => e?.name === 'enderman' && e.position && position.distanceTo(e.position) < 16).length);
      for (const e of ents) if (e?.name === 'dragon_fireball') endM.balls.add(e.id);
      if (health < endM.lastHp - 0.01) endM.hits.push(`${r1((Date.now() - endAt) / 1000)}s -${r1(endM.lastHp - health)} dragon ${dragon ? r1(position.distanceTo(dragon.position)) : '-'}m`);
      endM.lastHp = health; endM.lowestHp = Math.min(endM.lowestHp, health);
    }, 100);
    try {
      await sleep(2500);
      const topAt = (x: number, z: number): number | null => { for (let y = 110; y >= 20; y--) { const n = s5Name(x, y, z); if (n === 'end_stone') return y; } return null; };
      let rimX: number | null = null;
      for (let x = 96; x >= 0 && rimX === null; x--) { const top = topAt(x, 0); if (top !== null && top >= 55) rimX = x; }
      note(`End: island rim along z=0 at x=${rimX}`);
      if (rimX === null) { failed = 'end_no_rim'; throw new Error(failed); }
      const inX = rimX - 3, inTop = topAt(inX, 0) ?? topAt(rimX, 0)!;
      // As the head's knowledge says: go to a cell on the island with blocks to lay (one wide over the void), maxPlace 100, seconds 120.
      const onIsland = () => (actor.entity?.position?.x ?? 999) <= rimX! + 0.5 && actor.entity?.onGround;
      await goTo('end-bridge', () => ({ x: inX, y: inTop + 1, z: 0 }), { range: 1.5, canDig: ['end_stone'], canPlace: ['cobblestone', 'netherrack', 'cobbled_deepslate'], maxDig: 20, maxPlace: 100, until: () => !!onIsland(), maxActs: 4, seconds: 120 });
      endM.bridgeSeconds = r1((Date.now() - endAt) / 1000);
      mark(`End: ${onIsland() ? 'on the island' : 'not on the island'}`);
      if (!onIsland()) { failed = 'end_bridge'; throw new Error(failed); }
      // The waiting place: the island's ground 8 to 10 m east of the podium (0, 0).
      const wait = s5StandNear(9, 0, 90, 50, 3);
      await goTo('end-wait', () => wait, { range: 1.5, canDig: ['end_stone'], canPlace: ['cobblestone', 'netherrack'], maxDig: 20, maxPlace: 20, until: () => Math.hypot(actor.entity.position.x - 9, actor.entity.position.z) < 4, maxActs: 4, seconds: 90 });
      endM.waitSeconds = r1((Date.now() - endAt) / 1000);
      mark(`End: ${Math.hypot(actor.entity.position.x - 9, actor.entity.position.z) < 4 ? 'at the waiting place' : 'short of the waiting place'}`);
      // The rest of the first minute (and a little more): standing there.
      while (Date.now() - endAt < 75_000 && s4Alive(deaths0)) await sleep(500);
    } finally { clearInterval(endWatch); }
  } catch (error) {
    if (!failed) failed = `error: ${String((error as Error)?.message ?? error).slice(0, 160)}`;
  } finally { await ask('gamerule doMobSpawning false'); }
  const end = { ...endM, balls: endM.balls.size, nearestDragon: Number.isFinite(endM.nearestDragon) ? endM.nearestDragon : null, lastHp: undefined };
  return { end, entered: dimensionOf() === 'the_end' || endAt > 0, failed: failed || null, seconds: t(), route: chosen, fix, located, overDistance, phases, ...m, deathsHere: deaths - deaths0, pack: packClient(), stops: stops.slice(0, 24) };
}
const S5_TITLE = "S5 on the real seed: from the blaze stand in the Nether back through the gate, eyes made and thrown, the stronghold found, down to the room, the frames filled, into the End";
scene("s5_section_auto", `${S5_TITLE} (the Nether when the walk is over 600 m)`, note => s5Section(note, "auto"));
scene("s5_section_nether", `${S5_TITLE} (by the Nether)`, note => s5Section(note, "nether"));
scene("s5_section_over", `${S5_TITLE} (the overworld walk)`, note => s5Section(note, "over"));

/** Whether the frame at `f` holds an eye now, by the client's own world (null: not loaded). */
function s5FrameEye(f: { x: number; y: number; z: number }): boolean | null {
  try { const b = actor.blockAt(new Vec3(f.x, f.y, f.z), false); if (!b || b.name !== 'end_portal_frame') return null; const e = b.getProperties?.().eye; return e === true || e === 'true'; } catch { return null; }
}

scene("s5_gate_nether", `${S5_TITLE} — from the gate's Nether side, by the Nether`, note => s5Section(note, "nether", "gate"));
scene("s5_gate_over", `${S5_TITLE} — from the gate's Nether side, the overworld walk`, note => s5Section(note, "over", "gate"));
/** Lava, fire or magma beside the feet or head cell or under the floor (the body refuses such a place as a goal: lava's neighbour). */
function s5HazardNear(x: number, y: number, z: number): boolean {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [0, 2, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1], [0, -2, 0]]) {
    const n = s5Name(x + dx, y + dy, z + dz);
    if (n && /lava|fire|magma/u.test(n)) return true;
  }
  return false;
}
scene("s5_to_gate", "S5: only the walk from the blaze stand back to the gate (the go stops dumped)", note => s5Section(note, "gate-only"));
/** Places for a nether portal near `feet`: the inside's lower-left cell and the plane, where the ten frame cells and the six inside are open or
 *  netherrack-like (the head digs those first), the frame's bottom row has solid ground under it, and one side has a cell to stand in. Fewest digs, then nearest. */
function s5PortalSpots(feet: { x: number; y: number; z: number }, radius: number): Array<{ x: number; y: number; z: number; axis: 'x' | 'z'; dig: Array<{ x: number; y: number; z: number }> }> {
  const DIGGABLE = /^(netherrack|soul_sand|soul_soil|gravel|blackstone|basalt|nether_gold_ore|nether_quartz_ore|glowstone|stone|dirt|grass_block|cobblestone)$/u;
  const open = (x: number, y: number, z: number) => { const n = s5Name(x, y, z); return n !== null && S5_OPEN.has(n); };
  const solid = (x: number, y: number, z: number) => { const n = s5Name(x, y, z); return n !== null && !S5_OPEN.has(n) && !S5_BAD_FLOOR.test(n); };
  const out: Array<{ x: number; y: number; z: number; axis: 'x' | 'z'; dig: Array<{ x: number; y: number; z: number }>; d: number }> = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -2; dy <= 2; dy++) for (const axis of ['x', 'z'] as const) {
    const at = { x: feet.x + dx, y: feet.y + 1 + dy, z: feet.z + dz };
    const along = (a: number, up: number): [number, number, number] => axis === 'x' ? [at.x + a, at.y + up, at.z] : [at.x, at.y + up, at.z + a];
    let ok = true;
    const dig: Array<{ x: number; y: number; z: number }> = [];
    for (let a = -1; a <= 2 && ok; a++) for (let up = -1; up <= 3 && ok; up++) {
      const [x, y, z] = along(a, up);
      if (open(x, y, z)) continue;
      const n = s5Name(x, y, z);
      if (n && DIGGABLE.test(n) && !s5HazardNear(x, y, z)) dig.push({ x, y, z }); else ok = false;
    }
    for (let a = -1; a <= 2 && ok; a++) { const [x, y, z] = along(a, -2); if (!solid(x, y, z)) ok = false; }
    if (ok) {
      const [x, y, z] = along(0, -1);
      const sides = [-1, 1].filter(side => { const sx = axis === 'x' ? x : x + side, sz = axis === 'x' ? z + side : z; return open(sx, y, sz) && open(sx, y + 1, sz) && solid(sx, y - 1, sz); });
      if (!sides.length) ok = false;
    }
    if (ok && dig.length <= 12) out.push({ ...at, axis, dig, d: dig.length * 3 + Math.hypot(dx, dy, dz) });
  }
  return out.sort((a, b) => a.d - b.d).map(({ d: _d, ...rest }) => rest);
}
scene("s5_eighth", `${S5_TITLE} — from the Nether eighth of the stronghold on (portal, room, frames, End)`, note => s5Section(note, "nether", "eighth"));
/** The walk out from the gate to the blaze stand (as the run made it, laying its own bridges) and back to the gate along the same ground: what the return costs once a way was made. */
scene('s5_gate_roundtrip', 'S5: from the lit gate to the blaze stand by go, then back to the gate (the return over the way the walk out made)', async note => {
  const stand = sites.blazeStand as number[] | undefined, arrival = sites.netherArrival as number[] | undefined;
  if (!stand || !arrival) throw new Error('no blazeStand / netherArrival');
  const [gx, gy, gz] = arrival;
  const deaths0 = deaths;
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true'); await ask('weather clear');
  await ask(`execute in minecraft:the_nether run forceload add ${gx - 24} ${gz - 24} ${gx + 24} ${gz + 24}`); await sleep(2500);
  await ask(`execute in minecraft:the_nether run fill ${gx - 3} ${gy - 1} ${gz - 3} ${gx + 4} ${gy - 1} ${gz + 3} minecraft:netherrack`);
  await ask(`execute in minecraft:the_nether run fill ${gx - 3} ${gy} ${gz - 3} ${gx + 4} ${gy + 4} ${gz + 3} minecraft:air`);
  await ask(`execute in minecraft:the_nether run fill ${gx - 1} ${gy - 1} ${gz} ${gx + 2} ${gy + 3} ${gz} minecraft:obsidian`);
  await ask(`execute in minecraft:the_nether run fill ${gx} ${gy} ${gz} ${gx + 1} ${gy + 2} ${gz} minecraft:nether_portal[axis=x]`);
  await equip(S5_KIT, { armor: 'iron', shield: true });
  await placeActor('the_nether', gx, gy, gz + 2, 24);
  const NETHER = ['netherrack', 'soul_sand', 'soul_soil', 'basalt', 'blackstone', 'gravel', 'magma_block', 'nether_gold_ore', 'nether_quartz_ore', 'glowstone'];
  const leg = async (label: string, to: number[], near: number) => {
    const started = Date.now(); let maxDig = 40, maxPlace = 24, ok = false, places = 0, digs = 0;
    const stops: string[] = [];
    for (let i = 0; i < 12 && s4Alive(deaths0) && !ok; i++) {
      const r = await act(`${label}#${i + 1}`, [{ do: 'go', to: { x: to[0], y: to[1], z: to[2] }, range: 3, seconds: 100, canDig: NETHER, canPlace: ['netherrack', 'cobblestone'], maxDrop: 4, maxDig, maxPlace }], 130);
      const text = r.lines.join(' ');
      for (const hit of text.matchAll(/掘 (\d+)/gu)) digs += Number(hit[1]);
      for (const hit of text.matchAll(/置 (\d+)/gu)) places += Number(hit[1]);
      ok = s4Planar(to) < near;
      if (!r.ok && !ok) {
        const why = s4Why(r); stops.push(why.slice(0, 160));
        if (/limit_dig/u.test(why)) maxDig = Math.min(200, maxDig * 2);
        else if (/limit_place/u.test(why)) maxPlace = Math.min(100, maxPlace * 2);
        else if (stops.length >= 3 && stops.slice(-3).every(s => s4Key(s) === s4Key(why))) break;
      }
    }
    const out = { reached: ok, seconds: r1((Date.now() - started) / 1000), digs, places, end: r1(s4Planar(to)), stops: stops.slice(0, 6) };
    note(`${label}: ${JSON.stringify(out)}`);
    return out;
  };
  try {
    const out = await leg('out', stand, 4);
    const back = await leg('back', [gx, gy, gz], 4);
    return { out, back, deathsHere: deaths - deaths0 };
  } finally { await ask('gamerule doMobSpawning false'); }
});
