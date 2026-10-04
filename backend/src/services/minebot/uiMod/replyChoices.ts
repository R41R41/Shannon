/**
 * 返事待ちのときに ShannonUIMod へ出す「返事の候補」を、シャノン自身（軽いモデル）に作らせる。
 *
 * 候補はプレイヤーが押すと「シャノン、<候補>」としてゲーム内チャットに送られる。
 * 質問と同じくゲーム内チャットに出ている情報（目標・進捗・質問文）だけから作り、記憶には書かない。
 * モデルが失敗・遅延・変な出力をしたときは決まった候補に戻すので、返事待ちの流れは止まらない。
 */

/** モデルが使えないときの候補。続行確認の質問に合わせている */
export const FALLBACK_REPLY_CHOICES: readonly string[] = ['続けて', 'やめて'];

/** 候補の数と長さ。Mod のボタンに収まり、ゲーム内チャットにそのまま送れる長さ */
const MIN_CHOICES = 2;
const MAX_CHOICES = 4;
const MAX_CHOICE_LENGTH = 16;
const DEFAULT_TIMEOUT_MS = 4000;

export interface ReplyChoiceInput {
  /** シャノンがプレイヤーにした質問（ゲーム内チャットに出した文） */
  question: string;
  /** タスクの目標（表示用） */
  goal: string;
  /** これまでの進捗の短い要約 */
  progress?: string;
}

/** system と user を受け取り、モデルの出力テキストを返す */
export type ReplyChoiceModel = (system: string, user: string) => Promise<string>;

const SYSTEM_PROMPT = [
  'あなたはMinecraftでプレイヤーと一緒に遊ぶAI「シャノン」です。',
  'シャノンがプレイヤーにした質問に対して、プレイヤーがボタン一つで返せる返事の候補を作ります。',
  `候補は${MIN_CHOICES}〜${MAX_CHOICES}個。プレイヤーがシャノンに言う言葉として、くだけた日本語で、それぞれ${MAX_CHOICE_LENGTH}文字以内。`,
  '互いに意味が違うものにし、少なくとも一つは「続けて」のような前に進める返事、一つは「やめて」のような止める返事にする。',
  '状況に合わせた具体的な候補（例:「鉄を先に集めて」「家に帰って」）があれば入れる。',
  'JSONの文字列配列だけを出力する。例: ["続けて","いったんやめて","鉄を先に集めて"]',
].join('\n');

function buildUserPrompt(input: ReplyChoiceInput): string {
  const lines = [`質問: ${input.question}`, `目標: ${input.goal}`];
  if (input.progress) lines.push(`進捗: ${input.progress}`);
  return lines.join('\n');
}

/**
 * モデルの出力から候補を取り出して整える。
 * 文字列でないもの・空・長すぎるもの・改行を含むもの・重複を捨て、数が足りなければ null。
 */
export function parseReplyChoices(output: string): string[] | null {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const choices: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/^シャノン[、,]\s*/, '').trim();
    if (!text || text.length > MAX_CHOICE_LENGTH || /[\r\n]/.test(text) || choices.includes(text)) continue;
    choices.push(text);
    if (choices.length === MAX_CHOICES) break;
  }
  return choices.length >= MIN_CHOICES ? choices : null;
}

/** 返事の候補を作る。失敗・タイムアウト・不正な出力のときは FALLBACK_REPLY_CHOICES を返す */
export async function suggestReplyChoices(
  input: ReplyChoiceInput,
  model: ReplyChoiceModel,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const output = await Promise.race([model(SYSTEM_PROMPT, buildUserPrompt(input)), timeout]);
    return (output !== null && parseReplyChoices(output)) || [...FALLBACK_REPLY_CHOICES];
  } catch {
    return [...FALLBACK_REPLY_CHOICES];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
