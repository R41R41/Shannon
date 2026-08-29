import { createLogger } from '../../../utils/logger.js';
import { logToWeb } from '../../runtime/logging.js';
import {
  registerMinebotSkillHandler,
  unregisterMinebotSkillHandler,
} from '../../runtime/minebotSkillGateway.js';
import { ConstantSkills, CustomBot, InstantSkill, InstantSkills } from '../types.js';
import { SkillLoader } from './SkillLoader.js';

const log = createLogger('Minebot:SkillRegistrar');

let skillRegistrarInstance: SkillRegistrar | null = null;

export function getSkillRegistrar(): SkillRegistrar {
  if (!skillRegistrarInstance) {
    skillRegistrarInstance = new SkillRegistrar();
  }
  return skillRegistrarInstance;
}

/**
 * SkillRegistrar
 * スキル登録と ConstantSkill 定期実行を担当
 */
export class SkillRegistrar {
  private skillLoader: SkillLoader;

  /** skillName → taskPer* リスナ（差し替え時に removeListener する） */
  private constantSkillIntervalRefs = new Map<
    string,
    { eventName: string; listener: (...args: unknown[]) => void }
  >();

  constructor() {
    this.skillLoader = new SkillLoader();
  }

  /**
   * ConstantSkill の定期タスク用リスナを登録。同名があれば先に取り外す。
   * リスナ内は常に constantSkills.getSkill(skillName) で最新インスタンスを参照する。
   */
  attachConstantSkillInterval(
    bot: CustomBot,
    constantSkills: ConstantSkills,
    skillName: string,
    intervalMs: number | null | undefined,
  ): void {
    this.detachConstantSkillInterval(bot, skillName);
    if (!intervalMs || intervalMs <= 0) {
      return;
    }

    const eventName = `taskPer${intervalMs}ms`;
    const listener = (): void => {
      void (async () => {
        const skill = constantSkills.getSkill(skillName);
        if (!skill || !skill.status || skill.isLocked) return;
        try {
          await constantSkills.requestExecution(skill, []);
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          void logToWeb('minecraft', 'red', `${skillName} error: ${msg}`);
        }
      })();
    };

    bot.on(eventName as any, listener);
    this.constantSkillIntervalRefs.set(skillName, { eventName, listener });
    log.info(`⏱️ ConstantSkill interval 登録: ${skillName} → ${eventName}`);
  }

  detachConstantSkillInterval(bot: CustomBot, skillName: string): void {
    const ref = this.constantSkillIntervalRefs.get(skillName);
    if (!ref) return;
    bot.removeListener(ref.eventName as any, ref.listener as any);
    this.constantSkillIntervalRefs.delete(skillName);
    log.info(`⏱️ ConstantSkill interval 解除: ${skillName} (${ref.eventName})`);
  }

  private registerInstantSkillHandler(skill: InstantSkill): void {
    unregisterMinebotSkillHandler(skill.skillName);
    registerMinebotSkillHandler(skill.skillName, async (parameters) => {
      try {
        skill.status = true;
        const response = await skill.run(...parameters);
        skill.status = false;
        return response;
      } catch (error: unknown) {
        skill.status = false;
        return {
          success: false,
          result: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  /**
   * InstantSkills を skill gateway に登録
   */
  registerInstantSkills(instantSkills: InstantSkills): void {
    log.info('📝 Registering instant skills...');

    instantSkills.getSkills().forEach((skill) => {
      this.registerInstantSkillHandler(skill);
    });

    log.success(`✅ Registered ${instantSkills.getSkills().length} instant skills`);
  }

  /**
   * ConstantSkills を登録し、定期実行を設定
   */
  registerConstantSkills(bot: CustomBot, constantSkills: ConstantSkills): void {
    log.info('📝 Registering constant skills...');

    const savedSkills = this.skillLoader.loadConstantSkillsState();

    constantSkills.getSkills().forEach((skill) => {
      const savedSkill = savedSkills.find((s) => s.skillName === skill.skillName);
      if (savedSkill) {
        skill.status = savedSkill.status;
      }

      this.attachConstantSkillInterval(
        bot,
        constantSkills,
        skill.skillName,
        skill.interval,
      );
    });

    log.success(`✅ Registered ${constantSkills.getSkills().length} constant skills`);
  }

  /**
   * 単一 InstantSkill を gateway に登録（ホットリロード用）
   */
  registerSingleInstantSkill(skill: InstantSkill): void {
    this.registerInstantSkillHandler(skill);
    log.info(`✅ Hot-registered instant skill: ${skill.skillName}`);
  }

  /**
   * 単一 ConstantSkill を定期実行ハンドラーに登録（ホットリロード用）
   */
  registerSingleConstantSkill(bot: CustomBot, constantSkills: ConstantSkills, skill: import('../types.js').ConstantSkill): void {
    this.attachConstantSkillInterval(
      bot,
      constantSkills,
      skill.skillName,
      skill.interval,
    );
    log.info(`✅ Hot-registered constant skill: ${skill.skillName}`);
  }
}
