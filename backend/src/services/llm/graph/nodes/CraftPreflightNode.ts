/**
 * CraftPreflight Node — 決定論的クラフト前処理
 *
 * classify → execute の間で、Minecraft クラフトタスクのレシピ解決・
 * インベントリ突合・インフラ検索を LLM を使わずコードで事前計算する。
 * 結果を短い promptInjection テキストとして FCA に渡し、
 * LLM の判断ミス（材料あるのに採掘、作業台あるのに作成）を防止する。
 */

import { createLogger } from '../../../../utils/logger.js';
import {
    RecipeDependencyResolver,
    DependencyNode,
} from '../../../minebot/knowledge/RecipeDependencyResolver.js';

const log = createLogger('CraftPreflight');

// ── CraftPlan interface ──────────────────────────────────────────

export interface CraftPlan {
    target: string;
    count: number;
    canCraftImmediately: boolean;
    materialStatus: 'sufficient' | 'partial' | 'missing';
    missingMaterials: Array<{ item: string; need: number; have: number }>;
    steps: string[];
    nearbyInfra: Array<{ type: string; pos: { x: number; y: number; z: number }; distance: number }>;
    needsCraftingTable: boolean;
    craftingTableAvailable: boolean;
    needsFurnace: boolean;
    furnaceAvailable: boolean;
    /** FCA に注入する短いテキスト */
    promptInjection: string;
}

// ── JP→EN item name map (shared with FCA extractCraftTargets) ────

const JP_ITEM_MAP: Record<string, string> = {
    '鉄インゴット': 'iron_ingot', '金インゴット': 'gold_ingot', '銅インゴット': 'copper_ingot',
    '作業台': 'crafting_table', 'かまど': 'furnace', 'チェスト': 'chest',
    '木のツルハシ': 'wooden_pickaxe', '石のツルハシ': 'stone_pickaxe', '鉄のツルハシ': 'iron_pickaxe',
    'ダイヤのツルハシ': 'diamond_pickaxe', '木の剣': 'wooden_sword', '石の剣': 'stone_sword',
    '鉄の剣': 'iron_sword', 'ダイヤの剣': 'diamond_sword', 'ベッド': 'bed',
    '松明': 'torch', 'たいまつ': 'torch', 'はしご': 'ladder',
    'ドア': 'oak_door', '柵': 'oak_fence', 'バケツ': 'bucket',
    '鉄の防具': 'iron_chestplate', '鉄のヘルメット': 'iron_helmet', '鉄のブーツ': 'iron_boots',
    '鉄のレギンス': 'iron_leggings', '盾': 'shield', '弓': 'bow',
    '矢': 'arrow', '釣り竿': 'fishing_rod', '焼き鳥': 'cooked_chicken',
    '焼き肉': 'cooked_beef', '焼き豚': 'cooked_porkchop',
    'パン': 'bread', 'ケーキ': 'cake',
    '木の斧': 'wooden_axe', '石の斧': 'stone_axe', '鉄の斧': 'iron_axe',
    '木のシャベル': 'wooden_shovel', '石のシャベル': 'stone_shovel', '鉄のシャベル': 'iron_shovel',
    '木のクワ': 'wooden_hoe', '石のクワ': 'stone_hoe', '鉄のクワ': 'iron_hoe',
};

/**
 * アイテム名（ドロップ名）→ 実際に採掘すべきブロック名のマッピング。
 * cobblestone はブロックとして存在せず stone を掘ると cobblestone がドロップする。
 */
const ITEM_TO_MINEABLE_BLOCK: Record<string, string> = {
    cobblestone: 'stone',
    raw_iron: 'iron_ore',
    raw_gold: 'gold_ore',
    raw_copper: 'copper_ore',
    diamond: 'diamond_ore',
    redstone: 'redstone_ore',
    lapis_lazuli: 'lapis_ore',
    coal: 'coal_ore',
    emerald: 'emerald_ore',
    flint: 'gravel',
    // 木系はそのまま（oak_log→oak_log）
};

// ── Material equivalents (同じレシピスロットに使える代替素材) ────

/**
 * 同一レシピグループ内の代替素材マップ。
 * key のアイテムが周囲に見つからない場合、values 内の代替を探す。
 */
