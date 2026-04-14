import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
const log = createLogger('Minebot:Skill:stairMine');

/**
 * 階段掘り/埋めスキル
 * 目標の高さまで階段状に移動する（掘る or ブロックを置く）
 */
class StairMine extends InstantSkill {
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
            const TIMEOUT_MS = 60 * 1000;
            const startTime = Date.now();

            log.info(`⛏️ 階段${isDescending ? '下降' : '上昇'}開始: Y=${currentY} → Y=${targetY} (${steps}段, 最大60秒)`, 'cyan');

            for (let i = 0; i < steps; i++) {
                // 中断チェック
                if (this.shouldInterrupt()) {
                    return {
                        success: successSteps > 0,
                        result: `中断: ${successSteps}段${isDescending ? '下降' : '上昇'}しました（Y=${Math.floor(this.bot.entity.position.y)}）`,
                    };
                }

                // タイムアウトチェック
                if (Date.now() - startTime > TIMEOUT_MS) {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    return {
                        success: successSteps > 0,
                        result: `タイムアウト（${elapsed}秒）: ${successSteps}段${isDescending ? '下降' : '上昇'}しました（Y=${Math.floor(this.bot.entity.position.y)}）`,
                    };
                }

                // ツルハシチェック（石系ブロックを掘るために必要）
                const toolCheck = this.checkPickaxeAvailable();
                if (toolCheck) {
                    return {
                        success: successSteps > 0,
                        failureType: toolCheck.failureType,
                        recoverable: true,
                        result: `${successSteps}段${isDescending ? '下降' : '上昇'}しました（Y=${Math.floor(this.bot.entity.position.y)}）。${toolCheck.message}`,
                    };
                }

                const currentPos = this.bot.entity.position.floored();

                if (isDescending) {
                    // 下降: 前方に1ブロック進んで1ブロック下を掘る
                    const success = await this.digStairDown(currentPos, dir);
                    if (!success) {
                        return {
                            success: successSteps > 0,
                            result: `${successSteps}段下降しました（Y=${Math.floor(this.bot.entity.position.y)}）。これ以上掘れません`,
                        };
                    }
                } else {
                    // 上昇: ブロックを置いて登る
                    const success = await this.buildStairUp(currentPos, dir, placeBlock);
                    if (!success) {
                        return {
                            success: successSteps > 0,
                            result: `${successSteps}段上昇しました（Y=${Math.floor(this.bot.entity.position.y)}）。これ以上登れません`,
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

            return {
                success: true,
                result: `${successSteps}段${isDescending ? '下降' : '上昇'}してY=${Math.floor(this.bot.entity.position.y)}に到達しました`,
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
    private async digStairDown(currentPos: Vec3, dir: Vec3): Promise<boolean> {
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
                        return false;
                    }
                    const dug = await this.digBlockSafe(block);
                    if (!dug) return false;
                }
            }

            // 移動（前方に1ブロック進む → 自然に落ちる）
            this.bot.setControlState('forward', true);
            await this.sleep(300);
            this.bot.setControlState('forward', false);

            // 落下を待つ
            await this.sleep(200);

            return true;
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
            // 置くブロックがあるか確認
            const item = this.bot.inventory.items().find(i => i.name === blockName);
            if (!item) {
                // 代替ブロックを探す
                const alternatives = ['cobblestone', 'stone', 'dirt', 'netherrack', 'cobbled_deepslate'];
                let found = false;
                for (const alt of alternatives) {
                    const altItem = this.bot.inventory.items().find(i => i.name === alt);
                    if (altItem) {
                        blockName = alt;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    log.warn('⚠ 置けるブロックがありません');
                    return false;
                }
            }

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
                // 空気なら階段ブロックを置く
                const placePos = currentPos.offset(dir.x, 0, dir.z);
                const placed = await this.placeBlockSafe(blockName, placePos);
                if (!placed) {
                    log.warn('⚠ ブロックを置けませんでした');
                    return false;
                }
            }

            // ジャンプして前方に移動
            this.bot.setControlState('jump', true);
            this.bot.setControlState('forward', true);
            await this.sleep(400);
            this.bot.setControlState('jump', false);
            this.bot.setControlState('forward', false);

            // 着地を待つ
            await this.sleep(200);

            return true;
        } catch (error: any) {
            log.error(`上昇エラー: ${error.message}`, error);
            return false;
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

            const blockName = block.name.toLowerCase();
            const needsPickaxe = ['stone', 'ore', 'cobble', 'deepslate', 'brick', 'obsidian',
                'concrete', 'terracotta', 'basalt', 'netherrack', 'granite', 'diorite', 'andesite', 'tuff']
                .some(kw => blockName.includes(kw));

            // 最適なツールを装備
            const tool = this.findBestTool(block);
            if (tool) {
                await this.bot.equip(tool, 'hand');
            } else if (needsPickaxe) {
                log.warn(`⚠ ${block.name}を掘るためのツルハシがありません`);
                return false;
            }

            await this.bot.dig(block);
            return true;
        } catch (error) {
            return false;
        }
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
    private findBestTool(block: any): any {
        const items = this.bot.inventory.items();
        const blockName = block.name.toLowerCase();

        let toolType: string[] = [];

        if (blockName.includes('stone') || blockName.includes('ore') || blockName.includes('cobble') ||
            blockName.includes('deepslate') || blockName.includes('brick')) {
            toolType = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
        } else if (blockName.includes('dirt') || blockName.includes('sand') || blockName.includes('gravel')) {
            toolType = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel'];
        } else if (blockName.includes('log') || blockName.includes('wood') || blockName.includes('plank')) {
            toolType = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'];
        }

        for (const name of toolType) {
            const tool = items.find(i => i.name === name);
            if (tool) return tool;
        }

        return null;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default StairMine;

