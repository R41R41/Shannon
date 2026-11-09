import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// 実サーバーを起動せず、ラボの実際の場面関数・登録・選択を動かし、送る命令と集計を検査する。
const source = readFileSync(new URL('../../scripts/minecraft-hunt-probe.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['scenes', 'scene', 'wanted', 'chosen']);
const parts = parsed.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'witherTrio'
  || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && names.has(declaration.name.text))
  || ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(parsed) === 'scene'
    && statement.expression.arguments[0]?.getText(parsed).startsWith("'wither_trio_")
).map(statement => statement.getText(parsed));
const javascript = ts.transpileModule(parts.join('\n') + '\n({ scenes, chosen });', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function lab(wanted: string, die = false) {
  const actor = Object.assign(new EventEmitter(), { health: 20, floorReflexes: { engagements: { meleeStopped: 4, fleeStuckTurns: 2, pillar: 1 } } });
  const context: any = { actor, ACTOR: 'MinebotTrial', process: { env: { MINECRAFT_HUNT_SCENES: wanted } }, sites: { netherArrival: [100, 65, 200] }, deaths: 0, disconnected: null,
    timedSeconds: 0.001, Date, Math, JSON, Number, Error, r1: (value: number) => Math.round(value * 10) / 10,
    sleep: vi.fn(async () => {}), placeActor: vi.fn(async () => {}), equip: vi.fn(async () => {}),
    ask: vi.fn(async (command: string) => {
      // 掃除で倒した敵を、体が倒した数へ混ぜない。
      if (command.includes('kill @e[tag=')) actor.emit('entityDead', { name: 'wither_skeleton', position: { x: 104, y: 100, z: 200 } });
      return '';
    }),
    act: vi.fn(async () => {
      actor.health = 12; actor.emit('health'); actor.health = 16; actor.emit('health');
      actor.emit('entityDead', { name: 'wither_skeleton', position: { x: 104, y: 100, z: 200 } });
      actor.floorReflexes.engagements.meleeStopped += 2; actor.floorReflexes.engagements.fleeStuckTurns++; actor.floorReflexes.engagements.pillar++;
      if (die) { context.deaths++; actor.emit('death'); }
      return { stoppedBy: 'hurt', stoppedWhy: '受け切れない: wither_skeleton の一撃 8.0 ×2、残り 12.0', lines: ['go 止まった'] };
    }),
  };
  return { ...runInNewContext(javascript, context), context };
}

describe('wither_trio の隔離ラボ場面', () => {
  it('既定では2場面を実行しない', () => {
    const { scenes, chosen } = lab('');
    expect(scenes.map((entry: any) => entry.name)).toEqual(['wither_trio_naked', 'wither_trio_armored']);
    expect(chosen).toHaveLength(0);
  });

  it.each(['wither_trio_naked', 'wither_trio_armored'])('=%s で1場面だけ選べ、ネザー通路の奥へ accept 付き go を1回出す', async name => {
    const { chosen, context } = lab(`=${name}`);
    expect(chosen).toHaveLength(1); expect(chosen[0].name).toBe(name);
    const data = await chosen[0].run(vi.fn());
    const commands = context.ask.mock.calls.map((call: any[]) => call[0] as string);
    expect(commands).toContain('execute in minecraft:the_nether run fill 87 99 198 117 103 202 minecraft:nether_bricks');
    expect(commands).toContain('execute in minecraft:the_nether run fill 88 100 199 116 102 201 minecraft:air');
    const summons = commands.filter((command: string) => command.includes('summon minecraft:wither_skeleton'));
    expect(summons).toHaveLength(3);
    expect(summons.every((command: string) => command.startsWith('execute in minecraft:the_nether run summon minecraft:wither_skeleton 104 100 '))).toBe(true);
    expect(context.placeActor).toHaveBeenCalledWith('the_nether', 100, 100, 200, 24);
    expect(context.act).toHaveBeenCalledTimes(1);
    expect(context.act).toHaveBeenCalledWith(expect.any(String), [{ do: 'go', to: { x: 112, y: 100, z: 200 }, range: 0.8, seconds: 25 }], 40, { accept: ['wither_skeleton'] });
    for (const slot of ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet', 'weapon.offhand']) expect(commands).toContain(`item replace entity MinebotTrial ${slot} with minecraft:air`);
    const armored = name.endsWith('armored');
    expect(commands.some((command: string) => command.includes('armor.chest with minecraft:iron_chestplate'))).toBe(armored);
    expect(commands.some((command: string) => command.includes('weapon.offhand with minecraft:shield'))).toBe(armored);
    expect(commands).toContain(`item replace entity MinebotTrial weapon.mainhand with minecraft:${armored ? 'iron_sword' : 'wooden_sword'}`);
    expect(data).toMatchObject({ died: false, lowestHp: 12, stoppedWhy: expect.stringContaining('受け切れない'), meleeStopped: 2, fleeStuckTurns: 1, pillars: 1, kills: 1, seconds: expect.any(Number) });
    expect(context.actor.listenerCount('health')).toBe(0);
    expect(context.actor.listenerCount('entityDead')).toBe(0);
  });

  it('接頭辞 wither_trio なら2場面を選べ、死亡時の最低体力は0とする', async () => {
    const { chosen, context } = lab('wither_trio', true);
    expect(chosen).toHaveLength(2);
    expect(await chosen[0].run(vi.fn())).toMatchObject({ died: true, lowestHp: 0 });
    expect(context.actor.listenerCount('death')).toBe(0);
  });
});
