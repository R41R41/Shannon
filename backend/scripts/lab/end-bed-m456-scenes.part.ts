// ===== S7: M4 / M5 / M6 of the bed kill (dragon-bed-precision-20261104.md 264-270) ======================================================================
// Spliced into a copy of scripts/minecraft-end-fight-probe.ts before its "run" part by scripts/lab/end-bed-m456.sh (the probe file itself is not edited), so the
// probe's helpers are in scope: ask, END, DRAGON, ACTOR, actor, sleep, log, round, park, protect, holdReflexOff, releaseReflex, perch, still, g, fountainY,
// dragonEntity, dragonPhaseOf, partBox, scenes. Run after `enter`: END_SCENES=enter,m4_stand_safety (or m5_perch_budget, m6_landing_c10, m6_landing_c0).
//   m4_stand_safety  where to stand: 26 bed blasts (place + use in one go, the M3 packets) from stands beside an obsidian column under the pillow; the explosion
//                    packet's own knockback gives the exposure exactly, the unarmoured health loss the damage. Pass: every blast of the candidate stands loses
//                    <= 1.5 and is pushed < 0.05 (dragon-bed-precision 361: "feet about 3.1 m under the blast, all 45 rays blocked").
//   m5_perch_budget  the perched budget: blast 1 at d ~2.3 m (planned ~48), blast 2 ten ticks later at the nearest cell (~64), then one more bed in the
//                    takeoff; the dragon's loss per blast from its metadata, the phase after each, the head's path in the takeoff.
//   m6_landing_c10 / m6_landing_c0   the wait for the first landing with 10 / 0 crystals: the dragon reset to (0, 128, 0) in its holding pattern again and
//                    again with the actor standing in the fountain, at a raised tick rate; the game time to phase 2, 3 and the perch, from the world age.
import { exposureFromKnockback, exposureFromDamage, distanceForDamage, m4Layout, m4Predict, m4Verdict, m5PillowCell, perchedBudget, waitSummary, facingYaw, CARDINAL, type M4Layout, type Cardinal } from '../src/services/minebot/utils/bedM456.js';
// bedBurstPackets (the M3 packets) is imported by the probe itself.

