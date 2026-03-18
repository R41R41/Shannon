/**
 * EventReactionSystem
 * イベント反応を管理するシステム — ハンドラーの統括・タイマー管理
 */

import { CustomBot } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { MinebotTaskRuntime } from '../runtime/MinebotTaskRuntime.js';
import { EnvironmentEventHandler } from './handlers/EnvironmentEventHandler.js';
import { CombatEventHandler } from './handlers/CombatEventHandler.js';
import { PlayerEventHandler } from './handlers/PlayerEventHandler.js';
import { StatusEventHandler } from './handlers/StatusEventHandler.js';
import {
    DamageEventData,
    DEFAULT_REACTION_CONFIGS,
    EventData,
    EventReactionConfig,
    EventReactionResult,
    EventType,
    ItemEventData,
    ReactionSettingsState,
    SuffocationEventData,
} from './types.js';

const log = createLogger('Minebot:EventReaction');

export class EventReactionSystem {
    private bot: CustomBot;
    private taskRuntime: MinebotTaskRuntime;
    private configs: Map<EventType, EventReactionConfig>;

    // ハンドラー
    private environment: EnvironmentEventHandler;
    private combat: CombatEventHandler;
    private player: PlayerEventHandler;
    private status: StatusEventHandler;

    // インターバルID
    private environmentCheckInterval: NodeJS.Timeout | null = null;
    private hostileCheckInterval: NodeJS.Timeout | null = null;

    constructor(bot: CustomBot, taskRuntime: MinebotTaskRuntime) {
        this.bot = bot;
        this.taskRuntime = taskRuntime;
        this.configs = new Map();

        // デフォルト設定を読み込み
        DEFAULT_REACTION_CONFIGS.forEach(config => {
            this.configs.set(config.eventType, { ...config });
        });

        // ハンドラーを初期化
        this.environment = new EnvironmentEventHandler(bot);
        this.combat = new CombatEventHandler(bot);
        this.player = new PlayerEventHandler(bot);
        this.status = new StatusEventHandler(bot);
    }

    /**
     * 初期化
     */
    async initialize(): Promise<void> {
        if (this.bot.entity) {
            this.updateInitialState();
            this.startEnvironmentCheck();
            this.startHostileCheck();
        } else {
            this.bot.once('spawn', () => {
                this.updateInitialState();
                this.startEnvironmentCheck();
                this.startHostileCheck();
                log.success('✅ EventReactionSystem started after spawn');
            });
        }

        log.success('✅ EventReactionSystem initialized');
    }

    /**
     * 初期状態を記録
     */
    private updateInitialState(): void {
        if (!this.bot.entity) {
            log.warn('⚠️ bot.entity not available yet');
            return;
        }

        this.environment.updateInitialState();
        this.status.updateInventorySnapshot();
    }

    /**
     * ボットがidle状態かどうか
     */
    private isIdle(): boolean {
        return !this.taskRuntime.isRunning() && !this.bot.executingSkill;
    }

    /**
     * 確率チェック
     */
    private checkProbability(probability: number): boolean {
        return Math.random() * 100 < probability;
    }

    /**
     * 設定を取得
     */
    getConfig(eventType: EventType): EventReactionConfig | undefined {
        return this.configs.get(eventType);
    }

    /**
     * 設定を更新
     */
    updateConfig(eventType: EventType, updates: Partial<EventReactionConfig>): void {
        const config = this.configs.get(eventType);
        if (config) {
            Object.assign(config, updates);
        }
    }

    /**
     * 全設定をリセット
     */
    resetConfigs(): void {
        DEFAULT_REACTION_CONFIGS.forEach(config => {
            this.configs.set(config.eventType, { ...config });
        });
    }

    /**
     * 設定状態を取得（UI用）
     */
    getSettingsState(): ReactionSettingsState {
        const reactions = Array.from(this.configs.values());
        const constantSkills = this.bot.constantSkills.getSkills().map(skill => ({
            skillName: skill.skillName,
            enabled: skill.status,
            description: skill.description,
        }));
        return { reactions, constantSkills };
    }

