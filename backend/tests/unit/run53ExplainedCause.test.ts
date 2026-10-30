import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { heavyReason } from '../../src/services/minebot/utils/incidents.js';
const captured = JSON.parse(fs.readFileSync(new URL('../fixtures/run53-different-dead-ends.json', import.meta.url), 'utf8'));
const water = captured[0], permission = captured[1];
const check = (entry: typeof water, seen: Set<string>, hp = 20, died = false) => heavyReason(entry.report, entry.ms, hp, died, seen, 'run53');
describe('run53 hold2: different explained causes at one goal cell', () => {
  it('returns each recorded new cause once, after the water restriction was fixed but a digging permission was missing', () => {
    const seen = new Set<string>();
    expect(check(water, seen)).toBeNull();
    expect(check(permission, seen)).toBeNull();
    expect(check(permission, seen)).toBe('explained:go/dead_end');
    expect(check(water, seen)).toBe('explained:go/dead_end');
  });
  it('does not avoid the repeat guard by alternating the causes or rewriting unrelated words', () => {
    const seen = new Set<string>(); check(water, seen); check(permission, seen);
    const changed = structuredClone(permission); changed.report.lines[0].line += ' context changed';
    expect(check(changed, seen)).toBe('explained:go/dead_end');
    expect(check(water, seen)).toBe('explained:go/dead_end');
  });
  it('keeps low health and death ahead of a newly explained cause', () => {
    expect(check(permission, new Set(), 3.5)).toBe('near_death:3.5');
    expect(check(water, new Set(), 20, true)).toBe('death');
  });
});
