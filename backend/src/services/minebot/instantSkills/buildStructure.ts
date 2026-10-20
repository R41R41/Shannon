import fs from 'fs';
import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { CONFIG } from '../config/MinebotConfig.js';
import { actionDelay } from '../execution/observedWait.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:buildStructure');

/* ------------------------------------------------------------------ */
/*  Blueprint types                                                    */
/* ------------------------------------------------------------------ */

interface Blueprint {
  name: string;
  description: string;
  materials: Record<string, string>;
  /** layers[y][z] = "row string"; each char = block at that x */
  layers: string[][];
  afterBuild?: AfterBuildAction[];
}

interface AfterBuildAction {
  type: 'use_item';
  item: string;
  /** [col, layer, row] in local coords */
  offset: [number, number, number];
}

interface BlockPlacement {
  worldPos: Vec3;
  blockName: string;
}

const SCAFFOLD_CANDIDATES = ['dirt', 'cobblestone', 'stone', 'netherrack', 'cobbled_deepslate', 'deepslate'];

/* ------------------------------------------------------------------ */
/*  Rotation helpers                                                   */
/* ------------------------------------------------------------------ */

type Dir = 'north' | 'south' | 'east' | 'west';

/**
 * Rotate a blueprint while keeping its entire footprint in the positive local
 * quadrant. The public API defines origin as the lower bounding-box corner;
 * rotating around (0,0) made south/east builds unexpectedly extend into
 * negative coordinates and contradicted that contract.
 */
function rotateLocalFromOrigin(
  col: number,
  row: number,
  facing: Dir,
  width: number,
  depth: number,
): [number, number] {
  switch (facing) {
    case 'north': return [col, row];
    case 'east':  return [depth - 1 - row, col];
    case 'south': return [width - 1 - col, depth - 1 - row];
    case 'west':  return [row, width - 1 - col];
  }
}

function facingFromYaw(yaw: number): Dir {
  const n = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (n >= 0.25 * Math.PI && n < 0.75 * Math.PI)  return 'west';
  if (n >= 0.75 * Math.PI && n < 1.25 * Math.PI)  return 'north';
  if (n >= 1.25 * Math.PI && n < 1.75 * Math.PI)  return 'east';
  return 'south';
}

/* ------------------------------------------------------------------ */
/*  Skill                                                              */
/* ------------------------------------------------------------------ */

