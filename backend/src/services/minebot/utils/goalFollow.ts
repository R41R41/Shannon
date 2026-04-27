import pkg from 'mineflayer-pathfinder';
import { Entity } from 'prismarine-entity';
import { createLogger } from '../../../utils/logger.js';
import { CustomBot, ResponseType } from '../types.js';
import { setMovements } from './setMovements.js';
const { goals } = pkg;

const log = createLogger('Minebot:Goal');

export class GoalFollow {
  bot: CustomBot;
  constructor(bot: CustomBot) {
    this.bot = bot;
  }
  async run(entity: Entity, distance: number): Promise<ResponseType> {
    try {
      if (!entity || !entity.position) {
        log.debug(`エンティティの位置情報が取得できません: ${entity}`);
        return {
          success: false,
          result: 'エンティティの位置情報が取得できません',
        };
      }
      setMovements(this.bot);
      const goal = new goals.GoalFollow(entity, distance);
      await this.bot.pathfinder.setGoal(goal, true);
      return { success: true, result: 'ゴールに到達しました' };
    } catch (error) {
      log.error('Error in run', error);
      return { success: false, result: 'ゴールに到達できませんでした' };
    }
  }
}
