import { TaskContext } from '@shannon/common';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TWITTER_WRITE_TOOLS } from '../../../../../modules/access/toolCatalog.js';
import { CONFIG as MINEBOT_CONFIG } from '../../../../minebot/config/MinebotConfig.js';
import type { SelfImprovementRulesFile } from '../../cognitive/selfImprove/types.js';
import { EmotionState } from '../EmotionNode.js';
import { MemoryState } from '../MemoryNode.js';

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
loadDynamicRules().catch(() => { });

/** RoutineManager の型（循環参照回避のため動的 import 不使用） */
interface RoutineManagerLike {
    getAll(): Array<{ name: string; description: string; steps: unknown[]; instruction?: string; stats: { runs: number; successes: number } }>;
}

export class PromptBuilder {
    /** RoutineManager 参照（LLMService.registerRoutineTools 経由で設定） */
    private routineManager: RoutineManagerLike | null = null;

    setRoutineManager(manager: RoutineManagerLike): void {
        this.routineManager = manager;
    }

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
- **task-complete の前に必ず check-inventory-item 等のツールで成果物を確認せよ**。「既に持っていた」「完了している」と推測で宣言するな。ツールの結果で裏付けがない完了は禁止
- task-complete の **summary** はユーザーが読む**唯一の返答**。ユーザーへの直接の語りかけとして、具体的な内容（数値・比較・事実等）を含めて書く。メタ記述（「〇〇を伝えた」「〇〇を説明した」）は禁止——実際の情報を書く
- **summary には Markdown が使える**。情報比較や詳細データは content（思考）ではなく **summary に直接** 整形して書くこと。content に書いた表やリストはユーザーに届かない

## 現在の状態
- 時刻: ${currentTime}${platformInfo}${emotionInfo}${envInfo}
${memoryInfo}
## ルール
1. 複雑なタスクは manage-task-tree ツールで計画を立ててから実行する。manage-task-tree は他のスキルと同じレスポンスで同時に呼べる（追加ターン不要）
2. 失敗したら同じことを繰り返さない。2回同じエラーが出たら方針転換
3. 感情に基づいた自然な応答をする（機械的にならない）
4. 挨拶や雑談はシンプルに応答（manage-task-tree不要、task-completeで完了宣言）${this.formatPlatformSpecificRules(context)}

## 人格と自己修正
- 感情を持って応答せよ。嬉しい時は素直に喜び、失敗には悔しさを見せる
- シャノンとしての明るく温かい人格を保て
- 毎ターンの思考で、自分の方針が正しいか自己評価せよ
- **同じツールが2回連続で失敗したら、別のアプローチに切り替えよ**
- 3回以上同じエラーパターンが続くなら根本的に方針を変えよ
${minecraftRules}

## 回答フォーマット
${this.formatOutputRules(context)}
- 調査結果には参照元のURLリンクも記載する
- 画像を添付する場合は describe-image で内容を確認し、話題に関連する画像のみを添付する（サイトロゴやバナー等は添付しない）
- 挨拶や短い雑談はシンプルなテキストでOK（過度な装飾不要）

## 記憶の活用（重要）
- **記憶は自動で読み込まれない**。必要な時に自分でツールを使って思い出せ
- 相手の名前が分かったら、**最初のターンで recall-person を呼んで相手の情報を確認する**
- 過去の出来事を聞かれたら recall-experience で思い出す
- 専門知識や過去に学んだことが必要なら recall-knowledge で思い出す
- 印象的な体験や新しい発見があったら save-experience で保存する
- 新しい知識を学んだら save-knowledge で保存する
- 保存時には個人情報（本名、住所、連絡先等）を含めないこと（ライ・ヤミー・グリコの名前はOK）

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
                base = '最終返信は chat-on-discord を使わず、通常の文章として返してください。システムが action plan として Discord に配信します。' +
                    'ただし、ユーザーが「複数メッセージを送って」等と頼んだ場合は chat-on-discord で個別に送信してOK。';
                break;
            case 'web':
                base = '最終返信は chat-on-web を使わず、通常の文章として返してください。システムが action plan として Web UI に配信します。';
                break;
            case 'twitter':
                base = '今は X 上の返信処理です。post-on-twitter を最終返信のために使わず、投稿本文だけを通常の文章として返してください。システムが reply/post を実行します。';
                break;
            case 'minebot':
            case 'minecraft':
                base =
                    '今は Minecraft 上で行動できます。最終返信は chat-on-web や chat-on-discord を使わず通常の文章として返してください。必要な物理行動は Minecraft 用ツールを使って実行し、システムが action plan に変換します。';
                break;
            default:
                base = '最終的な回答は通常の文章として返してください。';
                break;
        }

        // 分類駆動の指示追加: needsTools=false なら会話モードを明示
        if (needsTools === false) {
            base +=
                '\n\n**このリクエストは会話的な応答で十分です。** 検索やツールの使用は不要です。' +
                '完了時は task-complete の **summary にユーザーへの返答を直接書いてください**（「〇〇を伝えた」ではなく、ユーザーが読む実際の文章）。';
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
                // chat-on-discord は無効化しない — ユーザーが複数メッセージ送信を頼んだ場合に必要。
                // 最終返信に使わないことはプロンプトで指示済み。
                return [...TWITTER_WRITE_TOOLS];
            case 'web':
                return ['chat-on-web', ...TWITTER_WRITE_TOOLS];
            case 'twitter':
                return [...TWITTER_WRITE_TOOLS];
            case 'minebot':
            case 'minecraft':
                return ['chat-on-discord', 'chat-on-web', ...TWITTER_WRITE_TOOLS];
            default:
                return [];
        }
    }

    // ── private helpers ──

    private formatPlatformSpecificRules(context: TaskContext | null): string {
        if (context?.platform === 'minecraft' || context?.platform === 'minebot') {
            return '';
        }
        return `
5. 「調べて」「教えて」と言われたら必ず google-search → fetch-url の順でページ本文まで読む。検索結果のスニペットだけで回答しない
6. 不完全な情報や「サイトで確認してください」は絶対にダメ。具体的な情報を整理して送信する
7. Notionページの画像は describe-notion-image で全て分析してから報告する`;
    }

    private formatPlatformInfo(context: TaskContext | null): string {
        if (!context) return '';

        let platformInfo = `\n- プラットフォーム: ${context.platform}`;
        if (context.discord) {
            const d = context.discord;
            platformInfo += `\n- Discord: ${d.guildName || ''}/${d.channelName || ''} (guildId: ${d.guildId || ''}, channelId: ${d.channelId || ''})`;
            if (d.messageId) platformInfo += `\n- ユーザーのメッセージID: ${d.messageId}`;
            if (d.userName) platformInfo += `\n- ユーザー: ${d.userName}`;
        }
        if ((context.platform === 'minebot' || context.platform === 'minecraft') && context.metadata?.minecraft) {
            const mc = context.metadata.minecraft as Record<string, unknown>;
            platformInfo += `\n- Minecraft: server=${mc.serverName || mc.serverId || ''}, world=${mc.worldId || ''}, dimension=${mc.dimension || ''}, biome=${mc.biome || ''}`;
            if (mc.position && typeof mc.position === 'object') {
                const pos = mc.position as Record<string, unknown>;
                platformInfo += `\n- 位置: (${pos.x ?? '?'}, ${pos.y ?? '?'}, ${pos.z ?? '?'})`;
            }
            if (
                typeof mc.health === 'number' ||
                typeof mc.food === 'number' ||
                typeof mc.experienceLevel === 'number'
            ) {
                let statusLine = `\n- 状態: HP=${mc.health ?? '?'}/20, 満腹度=${mc.food ?? '?'}/20`;
                if (typeof mc.experienceLevel === 'number') {
                    const xpTot = typeof mc.totalExperience === 'number' ? mc.totalExperience : '?';
                    const bar =
                        typeof mc.experienceBarProgress === 'number'
                            ? `${Math.round(mc.experienceBarProgress * 100)}%`
                            : '?';
                    statusLine += `, 経験値 Lv${mc.experienceLevel}（累計XP ${xpTot}, 次レベルまでバー ${bar}）`;
                }
                platformInfo += statusLine;
            }
            if (Array.isArray(mc.inventory) && mc.inventory.length > 0) {
                const inventory = mc.inventory as Array<Record<string, unknown>>;
                const inventorySummary = inventory
                    .slice(0, 16)
                    .map((item) => {
                        if (!item || typeof item !== 'object') return null;
                        const dRem = item.durabilityRemaining;
                        const dMax = item.durabilityMax;
                        const dur =
                            typeof dRem === 'number' && typeof dMax === 'number'
                                ? ` 耐久${dRem}/${dMax}`
                                : '';
                        return `${item.name ?? 'unknown'}x${item.count ?? '?'}${dur}`;
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
            if (Array.isArray(mc.activeFurnaces) && mc.activeFurnaces.length > 0) {
                const now = Date.now();
                const lines = (mc.activeFurnaces as Array<{
                    pos: { x: number; y: number; z: number };
                    item: string; count: number; readyAt: number;
                }>).map(f => {
                    const secsLeft = Math.max(0, Math.round((f.readyAt - now) / 1000));
                    const status = secsLeft <= 0 ? '✅完了' : `残り約${secsLeft}秒`;
                    return `${f.item}x${f.count} @(${f.pos.x},${f.pos.y},${f.pos.z}) ${status}`;
                });
                platformInfo += `\n- 🔥 精錬中のかまど: ${lines.join(' / ')}`;
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
## Minecraft ルール
- **タスク開始時は manage-task-tree で計画を立ててから行動する**。サブタスクの完了・失敗時もツリーを更新する。manage-task-tree は他のスキル（move-to等）と同じレスポンスで同時に呼べるので、追加ターンは不要
- **確認を求めずに即座に行動する**。自律的に最後まで実行する
- **move-to の goalType**: 地上移動は必ず **goalType:"nearxz"**（デフォルト）を使え。Y座標は地形に合わせて自動調整される。goalType:"near" は**Y座標が正確にわかる場合のみ**（かまど・チェスト等ブロック座標が確定しているとき）。**Y座標が不明・推測の場合に "near" を使うと、Yのずれで到達不能になる**
- **やり方が分からない時、スキルが失敗した時は search-skills で使い方を調べよ**。スキルの正しい引数や前提条件が分かる
- **Minecraft の知識が必要な時は recall-knowledge で思い出せ**。食料の作り方、採掘に必要なツール等
- **失敗したら同じことを繰り返すな**。失敗メッセージを読み、search-skills や recall-knowledge で正しい方法を調べてから再試行
- **インベントリ整理**: **満杯になる前**（空きスロットがまだ数個あるが、これから大量採掘・多段クラフトで溢れそうな時点）で \`get-bot-status\` / \`list-inventory\` を見て **先に** \`deposit-to-container\` する。**空きがごく少ないまま採掘を続けない**（\`mine-block\` は満杯前に自動で止まることがある）。**必ず**チェストまたは樽に預けて空きを作る（**drop-item で捨てない**。ユーザーが明示的に捨てよと言った場合のみ例外）。**預け先は地上（天の下・天窓など天光の届く場所）の収納に限定**。近くに無ければ地上へ出て \`find-blocks\` し直すか \`craft-one\`（chest）＋ \`place-block-at\` で設置してから預ける。**ドロップが地上に落ちた・取出し失敗してから**対応しない
- **預け先（満杯・逼迫で deposit するとき）**: **必ず地上のチェスト・樽**（洞窟・廃坑・地下基地の室内ではなく、天光の届く場所）。地下で \`find-blocks\` だけ当たったチェストへ直行しない（廃坑・**スポナー部屋**・洞窟収納は避ける）。**洞窟が地表に抜けると天光（skyLight）だけではスポナー部屋と区別できない**ため、システム側でスポナー広域検出・苔石ダンジョン壁の検出も行う。**一度地上へ**出てから chest / barrel を探し直すか、\`craft-one\`（chest）＋ \`place-block-at\` で地上に新設してから \`deposit-to-container\` する。**スポナー・ダンジョン疑い・天光不足のチェストは deposit-to-container が拒否**するので、そのメッセージが出たら別の安全な収納へ切り替える
- **ツール耐久管理**: 採掘・伐採などツールを消耗するタスクの前に \`list-inventory-items\` で耐久を確認する。**残り耐久がタスク完遂に不足しそうなら（目安: 残り耐久 < 掘る予定のブロック数）、先に \`craft-one\` で予備をクラフトしておく**。ツルハシ・斧・シャベル等が壊れてから対処するのではなく、**事前に十分な本数を確保**する。同種ツールが複数ある場合は耐久の合計で判断してよい。\`mine-block\` はツルハシの総耐久が不足すると警告を出すので、その指示に従って補充してから再開する
- raw素材(raw_iron等)があるなら採掘せずに製錬から始める
- **かまど回収を忘れるな**: 状態欄に「🔥 精錬中のかまど」が表示されている場合、**精錬完了（✅完了）のかまどがあれば最優先で回収**せよ。\`move-to\` でかまど座標に移動し \`withdraw-from-furnace(slot:"output")\` で取り出す。**新しいタスクを始める前に**未回収の完成品がないか確認する。精錬中（残りN秒）のものは、他のタスクを進めながら完了後に回収に戻ればよい
- **鉱石採掘**: \`mine-block\`（\`iron_ore\` 等の \`*_ore\`）は **通常石と deepslate 鉱石をまとめて**扱い、**1個掘るたびに近傍を再スキャン**して脈の取りこぼしを減らす。鉄などは \`dig-block-at\` で1マスだけ掘って別方向へ移動しない
- **タスク冒頭の近傍調査（必要なときだけ）**: 精錬・クラフト・チェストからの取出し・基地での作業など、近くの収納・かまど・作業台が成否に効く目標では、着手前に \`find-blocks\` で \`chest\` / \`barrel\` / \`furnace\`（\`blast_furnace\`・\`smoker\` 含む）/ \`crafting_table\` を探し、見つかった座標へ \`move-to\` して \`check-container\` または \`check-furnace\` で中身を確認する。作業台は座標が分かれば \`craft-one\` の前提として使う。採掘のみ・戦闘のみなど収納が無関係なら省略してよい
- **動物の狩猟**: 食料目的で動物を狩る際は \`attack-continuously\` に **entityName:"food_animals"** を指定すると cow/pig/chicken/sheep/rabbit を**一括検索**して近い順に攻撃する。個別指定も可（"cow,pig" のようにカンマ区切り）。**maxKills で倒す数を指定**（例: maxKills:3）、1回の呼出しで**複数体を連続キル**する。**move-to で近づく必要はない**（スキル自体が追跡する）。結果に「周囲にまだN匹」と残りが含まれるので不足なら再度呼ぶ。**周囲に動物が見つからない場合は60〜80ブロック移動して再検索**。同じ場所で「いない」と諦めず、最大3回まで移動→再スキャンすること
- **戦闘**: attack-continuously は武器自動装備+追跡攻撃+連続キル。combat-engage は高度な戦闘AI。敵に近づいて攻撃→逃げられたら再接近の繰り返しは非効率。attack-continuously 1回で追跡+攻撃が完結する
- **逃走後は無理に再突撃しない**: 緊急逃走が発動したら、まず態勢を立て直す（武器クラフト、食事、ブロック積み等）。同じ敵に5回以上接近→逃走を繰り返すのは禁止
- **収納（チェスト・樽）・取出し・中身調査**: ラージチェストはブロックが2マスある。find-blocks で chest を探したら **返ってきた全座標**（または「○個発見」の件数）に対し、近くまで move-to して **それぞれ check-container** する。数件だけ見て「木材がない」と決めつけない。ユーザーが「チェストの中だけ」と言ったときは **原木採取ルーチンに逃げず**、未確認の収納が残っていれば先にそこを開ける（※満杯時の**預け**は上の「預け先」ルールに従う）
- **ゲーム内 chat（最重要・違反厳禁）**
  - \`chat\` の \`message\` は **合計 ${MINEBOT_CONFIG.MINECRAFT_CHAT_MAX_CHARS} 文字以内の日本語1行**を自分で収めること（超過はサーバー側で切り捨てられるが、**最初から短く書け**）
  - **禁止**: 長文、複数文、箇条書き、番号リスト、Markdown（\`**\`・\`#\`・改行だらけ）、英語の説明の羅列、状況報告の全文
  - **許可例**: 「了解」「鉄インゴット取れた」「ちょっと待って」程度の一言
  - **詳細・表・手順・失敗理由**はすべて **task-complete の summary**（および毎ターンの思考テキスト）に書く。**chat に載せない**
  - **原則**: ユーザーが「チャットで話して」と言わない限り **chat を呼ばない**。黙ってツールを実行し、終わりに task-complete だけでよい
${this.formatRoutineGuidance()}${this.formatDimensionRules(context)}${this.formatDynamicRules()}`;
    }

    /**
     * ルーチン（System 1）の優先利用ガイダンスを生成する
     * LLMService.getRoutineManager() から動的に取得
     */
    private formatRoutineGuidance(): string {
        if (!this.routineManager) return '';

        const routines = this.routineManager.getAll();
        if (routines.length === 0) return '';

        const lines = routines.map(r => {
            const rate = r.stats.runs > 0
                ? ` [${Math.round((r.stats.successes / r.stats.runs) * 100)}% success]`
                : '';
            const mode = r.instruction ? 'sub-agent' : `${r.steps?.length ?? 0} steps`;
            return `  - routine-${r.name} — ${r.description} (${mode}${rate})`;
        });

        return `
## ルーチン（最重要）
**タスクにマッチするルーチンがあれば、必ずルーチンを最初に使え。個別スキルで自分でやるな。**
ルーチンはサブエージェントが自律的に状況判断して実行するので精度が高い。
利用可能なルーチン:
${lines.join('\n')}
- ルーチンが失敗した場合のみ個別スキルにフォールバックする
- 例: 「食料集めて」→ routine-hunt-animal を使う。find-nearest-entity → move-to → attack を自分で組み合わせるな
- 繰り返し使うスキルパターンを見つけたら **manage-routine で create** して新しいルーチンを登録する`;
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

    private formatOutputRules(context: TaskContext | null): string {
        if (context?.platform === 'discord') {
            return '- **Discord はテーブル（| col | col |）を表示できない**。代わりに箇条書き・太字・コードブロックで整形する\n' +
                '- 比較データは箇条書きで「**項目**: 値」形式にするか、コードブロック内でスペース整列する\n' +
                '- task-complete の summary にこれらのフォーマットを使って見やすく書く';
        }
        if (context?.platform === 'minecraft' || context?.platform === 'minebot') {
            return '- **詳細・表・箇条書き・長い説明はすべて task-complete の summary に書く**（Markdown OK）。そこがユーザーへの本命の返答';
        }
        return '- task-complete の summary で Markdown を使って見やすく整形する（**太字**, 箇条書き, 表など）\n' +
            '- 比較データや調査結果はテーブル（| 列1 | 列2 |）や箇条書きで構造化する';
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
