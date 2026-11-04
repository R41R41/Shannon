#!/usr/bin/env node
// Read-only replay: no bot, service graph, env, network, or writes. Node + installed TypeScript.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Share the actual pure geometry, without importing the probe or building dist.
const modules = new Map();
function pureModule(name) {
  if (!['dragonLandingPath', 'dragonHeadVanilla', 'dragonParts', 'bedBurst', 'dragonBedGeometry'].includes(name)) throw new Error(`non-pure dependency: ${name}`);
  if (modules.has(name)) return modules.get(name);
  const filename = path.resolve(__dirname, '../../src/services/minebot/utils', `${name}.ts`);
  let source = fs.readFileSync(filename, 'utf8');
  // Evaluate only the pure damage formula, never geometry's service-reader imports.
  if (name === 'dragonBedGeometry') source = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true).statements
    .find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'bedDamage').getText();
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} }; modules.set(name, mod.exports);
  new Function('module', 'exports', 'require', output)(mod, mod.exports, dep => pureModule(path.basename(dep, '.js')));
  return mod.exports;
}
const { landingEndHead, landingEntryDirection, landingShotWindow, landingMiddleRing, landingEntryOrder,
  landingBurstDue, predictLandingPath, landingStandContacts } = pureModule('dragonLandingPath');
const { bedDamage } = pureModule('dragonBedGeometry');
const { bodyBoxAt } = pureModule('dragonParts');
const { bedBurstDue, LANDING_BLAST_GAP_TICKS } = pureModule('bedBurst');
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const centre = cell => ({ x: cell.x + .5, y: cell.y + .5, z: cell.z + .5 });
const cellOf = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** Head interpolation is an estimate, separately counted from actual packet ticks.
 * No endpoint padding, extrapolation, phase-2 sample, or gap over six ticks. */
function interpolateHeads(observations, start, end) {
  const unique = new Map();
  for (const p of observations) if (p.phase === 3 && p.tick >= start && p.tick < end) unique.set(p.tick, p);
  const obs = [...unique.values()].sort((a, b) => a.tick - b.tick), out = [];
  for (let i = 0; i < obs.length; i++) {
    const a = obs[i], b = obs[i + 1]; out.push({ tick: a.tick, head: a.head, packet: true });
    if (!b || b.tick - a.tick > 6) continue;
    for (let tick = a.tick + 1; tick < b.tick; tick++) {
      const f = (tick - a.tick) / (b.tick - a.tick);
      out.push({ tick, packet: false, head: Object.fromEntries(['x', 'y', 'z'].map(k => [k, a.head[k] + (b.head[k] - a.head[k]) * f])) });
    }
  }
  return out;
}
function countWindows(samples, pillow, radius, admitted) {
  const inside = samples.filter(p => distance(p.head, pillow) <= radius && (!admitted || admitted.has(p.tick)));
  const ticks = inside.map(p => p.tick), set = new Set(ticks), ranges = [];
  for (const tick of ticks) {
    if (ranges.at(-1)?.[1] === tick - 1) ranges.at(-1)[1] = tick;
    else ranges.push([tick, tick]);
  }
  // Search every start. A missed +10 slot ends the train; no bridging a gap.
  let train = [];
  for (const tick of ticks) {
    const candidate = [];
    for (let t = tick; set.has(t); t += 10) candidate.push(t);
    if (candidate.length > train.length) train = candidate;
  }
  return { ticks: ticks.length, packetTicks: inside.filter(p => p.packet).length, ranges, shots: train.length, train };
}