const MATERIAL_EQUIVALENTS: Record<string, string[]> = {
    oak_log: ['acacia_log', 'birch_log', 'spruce_log', 'jungle_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'],
    oak_planks: ['acacia_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks'],
    acacia_log: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'],
    birch_log: ['oak_log', 'acacia_log', 'spruce_log', 'jungle_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'],
    spruce_log: ['oak_log', 'acacia_log', 'birch_log', 'jungle_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'],
};

/** _log → 対応する _planks 名 */
function logToPlanks(logName: string): string {
    return logName.replace('_log', '_planks');
}

/**
 * 依存ツリー内の素材を、周囲に実在する代替素材に置換する。
 * 例: oak_log が周囲にないが acacia_log が 15 個ある → ツリー内の oak_log → acacia_log に、
 *     対応する oak_planks → acacia_planks に置換。
 */
function substituteNearbyMaterials(
    tree: DependencyNode,
    nearbyResources: Array<{ name: string; count: number }>,
    inventoryMap: Map<string, number>,
): { substituted: boolean; from: string; to: string } | null {
    const nearbySet = new Map(nearbyResources.map(r => [r.name, r.count]));

    // ツリーの末端（raw素材）からログ系を探す
    const leaves: DependencyNode[] = [];
    collectLeaves(tree, leaves);

    const logLeaf = leaves.find(n => n.item.endsWith('_log'));
    if (!logLeaf) return null;

    const currentLog = logLeaf.item;
    // インベントリに既にある場合は置換不要
    if ((inventoryMap.get(currentLog) ?? 0) >= logLeaf.quantity) return null;
    // 周囲に既にある場合も置換不要
    if ((nearbySet.get(currentLog) ?? 0) > 0) return null;

    // 代替を探す
    const alternatives = MATERIAL_EQUIVALENTS[currentLog];
    if (!alternatives) return null;

    const bestAlt = alternatives
        .filter(alt => (nearbySet.get(alt) ?? 0) > 0)
        .sort((a, b) => (nearbySet.get(b) ?? 0) - (nearbySet.get(a) ?? 0))[0];

    if (!bestAlt) return null;

    // ツリー内のすべての currentLog → bestAlt、対応する planks も置換
    const currentPlanks = logToPlanks(currentLog);
    const bestPlanks = logToPlanks(bestAlt);

    replaceItemInTree(tree, currentLog, bestAlt);
    replaceItemInTree(tree, currentPlanks, bestPlanks);

    log.info(`[CraftPreflight] 素材代替: ${currentLog} → ${bestAlt} (周囲に${nearbySet.get(bestAlt)}個)`);

    return { substituted: true, from: currentLog, to: bestAlt };
}

function collectLeaves(node: DependencyNode, result: DependencyNode[]): void {
    if (node.children.length === 0) {
        result.push(node);
        return;
    }
    for (const child of node.children) {
        collectLeaves(child, result);
    }
}

function replaceItemInTree(node: DependencyNode, from: string, to: string): void {
    if (node.item === from) {
        node.item = to;
    }
    for (const child of node.children) {
        replaceItemInTree(child, from, to);
    }
}

// ── Craft target extraction ──────────────────────────────────────

export function extractCraftTargets(text: string): string[] {
    const targets: string[] = [];

    const snakeCaseMatches = text.match(/[a-z][a-z0-9_]+(?:_[a-z0-9]+)+/g);
    if (snakeCaseMatches) {
        targets.push(...snakeCaseMatches);
    }

    for (const [jp, en] of Object.entries(JP_ITEM_MAP)) {
        if (text.includes(jp) && !targets.includes(en)) {
            targets.push(en);
        }
    }

    return targets;
}

// ── Tree analysis helpers ────────────────────────────────────────

/** ツリー全体で crafting_table が必要か（consumed ノードの子孫はスキップ） */
function treeNeedsCraftingTable(node: DependencyNode): boolean {
    if (node.requiresCraftingTable) return true;
    if (node.consumed) return false; // インベントリ充足済み → 子ノードの要件は不要
    return node.children.some(treeNeedsCraftingTable);
}

/** ツリー全体で furnace が必要か（consumed ノードはスキップ） */
function treeNeedsFurnace(node: DependencyNode): boolean {
    if (node.consumed) return false; // インベントリ充足済み → 精錬不要
    if (node.requiresFurnace) return true;
    return node.children.some(treeNeedsFurnace);
}

// ── Smart material calculation ───────────────────────────────────

