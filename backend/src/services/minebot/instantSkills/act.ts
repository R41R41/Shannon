import { z } from 'zod';
import { CustomBot, InstantSkill } from '../types.js';
import { actionSignal, delegateShield, handoverOf, motorOpsOf, nativeActionHost } from '../execution/ActionExecution.js';
import { isThreat, LAYING_HANDS, reflexHeld, shooterWords, shootersInReach, shootersSeeing } from '../utils/floorReflexes.js';
import { threatExposure } from '../utils/threatExposure.js';
import { beginEngagement } from '../utils/engagement.js';
import { bodyReader, cellKey, facingOfYaw, feetCell, noteMapStop, type Cell, type Facing } from '../utils/localMap.js';
import { aroundText, clip, closedWord, keepActReport, renderActReport, stoppedLine, type ActReport, type HandLine, type HandStatus, type StoppedBy } from '../utils/actReport.js';
import { aggregateGoal, isReliable, type GoalOutcome, type InventoryEvent, type Progress } from '../integration/commonFca/continueContract.js';
import { actContextOf } from '../utils/actContext.js';
import { lifeOf } from '../utils/life.js';
import { handReasons, SELF_COUNTING, trackPack } from '../utils/packEvents.js';
import { cutByOf, finishedVerdict, numberEvents, stoppedFromOutside, type HandVerdict } from '../utils/handOutcome.js';
import { blockAt, cellNow, freeSlots, inventoryCount, resolvePosition, StepStopped, wait, type PositionSpec, type StepContext, type StepOutcome } from '../utils/primitives/common.js';
import { dimensionOf, portalWalks, walk } from '../utils/primitives/walk.js';
import { dig } from '../utils/primitives/dig.js';
import { place } from '../utils/primitives/place.js';
import { findEntity, use } from '../utils/primitives/use.js';
import { craft } from '../utils/primitives/craft.js';
import { furnace } from '../utils/primitives/furnace.js';
import { chest } from '../utils/primitives/chest.js';
import { attack } from '../utils/primitives/attack.js';
import { drop, eat, equip, jump, look, sneak } from '../utils/primitives/body.js';
import { pickup } from '../utils/primitives/pickup.js';
import { shoot } from '../utils/primitives/shoot.js';
import { pillarUp } from '../utils/primitives/pillarUp.js';
import { go, goProblem } from '../utils/primitives/go.js';
import { vertical } from '../utils/primitives/vertical.js';
import { obsidian, obsidianProblem } from '../utils/primitives/obsidian.js';
import { portal, portalProblem } from '../utils/primitives/portal.js';
import { fight, HandCut } from '../utils/primitives/fight.js';
import { LINE_MAX, LINE_MAX_WITH_CAUSE } from '../utils/actReport.js';
import { waterDigWords } from '../utils/waterDigWords.js';
import { mine } from '../utils/primitives/mine.js';
import { make } from '../utils/primitives/make.js';
import { smelt } from '../utils/primitives/smelt.js';
import { furnacesDueByNow } from '../utils/furnaceDone.js';
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
export const HAND_KINDS = ['walk', 'go', 'dig', 'place', 'pillarUp', 'use', 'look', 'jump', 'sneak', 'equip', 'craft', 'furnace', 'chest',
  'attack', 'shoot', 'eat', 'drop', 'pickup', 'wait', 'obsidian', 'portal', 'fight', 'mine', 'make', 'smelt', 'vertical'] as const;
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
  op: z.enum(['put', 'take', 'look', 'takeAll']).optional(),
  target: z.union([z.string(), z.number()]).optional().describe('#id か名前'),
  untilDead: z.boolean().optional(),
  hold: z.boolean().optional().describe('attack: その場で待ち、手の届く所に来たら打つ（追わない）'),
  goals: z.array(Pos).min(2).max(8).optional().describe('go: 行き先の候補（どれか1つに着けば済み）'),
  canDig: z.array(z.string().max(40)).min(1).max(12).optional().describe('go・mine: 掘ってよい物（stone・dirt・sand・wood か ブロック id）'),
  canPlace: z.array(z.string().max(40)).min(1).max(6).optional().describe('go・obsidian・portal: 置いてよい物（持っている物だけ使う）'),
  maxDrop: z.number().int().min(0).max(10).optional().describe('go: 一度に落ちてよい段'),
  waterOk: z.boolean().optional().describe('go: 水に入ってよい'),
  maxDig: z.number().int().min(0).max(200).optional().describe('go・mine: 掘る数の上限'),
  maxPlace: z.number().int().min(0).max(100).optional().describe('go・obsidian・portal: 置く数の上限'),
  axis: z.enum(['x', 'z']).optional().describe('portal: 枠が広がる向き（x: 枠は x 方向に広がる、z: z 方向）'),
  enter: z.boolean().optional().describe('portal: 点けたら入る（既定 true）'),
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
  stance: z.enum(['fight', 'flee']).optional().describe('fight: 戦う（既定）、flee: 相手から range m 以上離れるまで逃げる'),
  retreatHp: z.number().optional().describe('fight: この体力未満で戦いをやめて、食べるか退く（1〜19の整数）'),
  dir: z.enum(['down', 'up']).optional().describe('vertical: 向き（書く。今の y から推さない）'),
  shape: z.enum(['stairs', 'shaft', 'pillar']).optional().describe('vertical: stairs=階段、shaft=縦穴で真下（down だけ）、pillar=足の下に置いて真上（up だけ）'),
  toward: z.enum(['north', 'east', 'south', 'west']).optional().describe('vertical stairs: 進む向き（stairs では必須）'),
  toY: z.number().int().optional().describe('vertical: どの y まで（足の y）'),
  liquid: z.enum(['stop', 'seal', 'seal_water']).optional().describe('vertical: 溶岩・水が見えた時。stop=止める、seal=塞いで続ける、seal_water=水だけ塞ぎ溶岩で止める'),
  dependsOn: z.array(z.number().int().min(1).max(12)).max(11).optional().describe('この手が頼る、同じ act の同じ周回の前の手の番号（1 から）。無い: 今どおり。[]: どの手にも頼らない。[1,3]: 手 1 と 3 が済み（done か already）の時だけ動く'),
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
/**
 * Run 47 (hold 5): the hands whose aim is to take things into the pack stop when it fills (nothing more can be taken); a go, a vertical, a walk and the rest arrive without room,
 * and a dig only when it collects. What they dig lies unpicked, and their line says so.
 */