    /**
     * 環境チェックを開始
     */
    private startEnvironmentCheck(): void {
        this.environmentCheckInterval = setInterval(() => {
            this.pollEnvironment();
            this.pollStatus();
        }, 1000); // 1秒ごと
    }

    /**
     * 敵対Mobチェックを開始
     */
    private startHostileCheck(): void {
        this.hostileCheckInterval = setInterval(() => {
            this.pollHostile();
        }, 500); // 0.5秒ごと
    }

    // ── ポーリング（ハンドラーからイベントを取得し handleEvent へ渡す） ──

    private async pollEnvironment(): Promise<void> {
        const timeEvent = this.environment.checkTimeChange();
        if (timeEvent) await this.handleEvent(timeEvent);

        const weatherEvent = this.environment.checkWeatherChange();
        if (weatherEvent) await this.handleEvent(weatherEvent);

        const biomeEvent = this.environment.checkBiomeChange();
        if (biomeEvent) await this.handleEvent(biomeEvent);

        const teleportEvent = this.environment.checkTeleport();
        if (teleportEvent) await this.handleEvent(teleportEvent);
    }

    private async pollStatus(): Promise<void> {
        const itemEvents = this.status.checkInventoryChange();
        for (const ev of itemEvents) {
            await this.handleEvent(ev);
        }
    }

    private async pollHostile(): Promise<void> {
        const hostileEvent = this.combat.checkHostileApproach();
        if (hostileEvent) await this.handleEvent(hostileEvent);
    }

    // ── 外部から呼び出される公開メソッド ──

    /**
     * プレイヤーがボットの方を向いているかチェック
     */
    checkPlayerFacing(playerEntity: any): boolean {
        return this.player.checkPlayerFacing(playerEntity);
    }

    /**
     * プレイヤー接近イベントを処理（外部から呼び出し）
     */
    async handlePlayerFacing(playerEntity: any): Promise<void> {
        const eventData = this.player.buildPlayerFacingEvent(playerEntity);
        if (eventData) {
            await this.handleEvent(eventData);
        }
    }

    /**
     * プレイヤー発言イベントを処理（外部から呼び出し）
     */
    async handlePlayerSpeak(playerName: string, message: string, playerEntity?: any): Promise<void> {
        const eventData = this.player.buildPlayerSpeakEvent(playerName, message, playerEntity);
        await this.handleEvent(eventData);
    }

    /**
     * ダメージイベントを処理（外部から呼び出し）
     */
    async handleDamage(data: {
        damage: number;
        damagePercent: number;
        currentHealth: number;
        consecutiveCount: number;
    }): Promise<void> {
        const eventData: DamageEventData = {
            timestamp: Date.now(),
            eventType: 'damage',
            ...data,
        };
        await this.handleEvent(eventData);
    }

    /**
     * 窒息イベントを処理（外部から呼び出し）
     */
    async handleSuffocation(data: {
        oxygen: number;
        health: number;
        isInWater: boolean;
    }): Promise<void> {
        const eventData: SuffocationEventData = {
            timestamp: Date.now(),
            eventType: 'suffocation',
            ...data,
        };
        await this.handleEvent(eventData);
    }

    // ── イベントディスパッチ ──

