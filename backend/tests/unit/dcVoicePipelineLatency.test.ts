/**
 * dc-voice: how much time the BODY adds between the head sending something and Shannon's voice starting.
 *
 * A pretend head (a real HTTP server, NDJSON and PCM over a socket) answers with known waits: the decision after
 * 120 ms, the first sentence after 900 ms, and its voice 100 ms after being asked. The real client, the real turn
 * logic and the real player run against it; only the Discord audio player is replaced by a 20 ms-frame fake.
 * What is measured is the body's own added delay: filler start minus decision written, and first-sentence start
 * minus (sentence written + voice wait). The target is under 50 ms each (which includes the up-to-20 ms wait
 * for the audio player's next frame, a cost the real Discord player has too).
 */
import http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pcm24kMonoTo48kStereo, pcm48kStereoTo16kMono } from '../../src/services/discord/voice/pcm.js';
import { SpeechFillerStore } from '../../src/services/discord/voice/speechFillerStore.js';
import { SpeechPlayer } from '../../src/services/discord/voice/speechPlayer.js';
import type { TurnItem } from '../../src/services/discord/voice/turnQueue.js';
import { runDcVoiceTurn } from '../../src/services/llm/voice/dcVoiceTurn.js';
import { createShannonCoreVoiceClient } from '../../src/services/integration/shannonCoreVoiceClient.js';
import { FakeAudio, audioMs, sleep } from '../helpers/dcVoiceFakes.js';

const DECISION_AT_MS = 120;
const SENTENCE_AT_MS = 900;
const SPEECH_FIRST_CHUNK_MS = 100;

describe('body-side pipeline latency (pretend head over HTTP)', () => {
  let server: http.Server;
  let port = 0;
  const marks: { decisionWritten: number; sentenceWritten: number } = { decisionWritten: 0, sentenceWritten: 0 };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/v1/platform/voice/turn') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          setTimeout(() => {
            marks.decisionWritten = Date.now();
            res.write(`${JSON.stringify({ type: 'decision', respond: true, reason: 'solo', filler: { id: 'un', text: 'うん。' } })}\n`);
          }, DECISION_AT_MS);
          setTimeout(() => {
            marks.sentenceWritten = Date.now();
            res.write(`${JSON.stringify({ type: 'sentence', index: 0, text: 'いいよ、聞かせて。' })}\n`);
          }, SENTENCE_AT_MS);
          setTimeout(() => {
            res.write(`${JSON.stringify({ type: 'done', reply: 'いいよ、聞かせて。', threadId: 't', duplicate: false })}\n`);
            res.end();
          }, SENTENCE_AT_MS + 40);
          return;
        }
        if (req.url === '/v1/platform/voice/speech') {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'audio/l16;rate=24000;channels=1' });
            const pcm = audioMs(400);
            for (let at = 0; at < pcm.length; at += 4_800) res.write(pcm.subarray(at, at + 4_800));
            res.end();
          }, SPEECH_FIRST_CHUNK_MS);
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  it('adds less than 50 ms between the head speaking and Shannon starting to speak, and does not stall the event loop', async () => {
    const client = createShannonCoreVoiceClient({
      url: `http://127.0.0.1:${port}/v1/platform/turns`,
      token: 'a'.repeat(32),
      bindingsJson: JSON.stringify([{ platform: 'discord', conversationIdPrefix: 'discord:1:', ownerUserId: '7' }]),
      timeoutMs: 3_000,
    })!;
    const audio = new FakeAudio().auto(20); // the real player works in 20 ms frames
    const player = new SpeechPlayer({ port: audio.port, createResource: audio.createResource, pollMs: 5 });
    const store = new SpeechFillerStore();
    store.set([{ id: 'un', text: 'うん。', pcm: audioMs(300, 5) }]);
    const logs: string[] = [];
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();

    const endAt = Date.now();
    const item: TurnItem = {
      userId: '7', name: 'ライ', text: 'ねえ、ちょっと聞いてくれる？', startedAt: endAt - 2_000, endAt, queuedAt: endAt,
      sttMs: 300, utteranceMs: 2_000, endpointMs: 600, parts: 1,
    };
    // This VC has two people, so the filler comes from the decision (the one-person early start is covered elsewhere).
    const result = await runDcVoiceTurn({
      conversationId: 'discord:1:2', voiceChannelId: '9', client, fillers: store, player,
      speakingNow: () => false, followsShannonTurn: () => false, participants: () => ['7', '8'], heard: () => [],
      situation: () => undefined, voicepeakWav: async () => { throw new Error('VOICEPEAK must not be needed'); },
      legacy: async () => { throw new Error('the old path must not be needed'); },
      postText: () => undefined, log: line => logs.push(line),
    }, item);
    loop.disable();
    audio.dispose();

    expect(result).toMatchObject({ responded: true, path: 'head' });
    const line = logs[0]!;
    const fillerStartMs = Number(/fillerStartMs=(\d+)/.exec(line)![1]);
    const firstSentenceMs = Number(/firstSentenceMs=(\d+)/.exec(line)![1]);
    const decisionMs = Number(/decisionMs=(\d+)/.exec(line)![1]);
    const fillerOverhead = endAt + fillerStartMs - marks.decisionWritten;
    const sentenceOverhead = endAt + firstSentenceMs - (marks.sentenceWritten + SPEECH_FIRST_CHUNK_MS);
    const loopP99 = loop.percentile(99) / 1e6;
    const loopMax = loop.max / 1e6;

    // eslint-disable-next-line no-console
    console.info(`[dc-voice latency] decision written at +${marks.decisionWritten - endAt}ms (decisionMs=${decisionMs}); `
      + `filler started +${fillerStartMs}ms (body added ${fillerOverhead}ms); `
      + `first sentence written +${marks.sentenceWritten - endAt}ms, voice wait ${SPEECH_FIRST_CHUNK_MS}ms, started +${firstSentenceMs}ms (body added ${sentenceOverhead}ms); `
      + `event loop p99=${loopP99.toFixed(1)}ms max=${loopMax.toFixed(1)}ms`);

    expect(fillerOverhead).toBeGreaterThanOrEqual(0);
    expect(fillerOverhead).toBeLessThan(50);
    expect(sentenceOverhead).toBeLessThan(50);
    expect(firstSentenceMs).toBeGreaterThan(fillerStartMs);
    expect(loopMax).toBeLessThan(100);
  });

  it('keeps the signal-processing cost of a long utterance and a long reply small', () => {
    // 30 s captured speech (the cap) -> Whisper input; 10 s of reply -> Discord format.
    const captured = Buffer.alloc(30 * 48_000 * 4, 3);
    const t0 = process.hrtime.bigint();
    const forWhisper = pcm48kStereoTo16kMono(captured);
    const t1 = process.hrtime.bigint();
    const forDiscord = pcm24kMonoTo48kStereo(Buffer.alloc(10 * 24_000 * 2, 3));
    const t2 = process.hrtime.bigint();
    const downmixMs = Number(t1 - t0) / 1e6;
    const upsampleMs = Number(t2 - t1) / 1e6;
    // eslint-disable-next-line no-console
    console.info(`[dc-voice latency] 30 s downmix to 16k mono: ${downmixMs.toFixed(1)}ms; 10 s upsample to 48k stereo: ${upsampleMs.toFixed(1)}ms`);
    expect(forWhisper.length).toBe(30 * 16_000 * 2);
    expect(forDiscord.length).toBe(10 * 48_000 * 4);
    expect(downmixMs).toBeLessThan(200);
    expect(upsampleMs).toBeLessThan(100);
    void sleep;
  });
});
