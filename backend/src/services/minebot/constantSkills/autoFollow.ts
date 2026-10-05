import { Entity } from 'prismarine-entity';
import { createLogger } from '../../../utils/logger.js';
import { ConstantSkill, CustomBot } from '../types.js';
import { actionDelay } from '../execution/observedWait.js';

const log = createLogger('Minebot:Skill:autoFollow');

class AutoFollow extends ConstantSkill {
  private lastStatus: boolean = false;
  private targetName: string | undefined;
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-follow';
    this.description = '自動で近くのプレイヤーを追尾する';
    this.isLocked = false;
    this.status = false;
    this.priority = 8;
    this.containMovement = true;
    this.interval = 1000; // Resume an enabled follow after an owned emergency/task handoff.
    this.maxDurationMs = 0; // Persistent behavior; cancellation, not an arbitrary deadline, ends it.
  }

  /**
   * ボットが水中にいるか判定（entity dataを使用）
   * ※ this.bot.isInWater はどこにもセットされないため使わない
   */
  private isEntityInWater(): boolean {
    return (this.bot.entity as any)?.isInWater || false;
  }

  async runImpl(entityName?: string) {
    if (entityName) this.targetName = entityName;
    if (!this.targetName) return;
    entityName = this.targetName;
    try {
      while (this.status) {
        const entities = await this.bot.utils.getNearestEntitiesByName(
          this.bot,
          entityName
        );
        if (entities.length === 0) {
          await actionDelay(this.bot, 1000);
          continue;
        }

        if (this.isEntityInWater()) {
          // 水中: 短い間隔(200ms)で連続的に泳いで追従
          await this.swimLoop(entityName);
        } else {
          // 陸上: pathfinderで追従
          const entity = entities[0];
          this.bot.pathfinder.setGoal(null);
          this.bot.setControlState('sprint', false);
          this.bot.setControlState('forward', false);
          this.bot.setControlState('jump', false);
          this.bot.setControlState('sneak', false);
          await this.bot.utils.goalFollow.run(entity, 1.5);
          await actionDelay(this.bot, 1000);
        }
      }
      this.bot.pathfinder.setGoal(null);
      this.bot.clearControlStates();
    } catch (error: any) {
      log.error('追尾ループ中にエラー', error);
    }
  }

  /**
   * 水中追従ループ（200msごとに方向・制御を更新）
   * 水から出たら自動で抜ける
   */
  private async swimLoop(entityName: string) {
    // pathfinderを停止（手動制御に切り替え）
    this.bot.pathfinder.setGoal(null);

    while (this.status && this.isEntityInWater()) {
      const entities = await this.bot.utils.getNearestEntitiesByName(
        this.bot,
        entityName
      );
      const entity = entities.length > 0 ? entities[0] : null;
      await this.swim(entity);
      await actionDelay(this.bot, 200);
    }

    // 水から出た → 制御状態をリセット（陸上ループに引き継ぐ）
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('forward', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('sneak', false);
  }

  /**
   * 1回分の水中移動処理
   */
  async swim(entity: Entity | null) {
    if (entity !== null) {
      await this.bot.lookAt(entity.position, true);
    }
    this.bot.setControlState('sprint', true);
    this.bot.setControlState('forward', true);

    const frontBlock = this.bot.utils.getFrontBlock(this.bot, 1);
    const frontBlock2 = this.bot.utils.getFrontBlock(this.bot, 2);
    const aboveBlock = this.bot.world.getBlock(
      this.bot.entity.position.offset(0, 2, 0)
    );
    const aboveAboveBlock = this.bot.world.getBlock(
      this.bot.entity.position.offset(0, 3, 0)
    );
    const belowBlock = this.bot.world.getBlock(
      this.bot.entity.position.offset(0, -1, 0)
    );
    const feetBlock = this.bot.world.getBlock(
      this.bot.entity.position
    );

    // 岸に上がる判定: 足元が水で、前方1〜2ブロックに固体ブロックがある
    const isNearShore =
      feetBlock?.name === 'water' &&
      ((frontBlock && frontBlock.name !== 'water' && frontBlock.name !== 'air') ||
       (frontBlock2 && frontBlock2.name !== 'water' && frontBlock2.name !== 'air'));

    if (this.bot.oxygenLevel < 10) {
      // 酸素レベルが低いなら、上に進む（auto-swimと同じ閾値10）
      this.bot.setControlState('jump', true);
      this.bot.setControlState('sneak', false);
    } else if (isNearShore) {
      // 岸の近く → ジャンプして陸に上がる
      this.bot.setControlState('jump', true);
      this.bot.setControlState('sneak', false);
    } else if (
      aboveBlock &&
      aboveBlock.name !== 'water' &&
      aboveBlock.name !== 'air' &&
      belowBlock &&
      belowBlock.name === 'water'
    ) {
      // 天井がある水中（水面が塞がれている）→ 下に潜る
      this.bot.setControlState('jump', false);
      this.bot.setControlState('sneak', true);
    } else if (
      aboveAboveBlock &&
      aboveAboveBlock.name !== 'water' &&
      aboveAboveBlock.name !== 'air' &&
      belowBlock &&
      belowBlock.name === 'water'
    ) {
      // 浅瀬 → そのまま前に進む
      this.bot.setControlState('jump', false);
      this.bot.setControlState('sneak', false);
    } else if (
      entity !== null &&
      this.bot.entity.position.y < entity.position.y - 0.5
    ) {
      // エンティティより下にいるなら、上に進む
      this.bot.setControlState('jump', true);
      this.bot.setControlState('sneak', false);
    } else {
      // その他 → 前に進む
      this.bot.setControlState('jump', false);
      this.bot.setControlState('sneak', false);
    }
  }
}

export default AutoFollow;