function replayLanding(landing, directionAt = 'entry') {
  const obs = landing.observations;
  const cutoff = directionAt === 'entry' ? landing.startTick : directionAt === 'prepared' ? landing.preparation.tick : landing.endTick;
  // Preparation corridor records a bearing, but not its raw body history. Reconstruct
  // that bearing ONLY for the explicit phase-2 sensitivity comparison.
  const prep = landing.preparation.corridor[0];
  const history = directionAt === 'prepared' ? [{ tick: prep.observedTick, phase: 2, position: prep.position, yaw: prep.yaw }]
    : obs.filter(p => p.tick <= cutoff).slice(-2);
  const end = landingEndHead(history, landing.target);
  if (!end) throw new Error(`no direction for landing ${landing.n}`);
  const samples = interpolateHeads(obs, landing.startTick, landing.endTick);
  // Use the existing central pillow, then fixed midpoint and terminal cells. Never
  // move the pillow during a train or optimize its position using future hits.
  const central = landing.candidates[0]?.head ?? landing.preparation.candidates[0].head;
  const a = centre(central), b = end.head;
  const candidates = [
    { kind: 'central', cell: central },
    ...[...new Map((landing.candidates ?? landing.preparation.candidates).map(c => [JSON.stringify(c.head), c.head])).values()]
      .filter(c => JSON.stringify(c) !== JSON.stringify(central)).map((cell, i) => ({ kind: `central_alt${i + 1}`, cell })),
    { kind: 'midpoint', cell: cellOf({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }) },
    { kind: 'terminal', cell: cellOf(b) },
  ];
  return candidates.flatMap(candidate => [2.07, 3.22].map(radius => {
    // Causal gate comparison: feed only observations already received at t. Report
    // separately from interpolated geometric availability; no retrospective forecasts.
    const admitted = new Set();
    for (const sample of samples) {
      const h = obs.filter(p => p.tick <= sample.tick);
      const window = landingShotWindow(h, landing.target, sample.tick, 3);
      if (window.length === 4 && window.every(p => distance(p.head, centre(candidate.cell)) + .5 <= radius)) admitted.add(sample.tick);
    }
    return { landing: landing.n, directionAt, directionTick: end.observedTick, directionSource: end.source,
      kind: candidate.kind, cell: candidate.cell, radius, ...countWindows(samples, centre(candidate.cell), radius),
      shortGate: countWindows(samples, centre(candidate.cell), radius, admitted) };
  }));
}
function replay(report, directionAt = 'entry') {
  const scene = report.scenes?.end_bed_crystals_p3;
  if (!scene?.landing?.length) throw new Error('missing scenes.end_bed_crystals_p3.landing');
  return scene.landing.flatMap(l => replayLanding(l, directionAt));
}
/** New policy, causal: entry fixes the pillow without reading future hits. Fire at
 * the FIRST admitted tick, then exactly +10; no retrospective choice of train. */
function replayMiddle(report, label = '') {
  const scene = report.scenes?.end_bed_crystals_p3;
  if (!scene?.landing?.length) throw new Error('missing scenes.end_bed_crystals_p3.landing');
  return scene.landing.map(l => {
    const history = l.observations.filter(p => p.tick <= l.startTick);
    const candidate = landingEntryOrder(landingMiddleRing(l.target).map(head => ({ head })), history, l.target)[0];
    if (!candidate) throw new Error(`no entry pillow for landing ${l.n}`);
    const pillow = centre(candidate.head), samples = interpolateHeads(l.observations, l.startTick, l.endTick);
    const admitted = [], train = [];
    for (let tick = l.startTick; tick < l.endTick; tick++) {
      const h = l.observations.filter(p => p.tick <= tick), window = landingShotWindow(h, l.target, tick, 3);
      if (window.length === 4 && window.every(p => distance(p.head, pillow) <= 3.22)) admitted.push(tick);
    }
    const set = new Set(admitted);
    if (admitted.length) for (let t = admitted[0]; set.has(t) && train.length < 5; t += 10) train.push(t);
    const geometric = countWindows(samples, pillow, 3.22);
    return { report: label, landing: l.n, startTick: l.startTick, endTick: l.endTick, cell: candidate.head,
      direction: landingEntryDirection(history, l.target), shots: train.length, train, admitted,
      geometric, conditional: 'phase2 ready; reach/exposure/supports/reflex/health/HP ACK assumed; no explosion impulse simulated' };
  });
}
function middleMarkdown(rows) {
  return ['| report | landing (phase 3) | pillow cell | first-tick +10 shots | ticks | geometric maximum |',
    '|---|---|---|---:|---|---:|', ...rows.map(r => `| ${r.report} | ${r.landing} (${r.startTick}–${r.endTick}) | ${r.cell.x},${r.cell.y},${r.cell.z} | ${r.shots} | ${r.train.join(',') || '-'} | ${r.geometric.shots} |`)].join('\n');
}

