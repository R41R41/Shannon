import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';

/**
 * 原子的スキル: コンテナの中身を確認
 */
class CheckContainer extends InstantSkill {
    constructor(bot: CustomBot) {
        super(bot);
        this.skillName = 'check-container';
        this.description = 'チェストなどのコンテナの中身を確認します。';
        this.params = [
            {
                name: 'x',
                type: 'number',
                description: 'コンテナのX座標',
                required: true,
            },
            {
                name: 'y',
                type: 'number',
                description: 'コンテナのY座標',
                required: true,
            },
            {
                name: 'z',
                type: 'number',
                description: 'コンテナのZ座標',
                required: true,
            },
            {
                name: 'showEmpty',
                type: 'boolean',
                description: '空の場合も詳細を表示するか（デフォルト: false）',
                default: false,
            },
        ];
    }

    async runImpl(x: number, y: number, z: number, showEmpty: boolean = false) {
        try {
            const pos = new Vec3(x, y, z);
            const block = this.bot.blockAt(pos);

            if (!block) {
                return {
                    success: false,
                    result: `座標(${x}, ${y}, ${z})にブロックが見つかりません`,
                };
            }

            // コンテナかチェック
            const containerTypes = [
                'chest',
                'trapped_chest',
                'ender_chest',
                'shulker_box',
                'barrel',
                'dispenser',
                'dropper',
                'hopper',
            ];

            const isContainer = containerTypes.some((type) =>
                block.name.includes(type)
            );

            if (!isContainer) {
                // かまど系は別スキルを使う
                if (block.name.includes('furnace') || block.name.includes('smoker') || block.name.includes('blast_furnace')) {
                    return {
                        success: false,
                        result: `${block.name}はかまどです。check-furnaceを使用してください`,
                    };
                }
                return {
                    success: false,
                    result: `${block.name}はコンテナではありません`,
                };
            }

            // 距離チェック
            const distance = this.bot.entity.position.distanceTo(pos);
            if (distance > 4.5) {
                return {
                    success: false,
                    result: `コンテナが遠すぎます（距離: ${distance.toFixed(1)}m）`,
                };
            }

            let container;
            try {
                container = await this.bot.openContainer(block);
            } catch (actionError: any) {
                const los = await ensureLineOfSight(this.bot, pos);
                if (!los.clear) {
                    const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
                    return { success: false, result: los.message!, failureType: failType, recoverable: true };
                }
                throw actionError;
            }

            if (!container) {
                return {
                    success: false,
                    result: `${block.name}を開けませんでした`,
                };
            }

            try {
                // コンテナのスロットを取得（インベントリ部分を除く）
                const containerSlots = container.containerItems();

                if (containerSlots.length === 0) {
                    container.close();
                    return {
                        success: true,
                        result: `${block.name}は空です`,
                    };
                }

                // アイテムを集計
                const itemCounts: { [key: string]: number } = {};
                for (const item of containerSlots) {
                    if (item) {
                        const name = item.name;
                        itemCounts[name] = (itemCounts[name] || 0) + item.count;
                    }
                }

                // 結果を整形
                const itemList = Object.entries(itemCounts)
                    .sort((a, b) => b[1] - a[1]) // 個数でソート
                    .map(([name, count]) => `${name} x${count}`)
                    .join(', ');

                const totalItems = Object.values(itemCounts).reduce((a, b) => a + b, 0);
                const totalSlots = container.slots.length - 36; // プレイヤーインベントリを除く
                const usedSlots = containerSlots.length;

                container.close();

                return {
                    success: true,
                    result: `${block.name}(${x}, ${y}, ${z})の中身（${usedSlots}/${totalSlots}スロット使用、計${totalItems}個）: ${itemList}`,
                };
            } catch (error: any) {
                container.close();
                throw error;
            }
        } catch (error: any) {
            return {
                success: false,
                result: `確認エラー: ${error.message}`,
            };
        }
    }
}

export default CheckContainer;