let m456Tick = 0;
actor.on('physicsTick', () => { m456Tick++; });
let m456Sequence = 4_000_000;
const m456Air = (p: P3) => { const b = actor.blockAt(new Vec3(p.x, p.y, p.z)); return !!b && /^(air|cave_air|void_air)$/u.test(b.name); };
/** The dragon's health as its metadata says (float, unrounded), or null. */
const m456DragonHealth = (): number | null => {
  const d = dragonEntity(); if (!d) return null;
  const keys: string[] | undefined = (actor as any).registry?.entitiesByName?.ender_dragon?.metadataKeys;
  const at = keys?.indexOf('health') ?? -1, v = d.metadata?.[at >= 0 ? at : 9];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const m456Ticks = (n: number) => new Promise<void>(resolve => { const end = m456Tick + n; const on = () => { if (m456Tick >= end) { actor.removeListener('physicsTick', on); resolve(); } }; actor.on('physicsTick', on); });
const m456UntilTick = (t: number) => m456Ticks(Math.max(0, t - m456Tick));
type M456Explosion = { tick: number; centre: P3; knockback: P3 | null; ms: number };
/** Every explosion packet from now on, with the client tick it came in. */
function m456Explosions() {
  const seen: M456Explosion[] = [];
  const on = (p: any) => { seen.push({ tick: m456Tick, ms: Date.now(), centre: { x: p.center?.x ?? p.x, y: p.center?.y ?? p.y, z: p.center?.z ?? p.z }, knockback: p.playerKnockback ? { x: p.playerKnockback.x, y: p.playerKnockback.y, z: p.playerKnockback.z } : null }); };
  actor._client.on('explosion', on);
  return { seen, stop: () => actor._client.removeListener('explosion', on) };
}
/** Health values the actor is told from now on, each with its tick. */
function m456Healths() {
  const seen: Array<{ tick: number; health: number }> = [];
  const on = (p: any) => { seen.push({ tick: m456Tick, health: Number(p.health) }); };
  actor._client.on('update_health', on);
  return { seen, stop: () => actor._client.removeListener('update_health', on) };
}
/** Write the M3 burst (unsneak, look, place on the arm's top, use on the foot's top) at once. The bed must be in the main hand. */
function m456Burst(foot: P3, pillow: P3, facing: Cardinal, placeToo = true): string[] {
  m456Sequence += 4;
  const packets = bedBurstPackets(foot, pillow, facingYaw(facing), -0.7, true, m456Sequence);
  const sent: string[] = [];
  for (const packet of packets) {
    if (!placeToo && packet.stage === 'place') continue;
    actor._client.write(packet.name, packet.data); sent.push(packet.stage);
  }
  return sent;
}
const m456Fill = (a: P3, b: P3, block: string, extra = '') => ask(`${END} fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${block}${extra ? ' ' + extra : ''}`, 20_000);
const m456Set = (p: P3, block: string) => ask(`${END} setblock ${p.x} ${p.y} ${p.z} ${block}`);
async function m456Regen(on: boolean): Promise<string> {
  // 1.21.11 renamed the game rules; one of the two names answers.
  const a = await ask(`gamerule natural_health_regeneration ${on}`), b = await ask(`gamerule naturalRegeneration ${on}`);
  return `${a.replace(/\s+/gu, ' ').slice(0, 120)} | ${b.replace(/\s+/gu, ' ').slice(0, 120)}`;
}

// ----- M4 -----
const M4_ORIGIN = { x: 0, z: -28 }; // on the island, inside the spike ring (radius 42) and well away from it
scenes.m4_stand_safety = async () => {
  await park(true); await protect(false); holdReflexOff();
  for (const slot of ['head', 'chest', 'legs', 'feet']) await ask(`item replace entity ${ACTOR} armor.${slot} with air`);
  await ask(`effect give ${ACTOR} minecraft:fire_resistance 1200 0 true`);
  const regen = await m456Regen(false);
  const F = g + 12, O = M4_ORIGIN;
  const rel = (dx: number, dy: number, dz: number): P3 => ({ x: O.x + dx, y: F + dy, z: O.z + dz });
  const feetAt = (sx: number, sz: number): P3 => ({ x: O.x + 0.5 + sx, y: F, z: O.z + 0.5 + sz });
  // Candidates: a 3-high obsidian column under the pillow (feet 3.5 under the blast) and the stand beside it; controls the model says are partly open.
  const plans: Array<{ k: number; column: number; sx: number; sz: number; n: number; candidate: boolean; checks: string }> = [
    { k: 3, column: 3, sx: 1.2, sz: 0, n: 5, candidate: true, checks: 'design 177/707: 1.2 m from the column axis (the far side from the foot), feet under the blast by 3.5 (3.1 is between two block heights)' },
    { k: 3, column: 3, sx: 0, sz: 1, n: 5, candidate: true, checks: 'beside the column, square to the bed (the arm is not between)' },
    { k: 3, column: 3, sx: 1, sz: 1, n: 5, candidate: true, checks: 'diagonal to the column (h >= 0.71 s)' },
    { k: 3, column: 3, sx: -1, sz: -1, n: 5, candidate: true, checks: 'diagonal on the foot side, by the arm' },
    { k: 2, column: 2, sx: 1, sz: 0, n: 3, candidate: false, checks: 'control: column 2 high (feet 2.5 under): the model says 6 of 45 rays' },
    { k: 3, column: 3, sx: 2, sz: 0, n: 3, candidate: false, checks: 'control: one block further out: the model says 6 of 45 rays' },
  ];
  const out: Record<string, any> = { regen, floorY: F, origin: O, layouts: [] };
  await m456Fill(rel(-6, -1, -6), rel(6, -1, 6), 'obsidian');
  for (const plan of plans) {
    const layout: M4Layout = m4Layout({ label: `k${plan.k}c${plan.column} stand(${plan.sx},${plan.sz})`, pillow: rel(0, plan.k, 0), facing: 'east', column: plan.column, stand: feetAt(plan.sx, plan.sz), checks: plan.checks });
    const predicted = m4Predict(layout, F);
    const blasts: Array<Record<string, any>> = [];
    for (let i = 0; i < plan.n; i++) {
      await m456Fill(rel(-6, 0, -6), rel(6, 9, 6), 'air');
      for (const p of [layout.arm, ...layout.column, ...layout.shield]) await m456Set(p, 'obsidian');
      await ask(`${END} tp ${ACTOR} ${layout.stand.x} ${layout.stand.y} ${layout.stand.z} -90 30`);
      await ask(`effect give ${ACTOR} minecraft:instant_health 1 4 true`);
      await ask(`item replace entity ${ACTOR} weapon.mainhand with red_bed 4`);
      await sleep(1200);
      const before = { health: Number(actor.health), at: actor.entity.position.clone(), tick: m456Tick };
      const blast = m456Explosions(), healths = m456Healths();
      const sent = m456Burst(layout.foot, layout.pillow, layout.facing);
      for (let t = 0; t < 40 && !blast.seen.length; t++) await m456Ticks(1);
      let fallback = false;
      if (!blast.seen.length) { // the place half did not go through: put the bed by command and use it only (the shielding is what is measured)
        fallback = true;
        await m456Set(layout.foot, 'red_bed[facing=east,part=foot]'); await m456Set(layout.pillow, 'red_bed[facing=east,part=head]');
        await m456Ticks(3); m456Burst(layout.foot, layout.pillow, layout.facing, false);
        for (let t = 0; t < 40 && !blast.seen.length; t++) await m456Ticks(1);
      }
      await m456Ticks(12);
      const at10 = actor.entity.position.clone();
      blast.stop(); healths.stop();
      const e = blast.seen[0] ?? null;
      const firstAfter = e ? healths.seen.find(h => h.tick >= e.tick) ?? null : null;
      const loss = e && firstAfter ? before.health - firstAfter.health : null;
      const fires: number[][] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) {
        const b = actor.blockAt(new Vec3(Math.floor(layout.stand.x) + dx, F + dy, Math.floor(layout.stand.z) + dz));
        if (b?.name === 'fire') fires.push([dx, dy, dz]);
      }
      const centre = e?.centre ?? null, feet = { x: before.at.x, y: before.at.y, z: before.at.z };
      const row = {
        i, sent, fallback, detonated: !!e, centre: centre ? [round(centre.x, 2), round(centre.y, 2), round(centre.z, 2)] : null,
        centreIsPillow: centre ? Math.abs(centre.x - layout.pillow.x - 0.5) < 0.01 && Math.abs(centre.y - layout.pillow.y - 0.5) < 0.01 && Math.abs(centre.z - layout.pillow.z - 0.5) < 0.01 : null,
        healthBefore: before.health, loss: loss === null ? null : round(loss, 3),
        knockback: e?.knockback ? [round(e.knockback.x, 4), round(e.knockback.y, 4), round(e.knockback.z, 4)] : null,
        push: e ? round(e.knockback ? Math.hypot(e.knockback.x, e.knockback.y, e.knockback.z) : 0, 4) : null,
        exposureByKnockback: e && centre ? round(e.knockback ? exposureFromKnockback(e.knockback, feet, centre) ?? NaN : 0, 4) : null,
        exposureByLoss: loss !== null && centre ? round(exposureFromDamage(loss, Math.hypot(feet.x - centre.x, feet.y - centre.y, feet.z - centre.z)) ?? NaN, 4) : null,
        moved10ticks: round(Math.hypot(at10.x - before.at.x, at10.y - before.at.y, at10.z - before.at.z), 3), firesNextToStand: fires.length,
        ticksToExplosion: e ? e.tick - before.tick : null,
      };
      blasts.push(row);
      log(`M4 ${layout.label} #${i}: ${JSON.stringify(row)}`);
      await ask(`${END} fill ${O.x - 6} ${F} ${O.z - 6} ${O.x + 6} ${F + 9} ${O.z + 6} air replace fire`);
    }
    const verdict = m4Verdict(blasts.map(b => ({ loss: b.loss, push: b.push })));
    out.layouts.push({ label: layout.label, candidate: plan.candidate, checks: plan.checks, cells: { pillow: layout.pillow, foot: layout.foot, arm: layout.arm, column: layout.column.length },
      stand: layout.stand, predicted: { rays: predicted.rays, exposure: round(predicted.exposure, 4), loss: round(predicted.damage, 3), push: round(predicted.knockback, 4), reach: round(predicted.reach, 2), feetBelowCentre: predicted.feetBelowCentre, fromAxis: round(predicted.horizontalFromAxis, 2) },
      verdict, blasts });
  }
  const candidates = out.layouts.filter((l: any) => l.candidate);
  out.candidateBlasts = candidates.reduce((n: number, l: any) => n + l.blasts.length, 0);
  out.pass = candidates.every((l: any) => l.verdict.pass);
  out.controlsAgreeWithModel = out.layouts.filter((l: any) => !l.candidate).map((l: any) => ({ label: l.label, predictedRays: l.predicted.rays, measuredRays: l.blasts.map((b: any) => b.exposureByKnockback === null ? null : Math.round(b.exposureByKnockback * 45)) }));
  await m456Regen(true); releaseReflex(); await park(false);
  return out;
};

