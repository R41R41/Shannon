import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { digBlockVerified } from '../utils/digBlockVerified.js';
import { LavaReleaseError } from '../utils/lavaSafety.js';
import { ThreatExposedError } from '../utils/exposureGuard.js';
import { actionDelay } from '../execution/observedWait.js';
import { chooseTool } from '../utils/toolChoice.js';
import { blocksAlong, keepCheapTool } from '../utils/toolStock.js';
const log = createLogger('Minebot:Skill:stairMine');

/**
 * 階段掘り/埋めスキル
 * 目標の高さまで階段状に移動する（掘る or ブロックを置く）
 */
class StairMine extends InstantSkill {
    /** Concrete cause of the last stopped step, reported to the planner. */
    private lastStopReason: string | null = null;
    private mcData: any;

    constructor(bot: CustomBot) {
        super(bot);
        this.skillName = 'stair-mine';
        this.description = '階段を掘りながら（または置きながら）目標の高さまで移動します。';
        this.mcData = minecraftData(this.bot.version);
        this.params = [
            {
                name: 'targetY',
                type: 'number',
                description: '目標のY座標（高さ）',
                required: true,
            },
            {
                name: 'direction',
                type: 'string',
                description: '進む方向: "north", "south", "east", "west"。省略時は現在向いている方向',
                default: '',
            },
            {
                name: 'placeBlock',
                type: 'string',
                description: '上昇時に置くブロック名（省略時はcobblestone）',
                default: 'cobblestone',
            },
        ];
    }

