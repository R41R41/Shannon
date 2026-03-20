/**
 * SelfImprovementDaemon — 睡眠時記憶統合（Self-Improvement Background Process）
 *
 * タスク完了後に失敗エピソードを蓄積し、一定条件でバックグラウンド分析を発火。
 * LLM を使って失敗パターンを分類し、プロンプトルール追加（Tier 1）や
 * スキルコード修正（Tier 2）を自動生成・適用する。
 *
 * Singleton — ParallelExecutor から fire-and-forget で呼ばれる。
 */

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLogger } from '../../../../../utils/logger.js';
import type { TaskEpisode } from '../TaskEpisodeMemory.js';
import type { MetaAssessment, BlackboardSnapshot } from '../CognitiveBlackboard.js';
import {
    DaemonStatus,
    FailureRecord,
    ImprovementRecord,
    TriggerContext,
    SELF_IMPROVE_CONSTANTS as C,
    SkillIdeation,
    SkillCreationRecord,
} from './types.js';
import { FailureAnalyzer } from './FailureAnalyzer.js';
import { ImprovementGenerator } from './ImprovementGenerator.js';
import { ImprovementApplier } from './ImprovementApplier.js';
import { EffectivenessTracker } from './EffectivenessTracker.js';
import { SkillIdeator } from './SkillIdeator.js';
import { SkillCodeGenerator } from './SkillCodeGenerator.js';
import { CodeValidator } from './CodeValidator.js';
import { SelfTestRunner } from './SelfTestRunner.js';
import type { SelfTestRunReport } from './types.js';

const log = createLogger('SelfImprove');

export class SelfImprovementDaemon {
    private static instance: SelfImprovementDaemon;

    // 失敗バッファ
    private failureBuffer: FailureRecord[] = [];

    // 実行履歴
    private runTimestamps: number[] = [];
    private lastRunAt: number | null = null;
    private isRunning = false;

    // 統計
    private totalImprovements = 0;
    private totalRollbacks = 0;

    // MetaCognition シグナルの蓄積
    private metaCognitionSignals: MetaAssessment[] = [];

    // サブコンポーネント（リアクティブ）
    private analyzer: FailureAnalyzer;
    private generator: ImprovementGenerator;
    private applier: ImprovementApplier;
    private tracker: EffectivenessTracker;

    // サブコンポーネント（プロアクティブ）
    private ideator: SkillIdeator;
    private codeGenerator: SkillCodeGenerator;
    private codeValidator: CodeValidator;

    // テストランナー
    private testRunner = new SelfTestRunner();

    // プロアクティブ統計
    private generatedSkillCount = 0;
    private skillCreationHistory: SkillCreationRecord[] = [];

    // Minebot 参照（外部から注入）
    private botRef: import('../../../../minebot/types.js').CustomBot | null = null;

    private constructor() {
        this.analyzer = new FailureAnalyzer();
        this.generator = new ImprovementGenerator();
        this.applier = new ImprovementApplier();
        this.tracker = new EffectivenessTracker();
        this.ideator = new SkillIdeator();
        this.codeGenerator = new SkillCodeGenerator();
        this.codeValidator = new CodeValidator();
    }

    static getInstance(): SelfImprovementDaemon {
        if (!SelfImprovementDaemon.instance) {
            SelfImprovementDaemon.instance = new SelfImprovementDaemon();
        }
        return SelfImprovementDaemon.instance;
    }

