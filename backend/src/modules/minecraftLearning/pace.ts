/**
 * How the run's time has gone, in numbers the planner can weigh: since the start, since the last advancement, and
 * what the actions of the last stretch spent their time on. Nothing here says what to do about it.
 *
 * Slow runs lost 11-22 minutes of an hour to waiting (nights sat out, batches smelted with the body standing by) and
 * nothing in front of the planner showed it: each wait was sensible on its own, and the sum was never seen (paid
 * runs L96, L98-L100, against 1.4 minutes in the run that reached the Nether fastest, L94).
 */
export interface PaceEntry { at: number; tool: string; ms: number; emergency: boolean }

const CATEGORY: Array<[string, RegExp]> = [
  ['待機', /^(wait-time|sleep-in-bed)$/],
  ['採掘', /^(mine-block|dig-block-at|stair-mine|strip-mine|mine-area)$/],
  ['移動', /^(move-to|explore|find-structure|tower-up|follow-entity)$/],
  ['精錬', /^(start-smelting|withdraw-from-furnace)$/],
  ['クラフト', /^craft-/],
  ['戦闘', /^(attack-continuously|attack-nearest|combat|shoot-bow)$/],
  ['避難', /^(dig-shelter|build-around-self|flee-from)$/],
  ['水', /^(leave-water|swim-to|find-dry-footholds)$/],
];
const category = (tool: string) => CATEGORY.find(([, pattern]) => pattern.test(tool))?.[0] ?? 'その他';
const minutes = (ms: number) => (ms / 60_000).toFixed(1);

export function describePace(entries: PaceEntry[], options: { now: number; startedAt: number; lastMilestone?: { name: string; at: number } | null; windowMs?: number }): string | null {
  const windowMs = options.windowMs ?? 15 * 60_000;
  const elapsed = options.now - options.startedAt;
  if (elapsed < 5 * 60_000) return null;
  const recent = entries.filter(entry => options.now - entry.at <= windowMs);
  const spent = new Map<string, number>();
  let emergency = 0;
  for (const entry of recent) {
    if (entry.emergency) { emergency += entry.ms; continue; }
    spent.set(category(entry.tool), (spent.get(category(entry.tool)) ?? 0) + entry.ms);
  }
  const parts = [...spent.entries()].filter(([, ms]) => ms >= 30_000).sort((a, b) => b[1] - a[1]).map(([name, ms]) => `${name} ${minutes(ms)}分`);
  if (emergency >= 30_000) parts.push(`緊急対応中 ${minutes(emergency)}分`);
  const since = options.lastMilestone
    ? `最後の実績「${options.lastMilestone.name}」から${Math.round((options.now - options.lastMilestone.at) / 60_000)}分`
    : 'まだ実績なし';
  return `## 進み具合（実測）: 開始から${Math.round(elapsed / 60_000)}分。${since}。`
    + `直近${Math.round(Math.min(windowMs, elapsed) / 60_000)}分の行動の時間: ${parts.length ? parts.join('・') : '目立つものなし'}（考える時間は含まない）`;
}
