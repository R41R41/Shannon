import { loadPrompt } from '../config/prompts.js';
import GoogleSearchTool from '../tools/search/googleSearch.js';
import SearchByWikipediaTool from '../tools/search/searchByWikipedia.js';
import { jstDateLabel, jstToday, runScheduledPost, type ScheduledPostSpec } from './scheduledPostRun.js';
import type { ScheduledPostSearchPorts } from './scheduledPostSkills.js';

export interface NewsOutput {
  text: string;
  imagePrompt?: string;
}

function defaultPorts(): ScheduledPostSearchPorts {
  const web = new GoogleSearchTool();
  const wikipedia = new SearchByWikipediaTool();
  return {
    web: async (input, signal) => String(await web.invoke({
      query: input.query,
      ...(input.dateRestrict ? { dateRestrict: input.dateRestrict } : {}),
      ...(input.gl ? { gl: input.gl } : {}),
      ...(input.lr ? { lr: input.lr } : {}),
      ...(input.num ? { num: input.num } : {}),
    }, { signal })),
    wikipedia: async (query, signal) => String(await wikipedia.invoke({ query, lang: 'ja', summary: true }, { signal })),
  };
}

export class PostNewsAgent {
  private constructor(private readonly spec: ScheduledPostSpec, private readonly ports: ScheduledPostSearchPorts) {}

  public static async create(ports: ScheduledPostSearchPorts = defaultPorts()): Promise<PostNewsAgent> {
    const systemPrompt = await loadPrompt('news_today');
    const reviewPrompt = await loadPrompt('news_today_review');
    if (!systemPrompt || !reviewPrompt) throw new Error('Failed to load news_today prompt');
    return new PostNewsAgent({
      kind: 'news',
      systemPrompt,
      reviewPrompt,
      header: '【今日のAIニュース】',
      logLabel: '[News]',
      temperature: 0.7,
      maxToolCalls: 16,
      toolBudgets: { maxWebCalls: 10, maxWikiCalls: 5 },
      fallbackText: `今日${jstDateLabel(jstToday())}のAIニュース、うまく見つけられなかった…また明日チェックするね`,
      reviewHuman: '以下のAIニュースツイート案を審査してください。JSON形式で結果を返してください。\n\nツイート:',
      userPrompt: today => [
        `# 今日の日付`,
        today,
        '',
        'まず google-search で今日の最新 AI ニュースを調べてください。',
        '最初の検索では dateRestrict=d1, gl=jp, lr=lang_ja を必ず使ってください（例: query="AI ニュース"）。',
        '注目度の高い1件を選び、Wikipedia または追加 google-search で背景を深掘りしてください（追加検索は合計2回まで）。',
        '十分に調べたら submit_post でツイート本文と imagePrompt を提出してください。本文だけ返して終了しないでください。',
      ].join('\n'),
    }, ports);
  }

  public async createPost(signal?: AbortSignal): Promise<NewsOutput> {
    return runScheduledPost(this.spec, this.ports, signal);
  }
}
