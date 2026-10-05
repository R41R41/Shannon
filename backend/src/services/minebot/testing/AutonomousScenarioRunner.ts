import { ShannonExecutor, type ShannonExecutorDeps, type ShannonExecutorResult } from '../../llm/graph/ShannonExecutor.js';
import type { CustomBot } from '../types/CustomBot.js';
import { MinecraftCommandOracle } from './MinecraftCommandOracle.js';
import type { GoalContract } from '../cognition/GoalVerifier.js';

export interface AutonomousScenario {
  id: string;
  goal: string;
  constraints: string;
  setup: string[];
  goalContract: GoalContract;
  /** Prove environmental/preparation facts before attributing an agent result. */
  preAssertions?: Parameters<MinecraftCommandOracle['evaluate']>[0][];
  assertions: Parameters<MinecraftCommandOracle['evaluate']>[0][];
  /** Harness-only disturbance; hidden setup positions are never planner context. */
  disturbances?: Array<{ afterMs: number; commands: string[] }>;
}

/** The planner chooses skills and their order. The harness owns only setup,
 * timed disturbances and independent server assertions. No prewritten skill plan.
 */
export class AutonomousScenarioRunner {
  constructor(private readonly bot: CustomBot, private readonly deps: ShannonExecutorDeps, private readonly port: number) {
    if (port >= 25565 && port <= 25569 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ISOLATED_PORT_REQUIRED');
    const socket = (bot as any)._client?.socket;
    if (!socket || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.remoteAddress) || socket.remotePort !== port) throw new Error('ISOLATED_LOOPBACK_REQUIRED');
  }
  async run(scenario: AutonomousScenario, options: { tools: Parameters<ShannonExecutor['run']>[0]['tools']; timeoutMs?: number;
    plannerKind: 'real_provider' | 'protocol_fixture'; oracle?: MinecraftCommandOracle;
    continuation?: { runId: string; messages?: Parameters<ShannonExecutor['run']>[0]['previousMessages'];
      taskNodes?: Parameters<ShannonExecutor['run']>[0]['previousTaskNodes'];
      workspace?: Parameters<ShannonExecutor['run']>[0]['previousWorkspaceSnapshot'] } }): Promise<{
    scenario: string; plannerKind: string; autonomousQualityEvaluated: boolean; passed: boolean; durationMs: number;
    executor: ShannonExecutorResult; assertions: unknown[]; disturbances: unknown[]; setupProof: unknown[]; toolTrace: unknown[];
  }> {
    const startedAt = Date.now();
    // A test planner must not reach shared UI Mod/network tools or send OP
    // commands through chat. Reject them at dispatch as well as in the schema.
    const allowed = new Set(options.tools.map(tool => tool.name));
    if (['chat', 'get-advancements', 'investigate-terrain'].some(name => allowed.has(name))) throw new Error('ISOLATED_LOCAL_TOOLS_ONLY');
    const instantSkills = {
      getSkill: (name: string) => allowed.has(name) ? this.bot.instantSkills.getSkill(name) : undefined,
      getSkills: () => this.bot.instantSkills.getSkills().filter(skill => allowed.has(skill.skillName)),
    } as CustomBot['instantSkills'];
    const oracle = options.oracle ?? new MinecraftCommandOracle(this.bot); await oracle.verifyReady();
    for (const command of scenario.setup) await oracle.executeSetupCommand(command);
    const setupProof = [];
    for (const assertion of scenario.preAssertions ?? []) setupProof.push(await oracle.evaluate(assertion));
    if (setupProof.some(result => !result.passed)) throw new Error(`SCENARIO_SETUP_UNVERIFIED:${JSON.stringify(setupProof)}`);
    const controller = new AbortController();
    let disconnected = false;
    const onDisconnect = () => { disconnected = true; controller.abort('minecraft_connection_lost'); };
    const onDeath = () => controller.abort('minecraft_actor_died');
    this.bot.once('end', onDisconnect);
    this.bot.once('death', onDeath);
    const deadline = setTimeout(() => controller.abort('scenario_deadline'), options.timeoutMs ?? 180000);
    const disturbances: unknown[] = [];
    const tasks: Promise<void>[] = [];
    const timers = (scenario.disturbances ?? []).map(disturbance => setTimeout(() => {
      const task = (async () => {
        const appliedAt = Date.now();
        try { for (const command of disturbance.commands) await oracle.executeSetupCommand(command); disturbances.push({ afterMs: disturbance.afterMs, appliedAt, success: true }); }
        catch (error) { disturbances.push({ afterMs: disturbance.afterMs, appliedAt, success: false, error: String(error) }); controller.abort('disturbance_failed'); }
      })(); tasks.push(task);
    }, disturbance.afterMs));
    let executor: ShannonExecutorResult;
    const toolTrace: unknown[] = [];
    try {
      executor = await new ShannonExecutor({ ...this.deps, publishTaskTree: () => {}, bot: this.bot, instantSkills }).run({
        runId: options.continuation?.runId ?? crypto.randomUUID(), goal: scenario.goal, goalContract: scenario.goalContract, context: null,
        previousMessages: options.continuation?.messages, previousTaskNodes: options.continuation?.taskNodes,
        previousWorkspaceSnapshot: options.continuation?.workspace,
        systemPrompt: `You are Minebot. Choose your own plan and skills from live observations. ${scenario.constraints}`, tools: options.tools, abortSignal: controller.signal,
        onToolFinished: event => toolTrace.push(event),
      });
    } finally { this.bot.removeListener('end', onDisconnect); this.bot.removeListener('death', onDeath); clearTimeout(deadline); for (const timer of timers) clearTimeout(timer); await Promise.all(tasks); }
    const assertions = [];
    for (const assertion of scenario.assertions) assertions.push(disconnected
      ? { assertion, passed: false, durationMs: 0, error: 'actor_disconnected_before_oracle' }
      : await oracle.evaluate(assertion));
    return { scenario: scenario.id, plannerKind: options.plannerKind, autonomousQualityEvaluated: options.plannerKind === 'real_provider',
      passed: !controller.signal.aborted && executor.taskTree?.status === 'completed' && assertions.every(assertion => assertion.passed)
        && disturbances.every((disturbance: any) => disturbance.success), durationMs: Date.now() - startedAt, executor, assertions, disturbances, setupProof, toolTrace };
  }
}
