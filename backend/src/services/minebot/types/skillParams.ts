import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:Types');

/**
 * スキルパラメータの型定義を厳密化
 */

/**
 * サポートされるパラメータ型
 */
export type SkillParamType = 'string' | 'number' | 'boolean' | 'Vec3';

/**
 * スキルパラメータの定義
 */
export interface SkillParam {
    name: string;
    type: SkillParamType;
    description: string;
    required?: boolean;
    default?: string | number | boolean | null;
}

/**
 * Vec3座標パラメータ
 */
export interface Vec3Param {
    x: number;
    y: number;
    z: number;
}

/**
 * ランタイムでのパラメータ値の型
 */
export type SkillParamValue = string | number | boolean | Vec3Param | null | undefined;

/**
 * スキルの実行結果
 */
export interface SkillResult {
    success: boolean;
    result: string;
    failureType?: string;
    recoverable?: boolean;
    error?: string;
    duration?: number;
}

/**
 * スキルのメタデータ
 */
export interface SkillMetadata {
    skillName: string;
    description: string;
    priority?: number;
    isToolForLLM?: boolean;
    canUseByCommand?: boolean;
    params: SkillParam[];
}

/**
 * パラメータのバリデーション関数
 */
export class SkillParamValidator {
    /**
     * パラメータ定義が有効かチェック
     */
    static validateParamDefinition(param: SkillParam): boolean {
        if (!param.name || typeof param.name !== 'string') {
            log.error(`Invalid param name: ${JSON.stringify(param)}`);
            return false;
        }

        const validTypes: SkillParamType[] = ['string', 'number', 'boolean', 'Vec3'];
        if (!validTypes.includes(param.type)) {
            log.error(`Invalid param type: ${param.type}`);
            return false;
        }

        if (!param.description || typeof param.description !== 'string') {
            log.warn(`Param missing description: ${param.name}`);
        }

        return true;
    }

    /**
     * パラメータ値の型が正しいかチェック
     */
    static validateParamValue(param: SkillParam, value: SkillParamValue): boolean {
        if (param.required && (value === null || value === undefined)) {
            log.error(`Required param ${param.name} is missing`);
            return false;
        }

        if (value === null || value === undefined) {
            return true; // optional param
        }

        switch (param.type) {
            case 'string':
                return typeof value === 'string';
            case 'number':
                return typeof value === 'number' && !isNaN(value);
            case 'boolean':
                return typeof value === 'boolean';
            case 'Vec3':
                return (
                    typeof value === 'object' &&
                    value !== null &&
                    'x' in value &&
                    'y' in value &&
                    'z' in value &&
                    typeof value.x === 'number' &&
                    typeof value.y === 'number' &&
                    typeof value.z === 'number'
                );
            default:
                return false;
        }
    }

    /**
     * すべてのパラメータをバリデーション
     */
    static validateAllParams(
        params: SkillParam[],
        values: Record<string, SkillParamValue>
    ): { valid: boolean; errors: string[] } {
        const errors: string[] = [];

        for (const param of params) {
            if (!this.validateParamDefinition(param)) {
                errors.push(`Invalid param definition: ${param.name}`);
                continue;
            }

            const value = values[param.name];
            if (!this.validateParamValue(param, value)) {
                errors.push(
                    `Invalid value for param ${param.name}: expected ${param.type}, got ${typeof value}`
                );
            }
        }

        return {
            valid: errors.length === 0,
            errors,
        };
    }
}

