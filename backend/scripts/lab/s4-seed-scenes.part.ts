// ---- seed survey: the shape of every blaze spawner room of a staged world (body reads and the server's blocks only, no head) -------------
// Run on each staged key (c1 c3 c5 c6 c7 c8 n1 n4 ...): the room the blazes spawn in decides how easy the fight is. Reported per spawner: the camp
// cells S2's campSite finds within 4 blocks (enclosed hideouts: walls / pits), the open sides of the room (a clear line of 10 blocks at head height in
// each of the four directions), the share of solid cells on the shell of a 9 x 9 x 5 box round the spawner, the free floor cells under 2 blocks of air,
// and the lava near it.
function s4RoomShape(sx: number, sy: number, sz: number): Record<string, unknown> {
  const solid = (x: number, y: number, z: number) => {
    const block = actor.blockAt(new Vec3(x, y, z), false);
    return block ? block.boundingBox === 'block' : null;
  };
  let shellSolid = 0, shellKnown = 0, floorCells = 0, airCells = 0, unknown = 0;
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -1; dy <= 4; dy++) {
    const s = solid(sx + dx, sy + dy, sz + dz);
    if (s === null) { unknown++; continue; }
    if (!s) airCells++;
    const onShell = Math.abs(dx) === 4 || Math.abs(dz) === 4 || dy === 4;
    if (onShell) { shellKnown++; if (s) shellSolid++; }
    if (dy === 0 && s && solid(sx + dx, sy + dy + 1, sz + dz) === false && solid(sx + dx, sy + dy + 2, sz + dz) === false) floorCells++;
  }
  const sides: Record<string, number> = {};
  for (const [name, vx, vz] of [['east', 1, 0], ['west', -1, 0], ['south', 0, 1], ['north', 0, -1]] as Array<[string, number, number]>) {
    let clear = 0;
    for (let step = 1; step <= 10; step++) { if (solid(sx + vx * step, sy + 1, sz + vz * step) !== false) break; clear = step; }
    sides[name] = clear;
  }
  const openSides = Object.values(sides).filter(length => length >= 10).length;
  const lava = s4Lava(sx, sy, sz, 12) as { within6?: number; within12?: number };
  return { shellSolidShare: shellKnown ? Number((shellSolid / shellKnown).toFixed(2)) : null, airCells, floorCells, unknown, sides, openSides,
    lavaWithin6: lava.within6 ?? null, lavaWithin12: lava.within12 ?? null };
}

scene('s4_seed_rooms', 'seed survey: every blaze spawner room of the staged world: camp cells, open sides, enclosure, lava (the body\'s reads, no head)', async note => {
  await ask('difficulty peaceful'); await ask('gamemode spectator ' + ACTOR);
  const spawners = ((sites.blazeSpawners ?? [sites.blazeSpawner]) as number[][]).filter(Boolean);
  const rooms: Array<Record<string, unknown>> = [];
  for (const spawner of spawners) {
    await placeActor('the_nether', spawner[0], spawner[1] + 2, spawner[2], 40);
    await sleep(3500);
    const read = bodyReader(actor) as any;
    const cells = campSite(read, { x: spawner[0], y: spawner[1], z: spawner[2] }, 4).cells;
    const shape = s4RoomShape(spawner[0], spawner[1], spawner[2]);
    const entry = { spawner, campCells: cells.length, bestCamp: cells.slice(0, 3).map((c: any) => ({ at: [c.x, c.y, c.z], walls: c.walls, pits: c.pits })), ...shape };
    rooms.push(entry);
    note(`seed rooms ${JSON.stringify(entry)}`);
  }
  const arrival = sites.netherArrival as number[] | undefined, stand = sites.blazeStand as number[] | undefined;
  return { rooms, arrival, blazeStand: stand, spawners: spawners.length, fromArrival: arrival && spawners[0] ? Math.round(Math.hypot(spawners[0][0] - arrival[0], spawners[0][2] - arrival[2])) : null };
});

// ---- den survey: where the warped forest has a wall a 2-high, 2-deep side tunnel can be dug into (needs a pin that has huntEndermanDen: claude/dragon-pearl) ----
scene('s4_den_survey', 'den survey: the enderman den candidates (radius 12) from a grid of points round the warped forest\'s stand: how many, where, and what the best one looks like', async note => {
  const stand = sites.warpedStand as number[];
  await ask('difficulty peaceful'); await ask('gamemode spectator ' + ACTOR);
  const rows: Array<Record<string, unknown>> = [];
  let total = 0, points = 0, withAny = 0;
  for (let dx = -64; dx <= 64; dx += 16) for (let dz = -64; dz <= 64; dz += 16) {
    const x = stand[0] + dx, z = stand[2] + dz;
    await ask(`execute in minecraft:the_nether run forceload add ${x - 14} ${z - 14} ${x + 14} ${z + 14}`);
    await sleep(900);
    points++;
    const found: Array<any> = [];
    for (const dy of [-16, -8, 0, 8, 16]) {      // the nether floor's height varies: five heights per point, a radius-12 read at each (vertical range 2)
      await ask(`execute in minecraft:the_nether run tp ${ACTOR} ${x + 0.5} ${stand[1] + dy} ${z + 0.5}`);
      await sleep(dy === -16 ? 1400 : 450);
      for (const item of (endermanDenCandidates as any)(actor, { radius: 12, verticalRange: 2, limit: 64 }) as Array<any>) found.push(item);
    }
    found.sort((a, b) => a.score - b.score);
    total += found.length; if (found.length) withAny++;
    rows.push({ at: [x, z], count: found.length, best: found[0] ? { entrance: found[0].entrance, direction: found[0].direction, sight: found[0].sightDistance, penalties: found[0].penalties } : null });
  }
  note(`den survey: ${points} points, ${withAny} with at least one candidate, ${total} candidates in all`);
  note(`den survey rows ${JSON.stringify(rows.filter(r => (r.count as number) > 0))}`);
  return { points, withAny, total, rows };
});
