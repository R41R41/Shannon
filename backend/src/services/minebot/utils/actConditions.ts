import { Vec3 } from 'vec3';
import { z } from 'zod';
import { backgroundJobs } from '../execution/backgroundJobs.js';
import { isThreat } from './floorReflexes.js';
import { itemFoodPoints } from './foodPoints.js';
import { freeSlots } from './primitives/common.js';
import { threatExposure } from './threatExposure.js';

/**
 * The conditions of the task queue (the head's contract: wire note `tq/contract.md` section 1): what an act's `done` and a queue item's `pre` say,
 * as JSON (the head parses its text; the body never reads text). They are checked against the body as it is now and answer yes or no; nothing here
 * chooses a block, a place or an action for the planner. Alternatives (OR) of conjunctions (AND).
 */
const DIM = z.enum(['overworld', 'the_nether', 'the_end']);
const num = z.number().finite();
/** An item or block id (no `pattern` in the schema: the wire JSON schema does not carry one). */
const ID = z.string().min(1).max(64).refine(value => /^[a-z][a-z0-9_]*$/u.test(value));
const COUNT = z.number().int().min(0).max(100_000);
const CLAUSE = z.discriminatedUnion('k', [
  z.object({ k: z.enum(['have']), item: ID, n: COUNT, op: z.enum(['>=', '<']).optional() }).strict(),
  z.object({ k: z.enum(['food']), n: COUNT }).strict(),
  z.object({ k: z.enum(['hunger']), n: z.number().min(0).max(20) }).strict(),
  z.object({ k: z.enum(['hp']), n: z.number().min(0).max(20) }).strict(),
  z.object({ k: z.enum(['dim']), dim: DIM }).strict(),
  z.object({ k: z.enum(['at']), x: num, y: num, z: num, r: z.number().min(0).max(1000), dim: DIM.optional() }).strict(),
  z.object({ k: z.enum(['near']), block: ID, r: z.number().min(1).max(8) }).strict(),
  z.object({ k: z.enum(['free']), n: z.number().int().min(0).max(36) }).strict(),
  z.object({ k: z.enum(['time']), t: z.enum(['day', 'night']) }).strict(),
  z.object({ k: z.enum(['furnace']), x: num, y: num, z: num }).strict(),
  z.object({ k: z.enum(['safe']), r: z.number().min(1).max(64) }).strict(),
]);
export const ACT_CONDITION = z.array(z.array(CLAUSE).min(1).max(6)).min(1).max(4);
export type ActCondition = z.infer<typeof ACT_CONDITION>;
type Clause = ActCondition[number][number];

/** The condition if it is well formed, else null. */
export function readCondition(value: unknown): ActCondition | null {
  const parsed = ACT_CONDITION.safeParse(value);
  return parsed.success ? parsed.data : null;
}

