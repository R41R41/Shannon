import { StructuredTool } from '@langchain/core/tools';
import { Vec3 } from 'vec3';
import { z, ZodObject } from 'zod';
import { CustomBot } from '../types.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:SkillTool');

/**
 * InstantSkillをLangChainのStructuredToolに変換するクラス
 * スキルのパラメータからzodスキーマを動的生成
 */
export class InstantSkillTool extends StructuredTool {
    name: string;
    description: string;
    schema: ZodObject<any>;
    private bot: CustomBot;

    constructor(skill: any, bot: CustomBot) {
        super();
        this.bot = bot;
        this.name = skill.skillName;
        this.description = skill.description;
        this.schema = this.buildSchema(skill.params || []);
    }

    /**
     * スキルパラメータからzodスキーマを構築
     */
    private buildSchema(params: any[]): ZodObject<any> {
        return z.object(
            Object.fromEntries(
                params.map((param: any) => {
                    let zodType = this.getZodType(param.type);

                    // optionalまたはdefaultありの場合
                    if (!param.required || param.default !== undefined) {
                        zodType = zodType.optional().nullable();

                        if (param.default !== undefined) {
                            try {
                                zodType = (zodType as any).default(param.default);
                            } catch (error) {
                                log.error(`デフォルト値の設定に失敗: ${error}`);
                            }
                        }
                    } else {
                        // 必須フィールドはnullを許可しない
                        zodType = zodType;
                    }

                    zodType = zodType.describe(param.description || '');
                    return [param.name, zodType];
                })
            )
        );
    }

    /**
     * パラメータ型からzod型を取得
     */
    private getZodType(type: string): z.ZodTypeAny {
        switch (type) {
            case 'number':
                return z.number();
            case 'Vec3':
                return z.object({ x: z.number(), y: z.number(), z: z.number() });
            case 'boolean':
                return z.boolean();
            case 'string':
            default:
                return z.string();
        }
    }

    /**
     * スキルを実行
     */
    async _call(data: any): Promise<string> {
        const skill = this.bot.instantSkills.getSkill(this.name);
        if (!skill) {
            return `${this.name}スキルが存在しません。`;
        }

        log.success(`${skill.skillName}を実行: ${JSON.stringify(data)}`);

        try {
            const args = this.convertArgs(skill.params || [], data);
            const result = await skill.run(...args);

            if (typeof result === 'string') {
                return result;
            }

            // query系スキルは「ない / 見つからない」を観測結果として返すことがある。
            // success=true の結果まで failure 扱いすると、LLM が探索を打ち切って
            // ユーザーへ聞き返しやすくなるため、推論による failure 判定は失敗時だけ行う。
            const inferredFailureType = result.success
                ? null
                : this.detectFailureTypeFromResult(result.result);
            const effectiveFailureType = result.failureType
                ?? inferredFailureType
                ?? undefined;
            const effectiveSuccess = result.success && !effectiveFailureType;
            const recoverable = result.recoverable
                ?? (!effectiveSuccess ? this.isRecoverableFailure(effectiveFailureType) : undefined);

            let message = `結果: ${effectiveSuccess ? '成功' : '失敗'} 詳細: ${result.result}${
                effectiveSuccess
                    ? ''
                    : ` [failure_type=${effectiveFailureType ?? 'unknown'} recoverable=${recoverable ? 'true' : 'false'}]`
            }`;

            // mine-block が missing_tool で失敗した場合、石のツルハシをクラフトするリカバリを促す
            if (
                this.name === 'mine-block' &&
                !effectiveSuccess &&
                (effectiveFailureType === 'missing_tool' || /適切なツール|missing_tool/.test(String(result.result)))
            ) {
                message += ' リカバリ: 石のツルハシを作る材料(cobblestone x3以上, stick x2以上)がインベントリにあれば、先に craft-one(stone_pickaxe) を実行してください。丸石(cobblestone)の採掘にもツルハシが必要なため、素手で丸石を採掘することはできません。';
            }

            return message;
        } catch (error) {
            log.error(`${this.name}スキル実行エラー`, error);
            return `スキル実行エラー: ${error} [failure_type=unexpected_error recoverable=false]`;
        }
    }

    /**
     * データをスキルの引数に変換
     */
    private convertArgs(params: any[], data: any): any[] {
        return params.map((param) => {
            const value = data[param.name];

            if (param.type === 'Vec3' && value) {
                return new Vec3(value.x, value.y, value.z);
            }
            if (param.type === 'boolean') {
                if (value === 'true') return true;
                if (value === 'false') return false;
            }
            return value;
        });
    }

    private classifyFailureType(message: string): string {
        const normalized = message.toLowerCase();
        if (normalized.includes('ではありません')) {
            return 'invalid_target_type';
        }
        if (normalized.includes('適切なツールがありません') || normalized.includes('missing_tool')) {
            return 'missing_tool';
        }
        if (normalized.includes('パスが見つかりません')) {
            return 'path_not_found';
        }
        if (normalized.includes('decide path to goal') || normalized.includes('took to long')) {
            return 'path_not_found';
        }
        if (normalized.includes('見つかりません')) {
            if (normalized.includes('crafting_table') || normalized.includes('インベントリに')) {
                return 'material_missing';
            }
            return 'target_not_found';
        }
        if (normalized.includes('必要です') || normalized.includes('ありません')) {
            return 'material_missing';
        }
        if (normalized.includes('遠すぎ')) {
            return 'distance_too_far';
        }
        if (normalized.includes('タイムアウト')) {
            return 'timeout';
        }
        if (normalized.includes('中断')) {
            return 'interrupted';
        }
        if (normalized.includes('危険') || normalized.includes('unsafe')) {
            return 'unsafe';
        }
        return 'action_failed';
    }

    private detectFailureTypeFromResult(message: string): string | null {
        const failureType = this.classifyFailureType(message);
        return failureType === 'action_failed' ? null : failureType;
    }

    private isRecoverableFailure(failureType: string | undefined): boolean {
        switch (failureType) {
            case 'unexpected_error':
            case 'unsafe':
                return false;
            default:
                return true;
        }
    }
}
