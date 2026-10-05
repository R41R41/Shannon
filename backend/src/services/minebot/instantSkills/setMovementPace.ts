import { CustomBot, InstantSkill } from '../types.js';

/**
 * The pace of ordinary travel. Movement used to sprint always; the planner
 * could not trade speed against hunger. An emergency (escape, fight) sprints
 * regardless of this setting.
 */
class SetMovementPace extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'set-movement-pace';
    this.description = '以後の通常の移動の速さを選ぶ（次に変えるまで有効）。walk=歩く: 空腹度を消費しない。'
      + 'sprint=走る: 約2割速いが、約43mごとに空腹度1を消費する（隔離サーバーでの実測）。'
      + '緊急時の逃走・戦闘はこの設定に関係なく走る。現在の設定と歩いた/走った距離は観測のmovementPace・exertionに出る。';
    this.params = [{ name: 'pace', type: 'string', description: 'walk または sprint', required: true }];
  }

  async runImpl(pace: string) {
    if (pace !== 'walk' && pace !== 'sprint') {
      return { success: false, result: 'paceは walk か sprint で指定してください', failureType: 'invalid_argument', recoverable: true };
    }
    (this.bot as CustomBot & { movementPace?: 'walk' | 'sprint' }).movementPace = pace;
    return { success: true, result: `通常の移動を${pace === 'walk' ? '歩き' : '走り'}にしました` };
  }
}

export default SetMovementPace;