class BuildStructure extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'build-structure';
    this.description =
      '事前登録された構造物（例: nether_portal）を指定座標に建築します。'
      + '材料がインベントリに揃っている必要があります。'
      // The portal's recipe and its lighting were known only to the old planner's knowledge (a common FCA run asked).
      + 'nether_portal は黒曜石10個（4×5の枠、角なし）。flint_and_steel を持っていれば完成後に着火を試みる（点いたかは観測で確かめる）。'
      + '黒曜石はダイヤのつるはしで掘る（溶岩に水をかけてその場で作れる）。slit_cage・slit_shelter は build-around-self で使う';
    this.params = [
      {
        name: 'structureName',
        type: 'string',
        description: '構造物名（例: nether_portal）。利用可能一覧はスキル呼び出し時に表示',
        required: true,
      },
      {
        name: 'x',
        type: 'number',
        description: '建築原点 X 座標（構造物の左下手前の角）',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: '建築原点 Y 座標（底面の高さ）',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: '建築原点 Z 座標',
        required: true,
      },
      {
        name: 'facing',
        type: 'string',
        description: '構造物の向き (north/south/east/west)。省略時はボットの向きから自動判定',
        required: false,
      },
    ];
  }

  /* ============================================================== */

  async runImpl(
    structureName: string,
    x: number,
    y: number,
    z: number,
    facing?: string,
  ) {
    const bp = this.loadBlueprint(structureName);
    if (!bp) {
      const avail = this.listBlueprints();
      return {
        success: false,
        result: `構造物「${structureName}」が見つかりません。利用可能: ${avail.join(', ') || 'なし'}`,
        failureType: 'invalid_input' as const,
        recoverable: false,
      };
    }

    const dir = this.resolveFacing(facing);
    const origin = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const placements = this.resolvePositions(bp, origin, dir);

    const matCheck = this.checkMaterials(bp, placements);
    if (!matCheck.ok) {
      return { success: false, result: matCheck.message, failureType: 'missing_item' as const, recoverable: true };
    }

    log.info(`🏗️ ${bp.name} 建築開始 @ (${origin.x}, ${origin.y}, ${origin.z}) 向き=${dir}  ブロック数=${placements.length}`);

    // 障害物を先に除去
    for (const pl of placements) {
      if (this.shouldInterrupt()) break;
      const existing = this.bot.blockAt(pl.worldPos);
      if (existing && existing.boundingBox !== 'empty' && existing.name !== pl.blockName) {
        log.info(`🧹 障害物除去: ${existing.name} @ ${pl.worldPos}`);
        await this.digBlock(pl.worldPos);
      }
    }
    // The cells the frame encloses are dug out too: a portal built into rock has stone inside it, and neither lights nor lets the body
    // through (the inside of a blueprint is '.', which was never touched). Only for a portal: a house's inside holds its furniture.
    const enclosed = /portal/.test(structureName) ? this.enclosedCells(bp, origin, dir) : [];
    // Where the body must not stand while it builds: the frame and the inside it encloses (see stepAside).
    this.buildCells = [...placements.map(pl => pl.worldPos), ...enclosed];
    for (const inside of enclosed) {
      if (this.shouldInterrupt()) break;
      const existing = this.bot.blockAt(inside);
      if (existing && existing.boundingBox !== 'empty' && !['water', 'lava'].includes(existing.name)) {
        log.info(`🧹 内側の除去: ${existing.name} @ ${inside}`);
        await this.digBlock(inside);
      }
    }

    let placed = 0;
    const total = placements.length;
    const failed: { pos: Vec3; blockName: string }[] = [];
    const scaffolds: { pos: Vec3; blockName: string }[] = [];

    for (const pl of placements) {
      if (this.shouldInterrupt()) break;

      const existing = this.bot.blockAt(pl.worldPos);
      if (existing && existing.name === pl.blockName) {
        placed++;
        continue;
      }

      const ok = await this.placeOneBlockWithScaffold(pl, scaffolds);
      if (ok) { placed++; } else { failed.push({ pos: pl.worldPos, blockName: pl.blockName }); }
    }
    // Once more for each that failed, now that the rest stands (the body has moved and the faces around it are there).
    for (const miss of [...failed]) {
      if (this.shouldInterrupt()) break;
      const done = this.bot.blockAt(miss.pos)?.name === miss.blockName
        || await this.placeOneBlockWithScaffold({ worldPos: miss.pos, blockName: miss.blockName }, scaffolds);
      if (done) { placed++; failed.splice(failed.indexOf(miss), 1); }
    }

    // スカフォールド撤去
    if (scaffolds.length > 0) {
      log.info(`🧹 スカフォールド撤去: ${scaffolds.length} ブロック`);
      for (const s of scaffolds.reverse()) {
        const block = this.bot.blockAt(s.pos);
        if (block && block.name === s.blockName) {
          await this.digBlock(s.pos);
        }
      }
    }

    if (placed === total && bp.afterBuild) {
      for (const action of bp.afterBuild) {
        await this.executeAfterBuild(action, bp, origin, dir);
      }
    }

    const posStr = `(${origin.x}, ${origin.y}, ${origin.z})`;
    if (placed === total) {
      return { success: true, result: `${bp.name} を ${posStr} に建築完了（${placed} ブロック設置）` };
    }

    const allBlocks = placements.map(p => {
      const isFailed = failed.some(f => f.pos.x === p.worldPos.x && f.pos.y === p.worldPos.y && f.pos.z === p.worldPos.z);
      return `  ${isFailed ? '[ ]' : '[✓]'} ${p.blockName} (${p.worldPos.x},${p.worldPos.y},${p.worldPos.z})`;
    });
    const failedCommands = failed.map(
      f => `  place-block-at ${f.blockName} ${f.pos.x} ${f.pos.y} ${f.pos.z}`,
    );
    const hint = [
      `\n全ブロック配置図（下層から順、[ ]が未設置）:`,
      ...allBlocks,
      `\n手動設置コマンド（必ずY座標の小さい順＝下から設置）:`,
      ...failedCommands,
      `注意: 上記座標以外にブロックを置かないでください。参照ブロックがない場合はまず真下に仮ブロックを置いてから設置し、後で仮ブロックを掘ってください。`,
    ].join('\n');
    // Short of the whole is not built: a portal of nine blocks neither lights nor is a gate (a ladder probe, 2026-10-20, was told
    // success with one block of its frame missing).
    return {
      success: false,
      result: `${bp.name} 建築: ${placed}/${total} ブロック設置（${posStr}）。未完成のため着火していません。${hint}`,
      failureType: placed === 0 ? ('place_failed' as const) : ('partial_completion' as const),
      recoverable: true,
    };
  }

  /* ============================================================== */
  /*  Blueprint I/O                                                  */
  /* ============================================================== */

  private loadBlueprint(name: string): Blueprint | null {
    try {
      const raw = fs.readFileSync(`${CONFIG.STRUCTURES_DIR}/${name}.json`, 'utf-8');
      return JSON.parse(raw) as Blueprint;
    } catch {
      return null;
    }
  }

  private listBlueprints(): string[] {
    try {
      return fs.readdirSync(CONFIG.STRUCTURES_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  /* ============================================================== */
  /*  Position / material resolution                                 */
  /* ============================================================== */

  private resolveFacing(raw?: string): Dir {
    const v = raw?.toLowerCase();
    if (v === 'north' || v === 'south' || v === 'east' || v === 'west') return v;
    return facingFromYaw(this.bot.entity.yaw);
  }

  private resolvePositions(bp: Blueprint, origin: Vec3, facing: Dir): BlockPlacement[] {
    const out: BlockPlacement[] = [];
    const width = Math.max(1, ...bp.layers.flat().map(row => row.length));
    const depth = Math.max(1, ...bp.layers.map(layer => layer.length));
    for (let layerIdx = 0; layerIdx < bp.layers.length; layerIdx++) {
      const layer = bp.layers[layerIdx];
      for (let rowIdx = 0; rowIdx < layer.length; rowIdx++) {
        const row = layer[rowIdx];
        for (let colIdx = 0; colIdx < row.length; colIdx++) {
          const ch = row[colIdx];
          if (ch === '.') continue;
          const blockName = bp.materials[ch];
          if (!blockName) continue;
          const [dx, dz] = rotateLocalFromOrigin(colIdx, rowIdx, facing, width, depth);
          out.push({ worldPos: origin.offset(dx, layerIdx, dz), blockName });
        }
      }
    }
    return out;
  }

  /**
   * The empty cells ('.') a frame encloses: with a material cell to their left and right in their row, and above and below in their
   * column (other layers). A portal's 2×3 inside; nothing for a blueprint without a frame.
   */
  enclosedCells(bp: Blueprint, origin: Vec3, facing: Dir): Vec3[] {
    const width = Math.max(1, ...bp.layers.flat().map(row => row.length));
    const depth = Math.max(1, ...bp.layers.map(layer => layer.length));
    const filled = (layer: number, row: number, col: number) => {
      const ch = bp.layers[layer]?.[row]?.[col];
      return !!ch && ch !== '.' && !!bp.materials[ch];
    };
    const out: Vec3[] = [];
    for (let layer = 0; layer < bp.layers.length; layer++) {
      for (let row = 0; row < bp.layers[layer].length; row++) {
        const line = bp.layers[layer][row];
        for (let col = 0; col < line.length; col++) {
          if (filled(layer, row, col)) continue;
          const left = [...Array(col).keys()].some(c => filled(layer, row, c));
          const right = [...Array(line.length).keys()].some(c => c > col && filled(layer, row, c));
          const below = [...Array(layer).keys()].some(l => filled(l, row, col));
          const above = [...Array(bp.layers.length).keys()].some(l => l > layer && filled(l, row, col));
          if (!(left && right && below && above)) continue;
          const [dx, dz] = rotateLocalFromOrigin(col, row, facing, width, depth);
          out.push(origin.offset(dx, layer, dz));
        }
      }
    }
    return out;
  }

  private checkMaterials(bp: Blueprint, placements: BlockPlacement[]): { ok: boolean; message: string } {
    const needed = new Map<string, number>();
    for (const p of placements) {
      const ex = this.bot.blockAt(p.worldPos);
      if (ex && ex.name === p.blockName) continue;
      needed.set(p.blockName, (needed.get(p.blockName) ?? 0) + 1);
    }

    if (bp.afterBuild) {
      for (const a of bp.afterBuild) {
        if (a.type === 'use_item' && a.item) {
          needed.set(a.item, (needed.get(a.item) ?? 0) + 1);
        }
      }
    }

    const inv = new Map<string, number>();
    for (const it of this.bot.inventory.items()) {
      inv.set(it.name, (inv.get(it.name) ?? 0) + it.count);
    }

    const missing: string[] = [];
    for (const [name, count] of needed) {
      const have = inv.get(name) ?? 0;
      if (have < count) missing.push(`${name}: ${have}/${count}`);
    }

    if (missing.length) return { ok: false, message: `材料不足 — ${missing.join(', ')}` };
    return { ok: true, message: '' };
  }

  /* ============================================================== */
  /*  Block placement                                                */
  /* ============================================================== */

  private async placeOneBlockWithScaffold(pl: BlockPlacement, scaffolds: { pos: Vec3; blockName: string }[]): Promise<boolean> {
    const MAX_REACH = 4.5;

    if (this.bot.entity.position.distanceTo(pl.worldPos) > MAX_REACH) {
      try {
        await gotoSafe(
          this.bot,
          new goals.GoalNear(pl.worldPos.x, pl.worldPos.y, pl.worldPos.z, 3),
          { timeoutMs: 8000, stuckAbortCount: 3 },
        );
      } catch {
        log.warn(`⚠ 移動失敗 → ${pl.worldPos}`);
        return false;
      }
    }

    if (this.needStepAside(pl.worldPos)) {
      const moved = await this.stepAside(pl.worldPos);
      if (!moved) { log.warn(`⚠ 退避失敗 → ${pl.worldPos}`); return false; }
    }

    const item = this.bot.inventory.items().find(i => i.name === pl.blockName);
    if (!item) { log.warn(`⚠ ${pl.blockName} が不足`); return false; }

    try { await this.bot.equip(item, 'hand'); } catch { return false; }

    let ref = this.findRef(pl.worldPos);

    // 参照ブロックがない → スカフォールド設置
    if (!ref) {
      const scaffoldPlaced = await this.placeScaffold(pl.worldPos, scaffolds);
      if (!scaffoldPlaced) {
        log.warn(`⚠ 参照ブロックなし＆スカフォールド設置失敗 → ${pl.worldPos}`);
        return false;
      }
      // スカフォールド設置後に元のブロックを再装備
      const reItem = this.bot.inventory.items().find(i => i.name === pl.blockName);
      if (!reItem) { log.warn(`⚠ ${pl.blockName} が不足`); return false; }
      try { await this.bot.equip(reItem, 'hand'); } catch { return false; }
      ref = this.findRef(pl.worldPos);
      if (!ref) { log.warn(`⚠ スカフォールド後も参照ブロックなし → ${pl.worldPos}`); return false; }
    }

    try {
      await this.bot.placeBlock(ref.block, ref.face);
      await this.sleep(120);
      return true;
    } catch (e) {
      log.warn(`⚠ 設置失敗 (${pl.worldPos}): ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  private findScaffoldItem(): { item: any; name: string } | null {
    for (const candidate of SCAFFOLD_CANDIDATES) {
      const item = this.bot.inventory.items().find(i => i.name === candidate);
      if (item) return { item, name: candidate };
    }
    return null;
  }

  private async placeScaffold(targetPos: Vec3, scaffolds: { pos: Vec3; blockName: string }[]): Promise<boolean> {
    let groundY = targetPos.y - 1;
    while (groundY >= targetPos.y - 32) {
      const below = this.bot.blockAt(new Vec3(targetPos.x, groundY, targetPos.z));
      if (below && below.boundingBox !== 'empty') break;
      groundY--;
    }
    if (groundY < targetPos.y - 32) {
      log.warn(`⚠ スカフォールド: 地面が見つからない (${targetPos})`);
      return false;
    }

    for (let y = groundY + 1; y <= targetPos.y - 1; y++) {
      const scaffPos = new Vec3(targetPos.x, y, targetPos.z);
      const existing = this.bot.blockAt(scaffPos);
      if (existing && existing.boundingBox !== 'empty') continue;

      const scaff = this.findScaffoldItem();
      if (!scaff) {
        log.warn(`⚠ スカフォールド用ブロックがインベントリにない (候補: ${SCAFFOLD_CANDIDATES.join(', ')})`);
        return false;
      }

      if (this.bot.entity.position.distanceTo(scaffPos) > 4.5) {
        try {
          await gotoSafe(this.bot, new goals.GoalNear(scaffPos.x, scaffPos.y, scaffPos.z, 3), { timeoutMs: 5000, stuckAbortCount: 3 });
        } catch { return false; }
      }

      if (this.needStepAside(scaffPos)) {
        const moved = await this.stepAside(scaffPos);
        if (!moved) return false;
      }

      try { await this.bot.equip(scaff.item, 'hand'); } catch { return false; }

      const ref = this.findRef(scaffPos);
      if (!ref) { log.warn(`⚠ スカフォールド参照なし @ ${scaffPos}`); return false; }

      try {
        await this.bot.placeBlock(ref.block, ref.face);
        await this.sleep(120);
        scaffolds.push({ pos: scaffPos, blockName: scaff.name });
        log.info(`🪜 スカフォールド設置: ${scaff.name} @ ${scaffPos}`);
      } catch (e) {
        log.warn(`⚠ スカフォールド設置失敗: ${scaffPos}: ${e instanceof Error ? e.message : e}`);
        return false;
      }
    }
    return true;
  }

  private async digBlock(pos: Vec3): Promise<boolean> {
    const block = this.bot.blockAt(pos);
    if (!block || block.boundingBox === 'empty') return true;
    let result = await this.callSkill('dig-block-at', pos.x, pos.y, pos.z, false);
    // Out of reach from where the body stands (a frame cell high up the far side): a walk to within reach, and once more. Left
    // standing, the cell made its obsidian fail "something may be standing in that cell" (ladder probe 2026-10-20, 9/10 placed).
    if (!result.success && result.failureType === 'distance_too_far') {
      try { await gotoSafe(this.bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { timeoutMs: 8000 }); } catch { /* judged by the dig */ }
      result = await this.callSkill('dig-block-at', pos.x, pos.y, pos.z, false);
    }
    if (!result.success) {
      log.warn(`⚠ 掘削失敗 (${pos}): ${result.result}`);
    }
    return result.success;
  }

  private needStepAside(target: Vec3): boolean {
    const bx = Math.floor(this.bot.entity.position.x);
    const by = Math.floor(this.bot.entity.position.y);
    const bz = Math.floor(this.bot.entity.position.z);
    return target.x === bx && target.z === bz && (target.y === by || target.y === by + 1);
  }

  /** The frame and its inside, for the build in hand (set by runImpl). */
  private buildCells: Vec3[] = [];

  /**
   * Out of the cell to be filled, to a stand off the frame and its inside: the nearest of those within two blocks across and one up
   * or down, nearest first, four tried. None free: a pocket two high is dug beside, off the frame. A body that had dug a portal's inside
   * stood in its bottom row, and the four cells beside it were frame or rock (ladder probe 2026-10-20: 9 of 10).
   */
  async stepAside(target: Vec3): Promise<boolean> {
    const liquid = (block: any) => ['water', 'lava', 'flowing_water', 'flowing_lava'].includes(block?.name ?? '');
    const onFrame = (at: Vec3) => this.buildCells.some(cell => cell.x === at.x && cell.y === at.y && cell.z === at.z);
    const feetY = Math.floor(this.bot.entity.position.y);
    const out = () => { const p = this.bot.entity.position; return Math.floor(p.x) !== target.x || Math.floor(p.z) !== target.z; };
    const stands: Vec3[] = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, -1, 1]) {
      if (!dx && !dz) continue;
      const dest = new Vec3(target.x + dx, feetY + dy, target.z + dz);
      const ground = this.bot.blockAt(dest.offset(0, -1, 0)), feet = this.bot.blockAt(dest), head = this.bot.blockAt(dest.offset(0, 1, 0));
      if (onFrame(dest) || onFrame(dest.offset(0, 1, 0)) || !ground || ground.boundingBox === 'empty' || liquid(ground)) continue;
      if (feet?.boundingBox !== 'empty' || head?.boundingBox !== 'empty' || liquid(feet) || liquid(head)) continue;
      stands.push(dest);
    }
    const from = this.bot.entity.position;
    stands.sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(from) - b.offset(0.5, 0, 0.5).distanceTo(from));
    for (const dest of stands.slice(0, 4)) {
      try { await gotoSafe(this.bot, new goals.GoalBlock(dest.x, dest.y, dest.z), { timeoutMs: 4000, stuckAbortCount: 2 }); } catch { /* the next */ }
      await this.sleep(150);
      if (out()) return true;
    }
    // A pocket: the feet and head cells of a side off the frame, dug, then stepped into.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const dest = new Vec3(target.x + dx, feetY, target.z + dz);
      const ground = this.bot.blockAt(dest.offset(0, -1, 0));
      if (onFrame(dest) || onFrame(dest.offset(0, 1, 0)) || !ground || ground.boundingBox === 'empty') continue;
      const cells = [dest, dest.offset(0, 1, 0)];
      if (cells.some(cell => liquid(this.bot.blockAt(cell)) || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => liquid(this.bot.blockAt(cell.offset(x, 0, z)))))) continue;
      for (const cell of cells) if (this.bot.blockAt(cell)?.boundingBox !== 'empty') await this.digBlock(cell);
      if (cells.some(cell => this.bot.blockAt(cell)?.boundingBox !== 'empty')) continue;
      try { await gotoSafe(this.bot, new goals.GoalBlock(dest.x, dest.y, dest.z), { timeoutMs: 4000, stuckAbortCount: 2 }); } catch { /* judged below */ }
      await this.sleep(150);
      if (out()) return true;
    }
    return false;
  }

  private findRef(targetPos: Vec3): { block: any; face: Vec3 } | null {
    const offsets: [number, number, number, number, number, number][] = [
      [0, -1, 0,   0, 1, 0],
      [1, 0, 0,   -1, 0, 0],
      [-1, 0, 0,   1, 0, 0],
      [0, 0, 1,    0, 0,-1],
      [0, 0,-1,    0, 0, 1],
      [0, 1, 0,    0,-1, 0],
    ];
    for (const [ox, oy, oz, fx, fy, fz] of offsets) {
      const c = this.bot.blockAt(targetPos.offset(ox, oy, oz));
      if (c && c.boundingBox !== 'empty') {
        return { block: c, face: new Vec3(fx, fy, fz) };
      }
    }
    return null;
  }

  /* ============================================================== */
  /*  After-build actions                                            */
  /* ============================================================== */

  private async executeAfterBuild(
    action: AfterBuildAction,
    bp: Blueprint,
    origin: Vec3,
    facing: Dir,
  ): Promise<void> {
    if (action.type !== 'use_item') return;

    const width = Math.max(1, ...bp.layers.flat().map(row => row.length));
    const depth = Math.max(1, ...bp.layers.map(layer => layer.length));
    const [dx, dz] = rotateLocalFromOrigin(
      action.offset[0], action.offset[2], facing, width, depth,
    );
    const targetAir = origin.offset(dx, action.offset[1], dz);

    const item = this.bot.inventory.items().find(i => i.name === action.item);
    if (!item) { log.warn(`⚠ afterBuild: ${action.item} なし`); return; }

    try {
      await this.bot.equip(item, 'hand');
    } catch {
      log.warn(`⚠ afterBuild: ${action.item} 装備失敗`);
      return;
    }

    if (this.bot.entity.position.distanceTo(targetAir) > 4.5) {
      try {
        await gotoSafe(
          this.bot,
          new goals.GoalNear(targetAir.x, targetAir.y, targetAir.z, 3),
          { timeoutMs: 5000, stuckAbortCount: 3 },
        );
      } catch { /* best effort */ }
    }

    const ref = this.findRef(targetAir);
    if (!ref) { log.warn('⚠ afterBuild: 参照ブロックなし'); return; }

    try {
      await this.bot.placeBlock(ref.block, ref.face);
      log.info(`🔥 afterBuild: ${action.item} → (${targetAir.x},${targetAir.y},${targetAir.z})`);
    } catch (e) {
      log.warn(`⚠ afterBuild 失敗: ${e instanceof Error ? e.message : e}`);
    }
  }

  /* ============================================================== */
  /*  Utility                                                        */
  /* ============================================================== */

  private sleep(ms: number) {
    return actionDelay(this.bot, ms);
  }
}

export default BuildStructure;
