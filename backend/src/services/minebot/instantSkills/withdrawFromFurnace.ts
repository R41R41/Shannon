import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { assertActionActive, bindActionCallback, reportActionProgress } from '../execution/ActionExecution.js';
import { waitForObservation, type ObservationSource } from '../execution/observedWait.js';
import {
  hasNearbyDroppedItemNamed,
  inventoryNoEmptySlots,
  INVENTORY_FULL_RECOVERY_HINT_JA,
} from '../utils/inventorySpillDetection.js';

/**
 * 原子的スキル: かまどからアイテムを取り出す
 */
/** A furnace smelts one item in ten seconds; what is left is waited out only when it is about this short. */
const SMELT_MS_PER_ITEM = 10_000;
const SHORT_WAIT_MS = 20_000;

class WithdrawFromFurnace extends InstantSkill {
    private mcData: any;

    constructor(bot: CustomBot) {
        super(bot);
        this.skillName = 'withdraw-from-furnace';
        this.description = 'かまどからアイテムを取り出します。既定のallは全スロットを回収し、未完了の材料・燃料は残します。精錬の残りが短い（約20秒以内）時だけ完了を待ち、長い時は待たずに完成済みの分だけ回収して残り時間を返します（その間に別の作業ができる）。途中で材料や燃料だけを回収するには対応スロットを明示してください。';
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
            { name: 'waitForCompletion', type: 'boolean', description: '省略時は、残りが約20秒以内なら完成まで待ち、それより長ければ待たずに完成済みの出力だけ回収して残り時間を返す。true=残りが長くても完成するまで待つ（最大120秒、その間は身体が止まる）。false=決して待たない。allは精錬中の材料・燃料を取り出さない' },
        ];
    }

    async runImpl(
        x: number,
        y: number,
        z: number,
        slot: string = 'all',
        waitForCompletion?: boolean,
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
                let stoppedForFuel = false;
                // Mineflayer initializes these fields from separate window
                // packets. Do not mistake an incomplete snapshot for no fuel.
                const fuelExhausted = () => furnace.fuel === 0
                    && typeof (furnace as typeof furnace & { totalFuel?: number | null }).totalFuel === 'number'
                    && !furnace.fuelItem();

                // Output must be handled before the other slots. In particular,
                // the default slot="all" must not remove input or fuel while
                // waitForCompletion is waiting for an active smelting job.
                if (normalizedSlot === 'output' || normalizedSlot === 'all') {
                    let outputItem = furnace.outputItem();
                    // Blocking mode waits for all remaining input even if a
                    // partial output is already present. Nonblocking mode may
                    // withdraw that partial output but keeps the active job.
                    // Unless told, it waits only when what is left is short: waited out every time, a body stood at
                    // its furnace 80 to 120 seconds a batch, six to twelve minutes of a run (paid runs L97, L98, L100),
                    // while the run that reached the Nether fastest waited 6 (L94).
                    const waits = (left: number) => waitForCompletion === true || (waitForCompletion === undefined && left * SMELT_MS_PER_ITEM <= SHORT_WAIT_MS);
                    if (furnace.inputItem() && (waits(furnace.inputItem()!.count) || !outputItem)) {
                        const inputCount = furnace.inputItem()!.count;
                        const expectedOutputCount = inputCount + (outputItem?.count ?? 0);
                        if (!waits(inputCount)) {
                            const outOfFuel = fuelExhausted();
                            furnace.close();
                            return { success: false, failureType: outOfFuel ? 'material_missing' : 'waiting_external', recoverable: true,
                                result: outOfFuel
                                    ? `精錬が燃料切れで停止しています（材料${inputCount}個）。燃料を追加してください`
                                    : `精錬はまだ完了していません（材料${inputCount}個、残り約${Math.ceil(inputCount * SMELT_MS_PER_ITEM / 1000)}秒）。待たずに別の準備（採掘など）を進め、その後で同じかまどから取り出してください` };
                        }
                        const maxWaitMs = Math.min(inputCount * 11000, 120000);
                        let previousOutput = outputItem?.count ?? 0;
                        let previousInput = inputCount;
                        const stack = (item: { name: string; count: number } | null) => item
                            ? { name: item.name, count: item.count } : null;
                        const evidence = () => ({ kind: 'smelting', position: [x, y, z],
                            input: stack(furnace.inputItem()), output: stack(furnace.outputItem()),
                            fuel: stack(furnace.fuelItem()), expectedOutputCount, maximumWaitMs: maxWaitMs });
                        reportActionProgress(this.bot, 'wait_external', evidence(), false, 'waiting_external');
                        const furnaceUpdates = furnace as unknown as ObservationSource;
                        const onUpdate = bindActionCallback(this.bot, () => {
                            if (this.shouldInterrupt()) return;
                            const outputCount = furnace.outputItem()?.count ?? 0;
                            const remaining = furnace.inputItem()?.count ?? 0;
                            if (outputCount === previousOutput && remaining === previousInput) return;
                            previousOutput = outputCount; previousInput = remaining;
                            // Real item changes, not a timer, establish progress.
                            reportActionProgress(this.bot, 'wait_external', evidence(), true, 'waiting_external');
                        });
                        furnaceUpdates.on('update', onUpdate);
                        try {
                            await waitForObservation(this.bot, () => (furnace.outputItem()?.count ?? 0) >= expectedOutputCount
                                || fuelExhausted(),
                                maxWaitMs, [{ source: furnaceUpdates, event: 'update' }]);
                        } finally { furnaceUpdates.removeListener('update', onUpdate); }
                        assertActionActive(this.bot);
                        stoppedForFuel = fuelExhausted() && !!furnace.inputItem();
                        // 最終確認
                        outputItem = furnace.outputItem();
                    }
                    if (outputItem) {
                        reportActionProgress(this.bot, 'confirm', { output: outputItem.name, count: outputItem.count }, true);
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

                // An explicit input/fuel request may cancel an unfinished job.
                // "all" instead means everything after the job is complete;
                // otherwise preserve the work and let the caller refuel or wait.
                const mayDrainOtherSlots = normalizedSlot !== 'all' || !furnace.inputItem();
                if (mayDrainOtherSlots && (normalizedSlot === 'input' || normalizedSlot === 'all')) {
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
                if (mayDrainOtherSlots && (normalizedSlot === 'fuel' || normalizedSlot === 'all')) {
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

                const remainingInput = furnace.inputItem();
                stoppedForFuel = !!remainingInput && (stoppedForFuel || fuelExhausted());
                furnace.close();

                // 燃料切れなら残った材料は待機中の仕事ではない。
                if ((normalizedSlot === 'output' || normalizedSlot === 'all') && (!remainingInput || stoppedForFuel)) {
                    this.unregisterActiveFurnace(x, y, z);
                }

                // An output-only request succeeds when it actually retrieved
                // finished items from a fuel-exhausted furnace. The unfinished
                // input remains in place for refueling. "all" cannot claim
                // completion while that input is still present.
                if (remainingInput && (normalizedSlot === 'all'
                    || (normalizedSlot === 'output' && waitForCompletion === true && !stoppedForFuel))) {
                    return {
                        success: false,
                        failureType: stoppedForFuel ? 'material_missing' : 'waiting_external',
                        recoverable: true,
                        result: `${withdrawnItems.length ? `完成済みの${withdrawnItems.join(', ')}を回収しました。` : ''}`
                            + `材料${remainingInput.count}個の精錬は未完了です。材料と燃料はかまど内に残しました。`
                            + (stoppedForFuel ? '燃料を追加してください' : '後で同じかまどから取り出してください'),
                    };
                }

                if (withdrawnItems.length === 0) {
                    if (remainingInput && normalizedSlot === 'output') {
                        return { success: false, failureType: stoppedForFuel ? 'material_missing' : 'waiting_external', recoverable: true,
                            result: stoppedForFuel
                                ? `精錬が燃料切れで停止しています（材料${remainingInput.count}個）。燃料を追加してください`
                                : `完成品はまだありません（材料${remainingInput.count}個が残っています）。燃料と進行状況を確認し、後で再度取り出してください` };
                    }
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
                    result: `取り出しました: ${withdrawnItems.join(', ')}${remainingInput && normalizedSlot === 'output'
                        ? stoppedForFuel
                            ? `。材料${remainingInput.count}個が燃料切れで残っています。燃料を追加してください`
                            : `。材料${remainingInput.count}個の精錬は未完了です。かまどの追跡を継続しています` : ''}`,
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
        // Open-container player slots are authoritative while the UI is open;
        // bot.inventory can remain stale until the window closes.
        const visibleWindow = () => this.bot.currentWindow ?? this.bot.inventory;
        const count = () => visibleWindow().items().filter(item => item.name === itemName)
            .reduce((sum, item) => sum + item.count, 0);
        const before = count();
        const window = visibleWindow();
        await takeFn();
        await waitForObservation(this.bot, () => count() - before >= expectedQty,
            800, [{ source: window as unknown as ObservationSource, event: 'updateSlot' },
                { source: this.bot.inventory as unknown as ObservationSource, event: 'updateSlot' }]);
        const gained = count() - before;
        const onGround = hasNearbyDroppedItemNamed(this.bot, this.mcData, itemName, 10);
        const noSlots = window.emptySlotCount() === 0 || inventoryNoEmptySlots(this.bot);

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
