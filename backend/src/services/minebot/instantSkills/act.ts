import { z } from 'zod';
import { CustomBot, InstantSkill } from '../types.js';
import { actionSignal, nativeActionHost } from '../execution/ActionExecution.js';
import { isThreat, LAYING_HANDS, reflexHeld, shooterWords, shootersInReach, shootersSeeing } from '../utils/floorReflexes.js';
import { threatExposure } from '../utils/threatExposure.js';
import { beginEngagement } from '../utils/engagement.js';
import { bodyReader, cellKey, facingOfYaw, feetCell, noteMapStop, type Cell, type Facing } from '../utils/localMap.js';
import { aroundText, clip, closedWord, keepActReport, renderActReport, stoppedLine, type ActReport, type StoppedBy } from '../utils/actReport.js';
import { blockAt, cellNow, freeSlots, inventoryCount, resolvePosition, StepStopped, wait, type PositionSpec, type StepContext, type StepOutcome } from '../utils/primitives/common.js';
import { dimensionOf, portalWalks, walk } from '../utils/primitives/walk.js';
import { dig } from '../utils/primitives/dig.js';
import { place } from '../utils/primitives/place.js';
import { use } from '../utils/primitives/use.js';
import { craft } from '../utils/primitives/craft.js';
import { furnace } from '../utils/primitives/furnace.js';
import { chest } from '../utils/primitives/chest.js';
import { attack } from '../utils/primitives/attack.js';
import { drop, eat, equip, jump, look, sneak } from '../utils/primitives/body.js';
import { pickup } from '../utils/primitives/pickup.js';
import { shoot } from '../utils/primitives/shoot.js';
import { pillarUp } from '../utils/primitives/pillarUp.js';
import { mine } from '../utils/primitives/mine.js';
import { make } from '../utils/primitives/make.js';
import { smelt } from '../utils/primitives/smelt.js';
import { handProblem } from '../utils/actHandRules.js';
import { itemFoodPoints } from '../utils/foodPoints.js';
import { stepLabel } from '../utils/actLabel.js';
import { ACT_CONDITION, conditionHolds, conditionMetText, type ActCondition } from '../utils/actConditions.js';
import { noteHand } from '../utils/handHistory.js';

export { stepLabel };

/**
 * mc.act (design mb-llm-centric 2.3; the input and the result are the head's contract, minecraftActContract.ts): up to twelve small
 * hands, run in order. Each hand is a part (utils/primitives) that does exactly what it is told and checks what came of it; the first
 * that does not go as asked stops the act, and the answer (ActResult, JSON) says which hands were done, where and why the rest stopped
 * (the closed word, the block and its cell, what the cell holds now), and the map as it is now. `stopIf` stops it from outside its
 * hands: a hostile within some metres, health or food below a mark, a watched cell that changes. A body reflex that acts (a meal at
 * starvation, the flight at low health, lava, air, a lit creeper, an arrow, a fireball) stops it too. Nothing is chosen for the
 * planner: no place, no way round, no tool made, no giving up after a count.
 */

/**
 * A cell: absolute {x,y,z} (with the hand's `rel`, counted from the feet: x east, y up, z south), or {front,right,up} in the act's
 * facing (the body's own extension for "n ahead, n to the right"). One flat object: the wire's schema allows no deeper nesting.
 */
const Pos = z.object({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional(),
  front: z.number().optional(), right: z.number().optional(), up: z.number().optional() }).strict();
const ItemCount = z.object({ item: z.string(), count: z.number().optional() }).strict();
export const HAND_KINDS = ['walk', 'dig', 'place', 'pillarUp', 'use', 'look', 'jump', 'sneak', 'equip', 'craft', 'furnace', 'chest',
  'attack', 'shoot', 'eat', 'drop', 'pickup', 'wait', 'mine', 'make', 'smelt'] as const;
