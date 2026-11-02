#!/usr/bin/env node
// usage: node split-end-observation.mjs <report.json> [<fixtures dir>]
//
// The End probe's `enter` (arrival) and `observe` scenes keep, for each situation, the End fields of the observation the body gave and everything it read to give them
// (scripts/minecraft-end-fight-probe.ts, captureEnd). This splits them into the two files the tests read, in backend/tests/fixtures/end/ unless a directory is given:
//   observation.expected.json  what the head reads: { situations: [{ label, note, expected }] }  (the fields under state.world: dragon, crystals, perch, dragonBreath, dragonFireballs)
//   observation.inputs.json    what the replay test builds a body from: { situations: [{ label, input }] }
import fs from 'node:fs';
import path from 'node:path';

const [reportPath, outDirArg] = process.argv.slice(2);
if (!reportPath) { console.error('usage: split-end-observation.mjs <report.json> [<fixtures dir>]'); process.exit(2); }
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const captures = [report.scenes?.enter?.arrival, ...(report.scenes?.observe?.captures ?? [])].filter(Boolean);
if (!captures.length) { console.error('the report has no captures (run the scenes enter and observe)'); process.exit(1); }
const disagree = captures.filter(capture => capture.agreesWithBlockAtReader === false).map(capture => capture.label);
if (disagree.length) { console.error(`the column reader and the blockAt reader disagreed in: ${disagree.join(', ')}`); process.exit(1); }
const outDir = outDirArg ?? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'tests', 'fixtures', 'end');
fs.mkdirSync(outDir, { recursive: true });
const about = 'The End fields of the observation (state.world: dragon, crystals, perch, dragonBreath, dragonFireballs) as the isolated lab made them with the body\'s own code. Regenerate: run the probe scenes enter,observe (backend/scripts/lab/run-end-fight.sh), then split-end-observation.mjs on its report.json.';
fs.writeFileSync(path.join(outDir, 'observation.expected.json'), `${JSON.stringify({ about, startedAt: report.startedAt, situations: captures.map(({ label, note, capturedAt, expected }) => ({ label, note, capturedAt, expected })) }, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'observation.inputs.json'), `${JSON.stringify({ about, situations: captures.map(({ label, input }) => ({ label, input })) })}\n`);
console.log(`wrote ${captures.length} situations to ${outDir}: ${captures.map(capture => capture.label).join(', ')}`);
