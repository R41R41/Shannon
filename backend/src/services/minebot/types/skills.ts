import { beginEngagement, engagementOf } from '../utils/engagement.js';
import { createLogger } from '../../../utils/logger.js';
import { CONFIG } from '../config/MinebotConfig.js';
import { extractAndSaveKnowledge } from '../knowledge/skillResultExtractor.js';
import { SkillResultCache } from '../knowledge/SkillResultCache.js';
import { skillMetrics } from '../knowledge/SkillMetrics.js';
import { actionSignal, assertActionActive, executeAction, preemptLowerPriorityActions, cancelAction, cancelCapability, physicalActionBusy, waitForActionQuiescence, createMotorPort, currentAction } from '../execution/ActionExecution.js';
import { skillCategory } from '../execution/SkillExecutor.js';
import { describeRemainingTools } from '../utils/toolWear.js';
import { describeToolOptions, takeToolStockNotes } from '../utils/toolStock.js';
import { boundMinecraftServerId } from '../runtime/memoryContext.js';
import type { CustomBot } from './CustomBot.js';
import type { SkillParam, SkillResult } from './skillParams.js';

const skillCache = new SkillResultCache();

const log = createLogger('Minebot:Types');

export abstract class Skill {
  skillName: string;
  description: string;
  status: boolean;
  bot: CustomBot;
  /**
   * The body this skill was made for. `bot` is swapped for a fenced motor port while a run is in
   * progress; a run that starts while a cancelled one has not finished unwinding must not take that
   * leftover port for the body. It did: after a tool broke, the next call in the same response wrapped
   * its own port around the dead one, and from then on every dig failed with "Motor owner expired"
   * for the rest of the run (paid run L39, 14 times).
   */
  protected readonly rootBot: CustomBot;
  isToolForLLM: boolean;
  constructor(bot: CustomBot) {
    this.skillName = 'skill';
    this.description = 'skill';
    this.status = true;
    this.bot = bot;
    this.rootBot = bot;
    this.isToolForLLM = true;
  }
}

/** Lease ranks: task 0 < reflex (e.g. eating) < escape and counterattack (200) < critical survival (air). */
const REFLEX_PRIORITY = 100;
const CRITICAL_REFLEX_PRIORITY = 300;

export abstract class ConstantSkill extends Skill {
  priority: number;
  isLocked: boolean;
  interval: number | null;
  args: any;
  containMovement: boolean;
  /** trueの場合、InstantSkill実行中でもスキップされない（溺死防止など生存スキル向け） */
  isCritical: boolean;
  maxDurationMs: number = CONFIG.TASK_TIMEOUT ?? 10000;
  constructor(bot: CustomBot) {
    super(bot);
    this.priority = 0;
    this.containMovement = false;
    this.isCritical = false;
    this.isLocked = false;
    this.interval = null;
    this.args = {};
  }
  lock() {
    if (this.isLocked) return;
    this.isLocked = true;
  }
  unlock() {
    if (!this.isLocked) return;
    this.isLocked = false;
  }
  /** Override with an actual live hazard predicate, never preempt on an idle timer. */
  protected shouldPreempt(): boolean { return false; }
  wantsPreemption(): boolean { return this.shouldPreempt(); }
  cancel(): void { cancelCapability(this.bot, this.skillName, 'constant_queue_cleared'); }

