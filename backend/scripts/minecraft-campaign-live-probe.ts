#!/usr/bin/env node
// A goal-only, non-OP campaign pilot on a new natural world. The operator is
// read-only during the run; no starting items, shelter, fixed time or mobs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { RconClient } from '../src/services/minebot/testing/RconClient.js';
import { CONFIG } from '../src/services/minebot/config/MinebotConfig.js';
import { CompanionBodyClient } from '../src/services/minebot/integration/CompanionBodyClient.js';
import { CompanionRequestLoop } from '../src/services/minebot/integration/CompanionRequestLoop.js';
import { CompanionRuntimeTasks, inventoryCounts } from '../src/services/minebot/integration/CompanionRuntimeTasks.js';
import { companionBodyNow, othersOnline, speakCompanionReply, takeCompanionTurn, watchCompanionBodyEvents }
  from '../src/services/minebot/integration/companionBodyParts.js';
import { AutonomousScenarioRunner } from '../src/services/minebot/testing/AutonomousScenarioRunner.js';
import { AcceptanceBudget, ActualUsageBudget, ANTHROPIC_PRICING, seedSharedCampaignBudget } from '../src/services/minebot/testing/AcceptanceBudget.js';
import { CampaignGoalGraph } from '../src/services/minebot/cognition/CampaignGoalGraph.js';
import { createOpenAIPlannerClient } from '../src/services/minebot/cognition/OpenAIPlannerClient.js';
import { createAnthropicPlannerClient } from '../src/services/minebot/cognition/AnthropicPlannerClient.js';
import { ShannonExecutor, skillToAnthropicTool, type ShannonExecutorState } from '../src/services/llm/graph/ShannonExecutor.js';
import { MinebotTaskRuntime } from '../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { BotEventHandler } from '../src/services/minebot/events/BotEventHandler.js';
import { EventReactionSystem } from '../src/services/minebot/eventReaction/EventReactionSystem.js';
import { loadEventReactionSettingsFile } from '../src/services/minebot/eventReaction/eventReactionSettingsStore.js';
import { SkillRegistrar } from '../src/services/minebot/skills/SkillRegistrar.js';
import type { GoalPredicate } from '../src/services/minebot/cognition/GoalVerifier.js';
import { MinecraftLearningService, type MinecraftLearningMode } from '../src/services/minebot/learning/MinecraftLearningService.js';
import { minecraftKnowledgeScope } from '../src/modules/minecraftLearning/index.js';
import { gameChatSpeaker, humanChatLogLine, isAddressedToShannon, parseLabWatcherMode, playerNameByUuid, readLabUiModConfig,
  type PlayerChatEvent } from '../src/services/minebot/testing/labHumanContact.js';
import type { LabUiModBridge } from '../src/services/minebot/testing/LabUiModBridge.js';

