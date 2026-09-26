import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore, setArtifactStoreForTests } from '../../../src/services/artifacts/artifactStore';
import SendArtifactOnDiscordTool from '../../../src/services/llm/tools/discord/sendArtifactOnDiscord';

let rootDirectory: string | null = null;

afterEach(async () => {
  setArtifactStoreForTests(null);
  if (rootDirectory) await rm(rootDirectory, { recursive: true, force: true });
  rootDirectory = null;
});

describe('send-artifact-on-discord', () => {
  it('保管済みartifactIdだけをリクエスト境界のDiscord会話へ渡す', async () => {
    rootDirectory = await mkdtemp(join(tmpdir(), 'shannon-artifact-send-test-'));
    const store = new ArtifactStore({ rootDirectory, ttlMs: 60_000 });
    setArtifactStoreForTests(store);
    const draft = await store.createDraft();
    await writeFile(join(draft.directory, 'guide.pdf'), 'pdf');
    await store.complete(draft, {
      kind: 'travel_brief',
      title: 'test',
      files: [{ role: 'pdf', fileName: 'guide.pdf', mediaType: 'application/pdf' }],
    });

    const tool = new SendArtifactOnDiscordTool();
    const received: unknown[] = [];
    tool.setDiscordConversationPort({
      replyWithArtifacts: async input => {
        received.push(input);
        return { status: 'sent', message: 'ok' };
      },
    } as any);
    const result = await tool.invoke({
      artifactId: draft.id,
      message: '資料を作りました。',
      channelId: 'channel-1',
      guildId: 'guild-1',
    });

    expect(JSON.parse(String(result)).status).toBe('sent');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      channelId: 'channel-1',
      guildId: 'guild-1',
      artifactIds: [draft.id],
    });
  });
});
