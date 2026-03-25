import express, { Application } from 'express';
import { Server } from 'http';
import { createLogger } from '../../../utils/logger.js';
import { CONFIG } from '../config/MinebotConfig.js';

const log = createLogger('Minebot:HTTP');
import { EventReactionSystem } from '../eventReaction/EventReactionSystem.js';
import type { MinebotTaskRuntime } from '../runtime/MinebotTaskRuntime.js';
import { SkillLoader } from '../skills/SkillLoader.js';
import { CustomBot } from '../types.js';
import {
    ApiResponse,
    ConstantSkillSwitchRequest,
    HttpServerError,
    ThrowItemRequest,
} from '../types/index.js';

// 反応設定の更新リクエスト型
interface ReactionSettingUpdateRequest {
    eventType: string;
    enabled?: boolean;
    probability?: number;
}

// チャットメッセージリクエスト型
interface ChatMessageRequest {
    sender: string;
    message: string;
}

/**
 * MinebotHttpServer
 * Express APIサーバーの管理を担当
 */
export class MinebotHttpServer {
    private app: Application;
    private server: Server | null = null;
    private bot: CustomBot;
    private skillLoader: SkillLoader;
    private sendConstantSkillsCallback: () => Promise<void>;
    private sendReactionSettingsCallback: () => Promise<void>;
    private onChatMessageCallback: ((sender: string, message: string) => Promise<void>) | null = null;
    private eventReactionSystem: EventReactionSystem | null = null;
    private taskRuntime: MinebotTaskRuntime | null = null;

    constructor(
        bot: CustomBot,
        sendConstantSkillsCallback: () => Promise<void>,
        sendReactionSettingsCallback?: () => Promise<void>
    ) {
        this.bot = bot;
        this.skillLoader = new SkillLoader();
        this.sendConstantSkillsCallback = sendConstantSkillsCallback;
        this.sendReactionSettingsCallback = sendReactionSettingsCallback || (async () => { });
        this.app = express();
        this.setupMiddleware();
        this.registerEndpoints();
    }

    /**
     * チャットメッセージコールバックを設定
     */
    setOnChatMessageCallback(callback: (sender: string, message: string) => Promise<void>): void {
        this.onChatMessageCallback = callback;
    }

    /**
     * EventReactionSystemを設定
     */
    setEventReactionSystem(system: EventReactionSystem): void {
        this.eventReactionSystem = system;
    }

    setTaskRuntime(taskRuntime: MinebotTaskRuntime): void {
        this.taskRuntime = taskRuntime;
    }

    /**
     * ミドルウェアの設定
     */
    private setupMiddleware(): void {
        this.app.use(express.json());
    }

