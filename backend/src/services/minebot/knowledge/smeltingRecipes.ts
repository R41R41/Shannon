/**
 * 精錬レシピの静的定義。
 * minecraft-data にはクラフトレシピのみ含まれ、精錬レシピは含まれないため、
 * 主要な精錬レシピをここで定義する。
 *
 * 形式: output → { input, fuel? }
 * fuel を省略した場合は任意の燃料を使用する。
 */

export interface SmeltingRecipe {
    input: string;
    fuel?: string;
    description?: string;
}

export const SMELTING_RECIPES: Record<string, SmeltingRecipe> = {
    // 鉱石 → インゴット
    iron_ingot: { input: 'raw_iron', description: '鉄鉱石(raw_iron)を精錬' },
    gold_ingot: { input: 'raw_gold', description: '金鉱石(raw_gold)を精錬' },
    copper_ingot: { input: 'raw_copper', description: '銅鉱石(raw_copper)を精錬' },

    // 石材
    stone: { input: 'cobblestone', description: '丸石を精錬' },
    smooth_stone: { input: 'stone', description: '石を精錬' },
    glass: { input: 'sand', description: '砂を精錬' },
    deepslate: { input: 'cobbled_deepslate', description: '深層岩の丸石を精錬' },

    // 食料
    cooked_beef: { input: 'beef', description: '生の牛肉を精錬' },
    cooked_porkchop: { input: 'porkchop', description: '生の豚肉を精錬' },
    cooked_chicken: { input: 'chicken', description: '生の鶏肉を精錬' },
    cooked_mutton: { input: 'mutton', description: '生の羊肉を精錬' },
    cooked_cod: { input: 'cod', description: '生のタラを精錬' },
    cooked_salmon: { input: 'salmon', description: '生の鮭を精錬' },
    cooked_rabbit: { input: 'rabbit', description: '生のウサギ肉を精錬' },
    baked_potato: { input: 'potato', description: 'ジャガイモを精錬' },
    dried_kelp: { input: 'kelp', description: '昆布を精錬' },

    // その他
    brick: { input: 'clay_ball', description: '粘土玉を精錬' },
    nether_brick: { input: 'netherrack', description: 'ネザーラックを精錬' },
    charcoal: { input: 'oak_log', description: '原木を精錬（任意の原木可）' },
    green_dye: { input: 'cactus', description: 'サボテンを精錬' },
    lime_dye: { input: 'sea_pickle', description: 'シーピクルスを精錬' },
    sponge: { input: 'wet_sponge', description: '濡れたスポンジを乾燥' },
    cracked_stone_bricks: { input: 'stone_bricks', description: '石レンガを精錬' },
    cracked_nether_bricks: { input: 'nether_bricks', description: 'ネザーレンガを精錬' },
    cracked_deepslate_bricks: { input: 'deepslate_bricks', description: '深層岩レンガを精錬' },
    cracked_deepslate_tiles: { input: 'deepslate_tiles', description: '深層岩タイルを精錬' },
    terracotta: { input: 'clay', description: '粘土を精錬' },
};

/**
 * 精錬元の名前を返す。該当なしなら null。
 */
export function getSmeltingSource(outputItem: string): SmeltingRecipe | null {
    return SMELTING_RECIPES[outputItem] ?? null;
}
