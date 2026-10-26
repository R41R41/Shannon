/**
 * What each of the newer hands takes, as the head keeps it (services/api contracts/minecraftActHandRules.ts, the same fields and ranges):
 * `needs` are groups of which one field is required, `may` the optional ones; any other field is refused (the common ones, `do`, `rel`,
 * `note`, `onFail`, are always allowed). The act's schema is the widest of any hand; this is where a kind's own ranges are kept. A hand not
 * in the table (the older ones) has no check here: the schema and its own part answer for it.
 */
interface HandRule { needs: readonly (readonly string[])[]; may: readonly string[]; check(hand: Record<string, any>): string | null }

const BLOCK_NAME = /^[a-z][a-z0-9_]{0,39}$/u;
const COMMON = new Set(['do', 'rel', 'note', 'onFail']);
const seconds = (hand: Record<string, any>, least: number, most: number): string | null =>
  hand.seconds !== undefined && (hand.seconds < least || hand.seconds > most) ? `seconds は ${least}〜${most}` : null;
const count = (hand: Record<string, any>, most: number): string | null =>
  hand.count !== undefined && (!Number.isInteger(hand.count) || hand.count < 1 || hand.count > most) ? `count は 1〜${most} の整数` : null;
const names = (hand: Record<string, any>): string | null => ((hand.canDig ?? []) as string[]).some(name => !BLOCK_NAME.test(name))
  ? 'canDig はブロックの id（小文字の英字と _）か stone・dirt・sand・wood' : null;

export const HAND_RULES: Readonly<Record<string, HandRule>> = {
  mine: { needs: [['block'], ['at']], may: ['count', 'tool', 'collect', 'seconds', 'canDig', 'maxDig'],
    check: hand => seconds(hand, 5, 120) ?? count(hand, 64) ?? (hand.at.length > 4 ? 'at は鉱脈のマス 4 つまで（つながった同じ種類を体がたどる）' : null)
      ?? (BLOCK_NAME.test(hand.block) ? null : 'block はブロックの id（例 iron_ore）') ?? names(hand) },
  make: { needs: [['item']], may: ['count'], check: hand => count(hand, 64) },
  smelt: { needs: [['items']], may: ['fuel', 'fuelCount', 'furnaces', 'at', 'seconds'],
    check: hand => seconds(hand, 5, 60) ?? (hand.items.length < 1 || hand.items.length > 4 ? 'items は 1〜4 種類' : null)
      ?? (hand.items.some((entry: { count?: number }) => !Number.isInteger(entry.count) || (entry.count as number) < 1) ? 'items には 1 以上の整数の個数が要る' : null)
      ?? (hand.furnaces !== undefined && (!Number.isInteger(hand.furnaces) || hand.furnaces < 1 || hand.furnaces > 4) ? 'furnaces は 1〜4' : null)
      ?? (hand.at !== undefined && hand.at.length > 4 ? 'at は 4 つまで' : null) },
};

/** The fields a kind takes (needed, then optional, then the common ones), for a refusal that names them. */
export function handFieldNames(kind: string): string[] {
  const rule = HAND_RULES[kind];
  return rule ? [...rule.needs.flat(), ...rule.may, 'rel', 'note', 'onFail'] : [];
}

/** What is wrong with a hand of one of these kinds beyond the schema (a field the kind does not take, a missing one, a range), or null. */
export function handProblem(hand: { do: string } & Record<string, any>): string | null {
  const rule = HAND_RULES[hand.do];
  if (!rule) return null;
  const given = Object.keys(hand).filter(key => hand[key] !== undefined && hand[key] !== null);
  const allowed = new Set([...COMMON, ...rule.may, ...rule.needs.flat()]);
  const extra = given.filter(key => !allowed.has(key));
  if (extra.length) return `${extra.join('・')} は使えない（${hand.do} の欄: ${handFieldNames(hand.do).join('・')}）`;
  const missing = rule.needs.find(group => !group.some(key => hand[key] !== undefined && hand[key] !== null));
  if (missing) return `${missing.join(' か ')} が要る`;
  return rule.check(hand);
}
