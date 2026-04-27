import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
const log = createLogger('Minebot:Skill:switchConstantSkill');

/**
 * パラメータ名 → 実際の常時スキル名のマッピング
 * constantSkills.json / constantSkills/*.ts に実在するスキル名に合わせること
 */
const PARAM_TO_SKILL_NAME: Record<string, string> = {
    switchAutoAvoidProjectileRange: 'auto-avoid-projectile-range',
    switchAutoEat: 'auto-eat',
    switchAutoPickUpItem: 'auto-pick-up-item',
    switchAutoRunFromHostile: 'auto-run-from-hostiles',   // 実装は複数形
    switchAutoSleep: 'auto-sleep',
    switchAutoSwim: 'auto-swim',
    switchAutoFaceNearestEntity: 'auto-face-nearest-entity',
    switchAutoAvoidDragonBreath: 'auto-avoid-dragon-breath',
    switchAutoFollow: 'auto-follow',
    switchAutoPearlSave: 'auto-pearl-save',
};

export class SwitchConstantSkill extends InstantSkill {
    constructor(bot: CustomBot) {
        super(bot);
        this.skillName = 'switch-constant-skill';
        this.description = '常時実行するスキルを有効/無効にします。変更したいスキルのみ指定してください（指定しないスキルは変更されません）';
        this.priority = 10;
        this.params = [
            {
                name: 'switchAutoAvoidProjectileRange',
                type: 'boolean',
                description: 'スケルトンなどの射撃範囲の自動回避を有効にするかどうか',
            },
            {
                name: 'switchAutoEat',
                type: 'boolean',
                description: '自動で食べるを有効にするかどうか',
            },
            {
                name: 'switchAutoPickUpItem',
                type: 'boolean',
                description: '落ちているアイテムの自動収集を有効にするかどうか',
            },
            {
                name: 'switchAutoRunFromHostile',
                type: 'boolean',
                description: '敵モブから自動で逃げる機能を有効にするかどうか',
            },
            {
                name: 'switchAutoSleep',
                type: 'boolean',
                description: '夜になったら自動で寝る機能を有効にするかどうか',
            },
            {
                name: 'switchAutoSwim',
                type: 'boolean',
                description: '水中に入ったら自動で泳ぐ機能を有効にするかどうか',
            },
            {
                name: 'switchAutoFaceNearestEntity',
                type: 'boolean',
                description: '近くのエンティティに自動で顔を向ける機能を有効にするかどうか',
            },
            {
                name: 'switchAutoAvoidDragonBreath',
                type: 'boolean',
                description: 'ドラゴンブレスを自動で回避する機能を有効にするかどうか',
            },
            {
                name: 'switchAutoFollow',
                type: 'boolean',
                description: 'プレイヤーを自動で追従する機能を有効にするかどうか',
            },
            {
                name: 'switchAutoPearlSave',
                type: 'boolean',
                description: '落下時にエンダーパールで自動着地する機能を有効にするかどうか（エンド専用）',
            },
        ];
    }

    async runImpl(...args: any[]) {
        try {
            const results: string[] = [];
            const errors: string[] = [];

            // パラメータ定義の順序に対応する引数を処理
            for (let i = 0; i < this.params.length; i++) {
                const paramName = this.params[i].name;
                const value = args[i];

                // 未指定のパラメータはスキップ（変更しない）
                if (value === undefined || value === null) continue;

                const skillName = PARAM_TO_SKILL_NAME[paramName];
                if (!skillName) {
                    errors.push(`不明なパラメータ: ${paramName}`);
                    continue;
                }

                const skill = this.bot.constantSkills.getSkill(skillName);
                if (!skill) {
                    log.warn(`⚠️ 常時スキルが未登録: ${skillName} (${paramName})`);
                    errors.push(`スキル未登録: ${skillName}`);
                    continue;
                }

                skill.status = value;
                results.push(`${skillName}: ${value ? '有効' : '無効'}`);
            }

            if (results.length === 0 && errors.length > 0) {
                return { success: false, result: `全て失敗: ${errors.join(', ')}` };
            }

            const message = results.length > 0
                ? `更新完了: ${results.join(', ')}`
                : '変更対象のスキルがありません';
            const errorMessage = errors.length > 0
                ? ` (警告: ${errors.join(', ')})`
                : '';

            return {
                success: results.length > 0,
                result: message + errorMessage,
            };
        } catch (error: any) {
            return { success: false, result: `${error.message} in ${error.stack}` };
        }
    }
}

export default SwitchConstantSkill;
