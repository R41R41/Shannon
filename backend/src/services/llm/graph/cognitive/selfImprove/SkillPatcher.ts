/**
 * SkillPatcher — 失敗したスキルのコードを読んで修正する PDCA ループ
 *
 * 1. ソースコードを読む（backup 保持）
 * 2. LLM が失敗原因を診断し修正コードを生成
 * 3. CodeValidator で安全チェック
 * 4. SkillCompiler でコンパイル
 * 5. SkillHotLoader で差し替え
 * 6. 失敗したら rollback
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getBackendRoot } from '../../../../../utils/backendRoot.js';
import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createTracedModel } from '../../../utils/langfuse.js';
import { createLogger } from '../../../../../utils/logger.js';
import { CodeValidator } from './CodeValidator.js';
import {
    isLlmServiceMutablePath,
    isMutableRelativePath,
    isSkillMutablePath,
    sanitizeMutableRelativePath,
} from './mutableCodePolicy.js';
import {
    SELF_IMPROVE_CONSTANTS as C,
    type TestResult,
    type FixAttempt,
} from './types.js';

const log = createLogger('SelfTest:Patcher');

const FixSchema = z.object({
    code: z.string().describe('修正後の完全な TypeScript ソースコード。skipFix が true の場合は空文字列'),
    explanation: z.string().describe('修正内容の説明（日本語、1-2文）。skipFix の場合はスキップ理由'),
    skipFix: z.boolean().optional().describe('true: このスキルのコードに問題はなく、失敗原因は外部要因（前段ステップの未完了、テスト環境の問題など）であるため修正をスキップすべき'),
});

const SYSTEM_PROMPT = `あなたは Minecraft bot のスキルコードを修正するエンジニアです。

テスト結果で失敗したスキルのソースコードと、失敗時のエラー情報が与えられます。
原因を診断し、修正した完全なソースコードを返してください。

重要 — 根本原因の判断:
- 「チェーンコンテキスト」が提示された場合、前段ステップのスキップや失敗が今回の失敗原因である可能性を検討すること
- 例: 前段の place-block-at がスキップされてかまどが未設置 → start-smelting が「airはかまどではない」で失敗 → これはコードのバグではない
- このスキルのコード自体に問題がない場合は skipFix: true を返し、explanation に外部要因を記述すること
- コードに問題がある場合のみ、修正コードを返すこと

ルール:
- 修正は最小限にする（失敗の原因となる部分のみ修正）
- import は既存のものを維持（新規追加は minecraft-data, vec3, 相対パスのみ許可）
- eval, process.exit, child_process, fs (直接) は禁止
- クラス構造を壊さない（InstantSkill は runImpl、ConstantSkill は runImpl と interval の意味）
- skillName を変更しない
- 200行以内に収める`;

const SYSTEM_PROMPT_LLM = `あなたは Shannon バックエンドの src/services/llm 配下の TypeScript を修正するエンジニアです。

テスト失敗・コンパイルエラーに対し、原因箇所を最小限の差分で直し、修正後のファイル全文を返してください。

ルール:
- 既存の export / クラス名 / 公開 API の意味を壊さない（破壊的リネームは禁止）
- import は業務上必要な範囲で。child_process / vm は禁止
- eval, process.exit, new Function は禁止
- 変更は失敗に直接関係する部分に限定（無関係なリファクタ禁止）`;

const SYSTEM_PROMPT_MINEBOT = `あなたは Shannon の src/services/minebot 配下（スキル以外のエージェント・ランタイム等）の TypeScript を修正するエンジニアです。

テスト失敗・コンパイルエラーに対し、原因箇所を最小限の差分で直し、修正後のファイル全文を返してください。

ルール:
- Bot API・イベント・SkillRegistrar 等の既存パターンに合わせる
- child_process / vm は禁止。eval, process.exit, new Function は禁止
- 公開シグネチャを壊さない（破壊的リネームは禁止）`;

const SYSTEM_PROMPT_BACKEND_TS = `あなたは Shannon バックエンドの TypeScript を修正するエンジニアです。

テスト失敗・コンパイルエラーに対し、原因箇所を最小限の差分で直し、修正後のファイル全文を返してください。

ルール:
- 既存のモジュール構成・import 規約に合わせる
- child_process / vm は禁止。eval, process.exit, new Function は禁止`;

function patcherSystemPromptForPath(normPath: string): string {
    if (isSkillMutablePath(normPath)) return SYSTEM_PROMPT;
    if (isLlmServiceMutablePath(normPath)) return SYSTEM_PROMPT_LLM;
    if (normPath.startsWith('src/services/minebot/')) return SYSTEM_PROMPT_MINEBOT;
    return SYSTEM_PROMPT_BACKEND_TS;
}

export class SkillPatcher {
    private validator = new CodeValidator();

    /**
     * CodeAgentLoop（自律エージェント）を使った高度な修正。
     * 複数ファイルの探索・差分適用・tsc 検証をループで行う。
     */
    async diagnoseAndFixWithAgent(
        skillName: string,
        sourceFile: string,
        failedTests: TestResult[],
    ): Promise<{ fixAttempts: FixAttempt[]; fixed: boolean; rolledBack: boolean }> {
        const { runCodeAgentLoop } = await import('./CodeAgentLoop.js');

        const testInfo = failedTests.map(t => {
            let s = `- テスト: ${t.testCase.description} (args: ${JSON.stringify(t.testCase.args)})`;
            if (t.skillResult) {
                s += `\n  success=${t.skillResult.success}, result=${t.skillResult.result}`;
                if (t.skillResult.error) s += `\n  error: ${t.skillResult.error}`;
            } else {
                s += `\n  スキル実行失敗: ${t.errorMessage}`;
            }
            return s;
        }).join('\n');

        const result = await runCodeAgentLoop({
            description: `スキル "${skillName}" (${sourceFile}) のテストが失敗しています。原因を探索し、修正してください。`,
            targetFile: sourceFile,
            failedTestInfo: testInfo,
            maxIterations: 20,
        });

        return {
            fixAttempts: [{
                attempt: 1,
                diff: result.summary,
                compileSuccess: result.success,
                compileErrors: result.success ? [] : [result.summary],
                testPassed: result.success ? true : null,
                model: 'gpt-4.1 (CodeAgentLoop)',
            }],
            fixed: result.success,
            rolledBack: false,
        };
    }

    /**
     * 失敗したスキルを診断・修正する（レガシー: 固定3回ループ）。
     * 最大 MAX_FIX_ATTEMPTS 回の PDCA を試行し、全て失敗したら rollback。
     */
    async diagnoseAndFix(
        skillName: string,
        sourceFile: string,
        failedTests: TestResult[],
        bot: import('../../../../minebot/types.js').CustomBot,
        skillKind: 'instant' | 'constant',
        chainContext?: string,
    ): Promise<{ fixAttempts: FixAttempt[]; fixed: boolean; rolledBack: boolean }> {
        const fixAttempts: FixAttempt[] = [];

        if (!isMutableRelativePath(sourceFile)) {
            log.warn(`⛔ 書き換え禁止パス: ${sourceFile}`);
            return { fixAttempts, fixed: false, rolledBack: false };
        }

        // 元コードの backup
        const absolutePath = resolve(getBackendRoot(), sourceFile);
        let originalCode: string;
        try {
            originalCode = await readFile(absolutePath, 'utf-8');
        } catch (err: any) {
            log.error(`ソースファイル読み込み失敗: ${absolutePath}: ${err.message}`);
            return { fixAttempts, fixed: false, rolledBack: false };
        }

        let currentCode = originalCode;
        let lastCompileErrors: string[] = [];
        const normPath =
            sanitizeMutableRelativePath(sourceFile)?.replace(/\\/g, '/')
            ?? sourceFile.replace(/\\/g, '/');
        const systemPrompt = patcherSystemPromptForPath(normPath);
        const needsSkillHotReload = isSkillMutablePath(normPath);

        for (let attempt = 1; attempt <= C.MAX_FIX_ATTEMPTS; attempt++) {
            const modelName = 'gpt-4.1-mini';

            try {
                log.info(`🔧 修正試行 ${attempt}/${C.MAX_FIX_ATTEMPTS}: ${skillName} (${modelName})`);

                // LLM に修正を依頼
                const prompt = this.buildFixPrompt(
                    skillName, currentCode, failedTests, lastCompileErrors, normPath, needsSkillHotReload, chainContext,
                );

                const model = createTracedModel({ modelName, temperature: 0.2 });
                const structuredLLM = model.withStructuredOutput(FixSchema, {
                    name: 'SkillFix',
                });

                const response = await structuredLLM.invoke([
                    new SystemMessage(systemPrompt),
                    new HumanMessage(prompt),
                ]);

                if (response?.skipFix) {
                    log.info(`  ⏭️ LLM がスキップ判定: ${response.explanation}`);
                    fixAttempts.push({
                        attempt, diff: '', compileSuccess: false,
                        compileErrors: [`skipFix: ${response.explanation}`], testPassed: null, model: modelName,
                    });
                    return { fixAttempts, fixed: false, rolledBack: false };
                }

                if (!response?.code) {
                    log.warn(`  ❌ LLM がコードを返しませんでした`);
                    fixAttempts.push({
                        attempt, diff: '', compileSuccess: false,
                        compileErrors: ['LLM がコードを返しませんでした'], testPassed: null, model: modelName,
                    });
                    continue;
                }

                log.info(`  📋 LLM 診断: ${response.explanation}`);

                const newCode = this.extractCode(response.code);
                const diff = this.computeDiff(currentCode, newCode);

                const changedLines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length;
                log.info(`  📝 差分: ${changedLines} 行変更`);
                if (changedLines <= 30) {
                    for (const line of diff.split('\n').slice(0, 40)) {
                        log.info(`    ${line}`);
                    }
                } else {
                    for (const line of diff.split('\n').slice(0, 15)) {
                        log.info(`    ${line}`);
                    }
                    log.info(`    ... (残り ${changedLines - 15} 行省略)`);
                }

                if (changedLines > C.MAX_PATCH_LINES) {
                    log.warn(`  ⛔ 変更行数超過: ${changedLines} > ${C.MAX_PATCH_LINES}`);
                    fixAttempts.push({
                        attempt, diff, compileSuccess: false,
                        compileErrors: [`変更行数超過: ${changedLines} > ${C.MAX_PATCH_LINES}`],
                        testPassed: null, model: modelName,
                    });
                    continue;
                }

                const validation = this.validator.validateMutableFile(newCode, sourceFile, currentCode);
                if (!validation.valid) {
                    log.warn(`  ⛔ バリデーション失敗: ${validation.errors.join(', ')}`);
                    fixAttempts.push({
                        attempt, diff, compileSuccess: false,
                        compileErrors: validation.errors, testPassed: null, model: modelName,
                    });
                    lastCompileErrors = validation.errors;
                    continue;
                }
                log.info(`  ✅ バリデーション通過`);

                await writeFile(absolutePath, newCode, 'utf-8');
                currentCode = newCode;

                const compileResult = await this.compile(absolutePath);

                if (!compileResult.success) {
                    log.warn(`  ⛔ コンパイル失敗: ${compileResult.errors.join(', ')}`);
                    lastCompileErrors = compileResult.errors;
                    fixAttempts.push({
                        attempt, diff, compileSuccess: false,
                        compileErrors: compileResult.errors, testPassed: null, model: modelName,
                    });
                    continue;
                }
                log.info(`  ✅ コンパイル成功`);

                const reloadResult = needsSkillHotReload
                    ? await this.hotReload(
                        compileResult.jsPath!, skillName, bot, skillKind,
                    )
                    : { success: true as const };

                if (!reloadResult.success) {
                    log.warn(`  ⛔ ホットリロード失敗: ${reloadResult.error ?? 'unknown'}`);
                    fixAttempts.push({
                        attempt, diff, compileSuccess: true,
                        compileErrors: [reloadResult.error ?? 'reload failed'],
                        testPassed: null, model: modelName,
                    });
                    continue;
                }

                log.info(
                    needsSkillHotReload
                        ? `  🎉 修正完了: ${skillName} — ${response.explanation}`
                        : `  🎉 修正完了（ホットリロードなし）: ${skillName} — ${response.explanation}`,
                );

                fixAttempts.push({
                    attempt, diff, compileSuccess: true,
                    compileErrors: [], testPassed: null,
                    model: modelName,
                });

                return { fixAttempts, fixed: true, rolledBack: false };
            } catch (err: any) {
                log.error(`修正試行 ${attempt} エラー: ${err.message}`);
                log.warn(
                    'SkillPatcher: LLM/API 失敗時は OPENAI_API_KEY・ネットワーク・レート制限を確認してください。',
                );
                fixAttempts.push({
                    attempt, diff: '', compileSuccess: false,
                    compileErrors: [err.message], testPassed: null, model: modelName,
                });
            }
        }

        // 全試行失敗 → rollback
        log.warn(`⏪ 全試行失敗、rollback: ${skillName}`);
        await this.rollback(absolutePath, originalCode, skillName, bot, skillKind, !needsSkillHotReload);

        return { fixAttempts, fixed: false, rolledBack: true };
    }

    // ── private ──

    private buildFixPrompt(
        skillName: string,
        code: string,
        failedTests: TestResult[],
        prevCompileErrors: string[],
        relativePath: string,
        isSkillFile: boolean,
        chainContext?: string,
    ): string {
        const header = isSkillFile
            ? `## スキル: ${skillName}\n\n`
            : `## 対象ファイル（backend 相対）: ${relativePath}\n## 論理名 / スキル: ${skillName}\n\n`;
        let prompt = `${header}### ソースコード\n\`\`\`typescript\n${code}\n\`\`\`\n`;

        if (chainContext) {
            prompt += `\n### チェーンコンテキスト（前段ステップの実行結果）\n${chainContext}\n`;
            prompt += `\n上記を踏まえて、この失敗がコードのバグなのか、前段ステップの未完了による外部要因なのかを判断してください。\n`;
            prompt += `外部要因の場合は skipFix: true を返してください。\n`;
        }

        prompt += '\n### 失敗したテスト結果\n';
        for (const t of failedTests) {
            prompt += `- テスト: ${t.testCase.description}\n`;
            prompt += `  args: ${JSON.stringify(t.testCase.args)}\n`;
            if (t.skillResult) {
                prompt += `  結果: success=${t.skillResult.success}\n`;
                prompt += `  メッセージ: ${t.skillResult.result}\n`;
                if (t.skillResult.failureType) prompt += `  failureType: ${t.skillResult.failureType}\n`;
                if (t.skillResult.error) prompt += `  error: ${t.skillResult.error}\n`;
            } else {
                prompt += `  結果: スキル実行自体が失敗（例外）\n`;
                if (t.errorMessage) prompt += `  エラー: ${t.errorMessage}\n`;
            }
        }

        if (prevCompileErrors.length > 0) {
            prompt += '\n### 前回の修正で発生したエラー\n';
            prompt += prevCompileErrors.map(e => `- ${e}`).join('\n');
            prompt += '\n\n上記エラーを解決してください。';
        }

        prompt += '\n\n修正した完全なソースコードを返してください（外部要因の場合は skipFix: true）。';
        return prompt;
    }

    private extractCode(raw: string): string {
        // マークダウンコードブロックの除去
        const match = raw.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
        return match ? match[1].trim() : raw.trim();
    }

    private computeDiff(original: string, modified: string): string {
        const origLines = original.split('\n');
        const modLines = modified.split('\n');
        const diff: string[] = [];

        const maxLen = Math.max(origLines.length, modLines.length);
        for (let i = 0; i < maxLen; i++) {
            const orig = origLines[i];
            const mod = modLines[i];
            if (orig === mod) continue;
            if (orig !== undefined && mod === undefined) {
                diff.push(`-${i + 1}: ${orig}`);
            } else if (orig === undefined && mod !== undefined) {
                diff.push(`+${i + 1}: ${mod}`);
            } else if (orig !== mod) {
                diff.push(`-${i + 1}: ${orig}`);
                diff.push(`+${i + 1}: ${mod}`);
            }
        }

        return diff.join('\n');
    }

    private async compile(tsPath: string): Promise<{ success: boolean; jsPath: string | null; errors: string[] }> {
        const { SkillCompiler } = await import('../../../../minebot/skills/SkillCompiler.js');
        const compiler = new SkillCompiler();
        return compiler.compile(tsPath);
    }

    private async hotReload(
        jsPath: string,
        skillName: string,
        bot: import('../../../../minebot/types.js').CustomBot,
        skillKind: 'instant' | 'constant',
    ): Promise<{ success: boolean; error?: string }> {
        const { SkillHotLoader } = await import('../../../../minebot/skills/SkillHotLoader.js');
        const { getSkillRegistrar } = await import('../../../../minebot/skills/SkillRegistrar.js');
        const { getEventBus } = await import('../../../../eventBus/index.js');
        const hotLoader = new SkillHotLoader(getSkillRegistrar(getEventBus()));
        if (skillKind === 'constant') {
            return hotLoader.replaceConstantSkill(jsPath, bot, skillName, 'SelfTest auto-fix');
        }
        return hotLoader.replaceInstantSkill(jsPath, bot, skillName, 'SelfTest auto-fix');
    }

    private async rollback(
        absolutePath: string,
        originalCode: string,
        skillName: string,
        bot: import('../../../../minebot/types.js').CustomBot,
        skillKind: 'instant' | 'constant',
        skipHotReload: boolean,
    ): Promise<void> {
        try {
            await writeFile(absolutePath, originalCode, 'utf-8');
            const compileResult = await this.compile(absolutePath);
            if (!skipHotReload && compileResult.success && compileResult.jsPath) {
                await this.hotReload(compileResult.jsPath, skillName, bot, skillKind);
            }
            log.info(`⏪ rollback 完了: ${skillName}`);
        } catch (err: any) {
            log.error(`rollback エラー: ${err.message}`);
        }
    }
}
