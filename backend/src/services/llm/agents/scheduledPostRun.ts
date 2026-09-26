import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { FcaError, runFcaLoop } from '../../../modules/fca/index.js';
import { config } from '../../../config/env.js';
import { models } from '../../../config/models.js';
import { createOpenAiFcaModel } from '../../fca/openAiFcaModel.js';
import { createTracedModel } from '../utils/langfuse.js';
import { logger } from '../../../utils/logger.js';
import {
  scheduledPostTools,
  type ScheduledPostDraft,
  type ScheduledPostSearchPorts,
  type ScheduledPostToolBudgets,
} from './scheduledPostSkills.js';

const JST = 'Asia/Tokyo';
const MAX_REVIEW_RETRIES = 3;
const PROSE_DRAFT_MIN = 120;
const PROSE_DRAFT_MAX = 520;
const DEFAULT_TOOL_BUDGETS: ScheduledPostToolBudgets = { maxWebCalls: 10, maxWikiCalls: 5 };
const DEFAULT_MAX_TOOL_CALLS = 16;

/** 検索なし修正で LLM が差し替えやすい、数年前の製品発表 */
const STALE_NEWS_MARKERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /GPT-4\s*Turbo/i, label: 'GPT-4 Turbo' },
  { pattern: /GPT-3\.5/i, label: 'GPT-3.5' },
  { pattern: /ChatGPT\s*の?\s*公開/i, label: 'ChatGPT初期公開' },
  { pattern: /Gemini\s*1\.0/i, label: 'Gemini 1.0' },
];

const POST_META_PATTERNS = [
  /申し訳ありません/,
  /投稿時にエラーが続いています/,
  /画像プロンプトも再送/,
  /^---$/m,
];

export interface ScheduledPostReview {
  approved: boolean;
  issues: string[];
  suggestion: string;
}

export interface ScheduledPostSpec {
  kind: 'news' | 'about_today';
  systemPrompt: string;
  reviewPrompt: string;
  header: string;
  userPrompt: (today: string) => string;
  reviewHuman: string;
  fallbackText: string;
  logLabel: string;
  temperature: number;
  maxToolCalls: number;
  toolBudgets?: ScheduledPostToolBudgets;
}

function resolvedToolBudgets(spec: ScheduledPostSpec): ScheduledPostToolBudgets {
  return spec.toolBudgets ?? DEFAULT_TOOL_BUDGETS;
}

