#!/usr/bin/env node
// Model-free, no server: the LLM-centric body's map (utils/localMap) drawn from a saved world at a fixed place, for the scene replay of
// design mb-llm-centric 4 (verification 1). The text is the same the live body sends with every decision, so a scene's prompt can be
// made from a world copied off the server.
//
//   TS_NODE_TRANSPILE_ONLY=true node --loader ts-node/esm scripts/minebot-scene-map.ts --world <world dir> --at 201,45,277 \
//     [--dim overworld|the_nether|the_end] [--yaw <degrees, north 0 east 90>] [--mode auto|layers|top] \
//     [--view layers|top|slice|column] [--radius 7] [--axis x|z] [--version 1.21.11] [--scene <name>]
//
// --scene picks a place and a dimension from SCENES below (the six of the design; their coordinates are the runs' and are only a
// starting point: give --at to move one).
import minecraftData from 'minecraft-data';
import { openSavedWorld, type Dimension } from '../src/services/minebot/utils/anvilWorld.js';
import { drawColumn, drawLayers, drawLocalMap, drawSlice, drawTop, MAP_LEGEND } from '../src/services/minebot/utils/localMap.js';

/** The six scenes of the design (run 25 / run 24 places; the seed is -3217027361132446567 for run 25). */
const SCENES: Record<string, { at: [number, number, number]; dim: Dimension; yaw?: number; note: string }> = {
  'furnace-overhead': { at: [201, 45, 277], dim: 'overworld', note: '実走25 d=17: かまど (202,52,277) が7マス上' },
  'water-bank-573': { at: [0, 0, 0], dim: 'overworld', note: '実走25 573秒: 水の岸（座標は実走のログから入れる）' },
  'water-bank-806': { at: [0, 0, 0], dim: 'overworld', note: '実走25 806秒: 水の岸（座標は実走のログから入れる）' },
  'cave-edge': { at: [0, -7, 0], dim: 'overworld', note: '洞窟の縁 Y=-7（x・z は実走のログから）' },
  'water-at-head': { at: [0, 48, 0], dim: 'overworld', note: '頭の高さの隣が水 Y=48（x・z は実走のログから）' },
  'village': { at: [196, 69, 237], dim: 'overworld', note: '実走25 89秒: 村の回収' },
  'lava-pool': { at: [0, 0, 0], dim: 'overworld', note: '実走24 843秒: 溶岩の溜まり（座標は実走のログから）' },
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const scene = arg('scene') ? SCENES[arg('scene')!] : undefined;
if (arg('scene') && !scene) throw new Error(`unknown scene; one of: ${Object.keys(SCENES).join(', ')}`);
const world = arg('world');
if (!world) throw new Error('--world <saved world directory> is required');
const at = (arg('at') ?? scene?.at.join(',') ?? '').split(',').map(Number);
if (at.length !== 3 || !at.every(Number.isFinite)) throw new Error('--at x,y,z is required (or --scene)');
const dimension = (arg('dim') ?? scene?.dim ?? 'overworld') as Dimension;
const version = arg('version') ?? '1.21.11';
const data = minecraftData(version);
if (!data) throw new Error(`minecraft-data has no ${version}`);
const nbtModule: any = await import('prismarine-nbt');
const nbt = nbtModule.default ?? nbtModule;
const read = openSavedWorld(world, dimension, { nbt, solid: name => {
  const block = data.blocksByName[name];
  return block ? block.boundingBox === 'block' : undefined;
} });
const feet = { x: Math.floor(at[0]), y: Math.floor(at[1]), z: Math.floor(at[2]) };
const yawDegrees = Number(arg('yaw') ?? scene?.yaw ?? 0);
const yaw = -yawDegrees * Math.PI / 180;
const view = arg('view');
const radius = Number(arg('radius') ?? 7);
if (scene) console.log(`# ${arg('scene')}: ${scene.note}`);
if (!view) {
  const mode = (arg('mode') ?? 'auto') as 'auto' | 'layers' | 'top';
  console.log(drawLocalMap({ feet, yaw, read, dimension }, { mode }));
} else if (view === 'layers') {
  console.log(drawLayers({ read, self: feet, minX: feet.x - radius, maxX: feet.x + radius, minZ: feet.z - radius, maxZ: feet.z + radius,
    yFrom: Number(arg('yFrom') ?? feet.y - 2), yTo: Number(arg('yTo') ?? feet.y + 2) }));
} else if (view === 'top') {
  console.log(drawTop({ read, self: feet, minX: feet.x - radius, maxX: feet.x + radius, minZ: feet.z - radius, maxZ: feet.z + radius,
    feetY: feet.y, top: feet.y + 12, bottom: feet.y - 12 }));
} else if (view === 'slice') {
  console.log(drawSlice({ read, self: feet, center: feet, radius, yFrom: feet.y - radius, yTo: feet.y + radius, axis: arg('axis') === 'z' ? 'z' : 'x' }));
} else if (view === 'column') {
  console.log(drawColumn({ read, self: feet, x: feet.x, z: feet.z, yFrom: feet.y - 16, yTo: feet.y + 16 }));
}
if (process.argv.includes('--legend')) console.log(`凡例:\n${MAP_LEGEND}`);