export function packStops(hand: Pick<ActHand, 'do' | 'collect'> | null): boolean {
  if (!hand) return false;
  if (hand.do === 'dig') return hand.collect !== false;
  return PACK_TAKING.has(hand.do);
}
const PACK_TAKING = new Set<string>(['pickup', 'mine', 'obsidian', 'chest', 'furnace', 'smelt', 'make', 'craft']);
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
  + '手: walk / go / dig / place / pillarUp / use / look / jump / sneak / equip / craft / furnace / chest / attack / shoot / eat / drop / pickup / wait / obsidian / portal / fight / mine / make / smelt / vertical。'
  + 'vertical: 縦に長く下る・上る。dir(down/up)・shape(stairs=階段 toward 必須 / shaft=真下の縦穴 down だけ / pillar=足の下に置いて真上 up だけ)・toY(足の y)・canDig(必須)・maxDig・canPlace・maxPlace・liquid(stop/seal/seal_water)・range・seconds。体は道探しをせず一段ずつ掘る・置く・歩くだけで、止まる時は「vertical 止まった <code>」の行と進んだ段数を返す。'
  + 'go: 行き先（to か goals）へ体が道を引いて着くまで行く。canDig の物だけ掘り・canPlace の物（持っている物）だけ置き、溶岩・火・マグマ・サボテンは避ける。止まる時は「go 止まった <code>」の行で理由を返す。'
  + 'obsidian: 挙げた溶岩の源（at、8 まで）に水を注いで黒曜石にして掘り、水を汲み戻す（立ち位置・注ぐ所・待ちは体。count・seconds・canPlace・maxPlace）。'
  + 'portal: at（枠の内側の左下）と axis（x か z）の枠 10 個を組み、火打ち金で点け、enter なら入る（足場は canPlace の物）。止まる時は「<手> 止まった <code>」の行で理由を返す。'
  + 'fight: 挙げた相手 target を戦い（stance=flee なら range m 離れるまで逃げ）、狙い・間合い・盾・クリティカル・低体力で食べる/退くは体がこなす。反射が優先。'
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
/** The fields a fight hand takes (with `do`): the head's rules, minecraftActHandRules.ts. */
const FIGHT_FIELDS = new Set(['do', 'target', 'stance', 'item', 'retreatHp', 'range', 'seconds', 'rel', 'note', 'onFail', 'dependsOn']);
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
    case 'go': {
      // Where to go is the planner's, as cells; the way (what to tread, dig, lay, and drawing it again) is the body's (utils/primitives/go).
      const problem = goProblem(hand as Record<string, unknown>, spec => cellOf(ctx, hand, spec) !== null);
      if (problem) return bad(`go: ${problem}`);
      const goals = (hand.goals ?? [hand.to]).map(spec => cellOf(ctx, hand, spec)!);
      return go(ctx, { goals, range: hand.range, canDig: hand.canDig, canPlace: hand.canPlace, maxDrop: hand.maxDrop, waterOk: hand.waterOk, seconds: hand.seconds,
        maxDig: hand.maxDig, maxPlace: hand.maxPlace, sprint: hand.sprint });
    }
    case 'vertical': {
      // The direction, shape and height are the planner's; each level (dig, lay, walk) is the body's, with no route search (utils/primitives/vertical).
      return vertical(ctx, { dir: hand.dir!, shape: hand.shape!, toward: hand.toward, toY: hand.toY!, canDig: hand.canDig ?? [], maxDig: hand.maxDig, canPlace: hand.canPlace,
        maxPlace: hand.maxPlace, liquid: hand.liquid!, range: hand.range, seconds: hand.seconds });
    }
    case 'dig': return dig(ctx, { at: cells, tool: hand.tool, collect: hand.collect, take: hand.takeOk, exposeOk: hand.exposeOk });
    case 'obsidian': {
      // The lava sources are the planner's, as cells; where to stand, where to pour, the wait, the dig and the water back are the body's (utils/primitives/obsidian).
      const problem = obsidianProblem(hand as Record<string, unknown>, spec => cellOf(ctx, hand, spec) !== null);
      if (problem) return { ok: false, reason: 'invalid_input', text: `obsidian 止まった invalid_input: ${problem}` };
      return obsidian(ctx, { at: cells, count: hand.count, seconds: hand.seconds, canPlace: hand.canPlace, maxPlace: hand.maxPlace, canDig: hand.canDig, maxDig: hand.maxDig });
    }
    case 'portal': {
      // The frame's place and plane are the planner's; the building, the scaffolds, the fire and the walk in are the body's (utils/primitives/portal).
      const problem = portalProblem(hand as Record<string, unknown>, spec => cellOf(ctx, hand, spec) !== null);
      if (problem) return { ok: false, reason: 'invalid_input', text: `portal 止まった invalid_input: ${problem}` };
      return portal(ctx, { at: one, axis: hand.axis!, block: hand.block, enter: hand.enter, canPlace: hand.canPlace, maxPlace: hand.maxPlace, seconds: hand.seconds });
    }
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
    case 'equip': return equip(ctx, { item: hand.item ?? '', ...(hand.slot ? { slot: SLOTS[hand.slot] } : {}) });
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
    case 'fight': {
      // The hand's own fields and ranges (the head's minecraftActHandRules.ts HAND_FIELDS / KIND_CHECKS for fight).
      if (target === undefined) return bad('fight には target（#id か名前）が要る');
      const extra = Object.keys(hand).filter(key => !FIGHT_FIELDS.has(key));
      if (extra.length) return bad(`${extra.join('・')} は fight では使えない（fight の欄: target・stance・item・retreatHp・range・seconds・rel・note・onFail・dependsOn）`);
      if (hand.seconds !== undefined && (hand.seconds < 5 || hand.seconds > 60)) return bad('fight の seconds は 5〜60');
      if (hand.range !== undefined && (hand.range < 0 || hand.range > 16)) return bad('fight の range は 0〜16');
      if (hand.retreatHp !== undefined && (!Number.isInteger(hand.retreatHp) || hand.retreatHp < 1 || hand.retreatHp > 19)) return bad('fight の retreatHp は 1〜19 の整数');
      return fight(ctx, { target, stance: hand.stance, item: hand.item, retreatHp: hand.retreatHp, range: hand.range, seconds: hand.seconds });
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
      // Run 43: a wait says what the furnaces did by now (done, or out of fuel with how many smelted), once each.
      const furnaces = furnacesDueByNow(bot as any, Date.now());
      // Continue contracts (1): a wait is always done, and its progress is the seconds waited (the hand's whole aim).
      return { ok: true, text: `${seconds}秒待った${furnaces.length ? `。${furnaces.join('。')}` : ''}`, progress: { unit: 'second', done: seconds, left: 0 } };
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
  if (LAPSES.has(code)) return 'cancelled';
  return 'failure';
}
/** Continue contracts (2, 5): the lapses that stop an act from outside (a death, a new life, a changed connection, a dimension, a lease, the operator). */
const LAPSES = new Set(['death', 'stale_life', 'connection_changed', 'dimension_changed', 'lease_expired', 'operator_stop', 'handover', 'died']);