interface Slot { name?: string; count?: number }
/** How many of `item` the body has: the id itself or any id ending `_<item>`, the pack and the worn armour and off hand together. */
function carried(bot: any, item: string): number {
  const stacks: Slot[] = [...(bot.inventory?.items?.() ?? [])];
  for (const slot of [5, 6, 7, 8, 45]) if (bot.inventory?.slots?.[slot]) stacks.push(bot.inventory.slots[slot]);
  let total = 0;
  for (const stack of stacks) {
    const name = String(stack?.name ?? '');
    if (name === item || name.endsWith(`_${item}`) || (item === 'gold_armor' && /^golden_(?:helmet|chestplate|leggings|boots)$/u.test(name))) total += stack.count ?? 1;
  }
  return total;
}
function foodCarried(bot: any): number {
  let points = 0;
  for (const stack of (bot.inventory?.items?.() ?? []) as Slot[]) points += itemFoodPoints(bot, String(stack.name ?? '')) * (stack.count ?? 1);
  return Math.round(points * 10) / 10;
}
const dimensionOf = (bot: any) => String(bot.game?.dimension ?? '').replace(/^minecraft:/u, '');
const feetOf = (bot: any): { x: number; y: number; z: number } | null => {
  const at = bot.entity?.position;
  return at && [at.x, at.y, at.z].every((value: unknown) => typeof value === 'number' && Number.isFinite(value)) ? { x: at.x, y: at.y, z: at.z } : null;
};
const isNight = (bot: any): boolean => {
  const t = Number(bot.time?.timeOfDay);
  return (Number.isFinite(t) && t >= 12542 && t <= 23459) || Number(bot.thunderState ?? 0) > 0;
};
/** The nearest block within r of the feet whose name is `block` or ends `_<block>` (a cube scan: every block read is the world as it is). */
function nearBlock(bot: any, block: string, r: number): { name: string; at: Vec3 } | null {
  const feet = feetOf(bot);
  if (!feet || typeof bot.blockAt !== 'function') return null;
  const base = new Vec3(Math.floor(feet.x), Math.floor(feet.y), Math.floor(feet.z));
  let best: { name: string; at: Vec3; d: number } | null = null;
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
    const d = Math.hypot(dx, dy, dz);
    if (d > r || (best && d >= best.d)) continue;
    const found = bot.blockAt(base.offset(dx, dy, dz), false);
    const name = String(found?.name ?? '');
    if (name === block || name.endsWith(`_${block}`)) best = { name, at: base.offset(dx, dy, dz), d };
  }
  return best;
}
function furnaceDone(bot: any, c: Extract<Clause, { k: 'furnace' }>): boolean | null {
  const job = backgroundJobs(bot).find(entry => entry.position.x === c.x && entry.position.y === c.y && entry.position.z === c.z);
  return job ? job.remainingEstimateMs <= 0 && job.status !== 'different_dimension' : null;
}
function threatsWithin(bot: any, r: number): string[] {
  const at = bot.entity?.position;
  if (!at) return [];
  const out: string[] = [];
  for (const entity of Object.values(bot.entities ?? {}) as any[]) {
    if (!entity?.position || entity === bot.entity || entity.position.distanceTo(at) > r || !isThreat(bot, entity)) continue;
    let exposure = 'reachable';
    try { exposure = threatExposure(bot, entity); } catch { /* unknown counts as able to come */ }
    if (exposure !== 'sealed') out.push(String(entity.name));
  }
  return out;
}

function holds(bot: any, c: Clause): boolean {
  switch (c.k) {
    case 'have': return c.op === '<' ? carried(bot, c.item) < c.n : carried(bot, c.item) >= c.n;
    case 'food': return foodCarried(bot) >= c.n;
    case 'hunger': return Number(bot.food ?? 0) >= c.n;
    case 'hp': return Number(bot.health ?? 0) >= c.n;
    case 'dim': return dimensionOf(bot) === c.dim;
    case 'at': {
      const feet = feetOf(bot);
      return !!feet && (!c.dim || dimensionOf(bot) === c.dim) && Math.hypot(feet.x - c.x, feet.y - c.y, feet.z - c.z) <= c.r;
    }
    case 'near': return nearBlock(bot, c.block, c.r) !== null;
    case 'free': return freeSlots(bot) >= c.n;
    case 'time': return (c.t === 'night') === isNight(bot);
    case 'furnace': return furnaceDone(bot, c) === true;
    case 'safe': return threatsWithin(bot, c.r).length === 0;
  }
}
/** Whether the condition holds now (any alternative whose clauses all hold). */
export function conditionHolds(bot: any, condition: ActCondition): boolean {
  return condition.some(clauses => clauses.every(clause => holds(bot, clause)));
}

