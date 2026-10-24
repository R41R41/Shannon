/**
 * What fills the pack, for a skill refused for want of room. The body throws nothing away by itself (design mb-llm-centric): what goes,
 * and where, is the planner's; a full pack is told in the observation and in the refusal, with what fills it.
 */
import { describePack } from './inventoryTidy.js';

interface Stack { name: string; count: number; stackSize?: number }
export interface RoomBody { inventory: { items(): any[]; emptySlotCount?(): number } }

/** Why there is no room, for the refusal: what fills the pack, and what of it this call may not throw (`asked`). */
export function explainNoRoom(bot: RoomBody, asked: string[]): string {
  return `${describePack(bot.inventory.items() as Stack[], asked)}。`;
}
