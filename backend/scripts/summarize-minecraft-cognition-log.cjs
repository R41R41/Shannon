#!/usr/bin/env node
'use strict';

const readline = require('node:readline');

const samples = [];
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', line => {
  const match = line.match(
    /MINECRAFT_COGNITION_METRIC kind=(critic|reflex) mode=(off|shadow|feedback) source=(jev|openai|fallback) latency_ms=(\d+) stale=(true|false)/,
  );
  if (!match) return;
  samples.push({
    kind: match[1],
    mode: match[2],
    source: match[3],
    latencyMs: Number.parseInt(match[4], 10),
    stale: match[5] === 'true',
  });
});

input.on('close', () => {
  const byKind = Object.fromEntries(['critic', 'reflex'].map(kind => {
    const selected = samples.filter(sample => sample.kind === kind);
    const latencies = selected.map(sample => sample.latencyMs).sort((a, b) => a - b);
    const jev = selected.filter(sample => sample.source === 'jev').length;
    const fallback = selected.filter(sample => sample.source === 'fallback').length;
    const stale = selected.filter(sample => sample.stale).length;
    return [kind, {
      samples: selected.length,
      jevSuccessRate: ratio(jev, selected.length),
      fallbackRate: ratio(fallback, selected.length),
      staleRate: ratio(stale, selected.length),
      p50LatencyMs: percentile(latencies, 0.50),
      p95LatencyMs: percentile(latencies, 0.95),
      sources: countBySource(selected),
    }];
  }));

  process.stdout.write(`${JSON.stringify({ totalSamples: samples.length, byKind }, null, 2)}\n`);
  if (samples.length === 0) process.exitCode = 2;
});

function percentile(sorted, probability) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)];
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function countBySource(selected) {
  return Object.fromEntries(['jev', 'openai', 'fallback'].map(source => [
    source,
    selected.filter(sample => sample.source === source).length,
  ]));
}
