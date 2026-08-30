import { BaseAgent } from './BaseAgent.js';
import GoogleSearchTool from '../tools/search/googleSearch.js';
import SearchByWikipediaTool from '../tools/search/searchByWikipedia.js';
import { jstDateLabel, runScheduledPost, type ScheduledPostSpec } from './scheduledPostRun.js';
import type { ScheduledPostSearchPorts } from './scheduledPostSkills.js';

export interface AboutTodayOutput {
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

export class PostAboutTodayAgent {
  private constructor(private readonly spec: ScheduledPostSpec, private readonly ports: ScheduledPostSearchPorts) {}

  public static async create(ports: ScheduledPostSearchPorts = defaultPorts()): Promise<PostAboutTodayAgent> {
    const systemPrompt = await BaseAgent.loadPrompt('about_today');
    const reviewPrompt = await BaseAgent.loadPrompt('about_today_review');
    return new PostAboutTodayAgent({
      kind: 'about_today',
      systemPrompt,
      reviewPrompt,
      header: '【今日は何の日？】',
      logLabel: '[AboutToday]',
      temperature: 0.8,
      maxToolCalls: 8,
      fallbackText: '今日も何かの記念日かも…調べてみたけどうまく見つけられなかった',
      reviewHuman: '以下の「今日は何の日」ツイート案を審査してください。JSON形式で結果を返してください。\n\nツイート:',
      userPrompt: today => {
        const dateText = jstDateLabel(today);
        return [
          `# 今日の日付`,
          `${today}（${dateText}）`,
          '',
          `まず「${dateText} 何の日」で Google 検索して候補を把握し、`,
          '面白そうなトピックを1つ選んだら Wikipedia で詳しく調べてください。',
          '十分に調べたら submit_post でツイートを提出してください。投稿そのものはしない。',
        ].join('\n');
      },
    }, ports);
  }

  public async createPost(signal?: AbortSignal): Promise<AboutTodayOutput> {
    return runScheduledPost(this.spec, this.ports, signal);
  }
}
