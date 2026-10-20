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
import { blocksAlong, ensureToolUses, keepCheapTool, pickaxeUsesFor } from '../utils/toolStock.js';
import { packNeedsTidy, tidyPackNow } from '../utils/inventoryRoom.js';
import { emptySlotCountSafe } from '../utils/inventorySpillDetection.js';
import { hostileNear } from './craftOne.js';
import { nightGateFor } from '../utils/nightGate.js';
import { shaftStepRefusal } from '../utils/shaftDown.js';
import pathfinder from 'mineflayer-pathfinder';
import { gotoSafe } from '../utils/gotoSafe.js';
import { rankByRoute } from '../utils/routeEstimate.js';
import { waterLevelUnderBody } from '../utils/exitWater.js';
import { holdsWater } from '../utils/waterBlocks.js';
import { scanDryFootholds, spreadFootholds, type DryFoothold } from './findDryFootholds.js';
const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:stairMine');
/** The most blocks walked along the level, each way, to get clear of a lava lake or a cave under the descent (sidestepToRock). */
const SIDESTEP_BLOCKS = 6;

/** The ice of a frozen sea: ground no stair starts from (water lies under it). */
const SEA_ICE = new Set(['ice', 'packed_ice', 'blue_ice', 'frosted_ice']);
/** Land is looked for this far (the loaded chunks), and a stair starts this far from the water at least. */
const LAND_RADIUS = 64;
const LAND_MARGIN = 3;
/** With no land in sight, the body goes this far the way asked, and looks again. */
const SEA_LEG = 48;
/** Blocks carried to stand on or to shut water off with, after the one the caller named. */
const SCAFFOLD_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack'];
/** Cells of water shut off in one call at most. */
const WATER_SEALS = 48;
/** A seabed this much higher one way than the way swum turns the swim there (the sea shallows towards a shore). */
const SEABED_RISE = 4;
/** Uses of a pickaxe a level is counted to take (a shaft level digs one block, a stair level up to three; most of a descent is shaft). */
const USES_PER_LEVEL = 1.3;
/** The pickaxes' uses and the pack's room are looked at every this many levels. */
const UPKEEP_EVERY = 8;
/** On the way down the pack is tidied only when it is nearly full (this few free slots); at the end it is tidied from 30 slots taken. */
const TIDY_ON_THE_WAY_FREE = 2;

/**
 * 階段掘り/埋めスキル
 * 目標の高さまで階段状に移動する（掘る or ブロックを置く）
 */
class StairMine extends InstantSkill {
    /** Concrete cause of the last stopped step, reported to the planner. */
    private lastStopReason: string | null = null;
    /** Why the last trip to land did not get there, and the trip that did in this call (said in the result). */
    private landNote: string | null = null;
    private landTrip: string | null = null;
    /** The way swum at sea with no land in sight, kept from call to call until land is reached (see headingAtSea). */
    private seaHeading: Vec3 | null = null;
    /** Cells of water shut off in this call (see sealWater). */
    private waterSeals = 0;
    /** What this call did about the pickaxes and the pack (a spare made, stone thrown away), said at the end of its result. */
    private upkeepNotes: string[] = [];
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
        this.lastStopReason = null; this.landTrip = null; this.landNote = null; this.waterSeals = 0; this.upkeepNotes = [];
        const actionStartedAt = Date.now();
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

            /** Trips to land from the sea in this call (here, and in the fallback below). */
            let landWalks = 0;
            const LAND_WALKS = 3;
            // Down from the sea: to land before anything else. A pickaxe crafted afloat, the stair tried four ways in the water, the
            // body sinking and its breath reflex cutting in, took 95 s of the call's 120 before the swim (ladder probe, frozen sea).
            if (diff < 0 && !this.shouldInterrupt() && this.atSea([])) {
                landWalks++;
                const inland = await this.walkToLand(dir);
                if (inland) dir = inland;
            }
            const fromY = Math.floor(this.bot.entity.position.y);
            const isDescending = diff < 0;
            const steps = Math.max(0, isDescending ? fromY - targetY : targetY - fromY);
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
            /** Walks along the level away from a lava lake or a cave under the descent (sidestepToRock). */
            let sidesteps = 0;
            const SIDESTEPS = 3;

