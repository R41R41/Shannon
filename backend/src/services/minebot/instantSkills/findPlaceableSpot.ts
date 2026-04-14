import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';

/**
 * place-block-at と同じルールで「固体に面した空気セル」を探す。
 * 洞窟・坑道など地下で設置先を探す用途向け。
 */
class FindPlaceableSpot extends InstantSkill {
  /** placeBlockAt と同順: [隣接オフセット, 設置時の面ベクトル] の対応 */
  private static readonly OFFSETS: [number, number, number, number, number, number][] = [
    [0, -1, 0, 0, 1, 0],
    [1, 0, 0, -1, 0, 0],
    [-1, 0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0, -1],
    [0, 0, -1, 0, 0, 1],
    [0, 1, 0, 0, -1, 0],
  ];

  private static readonly FACE_LABELS = ['下', '東', '西', '南', '北', '上'] as const;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'find-placeable-spot';
    this.description =
      'ボット周辺で、place-block-at と同様に設置可能な空気ブロックの座標を列挙します。地下でクラフト台や松明を置く場所を探すのに使います。';
    this.params = [
      {
        name: 'searchRadius',
        type: 'number',
        description: 'ボット位置からの探索半径（ブロック、デフォルト: 8、最大: 24）',
        default: 8,
      },
      {
        name: 'maxResults',
        type: 'number',
        description: '返す候補の最大件数（デフォルト: 12）',
        default: 12,
      },
      {
        name: 'requireHeadSpace',
        type: 'boolean',
        description:
          'true のとき、設置セルの直上も空気である候補に限定（2マス高さが要る設置の目安。デフォルト: false）',
        default: false,
      },
    ];
  }

  private isAirBlockName(name: string | undefined): boolean {
    if (!name) return false;
    return name === 'air' || name === 'cave_air' || name === 'void_air';
  }

  /**
   * このセルに固体隣接があり place-block-at が参照ブロックを取れるか
   */
  private canPlaceAtCell(targetPos: Vec3): { ok: boolean; faceLabel: string } {
    for (let i = 0; i < FindPlaceableSpot.OFFSETS.length; i++) {
      const [ox, oy, oz] = FindPlaceableSpot.OFFSETS[i];
      const candidate = this.bot.blockAt(targetPos.offset(ox, oy, oz));
      if (candidate && !this.isAirBlockName(candidate.name)) {
        return { ok: true, faceLabel: FindPlaceableSpot.FACE_LABELS[i] };
      }
    }
    return { ok: false, faceLabel: '' };
  }

  async runImpl(searchRadius: number = 8, maxResults: number = 12, requireHeadSpace: boolean = false) {
    const R = Math.max(1, Math.min(24, Math.floor(Number(searchRadius)) || 8));
    const limit = Math.max(1, Math.min(32, Math.floor(Number(maxResults)) || 12));

    const botPos = this.bot.entity.position;
    const ox0 = Math.floor(botPos.x);
    const oy0 = Math.floor(botPos.y);
    const oz0 = Math.floor(botPos.z);

    type Spot = { x: number; y: number; z: number; dist: number; ref: string };
    const spots: Spot[] = [];
    const rsq = R * R;

    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        for (let dz = -R; dz <= R; dz++) {
          if (dx * dx + dy * dy + dz * dz > rsq) continue;

          const x = ox0 + dx;
          const y = oy0 + dy;
          const z = oz0 + dz;

          if (
            x === ox0 &&
            z === oz0 &&
            (y === oy0 || y === oy0 + 1)
          ) {
            continue;
          }

          const targetPos = new Vec3(x, y, z);
          const cell = this.bot.blockAt(targetPos);
          if (!cell || !this.isAirBlockName(cell.name)) continue;

          if (requireHeadSpace) {
            const above = this.bot.blockAt(targetPos.offset(0, 1, 0));
            if (!above || !this.isAirBlockName(above.name)) continue;
          }

          const { ok, faceLabel } = this.canPlaceAtCell(targetPos);
          if (!ok) continue;

          const cx = x + 0.5;
          const cy = y + 0.5;
          const cz = z + 0.5;
          const dist = Math.sqrt(
            (botPos.x - cx) ** 2 + (botPos.y - cy) ** 2 + (botPos.z - cz) ** 2,
          );
          spots.push({ x, y, z, dist, ref: faceLabel });
        }
      }
    }

    spots.sort((a, b) => a.dist - b.dist);
    const picked = spots.slice(0, limit);

    if (picked.length === 0) {
      return {
        success: false,
        failureType: 'target_not_found',
        recoverable: true,
        result:
          `半径${R}ブロック以内に、固体に面した空気セル（place-block-at 可能な候補）が見つかりませんでした。` +
          '坑道を広げる・床を掘る・別方向へ移動してから再試行してください。',
      };
    }

    const lines = picked.map(
      s => `(${s.x},${s.y},${s.z}) 距離約${s.dist.toFixed(1)}m 主な参照面:${s.ref}`,
    );
    return {
      success: true,
      result:
        `設置候補 ${picked.length} 件（半径${R}、近い順）。place-block-at で利用可（5m以内に近づいてから）。\n` +
        lines.join('\n'),
    };
  }
}

export default FindPlaceableSpot;