// A stray error from a timer or promise of an action that was already cancelled must not end a paid run:
// L39 was lost this way a minute after crafting its diamond pickaxe. Logged and survived, as the production client does.
process.on('uncaughtException', error => { console.error(`CAMPAIGN_UNCAUGHT ${error instanceof Error ? error.stack : String(error)}`); });
process.on('unhandledRejection', reason => { console.error(`CAMPAIGN_UNHANDLED_REJECTION ${reason instanceof Error ? reason.stack : String(reason)}`); });
const port = Number(process.env.MINECRAFT_PROBE_PORT ?? 25579);
if (process.env.SHANNON_ISOLATED_MINEBOT_PROBE !== 'true'
  || process.env.MINECRAFT_COGNITION_MODE !== 'off') {
  throw new Error('CAMPAIGN_BUDGETED_ISOLATION_REQUIRED');
}
const worldDirectory = process.env.MINECRAFT_CAMPAIGN_WORLD_DIRECTORY ?? '';
if (!/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('CAMPAIGN_ISOLATED_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').replace(/\\([:=])/g, '$1');
// A public lab (scripts/minecraft-isolated-lab.mjs with MINECRAFT_LAB_PUBLIC=true) is joined from outside with real
// accounts: the body signs in as MINECRAFT_LAB_ACCOUNT_EMAIL's player and the operator is the server console (RCON),
// since an offline operator bot cannot join. Only whitelisted names get in, and nobody is op.
const publicServer = process.env.MINECRAFT_LAB_PUBLIC === 'true';
const publicAccess = ['server-ip=', 'online-mode=true', 'white-list=true', 'enforce-whitelist=true', 'enable-rcon=true'];
for (const entry of [`server-port=${port}`, ...(publicServer ? publicAccess : ['server-ip=127.0.0.1']), 'level-type=minecraft:normal',
  'generate-structures=true', 'difficulty=normal', 'gamemode=survival']) {
  if (!properties.split('\n').includes(entry)) throw new Error(`CAMPAIGN_WORLD_CONFIGURATION_INVALID:${entry}`);
}
const configuredSeed = properties.match(/^level-seed=(.*)$/m)?.[1] ?? '';
const generatorSettings = properties.match(/^generator-settings=(.*)$/m)?.[1] ?? '';
if (configuredSeed || generatorSettings && generatorSettings !== '{}') throw new Error('CAMPAIGN_WORLD_PRESET_FORBIDDEN');
const rconPort = Number(properties.match(/^rcon\.port=(\d+)$/m)?.[1]);
const rconPassword = properties.match(/^rcon\.password=(.+)$/m)?.[1] ?? '';
// The VM's firewall opens 25500-25600 to the internet: the console must not be among them.
if (publicServer && (!(rconPort > 25600) || rconPassword.length < 32)) throw new Error('CAMPAIGN_PUBLIC_CONSOLE_UNSAFE');
const accountEmail = process.env.MINECRAFT_LAB_ACCOUNT_EMAIL ?? '';
if (publicServer && !accountEmail) throw new Error('CAMPAIGN_PUBLIC_ACCOUNT_REQUIRED');
const ops = JSON.parse(fs.readFileSync(path.join(worldDirectory, 'ops.json'), 'utf8'));
// On a public lab the owner may be op (MINECRAFT_LAB_OPS); the body never is, checked again once it has logged in.
const publicBotName = process.env.MINECRAFT_LAB_BOT_NAME || 'I_am_Shannon';
if (ops.some((op: any) => op.name === (publicServer ? publicBotName : 'MinebotTrial')))
  throw new Error('CAMPAIGN_ACTOR_MUST_BE_NON_OP');
if (process.env.MINECRAFT_CAMPAIGN_PAID_AUTHORIZED !== 'true') throw new Error('CAMPAIGN_PAID_AUTHORIZATION_REQUIRED');
const watcherMode = parseLabWatcherMode(process.env.MINECRAFT_LAB_WATCHERS);
// A world made with MINECRAFT_LAB_UI_MOD=true has ShannonUIMod; the full runtime talks to it as SkillAgent does.
// Its settings are read here, so its token never passes through the environment or a log.
let uiModConfig: ReturnType<typeof readLabUiModConfig> = null;
try { uiModConfig = readLabUiModConfig(worldDirectory); }
catch (error) { console.warn(`CAMPAIGN_UI_MOD_DISABLED ${error instanceof Error ? error.message : String(error)}`); }

const objective = process.env.MINECRAFT_CAMPAIGN_OBJECTIVE ?? 'dragon';
if (!['dragon', 'iron_pickaxe'].includes(objective)) throw new Error('CAMPAIGN_OBJECTIVE_INVALID');
const ironPickaxeObjective = objective === 'iron_pickaxe';
const milestone = process.env.MINECRAFT_CAMPAIGN_MILESTONE ?? '';
// 'blaze_rod': the first thing the Nether has to give that the dragon needs. A run with this milestone goes on
// through the portal (the time it entered the Nether is reported on its own) and ends when a rod is held.
if (!['', 'iron_pickaxe', 'nether', 'blaze_rod'].includes(milestone) || milestone && ironPickaxeObjective)
  throw new Error('CAMPAIGN_MILESTONE_INVALID');
const goal = ironPickaxeObjective
  ? '何も持っていない状態から、自然生成ワールドで自力で鉄のツルハシを1個製作し、所持する'
  : 'エンドラを倒す';
const resumeCampaign = process.env.MINECRAFT_CAMPAIGN_RESUME === 'true';
const fullRuntime = process.env.MINECRAFT_CAMPAIGN_FULL_RUNTIME === 'true';
const success: GoalPredicate[] = ironPickaxeObjective
  ? [{ kind: 'inventory', item: 'iron_pickaxe', count: 1 }]
  : [{ kind: 'boss_defeated', entity: 'ender_dragon', dimension: 'the_end' }];
const worldId = createHash('sha256').update(fs.realpathSync(worldDirectory)).digest('hex').slice(0, 20);
const reportsDirectory = path.resolve('saves/minecraft/progressive_reports');
const campaignDirectory = path.resolve('saves/minecraft/campaigns');
fs.mkdirSync(reportsDirectory, { recursive: true });
// This run-specific sentinel is an alternative to SIGINT/SIGTERM for an
// operator who cannot send a signal to the foreground probe process.
const stopFile = path.join(reportsDirectory, `campaign-stop-${worldId}-${randomUUID()}.stop`);
type OperatorStopSource = 'SIGINT' | 'SIGTERM' | 'sentinel';
let operatorStopSource: OperatorStopSource | null = null;
let budgetStopRequested = false;
/** Set when the provider itself refuses service (no credit): retrying cannot help. */
let providerStopCode: string | null = null;
const probeStopController = new AbortController();
const requestOperatorStop = (source: OperatorStopSource) => {
  if (operatorStopSource || budgetStopRequested) return;
  operatorStopSource = source;
  probeStopController.abort('operator_early_stop');
  console.warn(`CAMPAIGN_OPERATOR_STOP_REQUESTED ${source}`);
};
const requestBudgetStop = () => {
  if (budgetStopRequested || operatorStopSource) return;
  budgetStopRequested = true;
  probeStopController.abort('reserved_budget_exhausted');
  console.warn('CAMPAIGN_BUDGET_STOP_REQUESTED');
};
const requestProviderStop = (code: string) => {
  if (providerStopCode || budgetStopRequested || operatorStopSource) return;
  providerStopCode = code;
  probeStopController.abort('provider_credit_exhausted');
  console.warn(`CAMPAIGN_PROVIDER_STOP_REQUESTED ${code}`);
};
const operatorStopRequested = () => {
  if (!operatorStopSource && fs.existsSync(stopFile)) requestOperatorStop('sentinel');
  return operatorStopSource !== null;
};
const probeStopRequested = () => operatorStopRequested() || budgetStopRequested || providerStopCode !== null;
const probeStopReason = () => budgetStopRequested ? 'reserved_budget_exhausted'
  : providerStopCode ? 'provider_credit_exhausted'
    : operatorStopRequested() ? 'operator_early_stop' : null;
const budgetProfile = process.env.MINECRAFT_CAMPAIGN_BUDGET_PROFILE ?? 'prior-3000';
const extraBudgetFiles: Record<string, string> = {
  'extra-5000-20260930': 'dragon-campaign-extra-5000-20260930.json',
  'extra-5000-20260930-second': 'dragon-campaign-extra-5000-20260930-second.json',
  // Separately approved by the user on 2026-10-01 JST: up to 5,000 JPY.
  'extra-5000-20261001': 'dragon-campaign-extra-5000-20261001.json',
};
// Separately approved by the user on 2026-10-01 JST for the overnight work:
// up to 5,000 JPY of actual usage. Settled from billed usage at official Luna
// prices x1.25, capped at 5,000 JPY / 160 JPY/USD.
const actualBudgetFiles: Record<string, string> = {
  'actual-5000-20261001-night': 'dragon-campaign-actual-5000-20261001-night.json',
  // Separately approved by the user on 2026-10-01 JST (afternoon), after the
  // overnight cap was used up: a further 5,000 JPY of actual usage.
  'actual-5000-20261001-afternoon': 'dragon-campaign-actual-5000-20261001-afternoon.json',
  // Separately approved by the user on 2026-10-01 JST at about 23:10, for the planner comparison
  // (Claude Sonnet 5.5 / Opus 5.5): a further 5,000 JPY of actual usage. Used once the afternoon cap runs out.
  'actual-5000-20261001-latenight': 'dragon-campaign-actual-5000-20261001-latenight.json',
  // Separately approved by the user on 2026-10-02 JST at about 11:20 ("a further 5,000 JPY"), with the
  // latenight cap nearly used (27.5 of 31.25 USD): a further 5,000 JPY of actual usage.
  'actual-5000-20261002-morning': 'dragon-campaign-actual-5000-20261002-morning.json',
  // Separately approved by the user on 2026-10-02 JST at about 15:30 ("a further 5,000 JPY may be used", for
  // going on past the Nether with Sonnet), with 20.34 of 31.25 USD of the morning cap used: a further 5,000 JPY
  // of actual usage. Used once the morning cap runs out.
  'actual-5000-20261002-afternoon': 'dragon-campaign-actual-5000-20261002-afternoon.json',
  // Separately approved by the user on 2026-10-03 JST ("a further 5,000 JPY may be used", for the blaze rod:
  // what a skill can do is automated, the rest is left to the architecture, the knowledge and the planner), with
  // 25.26 of 31.25 USD of the afternoon cap used: a further 5,000 JPY of actual usage.
  'actual-5000-20261003': 'dragon-campaign-actual-5000-20261003.json',
  // Separately approved by the user on 2026-10-05 JST at about 06:20 ("a further 5,000 JPY may be used"), with
  // 28.73 of 31.25 USD of the 20261003 cap used, after the first zero-start Nether arrival since L77 (L88): a
  // further 5,000 JPY of actual usage.
  'actual-5000-20261005': 'dragon-campaign-actual-5000-20261005.json',
  // Separately approved by the user on 2026-10-05 JST at about 10:50 ("a further 5,000 JPY is allowed"), with the
  // 20261005 cap used (30.87 of 31.25 USD): a further 5,000 JPY of actual usage.
  'actual-5000-20261005b': 'dragon-campaign-actual-5000-20261005b.json',
  // Separately approved by the user on 2026-10-05 JST at about 23:40 ("up to a further 1,000 JPY"), with 29.26 of
  // 31.25 USD of the 20261005b cap used, to try the tool-wear, threat and request fixes in play: 1,000 JPY only.
  'actual-1000-20261005c': 'dragon-campaign-actual-1000-20261005c.json',
};
/** Ledgers approved for less than the usual 5,000 JPY. */
const actualBudgetCapsJpy: Record<string, number> = { 'actual-1000-20261005c': 1000 };
if (budgetProfile !== 'prior-3000' && !extraBudgetFiles[budgetProfile] && !actualBudgetFiles[budgetProfile])
  throw new Error('CAMPAIGN_BUDGET_PROFILE_INVALID');
const actualBudget = !!actualBudgetFiles[budgetProfile];
const extraBudget = budgetProfile !== 'prior-3000';
const budgetFile = path.join(reportsDirectory, actualBudget ? actualBudgetFiles[budgetProfile] : extraBudget
  ? extraBudgetFiles[budgetProfile] : 'dragon-campaign-additional-budget.json');
if (!extraBudget) seedSharedCampaignBudget(budgetFile, fs.readdirSync(reportsDirectory)
  .filter(name => /^dragon-campaign-budget-[a-f0-9]{20}\.json$/.test(name))
  .map(name => path.join(reportsDirectory, name)));
// Conservative reservations use $0.50/M input bytes and $1.80/M output tokens,
// above the current Luna token prices. Each separately authorized $13 cap
// × 375 JPY/USD = 4,875 JPY, leaving 125 JPY headroom below 5,000 JPY.
const budget = actualBudget
  ? new ActualUsageBudget(budgetFile, { maxUsd: (actualBudgetCapsJpy[budgetProfile] ?? 5000) / 160, maxRequests: 20000, margin: 1.25 })
  : new AcceptanceBudget(budgetFile,
    { maxUsd: extraBudget ? 13 : 8, maxRequests: extraBudget ? 400 : 500, priorReservedUsd: 0 });
const graph = CampaignGoalGraph.open({ directory: campaignDirectory,
  id: `${ironPickaxeObjective ? 'iron-pickaxe' : 'dragon'}-${worldId}`, worldId, goal, success });
if (resumeCampaign && graph.currentRevision <= 1) throw new Error('CAMPAIGN_RESUME_STATE_NOT_FOUND');
if (!resumeCampaign && graph.currentRevision > 1) throw new Error('CAMPAIGN_ALREADY_STARTED_USE_RESUME');
const keyFile = '/home/azureuser/Shannon-current/backend/.env';
const apiKey = dotenv.parse(fs.readFileSync(keyFile)).OPENAI_API_KEY ?? '';
if (!apiKey) throw new Error('CAMPAIGN_OPENAI_KEY_UNAVAILABLE');
const requests: any[] = [];
// A held item alone could have been found as loot. For this checkpoint require
// a successful craft-one action as well as the independent inventory oracle.
const inNether = () => String(actor.game?.dimension ?? '').includes('the_nether');
const craftedMilestoneIn = (segments: any[]) => milestone === 'iron_pickaxe' && segments.some(segment =>
  segment.toolTrace?.some((event: any) => event.tool === 'craft-one'
    && event.args?.itemName === milestone && event.success === true));
const previousMilestoneCraft = milestone && resumeCampaign && fs.readdirSync(reportsDirectory)
  .filter(name => name.endsWith('-dragon-campaign.json')).some(name => {
    try {
      const previous = JSON.parse(fs.readFileSync(path.join(reportsDirectory, name), 'utf8'));
      return previous.worldId === worldId && craftedMilestoneIn(previous.segments ?? []);
    } catch { return false; }
  });
// Same model, key and ledger; only how much the planner thinks before each answer (for a measured comparison).
const requestedEffort = (process.env.MINECRAFT_PLANNER_REASONING_EFFORT ?? 'none') as 'none' | 'low' | 'medium' | 'high';
if (!['none', 'low', 'medium', 'high'].includes(requestedEffort)) throw new Error('MINECRAFT_PLANNER_REASONING_EFFORT_INVALID');
// Which model plans. The learning reflections stay on the usual model either way, so only the planner differs
// between compared runs. Every request of either provider goes through the same ledger and cap.
const plannerModel = process.env.MINECRAFT_PLANNER_MODEL ?? 'gpt-5.6-luna';
const plannerProvider = plannerModel === 'gpt-5.6-luna' ? 'openai' : 'anthropic';
if (plannerProvider === 'anthropic' && !ANTHROPIC_PRICING[plannerModel]) throw new Error('CAMPAIGN_PLANNER_MODEL_UNPRICED');
// The key lives in a file outside the repository and is only ever read here, never printed or logged. The
// lab's own file comes first (the user puts the key for these runs there); the release's file is the fallback.
const anthropicKeyFiles = [process.env.MINECRAFT_PLANNER_ANTHROPIC_KEY_FILE, '/home/azureuser/.config/minebot-lab/anthropic.env',
  '/home/azureuser/Shannon-releases/unified-orchestrator-test/backend/.env'].filter((file): file is string => !!file);
const readAnthropicAccess = (): { key: string; workspaceId?: string } => {
  for (const file of anthropicKeyFiles) {
    try {
      const values = dotenv.parse(fs.readFileSync(file));
      const key = values.ANTHROPIC_API_KEY?.trim();
      // A key that is not tied to one workspace needs the workspace named beside it (an identifier, not a secret).
      if (key) return { key, ...(values.ANTHROPIC_WORKSPACE_ID?.trim() ? { workspaceId: values.ANTHROPIC_WORKSPACE_ID.trim() } : {}) };
    } catch { /* next file */ }
  }
  return { key: '' };
};
const anthropicAccess = plannerProvider === 'anthropic' ? readAnthropicAccess() : { key: '' };
const anthropicKey = anthropicAccess.key;
if (plannerProvider === 'anthropic' && !anthropicKey) throw new Error('CAMPAIGN_ANTHROPIC_KEY_UNAVAILABLE');
const plannerIdentity = { provider: plannerProvider, model: plannerModel };
// The Anthropic models always decide for themselves whether to think; "none" is not available there, so it means their lowest setting.
const anthropicEffort = requestedEffort === 'none' ? 'low' : requestedEffort;
const reasoningEffort = plannerProvider === 'openai' ? requestedEffort : 'none';
console.log(`PLANNER_SETTINGS ${JSON.stringify({ ...plannerIdentity, reasoningEffort: plannerProvider === 'openai' ? reasoningEffort : anthropicEffort })}`);
const ENDPOINTS = ['https://api.openai.com/v1/responses', 'https://api.anthropic.com/v1/messages'];
/**
 * The caller may stop waiting for an answer (an emergency takes the planner's turn, or its own timeout runs out).
 * The request itself is left to finish, so the ledger records what the provider reports for it instead of the
 * worst case: a request without a usage block is charged at its bound, which for the dearer planners is
 * $0.4 to $0.85 a time. Two such cancellations added $0.8 to the ledger in three minutes of run L41.
 */
/** Requests the provider has not answered yet: the process waits for them (bounded) so each is settled by its usage. */
const inFlight = new Set<Promise<unknown>>();
const meteredFetch: typeof fetch = (input, options) => {
  const caller = options?.signal ?? undefined;
  if (caller?.aborted) return Promise.reject(caller.reason ?? new DOMException('This operation was aborted', 'AbortError'));
  const work = performMetered(String(input), options);
  inFlight.add(work);
  work.catch(() => undefined).finally(() => inFlight.delete(work));
  if (!caller) return work;
  work.catch(() => { /* settled in the ledger either way; nobody may be listening any more */ });
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(caller.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    caller.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => caller.removeEventListener('abort', onAbort));
  });
};
const performMetered = async (url: string, options?: RequestInit): Promise<Response> => {
  if (!ENDPOINTS.includes(url) || typeof options?.body !== 'string') throw new Error('CAMPAIGN_OFFICIAL_ENDPOINT_REQUIRED');
  const requestModel = String(JSON.parse(options.body).model);
  // Check before reserving. In-flight reservations remain charged
  // conservatively, but an operator stop cannot create another one.
  if (operatorStopRequested()) throw new Error('CAMPAIGN_OPERATOR_EARLY_STOP');
  if (budgetStopRequested) throw new Error('ACCEPTANCE_SHARED_BUDGET_EXHAUSTED');
  if (providerStopCode) throw new Error(`CAMPAIGN_PROVIDER_CREDIT_EXHAUSTED:${providerStopCode}`);
  let reservation: { request: number; reservedUsd: number };
  try { reservation = budget.reserve(options.body); }
  catch (error) {
    // An exhausted reservation is terminal for the isolated live probe. Do
    // not strand a connected non-OP actor in a hostile world awaiting a model.
    if (String(error).includes('ACCEPTANCE_SHARED_BUDGET_EXHAUSTED')) requestBudgetStop();
    throw error;
  }
  const startedAt = Date.now();
  try {
    // Only the end of the whole run, or two minutes without an answer, cuts a request short.
    const signal = AbortSignal.any([probeStopController.signal, AbortSignal.timeout(120_000)]);
    const response = await fetch(url, { ...options, signal }); const payload: any = await response.clone().json();
    if (response.status >= 400 && response.status < 500) {
      // Refused before processing: not billed. A refusal for lack of credit is
      // terminal; any other rate limit waits before the caller may try again
      // (a paid run re-sent every two seconds for 85s against an empty balance).
      const settled = budget instanceof ActualUsageBudget ? budget.settleRejected(reservation.request) : null;
      const code = String(payload?.error?.code ?? payload?.error?.type ?? `http_${response.status}`);
      requests.push({ ...reservation, ...(settled ?? {}), durationMs: Date.now() - startedAt, httpStatus: response.status, providerError: code });
      if (/insufficient_quota|credit_balance_exhausted|billing|credit balance is too low/.test(`${payload?.error?.type} ${payload?.error?.code} ${payload?.error?.message}`)) requestProviderStop(code);
      else if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await new Promise(resolve => setTimeout(resolve, Math.min(30_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000)));
      }
      return response;
    }
    // A server-side failure (5xx, overloaded) returns an error body and no usage: it was not processed, so it is not billed.
    if (response.status >= 500 && payload?.type === 'error' && budget instanceof ActualUsageBudget) {
      const settled = budget.settleRejected(reservation.request);
      requests.push({ ...reservation, ...settled, durationMs: Date.now() - startedAt, httpStatus: response.status, providerError: String(payload?.error?.type ?? `http_${response.status}`) });
      await new Promise(resolve => setTimeout(resolve, 3000));
      return response;
    }
    const settled = budget instanceof ActualUsageBudget ? budget.settle(reservation.request, payload.usage, requestModel) : null;
    requests.push({ ...reservation, ...(settled ?? {}), durationMs: Date.now() - startedAt, httpStatus: response.status,
      model: payload.model, usage: payload.usage,
      toolCalls: [...(payload.output ?? []).filter((item: any) => item.type === 'function_call'),
        ...(payload.content ?? []).filter((item: any) => item.type === 'tool_use')].map((item: any) => item.name) });
    return response;
  } catch (error) {
    // Without a usage block the request may still have been billed: keep its bound.
    let settled = null;
    if (budget instanceof ActualUsageBudget) {
      try { settled = budget.settle(reservation.request, null); } catch { /* already settled above */ }
    }
    requests.push({ ...reservation, ...(settled ?? {}), durationMs: Date.now() - startedAt, error: String(error) });
    throw error;
  }
};
/**
 * Once the campaign has its result the planner gets no further turn. The runtime can outlive the result (an
 * emergency in progress re-queues its task after the final stop), and nothing else ended the process: after
 * the body of run L51 died and the report was written, the planner went on being called, and billed, for
 * eight minutes, until the process was stopped by hand.
 */
