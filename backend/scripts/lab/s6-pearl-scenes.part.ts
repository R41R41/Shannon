// ===== S6 (11/5): pearls to fourteen with the production hands only =================================================================
// Inserted into scripts/minecraft-hunt-probe.ts before '// ---- run -' by s4-section-probe.sh (S4_SCENES_PART=".. s6-pearl-scenes.part.ts").
// ender_roof_natural chose the site (a level 5x5) and the #id itself; in an uneven forest (c1's warped forest) it found no site in 11 minutes.
// This scene leaves both to the body the way a head that says `fight target=enderman` does: the body picks the enderman (fight's pickEnderman),
// builds its roof where it stands or walks to one within 7 m, and the scripted stand-in only (a) picks up and goes back to the roof cell after a
// kill, (b) eats, (c) walks about 10 m on when the body says none is to be had here. The clock stops at fourteen pearls carried, a death, or 25 min.
scene('s6_pearls_kind', '自然湧き: fight target=enderman（体が選ぶ）＋拾う、パール 14 個まで（最大25分）。召喚なし', async note => {
  const override = (process.env.MINECRAFT_HUNT_ROOF_STAND ?? process.env.ROOF_STAND)?.split(',').map(part => part.trim());
  const dimension = override?.[0] === 'overworld' ? 'overworld' : 'the_nether';
  const stand = override?.length === 4 ? override.slice(1).map(Number) : sites.warpedStand as number[] | undefined;
  if (!stand || stand.length !== 3 || !stand.every(Number.isFinite)) throw new Error('no warpedStand in the sites');
  roofStand = { dimension, x: stand[0], y: stand[1], z: stand[2] };
  const goal = Number(process.env.MINECRAFT_HUNT_PEARLS ?? 14), limitMs = (timedSeconds || 1500) * 1000;
  if (dimension === 'overworld') { await ask('time set midnight'); await ask('weather clear'); await ask('gamerule advance_time false'); await ask('gamerule doDaylightCycle false'); }
  await ask('difficulty normal');
  await equip({ stone_sword: 3, stone_pickaxe: 1, cooked_beef: 32, cobblestone: 128 }, { armor: 'iron', shield: true });
  await placeActor(dimension, stand[0], stand[1], stand[2], 24);
  await ask(`effect clear ${ACTOR}`);
  await ask('gamerule spawn_mobs true'); await ask('gamerule doMobSpawning true');
  const start = Date.now(), endAt = start + limitMs, deathsBefore = deaths, pearlStart = packClient().ender_pearl ?? 0;
  const remaining = () => Math.max(0, endAt - Date.now());
  const pearls = () => (packClient().ender_pearl ?? 0) - pearlStart;
  const rows: any[] = [], kills: Array<{ s: number; pearls: number }> = [];
  const clock = { fightMs: 0, pickupMs: 0, exploreMs: 0, eatMs: 0, otherMs: 0 };
  let lastHp = Number(actor.health), healthLost = 0, explore = 0, reachedAt: number | null = null, emptyInRow = 0;
  const hurt = () => { const hp = Number(actor.health); if (Number.isFinite(hp)) { healthLost += Math.max(0, lastHp - hp); lastHp = hp; } };
  actor.on('health', hurt);
  const angryNear = () => (Object.values(actor.entities ?? {}) as any[]).some(e => e?.name === 'enderman' && endermanAngry(actor.registry, e));
  const walkTo = (to: { x: number; y: number; z: number }) => ({ do: 'go', to, range: 0, maxDig: 0, maxPlace: 0, maxDrop: 0, waterOk: false, seconds: 12 });
  let stopReason = 'clock';
  try {
    while (remaining() > 6_000 && !disconnected) {
      hurt();
      if (deaths > deathsBefore) { stopReason = 'death'; break; }
      if (pearls() >= goal) { reachedAt = Date.now(); stopReason = 'goal'; break; }
      const at = Date.now();
      if (!angryNear() && Number(actor.food) < 18) { await act('s6-eat', [{ do: 'eat' }], 10); clock.eatMs += Date.now() - at; continue; }
      const before = pearls();
      const seconds = Math.min(45, Math.floor(remaining() / 1000) - 2);
      const run = await act(`s6-fight#${rows.length + 1}`, [{ do: 'fight', target: 'enderman', seconds, retreatHp: 8 }], seconds + 1, { accept: ['enderman'] }, { deadlineAt: endAt });
      clock.fightMs += Date.now() - at;
      const line = run.lines[0] ?? '', code = run.json?.lines?.[0]?.code ?? run.stoppedBy ?? null;
      const killed = /死んだ/u.test(line);
      const row: any = { i: rows.length + 1, s: (at - start) / 1000, code, killed, line: line.slice(0, 400), hp: run.hp };
      rows.push(row);
      if (killed) {
        emptyInRow = 0;
        const camp = endermanCampObservation(actor), home = camp?.roofCell ?? null;
        if (!angryNear()) {
          const p0 = Date.now();
          const back = home ? [walkTo(home)] : [];
          const pick = await act(`s6-pickup#${row.i}`, [{ do: 'pickup', range: 6, seconds: 10 }, ...back], 25, { accept: ['enderman'] }, { deadlineAt: endAt });
          row.pickup = (pick.lines ?? []).join(' | ').slice(0, 300); clock.pickupMs += Date.now() - p0;
        }
        row.pearls = pearls() - before;
        kills.push({ s: (Date.now() - start) / 1000, pearls: pearls() });
        note(`kill ${kills.length} at ${(Date.now() - start) / 1000 | 0}s: pearls ${pearls()}`);
        continue;
      }
      // The body says none is to be had here (none seen, eyes hidden, no roof site): walk about 10 m along the next compass direction (the stand-in's explore).
      if (!angryNear() && /target_not_found|enderman_not_visible|no_site|roof_failed|enderman_not_angry|lost/u.test(String(code)) ) {
        emptyInRow++;
        if (emptyInRow < 2 && /enderman_not_visible|enderman_not_angry/u.test(String(code))) continue;   // another one may be in sight now
        emptyInRow = 0;
        const e0 = Date.now(); explore++;
        const p0 = actor.entity.position, angle = (explore % 8) * Math.PI / 4, read = bodyReader(actor);
        let goal3: { x: number; y: number; z: number } | null = null;
        for (const len of [10, 8, 12, 6]) for (const dy of [0, -1, 1, -2, 2, -3, 3]) {
          const c = { x: Math.floor(p0.x + len * Math.cos(angle)), y: Math.floor(p0.y + 0.001) + dy, z: Math.floor(p0.z + len * Math.sin(angle)) };
          const f = read(c.x, c.y - 1, c.z), a = read(c.x, c.y, c.z), h = read(c.x, c.y + 1, c.z);
          if (!goal3 && f?.solid && a && h && !a.solid && !h.solid && !/lava|water|magma|fire|leaves|cactus/u.test(`${f.name} ${a.name} ${h.name}`)) goal3 = c;
        }
        if (goal3) { const walk = await act(`s6-explore#${explore}`, [walkTo(goal3)], 13, { accept: ['enderman'] }, { deadlineAt: endAt }); row.explore = (walk.lines[0] ?? '').slice(0, 200); }
        else await sleep(1000);
        clock.exploreMs += Date.now() - e0;
        continue;
      }
      clock.otherMs += Date.now() - at;
      if (!run.ok && !killed) await sleep(500);
    }
    if (disconnected) stopReason = disconnected;
    if (deaths > deathsBefore) stopReason = 'death';
    if (pearls() >= goal && reachedAt === null) { reachedAt = Date.now(); stopReason = 'goal'; }
  } catch (error) { stopReason = String((error as Error)?.message ?? error); note(`場面を中断: ${stopReason}`); }
  finally { actor.removeListener('health', hurt); }
  const summary = { stand: roofStand, goal, pearls: pearls(), secondsToGoal: reachedAt ? (reachedAt - start) / 1000 : null, wallSeconds: (Date.now() - start) / 1000,
    stopReason, deaths: deaths - deathsBefore, healthLost, kills: kills.length, fights: rows.length, killsTimeline: kills,
    codes: rows.reduce((m: Record<string, number>, r) => { m[String(r.code)] = (m[String(r.code)] ?? 0) + 1; return m; }, {}), clock, explores: explore };
  note(`S6 RESULT ${JSON.stringify({ ...summary, killsTimeline: undefined })}`);
  return { ...summary, rows };
});

