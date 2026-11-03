
// ===== S4 (2026-11-03): the road to the stronghold through the Nether, once, on c1 (the plan's decision 4 A) =============================================================
// status/run59-leg2-plan.md, 7 章 4: "throw the eyes at two spots 50 to 100 m apart near the gate; in the Nether walk ~180 blocks to (x/8, z/8); build the gate with obsidian and come out".
// Here: two eyes from the surface near the gate (the second spot perpendicular to the first bearing, 70 m off, on dry ground the client holds), the two bearings crossed (the estimate against
// /locate and against the portal room), the gate of run59's task 1 by the portal hand and gone into, the walk in the Nether to (estimate x/8, estimate z/8) by a head's hops, a second gate
// there (10 more obsidian: the plan has them made at the lava pool beside the first gate) by the portal hand, and where the overworld puts the body. Uses the helpers of s4-leg2-scenes.part.ts.
function s4Intersect(o1: { x: number; z: number }, b1: number, o2: { x: number; z: number }, b2: number): { x: number; z: number } | null {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const d1 = { x: Math.sin(rad(b1)), z: -Math.cos(rad(b1)) }, d2 = { x: Math.sin(rad(b2)), z: -Math.cos(rad(b2)) };
  const det = d1.x * (-d2.z) - d1.z * (-d2.x);
  if (Math.abs(det) < 1e-9) return null;
  const t1 = ((o2.x - o1.x) * (-d2.z) - (o2.z - o1.z) * (-d2.x)) / det;
  return { x: o1.x + t1 * d1.x, z: o1.z + t1 * d1.z };
}
/** Stands the body on the ground of the column (x, z): spectator first, to read the ground from above, then survival on it. */
async function s4StandAt(x: number, z: number): Promise<number | null> {
  await ask('gamemode spectator ' + ACTOR);
  await s4Tp('overworld', x, 120, z, 20);
  await sleep(2000);
  const surface = s4SurfaceY(x, z);
  await ask(`execute in minecraft:overworld run tp ${ACTOR} ${x + 0.5} ${(surface ?? 80) + 1} ${z + 0.5}`); await sleep(1200);
  await ask('gamemode survival ' + ACTOR); await sleep(2500);
  return surface;
}
const s4Dry = (x: number, z: number): boolean => { const y = s4SurfaceY(x, z); const name = y === null ? '' : String(actor.blockAt(new Vec3(x, y, z), false)?.name ?? ''); return y !== null && !/water|lava|ice|kelp|seagrass/u.test(name); };
async function s4Throw(label: string, x: number, z: number): Promise<{ origin: { x: number; z: number }; bearing: number; fate: string; line: string } | null> {
  const surface = await s4StandAt(x, z);
  const run = await act(label, [{ do: 'use', item: 'ender_eye' }], 40);
  const eye = run.json?.eye;
  if (!eye?.origin || typeof eye.bearingDeg !== 'number') return null;
  return { origin: { x: eye.origin.x, z: eye.origin.z }, bearing: eye.bearingDeg, fate: String(eye.fate ?? ''), line: `${surface} ${s4Short(run.lines[0] ?? '', 160)}` };
}
/** A place in the loaded chunks near the body where a portal's frame can stand with the hand's own rules (a floor under the bottom row, the inside, the sides and the top open, a way in on one side): the inside's lower-left cell and the axis. */
function s4FindGateSpot(radius = 10): { x: number; y: number; z: number; axis: 'x' | 'z'; moved: number } | null {
  const p = actor.entity.position as Vec3, bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  const name = (x: number, y: number, z: number): string | null => { const block = actor.blockAt(new Vec3(x, y, z), false); return block ? String(block.name) : null; };
  const open = (x: number, y: number, z: number): boolean => { const n = name(x, y, z); return n !== null && S4_PASSABLE(n); };
  const firm = (x: number, y: number, z: number): boolean => { const n = name(x, y, z); return n !== null && !S4_PASSABLE(n) && n !== 'lava' && n !== 'water' && n !== 'fire' && n !== 'soul_fire' && n !== 'magma_block'; };
  let best: { x: number; y: number; z: number; axis: 'x' | 'z'; moved: number } | null = null;
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -5; dy <= 5; dy++) {
    const x = bx + dx, z = bz + dz, floor = by + dy, moved = Math.hypot(dx, dz) + Math.abs(dy) * 0.5;
    if (best && moved >= best.moved) continue;
    for (const axis of ['x', 'z'] as const) {
      const along = (a: number, y: number): [number, number, number] => axis === 'x' ? [x + a, y, z] : [x, y, z + a];
      let ok = true;
      for (const a of [0, 1]) {
        const [fx, , fz] = along(a, floor);
        if (!firm(fx, floor - 1, fz) || !open(fx, floor, fz)) { ok = false; break; }
        for (let up = 1; up <= 4 && ok; up++) { const [ix, , iz] = along(a, floor + up); if (!open(ix, floor + up, iz)) ok = false; }
        if (!ok) break;
      }
      for (const a of [-1, 2]) for (let up = 1; up <= 3 && ok; up++) { const [sx, , sz] = along(a, floor + up); if (!open(sx, floor + up, sz)) ok = false; }
      if (ok) {
        const front = (side: number): boolean => { const ax = axis === 'x' ? x : x + side, az = axis === 'x' ? z + side : z; return open(ax, floor, az) && open(ax, floor + 1, az) && firm(ax, floor - 1, az); };
        if (!front(1) && !front(-1)) ok = false;
      }
      if (ok) best = { x, y: floor + 1, z, axis, moved };
    }
  }
  return best;
}
scene('s4_nether_stronghold', 'the road to the stronghold through the Nether, once: two eyes near the gate, the gate by the portal hand, the walk to (x/8, z/8), a second gate, the overworld side', async note => {
  const gateSpec = (process.env.HUNT_GATE_AT ?? '160,75,28').split(',').map(Number), gate = { x: gateSpec[0]!, y: gateSpec[1]!, z: gateSpec[2]! };
  const room = sites.strongholdPortalCenter as number[], deaths0 = deaths, started = Date.now(), limitMs = s4RunLimit(1500);
  const phases: Record<string, number> = {};
  const phase = (name: string, from: number) => { phases[name] = r1((Date.now() - from) / 1000); };
  const out: Record<string, unknown> = { gate: gateSpec };
  await ask('difficulty normal'); await ask('gamerule doMobSpawning false'); await ask('time set noon'); await ask('gamerule doDaylightCycle false'); await ask('weather clear');
  await s4EquipOriginal({ ender_eye: 3 }, { armor: 'none', shield: false });
  // ---- the two throws --------------------------------------------------------------------------------------------------------------------------------------------
  let phaseStart = Date.now();
  const located = await locateFrom(gate.x, 120, gate.z);
  const first = await s4Throw('eye-1', gate.x - 3, gate.z - 6);
  if (!first) return { ...out, stage: 'no first eye', located };
  note(`first eye from ${JSON.stringify(first.origin)}: bearing ${first.bearing}, ${first.fate}; /locate says the stronghold starts ${located ? `${located.x},${located.z}` : '?'} (bearing there ${located ? r1(bearingBetween(first.origin, located)) : '?'})`);
  // The second spot: across the first bearing, as far as 70 m (down to 50) on dry ground the client holds, on whichever side has some.
  const rad = (degrees: number) => degrees * Math.PI / 180, along = { x: Math.sin(rad(first.bearing)), z: -Math.cos(rad(first.bearing)) }, across = { x: -along.z, z: along.x };
  let second: Awaited<ReturnType<typeof s4Throw>> = null, secondAt: [number, number] | null = null;
  await s4StandAt(Math.round(first.origin.x), Math.round(first.origin.z));
  for (const metres of [70, 60, 50, 85]) for (const side of [1, -1]) {
    const x = Math.round(first.origin.x + across.x * side * metres), z = Math.round(first.origin.z + across.z * side * metres);
    if (!secondAt && s4Dry(x, z)) { secondAt = [x, z]; break; }
  }
  if (!secondAt) return { ...out, stage: 'no dry second spot', first, located };
  second = await s4Throw('eye-2', secondAt[0], secondAt[1]);
  if (!second) return { ...out, stage: 'no second eye', first, located };
  note(`second eye from ${JSON.stringify(second.origin)} (${r1(Math.hypot(second.origin.x - first.origin.x, second.origin.z - first.origin.z))} m from the first): bearing ${second.bearing}, ${second.fate}`);
  const estimate = s4Intersect(first.origin, first.bearing, second.origin, second.bearing);
  if (!estimate) return { ...out, stage: 'parallel bearings', first, second, located };
  const errorToLocate = located ? r1(Math.hypot(estimate.x - located.x, estimate.z - located.z)) : null, errorToRoom = r1(Math.hypot(estimate.x - room[0]!, estimate.z - room[2]!));
  note(`the crossing: ${r1(estimate.x)},${r1(estimate.z)}; from /locate's start ${errorToLocate} m, from the portal room ${errorToRoom} m`);
  Object.assign(out, { eyes: { first: { ...first }, second: { ...second }, baselineMetres: r1(Math.hypot(second.origin.x - first.origin.x, second.origin.z - first.origin.z)) }, estimate: { x: r1(estimate.x), z: r1(estimate.z) }, located, errorToLocate, errorToRoom });
  phase('throws', phaseStart);
  // ---- the gate on the surface -----------------------------------------------------------------------------------------------------------------------------------
  phaseStart = Date.now();
  const gate1 = await s4GateEnter(note);
  note(`the first gate: ${gate1.attempts.join(' | ')}`);
  if (!gate1.entered) return { ...out, stage: 'first gate not entered', attempts: gate1.attempts };
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true');
  await sleep(4000);
  const exit = actor.entity.position as Vec3;
  Object.assign(out, { netherExit: [r1(exit.x), r1(exit.y), r1(exit.z)], gateAttempts: gate1.attempts, gateSurfaceY: gate1.surfaceY });
  phase('gate1', phaseStart);
  // ---- the walk in the Nether ------------------------------------------------------------------------------------------------------------------------------------
  phaseStart = Date.now();
  const goal = [Math.round(estimate.x / 8), Math.floor(exit.y), Math.round(estimate.z / 8)];
  const metresToWalk = r1(Math.hypot(goal[0]! - exit.x, goal[2]! - exit.z));
  note(`the walk in the Nether: from ${r1(exit.x)},${r1(exit.y)},${r1(exit.z)} to ${goal[0]},?,${goal[2]} (${metresToWalk} m)`);
  await ask(`execute in minecraft:the_nether run forceload add ${goal[0]! - 24} ${goal[2]! - 24} ${goal[0]! + 24} ${goal[2]! + 24}`);
  const walk = await s4NetherWalk(goal, { limitMs: Math.max(120_000, limitMs - (Date.now() - started) - 420_000), deaths0, label: 'nether', note, reachMetres: 10, ignoreY: true });
  note(`the Nether walk: ${walk.reached ? 'reached' : 'NOT reached'} in ${walk.seconds}s, ${walk.endDistance} m left, hops ${walk.okHops}/${walk.hops}, hp lost ${walk.hpLost} (lowest ${walk.lowestHp}); mobs ${JSON.stringify(walk.mobs)}; stops ${JSON.stringify(walk.stops)}`);
  Object.assign(out, { walk: { ...walk, trail: undefined, trailSample: walk.trail.filter((_, index) => index % 10 === 0) }, metresToWalk });
  phase('walk', phaseStart);
  if (!walk.reached || !s4Alive(deaths0)) return { ...out, stage: 'walk did not arrive', deathsHere: deaths - deaths0, phases };
  // ---- the second gate -------------------------------------------------------------------------------------------------------------------------------------------
  phaseStart = Date.now();
  await ask(`give ${ACTOR} minecraft:obsidian 10`);
  let spot = s4FindGateSpot(10), carved = false;
  if (!spot) {
    // What a head would dig out by hand (a pocket of 6 by 6 by 6 over a floor): said so in the report.
    const p = actor.entity.position as Vec3, bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    await ask(`execute in minecraft:the_nether run fill ${bx - 4} ${by} ${bz - 4} ${bx + 4} ${by + 6} ${bz + 4} minecraft:air`);
    await ask(`execute in minecraft:the_nether run fill ${bx - 4} ${by - 1} ${bz - 4} ${bx + 4} ${by - 1} ${bz + 4} minecraft:netherrack`);
    await sleep(2500);
    spot = s4FindGateSpot(10); carved = true;
  }
  if (!spot) return { ...out, stage: 'no spot for the second gate', phases };
  note(`the second gate: inside's lower cell ${spot.x},${spot.y},${spot.z} axis ${spot.axis} (${r1(spot.moved)} from the body${carved ? '; a pocket was cut out first' : ''})`);
  s4MapAround('gate2', 7, 4, 2);
  const run = await act('gate2', [{ do: 'portal', at: [{ x: spot.x, y: spot.y, z: spot.z }], axis: spot.axis, enter: true, canPlace: ['cobblestone', 'netherrack'], maxPlace: 16, seconds: 100 }], 130);
  await sleep(4000);
  let walks = 0;
  while (dimensionOf() !== 'overworld' && walks++ < 2 && s4Alive(deaths0)) {
    const lit = actor.blockAt(new Vec3(spot.x, spot.y, spot.z), false)?.name === 'nether_portal';
    if (!lit) break;
    const again = await act('gate2-walk', [{ do: 'walk', to: { x: spot.x, y: spot.y, z: spot.z }, range: 0.5 }], 45);
    note(`walk into the second gate: ${again.ok ? 'ok' : 'NO'} ${s4Short(again.lines[0] ?? again.error ?? '', 160)}`);
    await sleep(5000);
  }
  Object.assign(out, { gate2: { spot, carvedPocket: carved, ok: run.ok, line: s4Short(run.lines[0] ?? run.error ?? '', 220) } });
  phase('gate2', phaseStart);
  const arrived = dimensionOf() === 'overworld';
  await sleep(4000);
  const back = actor.entity.position as Vec3;
  const surface = arrived ? s4SurfaceY(Math.floor(back.x), Math.floor(back.z)) : null;
  const result = { ...out, stage: arrived ? 'done' : 'second gate not entered', arrivedOverworld: arrived, overworldExit: [r1(back.x), r1(back.y), r1(back.z)], surfaceAbove: surface, undergroundBy: surface === null ? null : r1(surface - back.y),
    fromRoomHorizontal: r1(Math.hypot(back.x - room[0]!, back.z - room[2]!)), fromEstimateHorizontal: r1(Math.hypot(back.x - estimate.x, back.z - estimate.z)), fromLocateStart: located ? r1(Math.hypot(back.x - located.x, back.z - located.z)) : null,
    roomDepthBelowExit: r1(back.y - room[1]!), seconds: r1((Date.now() - started) / 1000), phases, deathsHere: deaths - deaths0 };
  note(`the overworld side: ${arrived ? `the body stands at ${r1(back.x)},${r1(back.y)},${r1(back.z)}; the portal room is ${result.fromRoomHorizontal} m off across and ${result.roomDepthBelowExit} m down; the surface above is y ${surface}` : 'not arrived'}`);
  return result;
});
