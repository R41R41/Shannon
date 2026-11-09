// ===== S1: the bow at the blaze spawner's blazes, from a walled cell ====================================================================
// Inserted into a copy of S2's hunt probe by s1-blaze-bow-probe.sh (before its "run" part), so the helpers of that file are in scope: ask, equip, placeActor, act, runSkill, countServer,
// shieldUsed, packClient, actor, sites, scene, deaths, disconnected, timedSeconds, sleep, r1, Vec3. The coordinator's question (2026-11-03): can the crystals' bow aim (arrow speed 3, drag 0.99, gravity 0.05)
// kill the c1 spawner's blazes from the camp cell closed with cobblestone, without the deaths of going out to fight (pass: no death after the iron armour, lowest health 8 or more, 3 rods or more, and the arrows per kill).
// Scenes: s1_bow_head (the head cell toward the spawner left open as the window), s1_bow_front (only the side away from the spawner closed: the front open), s1_bow_head_pick (the head window, and the rods picked up when the health allows).

async function s1BlazeBow(note: (text: string) => void, options: { window: 'head' | 'front' | 'low'; pick?: boolean; seconds?: number }): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined, spawner = sites.blazeSpawner as number[] | undefined;
  if (!stand || !spawner) throw new Error('no blazeStand or blazeSpawner in the sites');
  const seconds = options.seconds ?? (timedSeconds || 300);
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
  // the run59 pack with a bow and arrows
  await equip({ stone_sword: 1, diamond_pickaxe: 1, shield: 1, cooked_porkchop: 7, cobblestone: 173, bow: 1, arrow: 64 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const camp = await runSkill('probe', { kind: 'camp' }, 20);
  let cell: { x: number; y: number; z: number } | undefined;
  try { cell = JSON.parse(String(camp.receipt?.result ?? '')).cells?.[0]; } catch { cell = undefined; }
  if (!cell) throw new Error('no camp cell');
  const solidAt = (x: number, y: number, z: number) => { const b = actor.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'block'; };
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  const toward = [...sides].sort((a, b) => ((spawner[0] - cell!.x) * b[0] + (spawner[2] - cell!.z) * b[1]) - ((spawner[0] - cell!.x) * a[0] + (spawner[2] - cell!.z) * a[1]))[0];
  const place: Array<{ x: number; y: number; z: number }> = [];
  if (options.window === 'head' || options.window === 'low') {
    // head: the head cell toward the spawner is the window (a lintel over it clips the arrows that go up: S2's nook, 34 to 70 degrees); low: every side is a wall of one block only (a trench: the sky and the room open over it, the arrows leave at any angle)
    for (const [dx, dz] of sides) {
      const x = cell.x + dx, z = cell.z + dz;
      if (!solidAt(x, cell.y, z)) place.push({ x, y: cell.y, z });
      if (options.window === 'head' && !(dx === toward[0] && dz === toward[1]) && !solidAt(x, cell.y + 1, z)) place.push({ x, y: cell.y + 1, z });
    }
  } else {
    const open2 = sides.filter(([dx, dz]) => !solidAt(cell!.x + dx, cell!.y, cell!.z + dz) && !solidAt(cell!.x + dx, cell!.y + 1, cell!.z + dz) && !(dx === toward[0] && dz === toward[1]));
    for (const [dx, dz] of open2) for (const dy of [0, 1]) if (!solidAt(cell.x + dx, cell.y + dy, cell.z + dz)) place.push({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz });
  }
  note(`camp cell ${JSON.stringify(cell)}, toward the spawner ${JSON.stringify(toward)}, window ${options.window}, to place ${place.length}`);
  const canPlace = ['cobblestone'];
  const started = Date.now();
  const rods0 = await countServer('blaze_rod'), shield0 = shieldUsed(), arrows0 = packClient().arrow ?? 0;
  let killed = 0;
  const killTimes: number[] = [];
  const onDead = (entity: any) => { if (String(entity?.name ?? '') === 'blaze') { killed++; killTimes.push(Math.round((Date.now() - started) / 1000)); } };
  actor.on('entityDead', onDead);
  const track: number[] = [];
  const sampler = setInterval(() => { const value = Number(actor.health); if (Number.isFinite(value)) track.push(r1(value)); }, 1000);
  const m = { acts: 0, okActs: 0, shots: 0, hits: 0, refused: 0, lineBlocked: 0, tooFar: 0, noTarget: 0, hpLost: 0, lowestHp: 20, reflexStops: 0 };
  const samples: string[] = [];
  let aborted = '';
  try {
    // The camp cell first, the fire its neighbours may hold put out, the walls laid; asked again while the body is not on the cell or a wall is missing (a fireball pushes it off and sets fire to the cells).
    for (let attempt = 1; attempt <= 4 && !disconnected && Number(actor.health) > 0; attempt++) {
      const at = actor.entity.position as Vec3;
      if (Math.hypot(at.x - (cell.x + 0.5), at.z - (cell.z + 0.5)) > 0.9 || Math.abs(at.y - cell.y) > 0.6) {
        const there = await act(`go to the camp cell#${attempt}`, [{ do: 'go', to: { x: cell.x, y: cell.y, z: cell.z }, range: 0.6, seconds: 25, canPlace, maxPlace: 10 }], 40, { accept: ['blaze'] });
        note(`go#${attempt}: hp ${r1(Number(actor.health))} ${(there.lines[0] ?? '').slice(0, 160)}`);
      }
      const burning = place.filter(p => /fire/u.test(String(actor.blockAt(new Vec3(p.x, p.y, p.z))?.name ?? '')));
      if (burning.length) { const out = await act(`put out ${burning.length} fire`, [{ do: 'dig', at: burning.map(p => ({ x: p.x, y: p.y, z: p.z })) }], 20, { accept: ['blaze'] }); note(`dig fire: ${(out.lines[0] ?? '').slice(0, 140)}`); }
      const missing = place.filter(p => !solidAt(p.x, p.y, p.z));
      if (!missing.length) break;
      const built = await act(`build the walls#${attempt}`, [{ do: 'place', at: missing, block: 'cobblestone' }], 40, { accept: ['blaze'] });
      note(`place#${attempt}: hp ${r1(Number(actor.health))} missing ${missing.length} ${built.lines.join(' | ').slice(0, 260)}`);
    }
    const inside = actor.entity.position as Vec3;
    note(`standing at ${r1(inside.x)},${r1(inside.y)},${r1(inside.z)}`);
    while (Date.now() - started < seconds * 1000 && !disconnected && Number(actor.health) > 0) {
      const before = Number(actor.health);
      const seen = (Object.values(actor.entities ?? {}) as any[]).filter(e => e?.name === 'blaze' && e.position).map(e => ({ d: r1(e.position.distanceTo(actor.entity.position)), dy: r1(e.position.y - actor.entity.position.y) })).sort((a, b) => a.d - b.d).slice(0, 4);
      const run = await act(`shoot#${m.acts + 1}`, [{ do: 'shoot', target: 'blaze', n: 3, item: 'bow', onFail: 'continue' }], 30, { accept: ['blaze'] });
      m.acts++; if (run.ok) m.okActs++;
      const text = run.lines.join(' ');
      const tally = /当たり (\d+)\/(\d+)/u.exec(text);
      if (tally) { m.hits += Number(tally[1]); m.shots += Number(tally[2]); }
      if (/line_blocked|矢の道/u.test(text)) m.lineBlocked++;
      if (/届かない|遠すぎ/u.test(text)) m.tooFar++;
      if (!run.ok && !tally) { m.refused++; if (/見えない|いない|target_not_found/u.test(text)) m.noTarget++; await sleep(1200); }
      if (run.stoppedBy === 'reflex') m.reflexStops++;
      m.hpLost += Math.max(0, before - Number(actor.health)); m.lowestHp = Math.min(m.lowestHp, Number(actor.health));
      if (samples.length < 14) samples.push(`#${m.acts} hp ${r1(before)}→${r1(Number(actor.health))} near ${JSON.stringify(seen)} ${text.slice(0, 170)}`);
      if (Number(actor.health) < 12 && Number(actor.food) < 18) await act('eat', [{ do: 'eat' }], 15);
      if (Number(actor.health) < 8) { aborted = `health ${r1(Number(actor.health))}: stop`; note(aborted); break; }
    }
    const rodsFloor = (await countServer('blaze_rod')) - rods0;
    note(`shooting done: killed ${killed}, rods on the floor ${rodsFloor}, hp ${r1(Number(actor.health))}`);
    if (options.pick && Number(actor.health) >= 14 && !disconnected) {
      const hp0 = Number(actor.health);
      const picked = await act('pick up the rods', [{ do: 'pickup', range: 10 }, { do: 'go', to: { x: cell.x, y: cell.y, z: cell.z }, range: 0.6, seconds: 20, canPlace }], 40, { accept: ['blaze'] });
      note(`pickup: hp ${r1(hp0)}→${r1(Number(actor.health))} ${picked.lines.join(' | ').slice(0, 260)}`);
      m.lowestHp = Math.min(m.lowestHp, Number(actor.health));
    }
  } finally { clearInterval(sampler); actor.removeListener('entityDead', onDead); }
  for (const line of samples) note(line);
  const arrowsUsed = arrows0 - (packClient().arrow ?? 0);
  const rodsInPack = packClient().blaze_rod ?? 0;
  return { seconds: r1((Date.now() - started) / 1000), killed, killTimes, arrowsUsed, arrowsPerKill: killed ? r1(arrowsUsed / killed) : null, rodsOnTheFloorOrInPack: (await countServer('blaze_rod')) - rods0, rodsInPack,
    shieldWear: shieldUsed() - shield0, deathsHere: deaths, hpTrack: track.filter((_, index) => index % 5 === 0).join(' '), ...m, hpLost: r1(m.hpLost), placed: place.length, window: options.window, aborted };
}
scene('s1_bow_head', 'S1: the camp cell walled with the head cell toward the spawner left open, the bow (shoot n 3) at the blazes, run59 pack + bow and 64 arrows', note => s1BlazeBow(note, { window: 'head' }));
scene('s1_bow_front', 'S1: the camp cell with only the side away from the spawner closed (the front open), the bow at the blazes', note => s1BlazeBow(note, { window: 'front' }));
scene('s1_bow_head_pick', 'S1: the head window, and the rods picked up at the end when the health allows', note => s1BlazeBow(note, { window: 'head', pick: true }));
scene('s1_bow_low', 'S1: the camp cell a one-block wall on every side (a trench: nothing over it, the arrows leave at any angle), the bow at the blazes', note => s1BlazeBow(note, { window: 'low' }));
