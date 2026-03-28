import pathfinder from 'mineflayer-pathfinder';
import { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { CustomBot } from '../types.js';
import { setMovements } from './setMovements.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:RunFromEntities');

export async function runFromEntities(
  bot: CustomBot,
  entities: Entity[],
  distance: number
) {
  if (entities.length === 0) return;

  let sumPosition = new Vec3(0, 0, 0);
  for (const entity of entities) {
    sumPosition = sumPosition.plus(entity.position);
  }
  const averagePosition = sumPosition.scaled(1 / entities.length);

  const currentDistance = bot.entity.position.distanceTo(averagePosition);
  if (currentDistance >= distance) return;

  setMovements(
    bot,
    false,  // allow1by1towers: 逃走中はタワーしない
    true,   // allowSprinting
    true,   // allowParkour
    true,   // canOpenDoors
    false,  // canDig: 逃走中は掘らない
    true,   // dontMineUnderFallingBlock
    100,    // digCost: 掘るコストを高く
    false,  // allowFreeMotion
    false   // canSwim: 水を避ける
  );

  const fleeGoal = new goals.GoalInvert(
    new goals.GoalNear(
      averagePosition.x,
      averagePosition.y,
      averagePosition.z,
      distance
    )
  );

  try {
    const timeoutMs = 5000;
    const fleePromise = bot.pathfinder.goto(fleeGoal);
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('flee timeout')), timeoutMs)
    );
    await Promise.race([fleePromise, timeoutPromise]);
  } catch (error: any) {
    if (error.message !== 'flee timeout') {
      log.warn(`逃走エラー: ${error.message}`);
    }
    try { bot.pathfinder.stop(); } catch { /* ignore */ }
  }
}
