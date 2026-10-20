import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { digBlockVerified } from '../utils/digBlockVerified.js';
import { LavaReleaseError } from '../utils/lavaSafety.js';
import { ThreatExposedError } from '../utils/exposureGuard.js';
import { actionDelay } from '../execution/observedWait.js';
import { chooseTool, usesLeft } from '../utils/toolChoice.js';
import { spareToolNote } from '../utils/toolWear.js';
import { blocksAlong, keepCheapTool } from '../utils/toolStock.js';
import { nightGateFor } from '../utils/nightGate.js';
import { shaftStepRefusal } from '../utils/shaftDown.js';
import pathfinder from 'mineflayer-pathfinder';
import { gotoSafe } from '../utils/gotoSafe.js';
const { goals } = pathfinder;
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
        this.description = '斜めの階段を掘って（登りは置いて）目標の高さへ行く。種類で探して掘るならmine-block、1マスならdig-block-at';
        this.mcData = minecraftData(this.bot.version);
        // A descent to the diamonds is a hundred levels and more: two minutes cut a stair through stone at y 20 of 65 to -40, with
        // only "timeout" to say (lab copy of run 19's world, 2026-10-20). The stair's own bound (below) ends it first, with its account.
        this.maxDurationMs = 240_000;
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

    /** The night gate (utils/nightGate): a stair below y 16 at night without the kit is refused before the body is asked for. */
    protected preflight(targetY: number) {
        return nightGateFor(this.bot, Number(targetY), `stair-mine（目標 y${Math.floor(Number(targetY))}）`);
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
            // A stair cannot start from water (every way is "water beside"): run 11 and 12 asked for one on a sea and a frozen sea and
            // were refused four ways round (mb-body's lab, 2026-10-20). The body swims to the bank first and goes down from there.
            let leftWater = '';
            if (isDescending && this.inWaterNow()) {
                let out: { success?: boolean; result?: unknown } | null = null;
                try { out = await this.callSkill('leave-water'); } catch (error) { if (this.shouldInterrupt()) throw error; out = null; }
                if (!out?.success || this.inWaterNow()) {
                    return { success: false, failureType: 'stair_progress_blocked', recoverable: true,
                        result: `水の中からは階段を掘れません。岸へ上がれませんでした（${String(out?.result ?? 'leave-water なし').slice(0, 120)}）。find-dry-footholds で岸を探して move-to してから再実行してください` };
                }
                leftWater = '水から岸へ上がってから降りました。';
            }
            const steps = Math.abs(targetY - Math.floor(this.bot.entity.position.y));
            let successSteps = 0;
            /** Directions given up on in this call, with why (the stair turns to another by itself), and the one it was asked for. */
            const triedDirections: string[] = [];
            let firstDirection = dir.clone();
            /** Levels of this descent taken straight down (the rest were stair steps). */
            let shaftLevels = 0;
            /** Steps back up taken at a cave edge in this call (see the fallback below). */
            let backoffs = 0;
            const BACKOFFS = 3;
            /** Walks down to a cave's floor in this call (see the fallback below). */
            let caveWalks = 0;

            // タイムアウト設定（60秒）
            // Deepslate steps take several seconds each; a fixed 60s stopped a
            // 125-step descent to the diamond band after a fraction of it.
            const TIMEOUT_MS = Math.min(600_000, Math.max(60_000, steps * 4_000), (this.maxDurationMs || 120_000) - 4_000);
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
                        result: `${successSteps}段${isDescending ? '下降' : '上昇'}しました（Y=${Math.floor(this.bot.entity.position.y)}）。${toolCheck.message.replace(/。$/, '')}${spareToolNote(this.bot)}`,
                    };
                }

                const currentPos = this.bot.entity.position.floored();
                // A fall on the way (a step that gave onto a cave) can take the body past the height asked for: no further than that.
                if (isDescending ? currentPos.y <= targetY : currentPos.y >= targetY) break;

                if (isDescending) {
                    // Straight down where the rock allows (utils/shaftDown): one block dug for the level instead of a stair's three.
                    if (await this.shaftStep(currentPos)) { successSteps++; shaftLevels++; continue; }
                    // 下降: 前方に1ブロック進んで1ブロック下を掘る
                    const success = await this.digStairDown(currentPos, dir, placeBlock);
                    if (!success) {
                        // Blocked this way (a ledge, water beside the step, a block that will not break): the other ways from here
                        // first, the sides before the way back. Run 17 was sent east and north by hand and lost two calls to it.
                        const next = this.otherDirection(firstDirection, triedDirections);
                        if (next && !this.shouldInterrupt()) {
                            triedDirections.push(`${this.directionName(dir)}（${(this.lastStopReason ?? '進めず').slice(0, 56)}）`);
                            dir = next; this.lastStopReason = null; i--;
                            continue;
                        }
                        // Every way opens onto a cave too deep to step down into: the column the body stands on goes on down, dug
                        // a block at a time while there is solid rock under each (a ledge or a pillar over a cave), and the stair is
                        // taken up again from its foot. Ladder probe (2026-10-20): stopped at y -22 with all four ways open.
                        const voids = [...triedDirections, this.lastStopReason ?? ''].every(reason => reason.includes('で空いています'));
                        if (voids && !this.shouldInterrupt()) {
                            const down = await this.digDownInPlace(Math.min(8, Math.max(0, Math.floor(this.bot.entity.position.y) - targetY)));
                            if (down > 0) {
                                successSteps += down; i += down - 1;
                                triedDirections.length = 0; dir = firstDirection.clone(); this.lastStopReason = null;
                                continue;
                            }
                            // No rock under the feet either (a thin floor over the cave): one step back up the stair just dug, and
                            // the stair goes on to the side from there, where the rock is whole (ladder probe: y 27, the cave
                            // open on every side and under). At most BACKOFFS times a call.
                            if (backoffs < BACKOFFS) {
                                const back = new Vec3(-firstDirection.x, 0, -firstDirection.z);
                                const from = this.bot.entity.position.floored();
                                const feet = this.bot.blockAt(from.offset(back.x, 1, back.z)), head = this.bot.blockAt(from.offset(back.x, 2, back.z));
                                const step = this.bot.blockAt(from.offset(back.x, 0, back.z));
                                const dry = (block: any) => !['lava', 'water', 'flowing_lava', 'flowing_water'].includes(block?.name ?? '');
                                if (step?.boundingBox === 'block' && feet?.boundingBox === 'empty' && head?.boundingBox === 'empty' && dry(feet) && dry(head)
                                    && await this.moveOneStair(from, back, true)) {
                                    backoffs++; successSteps--; i -= 2;
                                    firstDirection = new Vec3(firstDirection.z, 0, -firstDirection.x);   // a quarter turn
                                    dir = firstDirection.clone(); triedDirections.length = 0; this.lastStopReason = null;
                                    continue;
                                }
                            }
                            // A cave too wide to step round: its floor, found below, is walked down to (the route planner digs and
                            // drops its own way), and the stair goes on from there. Ladder probe (2026-10-20): y 3, every way and the
                            // way back open, sixteen calls of no step.
                            if (caveWalks < 2) {
                                caveWalks++;
                                const fromY = Math.floor(this.bot.entity.position.y);
                                if (await this.walkToCaveFloor(targetY)) {
                                    const down = fromY - Math.floor(this.bot.entity.position.y);
                                    successSteps += down; i += down - 1;
                                    triedDirections.length = 0; dir = firstDirection.clone(); this.lastStopReason = null;
                                    continue;
                                }
                            }
                        }
                        return {
                            success: false,
                            failureType: 'stair_progress_blocked',
                            recoverable: true,
                            result: `${successSteps}段下降しました（Y=${Math.floor(this.bot.entity.position.y)}）。`
                                + (this.lastStopReason ?? '次の段で高さと位置を確認できず中断しました')
                                + (triedDirections.length ? `（ほかに試した方向: ${triedDirections.join('、')}）` : ''),
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

            }

            const finalY = Math.floor(this.bot.entity.position.y);
            return {
                success: finalY === targetY,
                failureType: finalY === targetY ? undefined : 'stair_progress_blocked',
                recoverable: finalY === targetY ? undefined : true,
                result: (finalY === targetY
                    ? `${leftWater}${successSteps}段${isDescending ? '下降' : '上昇'}してY=${finalY}に到達しました${shaftLevels ? `（うち${shaftLevels}段は縦穴で真下へ。足元の下が岩で、横に液体が無い所だけ）` : ''}`
                    : `${successSteps}段移動しましたが目標Y=${targetY}には到達していません（現在Y=${finalY}）`) + spareToolNote(this.bot),
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
                    const water = await this.plugWaterBeside(pos, blockName) ? null : this.adjacentWater(pos);
                    if (water) {
                        this.lastStopReason = `${label}の${block.name}(${pos.x}, ${pos.y}, ${pos.z})の隣(${water.x}, ${water.y}, ${water.z})が水です。`
                            + '塞ぐブロックが無いか塞げず、掘ると浸水するため停止しました。丸石などを持って再実行するか、水の無い場所から降りてください';
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
                // Nothing to bridge against (a cave opens under the step): a floor a block or two further down is stepped down to,
                // as a player drops into a cave, when the fall does no harm (three blocks in all) and no liquid is there. A
                // probe of the diamond descent (2026-10-20) stood at y -13 over such a cave with all four ways "open", and stopped.
                const drop = this.shallowFloorBelow(nextPos);
                if (drop !== null) {
                    const dropped = await this.moveOneStair(currentPos, dir, false, drop);
                    if (dropped) return true;
                }
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
     * One level straight down (utils/shaftDown): the block under the feet is dug and the body drops onto the rock under it. False, with
     * nothing dug, where that is not safe or the body cannot be stood over the middle of its column; the caller then takes a stair step.
     */
    private async shaftStep(feet: Vec3): Promise<boolean> {
        if (shaftStepRefusal(this.bot as any, feet)) return false;
        // The body's box (0.6 wide) has to be over this column alone, or it stays on the rim of the next.
        const centre = feet.offset(0.5, 0, 0.5);
        const off = () => Math.max(Math.abs(this.bot.entity.position.x - centre.x), Math.abs(this.bot.entity.position.z - centre.z));
        if (off() > 0.2) {
            try {
                await this.bot.lookAt(centre.offset(0, 1.6, 0), true);
                this.bot.setControlState('sneak', true);
                this.bot.setControlState('forward', true);
                for (let tick = 0; tick < 16 && off() > 0.15 && !this.shouldInterrupt(); tick++) await this.sleep(50);
            } finally {
                this.bot.setControlState('forward', false);
                this.bot.setControlState('sneak', false);
            }
            if (off() > 0.2 || Math.floor(this.bot.entity.position.y) !== feet.y) return false;
        }
        const floor = this.bot.blockAt(feet.offset(0, -1, 0));
        if (!floor || !(await this.digBlockSafe(floor))) return false;
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && !this.shouldInterrupt()
            && (Math.floor(this.bot.entity.position.y) >= feet.y || (this.bot.entity as any).onGround === false)) await this.sleep(50);
        return Math.floor(this.bot.entity.position.y) === feet.y - 1;
    }

    /** The next way to try, from the one first asked for (`dir`): its sides, then back; null once all four have been tried. */
    private otherDirection(dir: Vec3, tried: string[]): Vec3 | null {
        const left = new Vec3(dir.z, 0, -dir.x), right = new Vec3(-dir.z, 0, dir.x), back = new Vec3(-dir.x, 0, -dir.z);
        const given = tried.length + 1;   // this one is given up on as well
        if (given >= 4) return null;
        return [left, right, back][given - 1] ?? null;
    }

    private directionName(dir: Vec3): string {
        return dir.x > 0 ? 'east' : dir.x < 0 ? 'west' : dir.z > 0 ? 'south' : 'north';
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
    /**
     * Straight down where the body stands, up to `maxBlocks`: the block under the feet is dug only when the one under that is solid
     * (a fall of one), with no liquid beside either. Returns how many blocks it went down.
     */
    private async digDownInPlace(maxBlocks: number): Promise<number> {
        const liquid = (at: Vec3) => ['lava', 'water', 'flowing_lava', 'flowing_water'].includes(this.bot.blockAt(at)?.name ?? '');
        let down = 0;
        while (down < maxBlocks && !this.shouldInterrupt()) {
            const feet = this.bot.entity.position.floored();
            const floor = this.bot.blockAt(feet.offset(0, -1, 0)), under = this.bot.blockAt(feet.offset(0, -2, 0));
            if (!floor || floor.boundingBox !== 'block' || !floor.diggable || !under || under.boundingBox !== 'block') break;
            if ([feet.offset(0, -1, 0), feet.offset(0, -2, 0)].some(cell => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => liquid(cell.offset(dx, 0, dz))))) break;
            if (this.adjacentWater(feet.offset(0, -1, 0))) break;
            if (!(await this.digBlockSafe(floor))) break;
            const deadline = Date.now() + 1500;
            while (Date.now() < deadline && Math.floor(this.bot.entity.position.y) >= feet.y) await this.sleep(50);
            if (Math.floor(this.bot.entity.position.y) >= feet.y) break;
            down++;
        }
        if (down) log.info(`⛏️ 洞窟の縁: 足元を${down}ブロック真下へ掘り下げました（Y=${Math.floor(this.bot.entity.position.y)}）`);
        return down;
    }

    /**
     * The nearest dry floor of the cave below (3 to 24 blocks down, within 8 across, not below `targetY`), walked to by the route
     * planner in at most 30 s. True when the body came down 3 blocks or more.
     */
    private async walkToCaveFloor(targetY: number): Promise<boolean> {
        const floor = this.caveFloorBelow(this.bot.entity.position.floored(), targetY);
        if (!floor) return false;
        const fromY = this.bot.entity.position.y;
        try { await gotoSafe(this.bot, new goals.GoalBlock(floor.x, floor.y + 1, floor.z), { timeoutMs: 30_000 }); } catch (error) {
            if (this.shouldInterrupt()) throw error;
        }
        const came = fromY - this.bot.entity.position.y >= 3;
        if (came) log.info(`⛏️ 洞窟の縁: 洞窟の床(${floor.x}, ${floor.y + 1}, ${floor.z})へ歩いて降りました（Y=${Math.floor(this.bot.entity.position.y)}）`);
        return came;
    }

    /** See walkToCaveFloor: the floor block (feet and head above it open and dry, no lava beside, no magma), nearest across first. */
    caveFloorBelow(from: Vec3, targetY: number): Vec3 | null {
        const liquid = (at: Vec3) => ['lava', 'water', 'flowing_lava', 'flowing_water'].includes(this.bot.blockAt(at)?.name ?? '');
        const open = (at: Vec3) => { const block = this.bot.blockAt(at); return !!block && block.boundingBox === 'empty' && !liquid(at); };
        let best: Vec3 | null = null, bestCost = Infinity;
        for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) {
            const across = Math.abs(dx) + Math.abs(dz);
            if (across * 4 >= bestCost) continue;
            for (let down = 1; down <= 25; down++) {
                const cell = from.offset(dx, -down, dz);
                if (cell.y + 1 < targetY) break;
                const block = this.bot.blockAt(cell);
                if (!block) break;
                if (block.boundingBox !== 'block') continue;
                const feet = cell.offset(0, 1, 0);
                // Ground within three blocks is what the stair already stands on, not the cave's floor.
                if (down >= 4 && block.name !== 'magma_block' && open(feet) && open(feet.offset(0, 1, 0))
                    && ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => liquid(feet.offset(x, 0, z)) || liquid(cell.offset(x, 0, z)))) {
                    const cost = across * 4 + down;
                    if (cost < bestCost) { best = cell; bestCost = cost; }
                }
                break;   // the first solid block under the column is its floor; a deeper one is not reached through it
            }
        }
        return best;
    }

    /**
     * How many blocks below the step (`nextPos`) a solid floor lies that the body can drop to unharmed: 1 or 2 (a fall of two or
     * three blocks in all), with nothing but air between and no lava or water in the landing cell or beside it. Null otherwise.
     */
    private shallowFloorBelow(nextPos: Vec3): number | null {
        const liquid = (at: Vec3) => ['lava', 'water', 'flowing_lava', 'flowing_water'].includes(this.bot.blockAt(at)?.name ?? '');
        const open = (at: Vec3) => { const block = this.bot.blockAt(at); return !!block && block.boundingBox === 'empty' && !liquid(at); };
        for (let extra = 1; extra <= 2; extra++) {
            if (!open(nextPos.offset(0, -extra, 0))) return null;
            const floor = this.bot.blockAt(nextPos.offset(0, -extra - 1, 0));
            if (!floor) return null;
            if (floor.boundingBox !== 'block') continue;
            const landing = nextPos.offset(0, -extra, 0);
            const beside = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => liquid(landing.offset(dx, 0, dz)) || liquid(landing.offset(dx, -1, dz)));
            return beside || floor.name === 'magma_block' ? null : extra;
        }
        return null;
    }

    private async moveOneStair(start: Vec3, dir: Vec3, ascending: boolean, extraDrop = 0): Promise<boolean> {
        const target = start.offset(dir.x, ascending ? 1 : -1 - extraDrop, dir.z);
        // Aimed at the middle of the next column, not straight along the way: from a spot off the middle of its own column (the bank a
        // swim ended on, a landing a little to the side) a walk straight ahead ended with the box over the rim of the next block,
        // held up by it, and the step was given up four ways round (lab, 2026-10-20, after leave-water at x 12.73).
        const centre = { x: target.x + 0.5, z: target.z + 0.5 };
        const offCentre = () => Math.hypot(centre.x - this.bot.entity.position.x, centre.z - this.bot.entity.position.z);
        const aim = async () => {
            const p = this.bot.entity.position;
            // Mineflayer yaw: north=0, west=π/2, south=π, east=-π/2.
            await this.bot.look(Math.atan2(-(centre.x - p.x), -(centre.z - p.z)), 0, true);
        };
        await aim();
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
                if (!released && (progress >= 0.85 && offCentre() < 0.3 || progress >= 1.15)) {
                    this.bot.setControlState('forward', false);
                    if (ascending) this.bot.setControlState('jump', false);
                    released = true;
                } else if (!released && tick % 2 === 1) await aim();
                else if (released && !ascending && Math.floor(pos.y) > target.y && offCentre() > 0.35 && tick < 30) {
                    // Over the rim still (the drop has not come): towards the middle once more.
                    await aim();
                    this.bot.setControlState('forward', true);
                    released = false;
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

        // The pickaxe with the most left decides (each step chooses its own tool): measured by the worst one, a stone pickaxe at 1
        // stopped the stair five times while an iron one was in the hand (run 17).
        let bestDurability = -Infinity;
        let hasDurabilityInfo = false;
        for (const p of pickaxes) {
            const left = usesLeft(p as any);
            if (left === null) { bestDurability = Infinity; continue; }
            hasDurabilityInfo = true;
            bestDurability = Math.max(bestDurability, left);
        }

        if (hasDurabilityInfo && bestDurability <= 3) {
            return {
                failureType: 'tool_durability_low',
                message: `ツルハシの残り耐久が${bestDurability}しかありません。craft-one で新しいツルハシをクラフトしてから再実行してください。`,
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
                if (this.bot.heldItem?.type !== tool.type || this.bot.heldItem?.slot !== tool.slot) await this.bot.equip(tool, 'hand');
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

    /** Afloat or with the feet in water. */
    private inWaterNow(): boolean {
        const entity = this.bot.entity as any;
        if (entity?.isInWater) return true;
        const name = this.bot.blockAt(this.bot.entity.position.floored())?.name;
        return name === 'water' || name === 'bubble_column';
    }

    /**
     * Water beside a block about to be dug, put out with a carried block in each such cell (at most four), as a person blocks a leak
     * before breaking through. True when no water is left beside it. Run 18 stopped at y 51 with one source beside the stair, and
     * run 9 at an aquifer at y 25: four ways round, "water beside", the stair given up with stone in the bag (mb-body's lab).
     */
    private async plugWaterBeside(pos: Vec3, preferred: string): Promise<boolean> {
        const feet = this.bot.entity.position.floored();
        for (let tries = 0; tries < 4; tries++) {
            const water = this.adjacentWater(pos);
            if (!water) return true;
            // Never into the cells the body stands in: a block there is refused, and the body would be shut in.
            if ((water.x === feet.x && water.z === feet.z && (water.y === feet.y || water.y === feet.y + 1)) || this.shouldInterrupt()) return false;
            const filler = [preferred, 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack']
                .find(name => this.bot.inventory.items().some(item => item.name === name));
            if (!filler || !(await this.placeBlockSafe(filler, water))) return false;
            const deadline = Date.now() + 1000;
            while (Date.now() < deadline && ['water', 'bubble_column'].includes(this.bot.blockAt(water)?.name ?? '')) await this.sleep(50);
            log.info(`🧱 階段の脇の水(${water.x},${water.y},${water.z})を${filler}で塞いだ`);
        }
        return !this.adjacentWater(pos);
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
