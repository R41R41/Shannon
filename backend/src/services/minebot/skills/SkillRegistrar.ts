import { MinebotSkillInput } from '@shannon/common';
import { EventBus } from '../../eventBus/eventBus.js';
import { createLogger } from '../../../utils/logger.js';
import { ConstantSkills, CustomBot, InstantSkills } from '../types.js';
import { SkillLoader } from './SkillLoader.js';

const log = createLogger('Minebot:SkillRegistrar');

/** 同一 EventBus に対して 1 つの SkillRegistrar（ホットロードで taskPer リスナを正しく remove するため） */
const skillRegistrarByEventBus = new WeakMap<EventBus, SkillRegistrar>();

export function getSkillRegistrar(eventBus: EventBus): SkillRegistrar {
    let r = skillRegistrarByEventBus.get(eventBus);
    if (!r) {
        r = new SkillRegistrar(eventBus);
        skillRegistrarByEventBus.set(eventBus, r);
    }
    return r;
}

/**
 * SkillRegistrar
 * スキルとEventBusの紐付けを担当
 */
export class SkillRegistrar {
    private eventBus: EventBus;
    private skillLoader: SkillLoader;

    /** skillName → taskPer* リスナ（差し替え時に removeListener する） */
    private constantSkillIntervalRefs = new Map<
        string,
        { eventName: string; listener: (...args: unknown[]) => void }
    >();

    constructor(eventBus: EventBus) {
        this.eventBus = eventBus;
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
                    if (skill.isCritical) {
                        await skill.run();
                    } else {
                        await constantSkills.requestExecution(skill, []);
                    }
                } catch (error: unknown) {
                    const msg = error instanceof Error ? error.message : String(error);
                    this.eventBus.log('minecraft', 'red', `${skillName} error: ${msg}`);
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

    /**
     * InstantSkillsをEventBusに登録
     */
    registerInstantSkills(instantSkills: InstantSkills): void {
        log.info('📝 Registering instant skills to EventBus...');

        instantSkills.getSkills().forEach((skill) => {

            this.eventBus.subscribe(`minebot:${skill.skillName}`, async (event) => {
                try {
                    const data = event.data as any;
                    const parameters: unknown[] = Array.isArray(data?.skillParameters)
                        ? data.skillParameters
                        : Array.isArray(data) ? data : [];
                    skill.status = true;
                    const response = await skill.run(...parameters);
                    skill.status = false;

                    this.eventBus.publish({
                        type: `minebot:${skill.skillName}Result`,
                        memoryZone: 'minecraft',
                        data: response,
                    });
                } catch (error: any) {
                    this.eventBus.publish({
                        type: `minebot:${skill.skillName}Result`,
                        memoryZone: 'minecraft',
                        data: {
                            success: false,
                            result: error?.message ?? String(error),
                        },
                    });
                }
            });
        });

        log.success(`✅ Registered ${instantSkills.getSkills().length} instant skills`);
    }

    /**
     * ConstantSkillsをEventBusに登録し、定期実行を設定
     */
    registerConstantSkills(bot: CustomBot, constantSkills: ConstantSkills): void {
        log.info('📝 Registering constant skills...');

        // JSONファイルから保存された状態を読み込む
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
     * 単一 InstantSkill を EventBus に登録（ホットリロード用）
     */
    registerSingleInstantSkill(skill: import('../types.js').InstantSkill): void {
        this.eventBus.subscribe(`minebot:${skill.skillName}`, async (event) => {
            try {
                const data = event.data as any;
                const parameters: unknown[] = Array.isArray(data?.skillParameters)
                    ? data.skillParameters
                    : Array.isArray(data) ? data : [];
                skill.status = true;
                const response = await skill.run(...parameters);
                skill.status = false;

                this.eventBus.publish({
                    type: `minebot:${skill.skillName}Result`,
                    memoryZone: 'minecraft',
                    data: response,
                });
            } catch (error: any) {
                this.eventBus.publish({
                    type: `minebot:${skill.skillName}Result`,
                    memoryZone: 'minecraft',
                    data: {
                        success: false,
                        result: error?.message ?? String(error),
                    },
                });
            }
        });
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

    /**
     * EventBus経由のスキル制御イベントを登録
     */
    registerSkillControlEvents(bot: CustomBot): void {
        log.info('📝 Registering skill control events...');

        // スキル停止イベント
        this.eventBus.subscribe('minebot:stopInstantSkill', async (event) => {
            try {
                const { skillName } = event.data as MinebotSkillInput;
                if (!skillName) {
                    return;
                }
                const instantSkill = bot.instantSkills.getSkill(skillName);
                if (!instantSkill) {
                    bot.chat(`${skillName}は存在しません`);
                    return;
                }
                instantSkill.status = false;
                this.eventBus.publish({
                    type: `minebot:skillResult`,
                    memoryZone: 'minecraft',
                    data: {
                        skillName: skillName,
                        success: true,
                        result: `${skillName} stopped`,
                    },
                });
            } catch (error) {
                const { skillName } = event.data as MinebotSkillInput;
                this.eventBus.publish({
                    type: `minebot:skillResult`,
                    memoryZone: 'minecraft',
                    data: {
                        skillName: skillName,
                        success: false,
                        result: `error: ${error}`,
                    },
                });
            }
        });

        // スキル一覧取得イベント
        this.eventBus.subscribe('minebot:getInstantSkills', async (event) => {
            try {
                const formattedResponse = bot.instantSkills
                    .getSkills()
                    .map((skill) => {
                        const description = skill.description;
                        return `skillName: ${skill.skillName}, description: ${description}`;
                    })
                    .join('\n');
                this.eventBus.publish({
                    type: `minebot:skillResult`,
                    memoryZone: 'minecraft',
                    data: {
                        success: true,
                        result: formattedResponse,
                    },
                });
            } catch (error) {
                this.eventBus.publish({
                    type: `minebot:skillResult`,
                    memoryZone: 'minecraft',
                    data: {
                        success: false,
                        result: `error: ${error}`,
                    },
                });
            }
        });

        log.success('✅ Skill control events registered');
    }
}

