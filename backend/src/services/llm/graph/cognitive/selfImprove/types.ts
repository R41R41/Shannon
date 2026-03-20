/**
 * SelfImprovement — 共有型定義
 *
 * 自己改善デーモンで使用されるインターフェースと型。
 */

import type { TaskEpisode } from '../TaskEpisodeMemory.js';
import type { MetaAssessment } from '../CognitiveBlackboard.js';

// ── 失敗記録 ──

export interface FailureRecord {
    /** TaskEpisode から抽出 */
    episode: TaskEpisode;
    /** MetaCognition の評価（タスク完了時点） */
    metaAssessment: MetaAssessment | null;
    /** ForwardModel で学習済みのパターン数 */
    forwardModelPatternCount: number;
    /** 蓄積タイムスタンプ */
    recordedAt: number;
}

// ── 失敗分析結果 ──

export type RootCause =
    | 'skill_bug'             // InstantSkill のコードバグ
    | 'missing_precondition'  // ツール実行前の前提条件チェック不足
    | 'prompt_rule_missing'   // PromptBuilder のルール不足
    | 'recipe_missing'        // レシピ解決の不備
    | 'forward_model_gap'     // ForwardModel のルール不足
    | 'unknown';

export interface FailureCluster {
    rootCause: RootCause;
    /** 失敗パターンの要約 */
    summary: string;
    /** 関連する失敗レコードのインデックス */
    relatedRecordIndices: number[];
    /** 関連するスキル名 */
    affectedSkill: string | null;
    /** 繰り返し回数 */
    occurrenceCount: number;
    /** 推奨する改善ティア */
    suggestedTier: 1 | 2;
}

export interface FailureAnalysisResult {
    clusters: FailureCluster[];
    /** 分析に使った失敗レコード数 */
    analyzedCount: number;
    /** 分析の信頼度 (0-1) */
    confidence: number;
    timestamp: number;
}

// ── 改善提案 ──

export type ImprovementScope =
    | 'prompt_rule'      // PromptBuilder ルール追加
    | 'forward_model'    // ForwardModel ルール追加
    | 'recipe_override'  // レシピ補完
    | 'skill_code'       // TypeScript スキルコード修正
    | 'new_skill';       // 新規スキル追加

export interface ImprovementProposal {
    id: string;
    tier: 1 | 2;
    scope: ImprovementScope;
    /** 改善内容の説明 */
    description: string;
    /** 対象ファイルパス（Tier 2 のみ） */
    targetFile: string | null;
    /** 適用するパッチ/ルール内容 */
    content: string;
    /** 元になった失敗クラスタ */
    sourceCluster: FailureCluster;
    /** 生成タイムスタンプ */
    createdAt: number;
}

// ── 適用結果 ──

export type ApplyStatus = 'applied' | 'rejected' | 'rolled_back' | 'pending_review';

export interface ImprovementRecord {
    proposal: ImprovementProposal;
    status: ApplyStatus;
    /** 適用日時 */
    appliedAt: number | null;
    /** 検証結果 */
    validationErrors: string[];
    /** 効果測定 */
    effectiveness: EffectivenessMetrics | null;
    /** Git ブランチ名（Tier 2 のみ） */
    gitBranch: string | null;
}

// ── 効果測定 ──

export interface EffectivenessMetrics {
    /** 改善適用後のタスク数 */
    tasksSinceApplied: number;
    /** 同種の失敗が再発した回数 */
    sameFailureCount: number;
    /** 改善前の失敗率 */
    beforeFailureRate: number;
    /** 改善後の失敗率 */
    afterFailureRate: number;
    /** 最終計測日時 */
    measuredAt: number;
}

// ── Tier 1: ホットリロード用 JSON 構造 ──

export interface DynamicRule {
    id: string;
    /** 追加先 ('prompt' | 'forward_model') */
    target: 'prompt' | 'forward_model';
    /** ルール内容（プロンプト文 or ForwardModel 条件） */
    rule: string;
    /** 元の失敗パターン要約 */
    sourceFailure: string;
    /** 追加日時 */
    addedAt: number;
    /** 有効フラグ（ロールバック時に false） */
    enabled: boolean;
}

export interface SelfImprovementRulesFile {
    version: number;
    rules: DynamicRule[];
    lastUpdated: number;
}

// ── スキル発想（プロアクティブ） ──

export interface SkillIdeation {
    type: 'instant' | 'constant';
    /** kebab-case のスキル名 */
    name: string;
    description: string;
    /** なぜこのスキルが必要か */
    rationale: string;
    /** 元になったツール呼び出し列（InstantSkill の場合） */
    abstractedSequence?: string[];
    /** ConstantSkill の発動条件 */
    triggerCondition?: string;
    /** ConstantSkill の interval (ms) */
    suggestedInterval?: number;
    /** ConstantSkill の priority */
    suggestedPriority?: number;
    /** パラメータ定義 */
    params?: Array<{
        name: string;
        type: 'string' | 'number' | 'boolean';
        description: string;
        required: boolean;
    }>;
    /** 信頼度 (0-1) */
    confidence: number;
}

export interface ToolSequencePattern {
    /** ツール列のキー（例: "find-blocks->move-to->mine-block"） */
    key: string;
    /** 出現回数 */
    count: number;
    /** 最新のエピソード goal の例 */
    exampleGoals: string[];
    /** 最後に観測された時刻 */
    lastSeen: number;
}

export interface SkillCreationRecord {
    ideation: SkillIdeation;
    sourceFile: string;
    compiledFile: string | null;
    status: 'created' | 'compile_failed' | 'validation_failed' | 'loaded' | 'disabled';
    errors: string[];
    createdAt: number;
}