let plannerClosed = false;
// (An operator stop keeps its own, more specific refusal.)
const plannerFetch: typeof fetch = (input, options) => plannerClosed && !operatorStopRequested()
  ? Promise.reject(new Error('CAMPAIGN_OVER')) : meteredFetch(input, options);
// The usual model: learning reflections always (they also close the run), and planning unless another planner was chosen.
const client = createOpenAIPlannerClient({ apiKey, model: 'gpt-5.6-luna', reasoningEffort, promptCacheKey: `minebot-${worldId}`, fetcher: meteredFetch });
const plannerClient = plannerProvider === 'anthropic'
  ? createAnthropicPlannerClient({ apiKey: anthropicKey, model: plannerModel, effort: anthropicEffort, workspaceId: anthropicAccess.workspaceId, fetcher: plannerFetch })
  : createOpenAIPlannerClient({ apiKey, model: 'gpt-5.6-luna', reasoningEffort, promptCacheKey: `minebot-${worldId}`, fetcher: plannerFetch });

const rcon = publicServer ? new RconClient('127.0.0.1', rconPort, rconPassword) : null;
await rcon?.connect();
const operator = publicServer ? null : await createProbeBot(port);
const actor = publicServer
  ? await createProbeBot(port, 'MinebotTrial', { email: accountEmail,
    profilesFolder: process.env.MINECRAFT_LAB_ACCOUNT_CACHE ?? path.join(process.env.HOME ?? '', '.cache/minebot-lab/msa') })
  : await createProbeBot(port, 'MinebotTrial');
