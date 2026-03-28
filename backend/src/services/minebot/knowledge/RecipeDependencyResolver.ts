import minecraftData from 'minecraft-data';
import { getSmeltingSource } from './smeltingRecipes.js';

export interface DependencyNode {
    item: string;
    quantity: number;
    children: DependencyNode[];
    method: 'craft' | 'smelt' | 'raw';
    requiresCraftingTable?: boolean;
    requiresFurnace?: boolean;
    /** calculateActualNeeds でインベントリから充足済みとマークされたノード */
    consumed?: boolean;
}

/**
 * Minecraft のクラフト／精錬レシピを再帰的に解決し、
 * ツリー形式の依存チェーンを構築する。
 *
 * FCA のプロンプト注入や plan-craft ツールで利用される。
 */
export class RecipeDependencyResolver {
    private mcData: ReturnType<typeof minecraftData>;
    private version: string;

    private static instance: RecipeDependencyResolver | null = null;

    /**
     * 採掘・モブドロップなどで直接入手すべき原材料。
     * これらはクラフトレシピ（ブロック展開: raw_iron_block→9 raw_iron 等）で
     * 解決すべきではない。
     */
    private static readonly RAW_MATERIALS = new Set([
        'raw_iron', 'raw_gold', 'raw_copper',
        'diamond', 'emerald', 'coal', 'lapis_lazuli', 'redstone',
        'quartz', 'amethyst_shard', 'flint',
    ]);

    private constructor(version: string) {
        this.version = version;
        this.mcData = minecraftData(version);
    }

    static getInstance(version: string): RecipeDependencyResolver {
        if (!RecipeDependencyResolver.instance || RecipeDependencyResolver.instance.version !== version) {
            RecipeDependencyResolver.instance = new RecipeDependencyResolver(version);
        }
        return RecipeDependencyResolver.instance;
    }

    /**
     * アイテム名から依存ツリーを再帰的に構築する。
     * maxDepth で無限再帰を防止。
     */
    resolve(itemName: string, quantity = 1, maxDepth = 5): DependencyNode {
        return this.resolveInternal(itemName, quantity, maxDepth, new Set());
    }

    private resolveInternal(
        itemName: string,
        quantity: number,
        depth: number,
        visited: Set<string>,
    ): DependencyNode {
        if (depth <= 0 || visited.has(itemName)) {
            return { item: itemName, quantity, children: [], method: 'raw' };
        }

        visited.add(itemName);

        // 精錬レシピがあるアイテムは smelt を優先する。
        // 例: iron_ingot は raw_iron → furnace が正しいルートだが、
        // minecraft-data には iron_block → 9 iron_ingot のクラフトレシピもあるため
        // craft を先に試すと間違った依存ツリーになる。
        const smeltNode = this.tryResolveSmelt(itemName, quantity, depth, visited);
        if (smeltNode) {
            visited.delete(itemName);
            return smeltNode;
        }

        // 原材料はクラフトレシピで解決しない（raw_iron_block→9 raw_iron 等のブロック展開を防止）
        if (RecipeDependencyResolver.RAW_MATERIALS.has(itemName)) {
            visited.delete(itemName);
            return { item: itemName, quantity, children: [], method: 'raw' };
        }

        const craftNode = this.tryResolveCraft(itemName, quantity, depth, visited);
        if (craftNode) {
            visited.delete(itemName);
            return craftNode;
        }

        visited.delete(itemName);
        return { item: itemName, quantity, children: [], method: 'raw' };
    }

    private tryResolveCraft(
        itemName: string,
        quantity: number,
        depth: number,
        visited: Set<string>,
    ): DependencyNode | null {
        const item = this.mcData.itemsByName[itemName];
        if (!item) return null;

        const recipes = this.mcData.recipes[item.id];
        if (!recipes || recipes.length === 0) return null;

        const recipe = recipes[0] as any;
        const resultCount = recipe.result?.count ?? 1;
        const craftCount = Math.ceil(quantity / resultCount);

        const ingredients = this.extractIngredients(recipe);
        if (ingredients.length === 0) return null;

        const requiresCraftingTable = this.requiresCraftingTable(recipe);

        const children: DependencyNode[] = ingredients.map(({ name, count }) =>
            this.resolveInternal(name, count * craftCount, depth - 1, visited),
        );

        return {
            item: itemName,
            quantity,
            children,
            method: 'craft',
            requiresCraftingTable,
        };
    }

    private tryResolveSmelt(
        itemName: string,
        quantity: number,
        depth: number,
        visited: Set<string>,
    ): DependencyNode | null {
        const smelting = getSmeltingSource(itemName);
        if (!smelting) return null;

        const inputNode = this.resolveInternal(smelting.input, quantity, depth - 1, visited);
        return {
            item: itemName,
            quantity,
            children: [inputNode],
            method: 'smelt',
            requiresFurnace: true,
        };
    }

    private extractIngredients(recipe: any): Array<{ name: string; count: number }> {
        const countMap = new Map<number, number>();

        if (recipe.inShape) {
            for (const row of recipe.inShape) {
                for (const cell of row) {
                    const id = Array.isArray(cell) ? cell[0] : cell;
                    if (id == null || id === -1) continue;
                    countMap.set(id, (countMap.get(id) || 0) + 1);
                }
            }
        } else if (recipe.ingredients) {
            for (const ing of recipe.ingredients) {
                const id = Array.isArray(ing) ? ing[0] : ing;
                if (id == null || id === -1) continue;
                countMap.set(id, (countMap.get(id) || 0) + 1);
            }
        }

        const result: Array<{ name: string; count: number }> = [];
        for (const [id, count] of countMap) {
            const itemInfo = this.mcData.items[id];
            if (itemInfo) {
                result.push({ name: itemInfo.name, count });
            }
        }
        return result;
    }

