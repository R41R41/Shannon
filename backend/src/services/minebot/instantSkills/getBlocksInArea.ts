import { CustomBot, InstantSkill } from '../types.js';
import { SkillParam } from '../types/skillParams.js';
import { bodyReader, symbolFor, type MapBlock } from '../utils/localMap.js';

/**
 * スキル①: 指定した始点と終点の座標範囲内のブロック情報を取得
 * 効率的な圧縮表現でLLMに渡す
 *
 * The letters are the map's (utils/localMap: one drawer for every map, design mb-llm-centric 2.2). The old ones clashed (deepslate
 * and dirt were both `D`, gold ore and glass both `g`), cave_air was counted as a block, and a cell not loaded was drawn as air:
 * now a letter stands for one family whose names the legend lists, every air is air, and an unloaded cell is `?`.
 */
class GetBlocksInArea extends InstantSkill {
  skillName = 'get-blocks-in-area';
  description =
    '指定した始点と終点の座標範囲内のブロック情報を取得します。レイヤー形式または統計形式で出力できます。';
  params: SkillParam[] = [
    { name: 'x1', type: 'number' as const, description: '始点のX座標', required: true },
    { name: 'y1', type: 'number' as const, description: '始点のY座標', required: true },
    { name: 'z1', type: 'number' as const, description: '始点のZ座標', required: true },
    { name: 'x2', type: 'number' as const, description: '終点のX座標', required: true },
    { name: 'y2', type: 'number' as const, description: '終点のY座標', required: true },
    { name: 'z2', type: 'number' as const, description: '終点のZ座標', required: true },
    {
      name: 'format',
      type: 'string' as const,
      description:
        '出力形式: "layers"（レイヤー別の2D配列）, "stats"（統計情報）, "list"（座標リスト）',
      default: 'layers',
    },
    {
      name: 'includeAir',
      type: 'boolean' as const,
      description: '空気ブロックを含めるか（デフォルト: false）',
      default: false,
    },
  ];
  isToolForLLM = true;

  constructor(bot: CustomBot) {
    super(bot);
  }

  async runImpl(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    format: string = 'layers',
    includeAir: boolean = false
  ) {
    try {
      const read = bodyReader(this.bot as any);
      return describeArea(read, { x1, y1, z1, x2, y2, z2 }, format, includeAir);
    } catch (error: any) {
      return { success: false, result: `エラー: ${error.message}` };
    }
  }
}

type Reader = (x: number, y: number, z: number) => MapBlock | null;

/** The area as layers, stats or a list, from any reader (a live body, a test's blocks, a saved world). */
export function describeArea(read: Reader, corners: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }, format = 'layers', includeAir = false) {
  const minX = Math.floor(Math.min(corners.x1, corners.x2)), maxX = Math.floor(Math.max(corners.x1, corners.x2));
  const minY = Math.floor(Math.min(corners.y1, corners.y2)), maxY = Math.floor(Math.max(corners.y1, corners.y2));
  const minZ = Math.floor(Math.min(corners.z1, corners.z2)), maxZ = Math.floor(Math.max(corners.z1, corners.z2));
  const totalBlocks = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
  if (totalBlocks > 10000) {
    return { success: false, result: `範囲が大きすぎます（${totalBlocks}ブロック）。10,000ブロック以内にしてください。` };
  }
  const area = { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ },
    dimensions: { width: maxX - minX + 1, height: maxY - minY + 1, length: maxZ - minZ + 1 } };
  const cells: Array<{ x: number; y: number; z: number; block: MapBlock | null; symbol: string }> = [];
  for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
    const block = read(x, y, z);
    cells.push({ x, y, z, block, symbol: symbolFor(block) });
  }
  const isAir = (cell: typeof cells[number]) => cell.symbol === '.' && !!cell.block && /air$/u.test(cell.block.name);
  const airCount = cells.filter(isAir).length;
  const unloaded = cells.filter(cell => !cell.block).length;
  const solidCount = cells.length - airCount - unloaded;
  switch (format) {
    case 'layers': {
      const legend: Record<string, string> = {};
      for (const cell of cells) {
        if (!cell.block) { legend['?'] = '未ロード'; continue; }
        if (isAir(cell) && !includeAir) continue;
        const names = new Set(String(legend[cell.symbol] ?? '').split(',').filter(Boolean));
        names.add(cell.block.name);
        legend[cell.symbol] = [...names].slice(0, 8).join(',');
      }
      const layers = [];
      for (let y = minY; y <= maxY; y++) {
        const rows: string[] = [];
        for (let z = minZ; z <= maxZ; z++) {
          let row = '';
          for (let x = minX; x <= maxX; x++) row += cells[(y - minY) * area.dimensions.length * area.dimensions.width + (z - minZ) * area.dimensions.width + (x - minX)].symbol;
          rows.push(row);
        }
        layers.push({ y, data: rows.join('\n') });
      }
      return { success: true, result: JSON.stringify({ format: 'layers', area, legend, layers,
        note: '各レイヤーは上から見た2D配列（行は北→南、列は西→東）。記号は地図と同じ（. は空気・cave_air、? は未ロード）。legend は記号ごとのブロック名。' }, null, 2) };
    }
    case 'stats': {
      const stats: Record<string, number> = {};
      for (const cell of cells) { const name = cell.block ? cell.block.name : '未ロード'; stats[name] = (stats[name] || 0) + 1; }
      const blockTypes = Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ block: name, count }));
      const known = airCount + solidCount;
      return { success: true, result: JSON.stringify({ format: 'stats', area, totalBlocks: cells.length, airCount, solidCount, unloaded,
        density: known ? `${Math.round((solidCount / known) * 100)}%` : '0%', blockTypes }, null, 2) };
    }
    case 'list': {
      const list = cells.filter(cell => cell.block && (includeAir || !isAir(cell)))
        .map(cell => ({ position: { x: cell.x, y: cell.y, z: cell.z }, block: cell.block!.name })).slice(0, 100);
      return { success: true, result: JSON.stringify({ format: 'list', count: list.length, blocks: list,
        ...(unloaded ? { unloaded } : {}), note: list.length === 100 ? '結果が100個に制限されています' : undefined }, null, 2) };
    }
    default:
      return { success: false, result: `不明なフォーマット: ${format}。"layers", "stats", "list"のいずれかを指定してください。` };
  }
}

export default GetBlocksInArea;