  async run(...args: any[]): Promise<void> {
    if (this.isLocked) return;

    // containMovementがtrueの場合、優先度チェックとInstantSkill実行チェックを行う
    if (this.containMovement) {
      // InstantSkillが実行中の場合は実行しない（ただしisCriticalなスキルは除外）
      if (this.bot.executingSkill && !this.isCritical) {
        return;
      }

      // 優先度の高いConstantSkillが実行中の場合は実行しない（isCriticalでも優先度チェックは行う）
      const runningSkills = this.bot.constantSkills
        .getSkills()
        .filter((skill) => skill.containMovement && skill.isLocked && skill.priority > this.priority);
      if (runningSkills.length > 0) {
        return;
      }
    }

    this.isLocked = true;
    try {
      const physical = skillCategory(this.skillName) !== 'query';
      const preempt = physical && this.shouldPreempt();
      // Air outranks a pursuer; hunger does not. A critical survival skill
      // takes the body from anything, any other reflex only from the task.
      const priority = preempt ? (this.isCritical ? CRITICAL_REFLEX_PRIORITY : REFLEX_PRIORITY) : -1;
      if (preempt && !currentAction(this.bot)) {
        if (!preemptLowerPriorityActions(this.bot, priority, `constant:${this.skillName}`)) return;
      } else if (physical && physicalActionBusy(this.bot) && !currentAction(this.bot)) {
        // Periodic/event scheduler retries later; do not steal another action's hand/look.
        return;
      }
      const host = this.rootBot;
      await executeAction(host, this.skillName, this.maxDurationMs, async () => {
        const port = createMotorPort(host);
        this.bot = port;
        try { await this.runImpl(...args); return { success: true, result: this.skillName }; }
        finally { if (this.bot === port) this.bot = host; }
      }, { legacyExecutingSkill: false, priority,
        waitForQuiescence: true, safetyLease: this.isCritical && preempt });
    } finally {
      this.isLocked = false;
    }
  }

  protected abstract runImpl(...args: any[]): Promise<void>;
}

export abstract class InstantSkill extends Skill {
  priority: number;
  status: boolean;
  params: SkillParam[];
  canUseByCommand: boolean;
  /** スキルのタイムアウト（ミリ秒）。サブクラスでオーバーライド可能。0 = 無制限。 */
  maxDurationMs: number;

  constructor(bot: CustomBot) {
    super(bot);
    this.priority = 0;
    this.status = false;
    this.params = [];
    this.canUseByCommand = true;
    this.maxDurationMs = CONFIG.SKILL_TIMEOUT_MS ?? 120_000;
  }

  async run(...args: any[]): Promise<SkillResult> {
    const serverId = boundMinecraftServerId(this.bot);

    // キャッシュチェック（クエリ系スキルのみ）。未bindingの表示名では共有しない。
    if (serverId && skillCache.isCacheable(this.skillName) && this.bot.entity) {
      const pos = this.bot.entity.position;
      const cached = skillCache.get(this.skillName, args, { x: pos.x, y: pos.y, z: pos.z }, serverId);
      if (cached) return { ...cached, duration: 0 };
    }

    const host = this.rootBot;
    // What needs no body is said before the body is asked for (see preflight).
    if (!currentAction(host)) {
      let refused: SkillResult | null = null;
      try { refused = this.preflight(...args); } catch { refused = null; }
      if (refused) return { ...refused, duration: 0 };
    }
    // A tool breaking is the body's news, not the skill's: hand the decision
    // back instead of carrying on with whatever is left (paid run L21 wore out
    // its last two pickaxes inside one mining action). Only the action the
    // planner called is stopped; nested skills end with it.
    const broken: string[] = [];
    const topLevel = !currentAction(host);
    let actionId: string | null = null;
    let rootAction: object | null = null;
    const onBroke = (entry: { name: string }) => {
      broken.push(entry.name);
      if (actionId) cancelAction(host, actionId, 'tool_broke');
    };
    if (topLevel) host.on?.('minebotToolBroke' as any, onBroke as any);
    // A fight the planner called is said to the layer that keeps the body alive for as long as it runs (see engagement).
    const endEngagement = topLevel ? beginEngagement(host, engagementOf(this.skillName, args)) : null;
    let finalResult: SkillResult;
    try {
      finalResult = await executeAction(host, this.skillName, this.maxDurationMs, async () => {
        this.status = true;
        const port = createMotorPort(host);
        this.bot = port;
        actionId = currentAction(host)?.progress.actionId ?? null;
        if (topLevel) rootAction = currentAction(host) ?? null;
        try { return await this.runImpl(...args); }
        // Only this run's own port is handed back: a later run may already have put its own in place.
        finally { this.status = false; if (this.bot === port) this.bot = host; }
      });
    } finally {
      endEngagement?.();
      if (topLevel) host.removeListener?.('minebotToolBroke' as any, onBroke as any);
    }
    if (broken.length) {
      // What the carried materials can make is said with what is left, so the planner can choose (paid run L111).
      let options = '';
      try { options = describeToolOptions(host, broken); } catch { options = ''; }
      finalResult = { ...finalResult, success: false, failureType: 'tool_broke', recoverable: true,
        result: `${this.skillName}の途中で${[...new Set(broken)].join('、')}が壊れたため、行動を止めました（実行済みの効果は残っています）。`
          + `残っている道具: ${describeRemainingTools(host)}${options ? `。${options}` : ''}` };
    }
    // A cheap tool the action made (or could not make) on the way is said in its result (see utils/toolStock).
    const stockNotes = takeToolStockNotes(rootAction);
    if (stockNotes.length && typeof finalResult.result === 'string') finalResult = { ...finalResult, result: `${finalResult.result} ${stockNotes.join(' ')}` };
    if (serverId) {
      extractAndSaveKnowledge(this.skillName, args, finalResult, serverId).catch(() => {});
      skillMetrics.record(serverId, this.skillName, args, finalResult.success,
        finalResult.duration ?? 0, finalResult.error ?? null).catch(() => {});
    }
    if (serverId && skillCache.isCacheable(this.skillName) && this.bot.entity) {
      const pos = this.bot.entity.position;
      skillCache.set(this.skillName, args, finalResult, { x: pos.x, y: pos.y, z: pos.z }, serverId);
    }
    return finalResult;
  }

