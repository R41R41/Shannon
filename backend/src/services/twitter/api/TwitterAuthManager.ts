import axios, { isAxiosError } from 'axios';
import fs from 'fs';
import path from 'path';
import { TwitterApi } from 'twitter-api-v2';
import { config } from '../../../config/env.js';
import { createLogger } from '../../../utils/logger.js';
const logger = createLogger('Twitter:Auth');

// login_cookies の永続化ファイルパス
const LOGIN_COOKIES_FILE = path.resolve('saves/twitter_login_cookies.json');

export class TwitterAuthManager {
  private apiKey: string;
  private email: string;
  private password: string;
  private login_data: string;
  private two_fa_code: string;
  private totp_secret: string;
  private auth_session: string;
  private userName: string;
  private proxy1: string;

  public login_cookies: string;
  public client: TwitterApi;

  constructor() {
    this.apiKey = config.twitter.twitterApiIoKey;
    this.email = config.twitter.email;
    this.password = config.twitter.password;
    this.login_data = config.twitter.loginData;
    this.two_fa_code = config.twitter.twoFaCode;
    this.totp_secret = config.twitter.totpSecret;
    this.auth_session = config.twitter.authSession;
    this.login_cookies = config.twitter.loginCookies || '';
    this.userName = config.twitter.userName || '';
    this.proxy1 = config.twitter.proxy1;

    const apiKey = config.twitter.apiKey;
    const apiKeySecret = config.twitter.apiKeySecret;
    const accessToken = config.twitter.accessToken;
    const accessTokenSecret = config.twitter.accessTokenSecret;

    if (!apiKey || !apiKeySecret || !accessToken || !accessTokenSecret) {
      throw new Error('Twitter APIの認証情報が設定されていません');
    }

    this.client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiKeySecret,
      accessToken: accessToken,
      accessSecret: accessTokenSecret,
    });
  }

  /** auth_session を返す (API呼び出し用) */
  public getAuthSession(): string {
    return this.auth_session;
  }

  /** API Key を返す */
  public getApiKey(): string {
    return this.apiKey;
  }

  /** proxy1 を返す */
  public getProxy1(): string {
    return this.proxy1;
  }

  /**
   * ファイルから login_cookies を復元する。成功すれば true を返す。
   */
  public restoreCookiesFromFile(): boolean {
    try {
      if (fs.existsSync(LOGIN_COOKIES_FILE)) {
        const saved = JSON.parse(fs.readFileSync(LOGIN_COOKIES_FILE, 'utf-8'));
        if (saved?.cookies && typeof saved.cookies === 'string' && saved.cookies.length > 100) {
          this.login_cookies = saved.cookies;
          logger.success(`[initialize] login_cookies をファイルから復元 (${saved.cookies.length}文字, saved: ${saved.updatedAt ?? '不明'})`);
          return true;
        }
      }
    } catch (e) {
      logger.warn(`[initialize] login_cookies ファイル読込失敗: ${e}`);
    }
    return false;
  }

  /** twitterapi.io V1 Step-1 ログイン */
  public async login1Step() {
    const endpoint =
      'https://api.twitterapi.io/twitter/login_by_email_or_username';
    const data = { username_or_email: this.email, password: this.password };
    const reqConfig = { headers: { 'X-API-Key': this.apiKey } };
    try {
      const response = await axios.post(endpoint, data, reqConfig);
      const login_data = response.data.login_data;
      const status = response.data.status;
      logger.info(`Login step 1: ${status}`, 'cyan');
      return { login_data, status };
    } catch (error: unknown) {
      logger.error(`Login error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** twitterapi.io V1 Step-2 ログイン (2FA) */
  public async login2Step() {
    const endpoint = 'https://api.twitterapi.io/twitter/login_by_2fa';
    const data = { login_data: this.login_data, '2fa_code': this.two_fa_code };
    const reqConfig = { headers: { 'X-API-Key': this.apiKey } };
    try {
      const response = await axios.post(endpoint, data, reqConfig);
      this.auth_session = response.data.auth_session;
      logger.success('Login step 2 completed');
    } catch (error: unknown) {
      logger.error(`Login error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * twitterapi.io V2 ログイン
   * totp_secret を使って login_cookies を取得する（推奨フロー）
   */
  public async loginV2(): Promise<void> {
    const endpoint = 'https://api.twitterapi.io/twitter/user_login_v2';
    const data = {
      user_name: this.userName,
      email: this.email,
      password: this.password,
      totp_secret: this.totp_secret,
      proxy: this.proxy1,
    };
    const reqConfig = { headers: { 'X-API-Key': this.apiKey } };
    try {
      logger.info(`[loginV2] ログイン中... user_name=${this.userName}, email=${this.email}, totp_secret=${this.totp_secret ? '***' : '(empty)'}`, 'cyan');
      const response = await axios.post(endpoint, data, reqConfig);
      const resData = response.data;
      logger.debug(`[loginV2] レスポンス status: ${resData?.status}`);

      if (resData?.status === 'error') {
        throw new Error(`loginV2 failed: ${resData?.msg || resData?.message || JSON.stringify(resData).slice(0, 200)}`);
      }

      const cookies = resData?.login_cookie || resData?.login_cookies;
      if (!cookies) {
        throw new Error(`loginV2: login_cookie が返されませんでした。レスポンス: ${JSON.stringify(resData).slice(0, 300)}`);
      }
      this.login_cookies = cookies;
      logger.success(`[loginV2] ログイン成功。login_cookies 取得完了 (${cookies.length}文字)`);
      // クッキーをファイルに永続化
      try {
        const dir = path.dirname(LOGIN_COOKIES_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(LOGIN_COOKIES_FILE, JSON.stringify({ cookies, updatedAt: new Date().toISOString() }));
        logger.info('[loginV2] login_cookies をファイルに保存', 'cyan');
      } catch (e) {
        logger.warn(`[loginV2] login_cookies ファイル保存失敗: ${e}`);
      }
    } catch (error: unknown) {
      logger.error(`[loginV2] エラー: ${error instanceof Error ? error.message : String(error)}`);
      if (isAxiosError(error)) {
        logger.error(`[loginV2] レスポンス: ${JSON.stringify(error.response?.data).slice(0, 300)}`);
      }
      throw error;
    }
  }

  /**
   * login_cookies が取得済みかチェックし、未取得なら自動ログインを試行する。
   */
  public async ensureLoginCookies(): Promise<void> {
    if (!this.login_cookies) {
      logger.warn('[ensureLoginCookies] login_cookies が未取得。loginV2 を実行します...');
      await this.loginV2();
    }
  }
}