    /**
     * エピソード保存後に ParallelExecutor から呼ばれる（fire-and-forget）。
     * 失敗エピソードをバッファに追加し、トリガー条件を評価する。
     */
    async onEpisodeSaved(
        episode: TaskEpisode,
        snapshot?: BlackboardSnapshot,
    ): Promise<void> {
        try {
            // 効果測定の更新（成功・失敗問わず）
            this.tracker.onTaskCompleted(episode);

            // 生成スキルの使用追跡
            this.tracker.trackGeneratedSkillUsage(episode).catch(() => {});

            // プロアクティブ: 成功・失敗問わずツール列パターンを蓄積
            this.ideator.onEpisodeCompleted(episode);

            // プロアクティブ・スキル生成の評価
            if (this.ideator.shouldTriggerIdeation()) {
                this.executeProactiveIdeation().catch(err => {
                    log.error('プロアクティブ・スキル生成エラー', err);
                });
            }

            // 成功エピソードは失敗バッファに追加しない
            if (episode.success) return;

            const record: FailureRecord = {
                episode,
                metaAssessment: snapshot?.metaState?.assessment ?? null,
                forwardModelPatternCount: 0, // ForwardModel は per-task で生存しないため 0
                recordedAt: Date.now(),
            };

            this.failureBuffer.push(record);

            // バッファサイズ制限
            if (this.failureBuffer.length > C.MAX_FAILURE_BUFFER) {
                this.failureBuffer = this.failureBuffer.slice(-C.MAX_FAILURE_BUFFER);
            }

            log.info(
                `📥 失敗エピソード蓄積: "${episode.goal.substring(0, 40)}" ` +
                `(buffer: ${this.failureBuffer.length}/${C.MIN_FAILURE_BUFFER})`,
            );

            // MetaCognition シグナルを記録
            if (snapshot?.metaState?.assessment) {
                this.metaCognitionSignals.push(snapshot.metaState.assessment);
                if (this.metaCognitionSignals.length > 20) {
                    this.metaCognitionSignals = this.metaCognitionSignals.slice(-20);
                }
            }

            // トリガー条件を評価
            if (this.shouldTrigger()) {
                // fire-and-forget で非同期実行
                this.executeImprovement().catch(err => {
                    log.error('自己改善実行エラー', err);
                });
            }
        } catch (err) {
            log.error('onEpisodeSaved エラー', err);
        }
    }

    /**
     * MetaCognition から直接シグナルを受け取る（オプション）。
     */
    onMetaCognitionSignal(assessment: MetaAssessment): void {
        this.metaCognitionSignals.push(assessment);
        if (this.metaCognitionSignals.length > 20) {
            this.metaCognitionSignals = this.metaCognitionSignals.slice(-20);
        }
    }

    /**
     * デーモンの状態を取得（UI/デバッグ用）。
     */
    getStatus(): DaemonStatus {
        return {
            isRunning: this.isRunning,
            failureBufferSize: this.failureBuffer.length,
            lastRunAt: this.lastRunAt,
            totalImprovements: this.totalImprovements,
            totalRollbacks: this.totalRollbacks,
            runsInLastHour: this.getRunsInLastHour(),
            generatedSkillCount: this.generatedSkillCount,
            proactiveRunsInLastHour: this.ideator.getBufferStats().frequentPatterns,
        };
    }

    /**
     * Minebot の bot 参照を注入する。SkillAgent 初期化時に呼ばれる。
     */
    setBot(bot: import('../../../../minebot/types.js').CustomBot): void {
        this.botRef = bot;
    }

    /**
     * 注入された bot 参照を取得する（EffectivenessTracker 等から利用）。
     */
    getBot(): import('../../../../minebot/types.js').CustomBot | null {
        return this.botRef;
    }

    /**
     * ユーザーの明示的リクエストからスキルを生成する。
     * チャットで「こういうスキルを作って」と言われた場合に呼ばれる。
     */
    async onUserSkillRequest(description: string): Promise<SkillCreationRecord | null> {
        try {
            log.info(`📝 ユーザーからのスキル生成リクエスト: "${description.substring(0, 60)}"`);

            const ideation = await this.ideator.ideateFromUserRequest(description);
            if (!ideation) {
                log.info('スキル仕様の生成に失敗、または生成不要と判断');
                return null;
            }

            return await this.executeSkillCreation(ideation, `ユーザーリクエスト: ${description.substring(0, 60)}`);
        } catch (err) {
            log.error('ユーザーリクエスト処理エラー', err);
            return null;
        }
    }

    /**
     * 複数のテストスイートを順番に実行する（オーバーナイト用）。
     */
    async runMultipleSuites(
        suiteNames: string[],
        options?: { autoFix?: boolean; trigger?: 'manual' | 'auto' | 'api' },
    ): Promise<SelfTestRunReport | null> {
        if (!this.botRef) {
            log.warn('runMultipleSuites: bot が未設定');
            return null;
        }
        return this.testRunner.runMultiple(this.botRef, suiteNames, {
            autoFix: options?.autoFix ?? false,
            trigger: options?.trigger ?? 'api',
        });
    }