/**
 * インベントリの中間素材を考慮して、実際に不足している末端素材を計算する。
 *
 * 例: wooden_pickaxe = planks x3 + sticks x2
 *   sticks はインベントリに 4 本 → stick の原料 planks は不要
 *   planks はインベントリに 6 枚 → oak_log の採掘不要
 */
function calculateActualNeeds(
    tree: DependencyNode,
    inventoryMap: Map<string, number>,
): {
    satisfied: boolean;
    missing: Array<{ item: string; need: number; have: number }>;
    materialSummary: Array<{ item: string; need: number; have: number }>;
} {
    // Working copy of inventory to track consumption
    const available = new Map(inventoryMap);
    const missing: Array<{ item: string; need: number; have: number }> = [];
    const materialSummary: Array<{ item: string; need: number; have: number }> = [];

    /**
     * 再帰的にツリーを走査し、各ノードで:
     * 1. インベントリにそのアイテムが十分あれば消費して終了（子ノードは不要）
     * 2. 不足分だけ子ノードに降りて素材を確認
     */
    function resolveNeeds(node: DependencyNode, needed: number): void {
        if (needed <= 0) return;

        const have = available.get(node.item) ?? 0;

        if (have >= needed) {
            // インベントリで充足 — 消費してリターン（子ノードの探索不要）
            available.set(node.item, have - needed);
            node.consumed = true;
            materialSummary.push({ item: node.item, need: needed, have });
            log.info(`[calcNeeds] ${node.item}: have=${have} >= need=${needed} → consumed`);
            return;
        }

        // 部分的に充足 — 残りを子ノードで解決
        const shortfall = needed - have;
        if (have > 0) {
            available.set(node.item, 0);
            materialSummary.push({ item: node.item, need: needed, have });
            log.info(`[calcNeeds] ${node.item}: have=${have} < need=${needed} → shortfall=${shortfall}`);
        }

        if (node.children.length === 0) {
            // 末端（raw素材）で不足
            if (!materialSummary.find(m => m.item === node.item)) {
                materialSummary.push({ item: node.item, need: needed, have });
            }
            missing.push({ item: node.item, need: needed, have });
            log.info(`[calcNeeds] ${node.item}: RAW missing need=${needed} have=${have}`);
            return;
        }

        // クラフトノード: 子素材を再帰的に解決
        // shortfall 個のアイテムを作るのに必要な素材を計算
        // node.quantity : node.children[i].quantity の比率で必要量を算出
        const ratio = shortfall / node.quantity;
        for (const child of node.children) {
            const childNeeded = Math.ceil(child.quantity * ratio);
            resolveNeeds(child, childNeeded);
        }
    }

    resolveNeeds(tree, tree.quantity);

    return {
        satisfied: missing.length === 0,
        missing,
        materialSummary,
    };
}

// ── Action step builder ──────────────────────────────────────────

/**
 * アイテム名から実際に mine-block で指定すべきブロック名を返す。
 * cobblestone → stone のように、ドロップ名とブロック名が異なるケースを処理。
 */
function getMineableBlockName(itemName: string): string {
    return ITEM_TO_MINEABLE_BLOCK[itemName] ?? itemName;
}

/**
 * 依存ツリーから精錬が必要なアイテムを収集する。
 * 例: iron_pickaxe → iron_ingot(smelt) → raw_iron
 */
function collectSmeltItems(node: DependencyNode): Array<{ output: string; input: string; quantity: number }> {
    // consumed ノードはインベントリから充足済み → 精錬不要
    if (node.consumed) return [];
    const result: Array<{ output: string; input: string; quantity: number }> = [];
    if (node.method === 'smelt' && node.children.length > 0) {
        result.push({ output: node.item, input: node.children[0].item, quantity: node.quantity });
    }
    for (const child of node.children) {
        result.push(...collectSmeltItems(child));
    }
    return result;
}

/**
 * インベントリから利用可能な燃料を判定し、推奨燃料名を返す。
 */
function detectAvailableFuel(inventoryMap: Map<string, number>): string | null {
    // 優先順: coal > charcoal > oak_planks > oak_log > stick
    const fuelPriority = ['coal', 'charcoal', 'oak_planks', 'oak_log', 'stick'];
    for (const fuel of fuelPriority) {
        if ((inventoryMap.get(fuel) ?? 0) > 0) return fuel;
    }
    return null;
}

