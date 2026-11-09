import { describe, expect, it } from 'vitest';
import { installUseItemRotation, useItemRotation } from '../../src/services/minebot/utils/useItemRotation.js';

// end1108h8 S7: mineflayer wrote use_item with rotation {0, 0}; the 1.21.2+ server turned the body south at each draw and shield raised.
describe('use_item carries the body\'s own look', () => {
  it('rewrites the rotation of use_item with the look, and leaves other packets alone', () => {
    const written: Array<[string, any]> = [];
    const client = { write: (name: string, data: any) => { written.push([name, data]); } };
    const bot: any = { _client: client, entity: { yaw: Math.PI / 2, pitch: 0.3 } };
    installUseItemRotation(bot);
    installUseItemRotation(bot); // once only
    bot._client.write('use_item', { hand: 0, sequence: 4, rotation: { x: 0, y: 0 } });
    bot._client.write('look', { yaw: 1, pitch: 2 });
    expect(written[0][0]).toBe('use_item');
    expect(written[0][1].rotation.x).toBeCloseTo(90, 5);
    expect(written[0][1].rotation.y).toBeCloseTo(-0.3 * 180 / Math.PI, 5);
    expect(written[0][1]).toMatchObject({ hand: 0, sequence: 4 });
    expect(written[1]).toEqual(['look', { yaw: 1, pitch: 2 }]);
    expect(written).toHaveLength(2);
  });

  it('turns mineflayer\'s yaw to the game\'s degrees: facing north (yaw 0) is 180', () => {
    expect(useItemRotation(0, 0)).toEqual({ x: 180, y: -0 });
  });
});
