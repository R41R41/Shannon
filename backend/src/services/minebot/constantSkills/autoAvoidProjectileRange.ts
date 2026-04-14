import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { ConstantSkill, CustomBot } from '../types.js';
import { gotoSafe } from '../utils/gotoSafe.js';
const { goals } = pathfinder;

class AutoAvoidProjectileRange extends ConstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-avoid-projectile-range';
    this.description = '自動で投擲物の射撃範囲から逃げる';
    this.interval = 1000;
    this.priority = 9;
    this.status = false;
    this.containMovement = true;
  }

  async runImpl() {
    // 32ブロック以内に名前にbowがつくアイテムを持ったエンティティを検知
    const entities = Object.values(this.bot.entities).filter(
      (entity) =>
        (entity.type === 'hostile' || entity.type === 'player') &&
        (entity.type === 'hostile' || entity.username !== this.bot.username) &&
        entity.position.distanceTo(this.bot.entity.position) < 32 &&
        entity.equipment.some((item) => item && item.name.includes('bow'))
    );
    //さらにentity.typeがplayerでentity.usernameがbotと同じであるものを除外
    if (entities.length <= 0) return;
    this.bot.pathfinder.setGoal(null);
    //最も近いエンティティを選択
    const entity = entities.reduce((min, entity) => {
      return entity.position.distanceTo(this.bot.entity.position) <
        min.position.distanceTo(this.bot.entity.position)
        ? entity
        : min;
    }, entities[0]);
    const direction = entity.position
      .minus(this.bot.entity.position)
      .normalize();
    const right45 = this.rotateVector(direction, Math.PI / 4);

    // botの現在地から直線aへの垂線の交点を求める
    const botPosition = this.bot.entity.position;
    const entityPosition = entity.position;
    const a = right45;
    const botToEntity = botPosition.minus(entityPosition);
    const projectionLength = botToEntity.dot(a);
    const projection = a.scaled(projectionLength);
    const intersection = entityPosition.plus(projection);

    // 交点に移動
    const escapePosition = intersection;
    await gotoSafe(this.bot, new goals.GoalBlock(escapePosition.x, escapePosition.y, escapePosition.z), { timeoutMs: 5_000, stuckAbortCount: 4, logStuck: false });
  }

  rotateVector(vector: Vec3, angle: number) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return vector
      .clone()
      .set(
        vector.x * cos - vector.z * sin,
        vector.y,
        vector.x * sin + vector.z * cos
      );
  }
}

export default AutoAvoidProjectileRange;