    /**
     * レシピが3x3グリッドを使用する（= crafting_table が必要）か判定。
     * inShape が 3行 or いずれかの行が3列なら crafting_table 必須。
     */
    private requiresCraftingTable(recipe: any): boolean {
        if (recipe.inShape) {
            if (recipe.inShape.length > 2) return true;
            for (const row of recipe.inShape) {
                if (row.length > 2) return true;
            }
        }
        if (recipe.ingredients && recipe.ingredients.length > 4) return true;
        return false;
    }

    /**
     * 依存ツリーを LLM プロンプト用のテキストにフォーマットする。
     */
    formatForPrompt(node: DependencyNode, indent = 0): string {
        const prefix = '  '.repeat(indent);
        const lines: string[] = [];

        let label = `${prefix}${node.item} x${node.quantity}`;

        if (node.method === 'craft') {
            label += node.requiresCraftingTable ? ' [クラフト: 作業台必要]' : ' [クラフト: 手元可]';
        } else if (node.method === 'smelt') {
            label += ' [精錬: かまど必要]';
        } else if (indent > 0) {
            label += ' [素材]';
        }

        lines.push(label);

        for (const child of node.children) {
            lines.push(this.formatForPrompt(child, indent + 1));
        }

        return lines.join('\n');
    }

    /**
     * 複数のアイテムの依存チェーンを一括でフォーマットし、
     * FCA システムプロンプトに注入するテキストを構築する。
     */
    buildDependencyPrompt(items: string[]): string | null {
        const sections: string[] = [];

        for (const item of items) {
            try {
                const tree = this.resolve(item);
                if (tree.children.length > 0) {
                    sections.push(this.formatForPrompt(tree));
                }
            } catch {
                // unknown item — skip
            }
        }

        if (sections.length === 0) return null;

        return `\n\n## クラフト依存チェーン（参考）\n以下はターゲットアイテムの完全な依存ツリーです。素材の確保から順に実行してください。\n\n${sections.join('\n\n')}`;
    }

    /**
     * インベントリを突合した製作計画プロンプトを構築する。
     * 依存ツリーの末端素材（raw 素材）を集計し、手持ちとの差分から
     * 「不足分」を明示することで、LLM が無駄な採掘を避けられるようにする。
     */
    buildDependencyPromptWithInventory(
        items: string[],
        inventory: Array<{ name: string; count: number }>,
    ): string | null {
        const inventoryMap = new Map<string, number>();
        for (const entry of inventory) {
            inventoryMap.set(entry.name, (inventoryMap.get(entry.name) || 0) + entry.count);
        }

        const sections: string[] = [];

        for (const item of items) {
            try {
                const tree = this.resolve(item);
                if (tree.children.length === 0) continue;

                // 依存ツリーを表示
                sections.push(this.formatForPrompt(tree));

                // 末端素材を集計
                const leafNeeds = new Map<string, number>();
                this.collectLeafMaterials(tree, leafNeeds);

                // インベントリと突合
                const lines: string[] = ['  --- 所持品との突合 ---'];
                let allSatisfied = true;

                for (const [mat, needed] of leafNeeds) {
                    const have = inventoryMap.get(mat) || 0;
                    const shortage = Math.max(0, needed - have);
                    if (shortage > 0) {
                        allSatisfied = false;
                        lines.push(`  ${mat}: 必要${needed} / 所持${have} → 不足${shortage}`);
                    } else {
                        lines.push(`  ${mat}: 必要${needed} / 所持${have} → ✔ 十分`);
                    }
                }

                // 精錬可能な中間素材もチェック（例: raw_iron→iron_ingot）
                const intermediateNeeds = new Map<string, number>();
                this.collectIntermediateMaterials(tree, intermediateNeeds);
                for (const [mat, needed] of intermediateNeeds) {
                    const have = inventoryMap.get(mat) || 0;
                    if (have > 0) {
                        lines.push(`  ${mat}: 必要${needed} / 所持${have} → 所持品を活用可能`);
                    }
                }

                if (allSatisfied) {
                    lines.push('  ★ 全素材が揃っています。採掘不要、すぐにクラフト/精錬を開始できます');
                }

                sections.push(lines.join('\n'));
            } catch {
                // unknown item — skip
            }
        }

        if (sections.length === 0) return null;

        return `\n\n## 製作計画（インベントリ突合済み）\n**重要: 所持品で足りる素材は新たに採掘しないこと。不足分だけを調達する。**\n\n${sections.join('\n\n')}`;
    }

    /**
     * 依存ツリーの末端（raw 素材）を再帰的に集計する。
     */
    collectLeafMaterials(node: DependencyNode, result: Map<string, number>): void {
        if (node.children.length === 0) {
            result.set(node.item, (result.get(node.item) || 0) + node.quantity);
            return;
        }
        for (const child of node.children) {
            this.collectLeafMaterials(child, result);
        }
    }

    /**
     * 依存ツリーの中間ノード（craft/smelt で生成されるアイテム）を集計する。
     * インベントリに中間素材が既にある場合の活用を促すため。
     */
    collectIntermediateMaterials(node: DependencyNode, result: Map<string, number>): void {
        if (node.children.length === 0) return;
        for (const child of node.children) {
            if (child.method !== 'raw') {
                result.set(child.item, (result.get(child.item) || 0) + child.quantity);
            }
            this.collectIntermediateMaterials(child, result);
        }
    }
}