const Face = z.enum(['up', 'down', 'north', 'south', 'east', 'west']);
/** One hand: every field of the head's ActHand (the body takes whatever the head's schema takes), and a few more it can read. */
const Hand = z.object({
  do: z.enum(HAND_KINDS),
  to: Pos.optional().describe('walk の着く所、look の向く点'),
  path: z.array(Pos).max(64).optional().describe('walk の道（点の列）'),
  at: z.array(Pos).max(16).optional().describe('dig・place は順に全部、use・furnace・chest・shoot・drop は 1 つ、mine は鉱脈のマス（1〜4）、smelt は使うかまど（最大4）'),
  face: Face.optional().describe('place・use: 当てる面'),
  block: z.string().optional(),
  item: z.string().optional(),
  count: z.number().optional(),
  items: z.array(ItemCount).max(16).optional(),
  fuel: z.string().optional(),
  fuelCount: z.number().optional(),
  furnaces: z.number().int().min(1).max(4).optional().describe('smelt: 何基に分けるか（1〜4）'),
  canDig: z.array(z.string().max(40)).min(1).max(12).optional().describe('mine: 道を掘ってよい物（id か stone・dirt・sand・wood）'),
  maxDig: z.number().int().min(0).max(200).optional().describe('mine: 道を掘る数の上限'),
  op: z.enum(['put', 'take', 'look', 'takeAll']).optional(),
  target: z.union([z.string(), z.number()]).optional().describe('#id か名前'),
  untilDead: z.boolean().optional(),
  hold: z.boolean().optional().describe('attack: その場で待ち、手の届く所に来たら打つ（追わない）'),
  seconds: z.number().optional(),
  charge: z.number().optional(),
  n: z.number().optional(),
  sprint: z.boolean().optional(),
  range: z.number().optional(),
  slot: z.enum(['hand', 'offhand', 'off-hand', 'head', 'chest', 'torso', 'legs', 'feet']).optional(),
  on: z.boolean().optional(),
  yaw: z.number().optional(),
  pitch: z.number().optional(),
  tool: z.string().optional(),
  collect: z.boolean().optional(),
  exposeOk: z.union([z.boolean(), z.array(z.string()).max(16)]).optional().describe('true か、受け入れる敵の種類の列'),
  takeOk: z.boolean().optional(),
  rel: z.boolean().optional(),
  note: z.string().optional(),
  onFail: z.enum(['continue', 'stop']).optional().describe('この手が自分で失敗したとき: continue=失敗と記録して次の手へ、stop=ここで止める（省略: equip・eat・look・sneak・jump は continue、他は stop）。反射・stopIf・取り消し・時間切れ・満杯は常に止める'),
}).strict();
export const ACT_HANDS = z.array(Hand).min(1).max(12);
export const ACT_STOP_IF = z.object({
  hostileWithin: z.number().optional(),
  hpBelow: z.number().optional(),
  hungerBelow: z.number().optional(),
  blockChanged: z.array(Pos).max(8).optional(),
}).strict();
/** The kinds of hostile this act has chosen to fight (the contract's ccept, 1.4). */
export const ACT_ACCEPT = z.array(z.string()).max(6);
/** `repeat` (task queue): the most passes of the hand list; `done` (an `ActCondition`) ends the act ok where it holds, mid-hand too. */
export const ACT_REPEAT = z.number().int().min(2).max(8);
export type ActHand = z.infer<typeof Hand>;
export type ActStopIf = z.infer<typeof ACT_STOP_IF>;

/** The kinds whose failure does not stop the act unless the hand says `onFail: 'stop'` (a missing tool must not keep a walk away from running). */
const CONTINUES_ON_FAIL = new Set(['equip', 'eat', 'look', 'sneak', 'jump']);
/**
 * Whether the act goes on to the next hand when this one fails by itself (its outcome is not ok): `onFail` when given, else by the kind.
 * A reflex, stopIf, a cancel, the deadline, a lost connection or a full pack stop the whole act whatever this says.
 */
export function handContinuesOnFail(hand: Pick<ActHand, 'do' | 'onFail'>): boolean {
  return hand.onFail ? hand.onFail === 'continue' : CONTINUES_ON_FAIL.has(hand.do);
}

/** Reflex kinds in the ledger that do not stop an act (the shield is part of a fight; the budget is a notice). */
/** Reflex kinds in the ledger that do not stop an act: the shield and the fireball struck back are part of a fight (the contract's 1.4); the budget is a notice. */
const LEDGER_QUIET = new Set(['shield', 'fireball', 'budget', 'pickup', 'armor', 'cover_none', 'melee_none']);
const REFLEX_NAMES: Record<string, string> = { 'floor-eat': '食事（飢え・瀕死）', 'floor-retreat': '退避（点火したクリーパー・矢）', 'floor-flee': '低体力の逃走', 'floor-last-stand': '逃げ道が無い時の最後の手', 'floor-cover': '燃えて射手から見えている時に射線を切る', 'floor-melee': '近接の敵が近い時の最小の 1 手（打ち返す・間にブロック・2 段上がる・空所の縁から離れる）',
  'floor-shelter': '逃げ道が無い時の囲い', 'auto-swim': '泳ぎ（呼吸）', 'constant:auto-swim': '泳ぎ（呼吸）', 'lava-escape': '溶岩からの脱出', 'floor-armor': '防具' };
const reflexName = (reason: unknown) => { const text = String(reason ?? ''); return REFLEX_NAMES[text] ?? REFLEX_NAMES[text.replace(/^constant:/u, '')] ?? text; };

