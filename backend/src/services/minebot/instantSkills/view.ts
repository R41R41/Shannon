import { z } from 'zod';
import { CustomBot, InstantSkill } from '../types.js';
import { bodyReader, creatureCells, drawColumn, drawLayers, drawSlice, drawTop, feetCell, walkedCells, type Cell } from '../utils/localMap.js';
import { mapMarkLines } from '../utils/mapMarks.js';

/**
 * mc.view (design mb-llm-centric 2.2; input and result are the head's contract, minecraftActContract.ts ViewInput / ViewResult): the
 * map, wider or cut another way, when the decision's map is not enough (a stop that repeats, a shaft, a cliff, a furnace overhead). Read
 * only. Modes: layers (one grid per y), top (the surface from above with heights), slice (a vertical cut through the centre: ns, columns
 * z; ew, columns x), column (the x,z column). `only` keeps the letters of the kinds named (block names or map symbols) and draws the
 * rest as `#` or `.`. At most MAX_CELLS cells; past that the surface from above, a 2 x 2 square to a cell, said in the header.
 * The answer is JSON: { v: 1, map, landmarks? }.
 */
const MAX_CELLS = 6000;

class View extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'view';
    this.description = '地図を広く・別の向きで見る（読むだけ）。mode: layers（y ごとの層）/ top（上から。表面の記号と高さ）/ slice（中心を通る縦の断面。axis=ns か ew）/ '
      + 'column（その x,z の縦の列）。center（既定は足）、radius（1〜32、既定12）、yFrom・yTo（絶対の y）、only（見たい種類だけ。ほかは # と . にまとめる）。'
      + '6,000マスを超えると top を2×2にまとめる。結果は JSON（map と landmarks）。';
    this.params = [
      { name: 'mode', type: 'string', description: 'layers・top・slice・column（既定 layers）', default: 'layers' },
      { name: 'center', type: 'Vec3', description: '中心（既定は足）' },
      { name: 'radius', type: 'number', description: '半径（1〜32、既定 12）', default: 12 },
      { name: 'yFrom', type: 'number', description: '下端の y（既定 中心−4）' },
      { name: 'yTo', type: 'number', description: '上端の y（既定 中心+4）' },
      { name: 'axis', type: 'string', description: 'slice の向き: ns（北→南）か ew（西→東）。既定 ns', default: 'ns' },
      { name: 'only', type: 'json', schema: z.array(z.string()).max(8), description: '見たい種類（ブロック名か地図の記号、8まで）' },
    ];
  }

  async runImpl(mode = 'layers', center?: { x: number; y: number; z: number } | null, radius = 12, yFrom?: number | null, yTo?: number | null,
    axis = 'ns', only?: string[] | string | null) {
    const result = drawView(this.bot as any, { mode, center: center ?? undefined, radius, yFrom: yFrom ?? undefined, yTo: yTo ?? undefined, axis, only: only ?? undefined });
    return result.ok ? { success: true, result: result.text } : { success: false, result: result.text, failureType: 'invalid_input' };
  }
}

/** The view for a live body, as the contract's JSON (pure but for the reads). */
export function drawView(bot: any, input: { mode?: string; center?: Cell; radius?: number; yFrom?: number; yTo?: number; axis?: string; only?: string[] | string })
  : { ok: boolean; text: string } {
  const feet = feetCell(bot);
  if (!feet) return { ok: false, text: '体が無い（接続が切れた）' };
  const mode = ['layers', 'top', 'slice', 'column'].includes(String(input.mode)) ? String(input.mode) : 'layers';
  const c: Cell = input.center ? { x: Math.floor(input.center.x), y: Math.floor(input.center.y), z: Math.floor(input.center.z) } : feet;
  const r = Math.max(1, Math.min(32, Math.round(input.radius ?? 12)));
  const list = Array.isArray(input.only) ? input.only : typeof input.only === 'string' ? input.only.split(/[\s,、]+/u) : [];
  const kinds = new Set(list.map(name => name.trim().replace(/^minecraft:/u, '')).filter(Boolean));
  const draw = { read: bodyReader(bot), self: feet, trail: walkedCells(bot), creatures: creatureCells(bot, 32),
    only: kinds.size ? (name: string, symbol: string) => kinds.has(name) || kinds.has(symbol) : null };
  const lines: string[] = [];
  const header = (what: string) => `見る v1 ${what} 中心=(${c.x},${c.y},${c.z}) 足=(${feet.x},${feet.y},${feet.z})${kinds.size ? ` only=${[...kinds].join(',')}` : ''} 上=北`;
  if (mode === 'column') {
    const from = Math.floor(input.yFrom ?? c.y - 16), to = Math.floor(input.yTo ?? c.y + 16);
    lines.push(header(`方式=column x=${c.x} z=${c.z} y=${from}..${to}`));
    lines.push(drawColumn({ ...draw, x: c.x, z: c.z, yFrom: from, yTo: to }));
  } else if (mode === 'slice') {
    const from = Math.floor(input.yFrom ?? c.y - 4), to = Math.floor(input.yTo ?? c.y + 4);
    if (to < from) return { ok: false, text: 'yTo は yFrom 以上にする' };
    const cells = (to - from + 1) * (2 * r + 1);
    if (cells > MAX_CELLS) return { ok: false, text: `断面が大きすぎる（${cells} マス、${MAX_CELLS} まで）` };
    const ew = input.axis === 'ew';
    lines.push(header(`方式=slice axis=${ew ? 'ew' : 'ns'} ${ew ? `x=${c.x - r}..${c.x + r} z=${c.z}` : `z=${c.z - r}..${c.z + r} x=${c.x}`} y=${from}..${to}`));
    lines.push(drawSlice({ ...draw, center: c, radius: r, yFrom: from, yTo: to, axis: ew ? 'ew' : 'ns' }));
  } else {
    const from = Math.floor(input.yFrom ?? (mode === 'top' ? c.y - 12 : c.y - 4)), to = Math.floor(input.yTo ?? (mode === 'top' ? c.y + 12 : c.y + 4));
    if (to < from) return { ok: false, text: 'yTo は yFrom 以上にする' };
    const area = (2 * r + 1) ** 2;
    if (mode === 'top' || area * (to - from + 1) > MAX_CELLS) {
      const step = area > MAX_CELLS ? 2 : 1;
      lines.push(header(`方式=top x=${c.x - r}..${c.x + r} z=${c.z - r}..${c.z + r} y=${from}..${to}${step > 1 ? ' 2×2を1マス' : ''}${mode !== 'top' ? ` （${area * (to - from + 1)} マスは多いので上から）` : ''}`));
      lines.push(drawTop({ ...draw, minX: c.x - r, maxX: c.x + r, minZ: c.z - r, maxZ: c.z + r, feetY: feet.y, top: to, bottom: from, step }));
    } else {
      lines.push(header(`方式=layers x=${c.x - r}..${c.x + r} z=${c.z - r}..${c.z + r} y=${from}..${to}`));
      lines.push(drawLayers({ ...draw, minX: c.x - r, maxX: c.x + r, minZ: c.z - r, maxZ: c.z + r, yFrom: from, yTo: to }));
    }
  }
  let landmarks: string[] = [];
  try { landmarks = mapMarkLines(bot); } catch { landmarks = []; }
  return { ok: true, text: JSON.stringify({ v: 1, map: lines.join('\n'), ...(landmarks.length ? { landmarks } : {}) }) };
}

export default View;
