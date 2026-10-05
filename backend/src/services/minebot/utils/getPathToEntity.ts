import { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals, Movements } = pkg;
import { Vec3 } from 'vec3';
import { CustomBot } from '../types.js';
import { installSafeParkour } from './setMovements.js';

export class GetPathToEntity {
  bot: CustomBot;
  constructor(bot: CustomBot) {
    this.bot = bot;
  }
  async run(position: Vec3): Promise<pkg.ComputedPath> {
    const goal = new goals.GoalBlock(position.x, position.y, position.z);
    const defaultMove = new Movements(this.bot as Bot);
    defaultMove.allow1by1towers = true;
    defaultMove.canDig = true;
    defaultMove.allowParkour = true;
    defaultMove.allowSprinting = true;
    (defaultMove as any).infiniteLiquidDropdownDistance = false;
    installSafeParkour(defaultMove, defaultMove.maxDropDown);
    const path = await this.bot.pathfinder.getPathTo(defaultMove, goal);
    return path;
  }
}
