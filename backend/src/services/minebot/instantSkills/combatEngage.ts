import { CustomBot, InstantSkill } from '../types.js';
import { CombatController } from '../combat/CombatController.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:Skill:combatEngage');

/**
 * combat-engage: CombatController による汎用戦闘
 *
 * LLM から呼ばれると、CombatController が 200ms 周期で
 * 状況をスキャンし、最善の行動をスコアリングして自律実行する。
 * 敵全滅 or HP 危険逃走 or タイムアウトで終了。
 *
 * 旧 combat スキルとの違い:
 * - 複数体の敵に対処可能
 * - 遠距離攻撃 (スケルトン, ブレイズ) に盾・横移動で対処
 * - クリーパーは殴って後退
 * - 不利な状況では自動逃走
 * - 武器・防具を自動装備
 */
class CombatEngage extends InstantSkill {
    constructor(bot: CustomBot) {
        super(bot);
        this.skillName = 'combat-engage';
        this.description = '汎用戦闘AI。敵モブと戦闘する。200ms周期で状況を評価し最善の行動を自律選択。複数体の敵、遠距離攻撃、クリーパー爆発にも対処可能。不利なら自動逃走する。';
        this.params = [
            {
                name: 'target',
                type: 'string',
                description: '優先的に攻撃する敵の種類 (例: "zombie", "skeleton")。省略時は最も近い敵',
                required: false,
            },
            {
                name: 'maxDuration',
                type: 'number',
                description: '最大戦闘時間（秒）。デフォルト: 60',
                default: 60,
            },
        ];
        this.maxDurationMs = 120_000;
    }

    async runImpl(target?: string, maxDuration: number = 60): Promise<{ success: boolean; result: string }> {
        const controller = new CombatController(this.bot, {
            maxDurationMs: maxDuration * 1000,
        });

        log.info(`⚔️ combat-engage 開始${target ? ` (target: ${target})` : ''}`);

        const result = await controller.engage(target);

        const summary = [
            `戦闘${result.success ? '成功' : '失敗'}: ${result.reason}`,
            `${result.kills}体撃破`,
            `被ダメージ: ${result.damageTaken.toFixed(1)}HP`,
            `所要時間: ${(result.durationMs / 1000).toFixed(1)}秒`,
            `行動回数: ${result.actionsExecuted}`,
        ].join(', ');

        return { success: result.success, result: summary };
    }
}

export default CombatEngage;
