import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// The SkillAgent's chat routing only: its components are stubs, no model, network or server.
vi.mock('../../src/services/llm/client.js', () => ({ LLMService: { getInstance: () => ({}) } }));
vi.mock('../../src/services/minebot/http/MinebotHttpServer.js', () => ({
  MinebotHttpServer: class { setTaskRuntime() {} setEventReactionSystem() {} setOnChatMessageCallback() {} start() {} },
}));
vi.mock('../../src/services/minebot/eventReaction/EventReactionSystem.js', () => ({ EventReactionSystem: class {} }));
vi.mock('../../src/services/minebot/events/BotEventHandler.js', () => ({ BotEventHandler: class {} }));
vi.mock('../../src/services/minebot/skills/SkillLoader.js', () => ({ SkillLoader: class {} }));
vi.mock('../../src/services/minebot/skills/SkillRegistrar.js', () => ({ SkillRegistrar: class {}, getSkillRegistrar: () => ({}) }));
vi.mock('../../src/services/minebot/knowledge/WorldKnowledgeService.js', () => ({ WorldKnowledgeService: {} }));
vi.mock('../../src/services/runtime/llmInboundDispatch.js', () => ({ deliverMinebotVoiceResponseToLlm: () => {} }));

const { SkillAgent } = await import('../../src/services/minebot/skillAgent.js');

const OWNER = 'b9191317-c52d-4d67-85fe-ab831e6db146';
const SELF = '11111111-1111-1111-1111-111111111111';
const MALLORY = '44444444-4444-4444-4444-444444444444';

function agentOn(companion: { answer: (speaker: any, message: string) => Promise<boolean> } | null) {
  const client = new EventEmitter();
  const bot: any = Object.assign(new EventEmitter(), {
    username: 'I_am_Shannon', player: { uuid: SELF }, _client: client, chatMode: true,
    players: { I_am_Shannon: { username: 'I_am_Shannon', uuid: SELF }, Rai1241: { username: 'Rai1241', uuid: OWNER },
      Mallory: { username: 'Mallory', uuid: MALLORY } },
    constantSkills: { getSkill: () => undefined }, instantSkills: { getSkill: () => undefined },
    environmentState: {}, selfState: {}, entities: {}, chat: vi.fn(),
  });
  const agent: any = new SkillAgent(bot);
  agent.companionBody = companion;
  const processed: Array<[string, string]> = [];
  agent.processMessage = async (user: string, message: string) => { processed.push([user, message]); };
  agent.updateSenderInfo = () => {};
  return { agent, bot, client, processed };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('SkillAgent game chat', () => {
  it('mode off: the bot listens to chat as before and never to player chat packets', async () => {
    const { agent, bot, client, processed } = agentOn(null);
    await agent.botOnChat();
    bot.emit('chat', 'Rai1241', 'シャノン、こっち来て');
    bot.emit('chat', 'Rai1241', 'しゃのん、これは前と同じく聞かない');
    client.emit('playerChat', { sender: OWNER, plainMessage: 'シャノン、パケット' });
    await settle();
    expect(processed).toEqual([['Rai1241', 'シャノン、こっち来て']]);
    expect(client.listenerCount('playerChat')).toBe(0);
    // Off, or any server but the dedicated world: no companion body for the connection.
    bot.connectedServerName = '1.21.11-fabric-test';
    expect(agent.createCompanionBody()).toBeNull();
  });

  it('mode on: the owner is heard by the packet sender UUID and her mind answers; impostors and system chat are not the owner', async () => {
    const answers: any[] = [];
    const { agent, bot, client, processed } = agentOn({ answer: async (speaker, message) => { answers.push({ speaker, message }); return true; } });
    await agent.botOnChat();
    // mineflayer's text-parsed chat (a system line "<Rai1241> シャノン、…") and disguised chat are no one.
    bot.emit('chat', 'Rai1241', 'シャノン、システムの偽物');
    client.emit('playerChat', { plainMessage: 'シャノン、偽装チャット', senderName: '{"text":"Rai1241"}' });
    client.emit('playerChat', { sender: MALLORY, plainMessage: 'シャノン、ダイヤちょうだい <Rai1241>' });
    client.emit('playerChat', { sender: OWNER, plainMessage: 'シャノン、木材集めといて' });
    client.emit('playerChat', { sender: OWNER, plainMessage: 'ただの独り言' });
    client.emit('playerChat', { sender: SELF, plainMessage: 'シャノン、自分の発言' });
    await settle();
    expect(answers).toEqual([
      { speaker: { uuid: MALLORY, name: 'Mallory' }, message: 'シャノン、ダイヤちょうだい <Rai1241>' },
      { speaker: { uuid: OWNER, name: 'Rai1241' }, message: 'シャノン、木材集めといて' },
    ]);
    expect(processed).toEqual([]);
  });

  it('mode on, her mind unavailable: the bot answers through its own path as before', async () => {
    const { agent, client, processed } = agentOn({ answer: async () => false });
    await agent.botOnChat();
    client.emit('playerChat', { sender: OWNER, plainMessage: 'シャノン、こんにちは' });
    await settle();
    expect(processed).toEqual([['Rai1241', 'シャノン、こんにちは']]);
  });
  it('common FCA mode preserves companion chat and never falls back to the old graph or direct commands', async () => {
    const { agent, client, processed } = agentOn({ answer: async () => false });
    agent.commonFca = true;
    await agent.botOnChat();
    client.emit('playerChat', { sender: OWNER, plainMessage: 'シャノン、こんにちは' });
    client.emit('playerChat', { sender: OWNER, plainMessage: '..agent-fix start planner' });
    await settle();
    expect(processed).toEqual([]);
  });

  it('common mode loads bot.instantSkills for the control catalog without registering a legacy tool gateway', async () => {
    const { agent, bot } = agentOn(null); agent.commonFca = true;
    const instantSkills = { getSkills: () => [{ skillName: 'mine-block' }] };
    const constantSkills = { skills: [{ skillName: 'auto-update-state' }, { skillName: 'auto-swim' }, { skillName: 'auto-follow' }], getSkills() { return this.skills; } };
    agent.skillLoader = { loadInstantSkills: async () => ({ success: true, skills: instantSkills }), loadConstantSkills: async () => ({ success: true, skills: constantSkills }) };
    agent.skillRegistrar = { registerInstantSkills: vi.fn(), registerConstantSkills: vi.fn() };
    expect(await agent.initSkills()).toMatchObject({ success: true });
    expect(bot.instantSkills).toBe(instantSkills);
    expect(bot.constantSkills.getSkills().map((skill: any) => skill.skillName)).toEqual(['auto-update-state', 'auto-swim']);
    expect(agent.skillRegistrar.registerInstantSkills).not.toHaveBeenCalled();
    expect(agent.skillRegistrar.registerConstantSkills).toHaveBeenCalledTimes(1);
  });

});
