/**
 * 水/溶岩ブロックの level を堅牢に取得するユーティリティ。
 * level 0 = source (バケツで汲める), 1-7 = flowing, 8-15 = falling
 */

import minecraftData from 'minecraft-data';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:waterLevel');

let warnedOnce = false;

/**
 * ブロックの water/lava level を取得。
 * getProperties().level → metadata → stateId offset の順にフォールバック。
 */
export function getWaterLevel(block: any): number {
  // getProperties() — 1.13+ の主流
  if (typeof block.getProperties === 'function') {
    const props = block.getProperties();
    if (props && props.level !== undefined && props.level !== null) {
      return Number(props.level);
    }
  }

  // metadata — レガシーやフォールバック
  if (typeof block.metadata === 'number' && block.metadata >= 0) {
    return block.metadata & 0x7;
  }

  // stateId ベース — minecraft-data の minStateId がソース (level=0)
  if (typeof block.stateId === 'number' && block.type !== undefined) {
    try {
      const ver = block._mcVersion || '1.21';
      const mcData = minecraftData(ver);
      const blockType = mcData.blocks[block.type];
      if (blockType && typeof blockType.minStateId === 'number') {
        return block.stateId - blockType.minStateId;
      }
    } catch { /* ignore */ }
  }

  if (!warnedOnce) {
    warnedOnce = true;
    log.warn(
      `⚠ 水ブロックのlevel取得失敗: name=${block.name}, stateId=${block.stateId}, ` +
      `metadata=${block.metadata}, props=${JSON.stringify(block.getProperties?.())}`,
    );
  }
  return -1;
}