            // タイムアウト設定（60秒）
            // Deepslate steps take several seconds each; a fixed 60s stopped a
            // 125-step descent to the diamond band after a fraction of it.
            const TIMEOUT_MS = Math.min(600_000, Math.max(60_000, steps * 4_000), (this.maxDurationMs || 120_000) - 4_000);
            let startTime = Date.now();
            let lastUpkeepAt = -1;

            // Every step is dug: a dear pickaxe is not spent on it when a cheaper one can be made (utils/toolStock). Not while still at
            // sea: the table cannot be set down on the water (ladder probe, deep sea: nine tries, each refused).
            const here = this.bot.entity.position;
            const alongBlocks = blocksAlong(this.bot as any, here, { x: here.x + dir.x * steps, y: targetY, z: here.z + dir.z * steps });
            if (!(isDescending && this.atSea([]))) {
                await keepCheapTool(this.bot as any, alongBlocks, (skill, ...args) => this.callSkill(skill, ...args));
                // The pickaxes carried have to see the levels out: a spare is made now, with the table, rather than a break in the shaft.
                await this.checkPickaxeUses(alongBlocks, steps);
            }

            log.info(`⛏️ 階段${isDescending ? '下降' : '上昇'}開始: Y=${fromY} → Y=${targetY} (${steps}段, 最大${Math.round(TIMEOUT_MS / 1000)}秒)`, 'cyan');

            // Up through rock a pillar (tower-up: the block overhead dug, one laid underfoot) is twice as quick as a stair, which digs three cells
            // and steps aside for every level: lab, deepslate, diamond pickaxe, 1.27 s a level against 2.43. The stair is the way when the
            // pillar cannot be made (too few blocks, something overhead that will not be dug, water or lava above): it goes on from there.
            let pillared = 0;
            if (!isDescending && steps >= 3 && process.env.MINEBOT_STAIR_UP_PILLAR !== 'off') {
                const before = Math.floor(this.bot.entity.position.y);
                pillared = await this.pillarUp(targetY, startTime, TIMEOUT_MS);
                successSteps += pillared;
                if (pillared > 0) log.info(`⛏️ 上昇: 直上登りで${pillared}段上がりました（Y=${before} → Y=${Math.floor(this.bot.entity.position.y)}）`);
            }

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
                        result: `タイムアウト（${elapsed}秒）: ${successSteps}段${isDescending ? '下降' : '上昇'}しました（Y=${Math.floor(this.bot.entity.position.y)}）`
                            + (this.landTrip ? `。${this.landTrip}` : ''),
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

