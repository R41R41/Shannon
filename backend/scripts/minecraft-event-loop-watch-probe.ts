#!/usr/bin/env node
// Model-free and world-free: starts the body's event-loop watch (utils/eventLoopWatch) and stalls the main thread on purpose
// (a loop of calls for MINECRAFT_STALL_MS, default 4000), then sleeps. The lines to look for in the output:
//   "[EVENT_LOOP_STALL] ... where it is: busyForTheProbe@... <- ..."   (written by the worker thread while the main thread is stuck)
//   "event loop が N ms 止まっていました"                              (written by the main thread when it is free again)
// MINECRAFT_STALL_BLOCKING=write stalls in a synchronous write instead of JS (the sampler then answers after it returns).
import { startEventLoopWatch } from '../src/services/minebot/utils/eventLoopWatch.js';

const stallMs = Number(process.env.MINECRAFT_STALL_MS ?? 4000);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function twice(value: number) { return value * 2; }
function busyForTheProbe(ms: number) {
  const end = Date.now() + ms;
  let total = 0;
  while (Date.now() < end) total += twice(Math.sqrt(total + 1));
  return total;
}

startEventLoopWatch({ warnMs: 500, stallSampleMs: 1000, stallFile: process.env.MINECRAFT_STALL_FILE || null });
await sleep(1500);
console.log(`PROBE stalling for ${stallMs} ms`);
busyForTheProbe(stallMs);
await sleep(1500);
console.log('PROBE_DONE {}');
process.exit(0);
