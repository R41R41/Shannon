/**
 * 自己改善で読み書き削除してよいパス（backend ルート相対）の判定。
 * 原則: backend パッケージ直下はすべて可（下記 deny / skip 以外）。
 */

import { relative, resolve } from 'node:path';
import { getBackendRoot } from '../../../../../utils/backendRoot.js';

/** 変更禁止（秘密・ビルド定義・ロックファイル等） */
export const MUTABLE_PATH_DENY_SUBSTRINGS = [
    'src/config/',
    // Human-reviewed authentication/authorization and lifecycle boundaries.
    'src/modules/access/',
    'src/modules/modelSettings/',
    'src/modules/execution/',
    'src/adapters/access/',
    'src/bootstrap/',
    'src/server.ts',
    'src/services/web/client.ts',
    'src/models/User.ts',
    'src/routes/accessHttp.ts',
    'src/routes/httpSurface.ts',
    'src/services/web/agents/',
    'src/services/twitter/',
    'src/services/minebot/http/',
    'src/services/llm/tools/twitter/',
    'src/services/llm/graph/nodes/FunctionCallingAgent.ts',
    'src/services/llm/graph/nodes/FunctionCallingSession.ts',
    'src/services/llm/tools/memory/',
    'src/services/llm/tools/utility/updatePlan.ts',
    'src/services/llm/tools/utility/planCraft.ts',
    'src/services/llm/graph/nodes/execution/ToolExecutor.ts',
    'src/services/llm/client.ts',
    'src/services/llm/graph/requestExecutionCoordinator.ts',
    'src/services/llm/graph/coordinatedGraphInvocation.ts',
    'src/services/llm/graph/shannonGraph.ts',
    'src/services/llm/graph/cognitive/ParallelExecutor.ts',
    'scripts/',
    'src/routes/modelRoutes.ts',
    'src/services/web/agents/auth',
    'src/services/common/WebSocketService.ts',
    'mutableCodePolicy.ts',
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'tsconfig',
    '.env',
] as const;

/** 生成物・依存で編集対象外 */
const MUTABLE_SKIP_PREFIXES = [
    'node_modules/',
    'dist/',
    '.git/',
    'coverage/',
] as const;

export function sanitizeMutableRelativePath(input: string): string | null {
    let p = input.trim().replace(/\\/g, '/');
    if (p.startsWith('backend/')) {
        p = p.slice('backend/'.length);
    }
    if (!p || p.startsWith('/') || p.includes('..')) {
        return null;
    }
    const root = resolve(getBackendRoot());
    const abs = resolve(root, p);
    const rel = relative(root, abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || rel.includes('..')) {
        return null;
    }
    return rel;
}

export function isDeniedMutablePath(rel: string): boolean {
    const n = rel.replace(/\\/g, '/');
    return MUTABLE_PATH_DENY_SUBSTRINGS.some(d => n.includes(d));
}

function isUnderSkipPrefix(rel: string): boolean {
    const n = rel.replace(/\\/g, '/');
    return MUTABLE_SKIP_PREFIXES.some(
        p => n === p.slice(0, -1) || n.startsWith(p),
    );
}

/**
 * backend ルート配下で、deny/skip に当たらないパスはすべて mutable。
 */
export function isMutableRelativePath(rel: string): boolean {
    const n = sanitizeMutableRelativePath(rel);
    if (!n || isDeniedMutablePath(n) || isUnderSkipPrefix(n)) {
        return false;
    }
    return true;
}

export function isSkillMutablePath(rel: string): boolean {
    const n = sanitizeMutableRelativePath(rel);
    if (!n) return false;
    return (
        n.startsWith('src/services/minebot/instantSkills/')
        || n.startsWith('src/services/minebot/constantSkills/')
    );
}

export function isLlmServiceMutablePath(rel: string): boolean {
    const n = sanitizeMutableRelativePath(rel);
    if (!n) return false;
    return n.startsWith('src/services/llm/');
}
