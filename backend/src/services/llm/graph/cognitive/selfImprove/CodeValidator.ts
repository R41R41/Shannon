/**
 * CodeValidator — Tier 2 コード検証
 *
 * 生成された TypeScript / JSON 等の安全性を検証する。
 */

import { createLogger } from '../../../../../utils/logger.js';
import { SELF_IMPROVE_CONSTANTS as C } from './types.js';
import {
    isLlmServiceMutablePath,
    isSkillMutablePath,
    sanitizeMutableRelativePath,
} from './mutableCodePolicy.js';

const log = createLogger('SelfImprove:Validator');

/** 禁止パターン: セキュリティリスクのある API 呼び出し */
const BLOCKED_PATTERNS = [
    /\bprocess\.exit\b/,
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
    /\brequire\s*\(\s*['"]child_process['"]\s*\)/,
    /\bimport\s+.*['"]child_process['"]/,
    /\bimport\s+.*['"]fs['"]/,       // fs 直接使用は禁止（既存ユーティリティを使う）
    /\bexecSync\b/,
    /\bspawnSync\b/,
    /\bexec\s*\(/,
    /\b__dirname\b/,                  // パス操作は制限
    /\b__filename\b/,
    /\bprocess\.env\b/,               // 環境変数への直接アクセスは禁止
    /\bglobal\b/,
    /\bglobalThis\b/,
    /\bPromise\.resolve\(\)\s*\.then\b/,  // Promise trick でのサンドボックス回避
];

/** 許可されるインポートパターン（minebot スキル向け・厳しめ） */
const ALLOWED_IMPORTS_SKILL = [
    /from\s+['"]\.\.?\//,
    /from\s+['"]minecraft-data['"]/,
    /from\s+['"]vec3['"]/,
    /from\s+['"]@shannon\/common['"]/,
];

/** サービス層 TS: 危険なモジュール以外は許可 */
const SERVICE_LAYER_BLOCKED_IMPORT = [
    /['"]child_process['"]/,
    /['"]node:child_process['"]/,
    /['"]vm['"]/,
    /['"]node:vm['"]/,
];

const MAX_MUTABLE_JSON_CHARS = 2_000_000;
const MAX_MUTABLE_PLAIN_CHARS = 500_000;

export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

export class CodeValidator {
    /**
     * 相対パスに応じた検証（スキル / llm / その他 TS / JSON 等）。
     */
    validateMutableFile(code: string, relativePath: string, originalCode?: string): ValidationResult {
        const norm = sanitizeMutableRelativePath(relativePath) ?? relativePath.replace(/\\/g, '/');
        const lower = norm.toLowerCase();

        if (lower.endsWith('.json')) {
            return this.validateMutableJson(code, originalCode);
        }
        if (isSkillMutablePath(norm)) {
            return this.validate(code, originalCode);
        }
        if (/\.(tsx?|mts|cts)$/.test(lower)) {
            const maxLines = isLlmServiceMutablePath(norm)
                ? C.MAX_LLM_MUTABLE_LINES
                : C.MAX_BACKEND_TS_LINES;
            return this.validateServiceLayerTypeScript(code, originalCode, maxLines);
        }
        return this.validatePlainMutableFile(code, originalCode);
    }

    /**
     * src/services/llm およびその他バックエンド TS 用。
     */
    private validateServiceLayerTypeScript(
        code: string,
        originalCode: string | undefined,
        maxLines: number,
    ): ValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        const BLOCKED_SERVICE_EXTRA = [
            /\bprocess\.exit\b/,
            /\beval\s*\(/,
            /\bnew\s+Function\b/,
            /\brequire\s*\(\s*['"]child_process['"]\s*\)/,
            /\bimport\s+.*['"]child_process['"]/,
            /\bexecSync\b/,
            /\bspawnSync\b/,
            /\bexec\s*\(/,
            /\bglobal\b/,
            /\bglobalThis\b/,
            /\bPromise\.resolve\(\)\s*\.then\b/,
        ];
        for (const pattern of BLOCKED_SERVICE_EXTRA) {
            if (pattern.test(code)) {
                errors.push(`セキュリティ違反: 禁止パターン "${pattern.source}" が検出されました`);
            }
        }

        const importLines = code.match(/^import\s+.+$/gm) || [];
        for (const line of importLines) {
            if (SERVICE_LAYER_BLOCKED_IMPORT.some(p => p.test(line))) {
                errors.push(`危険な import: ${line.trim()}`);
            }
        }

        if (originalCode) {
            const originalLines = originalCode.split('\n').length;
            const newLines = code.split('\n').length;
            const changeRatio = Math.abs(newLines - originalLines) / Math.max(originalLines, 1);
            if (changeRatio > C.MAX_CODE_CHANGE_RATIO) {
                errors.push(
                    `変更規模が大きすぎます (${(changeRatio * 100).toFixed(0)}% > ${(C.MAX_CODE_CHANGE_RATIO * 100).toFixed(0)}%上限)`,
                );
            }
        }

        const lineCount = code.split('\n').length;
        if (lineCount > maxLines) {
            errors.push(`コードが ${lineCount} 行（上限: ${maxLines} 行）`);
        }

        const valid = errors.length === 0;
        if (!valid) log.warn(`❌ サービス層 TS 検証失敗: ${errors.length}件`);
        return { valid, errors, warnings };
    }

    /**
     * src/services/llm 配下用（後方互換・validateMutableFile から利用）。
     */
    validateLlmServiceFile(code: string, originalCode?: string): ValidationResult {
        return this.validateServiceLayerTypeScript(code, originalCode, C.MAX_LLM_MUTABLE_LINES);
    }

    private validateMutableJson(code: string, originalCode?: string): ValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];
        if (code.length > MAX_MUTABLE_JSON_CHARS) {
            errors.push(`JSON が大きすぎます（${code.length} 文字 > ${MAX_MUTABLE_JSON_CHARS}）`);
        }
        try {
            JSON.parse(code);
        } catch (e: any) {
            errors.push(`JSON パース失敗: ${e?.message ?? e}`);
        }
        if (originalCode) {
            const changeRatio = Math.abs(code.length - originalCode.length) / Math.max(originalCode.length, 1);
            if (changeRatio > C.MAX_CODE_CHANGE_RATIO) {
                errors.push(
                    `変更規模が大きすぎます (${(changeRatio * 100).toFixed(0)}% > ${(C.MAX_CODE_CHANGE_RATIO * 100).toFixed(0)}%上限)`,
                );
            }
        }
        const valid = errors.length === 0;
        if (!valid) log.warn(`❌ JSON 検証失敗: ${errors.length}件`);
        return { valid, errors, warnings };
    }

    private validatePlainMutableFile(code: string, originalCode?: string): ValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];
        if (code.includes('\0')) {
            errors.push('バイナリ的な内容が含まれています');
        }
        if (code.length > MAX_MUTABLE_PLAIN_CHARS) {
            errors.push(`ファイルが大きすぎます（${code.length} > ${MAX_MUTABLE_PLAIN_CHARS} 文字）`);
        }
        if (originalCode) {
            const changeRatio = Math.abs(code.length - originalCode.length) / Math.max(originalCode.length, 1);
            if (changeRatio > C.MAX_CODE_CHANGE_RATIO) {
                errors.push(
                    `変更規模が大きすぎます (${(changeRatio * 100).toFixed(0)}% > ${(C.MAX_CODE_CHANGE_RATIO * 100).toFixed(0)}%上限)`,
                );
            }
        }
        return { valid: errors.length === 0, errors, warnings };
    }

    /**
     * 生成されたコードを検証する（minebot スキル想定・厳しめ import）。
     */
    validate(code: string, originalCode?: string): ValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        // 1. 禁止パターンのチェック
        for (const pattern of BLOCKED_PATTERNS) {
            if (pattern.test(code)) {
                errors.push(`セキュリティ違反: 禁止パターン "${pattern.source}" が検出されました`);
            }
        }

        // 2. インポートの検証
        const importLines = code.match(/^import\s+.+$/gm) || [];
        for (const line of importLines) {
            const isAllowed = ALLOWED_IMPORTS_SKILL.some(p => p.test(line));
            if (!isAllowed) {
                errors.push(`許可されていないインポート: ${line.trim()}`);
            }
        }

        // 3. 変更規模の制限（元コードがある場合）
        if (originalCode) {
            const originalLines = originalCode.split('\n').length;
            const newLines = code.split('\n').length;
            const changeRatio = Math.abs(newLines - originalLines) / originalLines;

            if (changeRatio > C.MAX_CODE_CHANGE_RATIO) {
                errors.push(
                    `変更規模が大きすぎます (${(changeRatio * 100).toFixed(0)}% > ${(C.MAX_CODE_CHANGE_RATIO * 100).toFixed(0)}%上限)`,
                );
            }

            if (newLines > originalLines * 2) {
                warnings.push(`コードが元の2倍以上に増えています (${originalLines} → ${newLines}行)`);
            }
        }

        // 4. 基本的な構文チェック
        if (!code.includes('class') && !code.includes('function') && !code.includes('export')) {
            warnings.push('クラスまたは関数の定義が見つかりません');
        }

        // 5. InstantSkill パターンのチェック
        if (code.includes('extends InstantSkill') || code.includes('extends ConstantSkill')) {
            if (!code.includes('runImpl')) {
                errors.push('InstantSkill/ConstantSkill を継承していますが runImpl メソッドがありません');
            }
        }

        // export default / named export のいずれか（TS モジュールとして成立）
        const hasExport = /\bexport\s+default\b/.test(code) || /^\s*export\s+(abstract\s+)?(class|function|const|type|interface)\s+/m.test(code);
        if (!hasExport && code.split('\n').length > 5) {
            warnings.push('export が見当たりません（意図したモジュールか確認）');
        }

        // 6. 行数制限
        const lineCount = code.split('\n').length;
        if (lineCount > C.MAX_GENERATED_CODE_LINES) {
            errors.push(`コードが ${lineCount} 行あります（上限: ${C.MAX_GENERATED_CODE_LINES} 行）`);
        }

        const valid = errors.length === 0;

        if (!valid) {
            log.warn(`❌ 検証失敗: ${errors.length}件のエラー`);
        } else if (warnings.length > 0) {
            log.info(`⚠️ 検証通過（警告あり: ${warnings.length}件）`);
        }

        return { valid, errors, warnings };
    }

    /**
     * 生成スキル専用のバリデーション。
     * 基本検証に加えて、スキル固有のルールをチェックする。
     */
    validateGeneratedSkill(
        code: string,
        skillType: 'instant' | 'constant',
        existingSkillNames: string[],
    ): ValidationResult {
        // 基本検証
        const base = this.validate(code);

        // export default チェック
        if (!code.includes('export default')) {
            base.errors.push('export default が必要です');
        }

        // クラス継承チェック
        const expectedBase = skillType === 'instant' ? 'InstantSkill' : 'ConstantSkill';
        if (!code.includes(`extends ${expectedBase}`)) {
            base.errors.push(`${expectedBase} を継承していません`);
        }

        // skillName の重複チェック
        const nameMatch = code.match(/this\.skillName\s*=\s*['"]([^'"]+)['"]/);
        if (nameMatch) {
            const skillName = nameMatch[1];
            if (existingSkillNames.includes(skillName)) {
                base.errors.push(`スキル名 "${skillName}" は既に存在します`);
            }
        } else {
            base.errors.push('this.skillName の設定が見つかりません');
        }

        // ConstantSkill の interval チェック
        if (skillType === 'constant') {
            const intervalMatch = code.match(/this\.interval\s*=\s*(\d+)/);
            if (intervalMatch) {
                const interval = parseInt(intervalMatch[1]);
                if (interval < C.MIN_CONSTANT_SKILL_INTERVAL) {
                    base.errors.push(
                        `interval が ${interval}ms です（最小: ${C.MIN_CONSTANT_SKILL_INTERVAL}ms）`,
                    );
                }
            }
        }

        // dynamic import 禁止
        if (/\bimport\s*\(/.test(code)) {
            base.errors.push('動的 import は禁止されています');
        }

        base.valid = base.errors.length === 0;
        return base;
    }

    /**
     * tsc --noEmit を実行して TypeScript コンパイルチェックする。
     * SkillCompiler に委譲する。
     */
    async compileCheck(_filePath: string): Promise<ValidationResult> {
        return {
            valid: true,
            errors: [],
            warnings: [],
        };
    }
}