function resolvedMaxToolCalls(spec: ScheduledPostSpec): number {
  return Math.max(spec.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
}

export function jstToday(): string {
  return format(toZonedTime(new Date(), JST), 'yyyy-MM-dd');
}

export function jstDateLabel(today: string): string {
  const [, month, day] = today.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

export function looksLikeStaleNews(text: string): string | null {
  const freshCue = /新たに|最新|本日|今日|発表しました|公開しました|リリース/i;
  if (!freshCue.test(text)) return null;
  for (const { pattern, label } of STALE_NEWS_MARKERS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

export function looksLikePostMetaLeak(text: string): boolean {
  return POST_META_PATTERNS.some(p => p.test(text));
}

function exploreFailureFeedback(spec: ScheduledPostSpec, today: string, attempt: number): string {
  const dateText = jstDateLabel(today);
  if (spec.kind === 'about_today') {
    if (attempt <= 1) {
      return [
        `1回目の google-search では query="${dateText} 何の日", gl=jp, lr=lang_ja で候補を探してください。`,
        '追加の google-search は最大2回、Wikipedia は最大1回までに抑えてください。',
        '調査が足りたら必ず submit_post で本文と imagePrompt を提出してください。本文だけ返して終了しないでください。',
      ].join('\n');
    }
    return [
      '前回は submit_post まで到達しませんでした。',
      '検索はあと1回まで。候補が1つ決まっていれば Wikipedia を省略し submit_post で提出してください。',
    ].join('\n');
  }
  if (attempt <= 1) {
    return [
      '1回目の google-search では dateRestrict=d1, gl=jp, lr=lang_ja を使って今日のAIニュースを探してください。',
      '追加の google-search は最大2回、Wikipedia は最大1回までに抑えてください。',
      '調査が足りたら必ず submit_post で本文と imagePrompt を提出してください。本文だけ返して終了しないでください。',
    ].join('\n');
  }
  return [
    '前回は submit_post まで到達しませんでした。',
    '検索はあと1〜2回まで。十分な情報があれば追加検索せず submit_post で提出してください。',
  ].join('\n');
}

function reviewFailureFeedback(
  spec: ScheduledPostSpec,
  draft: ScheduledPostDraft,
  judged: ScheduledPostReview,
  today: string,
): string {
  const dateText = jstDateLabel(today);
  const lines = [
    `前回の投稿「${draft.text.slice(0, 100)}...」は以下の理由で不合格:`,
    ...judged.issues.map(issue => `- ${issue}`),
    judged.suggestion ? `提案: ${judged.suggestion}` : '',
  ];
  if (spec.kind === 'news') {
    lines.push(
      `今日は ${today}（${dateText}）です。google-search（dateRestrict=d1）で今日のニュースを再調査し、同じトピックを維持してよいので事実関係を裏取りしてください。`,
      '数年前の製品（GPT-4 Turbo 等）を「今日の新発表」として書き換えないでください。',
      '口調・構成だけ直すのではなく、検索結果に基づいて submit_post で提出してください。',
    );
  } else {
    lines.push('別の題材で書き直し、submit_post で提出してください。追加検索は最小限にしてください。');
  }
  return lines.filter(Boolean).join('\n');
}

function isScheduledPostToolBudget(error: unknown): boolean {
  return error instanceof Error && error.message === 'SCHEDULED_POST_TOOL_BUDGET';
}

async function explore(
  spec: ScheduledPostSpec,
  ports: ScheduledPostSearchPorts,
  today: string,
  feedback: string | undefined,
  signal: AbortSignal,
): Promise<ScheduledPostDraft | null> {
  return runExploreLoop(
    spec,
    ports,
    [{
      role: 'user',
      content: [spec.userPrompt(today), feedback ? `\n# 前回のフィードバック\n${feedback}` : ''].filter(Boolean).join('\n'),
    }],
    signal,
    false,
  );
}

async function runExploreLoop(
  spec: ScheduledPostSpec,
  ports: ScheduledPostSearchPorts,
  messages: Array<{ role: 'user'; content: string }>,
  signal: AbortSignal,
  submitOnly: boolean,
): Promise<ScheduledPostDraft | null> {
  const model = createOpenAiFcaModel({
    apiKey: config.openaiApiKey,
    model: models.autoTweet,
    maxTokens: 1200,
    temperature: spec.temperature,
    timeoutMs: 45000,
  });
  try {
    const result = await runFcaLoop({
      system: spec.systemPrompt,
      messages,
      tools: scheduledPostTools(ports, resolvedToolBudgets(spec), { submitOnly }),
      model,
      signal,
      limits: {
        maxTurns: submitOnly ? 4 : 14,
        maxToolCalls: submitOnly ? 2 : resolvedMaxToolCalls(spec),
        maxToolCallsPerTurn: submitOnly ? 1 : 2,
        maxElapsedMs: submitOnly ? 60000 : 90000,
      },
      policy: { kind: 'terminal-tool', name: 'submit_post', drain: 'until-terminal' },
      hooks: {
        onTextOnly: ({ content }) => {
          const text = content.trim();
          if (text.length >= PROSE_DRAFT_MIN && text.length <= PROSE_DRAFT_MAX) return 'complete';
          return 'continue';
        },
      },
    });
    const value = result.value as ScheduledPostDraft | undefined;
    if (value && typeof value.text === 'string' && value.text.trim()) return value;
    if (result.content.trim()) return { text: result.content.trim() };
    return null;
  } catch (error) {
    if (error instanceof FcaError && (error.code === 'FCA_NO_TERMINAL' || error.code === 'FCA_TOOL_BUDGET')) {
      logger.warn(`${spec.logLabel} 探索未完了: ${error.code}`);
      return null;
    }
    if (isScheduledPostToolBudget(error)) {
      logger.warn(`${spec.logLabel} 探索未完了: SCHEDULED_POST_TOOL_BUDGET`);
      return null;
    }
    logger.error(`${spec.logLabel} 探索エラー: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function review(spec: ScheduledPostSpec, draft: string, today: string): Promise<ScheduledPostReview> {
  const model = createTracedModel({ modelName: models.autoTweet, temperature: 0 });
  const dateContext = spec.kind === 'news'
    ? `今日の日付: ${today}（${jstDateLabel(today)}）。この日付と明らかに矛盾する古い製品発表を「今日のニュース」として紹介していないか確認してください。\n\n`
    : '';
  try {
    const response = await model.invoke([
      new SystemMessage(spec.reviewPrompt),
      new HumanMessage(`${dateContext}${spec.reviewHuman}\n\n${draft}`),
    ]);
    const text = typeof response.content === 'string' ? response.content.trim() : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { approved: true, issues: [], suggestion: '' };
    const parsed = JSON.parse(jsonMatch[0]) as ScheduledPostReview;
    return {
      approved: parsed.approved ?? true,
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
      suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion : '',
    };
  } catch (error) {
    logger.error(`${spec.logLabel} レビューエラー: ${error instanceof Error ? error.message : String(error)}`);
    return { approved: true, issues: [], suggestion: '' };
  }
}

function preReviewReject(spec: ScheduledPostSpec, draft: string): ScheduledPostReview | null {
  if (looksLikePostMetaLeak(draft)) {
    return {
      approved: false,
      issues: ['投稿メタ文（お詫び・画像プロンプト再送など）が本文に混入している'],
      suggestion: '読者向けの本文だけを submit_post で提出してください。',
    };
  }
  if (spec.kind === 'news') {
    const stale = looksLikeStaleNews(draft);
    if (stale) {
      return {
        approved: false,
        issues: [`${stale} は数年前の発表であり、今日の新ニュースとして不適切`],
        suggestion: 'google-search（dateRestrict=d1）で今日のAIニュースを調べ直し、submit_post で提出してください。',
      };
    }
  }
  return null;
}

export async function runScheduledPost(
  spec: ScheduledPostSpec,
  ports: ScheduledPostSearchPorts,
  signal: AbortSignal = AbortSignal.timeout(180000),
): Promise<{ text: string; imagePrompt?: string }> {
  const today = jstToday();
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= MAX_REVIEW_RETRIES; attempt++) {
    logger.info(`${spec.logLabel} 探索+生成 (試行 ${attempt}/${MAX_REVIEW_RETRIES})`, 'cyan');
    const draft = await explore(spec, ports, today, feedback, signal);
    if (!draft) {
      feedback = exploreFailureFeedback(spec, today, attempt);
      continue;
    }
    logger.info(`${spec.logLabel} ドラフト: "${draft.text.slice(0, 80)}..."`, 'cyan');
    const preReject = preReviewReject(spec, draft.text);
    const judged = preReject ?? await review(spec, draft.text, today);
    if (judged.approved) {
      logger.info(`${spec.logLabel} レビュー合格`, 'green');
      return { text: `${spec.header}\n${draft.text}`, imagePrompt: draft.imagePrompt };
    }
    logger.warn(`${spec.logLabel} レビュー不合格: ${judged.issues.join(', ')}`);
    feedback = reviewFailureFeedback(spec, draft, judged, today);
  }
  logger.warn(`${spec.logLabel} 3回リトライ失敗、フォールバック`);
  const fallback = await explore(spec, ports, today, exploreFailureFeedback(spec, today, MAX_REVIEW_RETRIES), signal);
  if (fallback?.text) {
    const fallbackPreReject = preReviewReject(spec, fallback.text);
    const fallbackJudged = fallbackPreReject ?? await review(spec, fallback.text, today);
    if (fallbackJudged.approved) {
      return { text: `${spec.header}\n${fallback.text}`, imagePrompt: fallback.imagePrompt };
    }
    logger.warn(`${spec.logLabel} フォールバック探索稿も不合格: ${fallbackJudged.issues.join(', ')}`);
  }
  return { text: `${spec.header}\n${spec.fallbackText}`, imagePrompt: fallback?.imagePrompt };
}
