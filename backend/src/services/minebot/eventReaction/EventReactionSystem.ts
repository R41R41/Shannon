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
    HostileEventData,
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

    /** 継続逃走の制御 — LLM が制御を取るまで敵から逃げ続ける */
    private fleeInterval: NodeJS.Timeout | null = null;
    /** LLM タスクが最初の tool call を実行したら true → 逃走停止 */
    private _llmHasControl = false;

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
     * LLM タスクが制御を取ったことを通知する。
     * MinebotTaskRuntime の onToolStarting から呼ばれ、継続逃走を停止する。
     */
    public notifyLLMHasControl(): void {
        this._llmHasControl = true;
        this.stopContinuousFlee();
    }

    /**
     * イベントを処理
     */
    private async handleEvent(eventData: EventData): Promise<EventReactionResult> {
        const config = this.configs.get(eventData.eventType);

        if (!config || !config.enabled) {
            return { handled: false, reactionType: 'info' };
        }

        // hostile_approach は脅威レベルで反応を動的に決定
        if (eventData.eventType === 'hostile_approach') {
            return this.handleHostileApproach(eventData as HostileEventData);
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
     * hostile_approach を脅威レベルで段階的に処理する。
     *
     *   critical → emergency（タスク中断 + 反射的逃走 + LLM 緊急タスク）— 確率チェック適用
     *   warning  → task（タスクキューに追加、実行中タスクは中断しない）— 確率チェック適用
     *   notice   → info（ログのみ）— 確率チェック適用
     *
     * emergency 中に新たな hostile_approach(critical) が来た場合:
     *   → LLM タスクはそのまま（二重起動しない）だが、逃走方向を再計算する
     */
    private async handleHostileApproach(eventData: HostileEventData): Promise<EventReactionResult> {
        const { threatLevel, allHostiles } = eventData;
        const config = this.configs.get('hostile_approach');
        const probability = config?.probability ?? 100;

        if (threatLevel === 'notice') {
            if (!this.checkProbability(probability)) {
                return { handled: false, reactionType: 'info' };
            }
            log.debug(`👀 敵対Mob検知 (notice): ${allHostiles.map(h => `${h.mobType}(${h.distance}m)`).join(', ')}`);
            return { handled: true, reactionType: 'info' };
        }

        if (threatLevel === 'warning') {
            if (!this.checkProbability(probability)) {
                return { handled: false, reactionType: 'info' };
            }
            const message = CombatEventHandler.buildTaskMessage(eventData) ?? '敵対Mobが接近中';
            log.info(`⚠️ 敵対Mob警戒 (warning): ${message}`);

            // idle ならタスク生成、busy ならログのみ
            if (this.isIdle()) {
                return this.handleTaskEvent(eventData);
            }
            return { handled: true, reactionType: 'info', message };
        }

        // critical — emergency 処理
        if (!this.checkProbability(probability)) {
            return { handled: false, reactionType: 'info' };
        }
        if (this.taskRuntime.isInEmergencyMode()) {
            // 既に emergency 中 → LLM タスクは二重起動しないが、逃走方向を即座に更新
            log.warn(`🚨 Emergency中に新たな脅威: ${allHostiles.map(h => `${h.mobType}(${h.distance}m)`).join(', ')} → 逃走方向を更新`);
            this.updateFleeDirection();
            return { handled: true, reactionType: 'emergency' };
        }

        return this.handleEmergencyEvent(eventData);
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
            // 1. 継続型の反射的逃走を開始（LLM が制御を取るまで逃げ続ける）
            this._llmHasControl = false;
            this.startContinuousFlee();

            // 2. 実行中タスクを中断し、isExecuting 解除を待つ
            await this.taskRuntime.interruptForEmergency(message);

            const emergencyTaskInput = {
                userMessage: message,
                isEmergency: true,
                emergencyType: eventData.eventType,
                onToolStarting: () => this.notifyLLMHasControl(),
            };
            this.taskRuntime.setEmergencyTask(emergencyTaskInput);

            // 3. LLM ベースの緊急タスクを実行
            await this.taskRuntime.invoke(emergencyTaskInput);

            // 4. 逃走停止（LLM が制御を取った場合は既に停止済みだがフォールバック）
            this.stopContinuousFlee();

            // 5. 緊急タスク完了後、中断された元タスクを再開
            await this.taskRuntime.resumePreviousTask();

            return { handled: true, reactionType: 'emergency', message };
        } catch (error) {
            log.error('緊急対応エラー', error);
            this.stopContinuousFlee();
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
        // hostile_approach は複数敵情報を含めてメッセージを構築
        if (eventData.eventType === 'hostile_approach') {
            const ha = eventData as HostileEventData;
            const mobSummary = ha.allHostiles.map(h => `${h.mobType}(${h.distance}m)`).join(', ');
            return `緊急: 敵対Mob ${ha.mobCount}体が接近中 [${mobSummary}]。【制約】即時生存行動のみ: (1)食料があれば食べる (2)全敵から逃走する (3)安全な場所で待機。クラフト・採掘・建築は禁止。`;
        }
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
     * 継続型の反射的逃走を開始する。
     *
     * 旧実装: 2秒の固定タイマーで逃走 → LLM 応答待ちの間に棒立ち
     * 新実装: 300ms ごとに全敵の位置を再走査し、複合的な逃走方向を計算して逃げ続ける。
     *         LLM が最初の tool call を実行した時点で notifyLLMHasControl() → 停止。
     *         フォールバックとして MAX_FLEE_DURATION_MS 後にも停止する。
     */
    private static readonly FLEE_TICK_MS = 300;
    private static readonly MAX_FLEE_DURATION_MS = 15_000;

    private startContinuousFlee(): void {
        this.stopContinuousFlee(); // 既存の逃走があれば停止

        try {
            if (!this.bot.entity) return;

            // 進行中のアクションを停止
            this.bot.clearControlStates();
            const pathfinder = (this.bot as any).pathfinder;
            pathfinder?.setGoal?.(null);
            pathfinder?.stop?.();
        } catch { /* ignore */ }

        // 即座に1回逃走方向を計算して走り始める
        this.updateFleeDirection();

        const startTime = Date.now();

        this.fleeInterval = setInterval(() => {
            // LLM が制御を取った or 上限時間に達した → 停止
            if (this._llmHasControl || Date.now() - startTime > EventReactionSystem.MAX_FLEE_DURATION_MS) {
                this.stopContinuousFlee();
                return;
            }

            // 全敵の最新位置をもとに逃走方向を再計算
            this.updateFleeDirection();
        }, EventReactionSystem.FLEE_TICK_MS);
    }

    /**
     * 継続逃走を停止し、制御状態をクリアする。
     */
    private stopContinuousFlee(): void {
        if (this.fleeInterval) {
            clearInterval(this.fleeInterval);
            this.fleeInterval = null;
        }
        try {
            this.bot.clearControlStates();
        } catch { /* bot might be dead */ }
    }

    /**
     * 全敵対 Mob の位置から逃走方向を計算し、スプリントジャンプで逃げる。
     *
     * 複数敵への対応: 各敵からの「斥力ベクトル」を距離の逆数で重み付け合成し、
     * 全敵から最も離れる方向へ逃走する。1体だけの場合は単純にその反対方向。
     */
    private updateFleeDirection(): void {
        try {
            if (!this.bot.entity) return;

            const botPos = this.bot.entity.position;
            const hostiles = this.combat.scanCurrentHostiles();

            if (hostiles.length === 0) {
                // 敵がいなくなった → 前方にスプリントだけ維持
                this.bot.setControlState('forward', true);
                this.bot.setControlState('sprint', true);
                return;
            }

            // 各敵からの斥力ベクトルを合成（距離の逆数で重み付け）
            let repelX = 0;
            let repelZ = 0;
            for (const hostile of hostiles) {
                const dx = botPos.x - hostile.position.x;
                const dz = botPos.z - hostile.position.z;
                const dist = Math.max(hostile.distance, 0.5); // ゼロ除算防止
                const weight = 1 / (dist * dist); // 近い敵ほど強い斥力
                repelX += dx * weight;
                repelZ += dz * weight;
            }

            const len = Math.sqrt(repelX * repelX + repelZ * repelZ) || 1;
            const fleeYaw = Math.atan2(-repelX / len, -repelZ / len);

            this.bot.look(fleeYaw, 0, true);
            this.bot.setControlState('forward', true);
            this.bot.setControlState('sprint', true);
            this.bot.setControlState('jump', true);

            if (hostiles.length > 1) {
                log.debug(`⚡ 継続逃走: ${hostiles.length}体から離脱中 (最近=${hostiles[0].mobType} ${hostiles[0].distance}m)`);
            }
        } catch (error) {
            log.error('継続逃走 updateFleeDirection エラー（無視して続行）', error);
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
        this.stopContinuousFlee();
    }
}
