/**
 * EventReactionSystem
 * イベント反応を管理するシステム — ハンドラーの統括・タイマー管理
 */

import { CustomBot } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { MinebotTaskRuntime } from '../runtime/MinebotTaskRuntime.js';
import { EnvironmentEventHandler } from './handlers/EnvironmentEventHandler.js';
import { CombatEventHandler, EMERGENCY_HOSTILE_GUIDANCE_JA } from './handlers/CombatEventHandler.js';
import { isExposedTo } from '../utils/threatExposure.js';
import { isSealedIn } from '../utils/shelter.js';
import { PlayerEventHandler } from './handlers/PlayerEventHandler.js';
import { StatusEventHandler } from './handlers/StatusEventHandler.js';
import {
    loadEventReactionSettingsFile,
    saveEventReactionSettingsFile,
} from './eventReactionSettingsStore.js';
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { isHostileEntity, isListedHostileMobName, noteAttackedBy } from '../utils/hostileMobHints.js';
import { attackReach, CONTACT_DISTANCE, estimateEncounter, shootsAtBody } from '../../../modules/minecraftLearning/index.js';
import { EncounterMemory } from '../learning/EncounterMemory.js';
import { setMovements } from '../utils/setMovements.js';
import { holdsWater } from '../utils/waterBlocks.js';
import { airRunningOut } from '../utils/breathingReflex.js';
import { config as appConfig } from '../../../config/env.js';
import { captureWorldObservation } from '../cognition/worldFrame.js';
import { clearSurfacingStall, secondsToBreakOut, secondsToSwimOut, surfacingStallsHere, swimRouteToAir } from '../utils/breathingReflex.js';
import { escapeHeading, escapeMayWork } from '../utils/escapeHeading.js';
import { counterFor, losingPursuit } from '../utils/losingRace.js';
import { wearCostSeconds } from '../utils/toolChoice.js';
import { surfacingPossible } from '../constantSkills/autoSwim.js';
import { BURIED_AT, eyeHeight } from '../utils/bodyPose.js';
import { verifyNativeBreathingSafety } from '../cognition/GoalVerifier.js';
import { scanDryFootholds } from '../instantSkills/findDryFootholds.js';
import {
    createConfiguredReflexPolicy,
    formatReflexRecommendation,
} from '../cognition/JevReflexPolicy.js';
import type { ReflexDecision, ReflexPolicy } from '../cognition/types.js';
import { executeDirectReflex, reflexFactsDigest } from '../cognition/DirectReflexExecutor.js';
import { cancelNonSurvivalActions, preemptLowerPriorityActions, waitForActionQuiescence, withActionSignal, executeAction, actionSignal, currentAction } from '../execution/ActionExecution.js';
import { actionDelay } from '../execution/observedWait.js';
import { describeHarm } from '../utils/harm.js';
import { MAX_HOSTILE_CLEAR_RADIUS } from '../cognition/GoalVerifier.js';
import { engagedWith, beginEngagement } from '../utils/engagement.js';
import { answeredByReflex } from '../utils/reflexAnswers.js';
import { closeInterruption, describeInterruptions, emptyInterruptionLog, hurtWhileInterrupted, openInterruption, summariseInterruptions } from '../../../modules/minecraftLearning/interruptions.js';
import { skillCategory } from '../execution/SkillExecutor.js';
import type { MinecraftToolFinishedEvent } from '../../llm/graph/types.js';

const { goals: pfGoals } = pathfinder;
import type { TaskStateInput } from '../../llm/graph/types.js';
import {
    DamageEventData,
    DEFAULT_REACTION_CONFIGS,
    EventData,
    EventReactionConfig,
    EventReactionResult,
    EventType,
    HostileDetectionConfig,
    HostileEventData,
    ItemEventData,
    ReactionSettingsState,
    SuffocationEventData,
} from './types.js';

const log = createLogger('Minebot:EventReaction');
/** Longest native hold on the campaign while the bot breathes at the surface but stays in water. */
const BREATHING_HOLD_LIMIT_MS = 180_000;
/** How long a low-HP bot must be clear of hostiles before an available planner resumes. */
const LOW_HEALTH_CLEAR_HOLD_MS = 20_000;
/** Longest native hold on the campaign while hostiles loiter but no damage lands. */
const HOSTILE_HOLD_LIMIT_MS = 180_000;
/** tower-up's own default placeable blocks; a water escape must not spend logs needed for tools. */
const TOWER_BLOCKS = new Set(['cobblestone', 'dirt', 'stone', 'netherrack', 'oak_planks', 'spruce_planks', 'birch_planks',
    'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'deepslate', 'cobbled_deepslate', 'sandstone',
    'andesite', 'diorite', 'granite', 'tuff', 'sand', 'gravel']);
/** Two hits inside this window while escaping mean the pursuer is keeping up. */
/** Same rank as the critical survival reflexes: neither takes the body from the other. */
const DIG_OUT_PRIORITY = 300;
/** A travelling escape handed to the planner must take the body this far within this long to keep the reflexes waiting. */
const HANDED_OFF_PROGRESS_METRES = 1.5;
const HANDED_OFF_STALL_MS = 2_500;
/** How far round the body mobs are looked at for what they can reach from, and the room left beyond that reach. */
const REACH_SCAN_RADIUS = MAX_HOSTILE_CLEAR_RADIUS;
/** The furthest a hostile is ever held to matter from (a ghast shoots from 64): the widest the goal check accepts. */
const CLEARANCE_CAP = MAX_HOSTILE_CLEAR_RADIUS;
const REACH_MARGIN = 6;
/** The planner's tools that shut the body in where it is: an escape in themselves. */
const SHELTER_TOOLS = new Set(['dig-shelter', 'build-around-self']);
/** The body's walking pace, for how long closing a distance takes. */
const WALK_BLOCKS_PER_SECOND = 4.3;
/** Room asked for beyond a hostile that is on its way and will arrive within the lead the body needs. */
const ARRIVING_MARGIN = 4;
/** The native escape gives up a heading on which the body has not moved this far in this long. */
const FLEE_HEADING_PROGRESS_METRES = 1.5;
const FLEE_HEADING_STALL_MS = 1500;
/** Out of air, the body loses a heart a second. */
const DROWNING_DAMAGE_PER_SECOND = 2;
/** One unit of air lasts 15 ticks. */
const AIR_MS_PER_UNIT = 750;
// What the dig is measured at is its best case: a slow server tick or a rise through the hole comes on top.
const CEILING_MARGIN_MS = 5_000;
const COUNTER_HIT_WINDOW_MS = 6_000;
const COUNTER_MAX_MS = 12_000;
/** Contact time with nearby hostiles is sampled at this period for the measured damage rate. */
const CONTACT_SAMPLE_MS = 500;
/** How often a running fight re-checks the measured race against everything in contact. */
const FIGHT_RECHECK_MS = 500;
/** What a point of a weapon's durability is worth, as for digging (see toolChoice): weighed in which weapon to strike with. */
const WEAPON_WEAR = (item: string): number => wearCostSeconds({ name: item, maxDurability: 1 });
/** Longest the body stands and fends off a pursuer the escape was losing to before running is tried again. */
const FEND_MAX_MS = 8_000;
/** A blow reaches about three blocks: nearer than this the pursuer is struck, and knocked back. */
const FEND_STRIKE_REACH = 3;
/** Beyond this the pursuer is let go and the run resumes (a creeper gives up its fuse beyond seven). */
const FEND_CLEAR_DISTANCE = 8;
/**
 * And never before the gap is this much wider than where the fend-off began, and opening. The race is found lost
 * at seven or eight metres; ended at eight, a fend-off begun at 8.3 m was over before it started, the run lost
 * again a moment later, and the body turned and ran eight times in forty seconds (paid run L111).
 */