    /**
     * テストスイート JSON ファイルを指定してテストを実行する。
     * @param suiteName saves/minecraft/self_test_cases/{suiteName}.json
     */
    async runSelfTestFromFile(
        suiteName: string,
        options?: { autoFix?: boolean; trigger?: 'manual' | 'auto' | 'api' },
    ): Promise<SelfTestRunReport | null> {
        if (!this.botRef) {
            log.warn('runSelfTestFromFile: bot が未設定');
            return null;
        }
        return this.testRunner.runFromFile(this.botRef, suiteName, {
            autoFix: options?.autoFix ?? false,
            trigger: options?.trigger ?? 'api',
        });
    }

    /**
     * スキルの自律テスト + 自己修正を実行する（後方互換）。
     */
    async runSelfTest(
        skillNames?: string[],
        options?: { autoFix?: boolean; trigger?: 'manual' | 'auto' | 'api' },
    ): Promise<SelfTestRunReport | null> {
        if (!this.botRef) {
            log.warn('runSelfTest: bot が未設定');
            return null;
        }
        return this.testRunner.runTests(this.botRef, {
            skillNames,
            autoFix: options?.autoFix ?? true,
            trigger: options?.trigger ?? 'api',
        });
    }

    // ── トリガー条件評価 ──

    private shouldTrigger(): boolean {
        const ctx = this.buildTriggerContext();

        // 条件1: 失敗バッファが十分
        if (ctx.failureCount < C.MIN_FAILURE_BUFFER) return false;

        // 条件2: クールダウン
        if (ctx.timeSinceLastRun < C.MIN_COOLDOWN_MS) return false;

        // 条件3: 1時間あたりの上限
        if (this.getRunsInLastHour() >= C.MAX_RUNS_PER_HOUR) return false;

        // 条件4: 実行中でない
        if (this.isRunning) return false;

        // 条件5: 以下のいずれかを満たす
        const hasMetaSignal = ctx.hasMetaCognitionSignal;
        const hasRepeatedFailureType = Array.from(ctx.repeatedFailureTypes.values())
            .some(count => count >= C.REPEATED_FAILURE_THRESHOLD);
        const hasRepeatedSkillFailure = Array.from(ctx.repeatedSkillFailures.values())
            .some(count => count >= C.REPEATED_FAILURE_THRESHOLD);

        if (!hasMetaSignal && !hasRepeatedFailureType && !hasRepeatedSkillFailure) {
            return false;
        }

        log.info(
            `🔔 トリガー条件成立: failures=${ctx.failureCount}, ` +
            `metaSignal=${hasMetaSignal}, repeatedType=${hasRepeatedFailureType}, ` +
            `repeatedSkill=${hasRepeatedSkillFailure}`,
        );

        return true;
    }

    private buildTriggerContext(): TriggerContext {
        const now = Date.now();

        // failureType の集計
        const repeatedFailureTypes = new Map<string, number>();
        for (const record of this.failureBuffer) {
            for (const pattern of record.episode.failurePatterns) {
                const type = this.extractFailureType(pattern);
                repeatedFailureTypes.set(type, (repeatedFailureTypes.get(type) || 0) + 1);
            }
        }

        // skill 名の集計
        const repeatedSkillFailures = new Map<string, number>();
        for (const record of this.failureBuffer) {
            for (const pattern of record.episode.failurePatterns) {
                const skill = this.extractSkillName(pattern);
                if (skill) {
                    repeatedSkillFailures.set(skill, (repeatedSkillFailures.get(skill) || 0) + 1);
                }
            }
        }

        // MetaCognition シグナル: wrong_approach / stuck が最近あったか
        const hasMetaCognitionSignal = this.metaCognitionSignals
            .slice(-5)
            .some(a => a === 'wrong_approach' || a === 'stuck');

        return {
            failureCount: this.failureBuffer.length,
            timeSinceLastRun: this.lastRunAt ? now - this.lastRunAt : Infinity,
            repeatedFailureTypes,
            repeatedSkillFailures,
            hasMetaCognitionSignal,
        };
    }

    // ── 改善実行 ──

