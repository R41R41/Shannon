import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';

/** スポナー・トライアルスポナー探索（水平は部屋の対角＋ラージチェストの片側ずれ、垂直は床の段差用に広め） */
const SPAWNER_SCAN_HR = 14;
const SPAWNER_SCAN_VR = 8;

/** 苔石＋丸石の塊（廃坑ダンジョンの壁）— スポナー座標が取りこぼされても抑止。誤検知はプレイヤー建築が極端に近い場合のみ */
const DUNGEON_SHELL_HR = 7;
const DUNGEON_SHELL_VR = 4;
const DUNGEON_MOSSY_MIN = 18;
const DUNGEON_COBBLE_MIN = 14;

const DANGEROUS_SPAWNER_BLOCKS = new Set(['spawner', 'trial_spawner']);

/** オーバーワールドで「地上（天光が届く）」とみなす最小 skyLight（洞窟が地表に繋がると高くなるため単独では不十分） */
const MIN_SKYLIGHT_FOR_SURFACE_DEPOSIT = 9;

function isOverworld(bot: CustomBot): boolean {
  const d = String((bot as any).game?.dimension ?? '');
  return d === 'overworld' || d.endsWith(':overworld');
}

/**
 * 預け先は地上（直射日光・天窓など天光が届く場所）に限定。オーバーワールドのみ判定。
 */
function isSurfaceDepositLocation(bot: CustomBot, chestPos: Vec3): { ok: boolean; detail?: string } {
  if (!isOverworld(bot)) {
    return { ok: true };
  }
  const chestBlock = bot.blockAt(chestPos);
  if (!chestBlock) {
    return { ok: false, detail: 'チェスト位置のブロックを取得できませんでした' };
  }
  const above = bot.blockAt(chestPos.offset(0, 1, 0));
  const skyChest = typeof chestBlock.skyLight === 'number' ? chestBlock.skyLight : 0;
  const skyAbove = typeof above?.skyLight === 'number' ? above.skyLight : 0;
  const sky = Math.max(skyChest, skyAbove);
  if (sky < MIN_SKYLIGHT_FOR_SURFACE_DEPOSIT) {
    return {
      ok: false,
      detail: `このチェストは天光が弱い（skyLight=${sky}）ため地上の預け先として使えません。洞窟・地下基地の可能性があります。地上へ出て天の下または天窓の近くのチェスト・樽を探すか、地上で craft-one(chest) と place-block-at してから預けてください。`,
    };
  }
  return { ok: true };
}

