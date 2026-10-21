import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BlockReader, MapBlock } from './localMap.js';

/**
 * A saved world read from its region files, as the map's `BlockReader` (design mb-llm-centric 4, scene replay): the same drawing the
 * live body makes, made from a world copied off the server, at any place, without a server or a body. For 1.18+ chunks (sections with
 * `block_states`: a palette and packed longs). A chunk not generated, or a region file missing, reads as not loaded (`null`).
 *
 *   const read = openSavedWorld('/path/to/world', 'overworld', { nbt: prismarineNbt, solid });
 *   drawLocalMap({ feet: { x: 201, y: 45, z: 277 }, read })
 */
export type Dimension = 'overworld' | 'the_nether' | 'the_end';
interface Section { palette: MapBlock[]; data: bigint[] | null; bits: number }
interface Chunk { sections: Map<number, Section> }

const regionDir = (world: string, dimension: Dimension) => dimension === 'the_nether' ? path.join(world, 'DIM-1', 'region')
  : dimension === 'the_end' ? path.join(world, 'DIM1', 'region') : path.join(world, 'region');

function toBig(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (Array.isArray(value) && value.length === 2) return (BigInt(value[0] as number) << 32n) | BigInt((value[1] as number) >>> 0);
  return BigInt(Number(value ?? 0));
}

/** Reads one chunk's sections out of a region file's bytes (null when the chunk is not there). */
export function readChunk(region: Buffer, chunkX: number, chunkZ: number, parseNbt: (data: Buffer) => any, toMapBlock: (entry: any) => MapBlock): Chunk | null {
  const index = (chunkX & 31) + (chunkZ & 31) * 32;
  const location = region.readUInt32BE(index * 4);
  const offset = (location >>> 8) * 4096, sectors = location & 0xff;
  if (!offset || !sectors || offset + 5 > region.length) return null;
  const length = region.readUInt32BE(offset);
  const compression = region.readUInt8(offset + 4);
  const body = region.subarray(offset + 5, offset + 4 + length);
  const raw = compression === 2 ? zlib.inflateSync(body) : compression === 1 ? zlib.gunzipSync(body) : compression === 3 ? body : null;
  if (!raw) return null;
  const root = parseNbt(raw);
  const sections = new Map<number, Section>();
  for (const section of (root.sections ?? root.Level?.sections ?? []) as any[]) {
    const states = section.block_states;
    if (!states?.palette) continue;
    const palette = (states.palette as any[]).map(toMapBlock);
    const data = Array.isArray(states.data) ? (states.data as unknown[]).map(toBig) : null;
    sections.set(Number(section.Y), { palette, data, bits: Math.max(4, Math.ceil(Math.log2(palette.length))) });
  }
  return { sections };
}

/** The block at a cell of a section (x, y, z within 0-15). */
export function sectionBlock(section: Section, x: number, y: number, z: number): MapBlock {
  if (!section.data || section.palette.length === 1) return section.palette[0];
  const index = (y << 8) | (z << 4) | x;
  const perLong = Math.floor(64 / section.bits);
  const word = section.data[Math.floor(index / perLong)] ?? 0n;
  const shift = BigInt((index % perLong) * section.bits);
  const id = Number((word >> shift) & ((1n << BigInt(section.bits)) - 1n));
  return section.palette[id] ?? { name: 'air', solid: false };
}

/**
 * A reader over a saved world. `solid` says whether a block name stops a body (from the game's data: minecraft-data's boundingBox);
 * without it, the map's own guess by the name is used.
 */
export interface NbtLike { parseUncompressed(data: Buffer, format?: string): unknown; simplify(tag: unknown): any }
export function openSavedWorld(world: string, dimension: Dimension, options: { nbt: NbtLike; solid?: (name: string) => boolean | undefined }): BlockReader {
  // The NBT reader is handed in (prismarine-nbt in the script): the body and the map's tests never load it.
  const parse = (data: Buffer) => options.nbt.simplify(options.nbt.parseUncompressed(data, 'big'));
  const toMapBlock = (entry: any): MapBlock => {
    const name = String(entry?.Name ?? 'minecraft:air').replace(/^minecraft:/u, '');
    const properties = entry?.Properties ?? {};
    const block: MapBlock = { name };
    const solid = options.solid?.(name);
    if (typeof solid === 'boolean') block.solid = solid;
    if (properties.level !== undefined) block.level = Number(properties.level);
    if (properties.eye !== undefined) block.eye = properties.eye === 'true' || properties.eye === true;
    return block;
  };
  const regions = new Map<string, Buffer | null>();
  const chunks = new Map<string, Chunk | null>();
  const dir = regionDir(world, dimension);
  return (x, y, z) => {
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const key = `${cx},${cz}`;
    let chunk = chunks.get(key);
    if (chunk === undefined) {
      const rx = Math.floor(cx / 32), rz = Math.floor(cz / 32);
      const file = `r.${rx}.${rz}.mca`;
      let region = regions.get(file);
      if (region === undefined) {
        try { region = fs.readFileSync(path.join(dir, file)); } catch { region = null; }
        regions.set(file, region);
      }
      try { chunk = region ? readChunk(region, cx, cz, parse, toMapBlock) : null; } catch { chunk = null; }
      chunks.set(key, chunk);
    }
    if (!chunk) return null;
    const section = chunk.sections.get(Math.floor(y / 16));
    if (!section) return { name: 'air', solid: false };
    return sectionBlock(section, ((x % 16) + 16) % 16, ((y % 16) + 16) % 16, ((z % 16) + 16) % 16);
  };
}