/** The shape errors of the hands' dependsOn: itself, a hand ahead, out of range, a repeat. Null when well formed. */
export function dependsProblem(hands: Array<Pick<ActHand, 'dependsOn'>>): string | null {
  for (let index = 0; index < hands.length; index++) {
    const list = hands[index].dependsOn;
    if (list === undefined) continue;
    const seen = new Set<number>();
    for (const target of list) {
      if (!Number.isInteger(target) || target < 1 || target > hands.length) return `手 ${index + 1} の dependsOn ${target} は範囲外（1〜${hands.length}）`;
      if (target === index + 1) return `手 ${index + 1} の dependsOn が自分自身`;
      if (target > index + 1) return `手 ${index + 1} の dependsOn ${target} はまだ先の手`;
      if (seen.has(target)) return `手 ${index + 1} の dependsOn ${target} が重複`;
      seen.add(target);
    }
  }
  return null;
}

/** The cells of a dig hand that held a block before and hold something else now (what the hand dug). */
function dugCountOf(bot: any, before: Array<{ cell: Cell; name: string }>): number {
  const AIR = new Set(['', 'air', 'cave_air', 'void_air']);
  return before.filter(item => !AIR.has(item.name) && String(blockAt(bot, item.cell)?.name ?? '') !== item.name).length;
}

