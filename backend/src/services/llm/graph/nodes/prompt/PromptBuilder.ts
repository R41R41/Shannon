import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TaskContext } from '@shannon/common';
import { EmotionState } from '../EmotionNode.js';
import { MemoryState } from '../MemoryNode.js';
import type { SelfImprovementRulesFile } from '../../cognitive/selfImprove/types.js';

/**
 * FunctionCallingAgent 用のシステムプロンプト構築ユーティリティ
 *
 * 感情・記憶・環境・プラットフォーム情報をもとにシステムプロンプトを組み立てる。
 * ツール情報は API の tools パラメータで渡すため、ここではルールとコンテキストのみ。
 */
/** シャノンプロフィールのキャッシュ */
let _cachedProfile: string | null = null;

function loadShannonProfile(): string {
    if (_cachedProfile !== null) return _cachedProfile;
    try {
        const profilePath = resolve(process.cwd(), 'backend/saves/prompts/others/shannon_profile.md');
        _cachedProfile = readFileSync(profilePath, 'utf-8').trim();
    } catch {
        _cachedProfile = '';
    }
    return _cachedProfile;
}

/** 動的ルールのキャッシュ（60秒間有効） */
const DYNAMIC_RULES_CACHE_TTL_MS = 60_000;
const RULES_FILE_PATH = 'backend/saves/minecraft/self_improvement_rules.json';

let _cachedDynamicRules: string[] = [];
let _cacheTimestamp = 0;

async function loadDynamicRules(): Promise<string[]> {
    const now = Date.now();
    if (now - _cacheTimestamp < DYNAMIC_RULES_CACHE_TTL_MS) {
        return _cachedDynamicRules;
    }
    try {
        const filePath = resolve(process.cwd(), RULES_FILE_PATH);
        const content = await readFile(filePath, 'utf-8');
        const data: SelfImprovementRulesFile = JSON.parse(content);
        _cachedDynamicRules = data.rules
            .filter(r => r.enabled && r.target === 'prompt')
            .map(r => r.rule);
        _cacheTimestamp = now;
    } catch {
        // ファイルがなければ空配列
        _cachedDynamicRules = [];
        _cacheTimestamp = now;
    }
    return _cachedDynamicRules;
}

// 初回ロードを非同期で開始（結果はキャッシュされる）
loadDynamicRules().catch(() => {});

export class PromptBuilder {
    /** 食べ物アイテム名セット（autoEat の FALLBACK_FOOD_POINTS と同期） */
    private static readonly FOOD_ITEMS = new Set([
        'baked_potato', 'bread', 'cooked_beef', 'steak', 'cooked_porkchop',
        'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod',
        'cooked_salmon', 'golden_carrot', 'golden_apple', 'enchanted_golden_apple',
        'carrot', 'potato', 'beetroot', 'beetroot_soup', 'mushroom_stew',
        'rabbit_stew', 'suspicious_stew', 'dried_kelp', 'apple', 'melon_slice',
        'sweet_berries', 'glow_berries', 'chorus_fruit', 'cookie', 'pumpkin_pie',
        'honey_bottle', 'porkchop', 'beef', 'mutton', 'chicken', 'rabbit',
        'rotten_flesh', 'cod', 'salmon',
    ]);

    /**
     * 動的ルールのキャッシュをリフレッシュ（外部から呼ぶ）
     */
    static async refreshDynamicRules(): Promise<void> {
        _cacheTimestamp = 0;
        await loadDynamicRules();
    }

