#!/usr/bin/env node
// Read-only replay: no bot, service graph, env, network, or writes. Node + installed TypeScript.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Share the actual pure geometry, without importing the probe or building dist.
const modules = new Map();
function pureModule(name) {
  if (!['dragonLandingPath', 'dragonHeadVanilla', 'dragonParts'].includes(name)) throw new Error(`non-pure dependency: ${name}`);
  if (modules.has(name)) return modules.get(name);
  const filename = path.resolve(__dirname, '../../src/services/minebot/utils', `${name}.ts`);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} }; modules.set(name, mod.exports);
  new Function('module', 'exports', 'require', output)(mod, mod.exports, dep => pureModule(path.basename(dep, '.js')));
  return mod.exports;
}
const { landingEndHead, landingShotWindow } = pureModule('dragonLandingPath');
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
      const window = landingShotWindow(h, landing.target, sample.tick);
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
function markdown(rows) {
  return ['| landing | direction | pillow cell | radius | ticks (packet) | +10 shots | train ticks | ranges | near gate ticks / shots |',
    '|---|---|---|---:|---:|---:|---|---|---|',
    ...rows.map(r => `| ${r.landing} | ${r.directionAt}:${r.kind} | ${r.cell.x},${r.cell.y},${r.cell.z} | ${r.radius} | ${r.ticks} (${r.packetTicks}) | ${r.shots} | ${r.train.join(',') || '-'} | ${r.ranges.map(([a,b]) => a === b ? a : `${a}-${b}`).join(',') || '-'} | ${r.shortGate.ticks} / ${r.shortGate.shots} |`)].join('\n');
}
module.exports = { interpolateHeads, countWindows, replayLanding, replay, markdown };
if (require.main === module) {
  const args = process.argv.slice(2), file = args.find(a => !a.startsWith('--'))
    ?? path.resolve(__dirname, '../../../lab-evidence/r245-report.json');
  const mode = args.includes('--prepared') ? 'prepared' : args.includes('--terminal-direction') ? 'terminal' : 'entry';
  const rows = replay(JSON.parse(fs.readFileSync(file, 'utf8')), mode);
  if (args.includes('--json')) console.log(JSON.stringify({ directionAt: mode, rows }, null, 2));
  else {
    console.log('Geometric opportunities only. Interpolation <=6 ticks; no phase-6/7 padding, exposure/reach/build/reflex permission or explosion effects.');
    console.log('entry = frozen phase-3 entry bearing (too late to build); prepared = actual preparation bearing; terminal = hindsight sensitivity, never an executable placement rule.');
    console.log('near gate = observed head AND +1..3 forecasts, including existing 0.5 m margin. No 20-tick authorization.');
    console.log(markdown(rows));
  }
}