/**
 * A-6 (5): the life the act is run in, read when it begins. `bot` is the act's motor port, a view of the native body, and the life keeper is the native body's:
 * read from the port it was 0 (the lab's produced life--r45-death-then-old-attack). Unknown (no keeper): nothing is set and the receipt reads the life when it is rendered.
 */
function lifeAtStart(bot: object): { life?: number } {
  const number = lifeOf(nativeActionHost(bot))?.number ?? lifeOf(bot)?.number;
  return typeof number === 'number' ? { life: number } : {};
}

/**
 * Runs the hands (also from tests, with a fake body). `bot` is the act's motor port: everything it moves stops when the action is
 * cut. The report is kept for the command's receipt (utils/actReport) and returned as the skill's result (JSON).
 */
/** Native physics does not expose entity.isOnLadder. Its controlled descent is -0.225/tick after gravity.
 * A known ladder/vine and bounded velocity establish support; a fast fall past either still counts as a fall. */
function climbSupportsBody(bot: any): boolean {
  const vy = bot.entity?.velocity?.y;
  if (typeof vy !== 'number' || !Number.isFinite(vy) || vy < -0.3 || vy > 0.3) return false;
  const at = feetCell(bot);
  return !!at && ['ladder', 'vine'].includes(String(blockAt(bot, at)?.name ?? ''));
}