    async runImpl(targetY: number, direction: string = '', placeBlock: string = 'cobblestone') {
        this.lastStopReason = null;
        try {
            const currentY = Math.floor(this.bot.entity.position.y);
            const diff = targetY - currentY;

            if (Math.abs(diff) < 1) {
                return {
                    success: true,
                    result: `すでに目標の高さ（Y=${targetY}）にいます`,
                };
            }

            // 方向を決定
            let dir: Vec3;
            if (direction) {
                const directions: { [key: string]: Vec3 } = {
                    'north': new Vec3(0, 0, -1),
                    'south': new Vec3(0, 0, 1),
                    'east': new Vec3(1, 0, 0),
                    'west': new Vec3(-1, 0, 0),
                };
                dir = directions[direction.toLowerCase()];
                if (!dir) {
                    return {
                        success: false,
                        result: `無効な方向: ${direction}。north, south, east, west のいずれかを指定してください`,
                    };
                }
            } else {
                // 現在向いている方向を使用
                const yaw = this.bot.entity.yaw;
                // yawを4方向に変換
                const normalized = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
                if (normalized >= 0.25 * Math.PI && normalized < 0.75 * Math.PI) {
                    dir = new Vec3(-1, 0, 0); // west
                } else if (normalized >= 0.75 * Math.PI && normalized < 1.25 * Math.PI) {
                    dir = new Vec3(0, 0, 1); // south (逆かも)
                } else if (normalized >= 1.25 * Math.PI && normalized < 1.75 * Math.PI) {
                    dir = new Vec3(1, 0, 0); // east
                } else {
                    dir = new Vec3(0, 0, -1); // north
                }
            }

            const isDescending = diff < 0;
            const steps = Math.abs(diff);
            let successSteps = 0;

            // タイムアウト設定（60秒）
            // Deepslate steps take several seconds each; a fixed 60s stopped a
            // 125-step descent to the diamond band after a fraction of it.
            const TIMEOUT_MS = Math.min(600_000, Math.max(60_000, steps * 4_000));
            const startTime = Date.now();

            // Every step is dug: a dear pickaxe is not spent on it when a cheaper one can be made (utils/toolStock).
            const here = this.bot.entity.position;
            await keepCheapTool(this.bot as any, blocksAlong(this.bot as any, here,
                { x: here.x + dir.x * steps, y: here.y + diff, z: here.z + dir.z * steps }),
                (skill, ...args) => this.callSkill(skill, ...args));

            log.info(`⛏️ 階段${isDescending ? '下降' : '上昇'}開始: Y=${currentY} → Y=${targetY} (${steps}段, 最大${Math.round(TIMEOUT_MS / 1000)}秒)`, 'cyan');

            for (let i = 0; i < steps; i++) {
                // 中断チェック
                if (this.shouldInterrupt()) {
                    return {
                        success: false,
                        failureType: 'interrupted',
                        recoverable: true,
                        result: `中断: ${successSteps}段${isDescending ? '下降' : '上昇'}しました（Y=${Math.floor(this.bot.entity.position.y)}）`,
                    };
                }

                // タイムアウトチェック
                if (Date.now() - startTime > TIMEOUT_MS) {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    return {
                        success: false,
                        failureType: 'timeout',
                        recoverable: true,
                        result: `タイムアウト（${elapsed}秒）: ${successSteps}段${isDescending ? '下降' : '上昇'}しました（Y=${Math.floor(this.bot.entity.position.y)}）`,
                    };
                }

                // ツルハシチェック（石系ブロックを掘るために必要）
                const toolCheck = this.checkPickaxeAvailable();
                if (toolCheck) {
                    return {
                        success: false,
                        failureType: toolCheck.failureType,
                        recoverable: true,
                        result: `${successSteps}段${isDescending ? '下降' : '上昇'}しました（Y=${Math.floor(this.bot.entity.position.y)}）。${toolCheck.message}`,
                    };
                }

                const currentPos = this.bot.entity.position.floored();

                if (isDescending) {
                    // 下降: 前方に1ブロック進んで1ブロック下を掘る
                    const success = await this.digStairDown(currentPos, dir, placeBlock);
                    if (!success) {
                        return {
                            success: false,
                            failureType: 'stair_progress_blocked',
                            recoverable: true,
                            result: `${successSteps}段下降しました（Y=${Math.floor(this.bot.entity.position.y)}）。`
                                + (this.lastStopReason ?? '次の段で高さと位置を確認できず中断しました'),
                        };
                    }
                } else {
                    // 上昇: ブロックを置いて登る
                    const success = await this.buildStairUp(currentPos, dir, placeBlock);
                    if (!success) {
                        return {
                            success: false,
                            failureType: 'stair_progress_blocked',
                            recoverable: true,
                            result: `${successSteps}段上昇しました（Y=${Math.floor(this.bot.entity.position.y)}）。`
                                + (this.lastStopReason ?? '次の段で高さと位置を確認できず中断しました'),
                        };
                    }
                }

                successSteps++;

                // 進捗表示
                if (successSteps % 5 === 0) {
                    log.debug(`⛏️ ${successSteps}/${steps}段完了`);
                }

                // 少し待機
                await this.sleep(100);
            }

            const finalY = Math.floor(this.bot.entity.position.y);
            return {
                success: finalY === targetY,
                failureType: finalY === targetY ? undefined : 'stair_progress_blocked',
                recoverable: finalY === targetY ? undefined : true,
                result: finalY === targetY
                    ? `${successSteps}段${isDescending ? '下降' : '上昇'}してY=${finalY}に到達しました`
                    : `${successSteps}段移動しましたが目標Y=${targetY}には到達していません（現在Y=${finalY}）`,
            };
        } catch (error: any) {
            return {
                success: false,
                result: `階段掘りエラー: ${error.message}`,
            };
        }
    }

