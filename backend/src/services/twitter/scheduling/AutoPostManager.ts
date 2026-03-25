import {
  AutoTweetMode,
  TwitterAutoTweetInput,
  TwitterTrendData,
} from '@shannon/common';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../../../utils/logger.js';
const logger = createLogger('Twitter:AutoPost');
import { TwitterApiClient } from '../api/TwitterApiClient.js';
import { EventBus } from '../../eventBus/eventBus.js';

// 自動投稿カウンタの永続化ファイルパス
const AUTO_POST_COUNT_FILE = path.resolve('saves/auto_post_count.json');
// 直近の自動投稿テキスト永続化ファイルパス
const RECENT_AUTO_POSTS_FILE = path.resolve('saves/recent_auto_posts.json');
// 当日の投稿予定時刻スケジュールの永続化ファイルパス
const DAILY_SCHEDULE_FILE = path.resolve('saves/auto_post_daily_schedule.json');
// 直近ポスト保持件数
const MAX_RECENT_AUTO_POSTS = 20;

export class AutoPostManager {
  /** 当日の自動投稿カウンター */
  private autoPostCount: number = 0;
  /** カウンタの日付 (YYYY-MM-DD JST) */
  private autoPostDate: string = '';
  /** 最後に自動投稿した時刻 (ms) */
  private lastAutoPostAt: number = 0;
  /** 1日あたりの自動投稿最小数 */
  private minAutoPostsPerDay: number;
  /** 1日あたりの自動投稿最大数 */
  private maxAutoPostsPerDay: number;
  /** 自動投稿の活動開始時間 (JST, 0-23) */
  private autoPostStartHour: number;
  /** 自動投稿の活動終了時間 (JST, 0-24) */
  private autoPostEndHour: number;
  /** 当日の投稿予定時刻リスト (epoch ms, 昇順) */
  private todayPostTimes: number[] = [];
  /** 次回自動投稿のタイマー */
  private autoPostTimer: ReturnType<typeof setTimeout> | null = null;
  /** 日次リセットのタイマー */
  private dailyResetTimer: ReturnType<typeof setTimeout> | null = null;

  /** 直近の自動投稿エントリ */
  private recentPostEntries: Array<{ text: string; quoteUrl?: string; topic?: string }> = [];

  private apiClient: TwitterApiClient;
  private eventBus: EventBus;
  private getStatus: () => string;

  constructor(
    apiClient: TwitterApiClient,
    eventBus: EventBus,
    getStatus: () => string,
    opts: {
      minAutoPostsPerDay: number;
      maxAutoPostsPerDay: number;
      autoPostStartHour: number;
      autoPostEndHour: number;
    },
  ) {
    this.apiClient = apiClient;
    this.eventBus = eventBus;
    this.getStatus = getStatus;
    this.minAutoPostsPerDay = opts.minAutoPostsPerDay;
    this.maxAutoPostsPerDay = opts.maxAutoPostsPerDay;
    this.autoPostStartHour = opts.autoPostStartHour;
    this.autoPostEndHour = opts.autoPostEndHour;
  }

  // =========================================================================
  // Recent posts tracking
  // =========================================================================

  /** recentPostEntries から text 配列を生成 */
  public get recentAutoPosts(): string[] {
    return this.recentPostEntries.map((e) => e.text);
  }

  /** recentPostEntries から quoteUrl 配列を生成（undefined は除く） */
  public get recentQuoteUrls(): string[] {
    return this.recentPostEntries.filter((e) => e.quoteUrl).map((e) => e.quoteUrl!);
  }

  /** recentPostEntries から topic 配列を生成（undefined は除く） */
  public get recentTopics(): string[] {
    return this.recentPostEntries.filter((e) => e.topic).map((e) => e.topic!);
  }

  /** 直近ポストをファイルから読み込む */
  public loadRecentPosts(): void {
    try {
      if (fs.existsSync(RECENT_AUTO_POSTS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(RECENT_AUTO_POSTS_FILE, 'utf-8'));
        if (Array.isArray(raw)) {
          this.recentPostEntries = raw
            .map((r: any) => ({
              text: typeof r === 'string' ? r : (r.text || ''),
              ...(r.quoteUrl ? { quoteUrl: r.quoteUrl } : {}),
              ...(r.topic ? { topic: r.topic } : {}),
            }))
            .filter((e) => e.text)
            .slice(-MAX_RECENT_AUTO_POSTS);
          logger.info(
            `📋 直近ポスト: ${this.recentPostEntries.length}件, 引用URL: ${this.recentQuoteUrls.length}件, トピック: ${this.recentTopics.length}件を復元`,
            'cyan'
          );
        }
      }
    } catch (err) {
      logger.warn(`📋 直近ポストファイル読み込み失敗: ${err}`);
    }
  }

