import { createLogger } from '../../../utils/logger.js';
import { ConstantSkill, CustomBot } from '../types.js';
import { activateItemFacing } from '../utils/activateItemFacing.js';

const log = createLogger('Minebot:Skill:autoShootArrowToBlock');

/**
 * Periodically shoots the nearest configured block. This is useful for target
 * blocks, buttons behind a gap, or other ranged redstone mechanisms.
 */
class AutoShootArrowToBlock extends ConstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-shoot-arrow-to-block';
    this.description = '指定した種類の最寄りブロックへ弓矢を自動射撃する';
    this.interval = 3000;
    this.priority = 4;
    this.status = false;
    this.args = { blockName: null, searchDistance: 32 };
  }

  async runImpl(): Promise<void> {
    const blockName = typeof this.args.blockName === 'string'
      ? this.args.blockName.trim()
      : '';
    if (!blockName) return;

    const blockType = this.bot.registry.blocksByName[blockName];
    if (!blockType) {
      log.warn(`⚠ 不明な射撃対象ブロック: ${blockName}`);
      return;
    }

    const bow = this.bot.inventory.items().find(item => item.name === 'bow');
    const arrows = this.bot.inventory.items().some(item =>
      item.name === 'arrow' || item.name === 'spectral_arrow' || item.name === 'tipped_arrow'
    );
    if (!bow || (!arrows && this.bot.game.gameMode !== 'creative')) return;

    const target = this.bot.findBlock({
      matching: blockType.id,
      maxDistance: Number(this.args.searchDistance) || 32,
    });
    if (!target) return;

    await this.bot.equip(bow, 'hand');
    const aimPos = target.position.offset(0.5, 0.5, 0.5);
    await activateItemFacing(this.bot, aimPos, false);
    await new Promise(resolve => setTimeout(resolve, 1200));
    this.bot.deactivateItem();
    await new Promise(resolve => setTimeout(resolve, 250));
    log.info(`🏹 ${blockName} (${target.position.x},${target.position.y},${target.position.z}) へ自動射撃`);
  }
}

export default AutoShootArrowToBlock;
