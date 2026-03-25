/**
 * HTTP関連の型定義
 */

/**
 * API レスポンスの基本型
 */
export interface ApiResponse<T = any> {
    success: boolean;
    result: string | T;
    error?: string;
    data?: T;
}

/**
 * スキル実行結果
 */
export interface SkillExecutionResult {
    success: boolean;
    result: string;
    metadata?: Record<string, unknown>;
}

/**
 * アイテム投げ捨てリクエスト
 */
export interface ThrowItemRequest {
    itemName: string;
    count?: number;
}

/**
 * コンスタントスキル切り替えリクエスト
 */
export interface ConstantSkillSwitchRequest {
    skillName: string;
    status: string; // 'true' | 'false'
}

/**
 * コンスタントスキル情報（UI送信用）
 */
export interface ConstantSkillInfo {
    skillName: string;
    description: string;
    status: boolean;
}

