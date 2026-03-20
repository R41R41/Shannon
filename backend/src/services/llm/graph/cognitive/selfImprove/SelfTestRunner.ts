/**
 * SelfTestRunner — JSON ファイルベースのスキル自律テスト + 自己修正
 *
 * テストケースは saves/minecraft/self_test_cases/*.json に配置。
 * 各テストケースに setup コマンド（/tp, /give, /clear 等）と
 * prechecks（前提条件チェック）を定義可能。
 *
 * フロー:
 * 1. JSON テストスイートを読み込み
 * 2. 各テスト: setup コマンド実行 → prechecks 評価 → スキル実行 → 結果判定
 * 3. 失敗時（autoFix）: SkillPatcher で修正 → 再テスト
 * 4. レポート JSON を保存
 */

import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../../../utils/logger.js';
import { SkillPatcher } from './SkillPatcher.js';
import {
    SELF_IMPROVE_CONSTANTS as C,
    type TestCase,
    type TestSuiteFile,
    type Precheck,
    type TestResult,
    type SkillTestReport,
    type SelfTestRunReport,
} from './types.js';
import type { CustomBot, InstantSkill } from '../../../../minebot/types.js';

const log = createLogger('SelfTest:Runner');

/** setup コマンドで許可されるプレフィックス */
const ALLOWED_COMMANDS = ['/tp ', '/give ', '/clear', '/time ', '/weather ', '/gamemode ', '/effect ', '/summon ', '/fill ', '/setblock '];

/** setup コマンド実行後の待機時間 (ms) */
const SETUP_DELAY_MS = 500;

/** precheck 評価後の余裕待ち (ms) */
const PRECHECK_DELAY_MS = 200;

export class SelfTestRunner {
    private patcher = new SkillPatcher();

    /** skillName → .ts ソースファイルパスのキャッシュ */
    private sourceFileCache: Map<string, string> | null = null;

    /**
     * テストスイート JSON ファイルを読み込んでテストを実行する。
     * @param suiteName ファイル名（拡張子なし）。例: "new-skills-v1"
     */
    async runFromFile(
        bot: CustomBot,
        suiteName: string,
        options: { autoFix?: boolean; trigger?: 'manual' | 'auto' | 'api' } = {},
    ): Promise<SelfTestRunReport> {
        const { autoFix = false, trigger = 'manual' } = options;
        const runId = randomUUID().slice(0, 8);
        const startedAt = Date.now();

        log.info(`🧪 SelfTest 開始: suite=${suiteName} (runId=${runId})`);

        // テストスイート読み込み
        const suite = await this.loadTestSuite(suiteName);
        if (!suite) {
            log.error(`テストスイートが見つかりません: ${suiteName}`);
            return this.emptyReport(runId, startedAt, trigger);
        }

        // TestCase に変換
        const testCases: TestCase[] = suite.cases.map((c, i) => ({
            id: `${suiteName}-${i}`,
            ...c,
            setup: [...(suite.globalSetup ?? []), ...(c.setup ?? [])],
        }));

        // スキル名ごとにグルーピング
        const bySkill = new Map<string, TestCase[]>();
        for (const tc of testCases) {
            const list = bySkill.get(tc.skillName) ?? [];
            list.push(tc);
            bySkill.set(tc.skillName, list);
        }

        const skillReports: SkillTestReport[] = [];

        for (const [skillName, cases] of bySkill) {
            try {
                const report = await this.testSkillGroup(skillName, cases, bot, autoFix);
                skillReports.push(report);

                const icon = report.finalStatus === 'pass' ? '✅' :
                    report.finalStatus === 'fixed' ? '🔧' :
                        report.finalStatus === 'skipped' ? '⏭️' : '❌';
                log.info(`${icon} ${skillName}: ${report.finalStatus}`);
            } catch (err: any) {
                log.error(`テストエラー (${skillName}): ${err.message}`);
                skillReports.push({
                    skillName,
                    sourceFile: '',
                    initialTestResults: [],
                    fixAttempts: [],
                    finalStatus: 'skipped',
                    rolledBack: false,
                });
            }
        }

        const summary = {
            totalTested: skillReports.length,
            passed: skillReports.filter(r => r.finalStatus === 'pass').length,
            fixed: skillReports.filter(r => r.finalStatus === 'fixed').length,
            unfixable: skillReports.filter(r => r.finalStatus === 'unfixable').length,
            skipped: skillReports.filter(r => r.finalStatus === 'skipped').length,
        };

        const report: SelfTestRunReport = {
            runId,
            startedAt,
            completedAt: Date.now(),
            trigger,
            skillReports,
            summary,
        };

        const savedPath = await this.saveReport(report);
        log.info(
            `🧪 SelfTest 完了 (${((Date.now() - startedAt) / 1000).toFixed(1)}s): ` +
            `tested=${summary.totalTested} pass=${summary.passed} fixed=${summary.fixed} ` +
            `unfixable=${summary.unfixable} skipped=${summary.skipped}`,
        );
        log.info(`📄 レポート: ${savedPath}`);

        return report;
    }

