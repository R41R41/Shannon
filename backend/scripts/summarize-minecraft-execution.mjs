#!/usr/bin/env node
// Read-only cohort summary. Root skill traces already include their children;
// never add child events again or label all waits as avoidable waste.
import fs from 'node:fs';
import path from 'node:path';

const summaryFiles = process.argv.slice(2);
if (!summaryFiles.length) throw new Error('Provide progressive *-summary.json paths');
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const cohorts = summaryFiles.map(file => {
  const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(summary.summary)) throw new Error('Not a progressive summary');
  const cells = summary.summary.map(cell => {
    const trials = Array.from({ length: cell.total }, (_, i) => JSON.parse(fs.readFileSync(
      path.join(path.dirname(file), `${summary.campaignId}-${cell.job}-${cell.tier}-${i + 1}.json`), 'utf8')));
    const signature = s => JSON.stringify({ name: s.name, args: s.args, expected: s.expected });
    const skills = [...new Set(trials.flatMap(t => t.steps.filter(s => s.result).map(signature)))];
    return { job: cell.job, tier: cell.tier, passed: cell.passed, total: cell.total,
      totalDurationMs: mean(trials.map(t => t.durationMs)),
      totalDurationRangeMs: [Math.min(...trials.map(t => t.durationMs)), Math.max(...trials.map(t => t.durationMs))],
      playerDeaths: trials.reduce((sum, t) => sum + t.playerDeaths, 0),
      skills: skills.map(key => {
        const calls = trials.flatMap(t => t.steps.filter(s => s.result && signature(s) === key));
        const traces = calls.filter(s => s.result.execution);
        const phases = [...new Set(traces.flatMap(s => Object.keys(s.result.execution.phaseMs)))];
        return { ...JSON.parse(key), calls: calls.length, durationMs: mean(calls.map(s => s.durationMs)),
          traceCount: traces.length,
          queueMs: mean(traces.map(s => s.result.execution.queueMs)),
          phaseMs: Object.fromEntries(phases.map(phase => [phase,
            mean(traces.map(s => s.result.execution.phaseMs[phase] ?? 0))])) };
      }) };
  });
  return { campaignId: summary.campaignId, sourceFingerprint: summary.sourceFingerprint,
    fingerprintVersion: summary.fingerprintVersion ?? 1, port: summary.port, seed: summary.seed, ok: summary.ok, cells };
});
let comparison = null;
if (cohorts.length > 1) {
  const [baseline, ...after] = cohorts;
  if (new Set(after.map(c => c.sourceFingerprint)).size !== 1
      || new Set(cohorts.map(c => c.seed)).size !== 1) throw new Error('Mixed post-fix source or world seeds');
  const cells = after.flatMap(c => c.cells);
  if (new Set(cells.map(c => `${c.job}:${c.tier}`)).size !== cells.length) throw new Error('Overlapping post-fix cells');
  comparison = baseline.cells.map(before => {
    const cell = cells.find(c => c.job === before.job && c.tier === before.tier);
    return { job: before.job, tier: before.tier, beforeTrials: before.total, afterTrials: cell?.total ?? 0,
      afterPassed: cell?.passed ?? 0, beforeDurationMs: before.totalDurationMs,
      afterDurationMs: cell?.totalDurationMs ?? null, afterRangeMs: cell?.totalDurationRangeMs ?? null,
      reductionPercent: cell && cell.passed === cell.total && before.passed === before.total
        ? (1 - cell.totalDurationMs / before.totalDurationMs) * 100 : null };
  });
}
process.stdout.write(`${JSON.stringify({ cohorts, comparison,
  caveat: 'Total duration includes connection, fixture setup and oracle checks. Phase means are per root skill call. Waits include normal game mechanics. Small samples are descriptive, not reliability estimates.' }, null, 2)}\n`);