/** Greedy causal returns, anchored to the REAL first use/explosion. After it, keep
 * the recorded trajectory (including its lift) unchanged. Hypothetical explosions
 * cannot manufacture extra landing ticks or a new trajectory. No later-start search.
 * Terrain/exposure/ownership and environmental hazards were not recorded per tick;
 * E=1 is conditional, while known stand contact boxes are still enforced. */
function replayReturns(report, label = '') {
  const scene = report.scenes?.end_bed_crystals_p3;
  if (!scene?.landing?.length) throw new Error('missing scenes.end_bed_crystals_p3.landing');
  return scene.landing.map(l => {
    const first = l.shots?.find(s => s.detonationTick !== null && s.healthRecorded);
    if (!first) return { report: label, landing: l.n, shots: 0, train: [], reason: 'no_confirmed_first_blast_to_anchor_recorded_lift' };
    const pillow = centre(first.head), stand = first.positionAtUse ?? l.preparation.stand;
    const delay = first.detonationTick - first.useTick;
    const forecasts = new Map((l.predictions ?? []).map(p => [p.tick, p.points]));
    const at = tick => {
      const history = l.observations.filter(p => p.tick <= tick);
      // Prefer forecasts actually logged at this tick: observations[].velocity is
      // a derived value and cannot recover raw velocity-packet receipt ordering.
      if (l.predictions) {
        const observed = history.at(-1), path = forecasts.get(tick) ?? [];
        const next = path.find(p => p.tick === tick + 1);
        return { path: path.filter(p => p.tick <= tick + 3), hits: observed?.phase === 3 && tick - observed.tick <= 3 && next?.phase === 3 ? [observed, next] : [] };
      }
      return { path: predictLandingPath(history, l.target, tick, 3), hits: landingShotWindow(history, l.target, tick) };
    };
    const shot = (tick, hits, actual = false) => ({ tick, receiptTick: tick + delay, actual,
      distances: hits.map(p => distance(p.head, pillow)), damagesE1: hits.map(p => bedDamage(distance(p.head, pillow), 1)),
      damageE1: Math.min(...hits.map(p => bedDamage(distance(p.head, pillow), 1))) });
    const initial = at(first.useTick).hits;
    if (initial.length !== 2) throw new Error(`first-shot history missing: landing ${l.n}`);
    const train = [shot(first.useTick, initial, true)], targetTrain = [...train], admitted = [], blockedContacts = [];
    let previous = first.detonationTick, targetPrevious = previous, standStopTick = null;
    for (let tick = first.detonationTick + 1; tick < l.endTick; tick++) {
      const { path, hits } = at(tick);
      const contacts = landingStandContacts(path, bodyBoxAt(stand), .5).filter(c => c.blocking);
      if (contacts.length && standStopTick === null) standStopTick = tick;
      if (hits.length !== 2 || !hits.every(p => landingBurstDue({ phase: 3, now: tick, lastBlast: null,
        head: p.head, pillow, beds: 5, error: 0 }))) continue;
      const candidate = shot(tick, hits);
      if (candidate.damageE1 < 35) continue;
      if (bedBurstDue(tick, targetPrevious, LANDING_BLAST_GAP_TICKS) && targetTrain.length < 5 && candidate.receiptTick < l.endTick) {
        targetTrain.push(candidate); targetPrevious = candidate.receiptTick;
      }
      if (!bedBurstDue(tick, previous, LANDING_BLAST_GAP_TICKS)) continue;
      admitted.push(tick);
      if (!path.length || standStopTick !== null) { blockedContacts.push({ tick, standStopTick,
        parts: [...new Set(contacts.map(c => c.part))] }); continue; }
      if (train.length >= 5 || tick + delay >= l.endTick) continue;
      train.push(candidate); previous = candidate.receiptTick;
    }
    const last = train.at(-1).receiptTick;
    const heals = (l.healing ?? []).filter(h => h.tick > first.detonationTick && h.tick <= last).reduce((n, h) => n + h.amount, 0);
    const damageE1 = train.reduce((n, s) => n + s.damageE1, 0);
    const remainingHeals = (l.healing ?? []).filter(h => h.tick > first.detonationTick && h.tick < l.endTick).reduce((n, h) => n + h.amount, 0);
    return { report: label, landing: l.n, startTick: l.startTick, endTick: l.endTick, cell: first.head,
      shots: train.length, train, targetShots: targetTrain.length, targetTrain, standStopTick, admitted, blockedContacts, receiptDelayTicks: delay,
      minimumGapTicks: LANDING_BLAST_GAP_TICKS, damageE1, recordedHealing: heals, netE1: damageE1 - heals,
      netThroughLandingEndE1: damageE1 - remainingHeals, healingThroughLandingEnd: remainingHeals,
      actualFirstNetThroughLandingEnd: first.serverDragonLoss - remainingHeals,
      targetNetThroughLandingEndE1: targetTrain.reduce((n, s) => n + s.damageE1, 0) - remainingHeals,
      forecastSource: l.predictions ? 'recorded_forecasts_at_receipt_tick' : 'reconstructed_from_observations',
      firstActualLoss: first.serverDragonLoss,
      conditional: 'real first blast anchored; later damage at E=1; observed trajectory fixed; same receipt delay; terrain/fire/cloud/fireball/reflex/HP ACK availability assumed' };
  });
}

