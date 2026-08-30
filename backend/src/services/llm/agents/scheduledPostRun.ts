import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { FcaError, runFcaLoop } from '../../../modules/fca/index.js';
import { config } from '../../../config/env.js';
import { models } from '../../../config/models.js';
import { createOpenAiFcaModel } from '../../fca/openAiFcaModel.js';
import { createTracedModel } from '../utils/langfuse.js';
import { logger } from '../../../utils/logger.js';
import { scheduledPostTools, type ScheduledPostDraft, type ScheduledPostSearchPorts } from './scheduledPostSkills.js';

const JST = 'Asia/Tokyo';
const MAX_REVIEW_RETRIES = 3;

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
}

export function jstToday(): string {
  return format(toZonedTime(new Date(), JST), 'yyyy-MM-dd');
}

export function jstDateLabel(today: string): string {
  const [, month, day] = today.split('-');
  return `${Number(month)}月${Number(day)}日`;
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
  });
  const user = [spec.userPrompt(today), feedback ? `\n# 前回のフィードバック\n${feedback}` : ''].filter(Boolean).join('\n');
  try {
    const result = await runFcaLoop({
      system: spec.systemPrompt,
      messages: [{ role: 'user', content: user }],
      tools: scheduledPostTools(ports),
      model,
      signal,
      limits: { maxTurns: 12, maxToolCalls: spec.maxToolCalls, maxToolCallsPerTurn: 2, maxElapsedMs: 90000 },
      policy: { kind: 'terminal-tool', name: 'submit_post', drain: 'until-terminal' },
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
    logger.error(`${spec.logLabel} 探索エラー: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function review(spec: ScheduledPostSpec, draft: string): Promise<ScheduledPostReview> {
  const model = createTracedModel({ modelName: models.autoTweet, temperature: 0 });
  try {
    const response = await model.invoke([
      new SystemMessage(spec.reviewPrompt),
      new HumanMessage(`${spec.reviewHuman}\n\n${draft}`),
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
      feedback = '前回は調査に失敗した。別の題材をもっと詳しく調べて。';
      continue;
    }
    logger.info(`${spec.logLabel} ドラフト: "${draft.text.slice(0, 80)}..."`, 'cyan');
    const judged = await review(spec, draft.text);
    if (judged.approved) {
      logger.info(`${spec.logLabel} レビュー合格`, 'green');
      return { text: `${spec.header}\n${draft.text}`, imagePrompt: draft.imagePrompt };
    }
    logger.warn(`${spec.logLabel} レビュー不合格: ${judged.issues.join(', ')}`);
    feedback = [
      `前回の投稿「${draft.text.slice(0, 100)}...」は以下の理由で不合格:`,
      ...judged.issues.map(issue => `- ${issue}`),
      judged.suggestion ? `提案: ${judged.suggestion}` : '',
      '別のアプローチでもう一度書いてください。',
    ].join('\n');
  }
  logger.warn(`${spec.logLabel} 3回リトライ失敗、フォールバック`);
  const fallback = await explore(spec, ports, today, undefined, signal);
  return { text: `${spec.header}\n${fallback?.text || spec.fallbackText}`, imagePrompt: fallback?.imagePrompt };
}