const actorName = actor.username;
if (ops.some((op: any) => op.name === actorName)) throw new Error('CAMPAIGN_ACTOR_MUST_BE_NON_OP');
console.log(`CAMPAIGN_ACTOR ${JSON.stringify({ name: actorName, public: publicServer })}`);
// People who join to watch are put in spectator mode: they see everything and can neither help nor get in the way.
// With MINECRAFT_LAB_WATCHERS=free their game mode is left alone, so the owner can play alongside; such a run
// is no longer unassisted and is not accepted.
const freeWatchers = new Set<string>();
const onPlayerJoined = (player: any) => {
  if (!rcon || !player?.username || player.username === actorName) return;
  if (watcherMode === 'free') {
    if (!freeWatchers.has(player.username)) console.log(`CAMPAIGN_WATCHER_JOINED ${player.username} free`);
    freeWatchers.add(player.username);
    return;
  }
  rcon.send(`gamemode spectator ${player.username}`)
    .then(() => console.log(`CAMPAIGN_WATCHER_JOINED ${player.username}`), () => {});
};
if (rcon) {
  actor.on('playerJoined', onPlayerJoined);
  for (const player of Object.values(actor.players)) onPlayerJoined(player);
}
// Game chat that starts with her name is for her. The full runtime sets the receiver once it can take tasks.
// Who spoke is the sender UUID of the player chat packet (the server's word on an online-mode lab), never a name
// parsed out of the text: mineflayer's 'chat' event matches `<name> text` in any chat or system message, which
// another player could make look like the owner's. System and disguised chat are not heard (see gameChatSpeaker).
// speakerUuid: from the packet for game chat; for the UI mod, looked up by the name it sends (trusted local client).
let receiveHumanChat: ((player: string, message: string, via: 'game_chat' | 'ui_mod', speakerUuid?: string) => void) | null = null;
const onGameChat = (event: unknown) => {
  const heard = gameChatSpeaker(event as PlayerChatEvent, uuid => playerNameByUuid(actor.players as any, uuid));
  if (!heard || !isAddressedToShannon(heard.message)) return;
  const self = [actor.player?.uuid, operator?.player?.uuid].map(uuid => String(uuid ?? '').toLowerCase());
  if (self.includes(heard.uuid) || heard.name === actorName || heard.name === operator?.username) return;
  if (receiveHumanChat) receiveHumanChat(heard.name, heard.message, 'game_chat', heard.uuid);
  else console.log(`CAMPAIGN_HUMAN_CHAT_UNHEARD ${heard.name}`);
};
actor._client.on('playerChat', onGameChat);
const operatorChat = (message: string) => rcon ? void rcon.send(message) : operator!.chat(message);
// Shannon's one mind (the companion, shannon-ios) writes what she says to people and keeps her death as a memory;
// this body acts. Only on a public lab, where Mojang proves who each player is. Off unless both are given.
const companionUrl = process.env.MINECRAFT_LAB_COMPANION_URL ?? '';
const companionTokenFile = process.env.MINECRAFT_LAB_COMPANION_TOKEN_FILE ?? '';
const companion = publicServer && companionUrl && companionTokenFile
  ? new CompanionBodyClient({ baseUrl: companionUrl, token: fs.readFileSync(companionTokenFile, 'utf8').trim(),
    // One id for the server people join (its address stays the same across lab worlds), so she knows it is the same place.
    serverId: process.env.MINECRAFT_LAB_COMPANION_SERVER_ID || `lab-${path.basename(worldDirectory).replace(/^progressive-lab-/, '')}` })
  : null;
if (companion) console.log(`CAMPAIGN_COMPANION ${JSON.stringify({ url: companionUrl })}`);
// Her own advancements (newest last) for the body's present she tells her mind, and her death: the vanilla death
// message names the damage type, the body's report of how she died (integration/companionBodyParts.ts).
const { recentAdvancements } = watchCompanionBodyEvents(actor as any, { name: () => actorName,
  onDeath: companion ? cause => void companion.died(cause, othersOnline(actor as any))
    .then(stored => console.log(`CAMPAIGN_COMPANION_DIED ${JSON.stringify({ cause, stored })}`)) : undefined });
// Dev-only general-knowledge scope shared by isolated labs; off unless requested.
const learningMode = (process.env.MINECRAFT_LEARNING_MODE ?? 'off') as MinecraftLearningMode;
if (!['off', 'shadow', 'feedback'].includes(learningMode)) throw new Error('MINECRAFT_LEARNING_MODE_INVALID');
const learningNamespace = process.env.MINECRAFT_LEARNING_NAMESPACE ?? 'dev-isolated-lab';
const learning = new MinecraftLearningService({ mode: learningMode, scope: minecraftKnowledgeScope(learningNamespace),
  directory: path.resolve('saves/minecraft/learning', learningNamespace), runId: `${worldId}-${randomUUID().slice(0, 8)}`,
  modelClient: client, model: 'gpt-5.6-luna' });
