import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { approachFurnace } from '../utils/furnaceReach.js';
import { assertActionActive, bindActionCallback, reportActionProgress } from '../execution/ActionExecution.js';
import { waitForObservation, type ObservationSource } from '../execution/observedWait.js';
import { backgroundJobs } from '../execution/backgroundJobs.js';
import { guardAskedToWait, healingNow, meanwhileWork } from './waitTime.js';
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
/** How long the burn bar has to read empty (with no fuel in the slot) before the furnace is taken to be out of fuel. */
const FUEL_EMPTY_CONFIRM_MS = 2_500;

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
            { name: 'waitForCompletion', type: 'boolean', description: '省略時は、残りが約20秒以内なら完成まで待ち、それより長ければ待たずに完成済みの出力だけ回収して残り時間を返す。true=残りが長くても完成するまで待つ（最大120秒、その間は身体が止まる。ただし残りが20秒を超え、近くにできる仕事がある時は wait-time と同じく断る）。false=決して待たない。allは精錬中の材料・燃料を取り出さない' },
        ];
    }

    /**
     * A wait for the batch longer than SHORT_WAIT_MS, asked for with waitForCompletion=true, is refused as wait-time refuses one when
     * there is something definite to do meanwhile (wait_refused, with what). Run 18 (D15) stood at its furnace 53 s for six iron, with
     * iron ore 16 m off named in the same refusal of wait-time that had pointed it here. Not refused: a hurt body regenerating, a wait
     * the exposure guard asked for, nothing definite to do.
     */
    protected preflight(x: number, y: number, z: number, slot: string = 'all', waitForCompletion?: boolean) {
        // Only the output (and `all`) waits for the batch: taking the input or the fuel out never stands at the furnace.
        if (waitForCompletion !== true || ![x, y, z].every(Number.isFinite) || !['output', 'all'].includes(String(slot).toLowerCase())) return null;
        let job: ReturnType<typeof backgroundJobs>[number] | undefined;
        try { job = backgroundJobs(this.bot).find(entry => entry.position.x === x && entry.position.y === y && entry.position.z === z && entry.status === 'waiting_external'); }
        catch { return null; }
        if (!job || job.remainingEstimateMs <= SHORT_WAIT_MS) return null;
        if (healingNow(this.bot) || guardAskedToWait(this.bot)) return null;
        const { work, concrete } = meanwhileWork(this.bot);
        if (!concrete || !work.length) return null;
        return { success: false, failureType: 'wait_refused', recoverable: true,
            result: `待ちを断りました: かまど(${x},${y},${z})の${job.input}×${job.count} は残り約${Math.ceil(job.remainingEstimateMs / 1000)}秒。`
                + `その間にできること: ${work.join('、')}。終わった頃に withdraw-from-furnace で取り出す（waitForCompletion は付けない）。` };
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

            // Out of reach: walk to where it can be opened first (a stand from which the block is in reach, whatever the height:
            // run 17 was told "too far" three times, once standing 14 blocks under the furnace after a move "already there" in XZ).
            const approach = await approachFurnace(this.bot, pos, (...args) => this.callSkill('move-to', ...args));
            if (approach) return approach;

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
                const fuelReadsEmpty = () => furnace.fuel === 0
                    && typeof (furnace as typeof furnace & { totalFuel?: number | null }).totalFuel === 'number'
                    && !furnace.fuelItem();
                // Read as empty for a while, not for a moment: just after start-smelting the one coal has gone from the slot into the
                // fire and the burn bar has not been sent yet. Run 17 was told "add fuel" at once, 29 s from done, with fuel burning.
                let emptySince: number | null = null;
                const fuelExhausted = () => {
                    if (!fuelReadsEmpty()) { emptySince = null; return false; }
                    emptySince ??= Date.now();
                    return Date.now() - emptySince >= FUEL_EMPTY_CONFIRM_MS;
                };
                /** Out of fuel, said only when it still reads empty after the burn bar has had time to come in. */
                const confirmedOutOfFuel = async () => fuelReadsEmpty() && !(await waitForObservation(this.bot, () => !fuelReadsEmpty(),
                    FUEL_EMPTY_CONFIRM_MS, [{ source: furnace as unknown as ObservationSource, event: 'update' }]));

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
                            const outOfFuel = await confirmedOutOfFuel();
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
                stoppedForFuel = !!remainingInput && (stoppedForFuel || fuelExhausted() || await confirmedOutOfFuel());
                furnace.close();

                // 燃料切れなら残った材料は待機中の仕事ではない。
                let queuedNote = '';
                if ((normalizedSlot === 'output' || normalizedSlot === 'all') && (!remainingInput || stoppedForFuel)) {
                    const queued = this.bot.activeFurnaces?.find(f => f.pos.x === x && f.pos.y === y && f.pos.z === z)?.then ?? [];
                    this.unregisterActiveFurnace(x, y, z);
                    // The raw food start-smelting queued behind the batch goes in now, the furnace being empty: cooked while the
                    // body goes on with its work, eaten cooked later (see start-smelting).
                    if (!remainingInput) queuedNote = await this.startQueued(x, y, z, queued);
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
                            `取り出し結果: ${withdrawnItems.join(', ')}。${INVENTORY_FULL_RECOVERY_HINT_JA}${queuedNote}`,
                    };
                }

                return {
                    success: true,
                    result: `取り出しました: ${withdrawnItems.join(', ')}${remainingInput && normalizedSlot === 'output'
                        ? stoppedForFuel
                            ? `。材料${remainingInput.count}個が燃料切れで残っています。燃料を追加してください`
                            : `。材料${remainingInput.count}個の精錬は未完了です。かまどの追跡を継続しています` : ''}${queuedNote}`,
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
    /**
     * The first queued raw food still carried goes into the empty furnace (start-smelting, with whatever fuel it finds), the rest
     * queued behind it again. Said in one sentence for the result; nothing when nothing was queued or carried.
     */
    private async startQueued(x: number, y: number, z: number, queued: string[]): Promise<string> {
        const carried = (name: string) => this.bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
        const next = queued.find(name => carried(name) > 0);
        if (!next) return '';
        // Only on coal or charcoal: planks and logs left in the pack are for crafting, not something to burn unasked.
        const fuel = ['coal', 'charcoal'].find(name => carried(name) > 0);
        if (!fuel) return `。並べていた${next}は、石炭・木炭が無いため焼き始めていません（燃料を指定して start-smelting で焼けます）`;
        try {
            const started = await this.callSkill('start-smelting', x, y, z, next, fuel, carried(next));
            if (!started.success) return `。並べていた${next}は焼き始められませんでした（${String(started.result).slice(0, 80)}）`;
            // start-smelting queued what else is raw behind this one itself: nothing more to carry over.
            const job = this.bot.activeFurnaces?.find(f => f.pos.x === x && f.pos.y === y && f.pos.z === z);
            const seconds = job ? Math.max(0, Math.round((job.readyAt - Date.now()) / 1000)) : null;
            return `。続けて、並べていた${next}×${job?.count ?? carried(next)}を同じかまどで焼き始めました${seconds !== null ? `（約${seconds}秒。待たずに次の作業へ）` : ''}`;
        } catch (error: any) {
            // A cancelled action is the caller's to see, not a sentence in the result.
            if (this.shouldInterrupt()) throw error;
            return `。並べていた${next}は焼き始められませんでした（${String(error?.message ?? error).slice(0, 80)}）`;
        }
    }

    private unregisterActiveFurnace(x: number, y: number, z: number): void {
        if (!this.bot.activeFurnaces) return;
        this.bot.activeFurnaces = this.bot.activeFurnaces.filter(
            f => !(f.pos.x === x && f.pos.y === y && f.pos.z === z),
        );
    }
}

export default WithdrawFromFurnace;