    private async executeImprovement(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        const runStart = Date.now();

        try {
            log.info('🧠 自己改善プロセス開始...');

            // Step 1: 失敗分析
            const analysisResult = await this.analyzer.analyze(this.failureBuffer);

            if (analysisResult.clusters.length === 0) {
                log.info('分析結果: 改善対象なし');
                return;
            }

            log.info(
                `📊 分析完了: ${analysisResult.clusters.length}件のクラスタ検出 ` +
                `(confidence: ${analysisResult.confidence.toFixed(2)})`,
            );

            // Step 2: 改善案生成
            const proposals = await this.generator.generate(analysisResult);

            if (proposals.length === 0) {
                log.info('改善案なし');
                return;
            }

            log.info(`💡 改善案生成: ${proposals.length}件`);

            // Step 3: 適用（Tier 1 のみ自動、Tier 2 はレビュー待ち）
            const records: ImprovementRecord[] = [];
            for (const proposal of proposals) {
                const record = await this.applier.apply(proposal);
                records.push(record);

                if (record.status === 'applied') {
                    this.totalImprovements++;
                    log.info(`✅ 改善適用: [Tier ${proposal.tier}] ${proposal.description}`);

                    // 効果測定を開始
                    this.tracker.startTracking(record);
                } else if (record.status === 'rejected') {
                    log.warn(`❌ 改善却下: ${record.validationErrors.join(', ')}`);
                } else if (record.status === 'pending_review') {
                    log.info(`👀 レビュー待ち: [Tier ${proposal.tier}] ${proposal.description}`);
                }
            }

            // 処理した失敗をバッファからクリア
            this.clearProcessedFailures(analysisResult.clusters);

        } catch (err) {
            log.error('自己改善プロセスエラー', err);
        } finally {
            this.isRunning = false;
            this.lastRunAt = Date.now();
            this.runTimestamps.push(Date.now());
            // 古いタイムスタンプを掃除
            const oneHourAgo = Date.now() - 3600_000;
            this.runTimestamps = this.runTimestamps.filter(t => t > oneHourAgo);

            log.info(`⏱️ 自己改善プロセス完了 (${((Date.now() - runStart) / 1000).toFixed(1)}s)`);
        }
    }

    // ── プロアクティブ・スキル生成 ──

    /**
     * 蓄積パターンからスキル提案を生成し、生成パイプラインへ渡す。
     */
    private async executeProactiveIdeation(): Promise<void> {
        try {
            this.ideator.recordRun();
            log.info('🔍 プロアクティブ・パターン分析開始...');

            const ideations = await this.ideator.analyzePatterns();
            if (ideations.length === 0) {
                log.info('パターン分析: 新スキル提案なし');
                return;
            }

            log.info(`💡 ${ideations.length}件のスキル提案を検出`);

            for (const ideation of ideations) {
                await this.executeSkillCreation(
                    ideation,
                    `パターン検出: ${ideation.rationale.substring(0, 60)}`,
                );
            }
        } catch (err) {
            log.error('プロアクティブ・スキル生成エラー', err);
        }
    }