learning.attach(actor as any);
// The map in the body's head is kept per world: this world is known by its directory, not by a name.
(actor as any).placeMemory?.persistTo(path.resolve('saves/minecraft/places', `${worldId}.json`));
const onSigint = () => requestOperatorStop('SIGINT');
const onSigterm = () => requestOperatorStop('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);
const stopPollTimer = setInterval(operatorStopRequested, 200);
stopPollTimer.unref();
console.log(`CAMPAIGN_STOP_FILE ${stopFile}`);
let deaths = 0, minHealth = actor.health;
actor.on('death', () => { deaths++; }); actor.on('health', () => { minHealth = Math.min(minHealth, actor.health); });
const onCampaignDeath = () => graph.noteActorDeath('native bot death',
  actor.inventory.items().map(item => ({ name: item.name, count: item.count })));
actor.on('death', onCampaignDeath);
const survivalTrace: any[] = [];
const progressTrace: any[] = [];
const PROGRESS_ITEMS = new Set(['crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'furnace', 'raw_iron', 'iron_ingot',
  'iron_pickaxe', 'bucket', 'water_bucket', 'lava_bucket', 'diamond', 'diamond_pickaxe', 'obsidian', 'gravel', 'flint',
  'flint_and_steel']);
const oracle = new MinecraftCommandOracle({ version: actor.version,
  chat: message => operatorChat(`/execute as @a[name=${actorName},limit=1] at @s run ${message.replace(/^\//, '')}`),
  on: (_event, listener) => actor.on('message', listener as any),
  removeListener: (_event, listener) => actor.removeListener('message', listener as any),
});
// The console has no chat of its own to read markers from: on a public server the body's checks stand in for it.
const control = operator ? new MinecraftCommandOracle(operator) : oracle;
const startedAt = Date.now(); let report: any;
const segments: any[] = [];
let campaignStopReason: string | null = null;
// Every time a person spoke to the body (game chat or the UI mod) or used the mod's task and item controls.
// Any of them makes the run assisted: it is reported, and not accepted.
const humanChats: Array<{ atMs: number; player: string; via: 'game_chat' | 'ui_mod' | 'companion_request'; message: string;
  taskId: string | null; dropped: string | null }> = [];
const humanControls: Array<{ atMs: number; path: string }> = [];
let uiModStatus: Record<string, unknown> = { enabled: false };
const humanContactSummary = () => {
  const humanInteractions = humanChats.length + humanControls.length;
  return { humanInteractions, freeWatchers: [...freeWatchers],
    acceptanceVoidReason: humanInteractions ? 'human_interaction' : freeWatchers.size ? 'free_watcher_present' : null };
};
try {
  await control.verifyReady();
  const initialInventory = actor.inventory.items().map(item => ({ name: item.name, count: item.count }));
  if (!resumeCampaign && initialInventory.length) throw new Error('CAMPAIGN_ACTOR_NOT_EMPTY_HANDED');
  const initialChecks = await oracle.evaluateAll([{ type: 'gamemode', gamemode: 'survival' },
    { type: 'difficulty', difficulty: 'normal' }, { type: 'gamerule', rule: 'spawn_mobs', value: true },
    { type: 'gamerule', rule: 'advance_time', value: true }]);
  if (initialChecks.some(check => !check.passed)) throw new Error(`CAMPAIGN_INITIAL_WORLD_CHECK_FAILED:${JSON.stringify(initialChecks)}`);
  if (probeStopRequested()) throw new Error(probeStopReason() ?? 'CAMPAIGN_STOP_REQUESTED');
  const skillTools = (excluded: string[]): any[] => [...actor.instantSkills.getSkills()
    .filter(skill => !excluded.includes(skill.skillName)).map(skillToAnthropicTool),
  { name: 'task-complete', description: 'Request native verified completion.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }];
  const tools = skillTools(['chat', 'get-advancements', 'investigate-terrain']);
  // Only an answer to a person may speak in the game.
  const conversationTools = skillTools(['get-advancements', 'investigate-terrain']);
  const runner = fullRuntime ? null : new AutonomousScenarioRunner(actor, { modelClient: plannerClient, modelIdentity: plannerIdentity,
    campaign: graph, criticMode: 'off' }, port);
  const scenario = { id: ironPickaxeObjective ? 'iron-pickaxe-campaign' : 'dragon-campaign', goal, goalContract: { goal, predicates: success }, setup: [],
    constraints: `You ${resumeCampaign ? 'are resuming the same campaign; preserve its verified progress and inspect current inventory' : 'start with no items or known resource coordinates'}. This is normal survival with natural time, weather and mobs. Do not use chat commands or ask the operator for supplies. Decompose the ${ironPickaxeObjective ? 'iron pickaxe' : 'dragon'} mission lazily; do not create a complete huge tree at once. Select an unfinished campaign node before each physical skill. Do not call task-complete until ${ironPickaxeObjective ? 'you actually hold an iron pickaxe' : 'the dragon defeat has native proof'}. Observe real results and reroute after blockers. The operator only checks facts and never helps you.`,
    assertions: [{ type: 'gamemode' as const, gamemode: 'survival' as const },
      { type: 'difficulty' as const, difficulty: 'normal' as const }] };
  // A long actual-usage run may continue through many 30-iteration planner turns.
  const maxSegments = Math.max(1, Math.min(actualBudget ? 64 : 4, Number(process.env.MINECRAFT_CAMPAIGN_SEGMENTS ?? 2)));
  const budgetHasRoom = () => {
    if (!fs.existsSync(budgetFile)) return true;
    const state = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
    return state.requests < budget.maxRequests && (state.committedUsd ?? state.reservedUsd) < budget.maxUsd;
  };
  let continuation: Parameters<AutonomousScenarioRunner['run']>[1]['continuation'];
  if (fullRuntime) {
    // Reproduce SkillAgent's runtime/event/constant-skill ownership, while
    // keeping the existing non-OP actor, isolated oracle and budgeted planner.
    if (operator) {
      await control.executeSetupCommand('gamemode spectator ShannonProbe');
      await control.executeSetupCommand('tp ShannonProbe -500 150 -500');
    }
    const runtime = new MinebotTaskRuntime(actor);
    const savedSettings = loadEventReactionSettingsFile();
    const isolatedSettings = { ...savedSettings, reactions: savedSettings.reactions.map(row =>
      row.eventType === 'hostile_approach' ? { ...row, enabled: true, probability: 100 } : row) };
    const reactions = new EventReactionSystem(actor, runtime, isolatedSettings);
    if (learning.mode !== 'off') reactions.setLearning(learning);
    const handler = new BotEventHandler(actor, runtime, []);
    const registrar = new SkillRegistrar();
    const timers: Array<ReturnType<typeof setInterval>> = [];
    const mainResults: any[] = [];
    const emergencyResults: any[] = [];
    const humanChatResults: any[] = [];
    const humanChatTaskIds = new Set<string>();
    // Requests from her mind (phase 4) as tasks of this runtime; it is told how each one's run ended.
    let requestTasksOf: CompanionRuntimeTasks | null = null;
    // The game-chat turn a queued request came from, so the person's words are counted once.
    const requestRecords = new Map<string, any>();
    const requestTaskIds = new Map<string, string>();
    let requestLoop: CompanionRequestLoop | null = null;
    let uiMod: LabUiModBridge | null = null;
    const publishTaskTree = (tree: any) => uiMod?.publishTaskTree(tree);
    const toolTrace: any[] = [];
    const toolStarts: any[] = [];
    const reachedMilestone = () => milestone === 'nether' ? inNether()
      : milestone === 'blaze_rod' ? actor.inventory.items().some(item => item.name === 'blaze_rod' && item.count > 0)
      : milestone === 'iron_pickaxe'
      && actor.inventory.items().some(item => item.name === milestone && item.count > 0)
      && (previousMilestoneCraft || craftedMilestoneIn([{ toolTrace }]));
    const runtimeStartedAt = Date.now();
    const segmentLimit = Number(process.env.MINECRAFT_CAMPAIGN_WINDOW_MS ?? 240000);
    let autonomousContinuations = 0;
    let stopReason: string | null = null;
    let interruptionError: string | null = null;
    try {
      runtime.setExecutor(async (envelope, _messages, options) => {
        const emergency = envelope.tags.includes('emergency');
        const runMetadata = (envelope.metadata ?? {}) as Record<string, unknown>;
        // A person spoke to her (see receiveHumanChat): she answers and does what was asked, then the campaign goes on.
        const humanChat = !emergency && envelope.tags.includes('user_chat')
          ? runMetadata.humanChat as { player: string; message: string; answered?: boolean; requestId?: string } : null;
        const mode = emergency ? 'emergency' : humanChat ? 'human_chat' : 'campaign';
        const executionGoal = emergency ? envelope.text || '敵から生き延びる' : humanChat ? humanChat.message : goal;
        const previousWorkspaceSnapshot = runMetadata.previousCognitiveWorkspace as ShannonExecutorState['previousWorkspaceSnapshot'];
        // What a person asked for is not her own experience: it is not recorded for learning.
        const executor = new ShannonExecutor({ modelClient: plannerClient,
          modelIdentity: plannerIdentity, bot: actor,
          instantSkills: actor.instantSkills, campaign: mode === 'campaign' ? graph : undefined,
          criticMode: 'off', publishTaskTree, learning: humanChat ? undefined : learning, conversation: !!humanChat });
        const result = await executor.run({ runId: previousWorkspaceSnapshot?.runId ?? randomUUID(), goal: executionGoal,
          context: null, systemPrompt: emergency
            ? 'You are Minebot in a real survival world. Perform only immediate survival actions; leave crafting and mining for the paused campaign.'
            : humanChat?.requestId
            ? `You are Shannon's body in survival Minecraft. Her owner asked Shannon for something (on his phone or in game chat) and she agreed; the goal is what she agreed to do. Do it (set a goal contract before any physical work), then call task-complete. Do not chat about it: her mind tells him how it went. Your own long task (${goal}) is paused and resumes after task-complete, so do not work on it here.`
            : humanChat?.answered
            ? `You are Shannon's body in survival Minecraft. ${humanChat.player} asked her for something and she has already answered them in chat; the goal is what she agreed to do. Do it (set a goal contract before any physical work), then call task-complete. Use the chat skill only to say it is done or that it cannot be done, in one short Japanese line. Your own long task (${goal}) is paused and resumes after task-complete, so do not work on it here.`
            : humanChat
            ? `You are Shannon (Minebot), playing survival Minecraft on your own. The player ${humanChat.player} has just spoken to you in the game; the goal is what they said. Answer them with the chat skill: Japanese, one short line, in your own voice. If they ask for something you can reasonably do now, do it (set a goal contract before any physical work) and keep it short. Your own long task (${goal}) is paused and resumes as soon as you call task-complete, so do not work on it here.`
            : `You are Minebot. Choose your own plan and skills from live observations. ${scenario.constraints}`,
          tools: humanChat && !humanChat.requestId ? conversationTools : tools, abortSignal: options?.abortSignal
            ? AbortSignal.any([options.abortSignal, probeStopController.signal]) : probeStopController.signal,
          tags: envelope.tags,
          goalContract: emergency ? (envelope.metadata as any)?.goalContract : humanChat ? undefined : scenario.goalContract,
          getHumanFeedback: runMetadata.getHumanFeedback as ShannonExecutorState['getHumanFeedback'],
          previousMessages: runMetadata.previousMessages as ShannonExecutorState['previousMessages'],
          previousTaskNodes: runMetadata.previousTaskNodes as ShannonExecutorState['previousTaskNodes'],
          previousWorkspaceSnapshot,
          initialReflexDecision: runMetadata.reflexDecision as ShannonExecutorState['initialReflexDecision'],
          onToolStarting: (tool, args) => {
            toolStarts.push({ mode, tool, args, atMs: Date.now() - runtimeStartedAt });
            options?.onToolStarting?.(tool, args);
          },
          onCheckpoint: options?.onCheckpoint,
          onTaskTreeUpdate: options?.onTaskTreeUpdate,
          onToolFinished: event => {
            toolTrace.push({ mode, ...event });
            options?.onToolFinished?.(event);
          } });
        (emergency ? emergencyResults : humanChat ? humanChatResults : mainResults).push(result);
        // A request from her mind: how its last run ended, for the result the request loop reports.
        if (humanChat?.requestId) requestTasksOf?.noteRun(humanChat.requestId, result.taskTree?.status === 'completed');
        if (humanChat) console.log(`CAMPAIGN_HUMAN_CHAT_DONE ${JSON.stringify({ player: humanChat.player,
          iterations: result.iterations, completed: result.taskTree?.status === 'completed' })}`);
        return { ...result, savedMessages: result.messages, savedTaskNodes: result.taskNodes,
          savedCognitiveWorkspace: result.cognitiveWorkspace };
      });
      registrar.registerConstantSkills(actor, actor.constantSkills);
      handler.registerAll();
      handler.setEventReactionSystem(reactions);
      await reactions.initialize();
      // A person's words become a task put ahead of the campaign, which pauses at its last checkpoint and
      // resumes after it. A few may wait at once; beyond that they are logged and dropped (each one is paid for).
      receiveHumanChat = (player, message, via, packetSenderUuid) => {
        const text = String(message ?? '').trim().slice(0, 256);
        if (!text || !player || player === actorName) return;
        const record = { atMs: Date.now() - startedAt, player, via, message: text.slice(0, 200),
          taskId: null as string | null, dropped: null as string | null };
        humanChats.push(record);
        console.log(humanChatLogLine(player, text));
        // Game chat: the packet's sender. The UI mod's /chat_message (loopback, mod token) is the owner's own
        // client on this machine, so its name is trusted and looked up in the player list.
        const speakerUuid = via === 'game_chat' ? String(packetSenderUuid ?? '')
          : String((actor.players?.[player] as any)?.uuid ?? '');
        if (companion && speakerUuid && !plannerClosed && !probeStopRequested()) {
          void answerFromCompanion(record, player, speakerUuid, text);
          return;
        }
        queueHumanTask(record, player, text, false);
      };
      // Her mind answers; what it asks of her body goes ahead of the campaign like any request. When the
      // companion cannot answer, the body's own planner answers as before.
      const queueHumanTask = (record: any, player: string, message: string, answered: boolean) => {
        const waiting = runtime.getTaskListState().tasks.filter(task => humanChatTaskIds.has(task.id)
          && ['pending', 'paused', 'executing'].includes(task.status)).length;
        if (plannerClosed || probeStopRequested()) record.dropped = 'run_over';
        else if (waiting >= 3) record.dropped = 'busy';
        else {
          const queued = runtime.putTaskFirst({ userMessage: message },
            { tags: ['user_chat'], metadata: { humanChat: { player, message, answered } } });
          if (queued.success) { record.taskId = queued.taskId!; humanChatTaskIds.add(queued.taskId!); }
          else record.dropped = queued.reason ?? 'queue_refused';
        }
        if (record.dropped) console.log(`CAMPAIGN_HUMAN_CHAT_DROPPED ${JSON.stringify({ player, reason: record.dropped })}`);
      };
      // What her body is doing now, from the campaign graph and the body itself: no coordinates or inventory.
      const bodyNow = () => {
        const active = graph.getActiveId() ? graph.getNode(graph.getActiveId()!) : undefined;
        const requestRunning = runtime.getTaskListState().tasks.some(task => humanChatTaskIds.has(task.id) && task.status === 'executing');
        return companionBodyNow(actor as any, { task: active && active.id !== 'root' ? `${goal} → 今は${active.goal}` : goal,
          busyWith: requestRunning ? 'request' : 'campaign', recentAdvancements });
      };
      const answerFromCompanion = async (record: any, player: string, speakerUuid: string, text: string) => {
        const outcome = await takeCompanionTurn(companion!, { speakerUuid, speakerName: player, message: text, body: bodyNow() },
          reply => speakCompanionReply(actor as any, reply, { uiModBaseUrl: CONFIG.UI_MOD_BASE_URL }));
        if (outcome.kind === 'unavailable') {
          console.log(`CAMPAIGN_COMPANION_UNAVAILABLE ${player}`);
          queueHumanTask(record, player, text, false);
          return;
        }
        const { turn } = outcome;
        record.companion = { intent: turn.intent?.kind ?? null, ignored: turn.ignored ?? null, requestId: outcome.requestId };
        console.log(`CAMPAIGN_COMPANION_REPLY ${JSON.stringify({ player, intent: turn.intent ?? null, reply: turn.reply.slice(0, 80) })}`);
        // Queued on her mind as a request: the request loop takes it through its claim (one path for progress, stop and result).
        if (outcome.requestId && requestLoop) {
          requestRecords.set(outcome.requestId, record);
          record.taskId = requestTaskIds.get(outcome.requestId) ?? null;
          return;
        }
        if (outcome.goal) queueHumanTask(record, player, outcome.goal, true);
      };
      // Requests from her mind (phase 4: shannon-ios docs/minecraft-body-contract.md): only with the companion configured.
      // A claimed request becomes a task ahead of the campaign, like a person's request in game chat, and counts as a human interaction.
      if (companion) {
        const requestTasks = new CompanionRuntimeTasks(runtime, {
          refuse: () => plannerClosed || probeStopRequested() ? 'run_over' : null,
          waiting: () => runtime.getTaskListState().tasks.filter(task => humanChatTaskIds.has(task.id)
            && ['pending', 'paused', 'executing'].includes(task.status)).length,
          envelope: request => ({ tags: ['user_chat'],
            metadata: { humanChat: { player: 'owner', message: request.goal, answered: true, requestId: request.id } } }),
          deaths: () => deaths,
          // The skill the body started last for the task running now: a short label, nothing else.
          step: taskId => runtime.getTaskListState().currentTaskId === taskId
            ? toolStarts.filter(start => start.mode === 'human_chat').at(-1)?.tool : undefined,
          inventory: () => inventoryCounts(actor.inventory.items()),
          onTaken: (request, result) => {
            if ('refused' in result && result.reason === 'run_over') return;
            let record = requestRecords.get(request.id);
            if (!record && request.surface !== 'minecraft') {
              record = { atMs: Date.now() - startedAt, player: 'owner', via: 'companion_request', message: request.goal.slice(0, 200), taskId: null, dropped: null };
              humanChats.push(record);
            }
            console.log(`CAMPAIGN_COMPANION_REQUEST ${JSON.stringify({ id: request.id, surface: request.surface, goal: request.goal.slice(0, 80) })}`);
            if ('refused' in result) { if (record) record.dropped = result.reason; return; }
            humanChatTaskIds.add(result.taskId);
            requestTaskIds.set(request.id, result.taskId);
            if (record) record.taskId = result.taskId;
          },
        });
        requestTasksOf = requestTasks;
        const loop: CompanionRequestLoop = new CompanionRequestLoop(companion, requestTasks, { log: line => console.log(`CAMPAIGN_${line}`) });
        requestLoop = loop;
        loop.start();
      }
      if (uiModConfig) {
        const { startLabUiModBridge } = await import('../src/services/minebot/testing/LabUiModBridge.js');
        uiMod = await startLabUiModBridge({ config: uiModConfig, bot: actor, runtime, reactions,
          // The UI's "continue" button arrives as the system saying 続けて; the campaign continues by itself.
          onChatMessage: async (sender, message) => { if (sender !== 'system') receiveHumanChat?.(sender, message, 'ui_mod'); },
          onControl: route => {
            humanControls.push({ atMs: Date.now() - startedAt, path: route });
            console.log(`CAMPAIGN_HUMAN_CONTROL ${route}`);
          },
          onWarning: code => console.warn(`CAMPAIGN_UI_MOD_WARNING ${code}`) });
        uiModStatus = { enabled: true, backendPort: uiModConfig.backendPort, httpServerPort: uiModConfig.httpServerPort,
          incoming: uiMod.incoming, botNameMatches: uiModConfig.botPlayerName === actorName };
        console.log(`CAMPAIGN_UI_MOD ${JSON.stringify(uiModStatus)}`);
      }
      if (probeStopRequested()) throw new Error(probeStopReason() ?? 'CAMPAIGN_STOP_REQUESTED');
      for (const ms of [100, 1000, 5000]) timers.push(setInterval(() => actor.emit(`taskPer${ms}ms` as any), ms));
      timers.push(setInterval(() => {
        const position = actor.entity?.position;
        const hostiles = position ? Object.values(actor.entities).filter(entity => entity.type === 'hostile')
          .map(entity => ({ name: entity.name, distance: Math.round(position.distanceTo(entity.position) * 10) / 10 }))
          .sort((a, b) => a.distance - b.distance).slice(0, 3) : [];
        survivalTrace.push({ elapsedMs: Date.now() - runtimeStartedAt, health: actor.health, food: actor.food,
          oxygenLevel: Number.isFinite(actor.oxygenLevel) ? actor.oxygenLevel : null,
          isInWater: (actor.entity as any)?.isInWater ?? null,
          headBlock: position ? actor.blockAt(position.offset(0, 1.62, 0).floored())?.name ?? null : null,
          position, dimension: actor.game?.dimension ?? null, controlState: actor.minebotControlState, hostiles });
      }, 500));
      // Coarse progress along the tool/portal chain, for diagnosis only.
      timers.push(setInterval(() => {
        const counts: Record<string, number> = {};
        for (const item of actor.inventory.items()) if (PROGRESS_ITEMS.has(item.name)) counts[item.name] = (counts[item.name] ?? 0) + item.count;
        progressTrace.push({ elapsedMs: Date.now() - runtimeStartedAt, dimension: actor.game?.dimension ?? null,
          y: actor.entity?.position?.y ?? null, timeOfDay: actor.time?.timeOfDay ?? null, counts });
      }, 5000));
      const queued = runtime.addTaskToQueue({ userMessage: goal });
      if (!queued.success) throw new Error(`CAMPAIGN_MAIN_TASK_QUEUE_FAILED:${queued.reason}`);
      // The task carrying the campaign now, and the dimension it was given in (see the portal below).
      let campaignTaskId = queued.taskId!;
      let campaignDimension = String(actor.game?.dimension ?? '');
      const deadline = Date.now() + segmentLimit;
      let netherSaid = inNether();
      while (!probeStopRequested() && Date.now() < deadline && !deaths
        && graph.getNode('root')?.state !== 'verified' && !reachedMilestone()) {
        // The moment of arrival, for a run that goes on past it.
        if (!netherSaid && inNether()) { netherSaid = true; console.log(`CAMPAIGN_NETHER_REACHED ${JSON.stringify({ elapsedMs: Date.now() - startedAt, deaths })}`); }
        // An answer that ran out of turns or failed is not asked to continue: the person can speak again.
        for (const task of runtime.getTaskListState().tasks) {
          if (humanChatTaskIds.has(task.id) && ['awaiting_user', 'failed_terminal'].includes(task.status)
            && !(runtime.isRunning() && runtime.currentState?.taskId === task.id)) runtime.removeTask(task.id);
        }
        const taskList = runtime.getTaskListState();
        const campaignTask = taskList.tasks.find(task => task.id === campaignTaskId);
        if (!runtime.isRunning() && !runtime.isInEmergencyMode() && campaignTask?.status === 'awaiting_user') {
          // MAX_ITERATIONS is a planner turn boundary, not a new operator goal.
          // Continue the same queued campaign with its native checkpoint only
          // while the configured time, run count and paid reservation remain.
          if (!probeStopRequested() && autonomousContinuations < maxSegments - 1
            && deadline - Date.now() >= 30_000 && budgetHasRoom()
            && await runtime.resumeAwaitingCampaignTask(campaignTaskId, goal)) {
            autonomousContinuations++;
            continue;
          }
          stopReason = budgetStopRequested || !budgetHasRoom() ? 'reserved_budget_exhausted'
            : autonomousContinuations >= maxSegments - 1 ? 'continuation_limit'
              : deadline - Date.now() < 30_000 ? 'window_nearly_expired' : 'resume_rejected';
          break;
        }
        // Through a portal the task's memory scope (server, world, dimension) is gone, and the runtime cancels the
        // task, as it should: what was said in one dimension is not carried into another unasked. The campaign is
        // the operator's and goes on, as a new task for the same goal in the new dimension; its goals and the world
        // are where the planner picks it up. Without this a run ended at the portal (paid run L88: the Nether reached
        // from a fresh world at 67 minutes, and the run over in the same second).
        const nowDimension = String(actor.game?.dimension ?? '');
        if (campaignTask?.status === 'failed_terminal' && nowDimension && nowDimension !== campaignDimension
          && !runtime.isRunning() && !runtime.isInEmergencyMode() && !probeStopRequested()
          && autonomousContinuations < maxSegments - 1 && deadline - Date.now() >= 30_000 && budgetHasRoom()) {
          runtime.removeTask(campaignTaskId);
          const next = runtime.addTaskToQueue({ userMessage: goal });
          if (next.success) {
            console.log(`CAMPAIGN_DIMENSION_CONTINUED ${JSON.stringify({ from: campaignDimension, to: nowDimension, elapsedMs: Date.now() - startedAt })}`);
            campaignTaskId = next.taskId!;
            campaignDimension = nowDimension;
            autonomousContinuations++;
            continue;
          }
        }
        if (mainResults.length && !runtime.isRunning() && !runtime.isInEmergencyMode()
          && !taskList.tasks.some(task => ['pending', 'paused', 'executing'].includes(task.status))) {
          stopReason = 'runtime_terminal';
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      stopReason = probeStopReason() ?? stopReason;
      stopReason ??= graph.getNode('root')?.state === 'verified' ? 'dragon_verified'
        : reachedMilestone() ? 'milestone_reached' : deaths ? 'actor_died'
          : Date.now() >= deadline ? 'window_expired' : 'loop_exited';
    } catch (error) {
      interruptionError = String(error);
      if (!probeStopRequested()) throw error;
      stopReason = probeStopReason();
    } finally {
      stopReason = probeStopReason() ?? stopReason;
      campaignStopReason = stopReason ?? 'runtime_error';
      // What her mind asked and is still open ends with the run (or with her death).
      await requestLoop?.stop(deaths ? 'died' : 'run_over').catch(() => undefined);
      plannerClosed = true;
      if (runtime.isRunning()) runtime.forceStop();
      const settleDeadline = Date.now() + 10000;
      while (runtime.isRunning() && Date.now() < settleDeadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (learning.mode !== 'off' && !probeStopRequested()) {
        const held = actor.inventory.items().map(item => `${item.name}x${item.count}`).join(',');
        await learning.reflect(actor, 'run_end', `試行の終了: 理由=${campaignStopReason}、死亡${deaths}回、`
          + `経過${Math.round((Date.now() - runtimeStartedAt) / 60000)}分、最終所持品=[${held}]。この試行全体から、次の試行でより早く・安全に進むための教訓を導く`)
          .catch(error => console.warn(`LEARNING_RUN_END_REFLECTION_FAILED ${String(error)}`));
      }
      const finalMain = mainResults.at(-1);
      segments.push({ scenario: scenario.id, plannerKind: 'real_provider', fullRuntime: true,
        passed: (milestone ? reachedMilestone() : graph.getNode('root')?.state === 'verified') && deaths === 0,
        durationMs: Date.now() - runtimeStartedAt,
        executor: finalMain ?? { durationMs: Date.now() - runtimeStartedAt, iterations: 0, messages: null },
        toolTrace, toolStarts, mainRuns: mainResults.length, emergencyRuns: emergencyResults.length,
        humanChatRuns: humanChatResults.length, companionRequests: requestLoop?.taken ?? [],
        autonomousContinuations, stopReason: campaignStopReason, interruptionError,
        taskList: runtime.getTaskListState(), executionStillRunningAtReport: runtime.isRunning(),
        persistedHostileProbability: savedSettings.reactions.find(row => row.eventType === 'hostile_approach')?.probability,
        isolatedHostileProbability: 100 });
      for (const timer of timers) clearInterval(timer);
      receiveHumanChat = null;
      await uiMod?.stop().catch(() => undefined);
      reactions.destroy();
      for (const skill of actor.constantSkills.getSkills()) registrar.detachConstantSkillInterval(actor, skill.skillName);
      runtime.forceStop();
    }
  } else {
    for (let segment = 1; segment <= maxSegments; segment++) {
      if (probeStopRequested()) {
        campaignStopReason = probeStopReason();
        break;
      }
      const result = await runner!.run(scenario, { tools, plannerKind: 'real_provider', oracle,
        timeoutMs: Number(process.env.MINECRAFT_CAMPAIGN_WINDOW_MS ?? 240000), continuation });
      segments.push(result);
      graph.checkpoint();
      console.log(`CAMPAIGN_SEGMENT ${JSON.stringify({ segment, executorMs: result.executor.durationMs,
        iterations: result.executor.iterations, rootState: graph.getNode('root')?.state, nodes: graph.size,
        inventory: actor.inventory.items().map(item => ({ name: item.name, count: item.count })), deaths,
        requests: requests.length, budgetReservedUsd: requests.at(-1)?.totalReservedUsd ?? requests.at(-1)?.settledUsd ?? 0 })}`);
      if (result.passed || deaths || !result.executor.messages || result.executor.iterations < 2) break;
      continuation = { runId: result.executor.cognitiveWorkspace.runId, messages: result.executor.messages,
        taskNodes: result.executor.taskNodes, workspace: result.executor.cognitiveWorkspace };
    }
  }
  const nativeSuccess = milestone === 'nether'
    ? await oracle.evaluate({ type: 'dimension', dimension: 'the_nether' })
    : milestone === 'blaze_rod'
    ? await oracle.evaluate({ type: 'inventory_count', item: 'blaze_rod', minCount: 1 })
    : ironPickaxeObjective || milestone === 'iron_pickaxe'
    ? await oracle.evaluate({ type: 'inventory_count', item: 'iron_pickaxe', minCount: 1 })
    : null;
  const nativeSurvival = ironPickaxeObjective || milestone ? await oracle.evaluateAll([
    { type: 'gamemode', gamemode: 'survival' }, { type: 'health_between', min: 1, max: 20 },
  ]) : [];
  // A respawned actor can have full health after dying during the run.
  const survivalContinuous = deaths === 0 && nativeSurvival.every(check => check.passed);
  const milestoneCrafted = !!milestone && !!(previousMilestoneCraft || craftedMilestoneIn(segments));
  // Reaching the Nether is judged by the server dimension; deaths are reported separately.
  const milestoneReached = milestone === 'nether' || milestone === 'blaze_rod' ? nativeSuccess?.passed === true : milestoneCrafted;
  const contact = humanContactSummary();
  const accepted = !contact.acceptanceVoidReason && (milestone
    ? milestoneReached && nativeSuccess?.passed === true && survivalContinuous
    : ironPickaxeObjective
    ? graph.getNode('root')?.state === 'verified' && nativeSuccess?.passed === true && survivalContinuous
    : graph.getNode('root')?.state === 'verified');
  report = { startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, objective, milestone: milestone || null,
    milestoneCrafted, milestoneReached, budgetProfile, fullRuntime, survivalTrace, progressTrace, survivalContinuous,
    stopReason: probeStopReason() ?? campaignStopReason,
    operatorStopSource, stopFile,
    worldId, port, resumed: resumeCampaign, initialInventory, initialChecks,
    campaignRevision: graph.currentRevision, campaignNodes: graph.size,
    root: graph.getNode('root'), accepted, ...contact, humanChats, humanControls, watchers: watcherMode, uiMod: uiModStatus,
    nativeSuccess, nativeSurvival, frontier: graph.projection(graph.getActiveId()),
    actor: { position: actor.entity?.position, health: actor.health, food: actor.food,
      inventory: actor.inventory.items().map(item => ({ name: item.name, count: item.count })), deaths, minHealth },
    requests, segments };
  console.log(`CAMPAIGN_RESULT ${JSON.stringify({ durationMs: report.durationMs, objective, milestone: milestone || null,
    milestoneCrafted, milestoneReached, accepted, humanInteractions: contact.humanInteractions,
    acceptanceVoidReason: contact.acceptanceVoidReason, stopReason: report.stopReason, rootState: report.root.state,
    nativeSuccess: nativeSuccess?.passed ?? null, nativeSurvival: survivalContinuous,
    nodes: report.campaignNodes, inventory: report.actor.inventory, deaths, requests: requests.length,
    budgetReservedUsd: requests.at(-1)?.totalReservedUsd ?? requests.at(-1)?.settledUsd ?? 0 })}`);
} catch (error) {
  // An already-dispatched fetch may reject as AbortError (or the runtime may
  // report its own cancellation) after the operator stop. Preserve that raw
  // diagnostic, but do not turn the requested early stop into a failed run.
  const interrupted = probeStopRequested();
  report = { startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt,
    objective, milestone: milestone || null, worldId, budgetProfile, fullRuntime,
    stopReason: probeStopReason() ?? campaignStopReason ?? 'error',
    operatorStopSource, stopFile, accepted: false, ...humanContactSummary(), humanChats, humanControls,
    watchers: watcherMode, uiMod: uiModStatus, error: String(error), survivalTrace, segments,
    campaignRevision: graph.currentRevision, campaignNodes: graph.size,
    root: graph.getNode('root'), frontier: graph.projection(graph.getActiveId()), requests,
    actor: { position: actor.entity?.position, health: actor.health, food: actor.food,
      inventory: actor.inventory.items().map(item => ({ name: item.name, count: item.count })), deaths, minHealth } };
  if (interrupted) console.log(`CAMPAIGN_EARLY_STOP ${probeStopReason()}`);
  else { console.error(`CAMPAIGN_ERROR ${String(error)}`); process.exitCode = 1; }
} finally {
  clearInterval(stopPollTimer);
  actor.removeListener('death', onCampaignDeath);
  actor._client.removeListener('playerChat', onGameChat);
  try {
    try { await learning.flush(); report.learning = learning.summary(); }
    catch (error) { report.learningError = String(error); }
    try { graph.checkpoint(); }
    catch (error) { report.checkpointError = String(error); process.exitCode = 1; }
    const file = path.join(reportsDirectory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${ironPickaxeObjective ? 'iron-pickaxe' : 'dragon'}-campaign.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`CAMPAIGN_REPORT ${file}`);
  } finally {
    plannerClosed = true;
    closeProbeBot(actor); if (operator) closeProbeBot(operator); rcon?.close();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    // The run is over: nothing left alive in the process (a runtime timer, a reflex watcher, a learning
    // hook) may keep it going. Requests already sent are given time to be settled by their usage first.
    // (A harness that runs this script inside its own process keeps it by setting MINECRAFT_CAMPAIGN_KEEP_PROCESS.)
    if (process.env.MINECRAFT_CAMPAIGN_KEEP_PROCESS !== 'true') {
      const exitDeadline = Date.now() + 125_000;
      while (inFlight.size && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 250));
      setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
    }
  }
}
