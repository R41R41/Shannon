import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { companionBaseUrl, type CompanionRequest, type CompanionReportCode } from '../integration/CompanionBodyClient.js';
import type { CompanionRequestClient, CompanionRequestTasks } from '../integration/CompanionRequestLoop.js';

export const MIND_CAMPAIGN_USER_GOAL = 'エンドラを討伐してください';
/** Closed semantic aliases only; additional prerequisites, operators and objectives are never accepted. */
export function isDragonCampaignGoal(value: string): boolean {
  const goal = value.trim().replace(/\s+/g, '').replace(/[。.!！]+$/, '').replace(/^(?:Minecraftで|マイクラで)/i, '');
  return /^(?:エンドラ|エンダードラゴン)(?:を)?(?:討伐する|討伐してください|討伐|倒す|倒してください|撃破する|撃破してください|撃破)$/.test(goal);
}
interface Runtime {
  getTaskListState(): { tasks: Array<{ id: string; status: string }> };
  isTaskExecuting(taskId: string): boolean;
  stopTaskAndWait(taskId: string): Promise<boolean>;
  removeTask(taskId: string): unknown;
}
export type MindCampaignAttestor = (input: { threadId: string; requestId: string; signal?: AbortSignal }) => Promise<string | null | { pending: true }>;
interface Options {
  now?: () => number; setupMs: number; windowMs: number; ownerThreadId: string; attestRoot: MindCampaignAttestor;
  /** Bind the canonical goal after attestation, before the runtime can synchronously dispatch it. */
  beforeRootDispatch?: (request: Readonly<CompanionRequest>) => void;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The private launch context supplies identity; a model's goal/response never supplies authority. */
export function readMindCampaignThread(configPath: string, suppliedThreadId: string): string {
  if (!configPath || !UUID.test(suppliedThreadId)) throw new Error('MIND_CAMPAIGN_PRIVATE_CONTEXT_REQUIRED');
  let fd: number | undefined;
  try {
    fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16_384 || (process.getuid && stat.uid !== process.getuid())) throw new Error('closed');
    const config = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (config.schema !== 'shannon.private-minebot-attestor.v1' || config.ownerThreadId !== suppliedThreadId) throw new Error('closed');
    return suppliedThreadId;
  } catch { throw new Error('MIND_CAMPAIGN_PRIVATE_CONTEXT_INVALID'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

type PrivateAttestorExecution = (argv: string[], signal?: AbortSignal) => Promise<string>;
const executePrivateAttestor: PrivateAttestorExecution = (argv, signal) => new Promise((resolve, reject) => {
  execFile('/usr/bin/python3', argv, { shell: false, timeout: 3_000, maxBuffer: 16_384, killSignal: 'SIGKILL', signal }, (error, stdout) => {
    if (error) reject(new Error('MIND_CAMPAIGN_ATTESTOR_UNAVAILABLE')); else resolve(stdout);
  });
});

export function privateMindCampaignAttestor(input: { configPath: string; threadId: string; execute?: PrivateAttestorExecution }): MindCampaignAttestor {
  return async ({ threadId, requestId, signal }) => {
    if (threadId !== input.threadId || !UUID.test(requestId) || signal?.aborted) return null;
    try {
      const stdout = await (input.execute ?? executePrivateAttestor)(['/home/azureuser/.cache/minebot-integration/attest.py',
        '--config', input.configPath, 'attest', '--request-id', requestId, '--thread-id', threadId], signal);
      if (stdout.length > 16_384) return null;
      const result = JSON.parse(stdout);
      if (result?.ok === true && result.reason === 'ATTESTED') return requestId;
      return result?.ok === false && result.reason === 'ACTION_ADMISSION_PENDING' && result.retryable === true ? { pending: true } : null;
    } catch { return null; }
  };
}

/** Observe post-metering native proof failures without changing the original error or provider method. */
export function watchCampaignEvidenceFailures<T extends { messages: any }>(client: T, fatal: (error: unknown) => boolean, stop: () => void): T {
  const failed = (error: unknown): never => { if (fatal(error)) stop(); throw error; };
  const call = (work: () => any) => { try { return Promise.resolve(work()).catch(failed); } catch (error) { return failed(error); } };
  return { ...client, messages: new Proxy(client.messages, { get(target, key) {
    if (key === 'create') return (...args: any[]) => call(() => target.create(...args));
    if (key === 'stream') return (...args: any[]) => {
      let stream: any; try { stream = target.stream(...args); } catch (error) { return failed(error); }
      return new Proxy(stream, { get(value, property) {
        if (property === 'finalMessage') return (...finalArgs: any[]) => call(() => value.finalMessage(...finalArgs));
        const field = Reflect.get(value, property); return typeof field === 'function' ? field.bind(value) : field;
      } });
    };
    const field = Reflect.get(target, key); return typeof field === 'function' ? field.bind(target) : field;
  } }) };
}

/** One canonical Mind request, possibly several settled body segments; never a second autonomous root. */
export class MindControlledCampaign implements CompanionRequestTasks {
  readonly userGoal = MIND_CAMPAIGN_USER_GOAL;
  private readonly now: () => number;
  private submittedAt: number | null = null;
  private startedAt: number | null = null;
  private root: CompanionRequest | null = null;
  private initialTaskId: string | null = null;
  private activeTaskId: string | null = null;
  private readonly aliases = new Set<string>();
  private readonly ended = new Set<string>();
  private final: { done: boolean; code?: CompanionReportCode } | null = null;
  private rejected: string | null = null;
  private terminalAck: { outcome: string; state: string; recorded: boolean } | null = null;
  private attestedRootId: string | null = null;
  private readonly provisional = new Set<string>();
  constructor(private readonly delegate: CompanionRequestTasks, private readonly runtime: Runtime, private readonly options: Options) {
    if (![options.setupMs, options.windowMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('MIND_CAMPAIGN_LIMIT_INVALID');
    this.now = options.now ?? Date.now;
    if (!UUID.test(options.ownerThreadId) || typeof options.attestRoot !== 'function') throw new Error('MIND_CAMPAIGN_ATTESTOR_REQUIRED');
  }
  /** Called immediately before the one owner HTTP request; never replay after an ambiguous response. */
  submitting(): void {
    if (this.submittedAt !== null) throw new Error('MIND_CAMPAIGN_GOAL_ALREADY_SENT');
    this.submittedAt = this.now();
  }
  start(request: CompanionRequest): { taskId: string } | { refused: CompanionReportCode } {
    if (this.rejected) return { refused: 'unsupported' };
    if (this.root?.id === request.id) return this.initialTaskId ? { taskId: this.initialTaskId } : { refused: 'unknown' };
    if (this.root) return this.delegate.start(request);
    if (this.submittedAt === null || !Number.isFinite(Date.parse(request.createdAt)) || Date.parse(request.createdAt) < this.submittedAt
      || !Number.isFinite(Date.parse(request.leaseExpiresAt)) || Date.parse(request.leaseExpiresAt) <= this.now()
      || this.now() >= this.submittedAt + this.options.setupMs || request.surface !== 'text' || !isDragonCampaignGoal(request.goal)) {
      this.rejected = 'MIND_CAMPAIGN_ROOT_REJECTED'; return { refused: 'unsupported' };
    }
    if (this.attestedRootId !== request.id) {
      this.provisional.add(request.id); this.rejected = 'MIND_CAMPAIGN_PROVENANCE_UNKNOWN'; return { refused: 'unknown' };
    }
    this.root = { ...request };
    this.provisional.delete(request.id);
    let started: ReturnType<CompanionRequestTasks['start']>;
    try {
      this.options.beforeRootDispatch?.({ ...this.root });
      started = this.delegate.start(request);
    }
    catch { this.rejected = 'MIND_CAMPAIGN_ROOT_QUEUE_REFUSED'; return { refused: 'error' }; }
    if ('taskId' in started) {
      this.initialTaskId = this.activeTaskId = started.taskId; this.aliases.add(started.taskId);
    } else this.rejected = 'MIND_CAMPAIGN_ROOT_QUEUE_REFUSED';
    return started;
  }
  isRootRequest(id: string): boolean { return this.root?.id === id; }
  markStarted(requestId: string): boolean {
    if (!this.isRootRequest(requestId)) return false;
    this.startedAt ??= this.now(); return true;
  }
  markSegmentEnded(taskId: string): void { if (this.aliases.has(taskId)) this.ended.add(taskId); }
  get taskId(): string | null { return this.activeTaskId; }
  get acceptedGoal(): string | null { return this.root?.goal ?? null; }
  get requestId(): string | null { return this.root?.id ?? null; }
  get activeStartedAt(): number | null { return this.startedAt; }
  get deadline(): number | null { return this.startedAt === null ? null : this.startedAt + this.options.windowMs; }
  get setupExpired(): boolean { return this.submittedAt !== null && this.now() >= this.submittedAt + this.options.setupMs; }
  get rejection(): string | null { return this.rejected; }
  get stopped(): boolean { return this.final !== null; }
  get executionSettled(): boolean { return !!this.activeTaskId && this.ended.has(this.activeTaskId) && ![...this.aliases].some(id => this.runtime.isTaskExecuting(id)); }
  get verifiedAcknowledged(): boolean { return this.final?.done === true && this.terminalAck?.state === 'done'; }
  /** HTTP receipt, separate from the legacy loop's bounded delivery-attempt bookkeeping. */
  trackClient(client: CompanionRequestClient): CompanionRequestClient {
    return { claim: async (holding, waitSeconds, signal) => {
        if (this.rejected === 'MIND_CAMPAIGN_PROVENANCE_UNKNOWN') return null;
        const answer = await client.claim([...new Set([...holding, ...this.provisional])], waitSeconds, signal);
        if (!answer?.request || this.root) return answer;
        const candidate = answer.request; this.provisional.add(candidate.id);
        const deadline = Date.now() + 2_000;
        const attesting = signal ? AbortSignal.any([signal, AbortSignal.timeout(2_000)]) : AbortSignal.timeout(2_000);
        try {
          for (let attempt = 0; attempt < 20 && !attesting.aborted; attempt++) {
            const proof = await new Promise<Awaited<ReturnType<MindCampaignAttestor>>>(resolve => {
              const finish = (value: Awaited<ReturnType<MindCampaignAttestor>>) => { attesting.removeEventListener('abort', onAbort); resolve(value); };
              const onAbort = () => finish(null);
              attesting.addEventListener('abort', onAbort, { once: true });
              Promise.resolve().then(() => this.options.attestRoot({ threadId: this.options.ownerThreadId, requestId: candidate.id, signal: attesting }))
                .then(finish, () => finish(null));
              if (attesting.aborted) finish(null);
            });
            if (proof === candidate.id && !attesting.aborted) { this.attestedRootId = candidate.id; return answer; }
            if (!proof || typeof proof === 'string' || proof.pending !== true || Date.now() >= deadline) break;
            await new Promise<void>(resolve => {
              const onAbort = () => { clearTimeout(timer); resolve(); };
              const timer = setTimeout(() => { attesting.removeEventListener('abort', onAbort); resolve(); }, 100);
              attesting.addEventListener('abort', onAbort, { once: true });
            });
          }
        } catch { /* Transport/DB uncertainty grants no right and closes no request. */ }
        this.rejected = 'MIND_CAMPAIGN_PROVENANCE_UNKNOWN'; return null;
      }, progress: (...args) => client.progress(...args),
      report: async (id, outcome, detail) => {
        if (this.provisional.has(id)) return null;
        const answer = await client.report(id, outcome, detail);
        const expected = outcome === 'done' ? 'done' : outcome === 'stopped' ? 'cancelled' : 'failed';
        if (this.isRootRequest(id) && answer?.state === expected) this.terminalAck = { outcome, state: answer.state, recorded: answer.recorded };
        return answer;
      } };
  }
  canReplaceTask(): boolean {
    return !this.final && this.executionSettled;
  }
  /** A dimension change re-admits the already claimed goal, with its original request provenance. */
  replaceTask(taskId: string): void {
    if (!this.canReplaceTask()) throw new Error('MIND_CAMPAIGN_ORIGINAL_EXECUTION_UNKNOWN');
    this.activeTaskId = taskId; this.aliases.add(taskId);
  }
  status(taskId: string): ReturnType<CompanionRequestTasks['status']> {
    if (taskId !== this.initialTaskId) return this.delegate.status(taskId);
    if ([...this.aliases].some(id => this.runtime.isTaskExecuting(id))) return { state: 'running' };
    if (this.final) return this.final.done ? { state: 'done' } : { state: 'failed', code: this.final.code };
    // Keep the canonical request held while a native checkpoint awaits the same-goal continuation.
    const task = this.runtime.getTaskListState().tasks.find(entry => entry.id === this.activeTaskId);
    return task?.status === 'executing' ? { state: 'running' } : { state: 'waiting' };
  }
  step(taskId: string): string | undefined { return this.delegate.step?.(taskId === this.initialTaskId ? this.activeTaskId ?? taskId : taskId); }
  inventory(): Record<string, number> { return this.delegate.inventory?.() ?? {}; }
  /** Independent observer and campaign verification must both agree; prose and queue admission cannot finish it. */
  finishVerified(campaignVerified: boolean, oracleVerified: boolean): boolean {
    if (!campaignVerified || !oracleVerified || !this.activeTaskId || !this.ended.has(this.activeTaskId)
      || [...this.aliases].some(id => this.runtime.isTaskExecuting(id))) return false;
    this.final ??= { done: true }; return this.final.done;
  }
  async stop(taskId: string): Promise<boolean> {
    if (taskId !== this.initialTaskId) return this.delegate.stop(taskId);
    for (const id of this.aliases) {
      if (this.ended.has(id) && !this.runtime.isTaskExecuting(id)) { this.runtime.removeTask(id); continue; }
      if (await this.runtime.stopTaskAndWait(id) !== true) return false;
      this.ended.add(id);
    }
    this.final ??= { done: false, code: 'run_over' };
    return true;
  }
  receipt(): Record<string, unknown> {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    return { enabled: true, submittedAt: this.submittedAt === null ? null : new Date(this.submittedAt).toISOString(),
      activeStartedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(), requestId: this.root?.id ?? null,
      attested: this.attestedRootId === this.root?.id, unacceptedRequests: [...this.provisional],
      originalGoalSha256: hash(this.userGoal), acceptedGoalSha256: this.root ? hash(this.root.goal) : null,
      terminalAck: this.terminalAck, taskSegments: this.aliases.size, settledSegments: this.ended.size, rejected: this.rejected, verified: this.final?.done === true };
  }
}

/** Owner auth is separate from body auth. Only the original goal is submitted, once; no game identity is forged. */
export async function submitMindCampaignGoal(input: { baseUrl: string; ownerToken: string; threadId: string; signal?: AbortSignal;
  fetcher?: typeof fetch }): Promise<{ status: number; acknowledged: boolean }> {
  if (input.ownerToken.trim().length < 16) throw new Error('MIND_CAMPAIGN_OWNER_TOKEN_REQUIRED');
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000);
  signal.throwIfAborted();
  const response = await (input.fetcher ?? fetch)(`${companionBaseUrl(input.baseUrl)}/v1/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${input.ownerToken}` },
    body: JSON.stringify({ scopeKey: 'owner', threadId: input.threadId, message: MIND_CAMPAIGN_USER_GOAL }), signal });
  // Consume without logging or storing the model's private reply. A lost response is not authorization to resend.
  await response.arrayBuffer();
  return { status: response.status, acknowledged: response.ok };
}

export async function assertMindCampaignQuiet(input: { baseUrl: string; ownerToken: string; signal?: AbortSignal; fetcher?: typeof fetch }): Promise<void> {
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000);
  signal.throwIfAborted();
  const response = await (input.fetcher ?? fetch)(`${companionBaseUrl(input.baseUrl)}/v1/body/minecraft/requests`, {
    headers: { authorization: `Bearer ${input.ownerToken}` }, signal });
  if (!response.ok) throw new Error('MIND_CAMPAIGN_OWNER_READ_UNAVAILABLE');
  const body: any = await response.json();
  if (!Array.isArray(body?.requests) || body.requests.some((row: any) => !row || !['done', 'failed', 'cancelled', 'expired'].includes(row.state))) {
    throw new Error('MIND_CAMPAIGN_EXISTING_REQUESTS');
  }
}