    /**
     * 下降用: 階段を掘って降りる
     */
    private async digStairDown(currentPos: Vec3, dir: Vec3, blockName = 'cobblestone'): Promise<boolean> {
        try {
            // 次の位置（前方1ブロック、下1ブロック）
            const nextPos = currentPos.offset(dir.x, -1, dir.z);

            // 通過経路上のブロックをすべて掘削 — 1つでも掘れなければ中断
            const clearTargets: [Vec3, string][] = [
                [currentPos.offset(dir.x, 1, dir.z), '頭の高さ'],
                [currentPos.offset(dir.x, 0, dir.z), '足の高さ'],
                [nextPos, '足元'],
            ];
            for (const [pos, label] of clearTargets) {
                const block = this.bot.blockAt(pos);
                if (block && block.boundingBox !== 'empty') {
                    if (!block.diggable) {
                        log.warn(`⚠ ${label}の${block.name}は掘れません`);
                        this.lastStopReason = `${label}の${block.name}(${pos.x}, ${pos.y}, ${pos.z})は掘れません。別の方向で再実行してください`;
                        return false;
                    }
                    // Breaking into an aquifer floods the stair: mining underwater is ~25x
                    // slower and paid runs lost the bot in flooded caves. Stop dry instead.
                    const water = this.adjacentWater(pos);
                    if (water) {
                        this.lastStopReason = `${label}の${block.name}(${pos.x}, ${pos.y}, ${pos.z})の隣(${water.x}, ${water.y}, ${water.z})が水です。`
                            + '掘ると浸水するため停止しました。別の方向で再実行するか、水の無い場所から降りてください';
                        return false;
                    }
                    const dug = await this.digBlockSafe(block);
                    if (!dug) {
                        this.lastStopReason ??= `${label}の${block.name}(${pos.x}, ${pos.y}, ${pos.z})を掘れませんでした（液体・危険の可能性）。別の方向で再実行してください`;
                        return false;
                    }
                }
            }

            // 次の段に足場がない場合は、穴へ踏み込まずに停止する。
            let support = this.bot.blockAt(nextPos.offset(0, -1, 0));
            // A cave edge: bridge the step with a carried block, as a player
            // does, instead of stopping at the first open floor.
            if (support && support.boundingBox === 'empty' && !['lava', 'water'].includes(support.name)) {
                const scaffold = [blockName, 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'andesite',
                    'diorite', 'granite', 'tuff', 'netherrack'].find(name => this.bot.inventory.items().some(i => i.name === name));
                if (scaffold && await this.placeBlockSafe(scaffold, support.position)) {
                    const deadline = Date.now() + 1000;
                    while (Date.now() < deadline && this.bot.blockAt(support.position)?.boundingBox !== 'block') await this.sleep(100);
                    support = this.bot.blockAt(support.position);
                }
            }
            if (!support || support.boundingBox === 'empty') {
                const below = support?.position ?? nextPos.offset(0, -1, 0);
                this.lastStopReason = `前方の足場(${below.x}, ${below.y}, ${below.z})が${support?.name ?? '未ロード'}で空いています`
                    + '（木の上・崖・洞窟の縁など）。地面へ降りるか別の方向で再実行してください';
                return false;
            }

            const moved = await this.moveOneStair(currentPos, dir, false);
            if (!moved) this.lastStopReason ??= `次の段(${nextPos.x}, ${nextPos.y}, ${nextPos.z})への移動を確認できませんでした（段差・水・障害物）。別の方向で再実行してください`;
            return moved;
        } catch (error: any) {
            log.error(`下降エラー: ${error.message}`, error);
            return false;
        }
    }

    /**
     * 上昇用: 階段を置いて登る
     */
    private async buildStairUp(currentPos: Vec3, dir: Vec3, blockName: string): Promise<boolean> {
        try {
            // 通過経路上のブロックをすべて掘削 — 1つでも掘れなければ中断
            const clearTargets: [number, number, number][] = [
                [0, 2, 0],          // 頭上+1
                [dir.x, 2, dir.z],  // 前方の頭上+1
                [dir.x, 1, dir.z],  // 前方の頭の高さ
            ];
            for (const [ox, oy, oz] of clearTargets) {
                const block = this.bot.blockAt(currentPos.offset(ox, oy, oz));
                if (block && block.boundingBox !== 'empty') {
                    if (!block.diggable) {
                        log.warn(`⚠ ${block.name}は掘削不可のため上昇中断`);
                        return false;
                    }
                    const dug = await this.digBlockSafe(block);
                    if (!dug) return false;
                }
            }

            // 前方の足元のブロックを確認
            const nextFoot = this.bot.blockAt(currentPos.offset(dir.x, 0, dir.z));

            if (!nextFoot || nextFoot.boundingBox === 'empty') {
                // 自然の段差がある場合は設置材を消費しない。
                const item = this.bot.inventory.items().find(i => i.name === blockName);
                if (!item) {
                    const alternatives = ['cobblestone', 'stone', 'dirt', 'netherrack', 'cobbled_deepslate'];
                    const alternative = alternatives.find(name => this.bot.inventory.items().some(i => i.name === name));
                    if (!alternative) {
                        log.warn('⚠ 置けるブロックがありません');
                        return false;
                    }
                    blockName = alternative;
                }
                // 空気なら階段ブロックを置く
                const placePos = currentPos.offset(dir.x, 0, dir.z);
                const placed = await this.placeBlockSafe(blockName, placePos);
                if (!placed) {
                    log.warn('⚠ ブロックを置けませんでした');
                    return false;
                }
            }

            return await this.moveOneStair(currentPos, dir, true);
        } catch (error: any) {
            log.error(`上昇エラー: ${error.message}`, error);
            return false;
        }
    }