    /**
     * SkillIdeation → コード生成 → 検証 → コンパイル → ホットロードのパイプライン。
     */
    private async executeSkillCreation(
        ideation: SkillIdeation,
        reason: string,
    ): Promise<SkillCreationRecord> {
        const record: SkillCreationRecord = {
            ideation,
            sourceFile: '',
            compiledFile: null,
            status: 'created',
            errors: [],
            createdAt: Date.now(),
        };

        try {
            // Step 1: コード生成
            log.info(`⚙️ スキルコード生成: ${ideation.name} (${ideation.type})`);
            const generated = await this.codeGenerator.generate(ideation);
            if (!generated) {
                record.status = 'validation_failed';
                record.errors.push('コード生成に失敗しました');
                this.skillCreationHistory.push(record);
                return record;
            }

            // Step 2: コード検証
            const existingSkillNames = this.getExistingSkillNames();
            const validation = this.codeValidator.validateGeneratedSkill(
                generated.code,
                generated.type,
                existingSkillNames,
            );

            if (!validation.valid) {
                record.status = 'validation_failed';
                record.errors = validation.errors;
                log.warn(`❌ スキル検証失敗 (${ideation.name}): ${validation.errors.join('; ')}`);
                this.skillCreationHistory.push(record);
                return record;
            }

            if (validation.warnings.length > 0) {
                log.info(`⚠️ スキル検証警告 (${ideation.name}): ${validation.warnings.join('; ')}`);
            }

            // Step 3: ファイル書き出し
            const { SkillCompiler } = await import('../../../../minebot/skills/SkillCompiler.js');
            const compiler = new SkillCompiler();
            await compiler.ensureGeneratedDirs();

            const subDir = generated.type === 'instant' ? 'instantSkills' : 'constantSkills';
            const fileName = `${ideation.name.replace(/-/g, '_')}.ts`;
            const projectRoot = process.cwd();
            const tsPath = join(projectRoot, 'src/services/minebot', subDir, 'generated', fileName);

            await writeFile(tsPath, generated.code, 'utf-8');
            record.sourceFile = tsPath;
            log.info(`📄 ソースコード保存: ${tsPath}`);

            // Step 4: コンパイル
            const compileResult = await compiler.compile(tsPath);
            if (!compileResult.success) {
                record.status = 'compile_failed';
                record.errors = compileResult.errors;
                log.warn(`❌ コンパイル失敗 (${ideation.name}): ${compileResult.errors.join('; ')}`);
                this.skillCreationHistory.push(record);
                return record;
            }

            record.compiledFile = compileResult.jsPath;

            // Step 5: ホットロード
            const { SkillHotLoader } = await import('../../../../minebot/skills/SkillHotLoader.js');
            const { SkillRegistrar } = await import('../../../../minebot/skills/SkillRegistrar.js');
            const { getEventBus } = await import('../../../../eventBus/index.js');
            const hotLoader = new SkillHotLoader(new SkillRegistrar(getEventBus()));

            // bot インスタンスを取得
            const bot = this.getMinebotInstance();
            if (!bot) {
                record.status = 'compile_failed';
                record.errors.push('Minebot インスタンスが利用できません');
                this.skillCreationHistory.push(record);
                return record;
            }

            const loadResult = generated.type === 'instant'
                ? await hotLoader.loadAndRegisterInstantSkill(compileResult.jsPath!, bot, reason)
                : await hotLoader.loadAndRegisterConstantSkill(compileResult.jsPath!, bot, reason);

            if (!loadResult.success) {
                record.status = 'compile_failed';
                record.errors.push(loadResult.error || 'ホットロード失敗');
                this.skillCreationHistory.push(record);
                return record;
            }

            record.status = 'loaded';
            this.generatedSkillCount++;
            log.info(`✅ スキル生成完了: ${loadResult.skillName} (${generated.type})`);

        } catch (err) {
            record.status = 'compile_failed';
            record.errors.push((err as Error).message);
            log.error(`スキル生成パイプラインエラー (${ideation.name})`, err);
        }

        this.skillCreationHistory.push(record);
        // 履歴は最大50件
        if (this.skillCreationHistory.length > 50) {
            this.skillCreationHistory = this.skillCreationHistory.slice(-50);
        }

        return record;
    }

    /**
     * 既存スキル名のリストを取得する。
     */
    private getExistingSkillNames(): string[] {
        try {
            const bot = this.getMinebotInstance();
            if (!bot) return [];
            const instantNames = bot.instantSkills.getSkills().map(s => s.skillName);
            const constantNames = bot.constantSkills.getSkills().map(s => s.skillName);
            return [...instantNames, ...constantNames];
        } catch {
            return [];
        }
    }

    /**
     * Minebot インスタンスを取得する。
     */
    private getMinebotInstance(): import('../../../../minebot/types.js').CustomBot | null {
        return this.botRef;
    }

    // ── ヘルパー ──

    private getRunsInLastHour(): number {
        const oneHourAgo = Date.now() - 3600_000;
        return this.runTimestamps.filter(t => t > oneHourAgo).length;
    }

    private extractFailureType(pattern: string): string {
        // "goal: reason" 形式から reason 部分を抽出
        const colonIdx = pattern.indexOf(':');
        if (colonIdx > 0) {
            return pattern.substring(colonIdx + 1).trim().substring(0, 50);
        }
        return pattern.substring(0, 50);
    }

    private extractSkillName(pattern: string): string | null {
        // スキル名っぽいパターンを抽出 (mine-block, dig-block-at, craft-one 等)
        const match = pattern.match(/\b([a-z]+-[a-z]+(?:-[a-z]+)*)\b/);
        return match?.[1] ?? null;
    }

    private clearProcessedFailures(clusters: Array<{ relatedRecordIndices: number[] }>): void {
        const processedIndices = new Set<number>();
        for (const cluster of clusters) {
            for (const idx of cluster.relatedRecordIndices) {
                processedIndices.add(idx);
            }
        }

        this.failureBuffer = this.failureBuffer.filter(
            (_, idx) => !processedIndices.has(idx),
        );
    }
}