    /**
     * イベントを処理
     */
    private async handleEvent(eventData: EventData): Promise<EventReactionResult> {
        const config = this.configs.get(eventData.eventType);

        if (!config || !config.enabled) {
            return { handled: false, reactionType: 'info' };
        }

        // idle時のみの設定でbusy状態ならスキップ
        if (config.idleOnly && !this.isIdle()) {
            // ただし、ダメージイベントは緊急対応
            if (eventData.eventType === 'damage') {
                return this.handleEmergencyEvent(eventData as DamageEventData);
            }

            // アイテム取得はinfo更新のみ
            if (eventData.eventType === 'item_obtained') {
                log.info(`📦 アイテム取得: +${(eventData as ItemEventData).count} ${(eventData as ItemEventData).itemName}`);
                return { handled: true, reactionType: 'info' };
            }

            return { handled: false, reactionType: 'info' };
        }

        // 確率チェック
        if (!this.checkProbability(config.probability)) {
            return { handled: false, reactionType: 'info' };
        }

        // 反応タイプに応じて処理
        switch (config.reactionType) {
            case 'emergency':
                return this.handleEmergencyEvent(eventData);
            case 'task':
                return this.handleTaskEvent(eventData);
            case 'immediate':
                return this.handleImmediateEvent(eventData);
            case 'info':
            default:
                // アイテム取得の特別処理
                if (eventData.eventType === 'item_obtained') {
                    const itemData = eventData as ItemEventData;
                    log.info(`📦 アイテム取得: +${itemData.count} ${itemData.itemName}`);

                    // プレイヤーからもらった場合は使い道を聞く（タスクとして処理）
                    if (itemData.nearbyPlayers && itemData.nearbyPlayers.length > 0) {
                        return this.handleTaskEvent(eventData);
                    }
                }
                return { handled: true, reactionType: 'info' };
        }
    }

    /**
     * 緊急イベントを処理
     */
    private async handleEmergencyEvent(eventData: EventData): Promise<EventReactionResult> {
        if (!this.taskRuntime.isReady()) {
            log.warn('⚠️ MinebotTaskRuntime が未接続です');
            return { handled: false, reactionType: 'emergency' };
        }

        if (this.bot.executingSkill) {
            log.warn('⚠️ InstantSkill実行中だが、緊急対応を優先して割り込みます');
        }

        if (this.taskRuntime.isInEmergencyMode()) {
            log.warn('⚠️ 緊急タスク処理中のため新しい緊急イベントをスキップ');
            return { handled: false, reactionType: 'emergency' };
        }

        const message = this.buildEmergencyMessage(eventData);
        log.error(`🚨 緊急対応: ${message}`);

        try {
            // 1. 即座の反射的逃走（LLM を待たずに物理行動）
            this.executeReflexiveFlee();

            // 2. 実行中タスクを中断し、isExecuting 解除を待つ
            await this.taskRuntime.interruptForEmergency(message);

            const emergencyTaskInput = {
                userMessage: message,
                isEmergency: true,
                emergencyType: eventData.eventType,
            };
            this.taskRuntime.setEmergencyTask(emergencyTaskInput);

            // 3. LLM ベースの緊急タスクを実行
            await this.taskRuntime.invoke(emergencyTaskInput);

            // 4. 緊急タスク完了後、中断された元タスクを再開
            await this.taskRuntime.resumePreviousTask();

            return { handled: true, reactionType: 'emergency', message };
        } catch (error) {
            log.error('緊急対応エラー', error);
            return { handled: false, reactionType: 'emergency', message };
        }
    }

    /**
     * タスクイベントを処理
     */
    private async handleTaskEvent(eventData: EventData): Promise<EventReactionResult> {
        if (!this.taskRuntime.isReady()) {
            return { handled: false, reactionType: 'task' };
        }

        const message = this.buildTaskMessage(eventData);
        log.info(`📋 タスク生成: ${message}`);

        try {
            const result = this.taskRuntime.addTaskToQueue({
                userMessage: message,
                isEmergency: false,
            });

            if (!result.success) {
                log.warn(`⚠️ タスク追加失敗: ${result.reason}`);
                return { handled: false, reactionType: 'task', message };
            }

            return { handled: true, reactionType: 'task', message };
        } catch (error) {
            log.error('タスク生成エラー', error);
            return { handled: false, reactionType: 'task', message };
        }
    }

