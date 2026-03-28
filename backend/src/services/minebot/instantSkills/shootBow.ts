import { createLogger } from '../../../utils/logger.js';
import { CustomBot, InstantSkill } from '../types.js';

const log = createLogger('Minebot:Skill:shootBow');

const BOW_ITEMS = ['bow', 'crossbow'];
const ARROW_ITEMS = ['arrow', 'spectral_arrow', 'tipped_arrow'];
const FULL_CHARGE_MS = 1200;
const CROSSBOW_CHARGE_MS = 1250;
const AIM_OFFSET_RATIO = 0.8;

class ShootBow extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'shoot-bow';
    this.description =
      '弓またはクロスボウで指定したエンティティやプレイヤーを射撃します。弓と矢がインベントリに必要です。';
    this.params = [
      {
        name: 'targetName',
        type: 'string',
        description:
          '射撃対象の名前（プレイヤー名またはエンティティ種別。例: "guriko8670", "zombie", "cow"）',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: '射撃回数（デフォルト: 1）',
        default: 1,
      },
      {
        name: 'chargeSeconds',
        type: 'number',
        description: '弓のチャージ時間（秒）。1.0でフルチャージ。0.5で半チャージ（デフォルト: 1.0）',
        default: 1.0,
      },
      {
        name: 'maxDistance',
        type: 'number',
        description: '対象との最大距離（デフォルト: 48ブロック）',
        default: 48,
      },
    ];
  }

  async runImpl(
    targetName: string,
    count: number = 1,
    chargeSeconds: number = 1.0,
    maxDistance: number = 48
  ) {
    try {
      if (!targetName) {
        return { success: false, result: '射撃対象を指定してください' };
      }

      const allItems = this.bot.inventory.items();
      const heldItem = this.bot.heldItem;

      const bowItem =
        allItems.find((i) => BOW_ITEMS.includes(i.name)) ??
        (heldItem && BOW_ITEMS.includes(heldItem.name) ? heldItem : null);

      if (!bowItem) {
        const itemNames = allItems.map((i) => i.name).join(', ');
        return {
          success: false,
          result: `弓またはクロスボウがありません (所持: ${itemNames || 'なし'})`,
        };
      }

      const isCrossbow = bowItem.name === 'crossbow';

      const hasArrows =
        allItems.some((i) => ARROW_ITEMS.includes(i.name)) ||
        this.bot.game.gameMode === 'creative';

      if (!hasArrows) {
        return { success: false, result: '矢がインベントリにありません' };
      }

      const targetLower = targetName.toLowerCase().trim();
      const target = this.bot.nearestEntity((entity) => {
        if (!entity?.position) return false;
        const dist = entity.position.distanceTo(this.bot.entity.position);
        if (dist > maxDistance) return false;

        const name = (entity.name ?? entity.username ?? '').toLowerCase();
        const username = (entity.username ?? '').toLowerCase();
        return name === targetLower || username === targetLower || name.includes(targetLower);
      });

      if (!target) {
        return {
          success: false,
          result: `${maxDistance}ブロック以内に "${targetName}" が見つかりません`,
        };
      }

      const equipItem = allItems.find((i) => i.name === bowItem.name);
      if (equipItem) {
        await this.bot.equip(equipItem, 'hand');
      }

      const distance = target.position.distanceTo(this.bot.entity.position);
      const clampedCount = Math.min(Math.max(count, 1), 10);
      const chargeMs = isCrossbow
        ? CROSSBOW_CHARGE_MS
        : Math.min(Math.max(chargeSeconds * 1000, 200), FULL_CHARGE_MS);

      let shotsLanded = 0;

      for (let i = 0; i < clampedCount; i++) {
        if (this.shouldInterrupt()) {
          log.info(`射撃中断: ${shotsLanded}/${clampedCount}発で中断`);
          break;
        }

        const currentTarget = this.bot.nearestEntity((e) => {
          const n = (e.name ?? e.username ?? '').toLowerCase();
          const u = (e.username ?? '').toLowerCase();
          return n === targetLower || u === targetLower || n.includes(targetLower);
        });

        if (!currentTarget) {
          log.warn('射撃対象がいなくなりました');
          break;
        }

        const aimPos = currentTarget.position.offset(
          0,
          currentTarget.height * AIM_OFFSET_RATIO,
          0
        );
        await this.bot.lookAt(aimPos, true);

        if (isCrossbow) {
          await this.shootCrossbow(chargeMs, aimPos);
        } else {
          await this.shootRegularBow(chargeMs);
        }

        shotsLanded++;

        if (i < clampedCount - 1) {
          await this.sleep(300);
        }
      }

      const targetDisplay = target.username ?? target.name ?? targetName;
      const distStr = distance.toFixed(1);

      return {
        success: true,
        result: `${targetDisplay}に向けて${shotsLanded}発射撃しました（距離: ${distStr}m, 武器: ${bowItem.name}）`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `射撃エラー: ${error.message}`,
      };
    }
  }

  private async shootRegularBow(chargeMs: number): Promise<void> {
    this.bot.activateItem(false);
    await this.sleep(chargeMs);
    this.bot.deactivateItem();
  }

  private async shootCrossbow(chargeMs: number, aimPos: any): Promise<void> {
    this.bot.activateItem(false);
    await this.sleep(chargeMs);
    this.bot.deactivateItem();

    await this.sleep(100);
    await this.bot.lookAt(aimPos, true);

    this.bot.activateItem(false);
    await this.sleep(50);
    this.bot.deactivateItem();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default ShootBow;
