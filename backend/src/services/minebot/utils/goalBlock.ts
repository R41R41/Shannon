import pkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { CustomBot, ResponseType } from '../types.js';
import { gotoSafe } from './gotoSafe.js';
const { goals } = pkg;

const log = createLogger('Minebot:Goal');

export class GoalBlock {
  bot: CustomBot;
  constructor(bot: CustomBot) {
    this.bot = bot;
  }
  async run(position: Vec3): Promise<ResponseType> {
    try {
      const r = await gotoSafe(this.bot, new goals.GoalBlock(position.x, position.y, position.z), { timeoutMs: 30_000 });
      return r.success
        ? { success: true, result: 'ゴールに到達しました' }
        : { success: false, result: `ゴールに到達できませんでした（${r.error}）` };
    } catch (error) {
      log.error('Error in run', error);
      return { success: false, result: 'ゴールに到達できませんでした' };
    }
  }
  async goToNear(position: Vec3, distance: number): Promise<ResponseType> {
    try {
      const r = await gotoSafe(this.bot, new goals.GoalNear(position.x, position.y, position.z, distance), { timeoutMs: 30_000 });
      return r.success
        ? { success: true, result: 'ゴールに到達しました' }
        : { success: false, result: `ゴールに到達できませんでした（${r.error}）` };
    } catch (error) {
      log.error('Error in goToNear', error);
      return { success: false, result: 'ゴールに到達できませんでした' };
    }
  }
}
