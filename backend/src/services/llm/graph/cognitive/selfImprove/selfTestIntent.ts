/**
 * マイクラチャット等からの「この self_test_cases を実行して」意図を軽量パースする。
 * （LLM 不要・決定的なルールのみ）
 */

import { SELF_IMPROVE_CONSTANTS as C } from './types.js';

const CASES_MARKER = 'self_test_cases/';

/**
 * chatMode OFF でも通す SelfTest 用メッセージか（..test 系以外の自然文）。
 */
export function looksLikeSelfTestChatIntent(message: string): boolean {
    const m = message.trim();
    if (!m) return false;
    if (m.startsWith('..test-all') || m.startsWith('..test-smoke')) return false;
    if (m.startsWith('..test')) return true;

    const lower = m.toLowerCase();
    if (lower.includes('self_test_cases')) return true;

    const dir = C.SELF_TEST_CASES_DIR.replace(/\\/g, '/').toLowerCase();
    if (lower.includes(dir)) return true;

    if (/\.json\b/i.test(m) && /(テスト|test)/i.test(m)) return true;

    if (/(テストケース|をテスト|のテスト)/.test(m) && /[\w-]+\.json/i.test(m)) return true;

    return false;
}

/**
 * スイート名（拡張子なし）と autoFix フラグを返す。解釈不能なら null。
 * ..test-all / ..test-smoke は null（呼び出し側で別処理）。
 */
export function parseSelfTestSuiteFromUserMessage(raw: string): { suiteName: string; autoFix: boolean } | null {
    const original = raw.trim();
    if (original.startsWith('..test-all') || original.startsWith('..test-smoke')) {
        return null;
    }

    const autoFix =
        /--fix\b/i.test(original)
        || /自動修正/.test(original)
        || /適宜修正|修正して|修正する/.test(original);

    let text = original
        .replace(/--fix\b/gi, ' ')
        .replace(/\s*自動修正\s*/g, ' ')
        .trim();

    if (text.startsWith('..test')) {
        text = text.slice('..test'.length).trim();
    }

    const jsonMatch = text.match(/([\w./\\-]+\.json)/i);
    if (jsonMatch) {
        let p = jsonMatch[1].replace(/\\/g, '/');
        const mi = p.toLowerCase().indexOf(CASES_MARKER);
        if (mi >= 0) {
            p = p.slice(mi + CASES_MARKER.length);
        }
        const seg = p.replace(/\.json$/i, '');
        const base = seg.includes('/') ? (seg.split('/').pop() ?? '') : seg;
        if (base && /^[\w-]+$/.test(base)) {
            return { suiteName: base, autoFix };
        }
    }

    const ja = text.match(/\b([\w-]{2,80})\b\s*(?:のテストケース|をテスト|のテスト)\b/);
    if (ja && /^[\w-]+$/.test(ja[1])) {
        return { suiteName: ja[1], autoFix };
    }

    const slugOnly = text.match(/^([\w-]+)\s*$/);
    if (slugOnly) {
        return { suiteName: slugOnly[1], autoFix };
    }

    return null;
}