    /**
     * 複数のテストスイートを順番に実行し、結合レポートを返す。
     */
    async runMultiple(
        bot: CustomBot,
        suiteNames: string[],
        options: { autoFix?: boolean; trigger?: 'manual' | 'auto' | 'api' } = {},
    ): Promise<SelfTestRunReport> {
        const { autoFix = false, trigger = 'manual' } = options;
        const runId = randomUUID().slice(0, 8);
        const startedAt = Date.now();

        log.info(`🧪 SelfTest 一括実行開始: ${suiteNames.join(', ')} (runId=${runId})`);

        const allSkillReports: SkillTestReport[] = [];

        for (const suiteName of suiteNames) {
            try {
                const report = await this.runFromFile(bot, suiteName, options);
                allSkillReports.push(...report.skillReports);
            } catch (err: any) {
                log.error(`スイート ${suiteName} でエラー: ${err.message}`);
            }
        }

        const summary = {
            totalTested: allSkillReports.length,
            passed: allSkillReports.filter(r => r.finalStatus === 'pass').length,
            fixed: allSkillReports.filter(r => r.finalStatus === 'fixed').length,
            unfixable: allSkillReports.filter(r => r.finalStatus === 'unfixable').length,
            skipped: allSkillReports.filter(r => r.finalStatus === 'skipped').length,
        };

        const report: SelfTestRunReport = {
            runId, startedAt, completedAt: Date.now(), trigger,
            skillReports: allSkillReports,
            summary,
        };

        const savedPath = await this.saveReport(report);
        log.info(
            `🧪 一括テスト完了 (${((Date.now() - startedAt) / 1000).toFixed(1)}s): ` +
            `suites=${suiteNames.length} tested=${summary.totalTested} ` +
            `pass=${summary.passed} fixed=${summary.fixed} unfixable=${summary.unfixable} skipped=${summary.skipped}`,
        );
        log.info(`📄 統合レポート: ${savedPath}`);

        return report;
    }

    /**
     * (後方互換) スキル名指定でテスト実行。テストケースは LLM 生成。
     */
    async runTests(
        bot: CustomBot,
        options: {
            skillNames?: string[];
            autoFix?: boolean;
            trigger?: 'manual' | 'auto' | 'api';
        } = {},
    ): Promise<SelfTestRunReport> {
        // テストスイートディレクトリ内の全ファイルを探してマッチするものを実行
        // skillNames が指定されていれば、それを含むスイートを探す
        // 見つからなければ空レポート
        const runId = randomUUID().slice(0, 8);
        log.warn('runTests: テストスイート JSON を使用してください (runFromFile)');
        return this.emptyReport(runId, Date.now(), options.trigger ?? 'api');
    }

    // ── テスト実行 ──