// ----- M5 -----
/**
 * mineflayer 4.35 puts sync_entity_position's yaw in as DEGREES (entities.js:358-365, the known bug of dragon-bed-precision 4.(a).4); a `tp` of the dragon
 * sends exactly that packet, so after perch() the client's dragon yaw is -180 (radians!) and the head model is metres off (m5a, 11/4: the head put at
 * (5.7, 67, -3.4) instead of (0.5, 67, 7.0), every bed out of reach). This scene-only listener runs after mineflayer's and writes the converted value.
 */
const m456SyncFixes: Array<{ tick: number; rawYaw: number; yaw: number }> = [];
actor._client.on('sync_entity_position', (p: any) => {
  const e = actor.entities?.[p.entityId];
  if (!e || e.name !== 'ender_dragon' || !Number.isFinite(p.yaw)) return;
  const r = Math.PI - p.yaw * Math.PI / 180;
  e.yaw = ((r % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (Number.isFinite(p.pitch)) e.pitch = -p.pitch * Math.PI / 180;
  m456SyncFixes.push({ tick: m456Tick, rawYaw: p.yaw, yaw: e.yaw });
});
/** The head as vanilla places it on the perch (hy -1, p 0, yRotA taken as 0): the client's body position and yaw. */
const m456Head = (d: any) => partBox({ position: d.position, yaw: d.yaw }, 'head');
const m456Boxes = (d: any) => (['head', 'neck', 'body'] as const).map(part => partBox({ position: d.position, yaw: d.yaw }, part));
/** A cell clear of the head, neck and body boxes (the dragon's checkWalls removes any block they overlap; touching is not overlapping). */
const m456Clear = (d: any, c: P3) => m456Boxes(d).every(b => !(c.x < b.maxX - 0.01 && c.x + 1 > b.minX + 0.01 && c.y < b.maxY - 0.01 && c.y + 1 > b.minY + 0.01 && c.z < b.maxZ - 0.01 && c.z + 1 > b.minZ + 0.01));
function m456BedFor(d: any, pillow: P3): { foot: P3; facing: Cardinal } | null {
  for (const facing of ['north', 'south', 'east', 'west'] as Cardinal[]) {
    const v = CARDINAL[facing], foot = { x: pillow.x - v.x, y: pillow.y, z: pillow.z - v.z };
    if (m456Air(foot) && m456Clear(d, foot)) return { foot, facing };
  }
  return null;
}
/** Put a bed by command with its pillow at `pillow`, wait until the client holds both halves, and use it (one packet). The explosion seen, or null. */
async function m456CommandBed(pillow: P3, bed: { foot: P3; facing: Cardinal }, useAtTick: number | null, standAt: P3 | null = null) {
  // Straight to the chat, without ask()'s answer and 250 ms pause, so that the bed is there within a few ticks of the last blast (3 lines: far under the spam limit).
  const commandTick = m456Tick;
  if (standAt) operator.chat(`/${END} tp ${ACTOR} ${standAt.x} ${standAt.y} ${standAt.z}`); // the server takes a click within 4.5 + 1 of the eye only
  operator.chat(`/${END} setblock ${bed.foot.x} ${bed.foot.y} ${bed.foot.z} red_bed[facing=${bed.facing},part=foot]`);
  operator.chat(`/${END} setblock ${pillow.x} ${pillow.y} ${pillow.z} red_bed[facing=${bed.facing},part=head]`);
  for (let t = 0; t < 20 && !/bed/u.test(actor.blockAt(new Vec3(pillow.x, pillow.y, pillow.z))?.name ?? ''); t++) await m456Ticks(1);
  const placedSeenTick = m456Tick;
  if (useAtTick !== null) await m456UntilTick(useAtTick);
  const blast = m456Explosions();
  const healthBefore = m456DragonHealth(), phaseBefore = phaseNow();
  const d = dragonEntity(), headNow = d ? m456Head(d) : null;
  const usedTick = m456Tick;
  m456Burst(bed.foot, pillow, bed.facing, false);
  for (let t = 0; t < 10 && !blast.seen.length; t++) await m456Ticks(1);
  await m456Ticks(2);
  blast.stop();
  const e = blast.seen[0] ?? null, healthAfter = m456DragonHealth();
  const headFeet = headNow ? { x: (headNow.minX + headNow.maxX) / 2, y: headNow.minY, z: (headNow.minZ + headNow.maxZ) / 2 } : null;
  const centre = { x: pillow.x + 0.5, y: pillow.y + 0.5, z: pillow.z + 0.5 };
  const loss = healthBefore !== null && healthAfter !== null ? healthBefore - healthAfter : null;
  return { pillow, facing: bed.facing, commandTick, placedSeenTick, usedTick, detonationTick: e?.tick ?? null, healthBefore, healthAfter, loss: loss === null ? null : round(loss, 3),
    phaseBefore, phaseAfter: phaseNow(), modelDistance: headFeet ? round(Math.hypot(centre.x - headFeet.x, centre.y - headFeet.y, centre.z - headFeet.z), 3) : null,
    distanceFromLoss: loss !== null && loss >= 1 ? round(distanceForDamage(loss), 3) : null };
}
scenes.m5_perch_budget = async () => {
  await protect(true); holdReflexOff(); await park(false);
  await ask(`${END} kill @e[type=minecraft:end_crystal]`);
  await ask(`effect give ${ACTOR} minecraft:slow_falling 1200 0 true`);
  const out: Record<string, any> = { crystals: 0, trials: [] };
  // Straight ahead of the head (within the scanning phase's 10 degrees, so it does not turn), near enough for the click.
  const STAND = { x: 0.5, y: g, z: 10.5 };
  for (let trial = 0; trial < 4; trial++) {
    await ask(`${END} fill -9 ${g} -9 9 ${g + 12} 17 air replace red_bed`);
    await ask(`${END} fill -9 ${g} -9 9 ${g + 12} 17 air replace fire`);
    await ask(`${END} tp ${ACTOR} ${STAND.x} ${STAND.y} ${STAND.z}`);
    // Flaming (5): 200 ticks on the perch whatever the player does (scanning, 6, takes off after 100 ticks when it does not find the player: m5a did, 11/4).
    const fixesBefore = m456SyncFixes.length;
    await perch(200, 5);
    await sleep(1500); // the client holds the tp; the flight history settles (p back to 0)
    const perchTick = m456Tick;
    const phases: Array<[number, number | null]> = [];
    const phaseWatch = every(50, () => { const p = phaseNow(); if (!phases.length || phases.at(-1)![1] !== p) phases.push([m456Tick - perchTick, p]); });
    const d0 = dragonEntity();
    if (!d0) { out.trials.push({ trial, error: 'no dragon in sight' }); continue; }
    const head0 = m456Head(d0), feet0 = { x: (head0.minX + head0.maxX) / 2, y: head0.minY, z: (head0.minZ + head0.maxZ) / 2 };
    const pose = { syncFixes: m456SyncFixes.slice(fixesBefore).map(f => [f.rawYaw, round(f.yaw, 4)]), body: [round(d0.position.x, 3), round(d0.position.y, 3), round(d0.position.z, 3)], yaw: round(d0.yaw, 4), phase: phaseNow(), headFeet: [round(feet0.x, 3), round(feet0.y, 3), round(feet0.z, 3)] };
    const free = (c: P3) => m456Air(c) && m456Clear(d0, c) && !!m456BedFor(d0, c);
    // blast 1: ~2.35 m (the design's d >= 2.3 m, planned ~48); blast 2: the nearest free cell (planned ~63-66)
    const c1 = m5PillowCell(feet0, 2.35, { atLeast: 2.3, isFree: free });
    const c2 = m5PillowCell(feet0, 0, { isFree: free });
    if (!c1 || !c2) { out.trials.push({ trial, pose, error: 'no free cell' }); continue; }
    const plan = perchedBudget([c1.damage, c2.damage]);
    const b1 = await m456CommandBed(c1.cell, m456BedFor(d0, c1.cell)!, null, STAND);
    log(`M5 trial ${trial} blast 1: ${JSON.stringify(b1)}`);
    const t2 = (b1.detonationTick ?? m456Tick) + 10;
    const bed2 = m456BedFor(dragonEntity() ?? d0, c2.cell);
    const b2 = bed2 ? await m456CommandBed(c2.cell, bed2, t2, STAND) : null;
    log(`M5 trial ${trial} blast 2: ${JSON.stringify(b2)}`);
    // the takeoff: the head's path (client model, hy -1 / p 0 even in flight: an estimate) for 40 ticks, and one more bed at the head ~10 ticks on
    const path: Array<{ t: number; phase: number | null; head: number[]; v: number[] }> = [];
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    let extra: Record<string, unknown> | null = null;
    const tz = b2?.detonationTick ?? m456Tick;
    const takeoffWatch = (async () => {
      let prev: P3 | null = null;
      while (m456Tick <= tz + 40) {
        const d = dragonEntity();
        if (d) { const h = m456Head(d), f = { x: (h.minX + h.maxX) / 2, y: h.minY, z: (h.minZ + h.maxZ) / 2 };
          path.push({ t: m456Tick - tz, phase: phaseNow(), head: [r3(f.x), r3(f.y), r3(f.z)], v: prev ? [r3(f.x - prev.x), r3(f.y - prev.y), r3(f.z - prev.z)] : [0, 0, 0] }); prev = f; }
        await m456Ticks(1);
      }
    })();
    if (b2 && b2.detonationTick !== null) {
      await m456UntilTick(tz + 4);
      const d = dragonEntity();
      if (d) {
        // where the head will be at tz+11 (setblock lands ~tz+6..8, the use at tz+10, its explosion one tick later): the last 3 ticks' velocity carried on
        const recent = path.slice(-3), last = recent.at(-1);
        const v = recent.length >= 2 ? recent.reduce((s, p) => ({ x: s.x + p.v[0], y: s.y + p.v[1], z: s.z + p.v[2] }), { x: 0, y: 0, z: 0 }) : { x: 0, y: 0, z: 0 };
        const n = Math.max(1, recent.length), ahead = tz + 11 - m456Tick;
        const lastFeet = last ? { x: last.head[0], y: last.head[1], z: last.head[2] } : feet0;
        const predicted = { x: lastFeet.x + v.x / n * ahead, y: lastFeet.y + v.y / n * ahead, z: lastFeet.z + v.z / n * ahead };
        const c3 = m5PillowCell(predicted, 0, { isFree: c => m456Air(c) && m456Clear(d, c) && !!m456BedFor(d, c), span: 3 });
        if (c3) {
          // within reach of the click; slow falling holds it there
          const b3 = await m456CommandBed(c3.cell, m456BedFor(d, c3.cell)!, tz + 10, { x: c3.cell.x + 0.5, y: c3.cell.y - 1, z: c3.cell.z + 2.5 });
          extra = { predictedFeet: [round(predicted.x, 2), round(predicted.y, 2), round(predicted.z, 2)], ...b3, ticksAfterBlast2: b3.detonationTick === null ? null : b3.detonationTick - tz };
        } else extra = { predictedFeet: [round(predicted.x, 2), round(predicted.y, 2), round(predicted.z, 2)], error: 'no free cell near the predicted head' };
      }
    }
    await takeoffWatch;
    clearInterval(phaseWatch);
    const losses = [b1.loss, b2?.loss ?? null].filter((x): x is number => x !== null);
    const row = { trial, pose, planned: { d1: round(c1.distance, 3), D1: round(c1.damage, 2), d2: round(c2.distance, 3), D2: round(c2.damage, 2), budget: plan },
      blast1: b1, blast2: b2, perchedTotal: round(losses.reduce((a, b) => a + b, 0), 2), stayedAfter1: b1.phaseAfter === 5 || b1.phaseAfter === 6 || b1.phaseAfter === 7,
      tookOffAfter2: b2?.phaseAfter === 4, phases, gap12: b1.detonationTick !== null && b2?.detonationTick != null ? b2.detonationTick - b1.detonationTick : null,
      extra, extraLoss: (extra as any)?.loss ?? null, takeoffPath: path.filter((_, i) => i % 2 === 0) };
    out.trials.push(row);
    log(`M5 trial ${trial}: ${JSON.stringify({ ...row, takeoffPath: undefined })}`);
    await ask(`${END} data modify entity ${DRAGON} Health set value 200.0f`);
    await sleep(1500);
  }
  const ok = out.trials.filter((t: any) => t.blast1 && t.blast2);
  out.summary = { trials: out.trials.length, complete: ok.length, stayedAfter1: ok.filter((t: any) => t.stayedAfter1).length, tookOffAfter2: ok.filter((t: any) => t.tookOffAfter2).length,
    perchedTotals: ok.map((t: any) => t.perchedTotal), extraLosses: out.trials.map((t: any) => t.extraLoss) };
  releaseReflex();
  return out;
};

// ----- M6 -----
const m6 = (crystals: boolean) => async () => {
  await protect(true); holdReflexOff(); await park(false);
  if (!crystals) await ask(`${END} kill @e[type=minecraft:end_crystal]`);
  const RATE = Number(process.env.M6_TICK_RATE ?? 60), SAMPLES = Number(process.env.M6_SAMPLES ?? 30), WALL_MS = Number(process.env.M6_WALL_SECONDS ?? 1500) * 1000;
  const CAP_TICKS = 20 * 600, STAND = { x: 0.5, y: g, z: 2.5 };
  const rateAnswer = (await ask(`tick rate ${RATE}`)).replace(/\s+/gu, ' ').slice(0, 160);
  let age = Number((actor as any).time?.age ?? 0), ageWall = Date.now();
  const onTime = () => { age = Number((actor as any).time?.age ?? age); ageWall = Date.now(); };
  actor.on('time', onTime);
  const now = () => age; // 20-tick steps (update_time comes every 20 game ticks)
  const samples: Array<Record<string, unknown>> = [];
  const started = Date.now();
  let displaced = 0;
  try {
    while (samples.length < SAMPLES && Date.now() - started < WALL_MS) {
      await ask(`${END} tp ${ACTOR} ${STAND.x} ${STAND.y} ${STAND.z}`);
      await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 0`);
      await ask(`${END} tp ${DRAGON} 0 128 0`); await still();
      await ask(`${END} data modify entity ${DRAGON} Health set value 200.0f`);
      const crystalsAlive = (await ask(`${END} execute store result storage lab:m6 n int 1 if entity @e[type=minecraft:end_crystal]`), Number(float(await ask('data get storage lab:m6 n')) ?? NaN));
      const t0 = now(), w0 = Date.now();
      const firstAt: Record<number, number> = {};
      const seen: number[] = [];
      let last: number | null = null;
      while (true) {
        await sleep(100);
        const p = phaseNow();
        if (p !== null && p !== last) { seen.push(p); last = p; if (firstAt[p] === undefined) firstAt[p] = now() - t0; }
        const at = actor.entity.position;
        if (Math.hypot(at.x - STAND.x, at.z - STAND.z) > 1.5 || at.y < g - 3) { displaced++; void ask(`${END} tp ${ACTOR} ${STAND.x} ${STAND.y} ${STAND.z}`); await sleep(300); }
        const perched = [5, 6, 7].map(x => firstAt[x]).filter((x): x is number => x !== undefined);
        if (perched.length || now() - t0 > CAP_TICKS || Date.now() - started > WALL_MS) break;
        if (firstAt[3] !== undefined && now() - t0 - firstAt[3] > 20 * 40) break; // 40 s in the landing without a perch: count it, move on
      }
      const perch = [5, 6, 7].map(x => firstAt[x]).filter((x): x is number => x !== undefined);
      const row = { i: samples.length, crystalsAlive, toApproach: firstAt[2] !== undefined ? firstAt[2] / 20 : null, toLanding: firstAt[3] !== undefined ? firstAt[3] / 20 : null,
        toPerch: perch.length ? Math.min(...perch) / 20 : null, landingSeconds: firstAt[3] !== undefined && perch.length ? (Math.min(...perch) - firstAt[3]) / 20 : null,
        strafes: seen.filter(p => p === 1).length, charges: seen.filter(p => p === 8).length, phases: seen.join(','), wallSeconds: round((Date.now() - w0) / 1000, 1), gameSeconds: (now() - t0) / 20,
        censored: firstAt[3] === undefined };
      samples.push(row);
      log(`M6 ${crystals ? 'c10' : 'c0'} #${row.i}: ${JSON.stringify(row)}`);
    }
  } finally {
    actor.removeListener('time', onTime);
    await ask('tick rate 20');
  }
  const landed = samples.filter(s => !s.censored);
  return { crystals: crystals ? 10 : 0, rate: RATE, rateAnswer, stand: STAND, displaced, samples,
    toLanding: waitSummary(landed.map(s => Number(s.toLanding)), samples.length - landed.length),
    toApproach: waitSummary(samples.filter(s => s.toApproach !== null).map(s => Number(s.toApproach))),
    landingSeconds: waitSummary(samples.filter(s => s.landingSeconds !== null).map(s => Number(s.landingSeconds))),
    effectiveRate: samples.length ? round(samples.reduce((a, s) => a + Number(s.gameSeconds), 0) * 20 / samples.reduce((a, s) => a + Number(s.wallSeconds), 0), 1) : null };
};
scenes.m6_landing_c10 = m6(true);
scenes.m6_landing_c0 = m6(false);
// ===== end S7 M4-M6 =====
