import { Entity } from 'prismarine-entity';
import { Bot as MineflayerBot } from 'mineflayer';
import InstantSkills from './instantSkills/instantSkills';
import ConstantSkills from './constantSkills/constantSkills';
import { Block } from 'prismarine-block';
import { goals } from 'prismarine-pathfinder';  
import Utils from './utils';

export type Goal = goals.Goal;

export type Hand = "hand" | "off-hand";

export type ToolCategory = "weapon" | "sword" | "axe" | "pickaxe" | "shovel" | "hoe" | "shears" | "bow" | "arrow" | "fishing rod" | "snowball" | "shield";

export type Material = "wood" | "stone" | "iron" | "diamond" | "gold" | "netherite";

export type ArmorCategory = "helmet" | "chestplate" | "leggings" | "boots" | "elytra";

export type Entity = Entity;

export type Entities = Entity[];

export type Block = Block;

export interface CustomBot extends MineflayerBot {
  isTest: boolean;
  chatMode: boolean;
  attackEntity: Entity | null;
  runFromEntity: Entity | null;
  goal: Goal | null;
  instantSkills: InstantSkills;
  constantSkills: ConstantSkills;
  utils: Utils;
}