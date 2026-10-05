import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUiModPusher, startLabUiModBridge, type LabUiModBridge } from '../../src/services/minebot/testing/LabUiModBridge.js';
import { CONFIG } from '../../src/services/minebot/config/MinebotConfig.js';

// A stand-in for the mod's push server on loopback: records what the probe would show in the game.
async function fakeMod() {
  const received: Array<{ path: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push({ path: req.url ?? '', body: JSON.parse(body || 'null') }); res.end('{"success":true}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { received, port: (server.address() as AddressInfo).port, close: () => new Promise(resolve => server.close(resolve)) };
}
async function freePort() {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(check()).toBe(true);
};

const token = 'f'.repeat(48);
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); CONFIG.setUiModBaseUrlOverride(null); });

function fixtures() {
  const skill = { skillName: 'auto-eat', description: 'eat', status: true };
  const bot: any = { constantSkills: { getSkills: () => [skill], getSkill: (name: string) => name === skill.skillName ? skill : undefined },
    instantSkills: { getSkill: () => undefined }, entities: {}, username: 'I_am_Shannon' };
  const runtime: any = { setTaskListUpdateCallback: vi.fn(), getTaskListState: () => ({ tasks: [{ id: 'campaign', status: 'executing' }] }),
    removeTask: vi.fn(() => ({ success: true })) };
  const reactions: any = { getSettingsState: () => ({ reactions: [{ eventType: 'hostile_approach', enabled: true, probability: 100 }] }),
    updateConfig: vi.fn() };
  return { skill, bot, runtime, reactions };
}

describe('lab UI mod bridge', () => {
  it('pushes state to the mod and takes its chat and controls, with the world token only', async () => {
    const mod = await fakeMod(); closers.push(mod.close);
    const backendPort = await freePort();
    const { skill, bot, runtime, reactions } = fixtures();
    const chats: Array<[string, string]> = [];
    const controls: string[] = [];
    const bridge: LabUiModBridge = await startLabUiModBridge({ config: { backendPort, httpServerPort: mod.port, backendToken: token,
      botPlayerName: 'I_am_Shannon' }, bot, runtime, reactions,
      onChatMessage: async (sender, message) => { chats.push([sender, message]); }, onControl: route => controls.push(route) });
    closers.push(() => bridge.stop());
    expect(bridge.incoming).toBe(true);
    expect(mod.received.map(entry => entry.path).sort()).toEqual(['/constant_skills', '/reaction_settings', '/task_list']);
    expect(mod.received.find(entry => entry.path === '/constant_skills')?.body).toEqual([{ skillName: 'auto-eat', description: 'eat', status: true }]);
    // The chat skill posts its /bot_chat to CONFIG.UI_MOD_BASE_URL.
    expect(CONFIG.UI_MOD_BASE_URL).toBe(`http://127.0.0.1:${mod.port}`);

    runtime.setTaskListUpdateCallback.mock.calls[0][0]({ tasks: [{ id: 'chat', status: 'pending' }] });
    bridge.publishTaskTree({ goal: 'エンドラを倒す', status: 'in_progress', strategy: '' } as any);
    await until(() => mod.received.some(entry => entry.path === '/task') && mod.received.filter(entry => entry.path === '/task_list').length === 2);

    const backend = `http://127.0.0.1:${backendPort}`;
    const post = (route: string, body: unknown, auth = true) => fetch(`${backend}${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    expect((await post('/chat_message', { sender: 'Rai1241', message: 'こっち来て' }, false)).status).toBe(401);
    expect(chats).toEqual([]);
    expect((await post('/chat_message', { sender: 'Rai1241', message: 'こっち来て' })).status).toBe(200);
    expect(chats).toEqual([['Rai1241', 'こっち来て']]);

    // Settings stay as the run started: nothing reaches the shared saves files.
    const pushesBefore = mod.received.length;
    expect((await post('/constant_skill_switch', { skillName: 'auto-eat', status: 'false' })).status).toBe(403);
    expect((await post('/reaction_setting_update', { eventType: 'hostile_approach', probability: 0 })).status).toBe(403);
    expect(skill.status).toBe(true);
    expect(reactions.updateConfig).not.toHaveBeenCalled();
    await until(() => mod.received.length >= pushesBefore + 2);

    expect((await post('/task_delete', { taskId: 'campaign' })).status).toBe(200);
    expect(runtime.removeTask).toHaveBeenCalledWith('campaign');
    await until(() => controls.length === 1);
    expect(controls).toEqual(['/task_delete']);
    const list = await fetch(`${backend}/task_list`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await list.json()).tasks[0].id).toBe('campaign');
    expect(controls).toEqual(['/task_delete']);

    await bridge.stop();
    expect(CONFIG.UI_MOD_BASE_URL).not.toBe(`http://127.0.0.1:${mod.port}`);
    await expect(fetch(`${backend}/task_list`)).rejects.toThrow();
  });

  it('still pushes when the world has no token, but takes no calls', async () => {
    const mod = await fakeMod(); closers.push(mod.close);
    const warnings: string[] = [];
    const { bot, runtime, reactions } = fixtures();
    const bridge = await startLabUiModBridge({ config: { backendPort: await freePort(), httpServerPort: mod.port, backendToken: '',
      botPlayerName: 'I_am_Shannon' }, bot, runtime, reactions, onChatMessage: async () => {}, onWarning: code => warnings.push(code) });
    closers.push(() => bridge.stop());
    expect(bridge.incoming).toBe(false);
    expect(warnings).toEqual(['UI_MOD_TOKEN_MISSING']);
    expect(mod.received).toHaveLength(3);
  });

  it('never throws when the mod is absent, and keeps only the newest pending push per path', async () => {
    const absent = createUiModPusher(`http://127.0.0.1:${await freePort()}`, 300);
    await expect(absent('/task', { goal: 'x' })).resolves.toBeUndefined();
    const mod = await fakeMod(); closers.push(mod.close);
    const push = createUiModPusher(`http://127.0.0.1:${mod.port}`, 1000);
    const first = push('/task_list', { n: 1 });
    for (let n = 2; n <= 5; n++) void push('/task_list', { n });
    await first;
    await until(() => mod.received.length === 2);
    expect(mod.received.map(entry => entry.body.n)).toEqual([1, 5]);
  });
});