/** Reconstruct the OLD combined refusal without claiming unrecorded fire/cloud
 * state was clear. First and last receipt ticks are exact; count is callback calls,
 * not distinct ticks. Use only forecasts already available at that tick. */
function replayStandRefusals(report) {
  const scene = report.scenes.end_bed_crystals_p3;
  return scene.landing.filter(l => l.shots?.length).map(l => {
    const r = scene.refusals.find(r => r.reason === 'landing_not_prepared_or_stand_unsafe' && r.tick >= l.startTick && r.tick < l.endTick);
    if (!r) return { landing: l.n, reason: 'no_combined_refusal' };
    const stand = l.shots[0].positionAtUse ?? l.preparation.stand;
    const ticks = [], parts = {};
    for (let tick = r.tick; tick <= (r.lastTick ?? r.tick); tick++) {
      const recorded = l.predictions.find(p => p.tick === tick)?.points?.filter(p => p.tick <= tick + 3);
      const path = recorded ?? predictLandingPath(l.observations.filter(p => p.tick <= tick), l.target, tick, 3);
      const contacts = landingStandContacts(path, bodyBoxAt(stand), .5);
      const names = [...new Set(contacts.map(c => c.part))];
      names.forEach(name => { parts[name] = (parts[name] ?? 0) + 1; });
      ticks.push({ tick, predictionMissing: !path.length, parts: names });
    }
    return { landing: l.n, callbackRefusals: r.count, from: r.tick, to: r.lastTick, stand,
      contactTicks: parts, ticksWithoutContact: ticks.filter(t => !t.parts.length).length,
      missingPredictionTicks: ticks.filter(t => t.predictionMissing).length,
      ticks, environment: 'unrecorded: fire/unloaded/cloud/fireball and per-tick actor position; contact reconstruction is not exclusive attribution' };
  });
}
function returnsMarkdown(rows) {
  return ['| landing | target / safety-admitted shots | target use ticks | target d observed / +1 (m), D E=1 (lower of both) | healing to last / end | safe net to last / end |',
    '|---|---:|---|---|---:|---:|', ...rows.map(r => `| ${r.landing} | ${r.targetShots ?? '-'} / ${r.shots} | ${(r.targetTrain ?? []).map(s => s.tick).join(',') || '-'} | ${(r.targetTrain ?? []).map(s => `${s.distances.map(d => d.toFixed(2)).join('/')} → ${s.damageE1.toFixed(2)}`).join('; ') || r.reason} | ${r.recordedHealing ?? '-'} / ${r.healingThroughLandingEnd ?? '-'} | ${r.netE1?.toFixed(2) ?? '-'} / ${r.netThroughLandingEndE1?.toFixed(2) ?? '-'} |`)].join('\n');
}
function markdown(rows) {
  return ['| landing | direction | pillow cell | radius | ticks (packet) | +10 shots | train ticks | ranges | near gate ticks / shots |',
    '|---|---|---|---:|---:|---:|---|---|---|',
    ...rows.map(r => `| ${r.landing} | ${r.directionAt}:${r.kind} | ${r.cell.x},${r.cell.y},${r.cell.z} | ${r.radius} | ${r.ticks} (${r.packetTicks}) | ${r.shots} | ${r.train.join(',') || '-'} | ${r.ranges.map(([a,b]) => a === b ? a : `${a}-${b}`).join(',') || '-'} | ${r.shortGate.ticks} / ${r.shortGate.shots} |`)].join('\n');
}
module.exports = { interpolateHeads, countWindows, replayLanding, replay, markdown, replayMiddle, middleMarkdown,
  replayReturns, replayStandRefusals, returnsMarkdown };