function hasDangerousSpawnerNearChest(bot: CustomBot, chestPos: Vec3): boolean {
  const hr = SPAWNER_SCAN_HR;
  const vr = SPAWNER_SCAN_VR;
  for (let dx = -hr; dx <= hr; dx++) {
    for (let dy = -vr; dy <= vr; dy++) {
      for (let dz = -hr; dz <= hr; dz++) {
        const b = bot.blockAt(chestPos.offset(dx, dy, dz));
        if (b && DANGEROUS_SPAWNER_BLOCKS.has(b.name)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** 古典的ダンジョン（苔石＋丸石）に囲まれたチェスト。洞窟が明るい（天光が入る）ときの二段目の防壁 */
function looksLikeVanillaDungeonShell(bot: CustomBot, chestPos: Vec3): boolean {
  let mossy = 0;
  let cobble = 0;
  const hr = DUNGEON_SHELL_HR;
  const vr = DUNGEON_SHELL_VR;
  for (let dx = -hr; dx <= hr; dx++) {
    for (let dy = -vr; dy <= vr; dy++) {
      for (let dz = -hr; dz <= hr; dz++) {
        const n = bot.blockAt(chestPos.offset(dx, dy, dz))?.name;
        if (n === 'mossy_cobblestone') mossy++;
        else if (n === 'cobblestone') cobble++;
      }
    }
  }
  return mossy >= DUNGEON_MOSSY_MIN && cobble >= DUNGEON_COBBLE_MIN;
}

/**
 * 原子的スキル: コンテナにアイテムを入れる
 */
class DepositToContainer extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'deposit-to-container';
    this.description =
      'コンテナにアイテムを入れます。安全でない場所（洞窟・スポナー部屋・ダンジョン等）のチェストは自動拒否されます。拒否された場合は別の安全な収納へ切り替えてください。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: 'コンテナのX座標',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: 'コンテナのY座標',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: 'コンテナのZ座標',
        required: true,
      },
      {
        name: 'itemName',
        type: 'string',
        description: '入れるアイテム名',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: '入れる個数（nullの場合は全部）',
        default: null,
      },
    ];
  }

  async runImpl(
    x: number,
    y: number,
    z: number,
    itemName: string,
    count: number | null = null
  ) {
    try {
      // パラメータチェック
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります',
        };
      }

      const pos = new Vec3(x, y, z);
      const block = this.bot.blockAt(pos);

      if (!block) {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})にブロックが見つかりません`,
        };
      }

      // 距離チェック
      const distance = this.bot.entity.position.distanceTo(pos);
      if (distance > 4.5) {
        return {
          success: false,
          result: `コンテナが遠すぎます（距離: ${distance.toFixed(
            1
          )}m、4.5m以内に近づいてください）`,
        };
      }

      if (hasDangerousSpawnerNearChest(this.bot, pos)) {
        return {
          success: false,
          result:
            'このチェストの近くにスポナーまたはトライアルスポナーがあります（スポナー部屋・試練施設の可能性）。預けずに地上へ戻り、安全なチェスト・樽を使うか craft-one(chest)+place-block-at してください。',
          failureType: 'unsafe_location',
          recoverable: true,
        };
      }

      if (isOverworld(this.bot) && looksLikeVanillaDungeonShell(this.bot, pos)) {
        return {
          success: false,
          result:
            'このチェストは苔石＋丸石のダンジョン型構造物内と判定されました（廃坑のスポナー部屋など）。天光が入って明るくても危険なので預けません。地上の収納を使うか、chest を新設してください。',
          failureType: 'unsafe_location',
          recoverable: true,
        };
      }

      const surface = isSurfaceDepositLocation(this.bot, pos);
      if (!surface.ok) {
        return {
          success: false,
          result: surface.detail ?? '地上以外のチェストへの預けはできません',
          failureType: 'unsafe_location',
          recoverable: true,
        };
      }

      // アイテムを持っているかチェック
      const items = this.bot.inventory
        .items()
        .filter((item) => item.name === itemName);
      if (items.length === 0) {
        return {
          success: false,
          result: `${itemName}をインベントリに持っていません`,
        };
      }

      const totalCount = items.reduce((sum, item) => sum + item.count, 0);
      const depositCount =
        count !== null ? Math.min(count, totalCount) : totalCount;

      let container;
      try {
        container = await this.bot.openContainer(block);
      } catch (actionError: any) {
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        throw actionError;
      }
      if (!container) {
        return {
          success: false,
          result: `${block.name}を開けませんでした`,
        };
      }

      try {
        // アイテムを入れる
        let remaining = depositCount;
        for (const item of items) {
          if (remaining <= 0) break;
          const depositAmount = Math.min(item.count, remaining);
          await container.deposit(item.type, null, depositAmount);
          remaining -= depositAmount;
        }

        container.close();

        return {
          success: true,
          result: `${itemName}を${depositCount}個${block.name}に入れました`,
        };
      } catch (error: any) {
        container.close();
        throw error;
      }
    } catch (error: any) {
      // エラーメッセージを詳細化
      let errorDetail = error.message;
      if (error.message.includes('full')) {
        errorDetail = 'コンテナが満杯です';
      } else if (error.message.includes('deposit')) {
        errorDetail = 'アイテムを入れられませんでした';
      }

      return {
        success: false,
        result: `格納エラー: ${errorDetail}`,
      };
    }
  }
}

export default DepositToContainer;