    /**
     * 1つのスキルに対するテストグループを実行する。
     */
    private async testSkillGroup(
        skillName: string,
        testCases: TestCase[],
        bot: CustomBot,
        autoFix: boolean,
    ): Promise<SkillTestReport> {
        const sourceFile = await this.resolveSourceFile(skillName) ?? '';
        const skill = bot.instantSkills.getSkill(skillName);

        if (!skill) {
            log.warn(`スキル未登録: ${skillName}`);
            return {
                skillName, sourceFile,
                initialTestResults: [],
                fixAttempts: [],
                finalStatus: 'skipped',
                rolledBack: false,
            };
        }

        // テスト実行
        const initialResults = await this.executeTests(skill, testCases, bot);

        // 全パス？
        const failedTests = initialResults.filter(r => !r.passed);
        if (failedTests.length === 0) {
            return {
                skillName, sourceFile,
                initialTestResults: initialResults,
                fixAttempts: [],
                finalStatus: 'pass',
                rolledBack: false,
            };
        }

        // 自動修正しない or ソースファイル不明
        if (!autoFix || !sourceFile) {
            return {
                skillName, sourceFile,
                initialTestResults: initialResults,
                fixAttempts: [],
                finalStatus: 'unfixable',
                rolledBack: false,
            };
        }

        // PDCA: 修正 → 再テスト
        const { fixAttempts, fixed, rolledBack } = await this.patcher.diagnoseAndFix(
            skillName, sourceFile, failedTests, bot,
        );

        if (!fixed) {
            return {
                skillName, sourceFile,
                initialTestResults: initialResults,
                fixAttempts,
                finalStatus: 'unfixable',
                rolledBack,
            };
        }

        // 修正後の再テスト
        const updatedSkill = bot.instantSkills.getSkill(skillName);
        if (!updatedSkill) {
            return {
                skillName, sourceFile,
                initialTestResults: initialResults,
                fixAttempts,
                finalStatus: 'unfixable',
                rolledBack: true,
            };
        }

        const retestResults = await this.executeTests(updatedSkill, testCases, bot);
        const retestFailed = retestResults.filter(r => !r.passed);

        if (fixAttempts.length > 0) {
            fixAttempts[fixAttempts.length - 1].testPassed = retestFailed.length === 0;
        }

        return {
            skillName, sourceFile,
            initialTestResults: initialResults,
            fixAttempts,
            finalStatus: retestFailed.length === 0 ? 'fixed' : 'unfixable',
            rolledBack: retestFailed.length > 0 ? rolledBack : false,
        };
    }

    /**
     * テストケースを順次実行する。各テスト前に setup + prechecks。
     */
    private async executeTests(
        skill: InstantSkill,
        testCases: TestCase[],
        bot: CustomBot,
    ): Promise<TestResult[]> {
        const results: TestResult[] = [];

        for (const tc of testCases) {
            // setup コマンド実行
            if (tc.setup && tc.setup.length > 0) {
                await this.executeSetup(bot, tc.setup);
            }

            // prechecks 評価
            if (tc.prechecks && tc.prechecks.length > 0) {
                await new Promise(r => setTimeout(r, PRECHECK_DELAY_MS));
                const precheckResult = this.evaluatePrechecks(bot, tc.prechecks);
                if (!precheckResult.passed) {
                    results.push({
                        testCase: tc,
                        skillResult: null,
                        passed: false,
                        errorMessage: `precheck 失敗: ${precheckResult.reason}`,
                        durationMs: 0,
                    });
                    // precheck 失敗は skip 扱い（passed=false だが skip 理由を明示）
                    continue;
                }
            }

            // スキル実行
            const start = Date.now();
            try {
                const skillResult = await skill.run(...tc.args);
                const durationMs = Date.now() - start;

                let passed: boolean;
                if (tc.expectedOutcome === 'either') {
                    passed = true;
                } else if (tc.expectedOutcome === 'success') {
                    passed = skillResult.success;
                } else {
                    passed = !skillResult.success;
                }

                results.push({
                    testCase: tc,
                    skillResult: {
                        success: skillResult.success,
                        result: skillResult.result,
                        failureType: skillResult.failureType,
                        error: skillResult.error,
                        duration: skillResult.duration,
                    },
                    passed,
                    errorMessage: passed ? null : skillResult.result,
                    durationMs,
                });
            } catch (err: any) {
                results.push({
                    testCase: tc,
                    skillResult: null,
                    passed: false,
                    errorMessage: err.message,
                    durationMs: Date.now() - start,
                });
            }
        }

        return results;
    }

    // ── setup / prechecks ──

    /**
     * setup コマンドを bot.chat() で実行する。
     * 許可されたコマンドのみ実行（安全弁）。
     */
    private async executeSetup(bot: CustomBot, commands: string[]): Promise<void> {
        for (const cmd of commands) {
            const trimmed = cmd.trim();
            if (!trimmed.startsWith('/')) {
                log.warn(`setup スキップ（/ で始まらない）: ${trimmed}`);
                continue;
            }
            if (!ALLOWED_COMMANDS.some(prefix => trimmed.startsWith(prefix) || trimmed === '/clear')) {
                log.warn(`setup スキップ（許可外コマンド）: ${trimmed}`);
                continue;
            }

            log.info(`⚙️ setup: ${trimmed}`);
            bot.chat(trimmed);
            await new Promise(r => setTimeout(r, SETUP_DELAY_MS));
        }
    }

