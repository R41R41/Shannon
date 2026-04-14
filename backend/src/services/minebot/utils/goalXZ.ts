import pkg from 'mineflayer-pathfinder';
import { createLogger } from '../../../utils/logger.js';
import { CustomBot, ResponseType } from '../types.js';
import { gotoSafe } from './gotoSafe.js';
const { goals } = pkg;

const log = createLogger('Minebot:Goal');

export class GoalXZ {
  bot: CustomBot;
  constructor(bot: CustomBot) {
    this.bot = bot;
  }

  async run(x: number, z: number): Promise<ResponseType> {
    try {
      if (!x || !z) {
        log.debug(`x, zの位置情報が取得できません: x=${x} z=${z}`);
        return { success: false, result: 'x, zの位置情報が取得できません' };
      }
      const result = await gotoSafe(this.bot, new goals.GoalXZ(x, z), { timeoutMs: 30_000 });
      return result.success
        ? { success: true, result: 'ゴールに到達しました' }
        : { success: false, result: `ゴールに到達できませんでした（${result.error}）` };
    } catch (error) {
      log.error('Error in run', error);
      return { success: false, result: 'ゴールに到達できませんでした' };
    }
  }
}
