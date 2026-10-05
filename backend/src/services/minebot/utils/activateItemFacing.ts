import type { Vec3 } from 'vec3';
import type { CustomBot } from '../types.js';

/**
 * Mineflayer 4.35 sends {yaw: 0, pitch: 0} in the modern use_item packet.
 * Minecraft 1.21.2+ performs item raycasts from those packet rotations, so
 * buckets and fishing rods can act southward instead of where the bot looks.
 * Patch exactly the synchronous packet emitted by activateItem(), preserving
 * Mineflayer's internal interaction sequence counter.
 */
export async function activateItemFacing(
  bot: CustomBot,
  target: Vec3,
  offHand = false,
): Promise<void> {
  await bot.lookAt(target, true);

  const client = (bot as any)._client;
  const originalWrite = client.write;
  client.write = function (name: string, data: any, ...rest: any[]) {
    if (name === 'use_item' && data?.rotation) {
      data = {
        ...data,
        rotation: {
          x: (180 / Math.PI) * (Math.PI - bot.entity.yaw),
          y: (180 / Math.PI) * (-bot.entity.pitch),
        },
      };
    }
    return originalWrite.call(this, name, data, ...rest);
  };

  try {
    bot.activateItem(offHand);
  } finally {
    client.write = originalWrite;
  }
}
