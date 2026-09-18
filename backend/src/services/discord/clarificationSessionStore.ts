import type { DiscordClarificationInput } from '@shannon/common';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ClarificationSession extends DiscordClarificationInput {
  status: 'pending' | 'answered' | 'expired';
  messageId?: string;
  createdAt: string;
  answeredAt?: string;
  answers?: Record<string, string>;
  draftAnswers?: Record<string, string>;
}

/** Preserve native select answers when the requester accepts Shannon's proposal. */
export function buildAcceptedClarificationAnswers(
  session: Pick<ClarificationSession, 'draftAnswers' | 'proposal'>,
): Record<string, string> {
  return {
    ...(session.draftAnswers ?? {}),
    ...(session.proposal ? { '推奨条件': session.proposal } : {}),
  };
}

function runtimeRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith(`${path.sep}backend`)
    ? path.join(cwd, 'saves', 'discord', 'clarifications')
    : path.join(cwd, 'backend', 'saves', 'discord', 'clarifications');
}

/** Durable, server-owned store for resumable Discord clarification forms. */
export class ClarificationSessionStore {
  private static instance: ClarificationSessionStore;
  private readonly root = runtimeRoot();
  private readonly cache = new Map<string, ClarificationSession>();
  private readonly answering = new Set<string>();

  static getInstance(): ClarificationSessionStore {
    if (!this.instance) this.instance = new ClarificationSessionStore();
    return this.instance;
  }

  async create(input: DiscordClarificationInput): Promise<ClarificationSession> {
    await this.cleanupExpired();
    const session: ClarificationSession = {
      ...input,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await this.save(session);
    return session;
  }

  async cleanupExpired(now = Date.now()): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    const names = await readdir(this.root).catch(() => [] as string[]);
    await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
      try {
        const filePath = path.join(this.root, name);
        const session = JSON.parse(await readFile(filePath, 'utf8')) as ClarificationSession;
        const terminalAt = Date.parse(session.answeredAt ?? session.expiresAt);
        if (Number.isFinite(terminalAt) && terminalAt + retentionMs < now) {
          await unlink(filePath);
          this.cache.delete(session.clarificationId);
        }
      } catch {
        // A partially written or manually removed runtime file is ignored.
      }
    }));
  }

  async get(id: string): Promise<ClarificationSession | null> {
    const cached = this.cache.get(id);
    if (cached) return this.markExpired(cached);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    try {
      const parsed = JSON.parse(await readFile(path.join(this.root, `${id}.json`), 'utf8')) as ClarificationSession;
      this.cache.set(id, parsed);
      return this.markExpired(parsed);
    } catch {
      return null;
    }
  }

  async attachMessage(id: string, messageId: string): Promise<void> {
    const session = await this.get(id);
    if (!session) return;
    session.messageId = messageId;
    await this.save(session);
  }

  async answer(id: string, answers: Record<string, string>): Promise<ClarificationSession | null> {
    if (this.answering.has(id)) return null;
    this.answering.add(id);
    try {
      const session = await this.get(id);
      if (!session || session.status !== 'pending') return session;
      session.answers = answers;
      session.status = 'answered';
      session.answeredAt = new Date().toISOString();
      await this.save(session);
      return session;
    } finally {
      this.answering.delete(id);
    }
  }

  async updateDraft(id: string, questionId: string, value: string): Promise<ClarificationSession | null> {
    const session = await this.get(id);
    if (!session || session.status !== 'pending') return session;
    session.draftAnswers = { ...(session.draftAnswers ?? {}), [questionId]: value };
    await this.save(session);
    return session;
  }

  private async markExpired(session: ClarificationSession): Promise<ClarificationSession> {
    if (session.status === 'pending' && Date.parse(session.expiresAt) <= Date.now()) {
      session.status = 'expired';
      await this.save(session);
    }
    return session;
  }

  private async save(session: ClarificationSession): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = path.join(this.root, `${session.clarificationId}.json`);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, target);
    this.cache.set(session.clarificationId, session);
  }
}

export const getClarificationSessionStore = (): ClarificationSessionStore =>
  ClarificationSessionStore.getInstance();
