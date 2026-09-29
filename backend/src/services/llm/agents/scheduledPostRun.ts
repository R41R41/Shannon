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
  SCHEDULED_POST_TEXT_MAX,
  type ScheduledPostDraft,
  type ScheduledPostSearchPorts,
  type ScheduledPostToolBudgets,
} from './scheduledPostSkills.js';

const JST = 'Asia/Tokyo';
const MAX_REVIEW_RETRIES = 3;
const DEFAULT_TOOL_BUDGETS: ScheduledPostToolBudgets = { maxWebCalls: 10, maxWikiCalls: 5 };

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
      `今日は ${today}（${dateText}）です。google-search（dateRestrict=d1）で今日のニュースを再調査し、事実関係を裏取りしてください。NGトピックが理由なら、条件を満たす別の題材を選んでください。`,
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
  const model = createOpenAiFcaModel({
    apiKey: config.openaiApiKey,
    model: models.autoTweet,
    maxTokens: 1200,
    temperature: spec.temperature,
    timeoutMs: 45000,
    requireSingleTool: 'submit_post',
  });
  const user = [spec.userPrompt(today), feedback ? `\n# 前回のフィードバック\n${feedback}` : ''].filter(Boolean).join('\n');
  const budgets = resolvedToolBudgets(spec);
  const used = new Map<string, number>();
  let calls = 0;
  let activeNames = new Set<string>();
  const tools = scheduledPostTools(ports, budgets).map(tool => ({
    ...tool,
    async execute(args: unknown, toolSignal: Parameters<typeof tool.execute>[1]) {
      calls += 1;
      used.set(tool.name, (used.get(tool.name) ?? 0) + 1);
      return tool.execute(args, toolSignal);
    },
  }));
  try {
    const result = await runFcaLoop({
      system: spec.systemPrompt,
      messages: [{ role: 'user', content: user }],
      tools,
      model,
      signal,
      limits: {
        maxTurns: 14,
        maxToolCalls: spec.maxToolCalls,
        maxToolCallsPerTurn: 2,
        maxElapsedMs: 90000,
      },
      policy: { kind: 'terminal-tool', name: 'submit_post', drain: 'until-terminal' },
      hooks: {
        beforeModel: ({ turn, elapsedMs }) => {
          // Reserve room for submission and one length/format correction. Keep
          // all collected search results in the same session when a cap is hit.
          const submitOnly = calls >= spec.maxToolCalls - 2 || turn >= 13 || elapsedMs >= 60000;
          const active = tools.filter(tool => tool.name === 'submit_post' || (!submitOnly && (
            tool.name === 'google-search'
              ? (used.get(tool.name) ?? 0) < (budgets.maxWebCalls ?? 10)
              : (used.get(tool.name) ?? 0) < (budgets.maxWikiCalls ?? 5)
          )));
          activeNames = new Set(active.map(tool => tool.name));
          return {
            tools: active,
            ephemeral: [{ role: 'user' as const, content: active.length === 1
              ? `検索枠は終了しました。既に取得した情報だけを使い、本文（最大${SCHEDULED_POST_TEXT_MAX}文字）とimagePromptをsubmit_postで提出してください。確認できない事実は作らないでください。`
              : `調査後は本文（最大${SCHEDULED_POST_TEXT_MAX}文字）とimagePromptをsubmit_postで提出してください。本文だけ返して終了しないでください。` }],
          };
        },
        planCalls: toolCalls => ({
          execute: toolCalls.filter(call => activeNames.has(call.name) || !tools.some(tool => tool.name === call.name)),
          synthetic: toolCalls.filter(call => !activeNames.has(call.name) && tools.some(tool => tool.name === call.name))
            .map(call => ({ call, content: '検索上限です。収集済みの情報を使ってsubmit_postで提出してください。' })),
        }),
        onTextOnly: () => 'continue',
      },
    });
    const value = result.value as ScheduledPostDraft | undefined;
    if (value && typeof value.text === 'string' && value.text.trim()) return value;
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
  return { text: `${spec.header}\n${spec.fallbackText}` };
}