                // Every few levels: the pickaxes against the levels left (a spare is made if they fall short), and a pack that is nearly
                // full is tidied. The time spent is not taken from the stair's own bound, as with the swim to land.
                if (i > 0 && i % UPKEEP_EVERY === 0 && lastUpkeepAt !== i) {
                    lastUpkeepAt = i;
                    const upkeepStart = Date.now();
                    await this.checkPickaxeUses(alongBlocks, steps - i);
                    if (isDescending && emptySlotCountSafe(this.bot) <= TIDY_ON_THE_WAY_FREE) await this.tidyPack(actionStartedAt);
                    startTime += Date.now() - upkeepStart;
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
                        // At sea (afloat, on the ice of a frozen sea, or every way stopped by the water beside the step under the open
                        // sky): a stair cut into the seabed floods and digging under water is some 25 times slower, so the body goes
                        // to land first (swims, or walks the ice), where the rock under it is dry, and the stair goes on from there
                        // inland. Ladder probe (2026-10-20, runs 11 and 12): a frozen sea and a sea, "水です" every way, no step.
                        if (landWalks < LAND_WALKS && !this.shouldInterrupt() && this.atSea([...triedDirections, this.lastStopReason ?? ''])) {
                            landWalks++;
                            const fromY = Math.floor(this.bot.entity.position.y), walkStart = Date.now();
                            const inland = await this.walkToLand(firstDirection);
                            // The stair's own time is for the stair: the swim to land is not taken from it.
                            startTime += Date.now() - walkStart;
                            if (inland) {
                                const down = fromY - Math.floor(this.bot.entity.position.y);
                                successSteps += Math.max(0, down); i += down - 1;
                                firstDirection = inland; dir = inland.clone(); triedDirections.length = 0; this.lastStopReason = null;
                                continue;
                            }
                            this.lastStopReason = `${this.lastStopReason ?? '水の上です。'}（陸へ向かいましたが着けませんでした: ${this.landNote ?? '理由不明'}）`;
                        }
                        // A lava lake (or a cave) under every way: along the level to where the rock under is whole, then down again.
                        if (sidesteps < SIDESTEPS && !this.shouldInterrupt() && await this.sidestepToRock(firstDirection)) {
                            sidesteps++;
                            triedDirections.length = 0; dir = firstDirection.clone(); this.lastStopReason = null; i--;
                            continue;
                        }
                        return {
                            success: false,
                            failureType: 'stair_progress_blocked',
                            recoverable: true,
                            result: `${successSteps}段下降しました（Y=${Math.floor(this.bot.entity.position.y)}）。`
                                + (this.lastStopReason ?? '次の段で高さと位置を確認できず中断しました')
                                + (triedDirections.length ? `（ほかに試した方向: ${triedDirections.join('、')}）` : '')
                                + (this.landTrip ? `。${this.landTrip}` : ''),
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

            // The stone the stair brought in goes before the next order is refused for a full pack (run 20: the obsidian mine-block).
            if (isDescending && packNeedsTidy(this.bot as any)) await this.tidyPack(actionStartedAt);
            const finalY = Math.floor(this.bot.entity.position.y);
            return {
                success: finalY === targetY,
                failureType: finalY === targetY ? undefined : 'stair_progress_blocked',
                recoverable: finalY === targetY ? undefined : true,
                result: (finalY === targetY
                    ? `${successSteps}段${isDescending ? '下降' : '上昇'}してY=${finalY}に到達しました${shaftLevels ? `（うち${shaftLevels}段は縦穴で真下へ。足元の下が岩で、横に液体が無い所だけ）` : ''}`
                        + (pillared ? `（うち${pillared}段は直上登り: 真上に積んで登ったので、その分は横へ進んでいません。今いる場所から${direction || '向き'}へ歩いてください）` : '')
                    : `${successSteps}段移動しましたが目標Y=${targetY}には到達していません（現在Y=${finalY}）`)
                    + (this.landTrip ? `（${this.landTrip}）` : '') + spareToolNote(this.bot)
                    + (this.upkeepNotes.length ? ` ${this.upkeepNotes.join(' ')}` : ''),
            };
        } catch (error: any) {
            return {
                success: false,
                result: `階段掘りエラー: ${error.message}`,
            };
        }
    }

    /**
     * The pickaxes carried against the levels still to dig (USES_PER_LEVEL each): with fewer uses between them, a spare is made when the
     * bag allows (utils/toolStock ensureToolUses), and what was or could not be done is said at the end of the result. The stone pickaxe
     * of run 20 broke on a dig of the same kind with 75 cobblestone in the pack.
     */
    private async checkPickaxeUses(blocks: ReturnType<typeof blocksAlong>, levels: number): Promise<void> {
        const need = Math.ceil(Math.max(0, levels) * USES_PER_LEVEL);
        if (need <= 0 || pickaxeUsesFor(this.bot.inventory.items() as any, blocks) >= need) return;
        try {
            const check = await ensureToolUses(this.bot as any, blocks, need, (skill, ...args) => this.callSkill(skill, ...args));
            if (check.note && !this.upkeepNotes.includes(check.note)) this.upkeepNotes.push(check.note);
        } catch (error) { if (this.shouldInterrupt()) throw error; }
    }

