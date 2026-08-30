import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearServiceCommandHandlers,
  dispatchServiceCommand,
  registerServiceCommandHandler,
} from '../../../src/services/runtime/serviceCommandRegistry.js';
import {
  clearPlatformToolPorts,
  getNotionToolPort,
  getTwitterToolPort,
  getYoutubeToolPort,
  registerNotionToolPort,
  registerTwitterToolPort,
  registerYoutubeToolPort,
} from '../../../src/services/runtime/platformToolGateway.js';
import {
  clearMinebotSkillHandlers,
  invokeMinebotSkill,
  invokeMinebotSkillFromParameters,
  registerMinebotSkillHandler,
  unregisterMinebotSkillHandler,
} from '../../../src/services/runtime/minebotSkillGateway.js';
import {
  clearSchedulerPort,
  getSchedulerPort,
  registerSchedulerPort,
} from '../../../src/services/runtime/schedulerGateway.js';
import {
  clearLlmInbound,
  getLlmInbound,
  registerLlmInbound,
} from '../../../src/services/runtime/llmInboundRegistry.js';
import {
  clearVoiceGateway,
  getVoiceGateway,
  registerVoiceGateway,
} from '../../../src/services/runtime/voiceGateway.js';
import {
  deliverWebMessageToLlm,
} from '../../../src/services/runtime/llmInboundDispatch.js';

describe('runtime gateways', () => {
  beforeEach(() => {
    clearServiceCommandHandlers();
    clearPlatformToolPorts();
    clearMinebotSkillHandlers();
    clearSchedulerPort();
    clearLlmInbound();
    clearVoiceGateway();
  });

  afterEach(() => {
    clearServiceCommandHandlers();
    clearPlatformToolPorts();
    clearMinebotSkillHandlers();
    clearSchedulerPort();
    clearLlmInbound();
    clearVoiceGateway();
  });

  describe('serviceCommandRegistry', () => {
    it('dispatches to a registered handler with optional serverName', async () => {
      const handler = vi.fn();
      registerServiceCommandHandler('discord', handler);
      await dispatchServiceCommand('discord', 'status', 'guild-a');
      expect(handler).toHaveBeenCalledWith('status', { serverName: 'guild-a' });
    });

    it('no-ops when the service is unknown', async () => {
      const handler = vi.fn();
      registerServiceCommandHandler('discord', handler);
      await dispatchServiceCommand('twitter', 'status');
      expect(handler).not.toHaveBeenCalled();
    });

    it('rejects duplicate registration', () => {
      registerServiceCommandHandler('discord', vi.fn());
      expect(() => registerServiceCommandHandler('discord', vi.fn())).toThrow(/already registered/);
    });
  });

  describe('platformToolGateway', () => {
    it('returns registered Twitter/Notion/YouTube ports', async () => {
      const twitter = {
        postMessage: vi.fn(async () => ({ isSuccess: true, errorMessage: '' })),
        likeTweet: vi.fn(),
        retweetTweet: vi.fn(),
        quoteRetweet: vi.fn(),
        getTweetContent: vi.fn(),
        postScheduledMessage: vi.fn(),
        checkReplies: vi.fn(),
      };
      const notion = { getPageMarkdown: vi.fn(async () => ({ markdown: '# fixture' })) };
      const youtube = { getVideoInfo: vi.fn(async () => ({ id: 'abc' })) };
      registerTwitterToolPort(twitter);
      registerNotionToolPort(notion);
      registerYoutubeToolPort(youtube);
      await expect(getTwitterToolPort().postMessage({ text: 'hi', replyId: null })).resolves.toEqual({
        isSuccess: true,
        errorMessage: '',
      });
      await expect(getNotionToolPort().getPageMarkdown('page-1')).resolves.toEqual({ markdown: '# fixture' });
      await expect(getYoutubeToolPort().getVideoInfo('abc')).resolves.toEqual({ id: 'abc' });
    });

    it('throws when ports are missing or duplicated', () => {
      expect(() => getTwitterToolPort()).toThrow(/not registered/);
      registerTwitterToolPort({
        postMessage: vi.fn(),
        likeTweet: vi.fn(),
        retweetTweet: vi.fn(),
        quoteRetweet: vi.fn(),
        getTweetContent: vi.fn(),
        postScheduledMessage: vi.fn(),
        checkReplies: vi.fn(),
      });
      expect(() => registerTwitterToolPort({} as any)).toThrow(/already registered/);
    });
  });

  describe('minebotSkillGateway', () => {
    it('invokes a registered skill and normalizes SkillParameters', async () => {
      const handler = vi.fn(async (args: unknown[]) => ({ success: true, result: args.join(',') }));
      registerMinebotSkillHandler('move', handler);
      await expect(invokeMinebotSkill('move', ['north', '3'])).resolves.toEqual({
        success: true,
        result: 'north,3',
      });
      await expect(
        invokeMinebotSkillFromParameters('move', { skillParameters: ['east', '1'] }),
      ).resolves.toEqual({ success: true, result: 'east,1' });
      unregisterMinebotSkillHandler('move');
      await expect(invokeMinebotSkill('move', [])).resolves.toMatchObject({ success: false });
    });

    it('returns a failure payload for missing skills and handler errors', async () => {
      await expect(invokeMinebotSkill('missing', [])).resolves.toEqual({
        success: false,
        result: 'Skill not registered: missing',
      });
      registerMinebotSkillHandler('boom', async () => {
        throw new Error('skill exploded');
      });
      await expect(invokeMinebotSkill('boom', [])).resolves.toEqual({
        success: false,
        result: 'skill exploded',
      });
    });
  });

  describe('schedulerGateway', () => {
    it('returns a registered scheduler port', async () => {
      const port = {
        getSchedule: vi.fn(),
        callSchedule: vi.fn(),
        listSchedules: vi.fn(() => []),
      };
      registerSchedulerPort(port);
      expect(getSchedulerPort()).toBe(port);
    });
  });

  describe('llmInboundRegistry + dispatch', () => {
    it('forwards web messages through the registered router', () => {
      const router = { handleWebMessage: vi.fn() };
      registerLlmInbound(router as any);
      deliverWebMessageToLlm({ role: 'user', content: 'hello', sessionId: 's1' } as any);
      expect(getLlmInbound()).toBe(router);
      expect(router.handleWebMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'hello', sessionId: 's1' }),
      );
    });
  });

  describe('voiceGateway', () => {
    it('returns a registered voice gateway', () => {
      const gateway = {
        publishStatus: vi.fn(),
        postTranscript: vi.fn(),
        startQueue: vi.fn(),
        enqueueAudio: vi.fn(),
        endQueue: vi.fn(),
        streamSentence: vi.fn(),
        playFiller: vi.fn(),
        routeToMinebotVoice: vi.fn(),
        waitForTextReply: vi.fn(),
      };
      registerVoiceGateway(gateway);
      expect(getVoiceGateway()).toBe(gateway);
    });
  });
});