/** The clause as the head writes it, with the value it has now: `have:log 10/10`, `hp>=15 (20)`. */
function clauseValue(bot: any, c: Clause): string {
  switch (c.k) {
    case 'have': return `have:${c.item} ${carried(bot, c.item)}${c.op === '<' ? `（${c.n} 未満が条件）` : `/${c.n}`}`;
    case 'food': return `food ${foodCarried(bot)}/${c.n} 点`;
    case 'hunger': return `hunger ${Number(bot.food ?? 0)}/${c.n}`;
    case 'hp': return `hp ${Math.round(Number(bot.health ?? 0) * 10) / 10}/${c.n}`;
    case 'dim': return `dim:${c.dim}`;
    case 'at': {
      const feet = feetOf(bot);
      return `at:${c.x},${c.y},${c.z}~${c.r}${feet ? `（今 ${Math.round(Math.hypot(feet.x - c.x, feet.y - c.y, feet.z - c.z))}m）` : ''}`;
    }
    case 'near': { const found = nearBlock(bot, c.block, c.r); return `near:${c.block}~${c.r}${found ? `（${found.name}）` : ''}`; }
    case 'free': return `free ${freeSlots(bot)}/${c.n}`;
    case 'time': return `time:${c.t}`;
    case 'furnace': return `furnace:${c.x},${c.y},${c.z}`;
    case 'safe': return `safe~${c.r}`;
  }
}
/** What an unmet clause lacks, in words: `raw_iron 1/3`, `かまど (1,2,3) の焼きはまだ`, `10m 内に zombie がいる`. */
function clauseLack(bot: any, c: Clause): string {
  switch (c.k) {
    case 'have': return c.op === '<' ? `${c.item} が ${carried(bot, c.item)} 個（${c.n} 未満が条件）` : `${c.item} ${carried(bot, c.item)}/${c.n}`;
    case 'food': return `食料 ${foodCarried(bot)}/${c.n} 点`;
    case 'hunger': return `満腹 ${Number(bot.food ?? 0)}/${c.n}`;
    case 'hp': return `体力 ${Math.round(Number(bot.health ?? 0) * 10) / 10}/${c.n}`;
    case 'dim': return `次元は ${c.dim}（今 ${dimensionOf(bot) || '不明'}）`;
    case 'at': {
      const feet = feetOf(bot);
      return feet ? `(${c.x},${c.y},${c.z}) から ${Math.round(Math.hypot(feet.x - c.x, feet.y - c.y, feet.z - c.z))}m（${c.r}m 内が条件${c.dim && dimensionOf(bot) !== c.dim ? `、次元は ${c.dim}` : ''}）` : `(${c.x},${c.y},${c.z}) までは不明`;
    }
    case 'near': return `${c.block} が ${c.r}m 内に無い`;
    case 'free': return `持ち物の空き ${freeSlots(bot)}/${c.n}`;
    case 'time': return `今は${isNight(bot) ? '夜' : '昼'}（${c.t === 'night' ? '夜' : '昼'}が条件）`;
    case 'furnace': return furnaceDone(bot, c) === null ? `かまど (${c.x},${c.y},${c.z}) の焼きの記録が無い` : `かまど (${c.x},${c.y},${c.z}) の焼きはまだ`;
    case 'safe': return `${c.r}m 内に ${threatsWithin(bot, c.r).slice(0, 3).join('・') || '敵'} がいる`;
  }
}
/** The alternative with the most clauses holding and its missing clauses in words, joined by `・`. Empty when the condition holds. */
export function conditionWords(bot: any, condition: ActCondition): string {
  if (conditionHolds(bot, condition)) return '';
  const rank = (clauses: Clause[]) => clauses.filter(clause => holds(bot, clause)).length / clauses.length;
  const best = [...condition].sort((a, b) => rank(b) - rank(a))[0]!;
  return best.filter(clause => !holds(bot, clause)).map(clause => clauseLack(bot, clause)).join('・');
}
/** The satisfied alternative's clauses with their values (`have:log 10/10`), joined by `&`; empty when none is satisfied. */
export function conditionMetText(bot: any, condition: ActCondition): string {
  const met = condition.find(clauses => clauses.every(clause => holds(bot, clause)));
  return met ? met.map(clause => clauseValue(bot, clause)).join('&') : '';
}
