import { CustomBot, InstantSkill } from '../types.js';

/**
 * ボットが見ている方向のブロック座標を取得するスキル
 * describe-bot-viewで特定したものの座標を知りたい時に使用
 */
class GetBlockInSight extends InstantSkill {
    constructor(bot: CustomBot) {
        super(bot);
        this.skillName = 'get-block-in-sight';
        this.description =
            'ボットが現在見ている方向にあるブロックの座標を取得します。look-atで向いた先にあるブロックの正確な座標を知りたい時に使用します。';
        this.params = [
            {
                name: 'maxDistance',
                type: 'number',
                description: '検索する最大距離（デフォルト: 64ブロック）',
                default: 64,
            },
        ];
    }

    async runImpl(maxDistance: number = 64) {
        try {
            // ボットが見ている方向のブロックを取得
            const block = this.bot.blockAtCursor(maxDistance);

            if (!block) {
                return {
                    success: true,
                    result: `${maxDistance}ブロック以内に見ているブロックはありません（空を見ている可能性があります）`,
                };
            }

            const bx = block.position.x;
            const by = block.position.y;
            const bz = block.position.z;

            return {
                success: true,
                result: `見ているブロック: ${block.name}\nブロック座標: {"x":${bx},"y":${by},"z":${bz}}\nブロック上面: {"x":${bx},"y":${by + 1},"z":${bz}}`,
            };
        } catch (error: any) {
            return {
                success: false,
                result: `エラー: ${error.message}`,
            };
        }
    }
}

export default GetBlockInSight;

