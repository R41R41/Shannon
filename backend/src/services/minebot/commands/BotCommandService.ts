/**
 * Quick orders from ShannonUIMod's command switcher.
 *
 * These are controls, not conversation: they never reach the LLM, never become memory, and take
 * no free text from the player. Each one maps to a fixed action on the bot or the task runtime.
 */
export const BOT_COMMANDS = ['STOP', 'FOLLOW', 'COME', 'RESUME', 'CANCEL'] as const;
export type BotCommand = (typeof BOT_COMMANDS)[number];

export function parseBotCommand(value: unknown): BotCommand | null {
  return typeof value === 'string' && (BOT_COMMANDS as readonly string[]).includes(value)
    ? (value as BotCommand)
    : null;
}

/** Minecraft player names are 3 to 16 of these characters. */
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

export function isPlayerName(value: unknown): value is string {
  return typeof value === 'string' && PLAYER_NAME.test(value);
}

export interface CommandRuntime {
  isRunning(): boolean;
  forceStop(): void;
  resumeByControl(): Promise<{ success: boolean; reason?: string }>;
  getTaskListState(): { currentTaskId?: string | null };
  removeTask(taskId: string): { success: boolean; reason?: string };
}

export interface CommandBotPort {
  /** Whether the bot can see the player's entity right now. */
  canSee(playerName: string): boolean;
  /** Runs an instant skill; resolves when it finishes. */
  runSkill(skillName: string, ...args: unknown[]): Promise<{ success: boolean; result: string }>;
  /** Turns an always-on skill off; returns whether it was on. */
  disableConstantSkill(skillName: string): boolean;
  /** Says a short line in game chat and in the Mod. */
  say(message: string): void;
}

export interface CommandResult {
  success: boolean;
  result: string;
}

const FOLLOW_RANGE = 3;
const COME_RANGE = 2;
const COME_TIMEOUT_MS = 60_000;

export class BotCommandService {
  constructor(
    private readonly runtime: CommandRuntime,
    private readonly bot: CommandBotPort,
    private readonly onConstantSkillsChanged: () => Promise<void> = async () => {},
  ) {}

  async run(command: BotCommand, sender: string): Promise<CommandResult> {
    switch (command) {
      case 'STOP':
        return this.stop();
      case 'FOLLOW':
        return this.goTo(sender, FOLLOW_RANGE, 0, `${sender}についていくね。`);
      case 'COME':
        return this.goTo(sender, COME_RANGE, COME_TIMEOUT_MS, '今そっちに向かうね。');
      case 'RESUME':
        return this.resume();
      case 'CANCEL':
        return this.cancel();
    }
  }

  private async stop(): Promise<CommandResult> {
    if (this.runtime.isRunning()) this.runtime.forceStop();
    if (this.bot.disableConstantSkill('auto-follow')) await this.onConstantSkillsChanged();
    await this.bot.runSkill('stop-movement');
    return this.reply(true, '止まったよ。');
  }

  /** Follows or approaches the player; the current task gives way, as the player asked. */
  private async goTo(sender: string, range: number, durationMs: number, ack: string): Promise<CommandResult> {
    if (!this.bot.canSee(sender)) {
      return this.reply(false, `${sender}が見当たらないよ。近くに来てくれる？`);
    }
    if (this.runtime.isRunning()) this.runtime.forceStop();
    // A timed approach runs until arrival; following without a limit returns at once.
    void this.bot.runSkill('follow-entity', sender, range, durationMs).catch(() => undefined);
    return this.reply(true, ack);
  }

  private async resume(): Promise<CommandResult> {
    const result = await this.runtime.resumeByControl();
    if (result.success) return this.reply(true, '続けるね。');
    if (result.reason === 'TASK_RUNNING') return this.reply(false, 'いま作業しているところだよ。');
    return this.reply(false, '続ける作業はないよ。');
  }

  private async cancel(): Promise<CommandResult> {
    const taskId = this.runtime.getTaskListState().currentTaskId;
    if (!taskId) return this.reply(false, 'いまは何もしていないよ。');
    const result = this.runtime.removeTask(taskId);
    return result.success
      ? this.reply(true, '今の作業をやめたよ。')
      : this.reply(false, 'やめられなかったよ。');
  }

  private reply(success: boolean, message: string): CommandResult {
    this.bot.say(message);
    return { success, result: message };
  }
}
