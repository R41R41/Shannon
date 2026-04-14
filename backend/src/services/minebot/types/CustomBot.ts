import { Bot, BotEvents, Dimension } from 'mineflayer';
import { CommandManager } from 'mineflayer-cmd';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Block } from 'prismarine-block';
import { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { Utils } from '../utils/index.js';
import type { InstantSkills, ConstantSkills } from './collections.js';

export type Goal = pathfinderPkg.goals.Goal;

export type Hand = 'hand' | 'off-hand';

export type ToolCategory =
  | 'weapon'
  | 'sword'
  | 'pickaxe'
  | 'shovel'
  | 'hoe'
  | 'shears'
  | 'bow'
  | 'arrow'
  | 'fishing rod'
  | 'snowball'
  | 'shield';

export type Material =
  | 'wood'
  | 'stone'
  | 'iron'
  | 'diamond'
  | 'gold'
  | 'netherite';

export type ArmorCategory =
  | 'helmet'
  | 'chestplate'
  | 'leggings'
  | 'boots'
  | 'elytra';

// BotEventsを拡張
interface CustomBotEvents extends BotEvents {
  [key: `taskPer${number}ms`]: () => void;
}

export type DroppedItem = {
  isDroppedItem: boolean;
  name: string;
  position: Vec3 | null;
  metadata: any;
};

export interface ActiveFurnace {
  pos: { x: number; y: number; z: number };
  item: string;
  count: number;
  /** 精錬完了の予想タイムスタンプ (Date.now() + 所要ms) */
  readyAt: number;
  /** 精錬開始時刻 */
  startedAt: number;
}

// CustomBotの定義を更新
export interface CustomBot extends Omit<Bot, 'on' | 'once' | 'emit'> {
  on<K extends keyof CustomBotEvents>(
    event: K,
    listener: CustomBotEvents[K]
  ): CustomBot;
  once<K extends keyof CustomBotEvents>(
    event: K,
    listener: CustomBotEvents[K]
  ): CustomBot;
  emit<K extends keyof CustomBotEvents>(
    event: K,
    ...args: Parameters<CustomBotEvents[K]>
  ): boolean;
  isTest: boolean;
  chatMode: boolean;
  connectedServerName: string;
  attackEntity: Entity | null;
  runFromEntity: Entity | null;
  goal: Goal | null;
  instantSkills: InstantSkills;
  constantSkills: ConstantSkills;
  utils: Utils;
  isInWater: boolean;
  cmd: CommandManager;
  executingSkill: boolean;
  interruptExecution: boolean;  // フィードバック到着時にスキル実行を中断するフラグ
  /** Minebot タスク優先（単一ルールの可視化）。未設定時は通常運用 */
  minebotControlState?: 'idle' | 'main_task' | 'emergency_reflect' | 'emergency_llm';
  /** true の間はゲーム内 chat を送らない（UI Mod 通知は可）。緊急タスク用 */
  suppressMinebotGameChat?: boolean;
  /** 精錬中のかまど追跡。start-smelting で登録し withdraw-from-furnace で削除 */
  activeFurnaces: ActiveFurnace[];
  environmentState: {
    senderName: string;
    senderPosition: Vec3 | null;
    weather: string;
    time: string;
    biome: string;
    dimension: Dimension | null;
    bossbar: string | null;
  };
  selfState: {
    botPosition: Vec3 | null;
    botHealth: string;
    botFoodLevel: string;
    botExperienceLevel: number;
    botTotalExperience: number;
    botExperienceBarProgress: number;
    botHeldItem: string;
    lookingAt: Block | Entity | DroppedItem | null;
    inventory: Array<{
      name: string;
      count: number;
      durabilityRemaining?: number;
      durabilityMax?: number;
    }>;
  };
}

export type ResponseType = {
  success: boolean;
  result: string;
};

// 旧Param型（後方互換性のため保持）
export type Param = {
  name: string;
  description: string;
  type: string;
  default?: string | number | boolean | null;
  required?: boolean;
};
