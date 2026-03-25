/**
 * 夜間バッチの時刻判定のみ（副作用なし・ユニットテスト対象）。
 */

export function utcCalendarDateUtc(d: Date): string {
    return d.toISOString().slice(0, 10);
}

/** 当日 UTC の「実行開始時刻」からの経過分。開始前は負。 */
export function minutesSinceNightlyStartUtc(now: Date, hourUtc: number, minuteUtc: number): number {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, minuteUtc, 0, 0);
    return (now.getTime() - start) / 60_000;
}

export function isNightlyFireTimeUtc(
    now: Date,
    hourUtc: number,
    minuteUtc: number,
    windowMinutes: number,
): boolean {
    const elapsed = minutesSinceNightlyStartUtc(now, hourUtc, minuteUtc);
    return elapsed >= 0 && elapsed < windowMinutes;
}
