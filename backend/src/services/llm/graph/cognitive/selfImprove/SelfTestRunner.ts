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
 *
 * runTests: ディレクトリ内の全スイート、または skillNames に該当ケースを含むスイートのみ実行。
 * ConstantSkill もテスト実行・--fix 対応（SkillRegistrar が taskPer リスナを差し替え）。
 */

import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../../../utils/logger.js';
import { getBackendRoot } from '../../../../../utils/backendRoot.js';
import { SkillPatcher } from './SkillPatcher.js';
import {
    SELF_IMPROVE_CONSTANTS as C,
    type TestCase,
    type TestSuiteFile,
    type GoalSuccessCriterion,
    type Precheck,
    type TestResult,
    type SkillTestReport,
    type SelfTestRunReport,
} from './types.js';
import type { CustomBot } from '../../../../minebot/types.js';
import { MinecraftGoalExecutor } from './MinecraftGoalExecutor.js';

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
        options: {
            autoFix?: boolean;
            trigger?: 'manual' | 'auto' | 'api';
            persistReport?: boolean;
        } = {},
    ): Promise<SelfTestRunReport> {
        const { autoFix = false, trigger = 'manual', persistReport = true } = options;
        const runId = randomUUID().slice(0, 8);
        const startedAt = Date.now();

        log.info(`🧪 SelfTest 開始: suite=${suiteName} (runId=${runId})`);

        // テストスイート読み込み
        const suite = await this.loadTestSuite(suiteName);
        if (!suite) {
            log.error(`テストスイートが見つかりません: ${suiteName}`);
            return this.emptyReport(runId, startedAt, trigger);
        }

        const hasSetup =
            (suite.globalSetup?.length ?? 0) > 0
            || suite.cases.some(c => (c.setup?.length ?? 0) > 0);
        if (hasSetup) {
            log.info(
                'ℹ️ setup で /tp 等を使用します。サーバーでボットにコマンドが通る権限があるか確認してください。',
            );
        }

        // ── goal モード: LLM 自律実行 ──
        if (suite.mode === 'goal') {
            return this.runGoalMode(suite, bot, runId, startedAt, trigger, persistReport);
        }

        const isChain = suite.mode === 'chain';

        const testCases: TestCase[] = suite.cases.map((c, i) => ({
            id: `${suiteName}-${i}`,
            ...c,
            setup: isChain
                ? [...(c.setup ?? [])]
                : [...(suite.globalSetup ?? []), ...(c.setup ?? [])],
        }));

        let skillReports: SkillTestReport[];

        if (isChain) {
            if (suite.globalSetup?.length) {
                await this.executeSetup(bot, suite.globalSetup);
            }
            skillReports = await this.runChain(testCases, bot, autoFix);
        } else {
            const bySkill = new Map<string, TestCase[]>();
            for (const tc of testCases) {
                const list = bySkill.get(tc.skillName) ?? [];
                list.push(tc);
                bySkill.set(tc.skillName, list);
            }

            skillReports = [];
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

        if (persistReport) {
            const savedPath = await this.saveReport(report);
            log.info(
                `🧪 SelfTest 完了 (${((Date.now() - startedAt) / 1000).toFixed(1)}s): ` +
                `tested=${summary.totalTested} pass=${summary.passed} fixed=${summary.fixed} ` +
                `unfixable=${summary.unfixable} skipped=${summary.skipped}`,
            );
            log.info(`📄 レポート: ${savedPath}`);
        } else {
            log.info(
                `🧪 スイート ${suiteName} 完了 (${((Date.now() - startedAt) / 1000).toFixed(1)}s) — 統合レポートへ集約`,
            );
        }

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
                const report = await this.runFromFile(bot, suiteName, {
                    ...options,
                    persistReport: false,
                });
                allSkillReports.push(...report.skillReports);
            } catch (err: any) {
                log.error(`スイート ${suiteName} でエラー: ${err.message}`);
            }
        }

        const mergedReports = this.mergeSkillReportsByName(allSkillReports);
        const summary = {
            totalTested: mergedReports.length,
            passed: mergedReports.filter(r => r.finalStatus === 'pass').length,
            fixed: mergedReports.filter(r => r.finalStatus === 'fixed').length,
            unfixable: mergedReports.filter(r => r.finalStatus === 'unfixable').length,
            skipped: mergedReports.filter(r => r.finalStatus === 'skipped').length,
        };

        const report: SelfTestRunReport = {
            runId, startedAt, completedAt: Date.now(), trigger,
            skillReports: mergedReports,
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
     * self_test_cases 内の JSON スイートを実行。
     * skillNames 省略時は全スイート。指定時は、そのスキルを含むスイートのみ。
     */
    async runTests(
        bot: CustomBot,
        options: {
            skillNames?: string[];
            autoFix?: boolean;
            trigger?: 'manual' | 'auto' | 'api';
        } = {},
    ): Promise<SelfTestRunReport> {
        const { autoFix = true, trigger = 'api', skillNames } = options;

        const allSuites = await this.listTestSuiteNames();
        if (allSuites.length === 0) {
            log.warn('runTests: self_test_cases に .json がありません');
            return this.emptyReport(randomUUID().slice(0, 8), Date.now(), trigger);
        }

        let suiteNames = allSuites;
        if (skillNames && skillNames.length > 0) {
            const wanted = new Set(skillNames);
            const filtered: string[] = [];
            for (const name of allSuites) {
                const suite = await this.loadTestSuite(name);
                if (suite?.cases.some(c => wanted.has(c.skillName))) {
                    filtered.push(name);
                }
            }
            if (filtered.length === 0) {
                log.warn(
                    `runTests: 指定スキルにマッチするスイートがありません: ${skillNames.join(', ')}`,
                );
                return this.emptyReport(randomUUID().slice(0, 8), Date.now(), trigger);
            }
            suiteNames = filtered;
        }

        log.info(`runTests: ${suiteNames.length} スイートを実行 → ${suiteNames.join(', ')}`);
        return this.runMultiple(bot, suiteNames, { autoFix, trigger });
    }

    // ── テスト実行 ──

    /**
     * chain モード: ケースを定義順に逐次実行。
     * 失敗時は autoFix を試み、失敗したらチェーンを中断する。
     */
    private async runChain(
        testCases: TestCase[],
        bot: CustomBot,
        autoFix: boolean,
    ): Promise<SkillTestReport[]> {
        const reportsBySkill = new Map<string, SkillTestReport>();
        const chainHistory: Array<{ step: number; skill: string; description?: string; status: string; error?: string }> = [];

        for (let i = 0; i < testCases.length; i++) {
            const tc = testCases[i];
            const skillName = tc.skillName;
            const sourceFile = await this.resolveSourceFile(skillName) ?? '';

            const instant = bot.instantSkills.getSkill(skillName);
            const constant = bot.constantSkills.getSkill(skillName);
            const skillKind: 'instant' | 'constant' | null =
                instant ? 'instant' : constant ? 'constant' : null;

            if (!skillKind) {
                log.warn(`⏭️ chain[${i}] スキル未登録: ${skillName}`);
                this.upsertChainReport(reportsBySkill, skillName, sourceFile, {
                    testCase: tc, skillResult: null, passed: false,
                    errorMessage: `スキル未登録: ${skillName}`, durationMs: 0,
                }, 'skipped');
                chainHistory.push({ step: i, skill: skillName, description: tc.description, status: 'skipped', error: `スキル未登録` });
                continue;
            }

            const result = await this.executeSingleTest(bot, skillName, skillKind, tc);

            if (result.passed) {
                const icon = '✅';
                log.info(`${icon} chain[${i}] ${tc.description ?? skillName}: pass`);
                this.upsertChainReport(reportsBySkill, skillName, sourceFile, result, 'pass');
                chainHistory.push({ step: i, skill: skillName, description: tc.description, status: 'pass' });
                continue;
            }

            log.warn(`❌ chain[${i}] ${tc.description ?? skillName}: ${result.errorMessage}`);
            chainHistory.push({ step: i, skill: skillName, description: tc.description, status: 'fail', error: result.errorMessage ?? undefined });

            if (autoFix && sourceFile) {
                const chainContext = this.buildChainContext(chainHistory);
                const { fixAttempts, fixed, rolledBack } = await this.patcher.diagnoseAndFix(
                    skillName, sourceFile, [result], bot, skillKind, chainContext,
                );
                if (fixed) {
                    const retry = await this.executeSingleTest(bot, skillName, skillKind, tc);
                    if (fixAttempts.length > 0) {
                        fixAttempts[fixAttempts.length - 1].testPassed = retry.passed;
                    }
                    if (retry.passed) {
                        log.info(`🔧 chain[${i}] ${skillName}: fixed`);
                        this.upsertChainReport(reportsBySkill, skillName, sourceFile, retry, 'fixed', fixAttempts);
                        chainHistory[chainHistory.length - 1].status = 'fixed';
                        continue;
                    }
                }
                log.error(`⛔ chain[${i}] ${skillName}: 修正失敗 → チェーン中断`);
                this.upsertChainReport(reportsBySkill, skillName, sourceFile, result, 'unfixable', fixAttempts);
            } else {
                this.upsertChainReport(reportsBySkill, skillName, sourceFile, result, 'unfixable');
            }

            log.warn(`⛔ チェーン中断: step ${i} (${skillName}) で失敗`);
            break;
        }

        const reports = [...reportsBySkill.values()];
        for (const r of reports) {
            const icon = r.finalStatus === 'pass' ? '✅' :
                r.finalStatus === 'fixed' ? '🔧' :
                    r.finalStatus === 'skipped' ? '⏭️' : '❌';
            log.info(`${icon} ${r.skillName}: ${r.finalStatus}`);
        }
        return reports;
    }

    private buildChainContext(
        history: Array<{ step: number; skill: string; description?: string; status: string; error?: string }>,
    ): string | undefined {
        const hasIssue = history.some(h => h.status === 'skipped' || h.status === 'fail');
        if (!hasIssue) return undefined;

        const lines = history.map(h => {
            const icon = h.status === 'pass' ? '✅' : h.status === 'skipped' ? '⏭️' : '❌';
            let line = `${icon} step ${h.step}: ${h.description ?? h.skill} → ${h.status}`;
            if (h.error) line += ` (${h.error})`;
            return line;
        });
        return lines.join('\n');
    }

    private upsertChainReport(
        map: Map<string, SkillTestReport>,
        skillName: string,
        sourceFile: string,
        result: TestResult,
        status: SkillTestReport['finalStatus'],
        fixAttempts: SkillTestReport['fixAttempts'] = [],
    ): void {
        const existing = map.get(skillName);
        if (existing) {
            existing.initialTestResults.push(result);
            existing.fixAttempts.push(...fixAttempts);
            const severity: Record<string, number> = { pass: 0, fixed: 1, skipped: 2, unfixable: 3 };
            if ((severity[status] ?? 0) > (severity[existing.finalStatus] ?? 0)) {
                existing.finalStatus = status;
            }
        } else {
            map.set(skillName, {
                skillName,
                sourceFile,
                initialTestResults: [result],
                fixAttempts,
                finalStatus: status,
                rolledBack: false,
            });
        }
    }

    /**
     * 単一テストケースを実行する（setup + prechecks + スキル実行）。
     */
    private async executeSingleTest(
        bot: CustomBot,
        skillName: string,
        skillKind: 'instant' | 'constant',
        tc: TestCase,
    ): Promise<TestResult> {
        if (tc.setup && tc.setup.length > 0) {
            await this.executeSetup(bot, tc.setup);
        }

        if (tc.prechecks && tc.prechecks.length > 0) {
            await new Promise(r => setTimeout(r, PRECHECK_DELAY_MS));
            const precheckResult = this.evaluatePrechecks(bot, tc.prechecks);
            if (!precheckResult.passed) {
                return {
                    testCase: tc,
                    skillResult: null,
                    passed: false,
                    errorMessage: `precheck 失敗: ${precheckResult.reason}`,
                    durationMs: 0,
                };
            }
        }

        const start = Date.now();
        try {
            const skillResult = await this.invokeSkillRun(bot, skillName, skillKind, tc.args);
            const durationMs = Date.now() - start;

            let passed: boolean;
            if (tc.expectedOutcome === 'either') {
                passed = true;
            } else if (tc.expectedOutcome === 'success') {
                passed = skillResult.success;
            } else {
                passed = !skillResult.success;
            }

            return {
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
            };
        } catch (err: any) {
            return {
                testCase: tc,
                skillResult: null,
                passed: false,
                errorMessage: err.message,
                durationMs: Date.now() - start,
            };
        }
    }

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
        const instant = bot.instantSkills.getSkill(skillName);
        const constant = bot.constantSkills.getSkill(skillName);
        let skillKind: 'instant' | 'constant';
        if (instant) {
            skillKind = 'instant';
        } else if (constant) {
            skillKind = 'constant';
        } else {
            log.warn(`スキル未登録: ${skillName}`);
            return {
                skillName, sourceFile,
                initialTestResults: [],
                fixAttempts: [],
                finalStatus: 'skipped',
                rolledBack: false,
            };
        }

        const initialResults = await this.executeTests(bot, skillName, skillKind, testCases);

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

        if (!autoFix || !sourceFile) {
            return {
                skillName, sourceFile,
                initialTestResults: initialResults,
                fixAttempts: [],
                finalStatus: 'unfixable',
                rolledBack: false,
            };
        }

        const { fixAttempts, fixed, rolledBack } = await this.patcher.diagnoseAndFix(
            skillName, sourceFile, failedTests, bot, skillKind,
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

        const stillOk =
            skillKind === 'instant'
                ? bot.instantSkills.getSkill(skillName)
                : bot.constantSkills.getSkill(skillName);
        if (!stillOk) {
            return {
                skillName, sourceFile,
                initialTestResults: initialResults,
                fixAttempts,
                finalStatus: 'unfixable',
                rolledBack: true,
            };
        }

        const retestResults = await this.executeTests(bot, skillName, skillKind, testCases);
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
        bot: CustomBot,
        skillName: string,
        skillKind: 'instant' | 'constant',
        testCases: TestCase[],
    ): Promise<TestResult[]> {
        const results: TestResult[] = [];

        for (const tc of testCases) {
            if (tc.setup && tc.setup.length > 0) {
                await this.executeSetup(bot, tc.setup);
            }

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
                    continue;
                }
            }

            const start = Date.now();
            try {
                const skillResult = await this.invokeSkillRun(bot, skillName, skillKind, tc.args);
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

    /**
     * InstantSkill は SkillResult、ConstantSkill は void 完了を成功とみなす。
     * ConstantSkill は isLocked / executingSkill により no-op になりうる点に注意。
     */
    private async invokeSkillRun(
        bot: CustomBot,
        skillName: string,
        skillKind: 'instant' | 'constant',
        args: unknown[],
    ): Promise<{
        success: boolean;
        result: string;
        failureType?: string;
        error?: string;
        duration?: number;
    }> {
        if (skillKind === 'instant') {
            const skill = bot.instantSkills.getSkill(skillName);
            if (!skill) {
                return { success: false, result: `InstantSkill 未登録: ${skillName}` };
            }
            return skill.run(...args as any);
        }

        const c = bot.constantSkills.getSkill(skillName);
        if (!c) {
            return { success: false, result: `ConstantSkill 未登録: ${skillName}` };
        }
        const t0 = Date.now();
        try {
            await c.run(...args as any);
            return {
                success: true,
                result: 'constant run ok',
                duration: Date.now() - t0,
            };
        } catch (e: any) {
            return {
                success: false,
                result: e?.message ?? String(e),
                error: e?.message,
                duration: Date.now() - t0,
            };
        }
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

    // ── goal モード実行 ──

    private async runGoalMode(
        suite: TestSuiteFile,
        bot: CustomBot,
        runId: string,
        startedAt: number,
        trigger: 'manual' | 'auto' | 'api',
        persistReport: boolean,
    ): Promise<SelfTestRunReport> {
        if (!suite.goal) {
            log.error('goal モードですが goal が未指定です');
            return this.emptyReport(runId, startedAt, trigger);
        }

        const criteria: GoalSuccessCriterion[] = suite.successCriteria ?? [];
        if (criteria.length === 0) {
            log.warn('successCriteria が空です — 達成判定は LLM の自己申告のみになります');
        }

        // globalSetup 実行
        if (suite.globalSetup?.length) {
            await this.executeSetup(bot, suite.globalSetup);
        }

        const executor = new MinecraftGoalExecutor(bot);
        const result = await executor.execute(suite.goal, criteria, suite.maxIterations);

        // GoalExecutionResult → SelfTestRunReport に変換
        const goalReport: SkillTestReport = {
            skillName: `goal:${suite.testSuite}`,
            sourceFile: '',
            initialTestResults: [{
                testCase: {
                    id: 'goal-0',
                    skillName: 'goal',
                    args: [suite.goal],
                    description: suite.goal,
                    expectedOutcome: 'success',
                },
                skillResult: {
                    success: result.success,
                    result: result.success
                        ? `ゴール達成 (${result.iterations}iter, ${result.skillCalls.length}スキル呼出)`
                        : result.errorMessage ?? 'ゴール未達成',
                },
                passed: result.success,
                errorMessage: result.success ? null : (result.errorMessage ?? null),
                durationMs: result.durationMs,
            }],
            fixAttempts: [],
            finalStatus: result.success ? 'pass' : 'unfixable',
            rolledBack: false,
        };

        const report: SelfTestRunReport = {
            runId,
            startedAt,
            completedAt: Date.now(),
            trigger,
            skillReports: [goalReport],
            summary: {
                totalTested: 1,
                passed: result.success ? 1 : 0,
                fixed: 0,
                unfixable: result.success ? 0 : 1,
                skipped: 0,
            },
        };

        if (persistReport) {
            await this.saveReport(report);
        }

        const icon = result.success ? '✅' : '❌';
        log.info(
            `${icon} ゴールテスト完了: ${suite.testSuite} — ` +
            `${result.success ? '達成' : '未達成'} ` +
            `(${result.iterations}iter, ${result.skillCalls.length}スキル, ${(result.durationMs / 1000).toFixed(1)}s)`,
        );

        return report;
    }

    /**
     * 複数スイートにまたがる同一 skillName のレポートを 1 件にまとめ、サマリの二重計上を防ぐ。
     */
    private mergeSkillReportsByName(reports: SkillTestReport[]): SkillTestReport[] {
        const severity: Record<SkillTestReport['finalStatus'], number> = {
            pass: 0,
            fixed: 0,
            skipped: 1,
            unfixable: 2,
        };
        const by = new Map<string, SkillTestReport[]>();
        for (const r of reports) {
            const arr = by.get(r.skillName) ?? [];
            arr.push(r);
            by.set(r.skillName, arr);
        }
        const merged: SkillTestReport[] = [];
        for (const [, list] of by) {
            if (list.length === 1) {
                merged.push(list[0]);
                continue;
            }
            const worst = list.reduce((a, b) =>
                severity[b.finalStatus] > severity[a.finalStatus] ? b : a,
            );
            merged.push({
                skillName: list[0].skillName,
                sourceFile: list.find(x => x.sourceFile)?.sourceFile ?? '',
                initialTestResults: list.flatMap(x => x.initialTestResults),
                fixAttempts: list.flatMap(x => x.fixAttempts),
                finalStatus: worst.finalStatus,
                rolledBack: list.some(x => x.rolledBack),
            });
        }
        merged.sort((a, b) => a.skillName.localeCompare(b.skillName));
        return merged;
    }

    // ── ファイル I/O ──

    /**
     * テストスイート JSON を読み込む。
     */
    private async listTestSuiteNames(): Promise<string[]> {
        const dir = resolve(getBackendRoot(), C.SELF_TEST_CASES_DIR);
        try {
            const files = await readdir(dir);
            return files
                .filter(f => f.endsWith('.json'))
                .map(f => f.slice(0, -'.json'.length))
                .sort();
        } catch {
            log.error(`listTestSuiteNames: 読み取り失敗 ${dir}`);
            return [];
        }
    }

    private async loadTestSuite(suiteName: string): Promise<TestSuiteFile | null> {
        const dir = resolve(getBackendRoot(), C.SELF_TEST_CASES_DIR);
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
            const absDir = resolve(getBackendRoot(), dir);
            try {
                const files = await readdir(absDir);
                for (const file of files) {
                    if (!file.endsWith('.ts')) continue;
                    const filePath = join(dir, file);
                    const absPath = join(absDir, file);
                    try {
                        const content = await readFile(absPath, 'utf-8');
                        const match = content.match(
                            /(?:this\.)?skillName\s*=\s*['"]([^'"]+)['"]/,
                        );
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
        const dir = resolve(getBackendRoot(), C.SELF_TEST_REPORT_DIR);
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
