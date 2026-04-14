import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import {
  countItemInInventory,
  hasNearbyDroppedItemNamed,
  inventoryNoEmptySlots,
  INVENTORY_FULL_RECOVERY_HINT_JA,
} from '../utils/inventorySpillDetection.js';

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

            let furnace: Awaited<ReturnType<CustomBot['openFurnace']>>;
            try {
                furnace = await this.bot.openFurnace(block);
            } catch (actionError: any) {
                const los = await ensureLineOfSight(this.bot, pos);
                if (!los.clear) {
                    const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
                    return { success: false, result: los.message!, failureType: failType, recoverable: true };
                }
                throw actionError;
            }
            if (!furnace) {
                return {
                    success: false,
                    result: 'かまどを開けませんでした',
                };
            }

            try {
                const withdrawnItems: string[] = [];
                let sawInventoryFull = false;

                // 入力スロットから取り出し
                if (normalizedSlot === 'input' || normalizedSlot === 'all') {
                    const inputItem = furnace.inputItem();
                    if (inputItem) {
                        const r = await this.withdrawStackWithSpillCheck(
                            inputItem.name,
                            inputItem.count,
                            () => furnace.takeInput(),
                            '材料',
                        );
                        withdrawnItems.push(r.line);
                        if (r.inventoryFull) sawInventoryFull = true;
                    }
                }

                // 燃料スロットから取り出し
                if (normalizedSlot === 'fuel' || normalizedSlot === 'all') {
                    const fuelItem = furnace.fuelItem();
                    if (fuelItem) {
                        const r = await this.withdrawStackWithSpillCheck(
                            fuelItem.name,
                            fuelItem.count,
                            () => furnace.takeFuel(),
                            '燃料',
                        );
                        withdrawnItems.push(r.line);
                        if (r.inventoryFull) sawInventoryFull = true;
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
                        const r = await this.withdrawStackWithSpillCheck(
                            outputItem.name,
                            outputItem.count,
                            () => furnace.takeOutput(),
                            '完成品',
                        );
                        withdrawnItems.push(r.line);
                        if (r.inventoryFull) sawInventoryFull = true;
                    }
                }

                furnace.close();

                // output を取り出した場合はかまど追跡から削除
                if (normalizedSlot === 'output' || normalizedSlot === 'all') {
                    this.unregisterActiveFurnace(x, y, z);
                }

                if (withdrawnItems.length === 0) {
                    return {
                        success: true,
                        result: normalizedSlot === 'all'
                            ? 'かまどは空でした'
                            : `${slot}スロットは空でした`,
                    };
                }

                if (sawInventoryFull) {
                    return {
                        success: true,
                        failureType: 'inventory_full',
                        recoverable: true,
                        result:
                            `取り出し結果: ${withdrawnItems.join(', ')}。${INVENTORY_FULL_RECOVERY_HINT_JA}`,
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

    /**
     * かまどから1スタック相当を取り出したあと、インベントリ増分と地上ドロップで満杯溢れを検出する。
     */
    private async withdrawStackWithSpillCheck(
        itemName: string,
        expectedQty: number,
        takeFn: () => Promise<unknown>,
        roleJp: string,
    ): Promise<{ line: string; inventoryFull: boolean }> {
        const before = countItemInInventory(this.bot, itemName);
        await takeFn();
        await new Promise(r => setTimeout(r, 450));
        let gained = countItemInInventory(this.bot, itemName) - before;
        if (gained < expectedQty) {
            await new Promise(r => setTimeout(r, 350));
            gained = countItemInInventory(this.bot, itemName) - before;
        }
        const onGround = hasNearbyDroppedItemNamed(this.bot, this.mcData, itemName, 10);
        const noSlots = inventoryNoEmptySlots(this.bot);

        if (gained >= expectedQty) {
            return {
                line: `${itemName} x${expectedQty}（${roleJp}）`,
                inventoryFull: false,
            };
        }
        if (onGround && noSlots) {
            const g = Math.max(0, gained);
            return {
                line:
                    `${itemName}: 満杯のため${expectedQty}個のうち約${expectedQty - g}個が地上に落ちた可能性（インベントリに${g}個、${roleJp}）`,
                inventoryFull: true,
            };
        }
        if (gained > 0) {
            return {
                line: `${itemName} x${gained}（${roleJp}、期待${expectedQty}個。pickup-nearest-itemを試す）`,
                inventoryFull: false,
            };
        }
        return {
            line: `${itemName}（${roleJp}）を取り出したがインベントリが増えていない。pickup-nearest-itemを試す`,
            inventoryFull: false,
        };
    }
    private unregisterActiveFurnace(x: number, y: number, z: number): void {
        if (!this.bot.activeFurnaces) return;
        this.bot.activeFurnaces = this.bot.activeFurnaces.filter(
            f => !(f.pos.x === x && f.pos.y === y && f.pos.z === z),
        );
    }
}

export default WithdrawFromFurnace;