    /** Throws away the stone and clutter the stair has brought in (utils/inventoryRoom tidyPackNow), and says what went. */
    private async tidyPack(actionStartedAt: number): Promise<void> {
        const note = await tidyPackNow(this.bot as any, (skill, ...args) => this.callSkill(skill, ...args), {
            timeLeftMs: (this.maxDurationMs || 120_000) - (Date.now() - actionStartedAt),
            interrupted: () => this.shouldInterrupt(),
            blocked: () => hostileNear(this.bot as any, 16) || String((this.bot as any).minebotControlState ?? '').startsWith('emergency'),
        });
        if (note) this.upkeepNotes.push(note.trim());
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
                    // The water is shut off first with a carried block, as a player does (sealWater); the stop stays for water in
                    // the stair's own cells, with nothing to shut it with, or when it will not shut.
                    const path = [currentPos, currentPos.offset(0, 1, 0), ...clearTargets.map(([cell]) => cell)];
                    let water = this.adjacentWater(pos);
                    for (let seal = 0; water && seal < 6 && !path.some(cell => cell.equals(water!)) && await this.sealWater(water, blockName); seal++)
                        water = this.adjacentWater(pos);
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
                const scaffold = [blockName, ...SCAFFOLD_BLOCKS].find(name => this.bot.inventory.items().some(i => i.name === name));
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
        let refusal = shaftStepRefusal(this.bot as any, feet);
        if (refusal === 'liquid_beside') {
            const into = feet.offset(0, -1, 0);
            await this.plugLavaBeside(into);
            for (let seal = 0, water = this.adjacentWater(into); water && seal < 4 && !water.equals(feet) && await this.sealWater(water); seal++)
                water = this.adjacentWater(into);
            refusal = shaftStepRefusal(this.bot as any, feet);
        }
        if (refusal) return false;
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
     * Straight up by tower-up, 20 levels a call, while the blocks last and each call climbs. Returns the levels climbed.
     * Stops at the first call that climbs nothing or fails: the stair takes the rest.
     */
    private async pillarUp(targetY: number, startedAt: number, timeoutMs: number): Promise<number> {
        const scaffold = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack'];
        const blocks = () => this.bot.inventory.items().filter(item => scaffold.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
        const startY = Math.floor(this.bot.entity.position.y);
        while (Math.floor(this.bot.entity.position.y) < targetY && !this.shouldInterrupt() && Date.now() - startedAt < timeoutMs) {
            const y = Math.floor(this.bot.entity.position.y);
            const height = Math.min(20, targetY - y);
            if (blocks() < height) break;
            let result;
            try { result = await this.callSkill('tower-up', height); } catch (error) { if (this.shouldInterrupt()) throw error; break; }
            const now = Math.floor(this.bot.entity.position.y);
            if (now <= y) {
                this.lastStopReason = `直上登りが進みませんでした（${String(result?.result ?? '').slice(0, 120)}）`;
                break;
            }
            if (!result?.success) { this.lastStopReason = `直上登りが途中で止まりました（${String(result?.result ?? '').slice(0, 120)}）`; break; }
        }
        return Math.max(0, Math.floor(this.bot.entity.position.y) - startY);
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

    private afloat(): boolean {
        return (this.bot.entity as any)?.isInWater === true || waterLevelUnderBody(this.bot as any) !== null;
    }

    /** A cell of the sea: water (or what holds it) or the ice over it. */
    private wetCell(at: Vec3): boolean {
        const block = this.bot.blockAt(at);
        return !!block && (holdsWater(block) || SEA_ICE.has(block.name));
    }

    /**
     * The body is at sea, where no stair can start: afloat, on the ice of a frozen sea, or stopped by water (`reasons`) with the open
     * sky over it (an aquifer underground is not the sea, and its own stop is said as it is).
     */
    atSea(reasons: string[]): boolean {
        if (this.afloat()) return true;
        const feet = this.bot.entity.position.floored();
        if (SEA_ICE.has(this.bot.blockAt(feet.offset(0, -1, 0))?.name ?? '')) return true;
        if (!reasons.some(reason => /水です|が(water|ice|packed_ice|blue_ice)で空いています/.test(reason))) return false;
        for (let up = 2; up <= 24; up++) {
            const block = this.bot.blockAt(feet.offset(0, up, 0));
            if (block && block.boundingBox !== 'empty') return false;
        }
        return true;
    }

    /**
     * Land a stair can start from: ground that is not ice, with no water or ice within LAND_MARGIN across and from the feet down
     * five (the stair's first steps, and the shore it leaves behind).
     */
    inland(feet: Vec3): boolean {
        if (SEA_ICE.has(this.bot.blockAt(feet.offset(0, -1, 0))?.name ?? '')) return false;
        for (let dx = -LAND_MARGIN; dx <= LAND_MARGIN; dx++) for (let dz = -LAND_MARGIN; dz <= LAND_MARGIN; dz++)
            for (let dy = 0; dy >= -5; dy--) if (this.wetCell(feet.offset(dx, dy, dz))) return false;
        return true;
    }

    /** The footholds on land (see inland) in the loaded chunks within LAND_RADIUS, nearest first, at most two dozen. */
    landSites(): DryFoothold[] {
        const sites: DryFoothold[] = [];
        for (const site of scanDryFootholds(this.bot as any, { radius: LAND_RADIUS, maxVertical: 12, wide: true }).candidates) {
            if (sites.length >= 24) break;
            if (this.inland(new Vec3(Math.floor(site.x), site.y, Math.floor(site.z)))) sites.push(site);
        }
        return sites;
    }

    /**
     * The way from `feet` whose stair stays clear of the sea: the fewest cells of water or ice along its first twelve steps (three
     * wide, floor to head), and of those the one leading on from where the body came (`from`), away from the shore.
     */
    inlandDirection(feet: Vec3, from: Vec3): Vec3 {
        const wet = (way: Vec3) => {
            let cells = 0;
            for (let k = 1; k <= 12; k++) for (let side = -1; side <= 1; side++) for (let up = -1; up <= 1; up++)
                if (this.wetCell(feet.offset(way.x * k - way.z * side, -k + up, way.z * k + way.x * side))) cells++;
            return cells;
        };
        return [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
            .map(way => ({ way, wet: wet(way), on: way.x * (feet.x - from.x) + way.z * (feet.z - from.z) }))
            .sort((a, b) => a.wet - b.wet || b.on - a.on)[0].way;
    }

    /**
     * How high the seabed lies the way `way`, 16 to 64 blocks off (three lines 8 apart, the loaded columns only): the mean height of
     * its first solid block under the sea level. Null with fewer than six columns read.
     */
    seabedHeight(way: Vec3): number | null {
        const feet = this.bot.entity.position.floored();
        let sum = 0, columns = 0;
        for (let k = 16; k <= 64; k += 8) for (const side of [-8, 0, 8]) {
            const x = feet.x + way.x * k - way.z * side, z = feet.z + way.z * k + way.x * side;
            for (let y = 62; y >= -16; y--) {
                const block = this.bot.blockAt(new Vec3(x, y, z));
                if (!block) break;
                if (block.boundingBox === 'block' && !SEA_ICE.has(block.name)) { sum += y; columns++; break; }
            }
        }
        return columns >= 6 ? sum / columns : null;
    }

    /**
     * The way to swim with no land in sight. The seabed rises towards a shore, so a way whose seabed lies SEABED_RISE blocks higher
     * than the present heading's is taken; otherwise the heading is kept, across calls (`seaHeading`), and never turned straight
     * back over the sea already seen. The way asked only starts it. Ladder probe (2026-10-20, a wide frozen sea): the way asked turned
     * east, south, west and north call by call, and the body swam to and fro for ten minutes.
     */
    headingAtSea(asked: Vec3): Vec3 {
        const current = this.seaHeading ?? asked;
        let best = current, bestHeight = this.seabedHeight(current) ?? -Infinity;
        for (const way of [new Vec3(current.z, 0, -current.x), new Vec3(-current.z, 0, current.x)]) {
            const height = this.seabedHeight(way);
            if (height !== null && height >= bestHeight + SEABED_RISE) { best = way; bestHeight = height; }
        }
        this.seaHeading = best;
        return best;
    }

    /** A quarter turn from `way`, to the side whose seabed lies higher (the left one when neither can be read or they are level). */
    sideOf(way: Vec3): Vec3 {
        const left = new Vec3(way.z, 0, -way.x), right = new Vec3(-way.z, 0, way.x);
        return (this.seabedHeight(right) ?? -Infinity) > (this.seabedHeight(left) ?? -Infinity) ? right : left;
    }

    /**
     * To land from the sea, by move-to (it swims, walks the ice, and climbs the bank on arrival): the land the navigator reaches most
     * cheaply of the nearest few; with none in sight, a swim of SEA_LEG blocks (headingAtSea) brings new chunks into view (twice at
     * most). Returns the way inland from where the body landed, or null (why in `landNote`).
     */
    private async walkToLand(asked: Vec3): Promise<Vec3 | null> {
        this.landNote = null;
        const tried = new Set<string>();
        const key = (site: DryFoothold) => `${Math.floor(site.x)},${site.y},${Math.floor(site.z)}`;
        for (let leg = 0; leg < 3 && !this.shouldInterrupt(); leg++) {
            const from = this.bot.entity.position.clone();
            const sites = this.landSites().filter(site => !tried.has(key(site)));
            if (!sites.length) {
                if (leg === 2) break;
                const heading = this.headingAtSea(asked);
                const to = from.offset(heading.x * SEA_LEG, 0, heading.z * SEA_LEG);
                log.info(`🌊 ${LAND_RADIUS}ブロック以内に陸が見えません。${this.directionName(heading)}へ${SEA_LEG}ブロック進んで探します`);
                const swum = await this.callSkill('move-to', Math.floor(to.x), Math.floor(from.y), Math.floor(to.z), 4, 'nearxz');
                const went = Math.hypot(this.bot.entity.position.x - from.x, this.bot.entity.position.z - from.z);
                // Hardly anywhere (a wall under the water, an ocean monument; ladder probe, deep sea: 1,000 s against one): the
                // heading turns a quarter, to the side whose seabed lies higher, never back.
                if (went < SEA_LEG / 4) this.seaHeading = this.sideOf(heading);
                this.landNote = `${LAND_RADIUS}ブロック以内に陸が見えず、${this.directionName(heading)}へ${Math.round(went)}ブロック進みました（${String(swum?.result ?? '').slice(0, 60)}）`;
                continue;
            }
            const site = (await rankByRoute(this.bot as any, spreadFootholds(sites, 4, 6), { timeoutMs: 700,
                goodEnough: (candidate, route) => route.cost <= 3 * candidate.distance + 10 }))[0];
            tried.add(key(site));
            const moved = await this.callSkill('move-to', site.x, site.y, site.z, 1.5, 'near');
            const here = this.bot.entity.position;
            if (Math.hypot(here.x - site.x, here.z - site.z) <= 2.5 && Math.abs(here.y - site.y) <= 1.5 && !this.afloat()) {
                const feet = here.floored();
                const way = this.inlandDirection(feet, from);
                this.seaHeading = null;
                this.landTrip = `海の上から陸(${feet.x}, ${feet.y}, ${feet.z})へ移り、${this.directionName(way)}へ掘り進めました`;
                log.info(`🌊 ${this.landTrip}`);
                return way;
            }
            this.landNote = `陸(${Math.floor(site.x)}, ${site.y}, ${Math.floor(site.z)})への移動: ${String(moved?.result ?? '失敗').slice(0, 80)}`;
        }
        return null;
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

            // マグマ隣接チェック — 掘ると溶岩が流入する場合は中止. Lava beside or over the block is filled with a carried block first
            // (plugLavaBeside); lava under it is not (the step would stand over it), and still stops the dig.
            if (this.hasAdjacentLava(block.position)) await this.plugLavaBeside(block.position);
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

    /**
     * Lava beside or over `pos` (never under it), filled with a carried block in each such cell, at most four; never in the cells the
     * body stands in. True when none is left there. A descent that meets a lava pocket beside its shaft goes on past it, as a person
     * blocks it off: the stair used to refuse the block and turn, four ways round, and stop (mb-body's diamond descents, 2026-10-20).
     */
    private async plugLavaBeside(pos: Vec3): Promise<boolean> {
        const feet = this.bot.entity.position.floored();
        const offsets = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];
        const lavaAt = () => offsets.map(off => pos.plus(off)).find(cell => ['lava', 'flowing_lava'].includes(this.bot.blockAt(cell)?.name ?? '')) ?? null;
        for (let tries = 0; tries < 4; tries++) {
            const lava = lavaAt();
            if (!lava) return true;
            if ((lava.x === feet.x && lava.z === feet.z && (lava.y === feet.y || lava.y === feet.y + 1)) || this.shouldInterrupt()) return false;
            const filler = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack']
                .find(name => this.bot.inventory.items().some(item => item.name === name));
            if (!filler || !(await this.placeBlockSafe(filler, lava))) return false;
            const deadline = Date.now() + 1000;
            while (Date.now() < deadline && ['lava', 'flowing_lava'].includes(this.bot.blockAt(lava)?.name ?? '')) await this.sleep(50);
            log.info(`🧱 階段の脇の溶岩(${lava.x},${lava.y},${lava.z})を${filler}で塞いだ`);
        }
        return !lavaAt();
    }

    /**
     * Along the level, away from what lies under the descent (a lava lake, a cave): up to SIDESTEP_BLOCKS forward in the first way that
     * has rock to walk on, the head and feet cells dug as needed (each dig held to the lava rules), until a step straight down is safe
     * again. The ways in turn: the one asked for, its sides, back. False, with the body where it got to, when no way leads there.
     */
    private async sidestepToRock(first: Vec3): Promise<boolean> {
        const ways = [first, new Vec3(first.z, 0, -first.x), new Vec3(-first.z, 0, first.x), new Vec3(-first.x, 0, -first.z)];
        for (const way of ways) {
            for (let n = 0; n < SIDESTEP_BLOCKS && !this.shouldInterrupt(); n++) {
                const here = this.bot.entity.position.floored();
                const floor = this.bot.blockAt(here.offset(way.x, -1, way.z));
                if (!floor || floor.boundingBox !== 'block' || ['lava', 'water', 'magma_block'].includes(floor.name)) break;
                let open = true;
                for (const dy of [1, 0]) {
                    const cell = this.bot.blockAt(here.offset(way.x, dy, way.z));
                    if (cell && cell.boundingBox !== 'empty' && !(await this.digBlockSafe(cell))) { open = false; break; }
                    if (['lava', 'flowing_lava', 'water'].includes(this.bot.blockAt(here.offset(way.x, dy, way.z))?.name ?? '')) { open = false; break; }
                }
                if (!open || !(await this.moveOneStair(here, way, false, -1))) break;
                if (!shaftStepRefusal(this.bot as any, this.bot.entity.position.floored())) {
                    log.info(`⛏️ 下りの真下が開いていたので、横へ${n + 1}ブロック進んでから縦穴を続けます`);
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * A cell of water beside a block the stair is about to dig, filled with a carried block (the scaffold blocks) so that the dig
     * does not let the water in. Ladder probe (2026-10-20, a frozen sea's coast): 25 steps down, then water beside every way at
     * y 38 under the ground, and eight calls of no step. Not afloat (the sea is left for land first, see walkToLand), at most
     * WATER_SEALS a call.
     */
    async sealWater(at: Vec3, blockName = 'cobblestone'): Promise<boolean> {
        if (this.waterSeals >= WATER_SEALS || this.afloat()) return false;
        const block = [blockName, ...SCAFFOLD_BLOCKS].find(name => this.bot.inventory.items().some(item => item.name === name));
        if (!block || !(await this.placeBlockSafe(block, at))) return false;
        this.waterSeals++;
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline && this.bot.blockAt(at)?.boundingBox !== 'block') await this.sleep(100);
        const sealed = this.bot.blockAt(at)?.boundingBox === 'block';
        if (sealed) log.info(`⛏️ 隣の水(${at.x}, ${at.y}, ${at.z})を${block}でふさぎました`);
        return sealed;
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