    /**
     * 即時イベントを処理（常時スキルが担当）
     */
    private async handleImmediateEvent(_eventData: EventData): Promise<EventReactionResult> {
        return { handled: true, reactionType: 'immediate' };
    }

    // ── メッセージ構築（ハンドラーに委譲） ──

    private buildEmergencyMessage(eventData: EventData): string {
        return CombatEventHandler.buildEmergencyMessage(eventData)
            || '緊急事態が発生した';
    }

    private buildTaskMessage(eventData: EventData): string {
        return PlayerEventHandler.buildTaskMessage(eventData)
            || CombatEventHandler.buildTaskMessage(eventData)
            || StatusEventHandler.buildTaskMessage(eventData)
            || EnvironmentEventHandler.buildTaskMessage(eventData)
            || 'イベントが発生した';
    }

    /**
     * 反射的逃走 — LLM を待たず即座に敵から離れる物理行動。
     * 脊髄反射に相当し、生存確率を大幅に上げる。
     */
    private executeReflexiveFlee(): void {
        try {
            if (!this.bot.entity) return;

            // 進行中のアクションを停止
            this.bot.clearControlStates();
            const pathfinder = (this.bot as any).pathfinder;
            pathfinder?.setGoal?.(null);
            pathfinder?.stop?.();

            // 最も近い敵対 Mob を見つける
            const botPos = this.bot.entity.position;
            let nearestHostile: { position: { x: number; y: number; z: number }; distance: number } | null = null;

            for (const entity of Object.values(this.bot.entities)) {
                if (entity.id === this.bot.entity.id) continue;
                const mobName = String((entity as any).name || '').toLowerCase();
                const isHostile = ['zombie', 'skeleton', 'creeper', 'spider', 'drowned', 'husk',
                    'stray', 'witch', 'phantom', 'pillager', 'vindicator', 'warden'].some(h => mobName.includes(h));
                if (!isHostile) continue;

                const dist = botPos.distanceTo(entity.position);
                if (dist < 16 && (!nearestHostile || dist < nearestHostile.distance)) {
                    nearestHostile = { position: entity.position, distance: dist };
                }
            }

            if (nearestHostile) {
                // 敵の反対方向を向いてスプリントジャンプで逃走
                const dx = botPos.x - nearestHostile.position.x;
                const dz = botPos.z - nearestHostile.position.z;
                const len = Math.sqrt(dx * dx + dz * dz) || 1;
                const fleeYaw = Math.atan2(-dx / len, -dz / len);

                this.bot.look(fleeYaw, 0, true);
                this.bot.setControlState('forward', true);
                this.bot.setControlState('sprint', true);
                this.bot.setControlState('jump', true);

                log.warn(`⚡ 反射的逃走: 敵(${nearestHostile.distance.toFixed(1)}m)から離脱中`);

                // 2秒後に制御状態をクリア（LLM タスクに制御を渡す）
                setTimeout(() => {
                    try {
                        this.bot.clearControlStates();
                    } catch { /* bot might be dead */ }
                }, 2000);
            } else {
                // 敵が見つからない場合もジャンプして離脱を試みる
                this.bot.setControlState('jump', true);
                this.bot.setControlState('forward', true);
                this.bot.setControlState('sprint', true);
                log.warn('⚡ 反射的逃走: 敵不明、前方にスプリント');
                setTimeout(() => {
                    try {
                        this.bot.clearControlStates();
                    } catch { /* ignore */ }
                }, 1500);
            }
        } catch (error) {
            log.error('反射的逃走エラー（無視して緊急タスクを続行）', error);
        }
    }

    /**
     * クリーンアップ
     */
    destroy(): void {
        if (this.environmentCheckInterval) {
            clearInterval(this.environmentCheckInterval);
            this.environmentCheckInterval = null;
        }
        if (this.hostileCheckInterval) {
            clearInterval(this.hostileCheckInterval);
            this.hostileCheckInterval = null;
        }
    }
}