    /** One staircase step is complete only after the bot reaches the adjacent column at the expected height. */
    private async moveOneStair(start: Vec3, dir: Vec3, ascending: boolean): Promise<boolean> {
        const target = start.offset(dir.x, ascending ? 1 : -1, dir.z);
        // Mineflayer yaw: north=0, west=π/2, south=π, east=-π/2.
        await this.bot.look(Math.atan2(-dir.x, -dir.z), 0, true);
        this.bot.setControlState('forward', true);
        if (ascending) this.bot.setControlState('jump', true);
        let released = false;
        try {
            // 36 physics observations bound one step to 1.8 s; the outer task has a 60 s limit.
            for (let tick = 0; tick < 36; tick++) {
                if (this.shouldInterrupt()) return false;
                await this.sleep(50);
                const pos = this.bot.entity.position;
                const progress = (pos.x - (start.x + 0.5)) * dir.x +
                    (pos.z - (start.z + 0.5)) * dir.z;
                if (!released && progress >= 0.85) {
                    this.bot.setControlState('forward', false);
                    if (ascending) this.bot.setControlState('jump', false);
                    released = true;
                }
                const inColumn = Math.floor(pos.x) === target.x && Math.floor(pos.z) === target.z;
                // In an aquifer the bot floats at the right column and height without touching ground.
                const inWater = !!(this.bot.entity as any).isInWater;
                const onGround = (this.bot.entity as any).onGround;
                if (inColumn && Math.floor(pos.y) === target.y && (onGround !== false || inWater)) {
                    // Allow physics one more tick before reporting a stable landing.
                    await this.sleep(50);
                    const landed = this.bot.entity.position;
                    const support = this.bot.blockAt(target.offset(0, -1, 0));
                    if (Math.floor(landed.x) === target.x && Math.floor(landed.z) === target.z &&
                        Math.floor(landed.y) === target.y && ((this.bot.entity as any).onGround !== false || inWater) &&
                        support && support.boundingBox !== 'empty') {
                        return true;
                    }
                }
            }
            log.warn(`⚠ 階段移動が進みません: 目標(${target.x},${target.y},${target.z}), 現在${this.bot.entity.position}`);
            return false;
        } finally {
            this.bot.setControlState('forward', false);
            if (ascending) this.bot.setControlState('jump', false);
        }
    }

    /**
     * ツルハシの所持・耐久をチェック。問題があればエラー情報を返す。
     */
    private checkPickaxeAvailable(): { failureType: string; message: string } | null {
        const pickaxes = this.bot.inventory.items().filter(i => i.name.includes('pickaxe'));
        if (pickaxes.length === 0) {
            return {
                failureType: 'missing_tool',
                message: 'ツルハシがありません。craft-one で stone_pickaxe 以上をクラフトしてから再実行してください。',
            };
        }

        let minDurability = Infinity;
        let hasDurabilityInfo = false;
        for (const p of pickaxes) {
            const max = (p as any).maxDurability;
            const used = (p as any).durabilityUsed;
            if (max != null && max > 0 && used != null && used >= 0) {
                hasDurabilityInfo = true;
                minDurability = Math.min(minDurability, max - used);
            }
        }

        if (hasDurabilityInfo && minDurability <= 3) {
            return {
                failureType: 'tool_durability_low',
                message: `ツルハシの残り耐久が${minDurability}しかありません。craft-one で新しいツルハシをクラフトしてから再実行してください。`,
            };
        }

        return null;
    }

