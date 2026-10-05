import { ConstantSkill, CustomBot } from '../types.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { abortable, actionDelay } from '../execution/observedWait.js';

const COLLECT_LIMIT_MS = 6_000;

/**
 * 自動アイテム拾得スキル
 * 近くに落ちているアイテムを自動で拾う
 */
class AutoPickUpItem extends ConstantSkill {
  private pickupRadius: number = 16; // アイテムを拾う半径
  private pickUpItemName: string = ''; // 特定のアイテム名のみ拾う（空なら全て）

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-pick-up-item';
    this.description = '近くに落ちているアイテムを自動で拾います';
    this.isLocked = false;
    this.status = false;
    this.priority = 3;
    this.interval = 1000; // 1秒ごと
    this.containMovement = true;
  }

  async runImpl(entity?: any) {
    // entitySpawnイベントからの呼び出し（新しくスポーンしたアイテム）
    if (entity) {
      if (entity.displayName === 'Item' || entity.name === 'item') {
        // 少し待ってから処理（投げられた直後のアイテムが落ち着くまで）
        await actionDelay(this.bot, 500);
        await this.collectItem(entity);
      }
      return;
    }

    // 定期実行の場合
    // 近くのアイテムを探す
    const items = Object.values(this.bot.entities).filter((e: any) => {
      if (e.displayName !== 'Item' && e.name !== 'item') return false;

      const distance = e.position.distanceTo(this.bot.entity.position);
      if (distance > this.pickupRadius) return false;

      // 速度チェック：動いているアイテムは無視（投げられた直後のアイテム）
      if (e.velocity) {
        const speed = Math.sqrt(
          e.velocity.x ** 2 + e.velocity.y ** 2 + e.velocity.z ** 2
        );
        if (speed > 0.1) return false; // まだ動いている
      }

      return true;
    });

    if (items.length === 0) return;

    // インベントリがいっぱいかチェック
    if (this.bot.inventory.emptySlotCount() === 0) return;

    // 最も近いアイテムから順に処理
    const sortedItems = items.sort((a: any, b: any) => {
      const distA = a.position.distanceTo(this.bot.entity.position);
      const distB = b.position.distanceTo(this.bot.entity.position);
      return distA - distB;
    });

    for (const item of sortedItems) {
      await this.collectItem(item);
    }
  }

  private async collectItem(entity: any) {
    try {
      // エンティティが有効かチェック
      if (!entity || !entity.isValid) return;

      // アイテム情報を取得
      const droppedItem = entity.getDroppedItem?.();

      // 特定アイテムのみ拾う設定の場合
      if (this.pickUpItemName && droppedItem) {
        if (droppedItem.name !== this.pickUpItemName) {
          return;
        }
      }

      // 距離チェック
      const distance = this.bot.entity.position.distanceTo(entity.position);
      if (distance > this.pickupRadius) return;

      // 遠い場合は近づく
      if (distance > 2) {
        await this.bot.lookAt(entity.position);
        // goalFollowがあれば使う、なければpathfinderで移動
        if (this.bot.utils?.goalFollow) {
          await this.bot.utils.goalFollow.run(entity, 1.5);
        } else {
          const pfModule = await import('mineflayer-pathfinder');
          const goal = new pfModule.default.goals.GoalNear(
            entity.position.x,
            entity.position.y,
            entity.position.z,
            1,
          );
          await gotoSafe(this.bot, goal, { timeoutMs: 8_000, stuckAbortCount: 4, logStuck: false });
        }
      }

      // アイテムを収集。The plugin walks to the item by itself and waits for the
      // pick-up without a time limit: for an item it cannot reach (drifting
      // in water) it never returned, and the body's lease with it (paid run
      // L29). Bounded, cancellable, and told to stop when given up on.
      const collector = (this.bot as any).collectBlock;
      if (collector) {
        const collecting = Promise.resolve(collector.collect(entity));
        collecting.catch(() => {});
        try {
          const done = await Promise.race([abortable(this.bot, collecting).then(() => true),
            actionDelay(this.bot, COLLECT_LIMIT_MS).then(() => false)]);
          if (!done) collector.cancelTask?.();
        } catch (error) {
          try { collector.cancelTask?.(); } catch { /* already stopped */ }
          throw error;
        }
      }
    } catch (error) {
      // 収集失敗は無視（アイテムが消えた等）
    }
  }
}

export default AutoPickUpItem;