/** The body's own words for the tool (the head shows its own definition: minecraftActContract.ts ACT_DESCRIPTION). */
const DESCRIPTION = '体に小さな手を最大12個まとめて頼む。体は順に動かし、手ごとに思ったとおりか確かめ、外れたら（失敗・反射・stopIf・満杯）そこで止めて、'
  + '手ごとの1行（止まりは閉じた語・場所・そのマスの今の中身）と新しい地図を JSON で返す。体は回り道・置き場所・道具作り・片づけ・夜の睡眠・戦うかどうかを決めない。'
  + '手: walk / dig / place / pillarUp / use / look / jump / sneak / equip / craft / furnace / chest / attack / shoot / eat / drop / pickup / wait / mine / make / smelt。'
  + 'mine(block: 掘る種類 id, at: その鉱脈のマス1〜4, count, tool, collect, seconds, canDig・maxDig: 鉱脈へ行く道を掘ってよい物) は at のマスにつながった同じ種類だけを近い順に掘って拾う（ほかの鉱石は探さない）。'
  + 'make(item, count) は途中の物（板・棒など）を持ち物から順に作る（足りなければ何も作らず足りない物の一覧を返す。3x3 は近くの作業台、無ければ持っている物を置く）。'
  + 'smelt(items: [{item,count}], fuel, fuelCount, furnaces: 何基に分けるか, at: かまど, seconds) はかまどに分けて入れて燃料を足すまで（焼き上がりは待たず、取り出しは furnace op=take）。'
  + '座標は {x,y,z}（rel:true で足からの差）か {front,right,up}（facing の向き）。stopIf: hostileWithin・hpBelow・hungerBelow・blockChanged。';

class Act extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'act';
    this.description = DESCRIPTION;
    this.maxDurationMs = 180_000;
    this.params = [
      { name: 'hands', type: 'json', schema: ACT_HANDS, description: '順に動かす手（1〜12）', required: true },
      { name: 'stopIf', type: 'json', schema: ACT_STOP_IF, description: '止める条件（任意）' },
      { name: 'why', type: 'string', description: 'この手の組のねらい（短く、記録だけ）' },
      { name: 'accept', type: 'json', schema: ACT_ACCEPT, description: 'この act で戦うと決めた敵の種類（6まで）' },
      { name: 'facing', type: 'string', description: '{front,right,up} を読む向き: north・east・south・west（省略は act の始めの体の向き）' },
      { name: 'repeat', type: 'json', schema: ACT_REPEAT, description: '手の組を最大何回まわすか（2〜8。rel の手の組向き）' },
      { name: 'done', type: 'json', schema: ACT_CONDITION, description: '済む条件（満たした所で、手の途中でも済にする）' },
    ];
  }

  async runImpl(hands: ActHand[], stopIf?: ActStopIf | null, _why?: string | null, accept?: string[] | null, facing?: string | null,
    repeat?: number | null, done?: ActCondition | null) {
    return runAct(this.bot, hands, stopIf ?? undefined, facing ?? undefined, { accept: accept ?? undefined, repeat: repeat ?? undefined, done: done ?? undefined });
  }
}

/** A hand's cells: relative ones (`rel`, or {front,right,up}) from the feet when the hand began. */
function cellOf(ctx: StepContext, hand: ActHand, spec: unknown): Cell | null {
  if (!spec || typeof spec !== 'object') return null;
  const value = spec as { x?: number; y?: number; z?: number };
  if (hand.rel && [value.x, value.y, value.z].every(v => v === undefined || typeof v === 'number')
    && ![(spec as { front?: number }).front, (spec as { right?: number }).right, (spec as { up?: number }).up].some(v => v !== undefined)) {
    return { x: ctx.base.x + Math.round(value.x ?? 0), y: ctx.base.y + Math.round(value.y ?? 0), z: ctx.base.z + Math.round(value.z ?? 0) };
  }
  return resolvePosition(ctx, spec as PositionSpec);
}
function cellsOf(ctx: StepContext, hand: ActHand, specs: unknown[] | undefined): Cell[] | null {
  const cells: Cell[] = [];
  for (const spec of specs ?? []) { const cell = cellOf(ctx, hand, spec); if (!cell) return null; cells.push(cell); }
  return cells;
}
const bad = (text: string): StepOutcome => ({ ok: false, reason: 'invalid_input', text });
/** A creature named as the contract does ("#41" an id, else a name), or a plain id. */
const targetOf = (value: string | number | undefined) => value === undefined ? undefined : typeof value === 'number' ? value
  : /^#\d+$/u.test(value.trim()) ? Number(value.trim().slice(1)) : value;
const PILLAR_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack'];
const SLOTS: Record<string, string> = { hand: 'hand', offhand: 'off-hand', 'off-hand': 'off-hand', head: 'head', chest: 'torso', torso: 'torso', legs: 'legs', feet: 'feet' };