  /** 直近ポストを追加してファイルに保存する */
  public saveRecentPost(text: string, quoteUrl?: string, topic?: string): void {
    this.recentPostEntries.push({
      text,
      ...(quoteUrl ? { quoteUrl } : {}),
      ...(topic ? { topic } : {}),
    });
    if (this.recentPostEntries.length > MAX_RECENT_AUTO_POSTS) {
      this.recentPostEntries = this.recentPostEntries.slice(-MAX_RECENT_AUTO_POSTS);
    }
    try {
      fs.writeFileSync(RECENT_AUTO_POSTS_FILE, JSON.stringify(this.recentPostEntries, null, 2));
    } catch (err) {
      logger.warn(`📋 直近ポスト保存失敗: ${err}`);
    }
  }

  /** 指定URLを最近引用RTしたか */
  public hasRecentlyQuoted(url: string): boolean {
    if (!url) return false;
    const tweetId = url.match(/status\/(\d+)/)?.[1];
    return this.recentQuoteUrls.some((u) => {
      if (u === url) return true;
      const existingId = u.match(/status\/(\d+)/)?.[1];
      return tweetId && existingId && tweetId === existingId;
    });
  }

  // =========================================================================
  // Auto tweet mode selection
  // =========================================================================

  /** 加重ランダムでAutoTweetモードを選択 */
  private selectAutoTweetMode(): AutoTweetMode {
    const weights: [AutoTweetMode, number][] = [
      ['original', 20],
      ['trend', 30],
      ['watchlist', 30],
      ['big_account_quote', 20],
    ];
    const total = weights.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [mode, weight] of weights) {
      r -= weight;
      if (r <= 0) return mode;
    }
    return 'trend';
  }

  // =========================================================================
  // Auto post count persistence
  // =========================================================================

  /** 自動投稿カウンタをファイルから読み込む */
  public loadAutoPostCount(): void {
    try {
      if (fs.existsSync(AUTO_POST_COUNT_FILE)) {
        const data = JSON.parse(fs.readFileSync(AUTO_POST_COUNT_FILE, 'utf-8'));
        const todayJST = this.getTodayJST();
        if (data.date === todayJST) {
          this.autoPostCount = data.count ?? 0;
          this.autoPostDate = data.date;
          this.lastAutoPostAt = data.lastPostAt ?? 0;
          logger.info(
            `📋 自動投稿カウンタ: ${this.autoPostCount}/${this.maxAutoPostsPerDay} (${todayJST})`,
            'cyan'
          );
        } else {
          this.autoPostCount = 0;
          this.autoPostDate = todayJST;
          this.lastAutoPostAt = 0;
          logger.info(
            `📋 自動投稿カウンタ: 新しい日付のためリセット (${todayJST})`,
            'cyan'
          );
        }
      } else {
        this.autoPostDate = this.getTodayJST();
      }
    } catch (err) {
      logger.warn(`📋 自動投稿カウンタ読み込み失敗: ${err}`);
      this.autoPostDate = this.getTodayJST();
    }
  }

  /** 自動投稿カウンタをファイルに保存する */
  private saveAutoPostCount(): void {
    try {
      const dir = path.dirname(AUTO_POST_COUNT_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        AUTO_POST_COUNT_FILE,
        JSON.stringify({
          date: this.autoPostDate,
          count: this.autoPostCount,
          lastPostAt: this.lastAutoPostAt,
        }, null, 2)
      );
    } catch (err) {
      logger.warn(`📋 自動投稿カウンタ保存失敗: ${err}`);
    }
  }

  // =========================================================================
  // Daily schedule
  // =========================================================================

  /**
   * 当日の投稿スケジュールをファイルから読み込む。
   * 今日の分がなければ新規生成する。
   */
  public loadDailySchedule(): void {
    try {
      if (fs.existsSync(DAILY_SCHEDULE_FILE)) {
        const data = JSON.parse(fs.readFileSync(DAILY_SCHEDULE_FILE, 'utf-8'));
        if (data.date === this.getTodayJST()) {
          this.todayPostTimes = data.times || [];
          if (typeof data.postedCount === 'number') {
            this.autoPostCount = data.postedCount;
          }
          logger.info(
            `📋 投稿スケジュール読み込み: ${this.todayPostTimes.length}件 (${data.date}), 投稿済み: ${this.autoPostCount}件`,
            'cyan'
          );
          this.logDailySchedule();
          return;
        }
      }
    } catch (err) {
      logger.warn(`📋 投稿スケジュール読み込み失敗: ${err}`);
    }
    this.generateDailySchedule();
  }

  /**
   * 当日分の投稿予定時刻をランダム生成してファイルに保存する。
   */
  private generateDailySchedule(): void {
    const count =
      Math.floor(
        Math.random() * (this.maxAutoPostsPerDay - this.minAutoPostsPerDay + 1)
      ) + this.minAutoPostsPerDay;

    const jstNow = toZonedTime(new Date(), 'Asia/Tokyo');

    const startJST = new Date(jstNow);
    startJST.setHours(this.autoPostStartHour, 0, 0, 0);
    const startMs = startJST.getTime();

    const endJST = new Date(jstNow);
    if (this.autoPostEndHour >= 24) {
      endJST.setDate(endJST.getDate() + 1);
      endJST.setHours(0, 0, 0, 0);
    } else {
      endJST.setHours(this.autoPostEndHour, 0, 0, 0);
    }
    const endMs = endJST.getTime();
    const range = endMs - startMs;

    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      times.push(Math.floor(startMs + Math.random() * range));
    }
    times.sort((a, b) => a - b);

    this.todayPostTimes = times;
    this.saveDailySchedule();

    logger.info(
      `📋 投稿スケジュール生成: ${count}件 (${this.getTodayJST()})`,
      'green'
    );
    this.logDailySchedule();
  }

  /** スケジュールをファイルに保存 */
  private saveDailySchedule(): void {
    try {
      const dir = path.dirname(DAILY_SCHEDULE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        DAILY_SCHEDULE_FILE,
        JSON.stringify(
          {
            date: this.getTodayJST(),
            times: this.todayPostTimes,
            postedCount: this.autoPostCount,
          },
          null,
          2
        )
      );
    } catch (err) {
      logger.warn(`📋 投稿スケジュール保存失敗: ${err}`);
    }
  }

  /** スケジュール一覧をログ出力 */
  private logDailySchedule(): void {
    const now = Date.now();
    this.todayPostTimes.forEach((t, i) => {
      const jst = toZonedTime(new Date(t), 'Asia/Tokyo');
      const timeStr = format(jst, 'HH:mm');
      const status = t <= now ? '✅済' : '⏳予定';
      logger.info(`  ${i + 1}. ${timeStr} ${status}`, 'cyan');
    });
  }

  // =========================================================================
  // Auto-post execution & scheduling
  // =========================================================================

  /**
   * 自動投稿を実行する
   */
  public async autoPostTweet(): Promise<void> {
    if (this.getStatus() !== 'running') {
      logger.info('🐦 AutoPost: Twitter未起動、スキップ');
      this.scheduleFromDailyPlan();
      return;
    }

    try {
      const mode = this.selectAutoTweetMode();

      let trends: TwitterTrendData[] = [];
      if (mode === 'trend') {
        logger.info(`🐦 AutoPost: トレンド取得中...`, 'cyan');
        trends = await this.apiClient.fetchTrends();
        if (trends.length === 0) {
          logger.warn('🐦 AutoPost: トレンド取得失敗、スキップ');
          this.scheduleFromDailyPlan();
          return;
        }
      }

      const todayInfo = this.getTodayInfo();

      logger.info(
        `🐦 AutoPost: LLMにツイート生成をリクエスト (mode=${mode}, トレンド${trends.length}件)`,
        'cyan'
      );

      this.eventBus.publish({
        type: 'llm:generate_auto_tweet',
        memoryZone: 'twitter:post',
        data: {
          mode,
          trends,
          todayInfo,
          recentPosts: [...this.recentAutoPosts],
          recentQuoteUrls: [...this.recentQuoteUrls],
          recentTopics: [...this.recentTopics],
        } as TwitterAutoTweetInput,
      });

      this.autoPostCount++;
      this.lastAutoPostAt = Date.now();
      this.saveAutoPostCount();
      logger.info(
        `🐦 AutoPost: リクエスト送信完了 (本日 ${this.autoPostCount}/${this.todayPostTimes.length}件予定)`,
        'green'
      );
    } catch (error) {
      logger.error('🐦 AutoPost エラー:', error);
    }

    this.scheduleFromDailyPlan();
  }

  /**
   * 今日のスケジュールから次回投稿時刻を探してタイマーをセットする。
   */
  public scheduleFromDailyPlan(): void {
    if (this.autoPostTimer) {
      clearTimeout(this.autoPostTimer);
      this.autoPostTimer = null;
    }

    const now = Date.now();
    const nextTime = this.todayPostTimes.find((t) => t > now);

    if (!nextTime) {
      logger.info('🐦 AutoPost: 本日のスケジュールをすべて消化。翌日まで待機', 'cyan');
      return;
    }

    const delay = nextTime - now;
    const nextJST = toZonedTime(new Date(nextTime), 'Asia/Tokyo');
    logger.info(
      `🐦 AutoPost: 次回投稿 ${format(nextJST, 'HH:mm')} (${Math.round(delay / 60000)}分後)`,
      'cyan'
    );

    this.autoPostTimer = setTimeout(() => this.autoPostTweet(), delay);
  }

  /**
   * 毎日 0:00 JST に自動投稿カウンターをリセットし、翌日のスケジュールを生成する
   */
  public scheduleDailyReset(): void {
    const scheduleNext = () => {
      const now = new Date();
      const jstNow = toZonedTime(now, 'Asia/Tokyo');

      const nextMidnight = new Date(jstNow);
      nextMidnight.setDate(nextMidnight.getDate() + 1);
      nextMidnight.setHours(0, 0, 0, 0);

      const msUntilMidnight = nextMidnight.getTime() - jstNow.getTime();

      logger.info(
        `🐦 AutoPost: 日次リセットを ${Math.round(msUntilMidnight / 60000)}分後にスケジュール`,
        'cyan'
      );

      this.dailyResetTimer = setTimeout(() => {
        this.autoPostCount = 0;
        this.autoPostDate = this.getTodayJST();
        this.lastAutoPostAt = 0;
        this.saveAutoPostCount();
        this.generateDailySchedule();
        this.scheduleFromDailyPlan();
        logger.info('🐦 AutoPost: 日次リセット完了。新しいスケジュールで再開', 'green');
        scheduleNext();
      }, msUntilMidnight);
    };

    scheduleNext();
  }

  // =========================================================================
  // Utility helpers
  // =========================================================================

  /** JST の今日の日付文字列を返す (YYYY-MM-DD) */
  public getTodayJST(): string {
    const now = new Date();
    const jst = toZonedTime(now, 'Asia/Tokyo');
    return format(jst, 'yyyy-MM-dd');
  }

  /** 現在JSTの時間 (0-23) を返す */
  public getJSTHour(): number {
    const now = new Date();
    const jstNow = toZonedTime(now, 'Asia/Tokyo');
    return jstNow.getHours();
  }

  /** 今日の日付情報を組み立てる */
  private getTodayInfo(): string {
    const now = new Date();
    const jstNow = toZonedTime(now, 'Asia/Tokyo');
    const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][jstNow.getDay()];
    const month = jstNow.getMonth() + 1;
    const day = jstNow.getDate();

    const lines = [`今日: ${jstNow.getFullYear()}年${month}月${day}日(${dayOfWeek})`];

    if (month === 1 && day === 1) lines.push('イベント: 元旦');
    else if (month === 2 && day === 3) lines.push('イベント: 節分');
    else if (month === 2 && day === 14) lines.push('イベント: バレンタインデー');
    else if (month === 3 && day === 3) lines.push('イベント: ひな祭り');
    else if (month === 3 && day === 14) lines.push('イベント: ホワイトデー');
    else if (month === 4 && day >= 1 && day <= 10) lines.push('季節: 桜の季節');
    else if (month === 5 && day === 5) lines.push('イベント: こどもの日');
    else if (month === 7 && day === 7) lines.push('イベント: 七夕');
    else if (month === 8 && day >= 13 && day <= 16) lines.push('イベント: お盆');
    else if (month === 10 && day === 31) lines.push('イベント: ハロウィン');
    else if (month === 12 && day === 24) lines.push('イベント: クリスマスイブ');
    else if (month === 12 && day === 25) lines.push('イベント: クリスマス');
    else if (month === 12 && day === 31) lines.push('イベント: 大晦日');

    return lines.join('\n');
  }

  /** 初期化ログを出力 */
  public logInitialization(): void {
    logger.info(
      `🐦 AutoPost: 初期化完了 (${this.minAutoPostsPerDay}-${this.maxAutoPostsPerDay}/日, ${this.autoPostStartHour}時-${this.autoPostEndHour}時 JST, 本日${this.todayPostTimes.length}件予定・${this.autoPostCount}件投稿済み)`,
      'green'
    );
  }
}
