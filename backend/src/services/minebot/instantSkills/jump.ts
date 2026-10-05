import { CustomBot, InstantSkill } from '../types.js';
import { actionDelay } from '../execution/observedWait.js';

/**
 * 原子的スキル: ジャンプする
 * 方向を指定すると、その方向にジャンプ移動する
 */
class Jump extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'jump';
    this.description =
      'ジャンプします。directionを指定すると、その方向にジャンプ移動します（forward/back/left/right）。countで回数を指定できます。';
    this.params = [
      {
        name: 'direction',
        type: 'string' as const,
        description:
          'ジャンプの方向。"forward"(前), "back"(後), "left"(左), "right"(右)。省略するとその場でジャンプ',
        required: false,
      },
      {
        name: 'count',
        type: 'number' as const,
        description: 'ジャンプ回数（デフォルト: 1）',
        required: false,
      },
    ];
  }

  async runImpl(
    direction?: 'forward' | 'back' | 'left' | 'right',
    count: number = 1,
  ) {
    try {
      const jumpCount = Math.min(Math.max(Math.round(count), 1), 10); // 1~10回
      const results: string[] = [];

      for (let i = 0; i < jumpCount; i++) {
        // 地面にいるまで待つ（最大2秒）
        const waitStart = Date.now();
        while (!this.bot.entity.onGround && Date.now() - waitStart < 2000) {
          await actionDelay(this.bot, 50);
        }

        if (!this.bot.entity.onGround) {
          results.push(`${i + 1}回目: 空中のためスキップ`);
          continue;
        }

        if (direction) {
          // 方向付きジャンプ: 移動キー + ジャンプを同時に押す
          this.bot.setControlState(direction, true);
          this.bot.setControlState('jump', true);

          // ジャンプ中は移動キーを押し続ける（着地まで最大800ms）
          await actionDelay(this.bot, 100);
          this.bot.setControlState('jump', false);

          // 着地を待つ
          const landStart = Date.now();
          while (!this.bot.entity.onGround && Date.now() - landStart < 800) {
            await actionDelay(this.bot, 50);
          }

          this.bot.setControlState(direction, false);
        } else {
          // その場ジャンプ
          this.bot.setControlState('jump', true);
          await actionDelay(this.bot, 100);
          this.bot.setControlState('jump', false);

          // 着地を待つ
          const landStart = Date.now();
          while (!this.bot.entity.onGround && Date.now() - landStart < 800) {
            await actionDelay(this.bot, 50);
          }
        }

        results.push(`${i + 1}回目: 成功`);
      }

      const dirLabel = direction
        ? { forward: '前', back: '後ろ', left: '左', right: '右' }[
            direction
          ] || direction
        : 'その場';

      return {
        success: true,
        result: `${dirLabel}に${jumpCount}回ジャンプしました`,
      };
    } catch (error: any) {
      // 安全のため全コントロールを解除
      try {
        this.bot.setControlState('jump', false);
        this.bot.setControlState('forward', false);
        this.bot.setControlState('back', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
      } catch (_) {
        /* ignore */
      }

      return {
        success: false,
        result: `ジャンプエラー: ${error.message}`,
      };
    }
  }
}

export default Jump;