function buildActionSteps(
    tree: DependencyNode,
    satisfied: boolean,
    missing: Array<{ item: string; need: number; have: number }>,
    infra: Array<{ name: string; x: number; y: number; z: number; distance: number }>,
    needsCT: boolean,
    needsFurnaceBlock: boolean,
    inventoryMap: Map<string, number>,
): string[] {
    const steps: string[] = [];
    const ctBlock = infra.find(b => b.name === 'crafting_table');
    const furnaceBlock = infra.find(b => b.name === 'furnace' || b.name === 'blast_furnace');
    const smeltItems = collectSmeltItems(tree);
    const recommendedFuel = detectAvailableFuel(inventoryMap);

    // 1. Missing materials → mine/acquire (ブロック名に変換)
    if (!satisfied) {
        for (const m of missing) {
            const shortage = m.need - m.have;
            const blockName = getMineableBlockName(m.item);
            if (blockName !== m.item) {
                steps.push(`mine-block(${blockName}, count=${shortage}) → ${m.item}を${shortage}個入手`);
            } else {
                steps.push(`mine-block(${blockName}, count=${shortage})`);
            }
        }
    }

    // 2. Infrastructure: crafting_table (精錬用の中間クラフトや最終クラフトに必要)
    if (needsCT && !ctBlock) {
        steps.push('craft-one(crafting_table) → get-position → place-block-at(crafting_table, 足元の隣)');
    }

    // 3. Infrastructure: furnace
    if (needsFurnaceBlock && !furnaceBlock) {
        steps.push('craft-one(furnace) → get-position → place-block-at(furnace, 足元の隣)');
    }

    // 4. Smelting steps (精錬は最終クラフトの前に行う)
    if (smeltItems.length > 0) {
        const fuelHint = recommendedFuel ? `, fuel=${recommendedFuel}` : '';
        const fuelNote = !recommendedFuel ? ' ※燃料の採掘が必要(coal_ore推奨)' : '';
        for (const s of smeltItems) {
            if (furnaceBlock) {
                steps.push(`start-smelting(${furnaceBlock.x}, ${furnaceBlock.y}, ${furnaceBlock.z}, ${s.input}, ${s.quantity}${fuelHint}) → ${s.output} x${s.quantity}${fuelNote}`);
            } else {
                steps.push(`start-smelting([設置した座標], ${s.input}, ${s.quantity}${fuelHint}) → ${s.output} x${s.quantity}${fuelNote}`);
            }
        }
    }

    // 5. Final craft (craft-one は近くの crafting_table を自動検出して使用する。activate-block は不要)
    steps.push(`craft-one(${tree.item})`);

    steps.push('task-complete');
    return steps;
}

// ── Prompt injection formatter ───────────────────────────────────

function formatCraftPlan(plan: CraftPlan): string {
    const lines: string[] = [];
    lines.push(`【クラフト分析】${plan.target} x${plan.count}`);

    // Material status with details
    if (plan.materialStatus === 'sufficient') {
        lines.push('✔ 材料十分 — 採掘不要');
    } else {
        const missingLine = plan.missingMaterials
            .map(m => {
                const shortage = m.need - m.have;
                const blockName = getMineableBlockName(m.item);
                if (blockName !== m.item) {
                    return `${m.item}不足${shortage}(mine-block(${blockName})で入手)`;
                }
                return `${m.item}不足${shortage}`;
            })
            .join(', ');
        lines.push(`✘ 材料不足: ${missingLine}`);
    }

    // Infrastructure
    if (plan.needsCraftingTable) {
        if (plan.craftingTableAvailable) {
            const ct = plan.nearbyInfra.find(i => i.type === 'crafting_table');
            if (ct) {
                lines.push(`✔ 作業台: (${ct.pos.x},${ct.pos.y},${ct.pos.z}) 距離${ct.distance}m — 新しく作らないこと`);
            }
        } else {
            lines.push('✘ 作業台なし → craft-one(crafting_table) で自動設置される。または planks x4 を確保してから craft-one で作成');
        }
    }

    if (plan.needsFurnace) {
        if (plan.furnaceAvailable) {
            const f = plan.nearbyInfra.find(i => i.type === 'furnace' || i.type === 'blast_furnace');
            if (f) {
                lines.push(`✔ かまど: (${f.pos.x},${f.pos.y},${f.pos.z}) 距離${f.distance}m`);
            }
        } else {
            lines.push('✘ かまどなし → cobblestone x8 で craft-one(furnace) → place-block-at');
        }
    }

    // Action steps
    lines.push('手順:');
    for (let i = 0; i < plan.steps.length; i++) {
        lines.push(`${i + 1}. ${plan.steps[i]}`);
    }

    if (plan.canCraftImmediately) {
        lines.push('※ 全て揃っているので採掘や作業台の作成は不要。上記手順だけを実行すること。');
    }

    lines.push('重要: craft-one は近くの作業台を自動検出して使用します。activate-block(crafting_table) を呼ぶ必要はありません。');

    return lines.join('\n');
}