async function runHand(ctx: StepContext, hand: ActHand): Promise<StepOutcome> {
  const bot = ctx.bot;
  const cells = cellsOf(ctx, hand, hand.at);
  if (cells === null) return bad('at のマスが読めない（{x,y,z} か {front,right,up}）');
  const one = cells[0];
  const target = targetOf(hand.target);
  // The hands with a field table of the head's (utils/actHandRules): a field the kind does not take, a missing one, a range, is refused before the hand moves.
  const wrong = handProblem(hand);
  if (wrong) return bad(`${hand.do} 止まった invalid_input: ${wrong}`);
  switch (hand.do) {
    case 'walk': {
      const to = hand.to ? cellOf(ctx, hand, hand.to) : null;
      const path = hand.path ? cellsOf(ctx, hand, hand.path) : null;
      if ((hand.to && !to) || (hand.path && !path)) return bad('walk のマスが読めない');
      return walk(ctx, { to: to ?? undefined, path: path ?? undefined, range: hand.range ?? 0.5, sprint: hand.sprint ?? false });
    }
    case 'dig': return dig(ctx, { at: cells, tool: hand.tool, collect: hand.collect, take: hand.takeOk, exposeOk: hand.exposeOk });
    case 'place': return place(ctx, { block: hand.block ?? '', at: cells, against: hand.face });
    case 'pillarUp': {
      const block = hand.block ?? [...PILLAR_BLOCKS].sort((a, b) => inventoryCount(bot, b) - inventoryCount(bot, a))[0];
      return pillarUp(ctx, { n: hand.n ?? 1, block });
    }
    case 'use': return use(ctx, { item: hand.item, at: one, against: hand.face, entity: target !== undefined ? String(target) : undefined });
    case 'look': {
      const to = hand.to ? cellOf(ctx, hand, hand.to) : null;
      // The contract's pitch is the game's (-90 up, 90 down); look takes it up positive.
      return look(ctx, { at: to ?? one, entity: target !== undefined ? String(target) : undefined, yaw: hand.yaw, pitch: typeof hand.pitch === 'number' ? -hand.pitch : undefined });
    }
    case 'jump': return jump(ctx, { n: hand.n });
    case 'sneak': return sneak(ctx, { on: hand.on ?? true, seconds: hand.seconds });
    case 'equip': return equip(ctx, { item: hand.item ?? '', slot: SLOTS[hand.slot ?? 'hand'] });
    case 'craft': return craft(ctx, { item: hand.item ?? '', count: hand.count });
    case 'furnace': {
      if (!one) return bad('furnace には at（かまどのマス）が要る');
      if (hand.op === 'take') return furnace(ctx, { at: one, take: 'output' });
      return furnace(ctx, { at: one, put: hand.item ? { item: hand.item, count: hand.count } : undefined,
        fuel: hand.fuel ? { item: hand.fuel, count: hand.fuelCount } : undefined });
    }
    case 'chest': {
      if (!one) return bad('chest には at（箱のマス）が要る');
      const items = (hand.items ?? []) as Array<{ item: string; count?: number }>;
      if (hand.op === 'take') return chest(ctx, { at: one, take: items });
      if (hand.op === 'put') return chest(ctx, { at: one, put: items });
      if (hand.op === 'takeAll') return chest(ctx, { at: one, takeAll: true });
      return chest(ctx, { at: one });
    }
    case 'attack': {
      if (hand.hold) return attack(ctx, { mode: 'hold', target, maxSeconds: hand.seconds ?? 20 });
      if (target === undefined) return bad('attack には target（#id か名前）が要る');
      const untilDead = hand.untilDead !== false;
      return attack(ctx, { target, until: untilDead ? 'dead' : hand.seconds ?? 20, maxSeconds: hand.seconds ?? 20 });
    }
    case 'shoot': return shoot(ctx, { target, at: one, charge: hand.charge, weapon: hand.item === 'crossbow' ? 'crossbow' : hand.item === 'bow' ? 'bow' : undefined, shots: hand.n });
    case 'eat': {
      const item = hand.item ?? [...new Set(((bot.inventory?.items?.() ?? []) as Array<{ name: string }>).map(entry => entry.name))]
        .filter(name => itemFoodPoints(bot, name) > 0 && !/^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|chorus_fruit)$/u.test(name))
        .sort((a, b) => itemFoodPoints(bot, b) - itemFoodPoints(bot, a))[0];
      if (!item) return { ok: false, reason: 'missing_item', text: '食べられる物を持っていない' };
      return eat(ctx, { item });
    }
    case 'drop': return drop(ctx, { items: (hand.items ?? []) as Array<{ item: string; count?: number }>, toward: target !== undefined ? String(target) : one });
    case 'pickup': return pickup(ctx, { radius: hand.range, ids: typeof target === 'number' ? [target] : undefined });
    case 'mine': return mine(ctx, { block: hand.block ?? '', at: cells, count: hand.count, tool: hand.tool, collect: hand.collect, seconds: hand.seconds, canDig: hand.canDig, maxDig: hand.maxDig });
    case 'make': return make(ctx, { item: hand.item ?? '', count: hand.count });
    case 'smelt': return smelt(ctx, { items: (hand.items ?? []) as Array<{ item: string; count?: number }>, fuel: hand.fuel, fuelCount: hand.fuelCount, furnaces: hand.furnaces, at: hand.at ? cells : undefined, seconds: hand.seconds });
    case 'wait': {
      const seconds = Math.max(0, Math.min(30, hand.seconds ?? 1));
      await wait(ctx, seconds * 1000);
      return { ok: true, text: `${seconds}秒待った` };
    }
  }
  return bad(`知らない手 ${String((hand as { do?: unknown }).do)}`);
}

