import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import type { SkillResult } from '../types/skillParams.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { setMovements } from '../utils/setMovements.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:rideVehicle');

const VEHICLE_PATTERNS: Record<string, string[]> = {
  boat: ['boat', 'raft'],
  horse: ['horse', 'donkey', 'mule', 'camel', 'llama'],
  minecart: ['minecart'],
};

const SEARCH_RADIUS = 16;
const WATER_SEARCH_RADIUS = 24;

interface SurfaceWaterSpot {
  water: Vec3;
  shore: Vec3;
}

class RideVehicle extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'ride-vehicle';
    this.description =
      '近くの乗り物（ボート・馬・トロッコ等）に乗る、または降りる。' +
      'action="mount" で乗車、action="dismount" で下車。' +
      'action="place-and-mount" で地上の水面にボートを設置して乗る（自動で岸に移動して設置）。';
    this.params = [
      {
        name: 'action',
        type: 'string',
        description: '"mount": 近くの乗り物に乗る, "dismount": 降りる, "place-and-mount": ボートを設置して乗る',
        required: true,
      },
      {
        name: 'vehicleType',
        type: 'string',
        description: '乗り物の種類: "boat", "horse", "minecart"。省略時は最寄りの乗り物',
        default: null,
      },
    ];
    this.maxDurationMs = 30_000;
  }

  async runImpl(action: string, vehicleType: string | null = null): Promise<SkillResult> {
    switch (action) {
      case 'mount':
        return this.doMount(vehicleType);
      case 'dismount':
        return this.doDismount();
      case 'place-and-mount':
        return this.placeAndMount();
      default:
        return { success: false, result: `不明なアクション: "${action}"。mount / dismount / place-and-mount を指定。` };
    }
  }

  private async doMount(vehicleType: string | null): Promise<SkillResult> {
    if ((this.bot as any).vehicle) {
      return { success: false, result: `既に ${((this.bot as any).vehicle as any).name ?? '乗り物'} に乗っています。` };
    }

    const patterns = vehicleType && VEHICLE_PATTERNS[vehicleType]
      ? VEHICLE_PATTERNS[vehicleType]
      : Object.values(VEHICLE_PATTERNS).flat();

    const vehicle = this.bot.nearestEntity((e) => {
      if (!e.name) return false;
      const name = e.name.toLowerCase();
      if (!patterns.some((p) => name.includes(p))) return false;
      return e.position.distanceTo(this.bot.entity.position) <= SEARCH_RADIUS;
    });

    if (!vehicle) {
      return { success: false, result: `${SEARCH_RADIUS}ブロック以内に乗り物が見つかりません。` };
    }

    const vName = (vehicle as any).name ?? 'unknown';
    const dist = vehicle.position.distanceTo(this.bot.entity.position);
    log.info(`🚗 乗車: ${vName} (距離${dist.toFixed(1)}m)`);

    try {
      await this.bot.mount(vehicle);
      await this.sleep(300);

      if (!(this.bot as any).vehicle) {
        return { success: false, result: `${vName} への乗車に失敗しました。` };
      }
      return { success: true, result: `${vName} に乗りました。` };
    } catch (err) {
      return { success: false, result: `乗車エラー: ${err}` };
    }
  }

  private async doDismount(): Promise<SkillResult> {
    const bot = this.bot as any;
    if (!bot.vehicle) {
      return { success: false, result: '現在乗り物に乗っていません。' };
    }
    const vehicle = bot.vehicle;
    const vName: string = vehicle.name ?? '乗り物';
    const isSynthetic: boolean = !!vehicle._synthetic;
    const vehicleId: number | undefined = vehicle.id;
    const isBoat = typeof vName === 'string' && /boat|raft/i.test(vName);
    try {
      // 1.21+ では降船は player_input {shift:true} を送る必要がある。
      // mineflayer の bot.dismount() は jump:true を送る既知のバグ（古いプロトコル向け残存）
      // があるため、自前で shift パケットを書き込む。
      if (bot.supportFeature?.('newPlayerInputPacket')) {
        bot._client.write('player_input', { inputs: { shift: true } });
        await this.sleep(200);
        bot._client.write('player_input', { inputs: {} });
      } else {
        bot._client.write('steer_vehicle', { sideways: 0.0, forward: 0.0, jump: 0x02 });
      }

      // mineflayer の set_passengers ハンドラは dismount 時（passengers が空になる ケース）に
      // bot.vehicle をクリアしないバグがあるため、ローカル状態を自前でクリアする。
      bot.vehicle = null;
      if (bot.entity) bot.entity.vehicle = null;
      if (isSynthetic && vehicleId && bot.entities[vehicleId]?._synthetic) {
        delete bot.entities[vehicleId];
      }

      await this.sleep(300);

      // ボートは降船後に bot の足元に残ることが多く、その上に立ったままだと pathfinder が
      // 移動経路を組めずスタックする。再利用も難しいので、降りたらそのまま殴って壊す。
      if (isBoat && !isSynthetic) {
        await this.breakBoat(vehicleId);
      }

      return { success: true, result: `${vName} から降りました。` };
    } catch (err) {
      return { success: false, result: `下車エラー: ${err}` };
    }
  }

  /**
   * 降船直後のボートを殴って破壊する。範囲内に居ることが前提。
   * 数回試行してダメなら諦める（ログ警告のみ）。
   */
  private async breakBoat(vehicleId: number | undefined): Promise<void> {
    if (vehicleId == null) return;
    const bot = this.bot as any;
    const MAX_ATTEMPTS = 5;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const ent = bot.entities?.[vehicleId];
      if (!ent || !ent.isValid) {
        log.info(`🚤 ボート (id=${vehicleId}) は既に消滅済み`);
        return;
      }
      const dist = ent.position.distanceTo(bot.entity.position);
      if (dist > 4.5) {
        log.warn(`🚤 ボートが遠すぎて破壊不可 dist=${dist.toFixed(2)}`);
        return;
      }
      try {
        await bot.lookAt(ent.position.offset(0, 0.3, 0), true);
        bot.attack(ent);
      } catch (err) {
        log.warn(`🚤 ボート破壊 attack エラー: ${err}`);
      }
      await this.sleep(250);
    }
    const stillExists = bot.entities?.[vehicleId];
    if (stillExists && stillExists.isValid) {
      log.warn(`🚤 ボート (id=${vehicleId}) が ${MAX_ATTEMPTS} 回殴っても壊せませんでした`);
    }
  }

  private async placeAndMount(): Promise<SkillResult> {
    if ((this.bot as any).vehicle) {
      return { success: false, result: '既に乗り物に乗っています。' };
    }

    const boatItem = this.bot.inventory.items().find((i) => i.name.includes('boat') || i.name.includes('raft'));
    if (!boatItem) {
      return { success: false, result: 'インベントリにボートがありません。' };
    }

    const spot = this.findSurfaceWaterSpot();
    if (!spot) {
      return {
        success: false,
        result: `${WATER_SEARCH_RADIUS}ブロック以内に地上の水面（川・湖）が見つかりません。地上の水辺に近づいてから再試行してください。`,
      };
    }

    log.info(`🚣 水面発見: water=(${spot.water.x},${spot.water.y},${spot.water.z}), 岸=(${spot.shore.x},${spot.shore.y},${spot.shore.z})`);

    try {
      const distToShore = this.bot.entity.position.distanceTo(spot.shore);
      const botBlock = this.bot.blockAt(this.bot.entity.position.offset(0, -0.5, 0));
      const isInWater = botBlock?.name === 'water' || this.bot.entity.position.y < spot.shore.y - 1;

      if (distToShore > 2 || isInWater) {
        log.info(`🚣 岸へ移動: 距離${distToShore.toFixed(1)}m${isInWater ? ' (水中から脱出)' : ''}`);
        setMovements(this.bot);
        const goal = new goals.GoalNear(spot.shore.x, spot.shore.y, spot.shore.z, 1);
        await gotoSafe(this.bot, goal, { timeoutMs: 15_000, stuckAbortCount: 6 });
        await this.sleep(500);
      }

      await this.bot.equip(boatItem, 'hand');
      await this.sleep(200);

      const waterBlock = this.bot.blockAt(spot.water);
      if (!waterBlock) {
        return { success: false, result: '水ブロックが見つかりません。' };
      }

      log.info(`🚣 ボート設置開始: (${spot.water.x}, ${spot.water.y}, ${spot.water.z})`);

      const spawnPromise = this.waitForBoatSpawn(spot.water, 5000);

      const waterTop = spot.water.offset(0.5, 1.0, 0.5);
      await this.bot.lookAt(waterTop, true);
      await this.sleep(100);

      const PI = Math.PI;
      const notchYaw = (180 / PI) * (PI - this.bot.entity.yaw);
      const notchPitch = (180 / PI) * (-this.bot.entity.pitch);
      log.info(`🚣 視線: yaw=${notchYaw.toFixed(1)}° pitch=${notchPitch.toFixed(1)}° (mf: yaw=${this.bot.entity.yaw.toFixed(3)} pitch=${this.bot.entity.pitch.toFixed(3)})`);

      this.bot.swingArm('right');

      (this.bot as any)._client.write('block_place', {
        location: waterBlock.position,
        direction: 1,
        hand: 0,
        cursorX: 0.5,
        cursorY: 1.0,
        cursorZ: 0.5,
        insideBlock: false,
        sequence: 0,
        worldBorderHit: false,
      });

      if ((this.bot as any).supportFeature('useItemWithOwnPacket')) {
        (this.bot as any)._client.write('use_item', {
          hand: 0,
          sequence: 0,
          rotation: { x: notchYaw, y: notchPitch },
        });
      }

      const boatEntity = await spawnPromise;

      if (!boatEntity) {
        log.warn('🚣 ボートエンティティが5秒以内に出現しませんでした');
        return { success: false, result: 'ボートエンティティが出現しませんでした。水面が狭すぎるか障害物がある可能性。' };
      }

      log.info(`🚣 ボートエンティティ検出: ${boatEntity.name} at (${boatEntity.position.x.toFixed(1)}, ${boatEntity.position.y.toFixed(1)}, ${boatEntity.position.z.toFixed(1)})`);
      await this.bot.mount(boatEntity);
      await this.sleep(300);

      if (!(this.bot as any).vehicle) {
        return { success: false, result: 'ボートに乗れませんでした。' };
      }

      log.info(`🚣 ボート乗車成功: ${boatItem.name}`);
      return { success: true, result: `${boatItem.name} を水面に設置して乗りました。` };
    } catch (err) {
      return { success: false, result: `ボート設置エラー: ${err}` };
    }
  }

  /**
   * entitySpawn イベントを監視し、waterPos 付近に出現したボート/ラフトを返す。
   * mineflayer の waitForEntitySpawn は 1.19.4+ のエンティティ名変更に未対応
   * (oak_boat 等を 'boat' で待つため検出不能) なので自前で実装。
   */
  private waitForBoatSpawn(waterPos: Vec3, timeoutMs: number): Promise<any | null> {
    return new Promise((resolve) => {
      const listener = (entity: any) => {
        if (!entity.name) return;
        const name = entity.name.toLowerCase();
        if (!name.includes('boat') && !name.includes('raft')) return;
        const dist = entity.position.distanceTo(waterPos);
        if (dist > 5) return;

        log.info(`🚣 entitySpawn 検出: ${entity.name} dist=${dist.toFixed(1)}`);
        clearTimeout(timer);
        this.bot.off('entitySpawn', listener);
        resolve(entity);
      };

      const timer = setTimeout(() => {
        this.bot.off('entitySpawn', listener);
        resolve(null);
      }, timeoutMs);

      this.bot.on('entitySpawn', listener);
    });
  }

  /**
   * ボートを設置可能な広い水面とその隣の岸を探す。
   * ボートは幅1.375ブロックあるため、1x1の水では設置不可。
   * 最低3x3の水面の中心ブロック（周囲4方向すべてが水）を候補にする。
   */
  private findSurfaceWaterSpot(): SurfaceWaterSpot | null {
    const pos = this.bot.entity.position;
    const bx = Math.floor(pos.x);
    const bz = Math.floor(pos.z);

    let bestSpot: SurfaceWaterSpot | null = null;
    let bestDist = Infinity;

    for (let r = 1; r <= WATER_SEARCH_RADIUS; r += 1) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) < r && Math.abs(dz) < r) continue;

          const x = bx + dx;
          const z = bz + dz;

          const waterY = this.findSurfaceWaterY(x, z);
          if (waterY === null) continue;

          if (!this.isWideEnoughForBoat(x, waterY, z)) continue;

          const shore = this.findAdjacentShore(x, waterY, z);
          if (!shore) continue;

          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < bestDist) {
            bestDist = dist;
            bestSpot = {
              water: new Vec3(x, waterY, z),
              shore,
            };
          }
        }
      }
      if (bestSpot && bestDist <= r + 1) break;
    }

    if (!bestSpot) {
      log.warn('🚣 3x3以上の広い水面が見つかりません');
    }

    return bestSpot;
  }

  /**
   * ボートを浮かべるのに十分な広さ（3x3以上）があるかチェック。
   * 中心の4方向（N/S/E/W）すべてが同じ高さの地上水面であること。
   */
  private isWideEnoughForBoat(cx: number, cy: number, cz: number): boolean {
    const cardinal = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [ox, oz] of cardinal) {
      try {
        const block = this.bot.blockAt(new Vec3(cx + ox, cy, cz + oz));
        if (!block || block.name !== 'water') return false;
        const above = this.bot.blockAt(new Vec3(cx + ox, cy + 1, cz + oz));
        if (!above || (above.name !== 'air' && above.name !== 'void_air')) return false;
      } catch { return false; }
    }
    return true;
  }

  /**
   * 指定XZの地上水面Yを返す。地下水は無視する。
   * 上から走査して最初の非空気ブロックが水なら地上の水面。
   */
  private findSurfaceWaterY(x: number, z: number): number | null {
    const botY = Math.floor(this.bot.entity.position.y);
    const maxY = Math.min(botY + 20, 320);
    const minY = Math.max(botY - 30, -64);

    for (let y = maxY; y >= minY; y--) {
      try {
        const block = this.bot.blockAt(new Vec3(x, y, z));
        if (!block) continue;

        if (block.name === 'air' || block.name === 'void_air' || block.name === 'cave_air') continue;

        if (block.name === 'water') {
          const above1 = this.bot.blockAt(new Vec3(x, y + 1, z));
          const above2 = this.bot.blockAt(new Vec3(x, y + 2, z));
          if (!above1 || !above2) return null;

          const a1 = above1.name;
          const a2 = above2.name;
          if ((a1 === 'air' || a1 === 'void_air') && (a2 === 'air' || a2 === 'void_air')) {
            return y;
          }
          return null;
        }

        return null;
      } catch { return null; }
    }
    return null;
  }

  /**
   * 水面の中心付近から岸を探す。3x3の中心の場合、隣接ブロックは水なので
   * 2ブロック先まで探索してプレイヤーが立てる陸地を見つける。
   */
  private findAdjacentShore(waterX: number, waterY: number, waterZ: number): Vec3 | null {
    let bestShore: Vec3 | null = null;
    let bestDist = Infinity;
    const botPos = this.bot.entity.position;

    for (let ox = -3; ox <= 3; ox++) {
      for (let oz = -3; oz <= 3; oz++) {
        if (ox === 0 && oz === 0) continue;
        const sx = waterX + ox;
        const sz = waterZ + oz;

        for (let dy = -2; dy <= 2; dy++) {
          const sy = waterY + dy;
          try {
            const ground = this.bot.blockAt(new Vec3(sx, sy, sz));
            if (!ground || ground.boundingBox !== 'block') continue;
            if (ground.name.includes('water') || ground.name.includes('lava')) continue;

            const above1 = this.bot.blockAt(new Vec3(sx, sy + 1, sz));
            const above2 = this.bot.blockAt(new Vec3(sx, sy + 2, sz));
            if (!above1 || !above2) continue;
            if (above1.name !== 'air' && above1.name !== 'void_air') continue;
            if (above2.name !== 'air' && above2.name !== 'void_air') continue;

            const dist = botPos.distanceTo(new Vec3(sx + 0.5, sy + 1, sz + 0.5));
            if (dist < bestDist) {
              bestDist = dist;
              bestShore = new Vec3(sx + 0.5, sy + 1, sz + 0.5);
            }
          } catch { continue; }
        }
      }
    }
    return bestShore;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

export default RideVehicle;