// ── Main node function ───────────────────────────────────────────

export interface CraftPreflightInput {
    channel: string;
    text?: string;
    inventory?: Array<{ name: string; count: number }>;
    nearbyInfrastructure?: Array<{ name: string; x: number; y: number; z: number; distance: number }>;
    nearbyResources?: Array<{ name: string; count: number }>;
}

/**
 * CraftPreflight ノード関数。
 * ShannonGraph の state から必要情報を取り出して CraftPlan を生成する。
 */
export function runCraftPreflight(input: CraftPreflightInput): CraftPlan | undefined {
    if (input.channel !== 'minecraft') return undefined;

    const text = input.text ?? '';
    const targets = extractCraftTargets(text);
    if (targets.length === 0) return undefined;

    const MC_VERSION = '1.20';
    const resolver = RecipeDependencyResolver.getInstance(MC_VERSION);
    const inventory = input.inventory ?? [];
    const infra = input.nearbyInfrastructure ?? [];
    const inventoryMap = new Map<string, number>();
    for (const entry of inventory) {
        inventoryMap.set(entry.name, (inventoryMap.get(entry.name) ?? 0) + entry.count);
    }

    // Use the first craft target (primary)
    const target = targets[0];

    // Debug: inventory dump
    const invSummary = inventory.length > 0
        ? inventory.map(i => `${i.name}:${i.count}`).join(', ')
        : '(empty)';
    log.info(`[CraftPreflight] target=${target}, inventory=[${invSummary}]`);

    try {
        const tree = resolver.resolve(target);
        if (tree.children.length === 0 && tree.method === 'raw') {
            // No recipe found — not a craftable item
            return undefined;
        }

        // 周囲の資源に基づいて素材を代替（oak_log → acacia_log 等）
        const nearbyResources = input.nearbyResources ?? [];
        if (nearbyResources.length > 0) {
            substituteNearbyMaterials(tree, nearbyResources, inventoryMap);
        }

        // Debug: tree structure
        log.info(`[CraftPreflight] tree: ${formatTreeCompact(tree)}`);

        // Material analysis with intermediate material optimization
        const { satisfied, missing, materialSummary } = calculateActualNeeds(tree, inventoryMap);

        // Infrastructure analysis
        const needsCT = treeNeedsCraftingTable(tree);
        const needsFurnaceBlock = treeNeedsFurnace(tree);
        const ctNearby = infra.find(b => b.name === 'crafting_table');
        const furnaceNearby = infra.find(b => b.name === 'furnace' || b.name === 'blast_furnace');
        const ctAvailable = !!ctNearby;
        const furnaceAvailable = !!furnaceNearby;

        // Can craft immediately?
        const canCraftImmediately = satisfied
            && (!needsCT || ctAvailable)
            && (!needsFurnaceBlock || furnaceAvailable);

        // Build action steps
        const steps = buildActionSteps(tree, satisfied, missing, infra, needsCT, needsFurnaceBlock, inventoryMap);

        // Nearby infra for plan
        const nearbyInfraForPlan = infra.map(b => ({
            type: b.name,
            pos: { x: b.x, y: b.y, z: b.z },
            distance: b.distance,
        }));

        const materialStatus: CraftPlan['materialStatus'] = satisfied
            ? 'sufficient'
            : missing.every(m => m.have > 0)
                ? 'partial'
                : 'missing';

        const plan: CraftPlan = {
            target,
            count: tree.quantity,
            canCraftImmediately,
            materialStatus,
            missingMaterials: missing,
            steps,
            nearbyInfra: nearbyInfraForPlan,
            needsCraftingTable: needsCT,
            craftingTableAvailable: ctAvailable,
            needsFurnace: needsFurnaceBlock,
            furnaceAvailable,
            promptInjection: '', // filled below
        };

        plan.promptInjection = formatCraftPlan(plan);

        log.info(`[CraftPreflight] ${target}: ${materialStatus}, canCraftImmediately=${canCraftImmediately}`);
        if (missing.length > 0) {
            log.info(`[CraftPreflight] Missing: ${missing.map(m => `${m.item}(${m.have}/${m.need})`).join(', ')}`);
        }
        if (infra.length > 0) {
            log.info(`[CraftPreflight] Infra: ${infra.map(b => `${b.name}(${b.x},${b.y},${b.z})`).join(', ')}`);
        }

        return plan;
    } catch (err) {
        log.warn(`[CraftPreflight] Failed to analyze ${target}: ${err}`);
        return undefined;
    }
}