// ── デーモン状態 ──

export interface DaemonStatus {
    isRunning: boolean;
    failureBufferSize: number;
    lastRunAt: number | null;
    totalImprovements: number;
    totalRollbacks: number;
    runsInLastHour: number;
    /** プロアクティブ・スキル生成 */
    generatedSkillCount: number;
    proactiveRunsInLastHour: number;
}

// ── トリガー条件 ──

export interface TriggerContext {
    failureCount: number;
    timeSinceLastRun: number;
    repeatedFailureTypes: Map<string, number>;
    repeatedSkillFailures: Map<string, number>;
    hasMetaCognitionSignal: boolean;
}

// ── 定数 ──

export const SELF_IMPROVE_CONSTANTS = {
    /** 失敗バッファの最小サイズ（トリガー発火条件） */
    MIN_FAILURE_BUFFER: 3,
    /** 最小クールダウン（ms） */
    MIN_COOLDOWN_MS: 10 * 60 * 1000, // 10分
    /** 1時間あたりの最大実行回数 */
    MAX_RUNS_PER_HOUR: 3,
    /** 繰り返し失敗の閾値 */
    REPEATED_FAILURE_THRESHOLD: 3,
    /** 効果測定の対象タスク数 */
    EFFECTIVENESS_TASK_COUNT: 10,
    /** Tier 2 コード変更の最大行数割合 */
    MAX_CODE_CHANGE_RATIO: 0.5,
    /** 失敗バッファの最大サイズ */
    MAX_FAILURE_BUFFER: 50,
    /** JSON ルールファイルパス */
    RULES_FILE_PATH: 'saves/minecraft/self_improvement_rules.json',
    /** 改善履歴ファイルパス */
    HISTORY_FILE_PATH: 'saves/minecraft/self_improvement_history.json',
    /** 生成スキルマニフェストパス */
    MANIFEST_FILE_PATH: 'saves/minecraft/generated_skills_manifest.json',

    // ── プロアクティブ・スキル生成 ──
    /** プロアクティブ発想のクールダウン (ms) */
    PROACTIVE_COOLDOWN_MS: 30 * 60 * 1000, // 30分
    /** 1時間あたりのプロアクティブ最大実行回数 */
    MAX_PROACTIVE_RUNS_PER_HOUR: 2,
    /** 生成スキルの上限数 */
    MAX_GENERATED_SKILLS: 20,
    /** ツール列パターンの最小出現回数 */
    MIN_SEQUENCE_OCCURRENCES: 3,
    /** ツール列の最小長 */
    MIN_SEQUENCE_LENGTH: 3,
    /** 生成コードの最大行数 */
    MAX_GENERATED_CODE_LINES: 200,
    /** ConstantSkill の最小 interval (ms) */
    MIN_CONSTANT_SKILL_INTERVAL: 1000,

    // ── SelfTest ──
    /** テストケース JSON の格納ディレクトリ */
    SELF_TEST_CASES_DIR: 'saves/minecraft/self_test_cases',
    /** テストレポート保存先ディレクトリ */
    SELF_TEST_REPORT_DIR: 'saves/minecraft/self_test_reports',
    /** コード修正の最大試行回数 */
    MAX_FIX_ATTEMPTS: 3,
    /** 1回の修正で許容する最大変更行数 */
    MAX_PATCH_LINES: 50,
    /** コード修正が許可されるパス */
    MUTABLE_PATHS: [
        'src/services/minebot/instantSkills/',
        'src/services/minebot/constantSkills/',
    ] as readonly string[],
} as const;

// ── SelfTest 型定義 ──

/** precheck: テスト実行前の前提条件チェック */
export type Precheck =
    | { type: 'inventory_has'; item: string; minCount: number }
    | { type: 'nearby_block'; block: string; maxDistance: number }
    | { type: 'health_above'; min: number }
    | { type: 'dimension'; dimension: string };

export interface TestCase {
    id: string;
    skillName: string;
    args: unknown[];
    /** テスト内容の説明 */
    description: string;
    /** テスト前に実行するコマンド（/tp, /give, /clear 等） */
    setup?: string[];
    /** テスト実行前の前提条件チェック */
    prechecks?: Precheck[];
    /** 期待される結果 */
    expectedOutcome: 'success' | 'failure' | 'either';
}

/** テストスイート JSON ファイルの形式 */
export interface TestSuiteFile {
    testSuite: string;
    description?: string;
    /** 全テスト共通の setup（各テストの前に毎回実行） */
    globalSetup?: string[];
    cases: Array<Omit<TestCase, 'id'>>;
}

export interface TestResult {
    testCase: TestCase;
    skillResult: {
        success: boolean;
        result: string;
        failureType?: string;
        error?: string;
        duration?: number;
    } | null;
    passed: boolean;
    errorMessage: string | null;
    durationMs: number;
}

export interface FixAttempt {
    attempt: number;
    diff: string;
    compileSuccess: boolean;
    compileErrors: string[];
    testPassed: boolean | null;
    model: string;
}

export interface SkillTestReport {
    skillName: string;
    sourceFile: string;
    initialTestResults: TestResult[];
    fixAttempts: FixAttempt[];
    finalStatus: 'pass' | 'fixed' | 'unfixable' | 'skipped';
    rolledBack: boolean;
}

export interface SelfTestRunReport {
    runId: string;
    startedAt: number;
    completedAt: number;
    trigger: 'manual' | 'auto' | 'api';
    skillReports: SkillTestReport[];
    summary: {
        totalTested: number;
        passed: number;
        fixed: number;
        unfixable: number;
        skipped: number;
    };
}