const FEND_MARGIN = 3;
/** How long a pursuer just dealt with is left alone, unless it comes nearer than it was then or the body is hurt. */
const PURSUER_COOLDOWN_MS = 5_000;
/** A pursuer that catches the run up again within this is one the run does not shake off. */
const PURSUER_REPEAT_WINDOW_MS = 30_000;
/** Backing away that has not moved the body this far in this long is blocked: it steps aside as well. */
const FEND_STUCK_METRES = 0.4;
const FEND_STUCK_MS = 800;

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
    private fleeController: AbortController | null = null;
    private breathingEscapeRunning = false;
    private digOutRunning = false;
    private lowHealthClearSince: number | null = null;
    private lastDamageAt = 0;
    private lastHealthSample: number | null = null;
    private fleeGoal: { x: number; z: number } | null = null;
    private fleeMovementsSet = false;
    /** Whether the escape's routes were last set to allow stopping to dig and lay blocks (see escapeMayWork). */
    private fleeMayWork: boolean | null = null;
    private recentHits: number[] = [];
    private counterattackRunning = false;
    /** The body has turned to face a pursuer its escape was losing to (see checkLosingRace). */
    private fendRunning = false;
    /** Pursuers the run was found losing to: when the last answer to each began and ended, from how far, at what health. */
    private pursuerAnswers = new Map<number, { startDistance: number; endedAt: number; health: number; times: number[] }>();
    /** Measured combat statistics; human priors only until a learning store is attached. */
    private encounters = new EncounterMemory();
    private learningNote: ((kind: string, record: Record<string, unknown>, line: string) => void) | null = null;
    private learningStalled: ((detail: string) => void) | null = null;
    /** What has taken the body from its task lately (see modules/minecraftLearning/interruptions). */
    private interruptions = emptyInterruptionLog();
    private contactSampler: NodeJS.Timeout | null = null;
    /** The server's damage_event for the bot: the causing entity, or null for falls, drowning and other environment. */
    private lastHurt: { at: number; source: string | null; from?: number } | null = null;
    private lastBlow: { at: number; cause: string } | null = null;
    /** One uniform swing period; its effect per weapon is learned as time-to-kill. */
    private swingIntervalMs = 650;
    private breathingEscapeAttempts = 0;
    private fleeWork: Promise<unknown> | null = null;
    /** LLM タスクが最初の tool call を実行したら true → 逃走停止 */
    private _llmHasControl = false;
    private handedOffTool: string | null = null;
    /** The way the native escape is running (kept from tick to tick so it does not turn at every shuffle of the mobs). */
    private fleeHeading: { x: number; z: number } | null = null;
    /** Headings this escape tried that took the body nowhere, and where it last got somewhere. */
    private fleeBlocked: Array<{ x: number; z: number }> = [];
    private fleeProgress: { x: number; z: number; at: number } | null = null;
    /** Where the body was when it last got somewhere under the handed-off escape, and when. */
    private handedOffProgress: { x: number; y: number; z: number; at: number } | null = null;
    private hostileContainmentActive = false;
    private fleeRenewalTimer: NodeJS.Timeout | null = null;
    /** An unresolved emergency is rechecked even when no new mob event arrives. */
    private hostileRecoveryTimer: NodeJS.Timeout | null = null;
    private hostileClearSince: number | null = null;
    private suffocationRecoveryTimer: NodeJS.Timeout | null = null;
    private suffocationClearSince: number | null = null;
    /** Respiratory danger remains latched across model calls and transient full-air readings. */
    private suffocationContainmentActive = false;
    private suffocationContainmentTimer: NodeJS.Timeout | null = null;
    private readonly reflexPolicy: ReflexPolicy | null;

    constructor(bot: CustomBot, taskRuntime: MinebotTaskRuntime,
        reactionSettings: ReturnType<typeof loadEventReactionSettingsFile> = loadEventReactionSettingsFile()) {
        this.bot = bot;
        this.taskRuntime = taskRuntime;
        this.configs = new Map();

        // ハンドラーを先に初期化（combat に検知距離を載せる）
        this.environment = new EnvironmentEventHandler(bot);
        this.combat = new CombatEventHandler(bot);
        this.player = new PlayerEventHandler(bot);
        this.status = new StatusEventHandler(bot);
        this.reflexPolicy = appConfig.minecraftCognition.mode === 'off'
            ? null
            : createConfiguredReflexPolicy({
                MINECRAFT_COGNITION_PROVIDER: appConfig.minecraftCognition.provider,
                TYPESAFE_API_KEY: appConfig.minecraftCognition.jevApiKey,
                SHANNON_JEV_ENDPOINT: appConfig.minecraftCognition.jevEndpoint,
                SHANNON_JEV_MODEL: appConfig.minecraftCognition.jevModel,
                SHANNON_JEV_TIMEOUT_MS: String(appConfig.minecraftCognition.jevTimeoutMs),
                OPENAI_API_KEY: appConfig.minecraftCognition.openAIApiKey,
                MINECRAFT_OPENAI_ENDPOINT: appConfig.minecraftCognition.openAIEndpoint,
                MINECRAFT_OPENAI_MODEL: appConfig.minecraftCognition.openAIModel,
                MINECRAFT_OPENAI_REASONING_EFFORT: appConfig.minecraftCognition.openAIReasoningEffort,
                MINECRAFT_OPENAI_TIMEOUT_MS: String(appConfig.minecraftCognition.openAITimeoutMs),
            });

        this.combat.applyHostileDetection(reactionSettings.hostileDetection);
        reactionSettings.reactions.forEach(config => {
            this.configs.set(config.eventType, { ...config });
        });
    }

    /**
     * 初期化
     */
    /** Share measured combat statistics and decision notes with the learning store (dev labs). */
    setLearning(learning: { encounterMemory(): EncounterMemory; note(kind: string, record: Record<string, unknown>, line: string): void;
        stalled?(bot: unknown, detail: string): void }): void {
        this.encounters = learning.encounterMemory();
        this.learningNote = (kind, record, line) => learning.note(kind, record, line);
        this.learningStalled = learning.stalled ? detail => learning.stalled!(this.bot, detail) : null;
    }

    /** The task gets the body back: the stop that held it is over. */
    private giveTaskBack(): Promise<void> {
        closeInterruption(this.interruptions, Date.now());
        return this.taskRuntime.resumePreviousTask();
    }

    /**
     * What has kept stopping the task, for the planner that holds it, with what the body has measured of the
     * kinds that keep coming up. Null when nothing has come up often enough. A fact for it to weigh: the same
     * way on from the same place meets the same stop, and only the planner of the task can choose another.
     */
    describeRecentInterruptions(now = Date.now()): string | null {
        const summary = summariseInterruptions(this.interruptions, now);
        if (!summary) return null;
        const stats = this.encounters.stats();
        const carried = [...new Set((this.bot.inventory?.items?.() ?? []).map((item: any) => String(item.name)))];
        const measured = summary.repeated.filter(kind => stats.mobs[kind]?.hits).map(kind => {
            const mob = stats.mobs[kind];
            const estimate = estimateEncounter(stats, { wearCost: WEAPON_WEAR, target: kind, health: this.bot.health ?? 20, threats: [{ name: kind, distance: 0 }], carried, escapeFailing: true });
            return `${kind}: ${attackReach(stats, kind) > 0 ? `最大${mob.reach!.toFixed(0)}m先から当ててくる、` : ''}被弾1回あたり平均${(mob.damage / mob.hits).toFixed(1)}、`
                + `いまの手持ち（${estimate.weapon ?? '素手'}）で倒すまで約${(estimate.timeToKillMs / 1000).toFixed(0)}秒`;
        });
        return describeInterruptions(summary) + (measured.length ? `。実測: ${measured.join('／')}` : '');
    }

    async initialize(): Promise<void> {
        // The dig guard asks how near a hostile has to be to matter: the same radius an emergency is judged by.
        (this.bot as any).hostileThreatRadius = () => this.emergencyClearanceRadius();
        (this.bot as any).recentInterruptions = () => this.describeRecentInterruptions();
        // What each kind of mob has been measured to do, for the observation's account of the body's reserves.
        (this.bot as any).combatStats = () => this.encounters.stats();
        // Whether a fight with what is near is one the measures favour (the attack skills ask before refusing one in an emergency).
        (this.bot as any).fightFavoured = () => { const odds = this.fightOdds(); return odds.length > 0 && odds.every(entry => entry.faster); };
        this.combat.setReachProvider(name => attackReach(this.encounters.stats(), name));
        // The second argument (the damage source) is newer than the event's typing.
        (this.bot as any).on('entityHurt', (entity: any, source: any) => {
            if (!entity || entity.id !== this.bot.entity?.id) return;
            // How far the cause stood when the hit landed: what a kind of mob can reach from is learned from this.
            let from: number | undefined;
            try { if (source?.position && this.bot.entity) from = this.bot.entity.position.distanceTo(source.position); } catch { from = undefined; }
            this.lastHurt = { at: Date.now(), source: source?.name ? String(source.name).toLowerCase() : null, from };
            // A mob the server names as the cause of a hit is hostile to the body for a while, listed or not.
            if (source?.name && source.type !== 'player' && source.type !== 'projectile' && source.type !== 'object') noteAttackedBy(String(source.name));
        });
        // Whether a kind shoots is learned from what the body sees of it: a shot seen coming that began where
        // one of that kind stood (said by the reflex that follows shots), against the blows it landed itself
        // (the server names the mob, not something in flight, as what struck). A kind that shoots is one a
        // shield answers (see utils/reflexAnswers).
        (this.bot as any)._client?.on?.('damage_event', (packet: any) => {
            if (packet?.entityId !== this.bot.entity?.id) return;
            const cause = (this.bot.entities as any)?.[packet.sourceCauseId - 1], direct = (this.bot.entities as any)?.[packet.sourceDirectId - 1];
            if (cause?.name && direct === cause) this.lastBlow = { at: Date.now(), cause: String(cause.name).toLowerCase() };
        });
        (this.bot as any).shotAtBy = (kind: string) => { try { this.encounters.recordShot(String(kind).toLowerCase()); } catch { /* a count */ } };
        (this.bot as any).shootsAtBody = (kind: string) => shootsAtBody(this.encounters.stats(), kind);
        this.bot.on('health', () => this.onHealthSample());
        this.contactSampler = setInterval(() => { this.sampleContact(); this.watchCeilingOverWater(); }, CONTACT_SAMPLE_MS);
        this.contactSampler.unref?.();
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
            this.persistSettingsToDisk();
        }
    }

    /**
     * 全設定をリセット
     */
    resetConfigs(): void {
        DEFAULT_REACTION_CONFIGS.forEach(config => {
            this.configs.set(config.eventType, { ...config });
        });
        this.combat.applyHostileDetection(undefined);
        this.persistSettingsToDisk();
    }

    private persistSettingsToDisk(): void {
        const reactions = Array.from(this.configs.values());
        saveEventReactionSettingsFile(reactions, this.combat.getHostileDetection());
    }

    /** 敵接近検知の距離・閾値を更新してディスクへ保存（HTTP / 手動設定用） */
    updateHostileDetection(partial: Partial<HostileDetectionConfig>): void {
        this.combat.applyHostileDetection(partial);
        this.persistSettingsToDisk();
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
        return {
            reactions,
            hostileDetection: this.combat.getHostileDetection(),
            constantSkills,
        };
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
        this.checkLosingRace();
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
        this.lastDamageAt = Date.now();
        hurtWhileInterrupted(this.interruptions, data.damage);
        // Classify the hit from the body's own state first: drowning or a
        // buried head is a breathing emergency, not "environmental damage,
        // eat something" (a paid run drowned while that task set food goals).
        const oxygen = Number.isFinite(this.bot.oxygenLevel) ? this.bot.oxygenLevel : null;
        const inWater = (this.bot.entity as any)?.isInWater === true;
        if ((inWater && oxygen !== null && oxygen <= 0) || this.buriedBodyBlock()) {
            await this.handleSuffocation({ oxygen, health: data.currentHealth, isInWater: inWater });
            return;
        }
        const hostiles = this.combat.scanCurrentHostiles();
        const det = this.combat.getHostileDetection();
        const nearThreshold = Math.max(det.criticalDistance, 12);
        let possibleSource: string | undefined;
        if (hostiles.length > 0 && hostiles[0].distance <= nearThreshold) {
            possibleSource = `${hostiles[0].mobType}（約${hostiles[0].distance}m）`;
        } else if (this.lastHurt?.source && Date.now() - this.lastHurt.at < 500) {
            // The server named who did it, and no listed hostile is near: say who (a piglin, a wolf, a golem).
            possibleSource = `${this.lastHurt.source}${this.lastHurt.from !== undefined ? `（約${this.lastHurt.from.toFixed(0)}m）` : ''}`;
        }
        const eventData: DamageEventData = {
            timestamp: Date.now(),
            eventType: 'damage',
            ...data,
            ...(possibleSource ? { possibleSource } : {}),
            ...(() => { try { const harm = describeHarm(this.bot as any); return harm ? { harm } : {}; } catch { return {}; } })(),
        };
        await this.handleEvent(eventData);
    }

    /**
     * The mob the server has just named as the cause of a hit, when nothing else would have raised it: it stood
     * further off than hostiles are watched for, or it is a kind the list does not know. A hit of six from a
     * ghast thirty blocks away was "minor damage, leave it to eating", three times, and the third killed
     * (paid run L77e). A hit a mob is named for is an attack, whatever it leaves of the health.
     */
    attackerBeyondWatch(now = Date.now()): string | null {
        const hurt = this.lastHurt;
        if (!hurt?.source || hurt.source === 'player' || now - hurt.at > 500) return null;
        const watched = isListedHostileMobName(hurt.source)
            && (hurt.from === undefined || hurt.from <= this.combat.getHostileDetection().detectionDistance);
        return watched ? null : hurt.source;
    }

    /**
     * 窒息イベントを処理（外部から呼び出し）
     */
    async handleSuffocation(data: {
        oxygen: number | null;
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

    private hostileClearanceRadius(): number {
        const detection = this.combat.getHostileDetection();
        return Math.min(detection.detectionDistance, detection.criticalDistance * 2);
    }

    /** Kinds of mob near enough to matter that have hit the body from beyond contact, with the farthest they have. */
    private reachingKinds(): Array<{ name: string; reach: number }> {
        const stats = this.encounters.stats();
        const kinds = new Map<string, number>();
        for (const entry of this.hostilesAround(REACH_SCAN_RADIUS)) {
            const reach = attackReach(stats, entry.name);
            // A kind whose attack a reflex of the body answers (a ghast's fireball is struck back) is not kept
            // away from by its mere presence: only a hit that got through raises it (see emergencyClearanceRadius).
            if (answeredByReflex(this.bot, entry.name) || engagedWith(this.bot, entry.name)) continue;
            if (reach > 0 && entry.distance <= reach + REACH_MARGIN && isExposedTo(this.bot as any, entry.entity)) kinds.set(entry.name, reach);
        }
        return [...kinds].map(([name, reach]) => ({ name, reach }));
    }

    /** A stop of the task begins: what it is for is kept, and a kind that keeps coming up is given to the learning to think over. */
    private noteInterruption(eventData: EventData): void {
        try {
            const data = eventData as Partial<HostileEventData> & { possibleSource?: string; harm?: string };
            const kinds = eventData.eventType === 'hostile_approach' ? (data.allHostiles ?? []).map(entry => entry.mobType)
                : data.possibleSource && data.possibleSource !== 'unknown' ? [data.possibleSource.replace(/（.*$/, '').trim()]
                : [data.harm ? data.harm.slice(0, 24) : eventData.eventType];
            const before = summariseInterruptions(this.interruptions, Date.now())?.repeated ?? [];
            openInterruption(this.interruptions, { cause: eventData.eventType, kinds }, Date.now());
            const summary = summariseInterruptions(this.interruptions, Date.now());
            const newly = summary?.repeated.filter(kind => !before.includes(kind)) ?? [];
            if (summary && newly.length) {
                const line = this.describeRecentInterruptions() ?? describeInterruptions(summary);
                log.warn(`🔁 ${line}`);
                this.learningNote?.('repeated_interruption', { kinds: summary.repeated, count: summary.count, damage: summary.damage }, line);
                this.learningStalled?.(`主タスクが同じ相手への緊急対応で繰り返し中断され、進んでいない。${line}`);
            }
        } catch { /* a count, never in the way of the emergency itself */ }
    }

    /**
     * How far everything hostile has to be before an emergency counts as over. The usual radius, or
     * farther for a kind of mob that has hit the body from farther: "nothing within 16 blocks" was
     * confirmed three times while a skeleton stood fifteen and a half blocks off and went on shooting,
     * five arrows in thirty-two seconds (paid run L69).
     */
    private emergencyClearanceRadius(): number {
        const farthest = Math.max(0, ...this.reachingKinds().map(kind => kind.reach));
        // And farther for one still on its way that will be here before the body can be safe: an emergency
        // begun for it is not over because it has not yet come inside the usual radius.
        const base = this.hostileClearanceRadius();
        const arriving = Math.max(0, ...this.combat.arrivingBeyond(base).map(entry => entry.distance));
        // And as far as the hit that has just landed came from: the measure of that kind's reach is taken from
        // the same hit a moment later, and an emergency raised for a ghast sixty blocks off was judged over
        // by "nothing hostile within sixteen" three seconds after it began (paid run L77f).
        const justHit = this.lastHurt?.source && this.lastHurt.from !== undefined && Date.now() - this.lastHurt.at < 5000 ? this.lastHurt.from : 0;
        return Math.min(CLEARANCE_CAP, Math.max(base, farthest > 0 ? Math.ceil(farthest + REACH_MARGIN) : 0,
            arriving > 0 ? Math.ceil(arriving + ARRIVING_MARGIN) : 0, justHit > 0 ? Math.ceil(justHit + REACH_MARGIN) : 0));
    }

    /** A nearby pursuer must not be handed back to an idle or unavailable planner. */
    private needsNativeHostileSafetyLease(): boolean {
        const recovery = this.taskRuntime.currentState?.recoveryStatus;
        return this.bot.health <= 8 || this.taskRuntime.isReady?.() === false
            || recovery === 'awaiting_user' || recovery === 'failed_terminal';
    }

    private onEmergencyToolStarting(toolName: string, args: Record<string, unknown> | undefined,
        hostileEmergency: boolean, suffocationEmergency = false): void {
        if (!toolName.startsWith('routine-') && !this.bot.instantSkills.getSkill(toolName)) return;
        if (skillCategory(toolName) === 'query') return;
        if (suffocationEmergency) {
            // Tool dispatch is not motor ownership or native breathing proof. A
            // missing-item action or another underwater Y-only move must not
            // disarm the independent survival capability.
            this.refreshSuffocationContainment();
            return;
        }
        if (!hostileEmergency) {
            this.notifyLLMHasControl();
            return;
        }
        const hostiles = this.combat.scanCurrentHostiles(this.hostileClearanceRadius());
        if (hostiles.length === 0) {
            // A planner escape started while the pursuer is just outside the
            // clearance radius is still the escape. Left unregistered, the next
            // warning tick restarted native flee and cancelled it, twice, and
            // the bot was caught (paid run L9).
            if (SHELTER_TOOLS.has(toolName) || (toolName === 'flee-from'
                && String(args?.target ?? args?.entityName ?? '').toLowerCase() === 'hostile')) this.handOff(toolName);
            this.notifyLLMHasControl();
            return;
        }

        let viable = false;
        if (toolName === 'flee-from') {
            // A named single target must not replace multi-threat containment.
            // Do not silently change the planner's request; the tool receives
            // exactly the chosen arguments and can report its own result.
            const target = String(args?.target ?? args?.entityName ?? '').toLowerCase();
            viable = target === 'hostile' || (hostiles.length === 1 && target === hostiles[0].mobType.toLowerCase());
        } else if (toolName === 'move-to' && this.bot.entity?.position) {
            const x = Number(args?.x), y = Number(args?.y), z = Number(args?.z);
            if ([x, y, z].every(Number.isFinite)) {
                const origin = this.bot.entity.position;
                viable = hostiles.every(hostile => {
                    const current = Math.hypot(origin.x - hostile.position.x, origin.y - hostile.position.y,
                        origin.z - hostile.position.z);
                    const destination = Math.hypot(x - hostile.position.x, y - hostile.position.y,
                        z - hostile.position.z);
                    return destination >= current + 1;
                });
            }
        } else if (SHELTER_TOOLS.has(toolName)) {
            // Sealing into a shaft, or walling itself in where it stands, is itself the escape; native flee must not pull the bot out.
            viable = true;
        } else if (toolName === 'attack-nearest' || toolName === 'attack-continuously' || toolName === 'combat-engage' || toolName === 'combat') {
            // The planner's attack is the response when the measured race says it wins: the escape lets go of the
            // body for it (it took the body back from every blow before, and the attack never closed the distance).
            try { const odds = this.fightOdds(); viable = odds.length > 0 && odds.every(entry => entry.faster); } catch { viable = false; }
        } else if (toolName === 'set-shield' && args?.enabled === true) {
            const offhand = this.bot.inventory?.slots?.[this.bot.getEquipmentDestSlot('off-hand')];
            viable = this.bot.heldItem?.name === 'shield' || offhand?.name === 'shield';
        } else if ((toolName === 'place-block-at' || toolName === 'dig-block-at') && this.bot.entity?.position) {
            const x = Number(args?.x), y = Number(args?.y), z = Number(args?.z);
            const pos = this.bot.entity.position;
            const nearby = [x, y, z].every(Number.isInteger) && Math.hypot(x - pos.x, y - pos.y, z - pos.z) <= 3;
            viable = nearby && (toolName === 'place-block-at'
                ? this.bot.inventory.items().some(item => item.name === args?.blockName)
                : args?.collect === false && !!this.bot.blockAt?.(new Vec3(x, y, z)));
        }
        if (!viable) return;
        this.handOff(toolName);
        this.notifyLLMHasControl();
    }

    private handOff(toolName: string): void {
        this.handedOffTool = toolName;
        const position = this.bot.entity?.position;
        this.handedOffProgress = position ? { x: position.x, y: position.y, z: position.z, at: Date.now() } : null;
    }

    /**
     * Whether the escape the planner was given is going nowhere: a travelling
     * escape (flee-from, move-to) that has not taken the body a block and a
     * half in two and a half seconds. The choice of tool said it could work;
     * only the body moving says it does. A flee-from that found no route out
     * of the water it started in kept the reflexes waiting for ten seconds
     * while a zombie hit a body that pressed no key (paid run L53).
     */
    private handedOffEscapeStalled(now = Date.now()): boolean {
        if (this.handedOffTool !== 'flee-from' && this.handedOffTool !== 'move-to') return false;
        const position = this.bot.entity?.position;
        const anchor = this.handedOffProgress;
        if (!position || !anchor) return false;
        if (Math.hypot(position.x - anchor.x, position.y - anchor.y, position.z - anchor.z) >= HANDED_OFF_PROGRESS_METRES) {
            this.handedOffProgress = { x: position.x, y: position.y, z: position.z, at: now };
            return false;
        }
        return now - anchor.at >= HANDED_OFF_STALL_MS;
    }

    private onEmergencyToolFinished(event: MinecraftToolFinishedEvent, hostileEmergency: boolean,
        suffocationEmergency = false): void {
        if (suffocationEmergency) {
            // A tool's own success is not the emergency postcondition. In
            // particular, full air while still submerged can fall again.
            this.refreshSuffocationContainment();
            return;
        }
        if (!hostileEmergency) return;
        // Work done where the body stands (a wall is several blocks) is one plan when the planner wrote it in
        // one response. Taking the body back after each block carried it off between them: of four blocks
        // asked for at once two were placed, the third waited fifteen seconds for the body and was then seven
        // blocks away, and the planner chased its own wall through a cave for two minutes (paid run L78).
        if (this.handedOffTool === event.tool && event.moreInResponse && event.success !== false
            && (event.tool === 'place-block-at' || event.tool === 'dig-block-at')) return;
        if (this.handedOffTool === event.tool) this.handedOffTool = null;
        else if (this.fleeController) return;
        const hostiles = this.combat.scanCurrentHostiles(this.hostileClearanceRadius());
        if (hostiles.length === 0) return;
        // A failed/finished takeover or an invalid action that outlasted the
        // current containment lease must not leave the bot standing still.
        this.startContinuousFlee();
    }

    private async waitForStableHostileClearance(radius: number): Promise<boolean> {
        if (this.needsNativeHostileSafetyLease()) return false;
        const deadline = Date.now() + 2_000;
        let clearSince: number | null = null;
        while (Date.now() < deadline) {
            if (!this.bot.entity || this.bot.health <= 0) return false;
            if (this.needsNativeHostileSafetyLease()) return false;
            const now = Date.now();
            if (this.combat.scanCurrentHostiles(radius).length === 0) {
                clearSince ??= now;
                if (now - clearSince >= 600) return true;
            } else clearSince = null;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
    }

    private async waitForStableBreathingClearance(): Promise<boolean> {
        const deadline = Date.now() + 2_000;
        let clearSince: number | null = null;
        while (Date.now() < deadline) {
            const now = Date.now();
            if (verifyNativeBreathingSafety(this.bot).status === 'verified') {
                clearSince ??= now;
                if (now - clearSince >= 600) return true;
            } else clearSince = null;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
    }

    private stopSuffocationRecovery(): void {
        if (this.suffocationRecoveryTimer) clearInterval(this.suffocationRecoveryTimer);
        this.suffocationRecoveryTimer = null;
        this.suffocationClearSince = null;
    }

    private stopSuffocationContainment(): void {
        this.suffocationContainmentActive = false;
        if (this.suffocationContainmentTimer) clearInterval(this.suffocationContainmentTimer);
        this.suffocationContainmentTimer = null;
    }

    /** Registered critical capabilities own the immediate motor response; the
     * model may still take a serial lease for a lateral escape after they yield.
     */
    private refreshSuffocationContainment(): void {
        if (!this.suffocationContainmentActive) return;
        if (!this.bot.entity || this.bot.health <= 0) {
            this.stopSuffocationContainment();
            return;
        }
        if (verifyNativeBreathingSafety(this.bot).status === 'verified') return;
        // Buried by falling sand or gravel: no swim reflex helps, and the
        // model misread "suffocating at 20/20 air" (paid run 2026-10-01 died
        // in its own shelter). Dig the head block, then the foot block, out.
        const buried = this.buriedBodyBlock() ?? this.ceilingOverWater();
        if (buried) {
            this.breakOut(buried, '身体が埋まっている、または頭上が塞がれて水面に出られない');
            return;
        }
        const constants = this.bot.constantSkills;
        if (!constants || typeof constants.requestExecution !== 'function') return;
        const available = constants.getSkills()
            .filter(skill => skill.status && skill.isCritical && !skill.isLocked && skill.wantsPreemption())
            .sort((left, right) => right.priority - left.priority);
        const skill = available[0];
        if (!skill) return;
        void constants.requestExecution(skill, []).catch(error => {
            log.warn(`呼吸安全のcritical capability ${skill.skillName} 起動失敗: ${String(error)}`);
        });
    }

    /**
     * Breaking out is the survival action here: on a rank of its own, so the
     * surfacing reflex (useless under a ceiling) and the emergency's own
     * cancellations cannot take the body from it. A bot under an ice sheet had
     * its dig cancelled three times in 18 seconds and drowned (paid run L25).
     */
    private breakOut(block: any, why: string): void {
        if (this.digOutRunning) return;
        this.digOutRunning = true;
        const dig = this.bot.instantSkills.getSkill('dig-block-at');
        log.warn(`⛏ ${why}: ${block.name}(${block.position.x}, ${block.position.y}, ${block.position.z})を掘って出る`);
        preemptLowerPriorityActions(this.bot, DIG_OUT_PRIORITY, 'dig_out');
        // Under water the body stays up against what it is breaking: nothing else holds it there.
        const reflex = (this.bot as any).breathingReflex as { holdAfloat?: boolean } | undefined;
        if (reflex) reflex.holdAfloat = true;
        void executeAction(this.bot, 'dig-block-at', 30_000,
            async () => (await dig?.run(block.position.x, block.position.y, block.position.z, false))
                ?? { success: false, result: 'dig-block-at unavailable' },
            { priority: DIG_OUT_PRIORITY, safetyLease: true, waitForQuiescence: true, legacyExecutingSkill: true })
            .catch(error => log.warn(`掘り出しに失敗: ${String(error)}`))
            .finally(() => { this.digOutRunning = false; if (reflex) reflex.holdAfloat = false; clearSurfacingStall(this.bot); });
    }

    /**
     * In water with the way up closed and no open surface in swimming reach:
     * the block to break through, straight above the head. Null in open water,
     * under an overhang with open water beside it, or under something that
     * cannot be dug.
     */
    private ceilingOverWater(): any | null {
        if (surfacingPossible(this.bot as any)) return null;
        const ceiling = this.ceilingBlock();
        if (!ceiling) return null;
        // A stalled swim is not a reason to start a dig that cannot finish. Stone overhead takes a body
        // afloat fourteen seconds with a stone pickaxe; with four seconds of air and a way to swim one cell
        // away, digging was the one choice sure to fail (paid run L54). While a route through the water
        // exists and breaking out would outlast the air and the health after it, the swim is tried again.
        try {
            const breakOut = secondsToBreakOut(this.bot as any);
            const lasts = Math.max(0, this.bot.oxygenLevel ?? 20) * (AIR_MS_PER_UNIT / 1000) + Math.max(0, this.bot.health ?? 20) / DROWNING_DAMAGE_PER_SECOND;
            // ...unless that swim has already stalled here twice: then it is not a way out, and breaking out is.
            if (breakOut > lasts && swimRouteToAir(this.bot as any) && surfacingStallsHere(this.bot) < 2) { clearSurfacingStall(this.bot); return null; }
        } catch { /* judged by the ceiling alone */ }
        return ceiling;
    }

    /** The diggable block closing the way straight up over a body in water, whether or not it could swim out from under it. */
    private ceilingBlock(): any | null {
        const entity: any = this.bot.entity;
        if (!entity?.position || entity.isInWater !== true) return null;
        const head = entity.position.offset(0, eyeHeight(this.bot as any), 0).floored();
        for (const dy of [0, 1]) {
            const block = this.bot.blockAt?.(head.offset(0, dy, 0));
            if (block?.boundingBox === 'block') return block.diggable && !PROTECTED_UTILITY_BLOCKS.has(block.name) ? block : null;
        }
        return null;
    }

    /**
     * Under a closed ceiling the air only runs down, and breaking through takes
     * the time it takes: far longer under water. Waiting for the low-air alarm
     * leaves too little. Start while the air still covers the dig, measured
     * with the tool in hand, plus a margin.
     */
    private watchCeilingOverWater(): void {
        if (this.digOutRunning || !this.bot.entity || this.bot.health <= 0) return;
        const oxygen = this.bot.oxygenLevel ?? 20;
        if (oxygen >= 20) return;
        const ceiling = this.ceilingBlock();
        if (!ceiling) return;
        const swimmable = surfacingPossible(this.bot as any);
        // The whole ceiling, not its first block: breaking into more rock is not a way out.
        let breakOutMs = Infinity;
        try { breakOutMs = secondsToBreakOut(this.bot as any) * 1000; } catch { /* judged below */ }
        if (!Number.isFinite(breakOutMs)) {
            // Too thick or not measurable. With nowhere to swim to it is still the only move there is.
            if (swimmable) return;
            breakOutMs = 5_000;
            try { const measured = (this.bot as any).digTime?.(ceiling); if (Number.isFinite(measured)) breakOutMs = measured; } catch { /* keep the default */ }
        }
        if (oxygen * AIR_MS_PER_UNIT > breakOutMs + CEILING_MARGIN_MS) return;
        // The air now only just covers breaking out. Swimming out from under the ceiling keeps the body
        // only while it is the quicker way; a swim that is not arriving must not spend the air the dig needs.
        if (swimmable) {
            let swimMs = Infinity;
            try { swimMs = secondsToSwimOut(this.bot as any) * 1000; } catch { /* no swim known */ }
            if (swimMs < breakOutMs) return;
        }
        this.breakOut(ceiling, `頭上が塞がれて水面に出られず、空気は残り${oxygen}/20（掘るのに約${(breakOutMs / 1000).toFixed(1)}秒）`);
    }

    /** Solid, diggable block occupying the head (first) or feet cell. */
    private buriedBodyBlock(): any | null {
        const position = this.bot.entity?.position;
        if (!position) return null;
        for (const dy of [BURIED_AT, 0.1]) {
            const block = this.bot.blockAt?.(new Vec3(Math.floor(position.x), Math.floor(position.y + dy), Math.floor(position.z)));
            if (block?.boundingBox === 'block' && block.diggable && !PROTECTED_UTILITY_BLOCKS.has(block.name)) return block;
        }
        return null;
    }

    private startSuffocationContainment(): void {
        this.suffocationContainmentActive = true;
        this.refreshSuffocationContainment();
        if (this.suffocationContainmentTimer) return;
        this.suffocationContainmentTimer = setInterval(() => this.refreshSuffocationContainment(), 100);
        this.suffocationContainmentTimer.unref?.();
    }

    /**
     * Surfacing alone cannot leave a pool walled in above the waterline: in a
     * paid run the bot bobbed for 80 minutes after the emergency model gave
     * up. While air is refilled (auto-swim yields at oxygen >= 10) and no
     * model run owns the body, walk to a scanned dry foothold, digging if the
     * path needs it. Candidates rotate so a blocked one is not retried forever.
     */
    private async tryNativeBreathingEscape(): Promise<void> {
        if (this.breathingEscapeRunning) return;
        this.breathingEscapeRunning = true;
        try {
            const candidates = scanDryFootholds(this.bot, { radius: 8, maxVertical: 12, maxCandidates: 3 }).candidates;
            const moveTo = this.bot.instantSkills.getSkill('move-to');
            if (candidates.length && moveTo) {
                const site = candidates[this.breathingEscapeAttempts++ % candidates.length];
                log.warn(`🏊 呼吸安全が回復しないため乾いた足場(${site.x.toFixed(1)}, ${site.y}, ${site.z.toFixed(1)})へnativeで移動を試行`);
                const moved: any = await moveTo.run(site.x, site.y, site.z, 1.2, 'near');
                // The pathfinder often finds no route out of a pool walled above the
                // waterline; cut steps into the wall toward the footing instead.
                const stairMine = this.bot.instantSkills.getSkill('stair-mine');
                const here = this.bot.entity?.position;
                if (!moved?.success && stairMine && here && site.y > here.y
                    && verifyNativeBreathingSafety(this.bot).status !== 'verified') {
                    const dx = site.x - here.x, dz = site.z - here.z;
                    const direction = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north');
                    log.warn(`🏊 経路が無いため${direction}の壁に段を掘って登る`);
                    await stairMine.run(site.y, direction, 'cobblestone');
                }
            }
            // A flooded shaft with no reachable footing (a paid run drowned there
            // after 15 minutes): stack blocks while swimming up until the feet
            // stand above the water column.
            if (verifyNativeBreathingSafety(this.bot).status !== 'verified' && (this.bot.entity as any)?.isInWater) {
                await this.towerOutOfWater();
            }
        } catch (error) {
            log.warn(`呼吸安全のnative移動に失敗: ${String(error)}`);
        } finally {
            this.breathingEscapeRunning = false;
        }
    }

    private async towerOutOfWater(): Promise<void> {
        const tower = this.bot.instantSkills.getSkill('tower-up');
        if (!tower || !this.bot.entity) return;
        const feet = this.bot.entity.position.floored();
        let depth = 0;
        while (depth < 10 && holdsWater(this.bot.blockAt(feet.offset(0, depth, 0)))) depth++;
        const blocks = this.bot.inventory.items().filter(item => TOWER_BLOCKS.has(item.name))
            .reduce((total, item) => total + item.count, 0);
        const height = Math.min(Math.max(depth, 1), blocks);
        if (height < 1) return;
        log.warn(`🏊 水柱${depth}段から足場を積んで水面の上へ登る（高さ${height}）`);
        await tower.run(height);
    }

    /** Native, model-free follow-up after a bounded emergency run ends before air recovers. */
    private watchSuffocationRecovery(): void {
        if (this.suffocationRecoveryTimer) return;
        this.suffocationClearSince = null;
        this.breathingEscapeAttempts = 0;
        let lastEscapeAt = Date.now();
        const watchStartedAt = Date.now();
        this.suffocationRecoveryTimer = setInterval(() => {
            if (!this.taskRuntime.isInEmergencyMode() || !this.bot.entity || this.bot.health <= 0) {
                this.stopSuffocationRecovery();
                return;
            }
            const now = Date.now();
            // Holding the campaign until the bot is fully out of water deadlocked
            // paid runs for up to 80 minutes in walled pools. After a bounded
            // wait, a bot that can breathe at the surface hands control back to
            // the main planner, which has the full toolset and context; a new
            // low-air event re-arms the emergency.
            if (now - watchStartedAt >= BREATHING_HOLD_LIMIT_MS && (this.bot.oxygenLevel ?? 0) >= 18
                && !this.taskRuntime.isRunning?.() && !this.breathingEscapeRunning) {
                const head = this.bot.blockAt?.(this.bot.entity.position.offset(0, eyeHeight(this.bot as any), 0).floored());
                if (head && head.name !== 'water' && head.boundingBox !== 'block') {
                    this.stopSuffocationRecovery();
                    this.stopSuffocationContainment();
                    log.warn('呼吸は確保できているが水から出られない状態が続いたため、主タスクの計画器へ戻す');
                    void this.giveTaskBack().catch(error => log.error('水中待機後の元タスク再開エラー', error));
                    return;
                }
            }
            if (verifyNativeBreathingSafety(this.bot).status !== 'verified' && now - lastEscapeAt >= 15_000
                && (this.bot.oxygenLevel ?? 20) >= 10 && !this.taskRuntime.isRunning?.() && !this.breathingEscapeRunning
                && !this.digOutRunning && !this.buriedBodyBlock()) {
                lastEscapeAt = now;
                void this.tryNativeBreathingEscape();
            }
            if (verifyNativeBreathingSafety(this.bot).status === 'verified') {
                this.suffocationClearSince ??= now;
                if (now - this.suffocationClearSince < 600) return;
                this.stopSuffocationRecovery();
                this.stopSuffocationContainment();
                log.info('酸素・水・身体周囲のnative安全確認が安定。保留していた元タスクを再開');
                void this.giveTaskBack().catch(error => {
                    log.error('窒息離脱後の元タスク再開エラー', error);
                });
            } else this.suffocationClearSince = null;
        }, 300);
        this.suffocationRecoveryTimer.unref?.();
    }

    private stopHostileRecovery(): void {
        if (this.hostileRecoveryTimer) clearInterval(this.hostileRecoveryTimer);
        this.hostileRecoveryTimer = null;
        this.hostileClearSince = null;
        this.lowHealthClearSince = null;
    }

    /**
     * A bounded emergency-model run can end while containment is still active.
     * The hostile event detector emits on approach, not departure, so only
     * listening for the next event can leave the main goal paused forever.
     * Native observations release it after the same stable-clearance window.
     */
    private watchHostileRecovery(radius: number): void {
        if (this.hostileRecoveryTimer) return;
        this.hostileClearSince = null;
        const watchStartedAt = Date.now();
        this.hostileRecoveryTimer = setInterval(() => {
            if (!this.hostileContainmentActive || !this.bot.entity || this.bot.health <= 0) {
                this.stopHostileRecovery();
                return;
            }
            // A mob loitering outside a shelter (a creeper does not burn at
            // dawn) kept a paid run's campaign paused after the emergency model
            // gave up. With no damage for a minute, return control to the main
            // planner after a bounded wait; a new attack re-arms the emergency.
            if (Date.now() - watchStartedAt >= HOSTILE_HOLD_LIMIT_MS && Date.now() - this.lastDamageAt >= 60_000
                && this.taskRuntime.isInEmergencyMode() && !this.taskRuntime.isRunning?.()) {
                this.stopHostileRecovery();
                this.hostileContainmentActive = false;
                this.stopContinuousFlee();
                this.combat.noteThreatsSettled();
                log.warn('敵対Mobの封じ込めが長引いたが被弾は無いため、主タスクの計画器へ戻す');
                void this.giveTaskBack().catch(error => log.error('封じ込め上限後の元タスク再開エラー', error));
                return;
            }
            const hostiles = this.combat.scanCurrentHostiles(radius);
            if (hostiles.length > 0) {
                this.hostileClearSince = null;
                this.lowHealthClearSince = null;
                if (!this.fleeController) this.startContinuousFlee();
                return;
            }
            // Clearance alone is insufficient while HP is critical or no
            // planner can own the next action. Keep the native watcher armed so
            // a pursuer crossing back into range restarts escape immediately.
            // A starving bot cannot regain HP, though, so once the area has
            // stayed clear for a while an available planner gets control back
            // to find food (a paid run held the campaign 15+ minutes at HP 0.5).
            const now = Date.now();
            if (this.needsNativeHostileSafetyLease()) {
                const recovery = this.taskRuntime.currentState?.recoveryStatus;
                const plannerAvailable = this.taskRuntime.isReady?.() !== false
                    && recovery !== 'awaiting_user' && recovery !== 'failed_terminal';
                this.lowHealthClearSince ??= now;
                if (!plannerAvailable || now - this.lowHealthClearSince < LOW_HEALTH_CLEAR_HOLD_MS) {
                    this.hostileClearSince = null;
                    return;
                }
            } else this.lowHealthClearSince = null;
            this.hostileClearSince ??= now;
            if (now - this.hostileClearSince < 600) return;

            this.stopHostileRecovery();
            this.hostileContainmentActive = false;
            this.stopContinuousFlee();
            this.combat.noteThreatsSettled();
            if (this.taskRuntime.isInEmergencyMode()) {
                log.info(`半径${radius}mの敵対Mob不在が安定。保留していた元タスクを再開`);
                void this.giveTaskBack().catch(error => {
                    log.error('敵対Mob離脱後の元タスク再開エラー', error);
                });
            } else if (!this.taskRuntime.isRunning?.()) {
                this.bot.minebotControlState = 'idle';
            }
        }, 300);
        this.hostileRecoveryTimer.unref?.();
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

            // The model may be awaiting user input or unavailable after a
            // provider error. A low-HP actor also cannot wait for a warning
            // task while a pursuer closes from the outer detection radius.
            if (this.hostileContainmentActive && this.taskRuntime.isInEmergencyMode()) {
                // currentAction() is always empty in an event handler, so it
                // cannot tell whether the planner's escape is running. Only a
                // viable planner escape (handedOffTool) keeps its lease.
                if (this.fleeController) this.updateFleeDirection();
                else if (!this.handedOffTool) this.startContinuousFlee();
                return { handled: true, reactionType: 'emergency', message };
            }
            if (this.needsNativeHostileSafetyLease()) return this.handleEmergencyEvent(eventData);

            // idle ならタスク生成、busy ならログのみ（warning は攻撃ツールを機械的に外す）
            if (this.isIdle()) {
                return this.handleTaskEvent(eventData, { minebotToolPolicy: 'hostile_warning' });
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
            // Restarting native escape cancels the planner's running flee-from.
            if (this.fleeController) this.updateFleeDirection();
            else if (!this.handedOffTool) this.startContinuousFlee();
            return { handled: true, reactionType: 'emergency' };
        }

        return this.handleEmergencyEvent(eventData);
    }

    /**
     * 緊急イベントを処理
     */
    private async handleEmergencyEvent(eventData: EventData): Promise<EventReactionResult> {
        if (!this.taskRuntime.isReady()) {
            const radius = this.hostileClearanceRadius();
            if (eventData.eventType === 'hostile_approach'
                || this.combat.scanCurrentHostiles(radius).length > 0) {
                log.warn('⚠️ MinebotTaskRuntime が未接続のため、敵対Mobからnativeで逃走します');
                this.hostileContainmentActive = true;
                this.bot.minebotControlState = 'emergency_reflect';
                this.startContinuousFlee();
                this.watchHostileRecovery(radius);
                return { handled: true, reactionType: 'emergency' };
            }
            log.warn('⚠️ MinebotTaskRuntime が未接続です');
            return { handled: false, reactionType: 'emergency' };
        }

        if (this.bot.executingSkill) {
            log.warn('⚠️ InstantSkill実行中だが、緊急対応を優先して割り込みます');
        }

        if (this.taskRuntime.isInEmergencyMode()) {
            // Air outranks a pursuer. A hostile emergency skipped drowning
            // events and, at low HP, restarted the escape underwater (paid
            // run 2026-10-01: drowned 28m from the nearest creeper).
            const breathingUnsafe = this.breathingAtRisk();
            if (breathingUnsafe && (eventData.eventType === 'suffocation' || this.suffocationContainmentActive)) {
                if (!this.suffocationContainmentActive) log.warn('⚠️ 緊急対応中に呼吸が危険 → 敵からの逃走より呼吸の確保を優先');
                this.stopContinuousFlee();
                // Suffocation damage ticks every half second; interrupting on
                // each tick cancelled the native dig-out of a buried body
                // (a paid run stayed buried in gravel for 16 minutes) and the
                // auto-swim surfacing itself (a paid run drowned). Take the
                // body from the task only, never from a survival action.
                if (!this.digOutRunning && !this.breathingEscapeRunning && !this.buriedBodyBlock()) {
                    cancelNonSurvivalActions(this.bot, 'breathing_priority');
                }
                this.startSuffocationContainment();
                return { handled: true, reactionType: 'emergency' };
            }
            // HP が危険域の場合は LLM を待たず即座に逃走を再開
            if (this.counterattackRunning) {
                log.debug(`HP=${this.bot.health}: 追いつかれた近接Mobへの反撃を継続`);
            } else if (this.bot.health <= 8) {
                // Poison, fire or several attackers emit a damage event every
                // tick. Restarting a running escape cancels its lease and path
                // each time, which leaves the bot standing still under fire.
                if (this.fleeController) {
                    this.updateFleeDirection();
                } else if (this.handedOffTool && this.handedOffEscapeStalled()) {
                    log.warn(`⚠️ 計画器に任せた${this.handedOffTool}が身体を動かしていない（HP=${this.bot.health}）→ 反射の逃走に戻す`);
                    this.startContinuousFlee();
                } else if (this.handedOffTool) {
                    // Set only while a viable planner escape runs; cleared when
                    // it finishes or native containment takes over again.
                    log.debug(`HP=${this.bot.health}: 進行中の${this.handedOffTool}による退避を維持`);
                } else {
                    log.warn(`⚠️ 緊急タスク処理中だが HP=${this.bot.health} で危険域 → 逃走を再開`);
                    this.startContinuousFlee();
                }
            } else {
                log.warn('⚠️ 緊急タスク処理中のため新しい緊急イベントをスキップ');
            }
            return { handled: false, reactionType: 'emergency' };
        }

        const message = this.buildEmergencyMessage(eventData);
        const clearanceRadius = this.emergencyClearanceRadius();
        const suffocationEmergency = eventData.eventType === 'suffocation';
        const hostileEmergency = !suffocationEmergency && (eventData.eventType === 'hostile_approach'
            || eventData.eventType === 'damage' && !!eventData.possibleSource && eventData.possibleSource !== 'unknown'
            || this.combat.scanCurrentHostiles(clearanceRadius).length > 0);
        this.hostileContainmentActive = hostileEmergency;
        this.stopHostileRecovery();
        this.stopSuffocationRecovery();
        if (suffocationEmergency) this.startSuffocationContainment();
        log.error(`🚨 緊急対応: ${message}`);
        this.noteInterruption(eventData);

        try {
            // The fast classifier starts in parallel with deterministic containment. A slow or
            // unavailable model can never delay the existing immediate escape.
            let reflexWorld = captureWorldObservation(this.bot);
            let reflexRequestedAt = Date.now();
            const reflexInput = () => ({
                event: structuredClone(eventData) as unknown as Record<string, unknown>, world: reflexWorld,
                currentTaskActive: this.taskRuntime.isRunning(), availableCapabilities: [
                    ...this.bot.instantSkills.getSkills().map(skill => skill.skillName),
                    ...this.bot.constantSkills.getSkills().filter(skill => skill.status).map(skill => skill.skillName),
                ],
            });
            const reflexPromise: Promise<ReflexDecision | null> = this.reflexPolicy
                ? this.reflexPolicy.decide(reflexInput())
                : Promise.resolve(null);

            this.bot.minebotControlState = 'emergency_reflect';
            // Hostile containment is horizontal escape. During suffocation it
            // would take the motor lease from the critical auto-swim reflex.
            this._llmHasControl = false;
            if (!suffocationEmergency) this.startContinuousFlee();

            // 2. 実行中タスクを中断し、isExecuting 解除を待つ
            await this.taskRuntime.interruptForEmergency(message);

            let reflexDecision = await reflexPromise;
            if (reflexDecision && this.reflexPolicy && (Date.now() - reflexRequestedAt > 1500
                || reflexFactsDigest(reflexWorld) !== reflexFactsDigest(captureWorldObservation(this.bot)))) {
                reflexWorld = captureWorldObservation(this.bot); reflexRequestedAt = Date.now();
                reflexDecision = await this.reflexPolicy.decide(reflexInput()); // one bounded refresh, never an infinite retry
            }
            if (reflexDecision) reflexDecision = { ...reflexDecision, stale: Date.now() - reflexRequestedAt > 1500
                || reflexFactsDigest(reflexWorld) !== reflexFactsDigest(captureWorldObservation(this.bot)) };
            if (appConfig.minecraftCognition.mode === 'feedback' && reflexDecision && ['SURFACE', 'EAT', 'STOP_MOVEMENT'].includes(reflexDecision.immediateAction)) {
                this.stopContinuousFlee();
                await this.fleeWork;
                const result = await executeDirectReflex(this.bot, reflexDecision, reflexWorld, reflexRequestedAt);
                log.info(`MINECRAFT_COGNITION_METRIC kind=direct_reflex applied=${result.applied} reason=${result.reason}`);
                if (!result.applied && !suffocationEmergency) this.startContinuousFlee();
            }
            if (reflexDecision) {
                log.info(
                    `⚡ ReflexPolicy(${reflexDecision.source}): ${reflexDecision.urgency} → ${reflexDecision.immediateAction}`
                    + ` (${reflexDecision.elapsedMilliseconds}ms)`,
                    'cyan',
                );
                log.info(
                    `MINECRAFT_COGNITION_METRIC kind=reflex mode=${appConfig.minecraftCognition.mode}`
                    + ` source=${reflexDecision.source} latency_ms=${reflexDecision.elapsedMilliseconds} stale=${reflexDecision.stale ?? false}`,
                );
            }
            const recommendation = appConfig.minecraftCognition.mode === 'feedback' && reflexDecision
                ? formatReflexRecommendation(reflexDecision)
                : null;
            // Survey only after the native survival capability had a chance to
            // acquire its lease; scanning loaded terrain must not delay the
            // first low-air response.
            const breathingEscape = suffocationEmergency ? this.describeBreathingEscape() : null;
            const taskMessage = [message, recommendation, breathingEscape].filter(Boolean).join('\n');

            const emergencyTaskInput: TaskStateInput = {
                userMessage: taskMessage,
                isEmergency: true,
                emergencyType: eventData.eventType,
                reflexDecision: reflexDecision ?? undefined,
                // Every emergency has an end the body itself can vouch for. One without (a hit from a fall,
                // from hunger) could not be completed at all: the planner's "done" was checked against no
                // condition and refused each time, and it went round reporting and waiting until its turn
                // limit, the main task held off the whole while (paid run L61: thirty turns at health 7 with
                // a rabbit in reach). What such an emergency can settle is that nothing is harming the body
                // now; what it could not settle (no food) goes back to the main task.
                goalContract: suffocationEmergency ? { goal: taskMessage, predicates: [{ kind: 'breathing_safe' }] }
                    : hostileEmergency ? { goal: taskMessage,
                        predicates: [{ kind: 'hostiles_clear', radius: clearanceRadius }] }
                    : { goal: taskMessage, predicates: [{ kind: 'breathing_safe' }, { kind: 'hostiles_clear', radius: clearanceRadius }] },
                onToolStarting: (toolName, args) => this.onEmergencyToolStarting(toolName, args, hostileEmergency, suffocationEmergency),
                onToolFinished: event => this.onEmergencyToolFinished(event, hostileEmergency, suffocationEmergency),
            };
            this.taskRuntime.setEmergencyTask(emergencyTaskInput);

            // 3. LLM ベースの緊急タスクを実行
            const emergencyResult = await this.taskRuntime.invoke(emergencyTaskInput);

            if (hostileEmergency && !await this.waitForStableHostileClearance(clearanceRadius)) {
                log.warn(`緊急対応は未解決: 半径${clearanceRadius}mに敵対Mobが残存。元タスクは一時停止を維持し、逃走を継続`);
                if (this.combat.scanCurrentHostiles(clearanceRadius).length > 0 && !this.fleeController) this.startContinuousFlee();
                this.watchHostileRecovery(clearanceRadius);
                return { handled: false, reactionType: 'emergency', message };
            }
            if (suffocationEmergency && !await this.waitForStableBreathingClearance()) {
                log.warn('窒息緊急対応は未解決: 酸素・水・身体周囲のnative安全確認が不足。元タスクは一時停止を維持');
                this.watchSuffocationRecovery();
                return { handled: false, reactionType: 'emergency', message };
            }

            if ((hostileEmergency || suffocationEmergency) && emergencyResult?.taskTree?.status !== 'completed') {
                log.info(hostileEmergency
                    ? `緊急LLMタスクは未完了だが、半径${clearanceRadius}mの敵対Mob不在をnative観測で確認して元タスクを再開`
                    : '緊急LLMタスクは未完了だが、呼吸安全のnative観測で元タスクを再開');
            }

            // 4. 逃走停止（LLM が制御を取った場合は既に停止済みだがフォールバック）
            this.hostileContainmentActive = false;
            this.stopContinuousFlee();
            // What is still in sight now is what this emergency settled: the same mobs standing where they are do not
            // raise the next one (see CombatEventHandler.noteThreatsSettled).
            if (hostileEmergency) this.combat.noteThreatsSettled();
            if (suffocationEmergency) this.stopSuffocationContainment();

            // 5. 緊急タスク完了後、中断された元タスクを再開
            await this.giveTaskBack();

            return { handled: true, reactionType: 'emergency', message };
        } catch (error) {
            log.error('緊急対応エラー', error);
            if (hostileEmergency && this.combat.scanCurrentHostiles(clearanceRadius).length > 0) {
                if (!this.fleeController) this.startContinuousFlee();
                this.watchHostileRecovery(clearanceRadius);
            } else if (suffocationEmergency) {
                this.watchSuffocationRecovery();
            } else if (!hostileEmergency) {
                this.stopContinuousFlee();
            }
            this.bot.minebotControlState = hostileEmergency ? 'emergency_reflect' : 'idle';
            return { handled: false, reactionType: 'emergency', message };
        }
    }

    /**
     * タスクイベントを処理
     */
    private async handleTaskEvent(
        eventData: EventData,
        taskOverrides: Partial<TaskStateInput> = {},
    ): Promise<EventReactionResult> {
        if (!this.taskRuntime.isReady()) {
            return { handled: false, reactionType: 'task' };
        }

        const message = this.buildTaskMessage(eventData);
        log.info(`📋 タスク生成: ${message}`);

        try {
            const result = this.taskRuntime.addTaskToQueue({
                userMessage: message,
                isEmergency: false,
                ...taskOverrides,
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
            const mobSummary = ha.allHostiles.map(h => `${h.mobType}(${h.distance}m${h.arrivesInSeconds !== undefined ? `・約${h.arrivesInSeconds}秒で届く` : ''})`).join(', ');
            return `緊急: 敵対Mob ${ha.mobCount}体が接近中 [${mobSummary}]。${EMERGENCY_HOSTILE_GUIDANCE_JA}${this.describeReach()}${this.describeFightOdds()}`;
        }
        const message = CombatEventHandler.buildEmergencyMessage(eventData) || '緊急事態が発生した';
        return eventData.eventType === 'damage' && message.includes(EMERGENCY_HOSTILE_GUIDANCE_JA) ? message + this.describeReach() + this.describeFightOdds() : message;
    }

    /**
     * What the body's own measurements say of fighting what is near, for the planner to weigh. An emergency used
     * to forbid attack outright, and getting out of reach was all a planner could choose: with one skeleton
     * standing eighteen blocks off it shut itself in a shaft, came out, and was in the next emergency, eight
     * times in four minutes, forty blocks from the fortress it was going to (paid run L77h; L72 went round the
     * same way with a creeper). The race is the one the cornered counterattack is decided by: the time to kill
     * with the best weapon carried, from fights it has had, against the time everything near would take to
     * kill it, from hits it has taken. Said only for one or two mobs; more is not a fight to offer.
     */
    private describeFightOdds(): string {
        try {
            const odds = this.fightOdds();
            if (!odds.length) return '';
            const lines = odds.map(entry => {
                const kill = (entry.estimate.timeToKillMs / 1000).toFixed(0);
                const die = Number.isFinite(entry.estimate.timeToDieMs) ? `約${(entry.estimate.timeToDieMs / 1000).toFixed(0)}秒` : '被弾の実測なし';
                const closing = entry.closingMs > 0 ? `、いま${entry.distance.toFixed(0)}m先で、近づくまで約${(entry.closingMs / 1000).toFixed(0)}秒は撃たれ続ける` : '';
                return `${entry.name}: ${entry.estimate.weapon ?? '素手'}で倒すまで約${kill}秒、倒されるまで${die}${closing} → ${entry.faster ? '倒す方が早い' : '倒し切れない見込み（戦わない）'}`;
            });
            return ` 【実測・戦う場合】${lines.join('、')}。隠れても同じ相手が居座って進めない時は、「倒す方が早い」相手を attack-nearest で倒してよい（盾があれば構える）。`;
        } catch { return ''; }
    }

    /** A mob's health as the server gives it (its entity data), or undefined when that cannot be read. */
    private healthOf(entity: any): number | undefined {
        const keys = (this.bot as any).registry?.entitiesByName?.[String(entity?.name ?? '')]?.metadataKeys;
        const index = Array.isArray(keys) ? keys.indexOf('health') : -1;
        const value = index >= 0 ? entity?.metadata?.[index] : undefined;
        return typeof value === 'number' && value > 0 ? value : undefined;
    }

    /** The race against each hostile near enough to matter, when there are one or two of them (see describeFightOdds). */
    private fightOdds(): Array<{ name: string; estimate: ReturnType<typeof estimateEncounter>; faster: boolean; distance: number; closingMs: number }> {
        const near = this.hostilesAround(this.emergencyClearanceRadius()).filter(entry => isExposedTo(this.bot as any, entry.entity));
        if (near.length === 0 || near.length > 2) return [];
        const stats = this.encounters.stats();
        const carried = [...new Set((this.bot.inventory?.items?.() ?? []).map((item: any) => String(item.name)))];
        const health = this.bot.health ?? 20;
        // As it would be once the fight is on: everything near in contact.
        const inContact = near.map(entry => ({ name: entry.name, distance: 0 }));
        return near.map(entry => {
            const estimate = estimateEncounter(stats, { wearCost: WEAPON_WEAR, target: entry.name, health, threats: inContact, carried, escapeFailing: true, targetHealth: this.healthOf(entry.entity) });
            // A kind that hits from where it stands goes on hitting while the body walks up to it: that walk is
            // part of the race. Left out, a blaze twenty-nine blocks off in the air was "faster to kill" at three
            // seconds against five (paid run L77j). One that has to come to the body costs it nothing to wait for.
            const gap = Math.max(0, entry.distance - CONTACT_DISTANCE);
            // Not for a kind whose shots a reflex answers (a shield on the arm): that walk is made behind it.
            const closingMs = attackReach(stats, entry.name) >= gap && gap > 0 && !answeredByReflex(this.bot, entry.name)
                ? (gap / WALK_BLOCKS_PER_SECOND) * 1000 : 0;
            return { name: entry.name, estimate, faster: false, distance: entry.distance, closingMs };
        }).map((entry, _index, all) => {
            // The race is against all of them: the others go on hitting while one is being killed, so the time
            // that counts is the time to kill every one near (two wither skeletons were each "two seconds to
            // kill, nine to die", and the body died with one of them dead: lab continuation L77q). And a margin
            // for what the measures leave out (a miss, a step back).
            const killAllMs = all.reduce((sum, other) => sum + other.estimate.timeToKillMs, 0);
            const closingMs = Math.max(...all.map(other => other.closingMs));
            const faster = all.every(other => other.estimate.fight && !other.estimate.lethalBurst) && health >= 10
                && closingMs + killAllMs * 1.5 < entry.estimate.timeToDieMs;
            return { ...entry, faster };
        });
    }

    /** What the body has measured about the mobs now near it, for the planner: a fact, not an order. */
    private describeReach(): string {
        const kinds = this.reachingKinds();
        if (!kinds.length) return '';
        return ` 【実測】${kinds.map(kind => `${kind.name}はこれまで最大${kind.reach.toFixed(0)}m先から当ててきた`).join('、')}。`
            + `この相手は${Math.ceil(Math.max(...kinds.map(kind => kind.reach)) + REACH_MARGIN)}m以上離れるか、視線を切るまで緊急対応は完了しない。`;
    }

    private describeBreathingEscape(): string {
        if (!this.bot.entity) return '現在位置が未取得。呼吸安全のnative観測を優先して。';
        try {
            const scan = scanDryFootholds(this.bot, { radius: 8, maxVertical: 12, maxCandidates: 3 });
            const candidates = scan.candidates.length
                ? scan.candidates.map(site => `(${site.x.toFixed(1)},${site.y},${site.z.toFixed(1)})`+
                    ` 水平${site.horizontalDistance.toFixed(1)}m・高低差${site.verticalDelta.toFixed(1)}m・足場${site.groundBlock}`).join('; ')
                : 'ロード済み近傍には未発見';
            const survey = this.bot.instantSkills.getSkill('find-dry-footholds')
                ? '移動後や候補が塞がれている場合は find-dry-footholds で再観測できる。' : '';
            return `呼吸安全は、頭が水面より上に出て酸素が回復し、身体が埋まっていないことをnativeで確認する。頭が水中のままなら酸素20でも未完了。足が水中でも頭が出ていれば完了で、岸へ上がるかどうかは元の作業で判断する。`+
                `乾いた立地点の幾何候補: ${candidates}。候補は経路到達性・水流・敵の安全を保証しない。`+
                `水面から横方向の短い移動で到達可能か判断し、移動後に呼吸と足場を再確認して。`+
                `足場のない水中で高さだけを指定した移動や、所持していないブロックによる直上登りを成功扱いしない。${survey}`;
        } catch (error) {
            log.warn(`呼吸緊急の地形候補観測失敗: ${String(error)}`);
            return '乾いた立地点の地形候補は未確認。短い横方向の脱出路を観測し、呼吸安全をnativeで再確認して。';
        }
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

    private scheduleHostileContainmentRenewal(): void {
        if (!this.hostileContainmentActive || this._llmHasControl || this.fleeRenewalTimer
            || !this.bot.entity || this.bot.health <= 0
            || this.combat.scanCurrentHostiles(this.hostileClearanceRadius()).length === 0) return;
        // A bounded action lease can expire or fail before the planner takes over.
        // Retry at tick cadence, not in a tight loop or a paid model retry.
        this.fleeRenewalTimer = setTimeout(() => {
            this.fleeRenewalTimer = null;
            if (this.hostileContainmentActive && !this._llmHasControl && !this.fleeController
                && this.bot.entity && this.bot.health > 0
                && this.combat.scanCurrentHostiles(this.hostileClearanceRadius()).length > 0) this.startContinuousFlee();
        }, EventReactionSystem.FLEE_TICK_MS);
    }

    private startContinuousFlee(): void {
        if (this.counterattackRunning || this.fendRunning) return; // the counterattack (or fend-off) hands back to containment when it ends
        // Flee pathing may dig, so from a sealed shaft it can only break the walls
        // open. Hold while sealed and unhurt; a hit means the shelter failed.
        if (this.isSealedInShelter() && Date.now() - this.lastDamageAt > 3_000) {
            this.stopContinuousFlee();
            log.debug('縦穴の中で封鎖済みのため逃走せず待機');
            return;
        }
        this.stopContinuousFlee(); // 既存の逃走があれば停止

        if (!this.bot.entity) return;
        // Horizontal escape must not hold the bot underwater while air is short.
        if (this.suffocationContainmentActive && this.breathingAtRisk()) return;
        this._llmHasControl = false;
        this.handedOffTool = null;
        this.fleeGoal = null;
        this.fleeHeading = null;
        this.fleeBlocked = [];
        this.fleeProgress = null;
        this.fleeMovementsSet = false;
        this.fleeMayWork = null;
        const controller = new AbortController();
        this.fleeController = controller;
        cancelNonSurvivalActions(this.bot, 'emergency_containment');
        this.fleeWork = (async () => {
            if (controller.signal.aborted) return;
            await withActionSignal(this.bot, controller.signal, () => executeAction(this.bot, 'flee-from', EventReactionSystem.MAX_FLEE_DURATION_MS, async () => {
                const startTime = Date.now();
                while (!this._llmHasControl && Date.now() - startTime < EventReactionSystem.MAX_FLEE_DURATION_MS) {
                    this.updateFleeDirection();
                    await actionDelay(this.bot, EventReactionSystem.FLEE_TICK_MS);
                }
                this.bot.pathfinder.stop(); this.bot.clearControlStates();
                return { success: true, result: 'containment ended' };
            }, { priority: 200, waitForQuiescence: true }));
        })().catch(error => log.warn(`逃走所有権: ${String(error)}`)).finally(() => {
            if (this.fleeController === controller) {
                this.fleeController = null;
                this.scheduleHostileContainmentRenewal();
            }
        });
    }

    /**
     * Fleeing is the default answer to hostiles, but one zombie in a tunnel
     * keeps pace with a pathfinding bot. A paid run carrying an iron pickaxe
     * was hit six times while walking away and died. Once flight is the active
     * response and the same lone melee mob still lands repeated hits, the bot
     * strikes back natively instead of turning its back again.
     */
    private onHealthSample(): void {
        const health = this.bot.health ?? 20;
        const previous = this.lastHealthSample;
        this.lastHealthSample = health;
        if (previous === null || health >= previous || health <= 0) return;
        // Attribute the hit to the entity the server named as its cause. A
        // hit without a cause (a fall, drowning) belongs to no mob: guessing
        // "the nearest hostile" made a 10-damage fall look like a spider's
        // one-shot and called off a winning fight (paid run L7).
        const now = Date.now();
        const hurt = this.lastHurt && now - this.lastHurt.at < 500 ? this.lastHurt : null;
        const attacker = hurt ? hurt.source : this.likelyAttacker();
        if (!attacker) return;
        const ownBlow = !!this.lastBlow && now - this.lastBlow.at < 500 && this.lastBlow.cause === attacker;
        this.encounters.recordHit(attacker, previous - health, hurt?.source === attacker ? hurt.from : undefined, ownBlow);
        this.recentHits = [...this.recentHits.filter(at => now - at < COUNTER_HIT_WINDOW_MS), now];
        const plan = this.corneredCounterattackPlan();
        if (plan) void this.runCorneredCounterattack(plan.target, plan.weapon, plan.reason);
    }

    /**
     * Air actually at stake: a body cell buried in blocks, or under water with
     * too little air left to swim up with a margin. Being wet is not: treating
     * "not yet verified dry" as a breathing emergency cancelled every escape
     * and fight while a drowned killed a bot with full air (paid run L14).
     */
    private breathingAtRisk(): boolean {
        if (this.buriedBodyBlock()) return true;
        return (this.bot.entity as any)?.isInWater === true && airRunningOut(this.bot as any);
    }

    /** Feet and head cells walled on all four sides with a solid roof: mobs cannot reach in. */
    private isSealedInShelter(): boolean { return isSealedIn(this.bot as any); }

    private hostilesAround(radius: number): Array<{ entity: any; name: string; distance: number }> {
        if (!this.bot.entity) return [];
        const origin = this.bot.entity.position;
        return Object.values(this.bot.entities ?? {})
            .filter((entity: any) => entity && entity !== this.bot.entity && entity.id !== this.bot.entity.id && entity.position
                && isHostileEntity(entity, this.bot as any))
            .map((entity: any) => ({ entity, name: String(entity.name).toLowerCase(), distance: origin.distanceTo(entity.position) }))
            .filter(entry => entry.distance <= radius)
            .sort((a, b) => a.distance - b.distance);
    }

    /** The nearest hostile in contact, else the nearest within shooting range, as the source of a hit. */
    private likelyAttacker(): string | null {
        const near = this.hostilesAround(24);
        const contact = near.find(entry => entry.distance <= CONTACT_DISTANCE + 0.5);
        return (contact ?? near[0])?.name ?? null;
    }

    private sampleContact(): void {
        for (const entry of this.hostilesAround(CONTACT_DISTANCE)) this.encounters.recordContact(entry.name, CONTACT_SAMPLE_MS);
    }

    /**
     * Strike back only when the escape is demonstrably failing (repeated hits
     * while fleeing) and the measured race favours the bot against everything
     * in contact. No mob list or weapon table: the estimate uses the bot's own
     * statistics, seeded with human priors.
     */
    private corneredCounterattackPlan(): { target: any; weapon: string | null; reason: string } | null {
        // One blow from something in contact is enough to know: a mob that fights hand to hand has caught the body
        // up, and the next blow is a second away. Waiting for a second one gave it that blow free (paid run L77t:
        // the first of six, a second apart, all of them taken before the body struck twice).
        if (this.counterattackRunning || this.recentHits.length < 1 || !this.bot.entity) return null;
        if (!this.hostileContainmentActive && !this.taskRuntime.isInEmergencyMode?.()) return null;
        if (this.breathingAtRisk()) return null;
        const threats = this.hostilesAround(16);
        const target = threats[0];
        if (!target || target.distance > CONTACT_DISTANCE) return null;
        const carried = [...new Set((this.bot.inventory?.items?.() ?? []).map((item: any) => String(item.name)))];
        const estimate = estimateEncounter(this.encounters.stats(), { wearCost: WEAPON_WEAR, target: target.name, health: this.bot.health ?? 20,
            threats: threats.map(entry => ({ name: entry.name, distance: entry.distance })), carried, escapeFailing: true, targetHealth: this.healthOf(target.entity) });
        this.learningNote?.('encounter_decision', { target: target.name, fight: estimate.fight, estimate },
            `遭遇判断: ${target.name} → ${estimate.fight ? '反撃' : '逃走継続'} (${estimate.reason})`);
        // Something in contact that fights hand to hand has already caught the body: turning away or going on
        // with the shelter gives it the next blows free (paid run L77y: building a shelter with a wither skeleton
        // at its side, struck six times in four seconds, never struck back). With a weapon in hand, the body
        // strikes back unless something near can kill it in one blow; the race decides only for bare hands.
        const fight = !estimate.lethalBurst && (estimate.weapon !== null || estimate.fight);
        return fight ? { target: target.entity, weapon: estimate.weapon, reason: estimate.reason } : null;
    }

    private async runCorneredCounterattack(target: any, weapon: string | null, reason = ''): Promise<void> {
        this.counterattackRunning = true;
        this.stopContinuousFlee();
        const targetName = String(target.name).toLowerCase();
        log.warn(`⚔️ 逃走中に${targetName}に追いつかれて被弾し、計測上は倒し切れる → ${weapon ?? '素手'}で反撃 (${reason})`);
        let swings = 0;
        let outcome = 'timeout';
        let startedAt = Date.now();
        let defeated = 0;
        // A fight the body has taken up, like one the planner chose: the shield is up between its blows, and being
        // near this kind or struck by it is not a new emergency while it lasts (utils/engagement.ts).
        const endEngagement = beginEngagement(this.bot as any, [targetName]);
        try {
            cancelNonSurvivalActions(this.bot, 'emergency_counterattack');
            await executeAction(this.bot, 'attack-nearest', COUNTER_MAX_MS, async () => {
                try { this.bot.pathfinder?.stop(); } catch { /* keep fighting */ }
                this.bot.clearControlStates();
                const item = weapon ? this.bot.inventory.items().find((entry: any) => entry.name === weapon) : null;
                if (item) { try { await this.bot.equip(item, 'hand'); } catch { /* swing with what is held */ } }
                startedAt = Date.now();
                let lastSwing = 0;
                let lastCheck = startedAt;
                while (Date.now() - startedAt < COUNTER_MAX_MS) {
                    let entity: any = this.bot.entities?.[target.id];
                    if (!entity || entity.isValid === false) {
                        // That one is down. Whatever else of its kind is on the body is the same fight, not a new one
                        // to be asked about after two more blows.
                        defeated++;
                        const next = this.hostilesAround(CONTACT_DISTANCE + 1).find(entry => entry.name === targetName && entry.entity.id !== target.id);
                        if (!next) { outcome = 'defeated'; break; }
                        target = next.entity;
                        entity = next.entity;
                    }
                    if (!this.bot.entity || this.bot.health <= 0) { outcome = 'dead'; break; }
                    if (this.breathingAtRisk()) { outcome = 'air'; break; }
                    const distance = this.bot.entity.position.distanceTo(entity.position);
                    if (distance > CONTACT_DISTANCE + 1) { outcome = 'separated'; break; }
                    if (Date.now() - lastCheck >= FIGHT_RECHECK_MS) {
                        lastCheck = Date.now();
                        const carried = weapon ? [weapon] : [];
                        const recheck = estimateEncounter(this.encounters.stats(), { wearCost: WEAPON_WEAR, target: targetName, health: this.bot.health ?? 20,
                            threats: this.hostilesAround(16).map(entry => ({ name: entry.name, distance: entry.distance })),
                            carried, escapeFailing: true, elapsedMs: Date.now() - startedAt });
                        // Once caught, letting go is not an escape: the body stood still and was struck four times in
                        // two seconds after a recheck called the race lost one blow in (paid run L77x). The fight is let go
                        // of only for what can kill in one blow; standing and striking with the shield up between blows
                        // beat three wither skeletons in the lab where running past them died.
                        if (recheck.lethalBurst) { outcome = `unfavorable (${recheck.reason})`; break; }
                    }
                    await this.bot.lookAt(entity.position.offset(0, (entity.height ?? 1.8) * 0.85, 0), true);
                    this.bot.setControlState('forward', distance > 2.6);
                    if (distance <= 3 && Date.now() - lastSwing >= this.swingIntervalMs) {
                        this.bot.attack(entity);
                        lastSwing = Date.now();
                        swings++;
                    }
                    await actionDelay(this.bot, 50);
                }
                this.bot.clearControlStates();
                return { success: outcome === 'defeated', result: `counterattack ${outcome}` };
            }, { priority: 200, waitForQuiescence: true });
        } catch (error) {
            outcome = `error: ${String(error)}`;
        } finally {
            const elapsedMs = Date.now() - startedAt;
            endEngagement();
            this.encounters.recordFight(weapon, targetName, { killed: outcome === 'defeated' || defeated > 0, elapsedMs: defeated > 1 ? Math.round(elapsedMs / defeated) : elapsedMs });
            this.learningNote?.('encounter_outcome', { target: targetName, weapon, outcome, swings, elapsedMs, health: this.bot.health },
                `反撃の結果: ${targetName} ${outcome}（${weapon ?? '素手'}、${swings}回、${(elapsedMs / 1000).toFixed(1)}秒、HP=${this.bot.health}）`);
            this.counterattackRunning = false;
            this.recentHits = [];
            log.info(`⚔️ 反撃終了: ${outcome}（${swings}回攻撃、HP=${this.bot.health}）`);
            if (this.hostileContainmentActive && !this.fleeController
                && this.combat.scanCurrentHostiles(this.hostileClearanceRadius()).length > 0) this.startContinuousFlee();
        }
    }

    /**
     * While the body runs, whether the run is working: the gap to a pursuer that has kept shrinking for a second
     * and a half, with it on the body within a few seconds at that rate, is a race being lost (see losingRace).
     * Then the body stops turning its back and answers what is coming, chosen by what it has measured of it:
     * the cornered counterattack, begun before the first blow instead of after it, for what hurts in ordinary
     * blows; for what can take all the health at once, a fend-off. In paid run L110 a creeper closed from 12 m
     * to 1 m over thirteen seconds of "fleeing" (the route had stopped to lay a block) and the body was blown up.
     */
    private checkLosingRace(): void {
        try {
            if (this.counterattackRunning || this.fendRunning || !this.bot.entity || (this.bot.health ?? 0) <= 0) return;
            if (!this.hostileContainmentActive && !this.taskRuntime.isInEmergencyMode?.()) return;
            // Only a body that is running can be losing a race: one walled into its shelter is not.
            if (!this.fleeController && !this.handedOffTool) return;
            if (this.breathingAtRisk()) return;
            const now = Date.now();
            for (const [id, mark] of this.pursuerAnswers) {
                if (!this.bot.entities?.[id] || now - Math.max(mark.endedAt, ...mark.times) > PURSUER_REPEAT_WINDOW_MS) this.pursuerAnswers.delete(id);
            }
            // One just dealt with is left alone for a few seconds, unless it is nearer than it was when the answer
            // began or the body has been hurt since.
            const losing = losingPursuit(this.bot as any, (entity, distance) => {
                const mark = this.pursuerAnswers.get(entity.id);
                return !!mark && mark.endedAt > 0 && now - mark.endedAt < PURSUER_COOLDOWN_MS
                    && distance >= mark.startDistance && (this.bot.health ?? 20) >= mark.health;
            });
            if (!losing) return;
            const previous = this.pursuerAnswers.get(losing.entity.id);
            const repeats = previous?.times.filter(at => now - at < PURSUER_REPEAT_WINDOW_MS).length ?? 0;
            const mark = { startDistance: losing.distance, endedAt: 0, health: this.bot.health ?? 20, times: [...(previous?.times ?? []), now] };
            this.pursuerAnswers.set(losing.entity.id, mark);
            const settle = () => { mark.endedAt = Date.now(); mark.health = this.bot.health ?? 20; };
            const stats = this.encounters.stats();
            const health = this.bot.health ?? 20;
            const carried = [...new Set((this.bot.inventory?.items?.() ?? []).map((item: any) => String(item.name)))];
            const estimate = estimateEncounter(stats, { wearCost: WEAPON_WEAR, target: losing.name, health, carried, escapeFailing: true,
                threats: this.hostilesAround(16).map(entry => ({ name: entry.name, distance: entry.distance })), targetHealth: this.healthOf(losing.entity) });
            // Something near that can kill in one blow (the pursuer itself or another) is not one to close with.
            const maxHit = Math.max(stats.mobs[losing.name]?.maxHit ?? 0, estimate.lethalBurst ? health : 0);
            const counter = counterFor({ maxHit, health, armed: estimate.weapon !== null, fightFavoured: estimate.fight,
                distance: losing.distance, contactReach: CONTACT_DISTANCE, repeats });
            const answer = counter === 'fight' ? '反撃' : counter === 'meet' ? `立ち止まって迎え撃つ（直近${repeats + 1}回目、逃げ切れない相手）` : '向き直って押し返しながら下がる';
            const line = `逃走が${losing.name}に追いつかれつつある（${losing.distance.toFixed(1)}m、毎秒${losing.closing.toFixed(1)}mずつ縮む、`
                + `約${losing.contactIn.toFixed(1)}秒で接触）→ ${answer}（${estimate.reason}）`;
            log.warn(`🏃 ${line}`);
            this.learningNote?.('losing_escape', { target: losing.name, distance: losing.distance, closing: losing.closing, counter, repeats }, line);
            const run = counter === 'fight' ? this.runCorneredCounterattack(losing.entity, estimate.weapon, estimate.reason)
                : this.runFendOff(losing.entity, estimate.weapon, counter === 'meet' ? 'meet' : 'keep-off');
            void Promise.resolve(run).finally(settle);
        } catch (error) {
            log.warn(`逃走の成否の確認に失敗（無視して続行）: ${String(error)}`);
        }
    }

    /**
     * Facing a pursuer the run was losing to and keeping it off: the look on it, backing away (a body walks
     * backward faster than a zombie or a creeper comes, and sees where it goes wrong), stepping aside when the
     * way back is blocked, and striking it whenever it comes within a blow: a blow knocks any mob back, and
     * something whose danger is a fuse or one great blow is kept beyond it. The shield, carried, is up between
     * blows (the engagement turns the shield's guard on). Ends when the pursuer is beyond FEND_CLEAR_DISTANCE,
     * gone, or after FEND_MAX_MS; the escape then resumes, and is watched again.
     */
    private async runFendOff(target: any, weapon: string | null, mode: 'keep-off' | 'meet' = 'keep-off'): Promise<void> {
        this.fendRunning = true;
        this.stopContinuousFlee();
        const targetName = String(target.name).toLowerCase();
        let swings = 0;
        let outcome = 'timeout';
        const startedAt = Date.now();
        const limitMs = mode === 'meet' ? COUNTER_MAX_MS : FEND_MAX_MS;
        const startDistance = this.bot.entity && target.position ? this.bot.entity.position.distanceTo(target.position) : 0;
        // Let go only once the gap is wider than where this began by a margin, and opening.
        const clearAt = Math.max(FEND_CLEAR_DISTANCE, startDistance + FEND_MARGIN);
        const recent: Array<{ at: number; distance: number }> = [];
        const endEngagement = beginEngagement(this.bot as any, [targetName]);
        try {
            cancelNonSurvivalActions(this.bot, 'emergency_fend_off');
            await executeAction(this.bot, mode === 'meet' ? 'attack-nearest' : 'fend-off', limitMs, async () => {
                try { this.bot.pathfinder?.stop(); } catch { /* keep fending */ }
                this.bot.clearControlStates();
                const item = weapon ? this.bot.inventory.items().find((entry: any) => entry.name === weapon) : null;
                if (item) { try { await this.bot.equip(item, 'hand'); } catch { /* strike with what is held */ } }
                let lastSwing = 0;
                let anchor = { x: this.bot.entity.position.x, z: this.bot.entity.position.z, at: Date.now() };
                let aside: 'left' | 'right' | null = null;
                while (Date.now() - startedAt < limitMs) {
                    const entity: any = this.bot.entities?.[target.id];
                    if (!entity || entity.isValid === false) { outcome = swings > 0 ? 'defeated_or_gone' : 'gone'; break; }
                    if (!this.bot.entity || this.bot.health <= 0) { outcome = 'dead'; break; }
                    if (this.breathingAtRisk()) { outcome = 'air'; break; }
                    const position = this.bot.entity.position;
                    const distance = position.distanceTo(entity.position);
                    const now = Date.now();
                    recent.push({ at: now, distance });
                    while (recent.length > 2 && now - recent[1].at >= 500) recent.shift();
                    const opening = now - recent[0].at >= 400 && distance - recent[0].distance >= 0.2;
                    if (distance >= clearAt && opening) { outcome = 'clear'; break; }
                    await this.bot.lookAt(entity.position.offset(0, (entity.height ?? 1.8) * 0.85, 0), true);
                    if (distance <= FEND_STRIKE_REACH && Date.now() - lastSwing >= this.swingIntervalMs) {
                        this.bot.attack(entity);
                        lastSwing = Date.now();
                        swings++;
                    }
                    if (mode === 'meet') {
                        // Stand and let it come; a step in when it is just beyond a blow.
                        this.bot.setControlState('back', false);
                        this.bot.setControlState('forward', distance > 2.6 && distance <= CONTACT_DISTANCE);
                        await actionDelay(this.bot, 50);
                        continue;
                    }
                    this.bot.setControlState('forward', false);
                    this.bot.setControlState('back', true);
                    if (Math.hypot(position.x - anchor.x, position.z - anchor.z) >= FEND_STUCK_METRES) {
                        anchor = { x: position.x, z: position.z, at: now };
                    } else if (now - anchor.at >= FEND_STUCK_MS) {
                        // The way back is blocked: step aside as well, the other side each time it stays blocked.
                        if (aside) this.bot.setControlState(aside, false);
                        aside = aside === 'left' ? 'right' : 'left';
                        this.bot.setControlState(aside, true);
                        anchor = { x: position.x, z: position.z, at: now };
                    }
                    await actionDelay(this.bot, 50);
                }
                this.bot.clearControlStates();
                return { success: ['clear', 'gone', 'defeated_or_gone'].includes(outcome), result: `${mode} ${outcome}` };
            }, { priority: 200, waitForQuiescence: true });
        } catch (error) {
            outcome = `error: ${String(error)}`;
        } finally {
            endEngagement();
            this.fendRunning = false;
            const elapsedMs = Date.now() - startedAt;
            this.learningNote?.('fend_off_outcome', { target: targetName, weapon, outcome, swings, elapsedMs, health: this.bot.health },
                `押し返しの結果: ${targetName} ${outcome}（${weapon ?? '素手'}、${swings}回、${(elapsedMs / 1000).toFixed(1)}秒、HP=${this.bot.health}）`);
            log.info(`🛡 ${mode === 'meet' ? '迎え撃ち' : '押し返し'}終了: ${targetName} ${outcome}（${swings}回攻撃、${(elapsedMs / 1000).toFixed(1)}秒、${startDistance.toFixed(1)}mから、HP=${this.bot.health}）`);
            if (this.hostileContainmentActive && !this.fleeController
                && this.combat.scanCurrentHostiles(this.hostileClearanceRadius()).length > 0) this.startContinuousFlee();
        }
    }

    /**
     * 継続逃走を停止し、制御状態をクリアする。
     */
    private stopContinuousFlee(): void {
        if (this.fleeRenewalTimer) clearTimeout(this.fleeRenewalTimer);
        this.fleeRenewalTimer = null;
        this.fleeController?.abort('containment_handoff');
        this.fleeController = null;
    }

    /**
     * 全敵対 Mob の位置から逃走先を計算し、pathfinder のゴールを更新する。
     * setGoal() はノンブロッキングなので 300ms ティックで繰り返し呼べる。
     */
    private updateFleeDirection(): void {
        try {
            if (!currentAction(this.bot) || actionSignal(this.bot)?.aborted) return;
            if (!this.bot.entity) return;

            const botPos = this.bot.entity.position;
            const hostiles = this.combat.scanCurrentHostiles();

            if (hostiles.length === 0) {
                try { this.bot.pathfinder.stop(); } catch { /* ignore */ }
                this.bot.clearControlStates();
                return;
            }

            // The heading that stays clear of all of them (the gap between pursuers, not the sum of
            // pushes away from each, which cancels when they are on two sides), kept while it holds good.
            const FLEE_DIST = 12;
            // A heading that does not take the body its own way (a cliff, water, a wall: the route goes round
            // or nowhere) is given up. Measured along the heading: going back and forth is not getting anywhere.
            const now = Date.now();
            const anchor = this.fleeProgress;
            if (this.fleeHeading && anchor) {
                const along = (botPos.x - anchor.x) * this.fleeHeading.x + (botPos.z - anchor.z) * this.fleeHeading.z;
                if (along >= FLEE_HEADING_PROGRESS_METRES) this.fleeProgress = { x: botPos.x, z: botPos.z, at: now };
                else if (now - anchor.at >= FLEE_HEADING_STALL_MS) {
                    this.fleeBlocked = [...this.fleeBlocked.slice(-3), this.fleeHeading];
                    this.fleeHeading = null;
                }
            }
            const heading = escapeHeading(botPos, hostiles.map(hostile => hostile.position), this.fleeHeading, FLEE_DIST, this.fleeBlocked);
            if (heading !== this.fleeHeading) this.fleeProgress = { x: botPos.x, z: botPos.z, at: now };
            this.fleeHeading = heading;
            const fleeX = botPos.x + heading.x * FLEE_DIST;
            const fleeZ = botPos.z + heading.z * FLEE_DIST;

            // setMovements and setGoal each reset the path and clear every control
            // state. Re-issuing both every 300ms halted the escape (and any jump or
            // sprint) several times a second, so a slower zombie kept catching up.
            // Configure once per escape; re-aim only on a real change of direction
            // or when the pathfinder has stopped.
            // With a pursuer near, a route that stops to dig or to lay a block is not an escape (see escapeMayWork).
            // Judged again as the pursuer comes: set once from where things stood when the run began (a zombie
            // at 14 m), it let the route lay a bridge with a creeper five blocks off (paid run L110).
            const mayWork = escapeMayWork(hostiles[0].distance);
            let reconfigured = false;
            if (!this.fleeMovementsSet || this.fleeMayWork !== mayWork) {
                try { setMovements(this.bot, false, true, true, true, mayWork, true, 1, false, true, 4, 10, mayWork); } catch { /* ignore */ }
                reconfigured = this.fleeMovementsSet;
                this.fleeMovementsSet = true;
                this.fleeMayWork = mayWork;
            }
            const previous = this.fleeGoal;
            if (reconfigured || !previous || Math.hypot(previous.x - fleeX, previous.z - fleeZ) > 4 || !this.bot.pathfinder.isMoving?.()) {
                this.fleeGoal = { x: fleeX, z: fleeZ };
                this.bot.pathfinder.setGoal(new pfGoals.GoalNearXZ(fleeX, fleeZ, 2));
            }

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
        if (this.contactSampler) clearInterval(this.contactSampler);
        this.contactSampler = null;
        this.stopContinuousFlee();
        this.stopHostileRecovery();
        this.stopSuffocationRecovery();
        this.stopSuffocationContainment();
    }
}