if (require.main === module) {
  const args = process.argv.slice(2), file = args.find(a => !a.startsWith('--'))
    ?? path.resolve(__dirname, '../../../lab-evidence/r245-report.json');
  const mode = args.includes('--prepared') ? 'prepared' : args.includes('--terminal-direction') ? 'terminal' : 'entry';
  if (args.includes('--returns') || args.includes('--stand-refusals')) {
    const report = JSON.parse(fs.readFileSync(args.find(a => !a.startsWith('--'))
      ?? path.resolve(__dirname, '../../../lab-evidence/r253-report.json'), 'utf8'));
    const rows = args.includes('--stand-refusals') ? replayStandRefusals(report) : replayReturns(report);
    console.log(args.includes('--json') || args.includes('--stand-refusals') ? JSON.stringify(rows, null, 2)
      : 'Conditional fixed recorded trajectory; damage assumes E=1; no hypothetical extra lift.\n' + returnsMarkdown(rows));
    return;
  }
  if (args.includes('--middle')) {
    const files = args.filter(a => !a.startsWith('--'));
    const rows = (files.length ? files : [file]).flatMap(f => replayMiddle(JSON.parse(fs.readFileSync(f, 'utf8')), path.basename(f)));
    console.log(args.includes('--json') ? JSON.stringify(rows, null, 2)
      : 'Conditional observation/forecast opportunities; terrain, body ownership and explosion effects are unavailable.\n' + middleMarkdown(rows));
    return;
  }
  const rows = replay(JSON.parse(fs.readFileSync(file, 'utf8')), mode);
  if (args.includes('--json')) console.log(JSON.stringify({ directionAt: mode, rows }, null, 2));
  else {
    console.log('Geometric opportunities only. Interpolation <=6 ticks; no phase-6/7 padding, exposure/reach/build/reflex permission or explosion effects.');
    console.log('entry = frozen phase-3 entry bearing (too late to build); prepared = actual preparation bearing; terminal = hindsight sensitivity, never an executable placement rule.');
    console.log('near gate = observed head AND +1..3 forecasts, including existing 0.5 m margin. No 20-tick authorization.');
    console.log(markdown(rows));
  }
}