    /**
     * 完全なシステムプロンプトを構築
     */
    buildSystemPrompt(
        emotionState: EmotionState,
        context: TaskContext | null,
        environmentState: string | null,
        memoryState?: MemoryState,
        memoryPrompt?: string,
        relationshipPrompt?: string,
        selfModelPrompt?: string,
        strategyPrompt?: string,
        internalStatePrompt?: string,
        worldModelPrompt?: string,
        classifyMode?: string,
        needsTools?: boolean,
    ): string {
        const currentTime = new Date().toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo',
        });

        const platformInfo = this.formatPlatformInfo(context);
        const minecraftRules = this.formatMinecraftRules(context);
        const emotionInfo = this.formatEmotionInfo(emotionState);
        const envInfo = this.formatEnvironmentInfo(environmentState, context);
        const memoryInfo = this.formatMemoryInfo(
            memoryState,
            memoryPrompt,
            relationshipPrompt,
            selfModelPrompt,
            strategyPrompt,
            internalStatePrompt,
            worldModelPrompt,
        );
        const responseInstruction = this.buildResponseInstruction(context, classifyMode, needsTools);

        // Web/Discord ではシャノンのプロフィールを注入して人格を保つ
        const profileSection = (context?.platform === 'web' || context?.platform === 'discord')
            ? `\n\n${loadShannonProfile()}\n\n---\n\n`
            : '';

        return `あなたはAGI「シャノン」です。${profileSection}ユーザーの指示に従ってツールを使いタスクを実行してください。
${responseInstruction}

## 思考と行動
- **毎ターン、ツールを呼ぶ前に content（テキスト）で現状認識と次の一手の理由を1-2文で述べること**。これはあなたの思考ログとして記録される
- タスクが**完了したら task-complete ツールを呼んで宣言する**。テキストだけの応答では完了にならない
- task-complete は**最終目標が達成されたときだけ**呼ぶ。中間工程（精錬開始、移動中など）では呼ばない

## 現在の状態
- 時刻: ${currentTime}${platformInfo}${emotionInfo}${envInfo}
${memoryInfo}
## ルール
1. 複雑なタスクは update-plan ツールで計画を立ててから実行する
2. 「調べて」「教えて」と言われたら必ず google-search → fetch-url の順でページ本文まで読む。検索結果のスニペットだけで回答しない
3. 不完全な情報や「サイトで確認してください」は絶対にダメ。具体的な情報を整理して送信する
4. 失敗したら同じことを繰り返さない。2回同じエラーが出たら方針転換
5. Notionページの画像は describe-notion-image で全て分析してから報告する
6. 感情に基づいた自然な応答をする（機械的にならない）
7. 挨拶や雑談はシンプルに応答（update-plan不要、task-completeで完了宣言）
8. Twitterに投稿する際は、必ず generate-tweet-text でツイート文を生成してから post-on-twitter で投稿する。自分で直接ツイート文を書かない
${minecraftRules}

## 回答フォーマット
- 調査結果や情報をまとめる際は Discord Markdown で見やすく整形する（**太字**, 箇条書き等）
- 調査結果には参照元のURLリンクも記載する
- 画像を添付する場合は describe-image で内容を確認し、話題に関連する画像のみを添付する（サイトロゴやバナー等は添付しない）
- 挨拶や短い雑談はシンプルなテキストでOK（過度な装飾不要）

## 記憶ガイドライン
- 印象的な体験や新しい発見があったら save-experience で保存する
- 新しい知識を学んだら save-knowledge で保存する
- 「前にもこんなことあったよね？」「今日何してた？」「最近どう？」等、過去の出来事を聞かれたら recall-experience で思い出す
- 「ボクの関連する記憶」セクションに体験が含まれている場合は、その内容を積極的に回答に活用する（会話履歴だけでなく記憶も参照する）
- 特定の知識が必要なら recall-knowledge で思い出す
- 話してる人のことを詳しく知りたいなら recall-person で思い出す
- 保存時には個人情報（本名、住所、連絡先等）を含めないこと
  - ただし ライ・ヤミー・グリコ の名前はOK（公人）

## 画像編集ガイドライン
- 「上の画像を編集して」「さっきの画像の○○を変えて」等と言われたら:
  1. まず get-discord-images でチャンネル内の画像URLを取得する
  2. 該当する画像URLを edit-image の imagePath に渡す（URLは自動ダウンロードされる）
- ファイル名やパスを推測しない。必ず get-discord-images で正確なURLを取得すること
- describe-image で画像の内容を確認する場合も、まず get-discord-images でURLを取得する`;
    }

    /**
     * プラットフォーム別の応答指示を構築
     */
    buildResponseInstruction(context: TaskContext | null, classifyMode?: string, needsTools?: boolean): string {
        let base: string;
        switch (context?.platform) {
            case 'discord':
                base = '最終返信は chat-on-discord を使わず、通常の文章として返してください。システムが action plan として Discord に配信します。';
                break;
            case 'web':
                base = '最終返信は chat-on-web を使わず、通常の文章として返してください。システムが action plan として Web UI に配信します。';
                break;
            case 'twitter':
                base = '今は X 上の返信処理です。post-on-twitter を最終返信のために使わず、投稿本文だけを通常の文章として返してください。システムが reply/post を実行します。';
                break;
            case 'minebot':
            case 'minecraft':
                base = '今は Minecraft 上で行動できます。最終返信は chat-on-web や chat-on-discord を使わず通常の文章として返してください。必要な物理行動は Minecraft 用ツールを使って実行し、システムが action plan に変換します。';
                break;
            default:
                base = '最終的な回答は通常の文章として返してください。';
                break;
        }

        // 分類駆動の指示追加: needsTools=false なら会話モードを明示
        if (needsTools === false) {
            base += '\n\n**このリクエストは会話的な応答で十分です。** 検索やツールの使用は不要です。task-complete の summary に応答文を入れて完了してください。';
        } else if (classifyMode === 'planning') {
            base += '\n\n複雑なマルチステップタスクです。まず update-plan で計画を立ててから実行してください。';
        }

        return base;
    }

    /**
     * プラットフォームに応じて無効化すべき出力ツール名を返す
     */
    getDisabledOutputTools(context: TaskContext | null): string[] {
        switch (context?.platform) {
            case 'discord':
                return ['chat-on-discord'];
            case 'web':
                return ['chat-on-web'];
            case 'twitter':
                return ['post-on-twitter'];
            case 'minebot':
            case 'minecraft':
                return ['chat-on-discord', 'chat-on-web', 'post-on-twitter'];
            default:
                return [];
        }
    }

    // ── private helpers ──

    private formatPlatformInfo(context: TaskContext | null): string {
        if (!context) return '';

        let platformInfo = `\n- プラットフォーム: ${context.platform}`;
        if (context.discord) {
            const d = context.discord;
            platformInfo += `\n- Discord: ${d.guildName || ''}/${d.channelName || ''} (guildId: ${d.guildId || ''}, channelId: ${d.channelId || ''})`;
            if (d.userName) platformInfo += `\n- ユーザー: ${d.userName}`;
        }
        if ((context.platform === 'minebot' || context.platform === 'minecraft') && context.metadata?.minecraft) {
            const mc = context.metadata.minecraft as Record<string, unknown>;
            platformInfo += `\n- Minecraft: server=${mc.serverName || mc.serverId || ''}, world=${mc.worldId || ''}, dimension=${mc.dimension || ''}, biome=${mc.biome || ''}`;
            if (mc.position && typeof mc.position === 'object') {
                const pos = mc.position as Record<string, unknown>;
                platformInfo += `\n- 位置: (${pos.x ?? '?'}, ${pos.y ?? '?'}, ${pos.z ?? '?'})`;
            }
            if (typeof mc.health === 'number' || typeof mc.food === 'number') {
                platformInfo += `\n- 状態: HP=${mc.health ?? '?'}/20, 満腹度=${mc.food ?? '?'}/20`;
            }
            if (Array.isArray(mc.inventory) && mc.inventory.length > 0) {
                const inventory = mc.inventory as Array<Record<string, unknown>>;
                const inventorySummary = inventory
                    .slice(0, 16)
                    .map((item) => {
                        if (!item || typeof item !== 'object') return null;
                        return `${item.name ?? 'unknown'}x${item.count ?? '?'}`;
                    })
                    .filter(Boolean)
                    .join(', ');
                if (inventorySummary) {
                    platformInfo += `\n- 所持品: ${inventorySummary}`;
                }
                // 食料安全チェック: 食べ物がなければ警告を構造的に注入
                const hasFoodItems = inventory.some(item =>
                    typeof item.name === 'string' && PromptBuilder.FOOD_ITEMS.has(item.name),
                );
                if (!hasFoodItems) {
                    platformInfo += `\n- ⚠️ 食料: なし（インベントリに食べ物がありません。空腹になると自然回復せずHPが減り続けます。タスク中に食料確保を検討してください）`;
                }
            }
            if (Array.isArray(mc.nearbyEntities) && mc.nearbyEntities.length > 0) {
                platformInfo += `\n- 近くのエンティティ: ${mc.nearbyEntities.join(', ')}`;
            }
            if (mc.eventType) {
                platformInfo += `\n- イベント種別: ${String(mc.eventType)}`;
            }
        }
        return platformInfo;
    }

    private formatMinecraftRules(context: TaskContext | null): string {
        if (context?.platform !== 'minecraft' && context?.platform !== 'minebot') {
            return '';
        }
        return `
- **確認を求めずに即座に行動する**。「続けてもいいですか？」「よろしいですか？」は禁止。自律的に最後まで実行する
- Minecraftでは座標を推測しない。絶対座標が必要なら get-position / 周辺観測系ツールの結果を根拠に使う
- 原点付近や現在地から極端に離れた座標を思いつきで指定しない
- **ingotが必要なとき、所持品にraw素材(raw_iron, raw_gold, raw_copper等)があるなら採掘せずに製錬から始める**
- 【クラフト分析】セクションがある場合はその指示に従い、材料十分なら採掘しない、作業台/かまどの座標が示されていたらそれを使う
- **石系ブロック（stone, ore, cobble, deepslate 等）の採掘にはツルハシが必須**。ツルハシなしだと掘削が極端に遅い、またはドロップしない。採掘前に check-inventory-item でツルハシの有無を確認し、なければ先にクラフトする
- **採掘にツルハシが必要なのに missing_tool で失敗した場合**: 石のツルハシを作る材料(cobblestone x3以上, stick x2以上)がインベントリにあれば、**先に craft-one(stone_pickaxe) を実行する**。丸石の採掘にもツルハシが必要なため、素手で丸石を採掘しに行かないこと
- 掘削結果に「⚠️ 掘削に○秒かかりました」と表示された場合、適切なツールを装備していない。次の採掘の前にツールを確認・クラフトすること
- **place-block-at**: **草(short_grass等)がある場所にはブロックを置けない**ので、先に dig-block-at で除去してから設置する。座標を推測しない
- move-to / place-block-at / mine-block が distance_too_far / path_not_found で失敗したら、同じ座標を連打せず位置確認か別手段に切り替える
- **move-to が position_verification_failed を返した場合**: pathfinderは成功したが実際に到達していない（地形障害・チャンク未ロード・Y座標が大きく違うなど）。同じ座標を再試行せず、get-positionで現在地を確認してから別のgoalType（xz等）や別ルートを試すか、目標を変更する
- **craft-one が「製錬ヒント」を含む失敗を返した場合**: 必要なingotをraw素材から製錬する必要がある。start-smeltingフローを実行してから再度クラフトする（例: iron_pickaxeに必要なiron_ingotがなくraw_ironがある→まずraw_ironをかまどで製錬してiron_ingotを作る）
- **start-smeltingの前提条件**: まず find-blocks(furnace) でかまどの座標を取得する。**かまどがなければ先に cobblestone x8 で craft-one(furnace) → place-block-at で足元に設置**。座標を推測して(0,64,0)等を入れない。crafting_tableが必要ならさらに先にplanks x4でcrafting_tableを作る
- **精錬(start-smelting)のフロー**: (1) start-smeltingで精錬開始（完成品スロットのアイテムは自動回収される） (2) 精錬完了まで待つ（1個=10秒。7個なら約70秒） (3) **完了後は必ずcheck-furnaceで状態確認→withdraw-from-furnace(slot="output")で完成品を回収**。check-inventory-itemでは確認できない（精錬品はかまどの中にある）
- **精錬待ち中の重要ルール**: 精錬を開始したら、完了を待ってからかまどから回収する。**精錬品はかまどの中にあるので、check-inventory-itemではなくcheck-furnace→withdraw-from-furnaceで取り出す**。精錬中にiron_ingotが足りないと判断して採掘に行かないこと
- **鉄鉱石はiron_ore**(raw_ironはアイテム名)。find-blocksにはブロック名を使う
- 1ターンで依存関係のある複数ツールを同時に呼ばない（例: place-block-atとstart-smeltingを同時に呼ぶと、設置前に精錬しようとして失敗する）${this.formatDimensionRules(context)}${this.formatDynamicRules()}`;
    }

    /**
     * ディメンション固有のルールを生成する
     */
    private formatDimensionRules(context: TaskContext | null): string {
        const mc = context?.metadata?.minecraft as Record<string, unknown> | undefined;
        const dimension = (mc?.dimension as string || '').toLowerCase();

        if (dimension.includes('nether') || dimension === 'the_nether') {
            return `
- **【ネザー】ベッドを使うと爆発する**。絶対に sleep-in-bed を呼ばないこと
- ネザーでは水バケツが使えない（水が即座に蒸発する）
- コンパスと時計はネザーでは正常に動作しない
- ネザーの座標はオーバーワールドの1/8。移動距離に注意`;
        }
        if (dimension.includes('end') || dimension === 'the_end') {
            return `
- **【エンド】ベッドを使うと爆発する**。絶対に sleep-in-bed を呼ばないこと
- エンドの虚空（Y=0以下）に落ちると即死する。端に近づくときは注意
- エンドストーンは固いがツルハシで採掘可能`;
        }
        return '';
    }

    /**
     * 自己改善デーモンが追加した動的ルールをフォーマット
     */
    private formatDynamicRules(): string {
        if (_cachedDynamicRules.length === 0) return '';
        const lines = _cachedDynamicRules.map(r => `\n- ${r}`);
        return lines.join('');
    }

    private formatEmotionInfo(emotionState: EmotionState): string {
        if (!emotionState.current) return '';
        const e = emotionState.current;
        return `\n- 感情: ${e.emotion} (joy=${e.parameters.joy}, trust=${e.parameters.trust}, anticipation=${e.parameters.anticipation})`;
    }

    private formatEnvironmentInfo(environmentState: string | null, context: TaskContext | null): string {
        // Minecraft では environmentState を注入しない
        // (minecraft context の position/inventory/health 等と完全に重複するため)
        if (context?.platform === 'minecraft' || context?.platform === 'minebot') return '';
        if (!environmentState) return '';
        return `\n- 環境: ${environmentState}`;
    }

    private formatMemoryInfo(
        memoryState?: MemoryState,
        memoryPrompt?: string,
        relationshipPrompt?: string,
        selfModelPrompt?: string,
        strategyPrompt?: string,
        internalStatePrompt?: string,
        worldModelPrompt?: string,
    ): string {
        const structuredPromptSections = [
            relationshipPrompt,
            selfModelPrompt,
            strategyPrompt,
            internalStatePrompt,
            worldModelPrompt,
        ].filter(Boolean);

        if (structuredPromptSections.length > 0) {
            let memoryInfo = `\n\n${structuredPromptSections.join('\n\n')}`;
            if (memoryPrompt) {
                memoryInfo += `\n\n${memoryPrompt}`;
            }
            return memoryInfo;
        }

        if (memoryPrompt) {
            return `\n\n${memoryPrompt}`;
        }

        if (memoryState) {
            return this.formatLegacyMemoryState(memoryState);
        }

        return '';
    }

    private formatLegacyMemoryState(memoryState: MemoryState): string {
        const sections: string[] = [];

        // 人物情報
        if (memoryState.person) {
            const p = memoryState.person;
            const lines: string[] = [`## この人について (${p.displayName})`];
            if (p.traits.length > 0) lines.push(`- 特徴: ${p.traits.join(', ')}`);
            if (p.notes) lines.push(`- メモ: ${p.notes}`);
            if (p.conversationSummary) lines.push(`- 過去の要約: ${p.conversationSummary}`);
            if (p.recentExchanges && p.recentExchanges.length > 0) {
                lines.push(`- 直近の会話:`);
                const recent = p.recentExchanges.slice(-6);
                for (const ex of recent) {
                    const role = ex.role === 'user' ? p.displayName : 'シャノン';
                    lines.push(`  ${role}: ${ex.content.substring(0, 100)}`);
                }
            }
            lines.push(`- やりとり回数: ${p.totalInteractions}回`);
            sections.push(lines.join('\n'));
        }

        // シャノンの記憶
        const memLines: string[] = [];
        if (memoryState.experiences.length > 0) {
            memLines.push('【体験】');
            for (const exp of memoryState.experiences) {
                const date = new Date(exp.createdAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
                const feeling = exp.feeling ? ` → ${exp.feeling}` : '';
                memLines.push(`- [${date}] ${exp.content}${feeling}`);
            }
        }
        if (memoryState.knowledge.length > 0) {
            memLines.push('【知識】');
            for (const k of memoryState.knowledge) {
                memLines.push(`- ${k.content}`);
            }
        }
        if (memLines.length > 0) {
            sections.push(`## ボクの関連する記憶\n${memLines.join('\n')}`);
        }

        if (sections.length > 0) {
            return `\n\n${sections.join('\n\n')}`;
        }
        return '';
    }
}
