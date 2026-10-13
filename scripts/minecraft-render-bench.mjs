// Render benchmark for the Minecraft first-person capture (ADR-0010 D3/D8, ADR-0011 §6). Same steps as
// backend/src/services/minebot/integration/commonFca/imageCapture.ts: meshing in the viewer's worker threads,
// render + JPEG on the main thread. Measures capture time, event-loop blocking and the bot's physics tick gaps.
// Usage: xvfb-run -a node render-bench.mjs <labNodeModules> <rendererDir> <port> <width> <height> <frames> <out.json>
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';

const [modulesDir, rendererDir, portText, widthText, heightText, framesText, outFile] = process.argv.slice(2);
const req = createRequire(path.join(modulesDir, 'package.json'));
const mineflayer = req('mineflayer');
const rendererRequire = createRequire(path.join(rendererDir, 'package.json'));
const width = Number(widthText), height = Number(heightText), frames = Number(framesText);
const pct = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const bot = mineflayer.createBot({ host: '127.0.0.1', port: Number(portText), username: 'ShannonRender', auth: 'offline', version: process.env.MC_VERSION ?? '1.21.11', checkTimeoutInterval: 120_000 });
await new Promise((resolve, reject) => { bot.once('spawn', resolve); bot.once('error', reject); bot.once('kicked', reason => reject(Error(`kicked ${JSON.stringify(reason)}`))); });
await bot.waitForChunksToLoad?.().catch(() => undefined);
await sleep(3000);

const ticks = []; let lastTick = performance.now();
bot.on('physicsTick', () => { const now = performance.now(); ticks.push(now - lastTick); lastTick = now; });

// Baseline: no renderer.
const idleDelay = monitorEventLoopDelay({ resolution: 10 }); idleDelay.enable();
ticks.length = 0; await sleep(5000); idleDelay.disable();
const idleTicks = [...ticks];

const { supportedVersions } = rendererRequire('./viewer/lib/version.js');
if (!supportedVersions.includes(bot.version)) throw Error(`EXACT_VERSION_ASSETS_REQUIRED ${bot.version}`);
const THREE = rendererRequire('three');
globalThis.THREE = THREE; globalThis.Worker = Worker;
const { createCanvas } = rendererRequire('node-canvas-webgl/lib');
const { Viewer, WorldView } = rendererRequire('./viewer/index.js');
const initStarted = performance.now();
const canvas = createCanvas(width, height);
const renderer = new THREE.WebGLRenderer({ canvas });
const viewer = new Viewer(renderer);
viewer.setVersion(bot.version);
const world = new WorldView(bot.world, 3, bot.entity.position);
viewer.listen(world); world.listenToBot(bot);
await world.init(bot.entity.position);
bot.on('move', () => { void world.updatePosition(bot.entity.position); });

async function capture() {
  const started = performance.now();
  await world.updatePosition(bot.entity.position);
  const deadline = Date.now() + 4000;
  while (viewer.world.sectionsOutstanding.size || !viewer.world.material.map) {
    if (Date.now() >= deadline) return { error: 'GEOMETRY_PENDING', ms: performance.now() - started };
    await sleep(10);
  }
  const geometryReady = performance.now();
  viewer.camera.position.set(bot.entity.position.x, bot.entity.position.y + (bot.entity.height ?? 1.8) * 0.9, bot.entity.position.z);
  viewer.camera.rotation.set(bot.entity.pitch, bot.entity.yaw, 0, 'ZYX');
  const renderStarted = performance.now();
  viewer.update(); renderer.render(viewer.scene, viewer.camera);
  const rendered = performance.now();
  const bytes = canvas.toBuffer('image/jpeg', { quality: 0.65, progressive: false });
  const encoded = performance.now();
  return { ms: encoded - started, waitGeometryMs: geometryReady - started, renderMs: rendered - renderStarted, jpegMs: encoded - rendered, bytes: bytes.length, last: bytes };
}

const first = await capture();
const initMs = performance.now() - initStarted;

// Captures every 250 ms while the body turns in place (new view each time, little new geometry).
const turnDelay = monitorEventLoopDelay({ resolution: 10 }); turnDelay.enable();
ticks.length = 0;
const turning = [];
for (let i = 0; i < frames; i++) {
  await bot.look(bot.entity.yaw + Math.PI / 6, -0.15, true);
  turning.push(await capture());
  await sleep(250);
}
turnDelay.disable();
const turnTicks = [...ticks];

// Captures while the body walks forward (new chunks may stream in and be meshed).
const walkDelay = monitorEventLoopDelay({ resolution: 10 }); walkDelay.enable();
ticks.length = 0;
const walking = [];
bot.setControlState('forward', true); bot.setControlState('sprint', true); bot.setControlState('jump', true);
for (let i = 0; i < frames; i++) { walking.push(await capture()); await sleep(250); }
bot.clearControlStates();
walkDelay.disable();
const walkTicks = [...ticks];

const summary = (rows) => { const ok = rows.filter(row => !row.error); return {
  n: rows.length, errors: rows.length - ok.length,
  captureMs: { p50: pct(ok.map(r => r.ms), 0.5), p95: pct(ok.map(r => r.ms), 0.95), max: pct(ok.map(r => r.ms), 1) },
  renderMs: { p50: pct(ok.map(r => r.renderMs), 0.5), p95: pct(ok.map(r => r.renderMs), 0.95) },
  jpegMs: { p50: pct(ok.map(r => r.jpegMs), 0.5), p95: pct(ok.map(r => r.jpegMs), 0.95) },
  waitGeometryMs: { p50: pct(ok.map(r => r.waitGeometryMs), 0.5), p95: pct(ok.map(r => r.waitGeometryMs), 0.95) },
  jpegKiB: { p50: pct(ok.map(r => r.bytes / 1024), 0.5), max: pct(ok.map(r => r.bytes / 1024), 1) } }; };
const loop = h => ({ p50: Math.round(h.percentile(50) / 1e5) / 10, p99: Math.round(h.percentile(99) / 1e5) / 10, max: Math.round(h.max / 1e5) / 10 });
const tickGaps = values => ({ n: values.length, p50: pct(values, 0.5), p95: pct(values, 0.95), max: pct(values, 1) });
const report = {
  version: bot.version, width, height, frames, initMs: Math.round(initMs), firstCaptureMs: Math.round(first.ms ?? -1),
  idle: { eventLoopMs: loop(idleDelay), physicsTickGapMs: tickGaps(idleTicks) },
  turning: { ...summary(turning), eventLoopMs: loop(turnDelay), physicsTickGapMs: tickGaps(turnTicks) },
  walking: { ...summary(walking), eventLoopMs: loop(walkDelay), physicsTickGapMs: tickGaps(walkTicks) },
  cpus: (await import('node:os')).cpus().length, node: process.version,
};
fs.writeFileSync(outFile, JSON.stringify(report, null, 1));
turning.forEach((row, i) => { if (row.last && i % 3 === 0) fs.writeFileSync(outFile.replace(/\.json$/, `-turn${i}.jpg`), row.last); });
const sample = [...walking].reverse().find(row => row.last);
if (sample) fs.writeFileSync(outFile.replace(/\.json$/, '-walk.jpg'), sample.last);
console.log(JSON.stringify(report));
bot.quit(); setTimeout(() => process.exit(0), 1500).unref();