/** The act's stop from outside its hands, as the contract names it. */
function stoppedByOf(code: string): StoppedBy {
  if (code === 'reflex' || code === 'interrupted_by_reflex') return 'reflex';
  if (code.startsWith('stop_if')) return 'stopIf';
  if (code === 'inventory_full') return 'inventoryFull';
  if (code === 'timeout' || code === 'deadline') return 'deadline';
  if (code === 'cancelled') return 'cancelled';
  if (code === 'no_progress') return 'noProgress';
  if (code === 'damage_taken') return 'damage';
  if (code === 'fell') return 'fall';
  return 'failure';
}

/** The cells of a dig hand that held a block before and hold something else now (what the hand dug). */
function dugCountOf(bot: any, before: Array<{ cell: Cell; name: string }>): number {
  const AIR = new Set(['', 'air', 'cave_air', 'void_air']);
  return before.filter(item => !AIR.has(item.name) && String(blockAt(bot, item.cell)?.name ?? '') !== item.name).length;
}

/**
 * Runs the hands (also from tests, with a fake body). `bot` is the act's motor port: everything it moves stops when the action is
 * cut. The report is kept for the command's receipt (utils/actReport) and returned as the skill's result (JSON).
 */
export async function runAct(bot: any, hands: ActHand[], stopIf?: ActStopIf, facingName?: string,
  options: { maxMs?: number; tickMs?: number; accept?: string[]; repeat?: number; done?: ActCondition } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + (options.maxMs ?? 180_000);
  const facing: Facing = (['north', 'east', 'south', 'west'] as const).find(name => name === facingName) ?? facingOfYaw(Number(bot.entity?.yaw ?? 0));
  // Task queue: the hand list may be run up to `repeat` times, and `done` ends the act ok where it holds (the head's contract; both optional).
  const passes = Math.max(1, Math.min(8, Math.floor(options.repeat ?? 1)));
  const report: ActReport = { startedAt, lines: [], ok: false, done: 0, of: hands.length * passes };
  const doneWhen = options.done ?? null;
  const holdsDone = () => { try { return !!doneWhen && conditionHolds(bot, doneWhen); } catch { return false; } };
  let doneMet = false, pass = 1, completedPasses = 0, dug = 0;
  const control = new AbortController();
  /** Stops the act from outside its hands: the contract's stoppedBy and stoppedWhy, and the code for the receipt. */
  const stopWith = (why: string, code: string) => {
    if (control.signal.aborted) return;
    report.stoppedBy = stoppedByOf(code); report.stoppedWhy = clip(why, 200); report.failureType = code; control.abort(code);
  };
  /** The act's own end: the `done` condition holds (ok, not a stop): what holds is told with its values. */
  const finishDone = () => {
    if (doneMet || control.signal.aborted) return;
    doneMet = true; report.doneMet = conditionMetText(bot, doneWhen!);
    control.abort('done_met');
  };
  const startDimension = String(bot.game?.dimension ?? '');
  /** The body (not the motor port): the hand running now is told on it, for the floor's last stand (floorReflexes LAYING_HANDS). */
  const host = nativeActionHost(bot) as { actHandNow?: string };
  const accepted = new Set((options.accept ?? []).map(kind => kind.replace(/^minecraft:/u, '').toLowerCase()).filter(Boolean));
  const sealed = (entity: any) => { try { return threatExposure(bot, entity) === 'sealed'; } catch { return false; } };
  const ledger = bot.reflexLedger as { mark(): number; entriesSince(mark: number): Array<{ kind: string; detail: string }> } | undefined;
  const mark = ledger?.mark() ?? 0;
  const startFree = freeSlots(bot);
  const watched = new Map<string, string>();
  const base0 = feetCell(bot);
  if (stopIf?.blockChanged && base0) {
    for (const spec of stopIf.blockChanged) {
      const cell = resolvePosition({ base: base0, facing }, spec as PositionSpec);
      if (cell) watched.set(cellKey(cell), String(blockAt(bot, cell)?.name ?? '未ロード'));
    }
  }
  /**
   * r7 (run 31: stopped by hpBelow in the middle of a corridor in the blazes' line, and burned there): where a stopIf stops, the shooters in
   * reach and whether they see the body ("射線の中: blaze #12 上5・9.1m から見えている"), or nothing when none is in reach. Facts only.
   */
  const lineFacts = () => {
    try {
      const at = bot.entity?.position;
      if (!at) return '';
      const inReach = shootersInReach(bot, at);
      if (!inReach.length) return '';
      const seeing = shootersSeeing(bot, inReach, at);
      return seeing.length ? `。射線の中: ${shooterWords(at, seeing)} から見えている` : `。射線の外: ${shooterWords(at, inReach)} からは見えない`;
    } catch { return ''; }
  };
  let crossedByWalk = false;
  // Hurt: health lost from the highest it was in this act (loss while a kind she accepted is within 6 m is not counted); fall: the drop of one airborne spell.
  let highWater = Number(bot.health ?? 20);
  let peakY: number | null = null, hurtAt: number | null = null;
  /** A reflex gets the first word on a blow: the stop for hurt waits this long for one to act (the ledger's stop and the lease's cut come first). */
  const HURT_GRACE_MS = 250;
  const acceptedNear = () => accepted.size > 0 && (Object.values(bot.entities ?? {}) as any[]).some(entity => entity?.position && entity !== bot.entity
    && accepted.has(String(entity.name ?? '').toLowerCase()) && entity.position.distanceTo(bot.entity.position) <= 6);
  const hurtOrFall = () => {
    const health = Number(bot.health ?? 20);
    highWater = acceptedNear() ? health : Math.max(highWater, health);
    if (highWater - health >= 4) {
      hurtAt ??= Date.now();
      if (Date.now() - hurtAt >= HURT_GRACE_MS && !reflexHeld(bot)) return stopWith(`被弾: 体力 ${Math.round(highWater)} → ${Math.round(health)}`, 'damage_taken');
    } else hurtAt = null;
    const entity = bot.entity;
    if (!entity?.position || entity.onGround !== false || entity.isInWater || entity.isInLava || entity.isOnLadder) { peakY = null; return; }
    peakY = Math.max(peakY ?? entity.position.y, entity.position.y);
    if (peakY - entity.position.y >= 4) return stopWith(`落下: ${Math.round(peakY - entity.position.y)} 段`, 'fell');
  };
  const watch = () => {
    try {
      if ((bot.health ?? 20) <= 0) return stopWith('体が死んだ', 'died');
      if (doneWhen && !doneMet && holdsDone()) return finishDone();
      // A walk into a portal says the crossing itself (its arrival) and the act ends after it (below): not a stop in the middle of the hand.
      if (String(bot.game?.dimension ?? '') !== startDimension && !(host.actHandNow === 'walk' && portalWalks.has(bot)) && !crossedByWalk) return stopWith(`次元が変わった（${startDimension} → ${String(bot.game?.dimension ?? '')}）`, 'dimension_changed');
      const entries = ledger?.entriesSince(mark).filter(entry => !LEDGER_QUIET.has(entry.kind)) ?? [];
      // r6 (run 29): a reflex's note does not stop a hand that is laying blocks (it may be what walls the threat off); the act stops when
      // that hand is over. A reflex that takes the body still cuts it at once (its lease aborts the action: onCut).
      if (entries.length && !LAYING_HANDS.has(String(host.actHandNow ?? ''))) return stopWith(entries.map(entry => entry.detail).join('、'), 'reflex');
      // An accepted kind is not counted (the contract's 1.4): the act is there to fight it.
      const near = typeof stopIf?.hostileWithin === 'number' ? (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity?.position && entity !== bot.entity
        && !accepted.has(String(entity.name ?? '').toLowerCase()) && entity.position.distanceTo(bot.entity.position) <= stopIf.hostileWithin! && isThreat(bot, entity) && !sealed(entity)) : [];
      if (near.length) {
        const listed = near
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
          .map(entity => `${entity.name} #${entity.id} ${entity.position.distanceTo(bot.entity.position).toFixed(1)}m`).slice(0, 3);
        return stopWith(`hostileWithin:${listed.join('、')}${lineFacts()}`, 'stop_if_hostile');
      }
      if (typeof stopIf?.hpBelow === 'number' && (bot.health ?? 20) < stopIf.hpBelow) return stopWith(`hpBelow:${Math.round(bot.health * 10) / 10}${lineFacts()}`, 'stop_if_hp');
      if (typeof stopIf?.hungerBelow === 'number' && (bot.food ?? 20) < stopIf.hungerBelow) return stopWith(`hungerBelow:${bot.food}`, 'stop_if_hunger');
      for (const [key, was] of watched) {
        const [x, y, z] = key.split(',').map(Number);
        const now = String(blockAt(bot, { x, y, z })?.name ?? '未ロード');
        if (now !== was) return stopWith(`blockChanged:(${key}) ${was}→${now}`, 'stop_if_block');
      }
      hurtOrFall();
      if (startFree > 0 && freeSlots(bot) === 0) return stopWith('持ち物が満杯になった', 'inventory_full');
    } catch { /* a watch must not stop the body */ }
  };
  const timer = setInterval(watch, options.tickMs ?? 100);
  // The kinds accepted are a fight the planner chose for this act: the dig guard lets them see the body, the arrow's step aside leaves
  // archers among them alone (engagement), and stopIf does not count them.
  const endAccepted = accepted.size ? beginEngagement(nativeActionHost(bot), [...accepted]) : () => undefined;
  const signal = actionSignal(bot);
  // A reflex's lease aborts the action with its own name (preemptLowerPriorityActions); anything else is the command's end.
  const onCut = () => {
    const reason = String(signal?.reason ?? '');
    if (/^(floor-|constant:|auto-|lava|breath)/u.test(reason) || REFLEX_NAMES[reason]) stopWith(`${reflexName(reason)}`, 'interrupted_by_reflex');
    else stopWith(`命令が止められた（${reason || 'cancel'}）`, reason === 'deadline' || reason === 'timeout' ? 'timeout' : 'cancelled');
  };
  signal?.addEventListener('abort', onCut, { once: true });
  const emit = (index: number, status: 'in_progress' | 'completed' | 'error', detail = '') => {
    try { bot.emit?.('minebotActStep', { startedAt, index, total: hands.length, label: hands[index].note ?? stepLabel(hands[index] as never), status, detail, iteration: pass, repeat: passes }); } catch { /* the UI is optional */ }
  };
  const skip = (from: number, why = '') => { for (let rest = from; rest < hands.length; rest++) report.lines.push({ i: rest + 1, do: hands[rest].do, status: 'skipped', line: why ? `未実行: ${why}` : '未実行' }); };
  // A dimension crossed (a portal walked into) ends the act there: the cells of the hands after it are the other dimension's (mb-llmc-cand 4).
  const dimension0 = dimensionOf(bot);
  let crossed = false;
  /** The hand as the probe's history keeps it (r4): its line, where it was about or stopped, and the feet it began from. */
  const remember = (hand: ActHand, status: 'done' | 'failed' | 'stopped', line: string, at: Cell | null | undefined, from: Cell | null) => {
    try {
      const where = at ?? feetCell(bot);
      if (where) noteHand(bot, { t: Date.now(), do: hand.do, status, line, at: where, ...(from ? { from } : {}) });
    } catch { /* the history is a help, never the act's result */ }
  };
  /** One pass of the hand list; false when the act ends there (a stop, an abort, the deadline, a crossed dimension), true when every hand has had its turn. */
  const runPass = async (): Promise<boolean> => {
    for (let index = 0; index < hands.length; index++) {
      const hand = hands[index];
      watch();
      if (index > 0 && crossedByWalk && dimensionOf(bot) !== dimension0) { crossed = true; skip(index, '次元が変わった（前の次元の座標の手は送らない）'); return false; }
      if (control.signal.aborted) { skip(index, doneMet ? '済む条件を満たした' : ''); return false; }
      if (Date.now() >= deadline) { stopWith('act の時間が尽きた', 'timeout'); skip(index); return false; }
      const base = feetCell(bot);
      if (!base) { stopWith('体が無い（接続が切れた）', 'disconnected'); skip(index); return false; }
      const ctx: StepContext = { bot, stop: control.signal, deadline, facing, base, progress: detail => emit(index, 'in_progress', detail) };
      emit(index, 'in_progress');
      const began = Date.now();
      let outcome: StepOutcome;
      host.actHandNow = hand.do;
      const dugBefore = hand.do === 'dig' ? (cellsOf(ctx, hand, hand.at) ?? []).map(cell => ({ cell, name: String(blockAt(bot, cell)?.name ?? '') })) : [];
      try { outcome = await runHand(ctx, hand); }
      catch (error) {
        host.actHandNow = undefined;
        dug += dugCountOf(bot, dugBefore);
        if (doneMet) {
          // The act's `done` held in the middle of this hand: the hand is cut there, and that is the act's end, ok.
          report.done++;
          report.lines.push({ i: index + 1, do: hand.do, status: 'done', line: '済む条件を満たしたので、ここで止めた' });
          emit(index, 'completed', '済む条件を満たした');
          skip(index + 1, '済む条件を満たした');
          return false;
        }
        if (error instanceof StepStopped || control.signal.aborted || /Action interrupted|Motor owner expired/u.test(String((error as Error)?.message))) {
          if (!control.signal.aborted && signal?.aborted) onCut();
          const word = closedWord(report.failureType ?? 'reflex');
          const line = clip(`${word}: ${report.stoppedWhy ?? '中断'}（手の途中）`), where = feetCell(bot) ?? undefined;
          report.lines.push({ i: index + 1, do: hand.do, status: 'stopped', line, where });
          remember(hand, 'stopped', line, where, base);
          emit(index, 'error', report.stoppedWhy ?? '中断');
          skip(index + 1);
          return false;
        }
        outcome = { ok: false, reason: 'error', text: `思わぬ失敗: ${String((error as Error)?.message ?? error).slice(0, 120)}` };
      }
      // A reflex's note held back while the hand laid blocks stops the act at the next hand's watch.
      host.actHandNow = undefined;
      dug += dugCountOf(bot, dugBefore);
      if (outcome.data?.eye) report.eye = outcome.data.eye;
      if (outcome.data?.container) report.container = outcome.data.container;
      if (typeof outcome.data?.arrowsLeft === 'number') report.arrowsLeft = outcome.data.arrowsLeft;
      if (outcome.ok) {
        if (hand.do === 'walk' && outcome.data?.crossedDimension) crossedByWalk = true;
        report.done++;
        const line = clip(`${outcome.text}（${((Date.now() - began) / 1000).toFixed(1)}秒）`);
        report.lines.push({ i: index + 1, do: hand.do, status: 'done', line });
        remember(hand, 'done', line, outcome.at, base);
        emit(index, 'completed', outcome.text);
        continue;
      }
      // A hand that fails by itself may let the act go on (onFail); what stops the act from outside its hands (the signal aborted) and a full pack never do.
      const goesOn = !control.signal.aborted && outcome.reason !== 'inventory_full' && handContinuesOnFail(hand);
      if (goesOn) report.failureType ??= outcome.reason ?? 'failed';
      else {
        report.failureType = outcome.reason ?? 'failed';
        report.stoppedBy = outcome.reason === 'inventory_full' ? 'inventoryFull' : 'failure';
      }
      // The body counts where its hands stop (the observation's recentStops); whether to give up is the planner's.
      let again = '';
      try {
        const at = outcome.at ?? feetCell(bot);
        if (at) {
          const entry = noteMapStop(bot, { kind: hand.do, from: outcome.from, at, reason: closedWord(outcome.reason) });
          if (entry.count > 1) again = `（同じ所・同じ理由で${entry.count}回目）`;
        }
      } catch { /* the count is a help, not the result */ }
      let around: string | undefined;
      try { if (outcome.at) around = aroundText(bodyReader(bot), outcome.at, feetCell(bot)); } catch { /* the line stands without it */ }
      const line = stoppedLine(outcome.reason, outcome.text, outcome.at ? cellNow(bot, outcome.at) : undefined, outcome.cause, again);
      report.lines.push({ i: index + 1, do: hand.do, status: goesOn ? 'failed' : 'stopped', line,
        ...(outcome.at ? { where: outcome.at } : {}), ...(around ? { around } : {}) });
      remember(hand, goesOn ? 'failed' : 'stopped', line, outcome.at, base);
      emit(index, 'error', outcome.text);
      if (goesOn) continue;
      skip(index + 1);
      return false;
    }
    return true;
  };
  /** What a pass changed, to tell a pass that did nothing: her cell, the pack, the blocks dug. */
  const signature = () => {
    const feet = feetCell(bot), pack = ((bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>).map(item => `${item.name}:${item.count}`).sort().join(',');
    return `${feet ? `${feet.x},${feet.y},${feet.z}` : '-'}|${pack}|${dug}`;
  };
  try {
    if (holdsDone()) finishDone();
    for (pass = 1; pass <= passes; pass++) {
      if (pass > 1) report.lines = [];
      const before = signature();
      if (!await runPass()) break;
      completedPasses = pass;
      if (holdsDone()) { finishDone(); break; }
      if (pass < passes && signature() === before) {
        stopWith(`進まない: ${pass} 回目が${pass > 1 ? ` ${pass - 1} 回目と同じ所で` : ''}何も変えなかった`, 'no_progress');
        break;
      }
    }
  } finally {
    host.actHandNow = undefined;
    clearInterval(timer);
    endAccepted();
    signal?.removeEventListener('abort', onCut);
    try { bot.setControlState?.('sneak', false); } catch { /* released */ }
  }
  // Crossed: the hands before it were all done (a failure would have stopped the act earlier), so it is ok as far as it went.
  if (passes > 1) report.repeat = { done: completedPasses, of: passes };
  report.ok = doneMet || ((report.done === hands.length * passes || (passes === 1 && crossed && report.done === report.lines.filter(line => line.status !== 'skipped').length)) && !report.stoppedBy);
  keepActReport(bot, report);
  const text = renderActReport(bot, report);
  return report.ok ? { success: true, result: text } : { success: false, result: text, failureType: report.failureType ?? 'failed', recoverable: true };
}

export default Act;