  /**
   * A refusal that can be told from the arguments and a look at the world, without the body: returned at
   * once, before the skill waits its turn for the body. Null (the default) lets the skill run. A planner in
   * an emergency asked for a block to be placed at a spot the escape reflex had already carried the body
   * twenty-five metres from; the call waited eleven seconds for the body and then answered "too far", twice,
   * while a skeleton shot at it (paid run L70).
   */
  protected preflight(..._args: any[]): SkillResult | null { return null; }

  /**
   * スキルを中断すべきか判定する。
   * 長時間ループを持つスキルは、各イテレーション間でこれを呼ぶことで
   * 100msのポーリングより早く中断できる。
   */
  protected shouldInterrupt(): boolean {
    return this.bot.interruptExecution === true
      || (actionSignal(this.bot)?.aborted ?? false);
  }

  /** runImpl 内で AbortSignal を参照するためのアクセサ */
  protected get abortSignal(): AbortSignal | undefined {
    return actionSignal(this.bot);
  }

  /**
   * 別の InstantSkill を内部呼び出しする。
   * 親の身体leaseを共有し、子の期限とmotor fenceを保持する。
   * 外側のキャッシュ・メトリクスは従来どおり通さない。親のrunImpl内からのみ使用。
   */
  protected async callSkill(name: string, ...args: any[]): Promise<SkillResult> {
    const skill = this.bot.instantSkills.getSkill(name);
    if (!skill) {
      return { success: false, result: `スキル「${name}」が見つかりません` };
    }
    assertActionActive(this.bot);
    if (!currentAction(this.bot)) throw new Error('Nested skill requires an active parent action');
    // The nested skill's own body, never a port a cancelled run of it left behind.
    const host = (skill as unknown as { rootBot: CustomBot }).rootBot ?? skill.bot;
    return executeAction(this.bot, name, skill.maxDurationMs, async () => {
      const port = createMotorPort(this.bot);
      skill.bot = port;
      try { return await skill.runImpl(...args); }
      finally { if (skill.bot === port) skill.bot = host; }
    });
  }

  abstract runImpl(
    ...args: any[]
  ): Promise<SkillResult>;
}
