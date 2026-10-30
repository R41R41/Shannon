import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { heavyReason, holdsFor } from '../../src/services/minebot/utils/incidents.js';
import type { ActReport } from '../../src/services/minebot/utils/actReport.js';
const captured = JSON.parse(fs.readFileSync(new URL('../fixtures/run53-wait-then-missing.json', import.meta.url), 'utf8'));
const reason = (report = structuredClone(captured.report), ms = captured.ms, hp = 17, died = false) => heavyReason(report, ms, hp, died, new Set(), 'run53');
describe('run53: completed explicit waits are not stalled work', () => {
  it('returns the recorded immediate missing ingredient after 70 confirmed wait seconds, preserving its partial results', () => {
    const report = structuredClone(captured.report), before = JSON.stringify(report);
    expect(reason(report)).toBe('first:make/missing');
    expect(holdsFor(reason(report))).toBe(false);
    expect(JSON.stringify(report)).toBe(before);
  });
  it('still holds real idle work lasting 61 seconds after the completed 70-second wait', () => {
    expect(reason(undefined, 131_152)).toBe('long:61s');
  });
  it.each(['stopped', 'skipped'])('does not deduct %s waits, even if a duration was reported', status => {
    const report = structuredClone(captured.report);
    for (const line of report.lines) if (line.do === 'wait') line.status = status;
    expect(reason(report)).toBe('long:73s');
  });
  it('keeps cancellation with no confirmed wait, unknown progress and impossible reported wait durations conservative', () => {
    for (const variant of ['cut', 'unknown', 'impossible']) {
      const report = structuredClone(captured.report);
      for (const line of report.lines) if (line.do === 'wait') {
        if (variant === 'cut') { line.end = 'cut'; line.goal = 'partial'; }
        if (variant === 'unknown') delete line.progress;
        if (variant === 'impossible') line.progress.done = 9999;
      }
      expect(reason(report), variant).toBe('long:73s');
    }
  });
  it('keeps death, low health and a stuck go ahead of any completed wait', () => {
    expect(reason(undefined, captured.ms, 3.5)).toBe('near_death:3.5');
    expect(reason(undefined, captured.ms, 17, true)).toBe('death');
    const report = structuredClone(captured.report) as ActReport;
    report.lines.push({ i: 11, do: 'go', status: 'stopped', line: 'go 止まった stuck: 道 0 歩', goal: 'not_started', end: 'finished' });
    expect(reason(report)).toBe('go_stuck');
  });
});