// ── CraftPlan → PlanState conversion ─────────────────────────────

import type { PlanState, PlanSubtask } from '../cognitive/CognitiveBlackboard.js';

/**
 * CraftPlan を CognitiveBlackboard 用の PlanState に変換する。
 * ParallelExecutor で blackboard.updatePlan() に渡す。
 */
export function craftPlanToPlanState(craftPlan: CraftPlan, goal: string): PlanState {
    const subtasks: PlanSubtask[] = [];
    let stepId = 1;

    // 1. 不足素材の採掘ステップ
    for (const m of craftPlan.missingMaterials) {
        const shortage = m.need - m.have;
        const blockName = getMineableBlockName(m.item);
        subtasks.push({
            id: `st_${stepId++}`,
            goal: blockName !== m.item
                ? `${blockName}を${shortage}個採掘して${m.item}を入手`
                : `${m.item}を${shortage}個入手`,
            status: 'pending',
            iterationsSpent: 0,
            children: [],
            createdBy: 'craft_preflight',
            createdAt: Date.now(),
        });
    }

    // 2. インフラ設置（crafting_table）
    if (craftPlan.needsCraftingTable && !craftPlan.craftingTableAvailable) {
        subtasks.push({
            id: `st_${stepId++}`,
            goal: 'crafting_tableをクラフトして設置',
            status: 'pending',
            iterationsSpent: 0,
            children: [],
            createdBy: 'craft_preflight',
            createdAt: Date.now(),
        });
    }

    // 3. インフラ設置（furnace）
    if (craftPlan.needsFurnace && !craftPlan.furnaceAvailable) {
        subtasks.push({
            id: `st_${stepId++}`,
            goal: 'furnaceをクラフトして設置',
            status: 'pending',
            iterationsSpent: 0,
            children: [],
            createdBy: 'craft_preflight',
            createdAt: Date.now(),
        });
    }

    // 4. 精錬ステップ
    const smeltItems = craftPlan.steps
        .filter(s => s.startsWith('start-smelting'))
        .map(s => s);
    if (smeltItems.length > 0) {
        subtasks.push({
            id: `st_${stepId++}`,
            goal: '素材を精錬する',
            status: 'pending',
            iterationsSpent: 0,
            children: [],
            createdBy: 'craft_preflight',
            createdAt: Date.now(),
        });
    }

    // 5. crafting_table 使用 + 最終クラフト
    subtasks.push({
        id: `st_${stepId++}`,
        goal: `${craftPlan.target}をクラフト`,
        status: 'pending',
        iterationsSpent: 0,
        children: [],
        createdBy: 'craft_preflight',
        createdAt: Date.now(),
    });

    const strategy = craftPlan.canCraftImmediately
        ? '材料・インフラ全て揃い。即クラフト可能'
        : craftPlan.steps.slice(0, 3).join(' → ');

    return {
        goal,
        strategy,
        subtasks,
        currentSubtaskId: subtasks[0]?.id ?? null,
        journalSummary: `プラン作成: ${craftPlan.target}をクラフト。${subtasks.length}サブタスク。戦略: ${strategy}`,
        lastUpdatedBy: 'craft_preflight',
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

// ── Debug helpers ────────────────────────────────────────────────

/** ツリーをコンパクトな1行文字列にフォーマット */
function formatTreeCompact(node: DependencyNode, depth = 0): string {
    const prefix = depth > 0 ? `${node.item}x${node.quantity}` : `${node.item}x${node.quantity}`;
    if (node.children.length === 0) return prefix;
    const children = node.children.map(c => formatTreeCompact(c, depth + 1)).join('+');
    return `${prefix}(${children})`;
}
