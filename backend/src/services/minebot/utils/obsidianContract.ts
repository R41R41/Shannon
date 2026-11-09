/** Pure public obsidian bounds shared by its primitive, act deadline and queue envelope. */
export const OBSIDIAN_DEFAULTS = { seconds: 90, maxPlace: 6 } as const;
export const OBSIDIAN_LIMITS = { sources: 24, seconds: 300 } as const;
/** Allow an in-flight dig (9.4 s), its drop and the bucket to finish after the hand's own deadline. */
export const OBSIDIAN_RECOVERY_MS = 20_000;
export const OBSIDIAN_ACT_MAX_MS = OBSIDIAN_LIMITS.seconds * 1000 + OBSIDIAN_RECOVERY_MS;

const COMMON_FIELDS = ['do', 'rel', 'note', 'onFail'];
const BLOCK_NAME = /^[a-z][a-z0-9_]{0,39}$/u;
/**
 * What is wrong with an obsidian hand beyond the schema, in the head's own ranges (minecraftActHandRules.ts: needs `at`; may `count`, `seconds`,
 * `canPlace`, `maxPlace`; `at` 1 to 24, `seconds` 5 to 300, `count` 1 to 64, defaulting to the distinct named cells): a field the kind does not take, a missing `at`, a range. Null when it is well formed.
 */
export function obsidianProblem(hand: Record<string, unknown>, cellOk: (spec: unknown) => boolean): string | null {
  const allowed = new Set([...COMMON_FIELDS, 'at', 'count', 'seconds', 'canPlace', 'maxPlace', 'canDig', 'maxDig']);
  const extra = Object.keys(hand).filter(key => hand[key] !== undefined && !allowed.has(key));
  if (extra.length) return `${extra.join('・')} は使えない（obsidian の欄: at・count・seconds・canPlace・maxPlace）`;
  const at = hand.at;
  if (!Array.isArray(at) || !at.length) return 'at（溶岩の源のマス）が要る';
  if (at.length > OBSIDIAN_LIMITS.sources) return 'at は溶岩の源のマス 24 つまで';
  if (!at.every(cellOk)) return 'at のマスが読めない';
  const maxDig = hand.maxDig as number | undefined;
  if (maxDig !== undefined && (!Number.isInteger(maxDig) || maxDig < 1 || maxDig > 100)) return 'maxDig は 1〜100 の整数';
  const seconds = hand.seconds as number | undefined, count = hand.count as number | undefined;
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 5 || seconds > OBSIDIAN_LIMITS.seconds)) return 'seconds は 5〜300';
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 64)) return 'count は 1〜64 の整数';
  if (Array.isArray(hand.canPlace) && (hand.canPlace as string[]).some(name => !BLOCK_NAME.test(name))) return 'canPlace はブロックの id（小文字の英字と _）';
  return null;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const POSITION_FIELDS = new Set(['x', 'y', 'z', 'front', 'right', 'up']);
const cellShape = (value: unknown): boolean => object(value) && Object.entries(value).every(([key, field]) =>
  POSITION_FIELDS.has(key) && (field === undefined || typeof field === 'number' && Number.isFinite(field)));
const namesShape = (value: unknown, max: number): boolean => value === undefined || Array.isArray(value) && value.length >= 1 && value.length <= max
  && value.every(name => typeof name === 'string' && name.length <= 40);

/** Only a well-formed obsidian hand grants its existing seconds+recovery exception. Never sum hands or multiply repeat. */
export function actQueueMilliseconds(input: unknown): number {
  const hands = object(input) && Array.isArray(input.hands) ? input.hands : [];
  const limits = hands.filter((hand): hand is Record<string, unknown> => object(hand) && hand.do === 'obsidian'
    && namesShape(hand.canPlace, 6) && namesShape(hand.canDig, 12)
    && (hand.maxPlace === undefined || typeof hand.maxPlace === 'number' && Number.isInteger(hand.maxPlace) && hand.maxPlace >= 0 && hand.maxPlace <= 100)
    && (hand.rel === undefined || typeof hand.rel === 'boolean')
    && (hand.note === undefined || typeof hand.note === 'string')
    && (hand.onFail === undefined || hand.onFail === 'continue' || hand.onFail === 'stop')
    && obsidianProblem(hand, cellShape) === null)
    .map(hand => ((hand.seconds as number | undefined) ?? OBSIDIAN_DEFAULTS.seconds) * 1000 + OBSIDIAN_RECOVERY_MS);
  return limits.reduce((maximum, limit) => Math.max(maximum, limit), 180_000);
}
