import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';

/**
 * 原子的スキル: かまどからアイテムを取り出す
 */
class WithdrawFromFurnace extends InstantSkill {
    private mcData: any;

    constructor(bot: CustomBot) {
        super(bot);
        this.skillName = 'withdraw-from-furnace';
        this.description = 'かまどからアイテムを取り出します。スロットを指定するか、すべて取り出せます。';
        this.mcData = minecraftData(this.bot.version);
        this.params = [
            {
                name: 'x',
                type: 'number',
                description: 'かまどのX座標',
                required: true,
            },
            {
                name: 'y',
                type: 'number',
                description: 'かまどのY座標',
                required: true,
            },
            {
                name: 'z',
                type: 'number',
                description: 'かまどのZ座標',
                required: true,
            },
            {
                name: 'slot',
                type: 'string',
                description: '取り出すスロット: "input"（材料）, "fuel"（燃料）, "output"（完成品）, "all"（すべて）。デフォルト: "all"',
                default: 'all',
            },
        ];
    }

    async runImpl(
        x: number,
        y: number,
        z: number,
        slot: string = 'all'
    ) {
        try {
            const pos = new Vec3(x, y, z);
            const block = this.bot.blockAt(pos);

            if (!block) {
                return {
                    success: false,
                    result: `座標(${x}, ${y}, ${z})にブロックが見つかりません`,
                };
            }

            // かまどかチェック
            if (
                !block.name.includes('furnace') &&
                !block.name.includes('smoker') &&
                !block.name.includes('blast_furnace')
            ) {
                return {
                    success: false,
                    result: `${block.name}はかまどではありません`,
                };
            }

            // 距離チェック
            const distance = this.bot.entity.position.distanceTo(pos);
            if (distance > 4.5) {
                return {
                    success: false,
                    result: `かまどが遠すぎます（距離: ${distance.toFixed(1)}m）`,
                };
            }

            // スロット名の正規化
            const normalizedSlot = slot.toLowerCase();
            if (!['input', 'fuel', 'output', 'all'].includes(normalizedSlot)) {
                return {
                    success: false,
                    result: `無効なスロット名: ${slot}。input, fuel, output, all のいずれかを指定してください`,
                };
            }

            // かまどを開く
            const furnace = await this.bot.openFurnace(block);
            if (!furnace) {
                return {
                    success: false,
                    result: 'かまどを開けませんでした',
                };
            }

            try {
                const withdrawnItems: string[] = [];

                // 入力スロットから取り出し
                if (normalizedSlot === 'input' || normalizedSlot === 'all') {
                    const inputItem = furnace.inputItem();
                    if (inputItem) {
                        await furnace.takeInput();
                        withdrawnItems.push(`${inputItem.name} x${inputItem.count}（材料）`);
                    }
                }

                // 燃料スロットから取り出し
                if (normalizedSlot === 'fuel' || normalizedSlot === 'all') {
                    const fuelItem = furnace.fuelItem();
                    if (fuelItem) {
                        await furnace.takeFuel();
                        withdrawnItems.push(`${fuelItem.name} x${fuelItem.count}（燃料）`);
                    }
                }

                // 出力スロットから取り出し
                if (normalizedSlot === 'output' || normalizedSlot === 'all') {
                    let outputItem = furnace.outputItem();
                    // 精錬中で output が空 → 完了まで待つ (最大120秒)
                    if (!outputItem && furnace.inputItem()) {
                        const inputCount = furnace.inputItem()!.count;
                        const maxWaitMs = Math.min(inputCount * 11000, 120000);
                        const startWait = Date.now();
                        while (Date.now() - startWait < maxWaitMs) {
                            if (this.shouldInterrupt()) break;
                            await new Promise(r => setTimeout(r, 2000));
                            outputItem = furnace.outputItem();
                            if (outputItem && outputItem.count >= inputCount) break;
                        }
                        // 最終確認
                        outputItem = furnace.outputItem();
                    }
                    if (outputItem) {
                        await furnace.takeOutput();
                        withdrawnItems.push(`${outputItem.name} x${outputItem.count}（完成品）`);
                    }
                }

                furnace.close();

                if (withdrawnItems.length === 0) {
                    return {
                        success: true,
                        result: normalizedSlot === 'all'
                            ? 'かまどは空でした'
                            : `${slot}スロットは空でした`,
                    };
                }

                return {
                    success: true,
                    result: `取り出しました: ${withdrawnItems.join(', ')}`,
                };
            } catch (error: any) {
                furnace.close();
                throw error;
            }
        } catch (error: any) {
            return {
                success: false,
                result: `取り出しエラー: ${error.message}`,
            };
        }
    }
}

export default WithdrawFromFurnace;

