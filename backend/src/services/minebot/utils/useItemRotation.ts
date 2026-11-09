/**
 * end1108h8 S7: mineflayer 4.35 writes every use_item (a bow drawn, a shield raised, a bucket, a potion thrown) with the rotation {x: 0, y: 0},
 * and a 1.21.2+ server turns the player to the packet's rotation. So each draw turned the body south and level on the server: an arrow let go
 * before the next look packet flew south (15 「外れた」 in a row at blazes 3 to 6 m off), and each shield raised faced south, where it only
 * blocks what comes from the south. The packet is written with the body's own look (as instantSkills/fish.ts did for the cast alone).
 */
export function useItemRotation(yaw: number, pitch: number): { x: number; y: number } {
  // mineflayer's radians to the game's degrees (its conversions: yaw degrees(pi - yaw), pitch degrees(-pitch)).
  return { x: (180 / Math.PI) * (Math.PI - yaw), y: (180 / Math.PI) * -pitch };
}

const installed = new WeakSet<object>();

export function installUseItemRotation(bot: any): void {
  const client = bot?._client;
  if (!client || typeof client.write !== 'function' || installed.has(client)) return;
  installed.add(client);
  const write = client.write.bind(client);
  client.write = function (name: string, data: any, ...rest: any[]) {
    if (name === 'use_item' && data?.rotation && Number.isFinite(bot.entity?.yaw) && Number.isFinite(bot.entity?.pitch)) {
      data = { ...data, rotation: useItemRotation(bot.entity.yaw, bot.entity.pitch) };
    }
    return write(name, data, ...rest);
  };
}
