/**
 * Room in the pack, made before a skill is refused for want of it. Run 20 (a 99-level shaft and its tunnels filled the pack with tuff,
 * andesite, diorite and deepslate): the second mine-block was refused for "one free slot" after 69 s, drop-item answered "too narrow"
 * and the other three orders of that reply were never run, fill-area spent 60 s placing 34 tuff that freed no slot. What may be thrown
 * is utils/inventoryTidy's one table; this is the doing: skills that could be refused for a full pack (mine-block, craft-one, a dig that
 * collects, a stair that has dug a long way) call it first and only refuse, with the reason, when it could not.
 *
 * Skill-independent: the skill passes `call` (its own callSkill) and the checks that are its to make (a hostile near, an emergency).
 */
import { emptySlotCountSafe } from './inventorySpillDetection.js';
import { describePack, slotsUsed, spareRockToDrop, tidyPlan, TIDY_ABOVE } from './inventoryTidy.js';

export type RoomCall = (skill: string, ...args: any[]) => Promise<{ success?: boolean; result?: unknown; failureType?: string }>;
interface Stack { name: string; count: number; stackSize?: number }
export interface RoomBody { inventory: { items(): any[]; emptySlotCount?(): number } }

/** The least time worth throwing anything away with (a throw walks the body off and waits out the pickup delay). */
export const ROOM_TIME_MS = 8_000;
/** A tidy of several kinds needs this much of the action left. */
export const TIDY_TIME_MS = 40_000;

export interface RoomOptions {
  /** Kinds never thrown: what is being mined and what it drops. */
  asked?: string[];
  /** Free slots wanted (two at least are asked for). */
  slots: number;
  timeLeftMs?: number;
  /** True when throwing is not for now (a hostile near, an emergency). */
  blocked?: () => boolean;
  interrupted?: () => boolean;
  /** Throws tried at most. */
  rounds?: number;
}
export interface RoomOutcome {
  /** One sentence for the result, empty when nothing was thrown. */
  note: string;
  /** Slots gained. */
  freed: number;
  /** "tuff×49: why" for each throw that was refused. */
  refused: string[];
}

const refusalOf = (name: string, count: number, result: { result?: unknown; failureType?: string }) =>
  `${name}×${count}（${result.failureType ?? '失敗'}: ${String(result.result ?? '').slice(0, 90)}）`;

/**
 * With fewer than `slots` free (two at least), throws away what tidyPlan names, else the largest heap of spare rock (spareRockToDrop),
 * until there is room or nothing more can go. A kind whose throw was refused is not tried again, and the reason is kept for the refusal
 * the caller may still have to give (explainNoRoom).
 */
export async function makeRoom(bot: RoomBody, call: RoomCall, options: RoomOptions): Promise<RoomOutcome> {
  const free = () => emptySlotCountSafe(bot as any);
  const need = Math.max(2, options.slots);
  const started = free();
  const none: RoomOutcome = { note: '', freed: 0, refused: [] };
  if (started >= need || (options.timeLeftMs ?? Infinity) < ROOM_TIME_MS || options.blocked?.()) return none;
  const asked = options.asked ?? [];
  const gone: string[] = [];
  const refused: string[] = [];
  const skipped: string[] = [];
  for (let round = 0; round < (options.rounds ?? 3) && free() < need && !options.interrupted?.(); round++) {
    const items = bot.inventory.items() as Stack[];
    let plan: Array<{ name: string; count: number }> = [];
    try { plan = tidyPlan(items).filter(entry => !asked.includes(entry.name) && !skipped.includes(entry.name)).slice(0, 1); } catch { plan = []; }
    if (!plan.length) { const rock = spareRockToDrop(items, [...asked, ...skipped]); if (rock) plan = [rock]; }
    if (!plan.length) break;
    const { name, count } = plan[0];
    let dropped: { success?: boolean; result?: unknown; failureType?: string } = { success: false };
    try { dropped = await call('drop-item', name, count); } catch (error) { if (options.interrupted?.()) throw error; break; }
    if (dropped.success) { gone.push(`${name}×${count}`); continue; }
    refused.push(refusalOf(name, count, dropped));
    skipped.push(name);
    // Nowhere to throw is the same for every kind: the next would be refused in the same place.
    if (dropped.failureType === 'no_room_to_drop' || dropped.failureType === 'picked_up_again') break;
  }
  const freed = free() - started;
  return {
    note: gone.length ? ` 掘る前に持ち物の空きを作るため、${gone.join('・')}を捨てました（空き${free()}マス）` : '',
    freed, refused,
  };
}

/**
 * Past TIDY_ABOVE of the 36 slots taken, throws away what tidyPlan names (two kinds at most, down to the table's target), not what
 * `asked` names. Says what went; empty when nothing did. Not with a hostile near, in an emergency, or with under TIDY_TIME_MS left.
 */
export async function tidyPackNow(bot: RoomBody, call: RoomCall, options: { asked?: string[]; timeLeftMs?: number; blocked?: () => boolean; interrupted?: () => boolean }): Promise<string> {
  if ((options.timeLeftMs ?? Infinity) < TIDY_TIME_MS || options.blocked?.()) return '';
  const asked = options.asked ?? [];
  let plan: ReturnType<typeof tidyPlan> = [];
  try { plan = tidyPlan(bot.inventory.items() as Stack[]).filter(entry => !asked.includes(entry.name)); } catch { plan = []; }
  if (!plan.length || options.interrupted?.()) return '';
  const before = slotsUsed(bot.inventory.items() as Stack[]);
  const gone: string[] = [];
  for (const { name, count } of plan.slice(0, 2)) {
    let dropped: { success?: boolean; failureType?: string } = { success: false };
    try { dropped = await call('drop-item', name, count); } catch { break; }
    if (dropped.success) gone.push(`${name}×${count}`);
    if (dropped.failureType === 'no_room_to_drop' || options.interrupted?.()) break;
  }
  return gone.length ? ` 持ち物が${before}/36マス埋まっていたため、${gone.join('・')}を捨てました（いま${slotsUsed(bot.inventory.items() as Stack[])}マス）` : '';
}

/** Whether the pack is past the point where tidyPackNow would act. */
export function packNeedsTidy(bot: RoomBody): boolean {
  return slotsUsed(bot.inventory.items() as Stack[]) > TIDY_ABOVE;
}

/** Why no room could be made, for the refusal: what fills the pack, what may not be thrown, and the throws that were refused. */
export function explainNoRoom(bot: RoomBody, asked: string[], refused: string[]): string {
  return `${describePack(bot.inventory.items() as Stack[], asked)}。`
    + (refused.length ? `捨てようとして断られた: ${refused.join('、')}。` : '');
}
