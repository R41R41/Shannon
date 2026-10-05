/**
 * How the body has been spending energy since it connected: metres walked,
 * sprinted and swum, and jumps taken. Hunger falls with sprinting and jumping
 * but not with walking (measured on the lab server: 350m walked cost no food,
 * the same distance sprinted cost 8 points), yet the planner and the
 * reflections saw only the food level dropping, never what spent it.
 */
export interface Exertion { walkedMetres: number; sprintedMetres: number; swumMetres: number; jumps: number }

interface MeterBot {
  entity?: { position: { x: number; y: number; z: number }; onGround: boolean; isInWater?: boolean };
  getControlState(control: string): boolean;
  on(event: 'physicsTick', listener: () => void): unknown;
}

const TELEPORT_METRES_PER_TICK = 2;

export function installExertionMeter(bot: MeterBot): void {
  const marked = bot as MeterBot & { exertion?: Exertion };
  if (marked.exertion) return;
  const exertion: Exertion = marked.exertion = { walkedMetres: 0, sprintedMetres: 0, swumMetres: 0, jumps: 0 };
  let last: { x: number; z: number; onGround: boolean } | null = null;
  bot.on('physicsTick', () => {
    const entity = bot.entity;
    if (!entity) { last = null; return; }
    const { x, z } = entity.position;
    if (last) {
      const moved = Math.hypot(x - last.x, z - last.z);
      if (moved < TELEPORT_METRES_PER_TICK) {
        if (entity.isInWater) exertion.swumMetres += moved;
        else if (bot.getControlState('sprint')) exertion.sprintedMetres += moved;
        else exertion.walkedMetres += moved;
      }
      if (last.onGround && !entity.onGround && bot.getControlState('jump')) exertion.jumps++;
    }
    last = { x, z, onGround: entity.onGround };
  });
}

/** As a mineflayer plugin. */
export function exertionMeterPlugin(bot: unknown): void { installExertionMeter(bot as MeterBot); }

export function roundedExertion(exertion: Exertion | undefined): Exertion | undefined {
  return exertion ? { walkedMetres: Math.round(exertion.walkedMetres), sprintedMetres: Math.round(exertion.sprintedMetres),
    swumMetres: Math.round(exertion.swumMetres), jumps: exertion.jumps } : undefined;
}