    /**
     * ブロックを安全に掘る。ツールが必要なブロックでツルハシがない場合は false を返す。
     */
    private async digBlockSafe(block: any): Promise<boolean> {
        try {
            if (!block || !block.diggable) return false;

            if (PROTECTED_UTILITY_BLOCKS.has(block.name)) {
                log.warn(`⚠ ${block.name}は保護対象のためスキップ`);
                return false;
            }

            // マグマ隣接チェック — 掘ると溶岩が流入する場合は中止
            if (this.hasAdjacentLava(block.position)) {
                log.warn(`⚠ ${block.name}(${block.position.x},${block.position.y},${block.position.z})の隣にマグマがあるため掘削中止`);
                return false;
            }

            // Blocks with harvest tools drop nothing without one.
            const needsPickaxe = !!block.harvestTools;

            // 最適なツールを装備
            const tool = this.findBestTool(block);
            if (tool) {
                await this.bot.equip(tool, 'hand');
            } else if (needsPickaxe) {
                log.warn(`⚠ ${block.name}を掘るためのツルハシがありません`);
                return false;
            }

            await digBlockVerified(this.bot, block);
            return this.bot.blockAt(block.position)?.boundingBox === 'empty';
        } catch (error) {
            // A dig the body's guards refused (lava behind the block, a shut-out mob behind it) is said as that:
            // "could not confirm height and position" sent a planner back to the same stair three times (paid run L74).
            if (error instanceof ThreatExposedError || error instanceof LavaReleaseError) this.lastStopReason = error.message;
            return false;
        }
    }

    private adjacentWater(pos: Vec3): Vec3 | null {
        for (const off of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]) {
            const neighbor = this.bot.blockAt(pos.plus(off));
            if (neighbor && (neighbor.name === 'water' || neighbor.name === 'bubble_column')) return pos.plus(off);
        }
        return null;
    }

    private hasAdjacentLava(pos: Vec3): boolean {
        const offsets = [
            new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
            new Vec3(0, 1, 0), new Vec3(0, -1, 0),
            new Vec3(0, 0, 1), new Vec3(0, 0, -1),
        ];
        for (const off of offsets) {
            const neighbor = this.bot.blockAt(pos.plus(off));
            if (neighbor && neighbor.name === 'lava') return true;
        }
        return false;
    }

    /**
     * ブロックを安全に置く
     */
    private async placeBlockSafe(blockName: string, pos: Vec3): Promise<boolean> {
        try {
            const item = this.bot.inventory.items().find(i => i.name === blockName);
            if (!item) return false;

            // 参照ブロックを探す
            const offsets: [number, number, number, Vec3][] = [
                [0, -1, 0, new Vec3(0, 1, 0)],
                [1, 0, 0, new Vec3(-1, 0, 0)],
                [-1, 0, 0, new Vec3(1, 0, 0)],
                [0, 0, 1, new Vec3(0, 0, -1)],
                [0, 0, -1, new Vec3(0, 0, 1)],
                [0, 1, 0, new Vec3(0, -1, 0)],
            ];

            let referenceBlock = null;
            let faceVector = new Vec3(0, 1, 0);

            for (const [ox, oy, oz, face] of offsets) {
                const candidate = this.bot.blockAt(pos.offset(ox, oy, oz));
                if (candidate && candidate.boundingBox !== 'empty') {
                    referenceBlock = candidate;
                    faceVector = face;
                    break;
                }
            }

            if (!referenceBlock) return false;

            await this.bot.equip(item, 'hand');
            await this.bot.placeBlock(referenceBlock, faceVector);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * ブロックに最適なツールを探す
     */
    /**
     * Fastest held tool that can harvest the block, from the versioned block
     * data rather than name keywords (andesite, tuff and granite need a
     * pickaxe too). Returns null when only the bare hand qualifies.
     */
    private findBestTool(block: any): any {
        // Cheapest in time and wear (utils/toolChoice), not the fastest: the iron pickaxe is not spent on stone steps.
        return chooseTool(block, this.bot.inventory.items(), { requireHarvest: !!block.harvestTools, effects: (this.bot.entity as any)?.effects ?? {} });
    }

    private sleep(ms: number): Promise<void> {
        return actionDelay(this.bot, ms);
    }
}

export default StairMine;