export async function runAct(bot: any, hands: ActHand[], stopIf?: ActStopIf, facingName?: string,
  options: { maxMs?: number; tickMs?: number; accept?: string[]; repeat?: number; done?: ActCondition } = {}) {
  const startedAt = Date.now();
  const shape = dependsProblem(hands);
  if (shape) {
    const lines: HandLine[] = hands.map((hand, index) => ({ i: index + 1, do: hand.do, status: 'skipped', line: `未実行: ${shape}`, goal: 'not_started', end: 'not_run', code: 'invalid_input' }));
    const bad: ActReport = { startedAt, lines, ok: false, done: 0, of: hands.length, stoppedBy: 'failure', stoppedWhy: shape, failureType: 'invalid_input',
      outcome: { goal: 'not_started', end: 'not_run' }, ...lifeAtStart(bot) };
    keepActReport(bot, bad);
    return { success: false, result: renderActReport(bot, bad), failureType: 'invalid_input', recoverable: true };
  }
  const deadline = startedAt + (options.maxMs ?? 180_000);
  const facing: Facing = (['north', 'east', 'south', 'west'] as const).find(name => name === facingName) ?? facingOfYaw(Number(bot.entity?.yaw ?? 0));
  // Task queue: the hand list may be run up to `repeat` times, and `done` ends the act ok where it holds (the head's contract; both optional).
  const passes = Math.max(1, Math.min(8, Math.floor(options.repeat ?? 1)));
  const report: ActReport = { startedAt, lines: [], ok: false, done: 0, of: hands.length * passes, ...lifeAtStart(bot) };
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
  let handNow: ActHand | null = null;
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
  /** The fall that stops the act (4 cells); a go hand that may drop further (`maxDrop`) is let fall what it may. */
  let fallStops = 4;
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
    if (!entity?.position || entity.onGround !== false || entity.isInWater || entity.isInLava || entity.isOnLadder || climbSupportsBody(bot)) {
      peakY = null; return;
    }
    peakY = Math.max(peakY ?? entity.position.y, entity.position.y);
    if (peakY - entity.position.y >= fallStops) return stopWith(`落下: ${Math.round(peakY - entity.position.y)} 段`, 'fell');
  };
  const watch = () => {
    try {
      if ((bot.health ?? 20) <= 0) return stopWith('体が死んだ', 'died');
      if (doneWhen && !doneMet && holdsDone()) return finishDone();
      // A walk into a portal says the crossing itself (its arrival) and the act ends after it (below): not a stop in the middle of the hand.
      if (String(bot.game?.dimension ?? '') !== startDimension && !((host.actHandNow === 'walk' || host.actHandNow === 'portal') && portalWalks.has(bot)) && !crossedByWalk) return stopWith(`次元が変わった（${startDimension} → ${String(bot.game?.dimension ?? '')}）`, 'dimension_changed');
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
      // Run 47 (hold 5): only a hand whose aim is to take things stops for a full pack; a go or a vertical arrives without room (what it digs falls, and its line says so).
      if (startFree > 0 && freeSlots(bot) === 0 && packStops(handNow)) return stopWith('持ち物が満杯になった', 'inventory_full');
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
  // ----- continue contracts: each hand's result on two axes, its inventory events, its place in the dependency order -----
  const actContext = actContextOf(bot);
  const commandId = actContext?.command ?? 'act';
  report.command = actContext?.command;
  const allEvents: InventoryEvent[] = [];
  report.events = allEvents;
  /** The hands' goals and the effective motor operations each sent (the act's goal is decided from these, 1). */
  const handRuns: Array<{ goal: GoalOutcome; motorOps: number; ran: boolean }> = [];
  /** This pass's hands' results, for the hands that depend on them: reliable is done or already, finished. */
  let handResults = new Map<number, { goal: GoalOutcome; end: string }>();
  /** A hand failed by itself and the act stopped there: later hands go on only if they say what they depend on (and it holds). */
  let actFailed = false;
  const nextObsSeq = () => { try { return Number((host as { nextObsSeq?: () => number }).nextObsSeq?.() ?? 0); } catch { return 0; } };
  /** The cut reason of an act stopped from outside its hands. */
  const outsideCut = () => cutByOf(report.failureType, report.stoppedBy, signal?.reason);
  const pushLine = (index: number, status: HandStatus, line: string, verdict: HandVerdict, motorOps: number, extra: Partial<HandLine> = {}, events: InventoryEvent[] = []) => {
    handResults.set(index + 1, { goal: verdict.goal, end: verdict.end });
    handRuns.push({ goal: verdict.goal, motorOps, ran: status !== 'skipped' });
    report.lines.push({ i: index + 1, do: hands[index].do, status, line, ...extra, goal: verdict.goal, end: verdict.end, ...(status !== 'skipped' ? { motorOps } : {}),
      ...(verdict.cutBy ? { cutBy: verdict.cutBy } : {}), ...(verdict.code ? { code: verdict.code } : {}), ...(verdict.progress ? { progress: verdict.progress } : {}),
      ...(events.length ? { delta: events } : {}), ...(passes > 1 ? { pass } : {}) });
  };
  /** A hand that did not run (the act stopped before it, a hand it depends on gave nothing, ...): not started, not run. */
  const skipOne = (index: number, why = '', code?: string, cutBy?: HandVerdict['cutBy']) =>
    pushLine(index, 'skipped', why ? `未実行: ${why}` : '未実行', { goal: 'not_started', end: 'not_run', ...(cutBy ? { cutBy } : {}), ...(code ? { code } : {}) }, 0);
  const skip = (from: number, why = '', code?: string) => {
    const cutBy = control.signal.aborted && !doneMet ? outsideCut() : undefined;
    for (let rest = from; rest < hands.length; rest++) skipOne(rest, why, code, cutBy);
  };
  /** The inventory events a hand made, numbered in the order they come to the head (the ids are the command's, the pass's, the hand's). */
  const eventsOf = (index: number, made: Array<Omit<InventoryEvent, 'id' | 'obsSeq' | 'deliverySeq'>>): InventoryEvent[] => {
    if (!made.length) return [];
    const numbered = numberEvents(made, { command: commandId, pass, hand: index + 1, obsSeq: nextObsSeq(), nextDelivery: allEvents.length });
    allEvents.push(...numbered);
    return numbered;
  };
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
  /** One pass of the hand list; false when the act ends there (a stop, an abort, the deadline, a crossed dimension, a failed hand), true when every hand has had its turn. */
  const runPass = async (): Promise<boolean> => {
    handResults = new Map();
    for (let index = 0; index < hands.length; index++) {
      const hand = hands[index];
      watch();
      if (index > 0 && crossedByWalk && dimensionOf(bot) !== dimension0) { crossed = true; skip(index, '次元が変わった（前の次元の座標の手は送らない）'); return false; }
      if (control.signal.aborted) { skip(index, doneMet ? '済む条件を満たした' : ''); return false; }
      // The lapses (2, 5): a new life, a changed connection or lease, a dimension changed: checked before each hand moves the body.
      const lapse = actContext?.lapse?.(index === 0 && pass === 1);
      if (lapse) { stopWith(lapse.why, lapse.code); skip(index); return false; }
      if (Date.now() >= deadline) { stopWith('act の時間が尽きた', 'timeout'); skip(index); return false; }
      // A hand failed by itself and stopped the act: only a hand that names what it depends on may still go (and only if that holds).
      if (actFailed && !Array.isArray(hand.dependsOn)) { skipOne(index); continue; }
      if (Array.isArray(hand.dependsOn)) {
        const unmet = hand.dependsOn.find(target => { const result = handResults.get(target); return !result || !isReliable({ goal: result.goal, end: result.end as never }); });
        if (unmet !== undefined) { skipOne(index, `頼る手 ${unmet} が済んでいない`, `depends_failed:${unmet}`); continue; }
      }
      const base = feetCell(bot);
      if (!base) { stopWith('体が無い（接続が切れた）', 'disconnected'); skip(index); return false; }
      const made: Array<Omit<InventoryEvent, 'id' | 'obsSeq' | 'deliverySeq'>> = [];
      const ctx: StepContext = { bot, stop: control.signal, deadline, facing, base, progress: detail => emit(index, 'in_progress', detail), record: event => { made.push(event); } };
      emit(index, 'in_progress');
      try { actContext?.onHandStart?.({ hand: index + 1, pass }); } catch { /* the record never stops a hand */ }
      const began = Date.now();
      const opsBefore = motorOpsOf(bot);
      let outcome: StepOutcome;
      host.actHandNow = hand.do; handNow = hand;
      fallStops = hand.do === 'go' ? Math.max(4, (hand.maxDrop ?? 3) + 1) : 4;
      const dugBefore = hand.do === 'dig' ? (cellsOf(ctx, hand, hand.at) ?? []).map(cell => ({ cell, name: String(blockAt(bot, cell)?.name ?? '') })) : [];
      // A fight hand is a fight the planner chose against its target's kind, in either stance: for the length of the hand the kind counts as accepted
      // (the hurt stop and stopIf's hostileWithin leave it alone), and the blows it cost are not held against the next hand.
      const fightKind = hand.do === 'fight' && hand.target !== undefined ? String(findEntity(bot, targetOf(hand.target) ?? '', 32)?.name ?? '').toLowerCase() : '';
      const fightAccepted = fightKind !== '' && !accepted.has(fightKind);
      if (fightAccepted) accepted.add(fightKind);
      // Continue contracts (4): a fight or an attack hand hands the shield to the resident shield for as long as it runs (the right stays with the owner, this act).
      const delegates = hand.do === 'fight' || hand.do === 'attack';
      if (delegates) delegateShield(bot, true);
      const endFight = () => { if (delegates) delegateShield(bot, false); if (fightAccepted) accepted.delete(fightKind); if (hand.do === 'fight') { highWater = Number(bot.health ?? 20); hurtAt = null; } };
      // Continue contracts (3): what the hand changed in the pack is told, with the reason its kind gives (craft and make say their own).
      const tracker = SELF_COUNTING.has(hand.do) ? null : trackPack(bot);
      const settleTrack = () => tracker?.finish(handReasons(hand) ?? {}, event => made.push(event));
      try { outcome = await runHand(ctx, hand); }
      catch (error) {
        settleTrack();
        endFight();
        host.actHandNow = undefined;
        dug += dugCountOf(bot, dugBefore);
        const handOps = motorOpsOf(bot) - opsBefore;
        const cutProgress = ((error as { progress?: Progress; verticalProgress?: Progress })?.progress ?? (error as { verticalProgress?: Progress })?.verticalProgress);
        if (doneMet) {
          // The act's `done` held in the middle of this hand: the hand is cut there, and that is the act's end, ok.
          report.done++;
          pushLine(index, 'done', '済む条件を満たしたので、ここで止めた', { goal: 'done', end: 'finished' }, handOps, {}, eventsOf(index, made));
          emit(index, 'completed', '済む条件を満たした');
          skip(index + 1, '済む条件を満たした');
          return false;
        }
        if (error instanceof StepStopped || control.signal.aborted || /Action interrupted|Motor owner expired/u.test(String((error as Error)?.message))) {
          if (!control.signal.aborted && signal?.aborted) onCut();
          const word = closedWord(report.failureType ?? 'reflex');
          // A hand that was cut tells what it had done (fight: the blows, the health lost, who held the body).
          // Run 46 (hold 7): a dig under water stopped by the swim reflex says why, and what to do next.
          const watery = error instanceof HandCut ? null : waterDigWords(bot, hand.do, report.stoppedWhy);
          const told = error instanceof HandCut ? `。${error.summary}` : watery ? `。${watery}` : '';
          const line = clip(`${word}: ${report.stoppedWhy ?? '中断'}（手の途中）${told}`, told ? LINE_MAX_WITH_CAUSE : LINE_MAX), where = feetCell(bot) ?? undefined;
          const verdict: HandVerdict = { goal: (cutProgress?.done ?? 0) > 0 ? 'partial' : handOps > 0 ? 'failed' : 'not_started', end: 'cut', cutBy: outsideCut(),
            ...(report.failureType ? { code: report.failureType } : {}), ...(cutProgress ? { progress: cutProgress } : {}) };
          pushLine(index, 'stopped', line, verdict, handOps, { where }, eventsOf(index, made));
          remember(hand, 'stopped', line, where, base);
          emit(index, 'error', report.stoppedWhy ?? '中断');
          skip(index + 1);
          return false;
        }
        outcome = { ok: false, reason: 'error', text: `思わぬ失敗: ${String((error as Error)?.message ?? error).slice(0, 120)}` };
      }
      // A reflex's note held back while the hand laid blocks stops the act at the next hand's watch.
      settleTrack();
      endFight();
      host.actHandNow = undefined;
      dug += dugCountOf(bot, dugBefore);
      const handOps = motorOpsOf(bot) - opsBefore;
      const delta = eventsOf(index, [...made, ...(outcome.events ?? [])]);
      if (outcome.data?.eye) report.eye = outcome.data.eye;
      if (outcome.data?.container) report.container = outcome.data.container;
      if (typeof outcome.data?.arrowsLeft === 'number') report.arrowsLeft = outcome.data.arrowsLeft;
      if (outcome.ok) {
        if ((hand.do === 'walk' || hand.do === 'portal') && outcome.data?.crossedDimension) crossedByWalk = true;
        report.done++;
        const line = clip(`${outcome.text}（${((Date.now() - began) / 1000).toFixed(1)}秒）`);
        pushLine(index, 'done', line, finishedVerdict(outcome, handOps), handOps, {}, delta);
        remember(hand, 'done', line, outcome.at, base);
        emit(index, 'completed', outcome.text);
        continue;
      }
      // A hand that fails by itself may let the act go on (onFail); what stops the act from outside its hands (the signal aborted) and a full pack never do.
      const goesOn = !control.signal.aborted && outcome.reason !== 'inventory_full' && handContinuesOnFail(hand);
      if (goesOn) report.failureType ??= outcome.reason ?? 'failed';
      else if (!actFailed) {
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
      // go's, obsidian's and portal's lines are the contract's own ("<手> 止まった <code>: ...", the counts in it): the code is the closed word.
      const own = hand.do === 'obsidian' || hand.do === 'portal' || hand.do === 'vertical';
      const line = hand.do === 'go' ? clip(outcome.text) : own ? clip(outcome.text.startsWith(`${hand.do} 止まった`) ? outcome.text : `${hand.do} 止まった ${outcome.reason ?? 'failed'}: ${outcome.text}`) : stoppedLine(outcome.reason, outcome.text, outcome.at ? cellNow(bot, outcome.at) : undefined, outcome.cause, again);
      // A hand that stops the act by itself ended (finished) on its own: a cut is only what comes from outside.
      pushLine(index, goesOn ? 'failed' : 'stopped', line, finishedVerdict(outcome, handOps), handOps,
        { ...(outcome.at ? { where: outcome.at } : {}), ...(around ? { around } : {}) }, delta);
      remember(hand, goesOn ? 'failed' : 'stopped', line, outcome.at, base);
      emit(index, 'error', outcome.text);
      if (goesOn) continue;
      actFailed = true;
      if (control.signal.aborted || outcome.reason === 'inventory_full') { skip(index + 1); return false; }
    }
    return !actFailed;
  };
  /** What a pass changed, to tell a pass that did nothing: her cell, the pack, the blocks dug. */
  const signature = () => {
    const feet = feetCell(bot), pack = ((bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>).map(item => `${item.name}:${item.count}`).sort().join(',');
    return `${feet ? `${feet.x},${feet.y},${feet.z}` : '-'}|${pack}|${dug}`;
  };
  try {
    if (holdsDone()) finishDone();
    for (pass = 1; pass <= passes; pass++) {
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
  // The act's two axes (1): the goal from the hands' goals and what moved the body; the end from whether anything ran and whether it was cut from outside.
  const outside = !report.ok && stoppedFromOutside(report.stoppedBy);
  const ran = handRuns.some(run => run.ran);
  report.outcome = { goal: aggregateGoal(handRuns, doneMet), end: report.ok ? 'finished' : !ran ? 'not_run' : outside ? 'cut' : 'finished',
    ...(!report.ok && (outside || !ran) && report.stoppedBy ? { cutBy: outsideCut() } : {}) };
  const handover = handoverOf(bot);
  if (handover) report.handover = handover;
  keepActReport(bot, report);
  const text = renderActReport(bot, report);
  return report.ok ? { success: true, result: text } : { success: false, result: text, failureType: report.failureType ?? 'failed', recoverable: true };
}

export default Act;
