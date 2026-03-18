import { createLogger } from '../../../utils/logger.js';
import { CONFIG } from '../config/MinebotConfig.js';
import { extractAndSaveKnowledge } from '../knowledge/skillResultExtractor.js';
import { SkillResultCache } from '../knowledge/SkillResultCache.js';
import { skillMetrics } from '../knowledge/SkillMetrics.js';
import { SkillExecutor } from '../execution/SkillExecutor.js';
import type { CustomBot } from './CustomBot.js';
import type { SkillParam, SkillResult } from './skillParams.js';

const skillExecutor = new SkillExecutor();

const skillCache = new SkillResultCache();

const log = createLogger('Minebot:Types');

export abstract class Skill {
  skillName: string;
  description: string;
  status: boolean;
  bot: CustomBot;
  isToolForLLM: boolean;
  constructor(bot: CustomBot) {
    this.skillName = 'skill';
    this.description = 'skill';
    this.status = true;
    this.bot = bot;
    this.isToolForLLM = true;
  }
}

export abstract class ConstantSkill extends Skill {
  priority: number;
  isLocked: boolean;
  interval: number | null;
  args: any;
  containMovement: boolean;
  /** trueの場合、InstantSkill実行中でもスキップされない（溺死防止など生存スキル向け） */
  isCritical: boolean;
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
      await this.runImpl(...args);
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
  /** 中断時に runImpl 内のループを即座に停止するための AbortController */
  private _abortController: AbortController | null = null;

  constructor(bot: CustomBot) {
    super(bot);
    this.priority = 0;
    this.status = false;
    this.params = [];
    this.canUseByCommand = true;
    this.maxDurationMs = CONFIG.SKILL_TIMEOUT_MS ?? 120_000;
  }

  async run(...args: any[]): Promise<SkillResult> {
    // キャッシュチェック（クエリ系スキルのみ）
    if (skillCache.isCacheable(this.skillName) && this.bot.entity) {
      const pos = this.bot.entity.position;
      const cached = skillCache.get(this.skillName, args, { x: pos.x, y: pos.y, z: pos.z });
      if (cached) return { ...cached, duration: 0 };
    }

    // カテゴリベースのロック取得（queryスキルはロック不要で即座実行）
    const releaseLock = await skillExecutor.acquire(this.skillName);

    this.bot.executingSkill = true;
    this.bot.interruptExecution = false;
    this._abortController = new AbortController();
    this.status = true;
    const startTime = Date.now();

    let interruptCheckInterval: ReturnType<typeof setInterval> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      // 中断監視: 100msごとに interruptExecution フラグをチェック（Phase 1-C: 500ms→100ms）
      const interruptPromise = new Promise<SkillResult>((resolve) => {
        interruptCheckInterval = setInterval(() => {
          if (this.bot.interruptExecution) {
            if (interruptCheckInterval) {
              clearInterval(interruptCheckInterval);
              interruptCheckInterval = null;
            }
            try {
              this._abortController?.abort();
              this.bot.clearControlStates();
              const pathfinder = (this.bot as any).pathfinder;
              if (pathfinder && typeof pathfinder.stop === 'function') {
                pathfinder.stop();
              }
            } catch (_) { /* ignore */ }

            log.warn(`⚡ ${this.skillName} を中断: フィードバック受信`);
            resolve({
              success: false,
              result: `フィードバックにより中断されました（${this.skillName}）。再計画します。`,
            });
          }
        }, 100);
      });

      // タイムアウト制御
      const timeoutPromise = this.maxDurationMs > 0
        ? new Promise<SkillResult>((resolve) => {
            timeoutId = setTimeout(() => {
              try {
                this._abortController?.abort();
                this.bot.clearControlStates();
                const pathfinder = (this.bot as any).pathfinder;
                if (pathfinder && typeof pathfinder.stop === 'function') {
                  pathfinder.stop();
                }
              } catch (_) { /* ignore */ }

              log.warn(`⏱️ ${this.skillName} がタイムアウト (${this.maxDurationMs}ms)`);
              resolve({
                success: false,
                result: `${this.skillName} がタイムアウトしました（${Math.round(this.maxDurationMs / 1000)}秒）。別のアプローチを検討してください。`,
              });
            }, this.maxDurationMs);
          })
        : new Promise<never>(() => {});

      const result = await Promise.race([
        this.runImpl(...args),
        interruptPromise,
        timeoutPromise,
      ]);

      const duration = Date.now() - startTime;
      const finalResult = { ...result, duration };

      // ワールド知識の自動抽出（fire-and-forget）
      extractAndSaveKnowledge(this.skillName, args, finalResult, this.bot.connectedServerName || 'default')
        .catch(() => {});

      // キャッシュ書き込み
      if (skillCache.isCacheable(this.skillName) && this.bot.entity) {
        const pos = this.bot.entity.position;
        skillCache.set(this.skillName, args, finalResult, { x: pos.x, y: pos.y, z: pos.z });
      }

      // メトリクス記録
      skillMetrics.record(
        this.bot.connectedServerName || 'default',
        this.skillName, args,
        finalResult.success, finalResult.duration || 0, null,
      ).catch(() => {});

      return finalResult;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      skillMetrics.record(
        this.bot.connectedServerName || 'default',
        this.skillName, args, false, duration, error.message,
      ).catch(() => {});
      return {
        success: false,
        result: 'Skill execution failed',
        error: error.message,
        duration,
      };
    } finally {
      if (interruptCheckInterval) {
        clearInterval(interruptCheckInterval);
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      releaseLock();
      this.bot.executingSkill = false;
      // 注意: interruptExecution はここでリセットしない（runImpl のバックグラウンド用）。
      // _abortController も abort 済みのまま残す（runImpl 側が signal.aborted を参照するため）。
      // 両方とも次の run() 開始時にリセットされる。
      this.status = false;
    }
  }

  /**
   * スキルを中断すべきか判定する。
   * 長時間ループを持つスキルは、各イテレーション間でこれを呼ぶことで
   * 100msのポーリングより早く中断できる。
   */
  protected shouldInterrupt(): boolean {
    return this.bot.interruptExecution === true
      || (this._abortController?.signal.aborted ?? false);
  }

  /** runImpl 内で AbortSignal を参照するためのアクセサ */
  protected get abortSignal(): AbortSignal | undefined {
    return this._abortController?.signal;
  }

  abstract runImpl(
    ...args: any[]
  ): Promise<SkillResult>;
}
