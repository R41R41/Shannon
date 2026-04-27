import { CustomBot, InstantSkill } from '../types.js';
import { SkillParam, SkillResult } from '../types/skillParams.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:Skill:boatGoto');

/**
 * BotBoatNavigator mod と連携してボートで水上移動するスキル。
 *
 * 前提:
 *  - サーバー側に BotBoatNavigator mod が導入されていること
 *  - bot が /botboat コマンドを実行できる権限を持つこと
 *
 * フロー:
 *  1. ボートに乗っていなければ ride-vehicle(place-and-mount) で乗船
 *  2. `/botboat goto <botName> <x> <y> <z>` を送信
 *  3. `BOTBOAT_RESULT bot=<botName> status=...` をチャット監視でパース
 *  4. arrived / partial_arrived → 降船して成功返却
 *  5. failed → 降船して失敗返却
 */
class BoatGoto extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'boat-goto';
    this.description =
      'ボートで指定座標まで水上移動する。未乗船なら自動でボートを設置して乗る。' +
      '到着できない場合は水上で進める最も目標に近い地点で降船する（partial_arrived）。' +
      'サーバー側の BotBoatNavigator mod が経路探索と操船を担当。';
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: '目標X座標',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: '目標Y座標（水面付近の整数で可）',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: '目標Z座標',
        required: true,
      },
    ] as SkillParam[];
    this.isToolForLLM = true;
    this.maxDurationMs = 180_000;
  }

  async runImpl(x: number, y: number, z: number): Promise<SkillResult> {
    const bot: any = this.bot;
    const botName = bot.username ?? bot._client?.username ?? '';
    if (!botName) {
      return { success: false, result: 'ボットのユーザー名を取得できませんでした。' };
    }

    const gx = Math.round(x);
    const gy = Math.round(y);
    const gz = Math.round(z);

    // 1. 乗船確認
    // synthetic vehicle (set_passengers は受けたが spawn_entity が間に合わなかったログイン直後等)
    // は実態との乖離で操船できないことが多いため、一旦 dismount してから再マウントする。
    const rideSkill = this.bot.instantSkills.getSkill('ride-vehicle');
    if (!rideSkill) {
      return { success: false, result: 'ride-vehicle スキルが見つかりません。' };
    }

    if (bot.vehicle && bot.vehicle._synthetic) {
      log.warn(`🚤 synthetic vehicle を検出。dismount して実態と合わせます`);
      try {
        await rideSkill.runImpl('dismount');
      } catch (err) {
        log.warn(`🚤 synthetic vehicle dismount エラー（続行）: ${err}`);
      }
    }

    if (!bot.vehicle) {
      log.info(`🚤 未乗船のためボートを設置して乗船します`);
      const mountResult = await rideSkill.runImpl('place-and-mount', 'boat');
      if (!mountResult.success) {
        return { success: false, result: `乗船失敗: ${mountResult.result}` };
      }
    }

    // 2. 結果待ちリスナ登録
    const resultPattern = new RegExp(
      `^BOTBOAT_RESULT\\s+bot=${escapeRegex(botName)}\\s+status=(\\w+)(.*)$`,
    );
    const resultPromise = new Promise<{
      status: string;
      rest: string;
    } | null>((resolve) => {
      let settled = false;
      const finish = (value: { status: string; rest: string } | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.bot.off('messagestr', listener);
        resolve(value);
      };

      const listener = (message: string) => {
        const m = message.match(resultPattern);
        if (!m) return;
        finish({ status: m[1], rest: m[2] ?? '' });
      };

      const timeoutMs = Math.max(this.maxDurationMs - 10_000, 30_000);
      const timer = setTimeout(() => finish(null), timeoutMs);

      this.bot.on('messagestr', listener);
    });

    // 3. コマンド送信
    const cmd = `/botboat goto ${botName} ${gx} ${gy} ${gz}`;
    log.info(`🚤 コマンド送信: ${cmd}`);
    this.bot.chat(cmd);

    // 4. 結果待ち
    const parsed = await resultPromise;

    // 到着後は自動で降りない。ボートに乗ったまま次の指示を待つ。
    // 降船したい場合は別途 ride-vehicle dismount を呼ぶこと。

    if (!parsed) {
      return { success: false, result: 'BotBoatNavigator からの応答がタイムアウトしました。' };
    }

    const { status, rest } = parsed;
    const fields = parseKeyValues(rest);

    switch (status) {
      case 'arrived':
        return {
          success: true,
          result: `目標地点 (${gx},${gy},${gz}) に到達しました。water_end=${fields.water_end ?? 'n/a'}`,
        };
      case 'partial_arrived':
        return {
          success: true,
          result:
            `水上で進める最良地点 ${fields.water_end ?? 'n/a'} まで到達しました。` +
            `目標まで残り ${fields.remaining_distance ?? '?'}m。徒歩移動に切り替えてください。`,
        };
      case 'failed':
        return {
          success: false,
          result: `ボート航行失敗 reason=${fields.reason ?? 'unknown'}`,
        };
      default:
        return { success: false, result: `不明な status=${status}` };
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseKeyValues(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

export default BoatGoto;
