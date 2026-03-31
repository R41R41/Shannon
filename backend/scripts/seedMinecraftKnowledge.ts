/**
 * Minecraft 初期知識を MongoDB に seed するスクリプト
 *
 * 実行: cd backend && npx tsx scripts/seedMinecraftKnowledge.ts
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://100.74.197.48:27017/shannon';

const KNOWLEDGE_ENTRIES = [
    // 狩猟
    {
        category: 'minecraft_gameplay',
        content: '動物の狩猟: combat スキルは追跡が遅く非効率。正しい手順: (1) find-nearest-entity で動物の座標を取得 (2) move-to(x,y,z, range:2) で動物の座標に近づく (3) attack-continuously で倒す (4) pickup-nearest-item でドロップ回収。cow/pig/sheep を優先。chicken は小さく当たりにくい。attack-continuously は 4.5m 以内でないと動かない。',
    },
    // 食料
    {
        category: 'minecraft_gameplay',
        content: '食料の基本: 小麦(wheat)はそのまま食べられない→craft-one(bread)でパンにする(小麦3個→パン1個)。卵(brown_egg)は食べられない(投擲アイテム)。生肉(beef,porkchop,mutton,chicken)はかまどで焼いてから食べると回復量が大幅に増える。焼き肉の精錬フロー: start-smelting → wait-time(10秒×個数) → check-furnace → withdraw-from-furnace(slot="output")。',
    },
    // 採掘
    {
        category: 'minecraft_gameplay',
        content: '採掘とツルハシ: 石系ブロック(stone, ore, deepslate等)の採掘にはツルハシが必須。木のツルハシ: stone/coal_ore を掘れる。石のツルハシ以上: iron_ore, lapis_ore, copper_ore を掘れる。鉄のツルハシ以上: diamond_ore, gold_ore, redstone_ore, emerald_ore を掘れる。鉄鉱石のブロック名は iron_ore (raw_iron はドロップアイテム名)。',
    },
    // クラフト
    {
        category: 'minecraft_gameplay',
        content: 'クラフトの基本: 3x3レシピ(ツルハシ,斧,剣等)にはクラフトテーブルが必要。クラフトテーブル: oak_planks x4 → craft-one(crafting_table)。stone を掘ると cobblestone がドロップ(自然界に cobblestone ブロックは存在しない)。木の道具のクラフト順: oak_log → oak_planks(x4) → stick(x4) → crafting_table → wooden_pickaxe。',
    },
    // 精錬
    {
        category: 'minecraft_gameplay',
        content: '精錬: かまどの作り方: cobblestone x8 → craft-one(furnace)。かまどを place-block-at で設置してから使う。精錬品はかまど内にあるので check-inventory-item では見えない。check-furnace → withdraw-from-furnace(slot="output") で取り出す。Y<60の地下では精錬するな。先に stair-mine で地上に戻ってから。',
    },
    // ブロック設置
    {
        category: 'minecraft_gameplay',
        content: 'ブロック設置: place-block-at の前に get-position で現在座標を確認してから近くの座標を指定。grass_block がある場所には直接置けないので先に dig-block-at で除去。target_occupied で2回連続失敗したら地上(Y≥64)に移動してから設置する。',
    },
    // 道具の順序
    {
        category: 'minecraft_gameplay',
        content: '道具のアップグレード順: (1) 素手で原木を集める (2) 木のツルハシを作る (routine-make-wooden-tools) (3) stone を掘って石のツルハシを作る (routine-make-stone-tools、前提: 木のツルハシ) (4) iron_ore を掘って精錬し鉄のツルハシを作る (前提: 石のツルハシ以上)。',
    },
    // 鉄ピッケル作成
    {
        category: 'minecraft_gameplay',
        content: '鉄のツルハシの作り方: (1) 石のツルハシ以上を用意 (2) routine-find-and-mine-ore(iron_ore, count:3) で鉄鉱石を3個以上採掘 (3) かまどを設置して start-smelting で raw_iron を精錬 (4) iron_ingot x3 + stick x2 → craft-one(iron_pickaxe)。',
    },
    // 生存
    {
        category: 'minecraft_gameplay',
        content: 'サバイバルの基本: 満腹度が低いと体力が回復しない。食料は常にストックしておく。夜は敵モブが湧くので屋内で過ごすか寝る(sleep-in-bed)。水中では酸素が減る(autoSwim が自動浮上)。落下ダメージに注意(3ブロック以上の落下で受ける)。',
    },
    // ルーチン
    {
        category: 'minecraft_gameplay',
        content: 'ルーチンの使い方: routine-make-wooden-tools(前提なし、素手から開始可能)、routine-make-stone-tools(前提: 木のツルハシ)、routine-find-and-mine-ore(前提: 石のツルハシ以上)、routine-hunt-animal(動物を探して倒す)、routine-smelt-ore(かまど座標と鉱石を指定して精錬)、routine-gather-wood(原木採掘)。',
    },
];

async function seed() {
    console.log(`Connecting to ${MONGODB_URI}...`);
    await mongoose.connect(MONGODB_URI);
    console.log('Connected.');

    const db = mongoose.connection.db!;
    const collection = db.collection('shannonmemories');

    let inserted = 0;
    for (const entry of KNOWLEDGE_ENTRIES) {
        // 重複チェック
        // 重複チェック: 先頭のテキストで部分一致 (regex ではなく $text 不使用、安全に)
        const searchPrefix = entry.content.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const existing = await collection.findOne({
            category: 'knowledge',
            content: { $regex: searchPrefix },
        });
        if (existing) {
            console.log(`  Skip (exists): ${entry.content.slice(0, 40)}...`);
            continue;
        }

        await collection.insertOne({
            category: 'knowledge',
            subcategory: entry.category,
            content: entry.content,
            importance: 0.8,
            createdAt: new Date(),
            updatedAt: new Date(),
            accessCount: 0,
            lastAccessedAt: null,
            tags: ['minecraft', 'gameplay', 'seed'],
        });
        inserted++;
        console.log(`  ✔ Inserted: ${entry.content.slice(0, 40)}...`);
    }

    console.log(`\nDone: ${inserted} entries inserted (${KNOWLEDGE_ENTRIES.length - inserted} skipped).`);
    await mongoose.disconnect();
}

seed().catch(e => {
    console.error(e);
    process.exit(1);
});