    /**
     * prechecks を評価する。全て OK なら passed=true。
     */
    private evaluatePrechecks(
        bot: CustomBot,
        prechecks: Precheck[],
    ): { passed: boolean; reason: string } {
        for (const check of prechecks) {
            switch (check.type) {
                case 'inventory_has': {
                    const items = bot.inventory?.items() ?? [];
                    const count = items
                        .filter(i => i.name === check.item)
                        .reduce((sum, i) => sum + i.count, 0);
                    if (count < check.minCount) {
                        return {
                            passed: false,
                            reason: `${check.item} が不足 (必要: ${check.minCount}, 所持: ${count})`,
                        };
                    }
                    break;
                }
                case 'nearby_block': {
                    try {
                        const blockId = (bot as any).registry?.blocksByName?.[check.block]?.id;
                        if (blockId == null) {
                            return { passed: false, reason: `ブロック名不明: ${check.block}` };
                        }
                        const found = bot.findBlocks({
                            matching: blockId,
                            maxDistance: check.maxDistance,
                            count: 1,
                        });
                        if (found.length === 0) {
                            return {
                                passed: false,
                                reason: `${check.block} が半径 ${check.maxDistance} 以内に見つからない`,
                            };
                        }
                    } catch {
                        return { passed: false, reason: `nearby_block チェックエラー: ${check.block}` };
                    }
                    break;
                }
                case 'health_above': {
                    const health = bot.health ?? 20;
                    if (health < check.min) {
                        return { passed: false, reason: `HP が ${check.min} 未満 (現在: ${health})` };
                    }
                    break;
                }
                case 'dimension': {
                    const dim = ((bot as any).game?.dimension ?? 'overworld').toString();
                    if (!dim.includes(check.dimension)) {
                        return { passed: false, reason: `ディメンションが ${check.dimension} ではない (現在: ${dim})` };
                    }
                    break;
                }
            }
        }

        return { passed: true, reason: '' };
    }

    // ── ファイル I/O ──

    /**
     * テストスイート JSON を読み込む。
     */
    private async loadTestSuite(suiteName: string): Promise<TestSuiteFile | null> {
        const dir = resolve(process.cwd(), C.SELF_TEST_CASES_DIR);
        const filePath = join(dir, `${suiteName}.json`);
        try {
            const content = await readFile(filePath, 'utf-8');
            return JSON.parse(content) as TestSuiteFile;
        } catch {
            log.error(`テストスイート読み込み失敗: ${filePath}`);
            return null;
        }
    }

    /**
     * skillName → .ts ソースファイルパスを解決する。
     */
    private async resolveSourceFile(skillName: string): Promise<string | null> {
        if (!this.sourceFileCache) {
            this.sourceFileCache = new Map();
            await this.buildSourceFileCache();
        }
        return this.sourceFileCache.get(skillName) ?? null;
    }

    private async buildSourceFileCache(): Promise<void> {
        const dirs = [
            'src/services/minebot/instantSkills',
            'src/services/minebot/instantSkills/generated',
            'src/services/minebot/constantSkills',
            'src/services/minebot/constantSkills/generated',
        ];

        for (const dir of dirs) {
            const absDir = resolve(process.cwd(), dir);
            try {
                const files = await readdir(absDir);
                for (const file of files) {
                    if (!file.endsWith('.ts')) continue;
                    const filePath = join(dir, file);
                    const absPath = join(absDir, file);
                    try {
                        const content = await readFile(absPath, 'utf-8');
                        const match = content.match(/this\.skillName\s*=\s*['"]([^'"]+)['"]/);
                        if (match) {
                            this.sourceFileCache!.set(match[1], filePath);
                        }
                    } catch { /* skip */ }
                }
            } catch { /* dir not found */ }
        }

        log.info(`📁 ソースファイルマップ: ${this.sourceFileCache!.size} スキル`);
    }

    private async saveReport(report: SelfTestRunReport): Promise<string> {
        const dir = resolve(process.cwd(), C.SELF_TEST_REPORT_DIR);
        await mkdir(dir, { recursive: true });

        const ts = new Date(report.startedAt).toISOString().replace(/[:.]/g, '-');
        const filePath = join(dir, `${ts}_${report.runId}.json`);
        await writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
        return filePath;
    }

    private emptyReport(
        runId: string, startedAt: number, trigger: 'manual' | 'auto' | 'api',
    ): SelfTestRunReport {
        return {
            runId, startedAt, completedAt: Date.now(), trigger,
            skillReports: [],
            summary: { totalTested: 0, passed: 0, fixed: 0, unfixable: 0, skipped: 0 },
        };
    }
}