    /**
     * エンドポイントの登録
     */
    private registerEndpoints(): void {
        // アイテム投げ捨てエンドポイント
        this.app.post('/throw_item', async (req: any, res: any) => {
            try {
                const { itemName, count = 1 } = req.body as ThrowItemRequest;
                const dropItem = this.bot.instantSkills.getSkill('drop-item');
                if (!dropItem) {
                    const response: ApiResponse = { success: false, result: 'drop-item skill not found' };
                    return res.status(404).json(response);
                }

                // minecraft:oak_log -> oak_log の形式変換
                const cleanItemName = itemName.includes(':') ? itemName.split(':')[1] : itemName;
                const result = await dropItem.run(cleanItemName, count);

                log.info(`📦 アイテムドロップ: ${cleanItemName} → ${result.result}`);
                const response: ApiResponse = { success: result.success, result: result.result };
                res.status(200).json(response);
            } catch (error) {
                const httpError = new HttpServerError('/throw_item', 500, error as Error);
                log.error('/throw_item エラー', httpError);
                const response: ApiResponse = {
                    success: false,
                    result: httpError.message,
                    error: httpError.code
                };
                res.status(500).json(response);
            }
        });

        // コンスタントスキル切り替えエンドポイント
        this.app.post('/constant_skill_switch', async (req: any, res: any) => {
            try {
                const { skillName, status } = req.body as ConstantSkillSwitchRequest;
                const constantSkill = this.bot.constantSkills.getSkill(skillName);
                if (!constantSkill) {
                    return res
                        .status(404)
                        .json({ success: false, result: 'constant skill not found' });
                }

                constantSkill.status = status === 'true';

                // JSONファイルを更新
                const savedSkills = this.skillLoader.loadConstantSkillsState();

                // 既存のスキルを更新または新規追加
                const existingSkillIndex = savedSkills.findIndex(
                    (s) => s.skillName === skillName
                );
                if (existingSkillIndex !== -1) {
                    savedSkills[existingSkillIndex].status = constantSkill.status;
                } else {
                    savedSkills.push({
                        skillName: skillName,
                        status: constantSkill.status,
                    });
                }

                // JSONファイルに保存
                this.skillLoader.saveConstantSkillsState(
                    savedSkills.map(s => {
                        const skill = this.bot.constantSkills.getSkill(s.skillName);
                        return skill || ({ skillName: s.skillName, status: s.status } as any);
                    })
                );

                // auto-followスキルの特別処理
                if (skillName === 'auto-follow') {
                    if (constantSkill.status) {
                        const autoFollow = this.bot.constantSkills.getSkill('auto-follow');
                        if (autoFollow) {
                            const players = Object.values(this.bot.entities).filter(
                                (entity) =>
                                    entity.name === 'player' &&
                                    entity.username !== this.bot.username
                            );
                            const nearestPlayer = players.sort(
                                (a, b) =>
                                    a.position.distanceTo(this.bot.entity.position) -
                                    b.position.distanceTo(this.bot.entity.position)
                            )[0];
                            if (nearestPlayer) {
                                autoFollow.run(nearestPlayer.username);
                            }
                        }
                    } else {
                        const autoFollow = this.bot.constantSkills.getSkill('auto-follow');
                        if (autoFollow) {
                            autoFollow.status = false;
                        }
                    }
                }

                const response: ApiResponse = { success: true, result: 'constant skill status updated' };
                res.status(200).json(response);
            } catch (error) {
                const httpError = new HttpServerError('/constant_skill_switch', 500, error as Error);
                log.error('/constant_skill_switch エラー', httpError);
                const response: ApiResponse = {
                    success: false,
                    result: httpError.message,
                    error: httpError.code
                };
                res.status(500).json(response);
            } finally {
                await this.sendConstantSkillsCallback();
            }
        });

        // 反応設定更新エンドポイント
        this.app.post('/reaction_setting_update', async (req: any, res: any) => {
            try {
                const { eventType, enabled, probability } = req.body as ReactionSettingUpdateRequest;

                // EventReactionSystemで設定を更新
                if (this.eventReactionSystem) {
                    this.eventReactionSystem.updateConfig(eventType as any, {
                        enabled,
                        probability,
                    });
                    log.info(`📝 反応設定更新: ${eventType} → enabled=${enabled}, probability=${probability}`);
                }

                const response: ApiResponse = {
                    success: true,
                    result: `reaction setting for ${eventType} updated`,
                    data: { eventType, enabled, probability }
                };
                res.status(200).json(response);
            } catch (error) {
                const httpError = new HttpServerError('/reaction_setting_update', 500, error as Error);
                log.error('/reaction_setting_update エラー', httpError);
                const response: ApiResponse = {
                    success: false,
                    result: httpError.message,
                    error: httpError.code
                };
                res.status(500).json(response);
            } finally {
                await this.sendReactionSettingsCallback();
            }
        });

        // 反応設定リセットエンドポイント
        this.app.post('/reaction_settings_reset', async (req: any, res: any) => {
            try {
                // EventReactionSystemで設定をリセット
                if (this.eventReactionSystem) {
                    this.eventReactionSystem.resetConfigs();
                    log.info('📝 反応設定をリセットしました');
                }

                const response: ApiResponse = {
                    success: true,
                    result: 'reaction settings reset'
                };
                res.status(200).json(response);
            } catch (error) {
                const httpError = new HttpServerError('/reaction_settings_reset', 500, error as Error);
                log.error('/reaction_settings_reset エラー', httpError);
                const response: ApiResponse = {
                    success: false,
                    result: httpError.message,
                    error: httpError.code
                };
                res.status(500).json(response);
            } finally {
                await this.sendReactionSettingsCallback();
            }
        });

        // 反応設定取得エンドポイント（GET）
        this.app.get('/reaction_settings', async (req: any, res: any) => {
            try {
                // EventReactionSystemから設定を取得
                if (this.eventReactionSystem) {
                    const settings = this.eventReactionSystem.getSettingsState();
                    res.status(200).json({
                        reactions: settings.reactions,
                        constantSkills: [], // 常時スキルは常時スキルタブで管理
                    });
                } else {
                    // EventReactionSystemがまだ設定されていない場合はデフォルト設定
                    const reactions = [
                        { eventType: 'player_facing', enabled: true, probability: 30, idleOnly: true, reactionType: 'task' },
                        { eventType: 'player_speak', enabled: true, probability: 100, idleOnly: false, reactionType: 'task' },
                        { eventType: 'hostile_approach', enabled: true, probability: 100, idleOnly: false, reactionType: 'task' },
                        { eventType: 'item_obtained', enabled: true, probability: 30, idleOnly: true, reactionType: 'task' },
                        { eventType: 'time_change', enabled: true, probability: 30, idleOnly: false, reactionType: 'task' },
                        { eventType: 'weather_change', enabled: true, probability: 30, idleOnly: false, reactionType: 'task' },
                        { eventType: 'biome_change', enabled: true, probability: 50, idleOnly: false, reactionType: 'task' },
                        { eventType: 'teleported', enabled: true, probability: 100, idleOnly: false, reactionType: 'task' },
                        { eventType: 'damage', enabled: true, probability: 100, idleOnly: false, reactionType: 'task' },
                        { eventType: 'suffocation', enabled: true, probability: 100, idleOnly: false, reactionType: 'emergency' },
                    ];
                    res.status(200).json({
                        reactions,
                        constantSkills: [],
                    });
                }
            } catch (error) {
                const httpError = new HttpServerError('/reaction_settings', 500, error as Error);
                log.error('/reaction_settings エラー', httpError);
                res.status(500).json({
                    success: false,
                    result: httpError.message,
                });
            }
        });

        // チャットメッセージエンドポイント
        this.app.post('/chat_message', async (req: any, res: any) => {
            try {
                const { sender, message } = req.body as ChatMessageRequest;
                log.info(`💬 Chat from ${sender}: ${message}`);

                if (this.onChatMessageCallback) {
                    await this.onChatMessageCallback(sender, message);
                }

                const response: ApiResponse = {
                    success: true,
                    result: 'Message received'
                };
                res.status(200).json(response);
            } catch (error) {
                const httpError = new HttpServerError('/chat_message', 500, error as Error);
                log.error('/chat_message エラー', httpError);
                res.status(500).json({
                    success: false,
                    result: httpError.message,
                });
            }
        });

        // タスクリスト取得エンドポイント
        this.app.get('/task_list', async (req: any, res: any) => {
            try {
                if (!this.taskRuntime) {
                    return res.status(200).json({ tasks: [], emergencyTask: null, currentTaskId: null });
                }
                const taskListState = this.taskRuntime.getTaskListState();
                res.status(200).json(taskListState);
            } catch (error) {
                const httpError = new HttpServerError('/task_list', 500, error as Error);
                log.error('/task_list エラー', httpError);
                res.status(500).json({ success: false, result: httpError.message });
            }
        });

        // タスク削除エンドポイント
        this.app.post('/task_delete', async (req: any, res: any) => {
            try {
                const { taskId } = req.body;
                if (!taskId) {
                    return res.status(400).json({ success: false, result: 'taskId is required' });
                }

                if (!this.taskRuntime) {
                    return res.status(400).json({ success: false, result: 'Task runtime not initialized' });
                }

                const queueIds = this.taskRuntime.getTaskListState().tasks.map((t: any) => t.id);
                const emergencyId = this.taskRuntime.getTaskListState().emergencyTask?.id;
                log.info(`/task_delete taskId=${taskId}, queueIds=[${queueIds.join(',')}], emergencyId=${emergencyId ?? 'none'}`);

                const result = this.taskRuntime.removeTask(taskId);
                log.info(`/task_delete result: ${JSON.stringify(result)}`);
                res.status(200).json(result);
            } catch (error) {
                const httpError = new HttpServerError('/task_delete', 500, error as Error);
                log.error('/task_delete エラー', httpError);
                res.status(500).json({ success: false, result: httpError.message });
            }
        });

        // タスク優先実行エンドポイント
        this.app.post('/task_prioritize', async (req: any, res: any) => {
            try {
                const { taskId } = req.body;
                if (!taskId) {
                    return res.status(400).json({ success: false, result: 'taskId is required' });
                }

                if (!this.taskRuntime) {
                    return res.status(400).json({ success: false, result: 'Task runtime not initialized' });
                }

                const result = this.taskRuntime.prioritizeTask(taskId);
                res.status(200).json(result);
            } catch (error) {
                const httpError = new HttpServerError('/task_prioritize', 500, error as Error);
                log.error('/task_prioritize エラー', httpError);
                res.status(500).json({ success: false, result: httpError.message });
            }
        });

        // voice_mode 切り替え（Minecraft側から）
        this.app.post('/voice_mode', async (_req: any, res: any) => {
            try {
                log.info('🎙️ /voice_mode リクエスト受信', 'magenta');
                const { DiscordBot } = await import('../../discord/client.js');
                const result = DiscordBot.getInstance().toggleVoiceMode();
                if (!result) {
                    log.warn('🎙️ /voice_mode: ボイスチャンネル未接続のため切り替え不可');
                    res.status(200).json({ success: false, result: 'ボイスチャンネル未接続' });
                    return;
                }
                const label = result.mode === 'minebot' ? 'Minebot' : 'Chat';
                log.info(`🎙️ Voice mode toggled to ${label} from Minecraft`, 'magenta');
                res.status(200).json({ success: true, result: label, mode: result.mode });
            } catch (error) {
                const httpError = new HttpServerError('/voice_mode', 500, error as Error);
                log.error('/voice_mode エラー', httpError);
                res.status(500).json({ success: false, result: httpError.message });
            }
        });

        // PTT（Minecraft側から、押してる間ON/離したらOFF）
        this.app.post('/voice_ptt', async (req: any, res: any) => {
            try {
                const { mcUsername, action } = req.body as { mcUsername?: string; action?: 'on' | 'off' };
                log.info(`🎙️ /voice_ptt リクエスト受信: mcUsername=${mcUsername ?? '(empty)'}, action=${action ?? '(empty)'}`, 'magenta');
                if (!mcUsername) {
                    res.status(400).json({ success: false, result: 'mcUsername required' });
                    return;
                }
                const discordNames = CONFIG.resolveDiscordNames(mcUsername);
                if (discordNames.length === 0) {
                    discordNames.push(mcUsername);
                }
                const { DiscordBot } = await import('../../discord/client.js');
                const result = DiscordBot.getInstance().remotePttSet(discordNames, action === 'on');
                if (!result) {
                    log.warn(`🎙️ /voice_ptt: ボイスチャンネル未接続 or ユーザー不明 (discordNames=[${discordNames.join(', ')}])`);
                    res.status(200).json({ success: false, result: 'ボイスチャンネル未接続 or ユーザー不明' });
                    return;
                }
                if (result.blocked) {
                    log.info(`🎙️ Remote PTT blocked: ${mcUsername} (${result.blockedBy} が通話中)`, 'yellow');
                    res.status(200).json({
                        success: false,
                        blocked: true,
                        blockedBy: result.blockedBy,
                        result: `${result.blockedBy} が通話中のため待機してください`,
                    });
                    return;
                }
                log.info(`🎙️ Remote PTT ${result.active ? 'ON' : 'OFF'}: ${result.userName}`, result.active ? 'cyan' : 'yellow');
                res.status(200).json({ success: true, active: result.active, userName: result.userName });
            } catch (error) {
                const httpError = new HttpServerError('/voice_ptt', 500, error as Error);
                log.error('/voice_ptt エラー', httpError);
                res.status(500).json({ success: false, result: httpError.message });
            }
        });

        log.success('✅ API endpoints registered');
    }

    /**
     * サーバーを起動
     */
    start(): void {
        if (this.server) {
            log.warn('⚠️ Server is already running');
            return;
        }

        this.server = this.app.listen(CONFIG.MINEBOT_API_PORT, () => {
            log.success(`✅ Express server listening on port ${CONFIG.MINEBOT_API_PORT}`);
        });
    }

    /**
     * サーバーを停止
     */
    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server) {
                resolve();
                return;
            }

            this.server.close(() => {
                log.info('Express server closed');
                this.server = null;
                resolve();
            });
        });
    }

    /**
     * サーバーインスタンスを取得
     */
    getServer(): Server | null {
        return this.server;
    }
}

