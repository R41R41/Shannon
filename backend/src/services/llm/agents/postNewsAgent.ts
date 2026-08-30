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
    web: async (query, signal) => String(await web.invoke({ query }, { signal })),
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
      maxToolCalls: 10,
      fallbackText: `今日${jstDateLabel(jstToday())}のAIニュース、うまく見つけられなかった…また明日チェックするね`,
      reviewHuman: '以下のAIニュースツイート案を審査してください。JSON形式で結果を返してください。\n\nツイート:',
      userPrompt: today => [
        `# 今日の日付`,
        today,
        '',
        'まず Google 検索で今日の最新 AI ニュースを調べてください。',
        '注目度の高い1件を選び、Wikipedia や追加検索で背景を深掘りしてください。',
        '十分に調べたら submit_post でツイートを提出してください。投稿そのものはしない。',
      ].join('\n'),
    }, ports);
  }

  public async createPost(signal?: AbortSignal): Promise<NewsOutput> {
    return runScheduledPost(this.spec, this.ports, signal);
  }
}
