import { describe, expect, it } from 'vitest';
import {
    isNightlyFireTimeUtc,
    minutesSinceNightlyStartUtc,
    utcCalendarDateUtc,
} from '../../src/services/llm/graph/cognitive/selfImprove/nightlySchedule.js';

describe('nightlySchedule', () => {
    it('minutesSinceNightlyStartUtc: 開始直後は 0 に近い', () => {
        const now = new Date(Date.UTC(2026, 2, 21, 3, 2, 30));
        const m = minutesSinceNightlyStartUtc(now, 3, 0);
        expect(m).toBeCloseTo(2.5, 5);
    });

    it('minutesSinceNightlyStartUtc: 開始前は負', () => {
        const now = new Date(Date.UTC(2026, 2, 21, 2, 59, 0));
        expect(minutesSinceNightlyStartUtc(now, 3, 0)).toBeLessThan(0);
    });

    it('isNightlyFireTimeUtc: ウィンドウ内のみ true', () => {
        const t0 = new Date(Date.UTC(2026, 2, 21, 3, 0, 0));
        expect(isNightlyFireTimeUtc(t0, 3, 0, 15)).toBe(true);
        const t1 = new Date(Date.UTC(2026, 2, 21, 3, 14, 59));
        expect(isNightlyFireTimeUtc(t1, 3, 0, 15)).toBe(true);
        const t2 = new Date(Date.UTC(2026, 2, 21, 3, 15, 0));
        expect(isNightlyFireTimeUtc(t2, 3, 0, 15)).toBe(false);
    });

    it('utcCalendarDateUtc', () => {
        expect(utcCalendarDateUtc(new Date(Date.UTC(2026, 2, 21, 15, 0, 0)))).toBe('2026-03-21');
    });
});
