import { ConstantSkill, CustomBot } from '../types.js';

class AutoRunFromHostiles extends ConstantSkill {
  distance: number;
  radius: number;
  runIfFatal: boolean;
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-run-from-hostiles';
    this.description = '瀕死の際に自動で敵モブから逃げる';
    this.interval = 1000;
    this.priority = 9;
    this.distance = 16;
    this.radius = 32;
    this.runIfFatal = true;
    this.status = true;
    this.containMovement = true;
  }

  async runImpl() {
    // #12 fix: CombatController 実行中は干渉しない
    if (this.bot.executingSkill) return;

    const hostiles = Object.values(this.bot.entities).filter(
      (entity) =>
        entity.type === 'hostile' &&
        this.bot.entity.position.distanceTo(entity.position) <= this.distance
    );
    if (
      (!this.runIfFatal && hostiles.length > 0) ||
      (this.runIfFatal && this.bot.health <= 5)
    ) {
      await this.bot.utils.runFromEntities(this.bot, hostiles, this.radius);
    }
  }
}

export default AutoRunFromHostiles;
