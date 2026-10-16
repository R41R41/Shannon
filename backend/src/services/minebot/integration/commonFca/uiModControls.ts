/**
 * What ShannonUIMod's buttons mean for the common FCA body.
 *
 * The body no longer owns a task queue, a planner or the always-on skills: Shannon's mind in the API decides what the
 * body does. So a button is something the owner says to her: it goes to her mind as the same words a player would
 * write, and her mind acts (and answers in her own voice, in game chat and in the mod). The one thing the body does at
 * once on its own is stand still: stop and cancel abort the running commands first, then tell her mind.
 */
export const BOT_COMMANDS = ['STOP', 'FOLLOW', 'COME', 'RESUME', 'CANCEL'] as const;
export type BotCommand = (typeof BOT_COMMANDS)[number];

export function parseBotCommand(value: unknown): BotCommand | null {
  return typeof value === 'string' && (BOT_COMMANDS as readonly string[]).includes(value) ? (value as BotCommand) : null;
}

/** Minecraft player names are 3 to 16 of these characters. */
export function isPlayerName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(value);
}

/** The words each order is said to her mind in. */
export const COMMAND_WORDS: Record<BotCommand, string> = {
  STOP: '止まって', FOLLOW: 'ついてきて', COME: 'こっちに来て', RESUME: '続けて', CANCEL: '今の作業をやめて',
};

export interface UiControlResult { success: boolean; result: string; status?: number }

export interface FcaUiControls {
  command(command: BotCommand, sender: string): Promise<UiControlResult>;
  /** The inventory tab's "give": the owner asks her to hand the item over. */
  giveItem(item: string, count: number): Promise<UiControlResult>;
  /** The skills tab's switch. Only the follow switch has a meaning for this body. */
  switchSkill(skillName: string, enabled: boolean): Promise<UiControlResult>;
  /** Delete/prioritize on a task in the queue. */
  taskAction(action: 'delete' | 'prioritize', taskId: string): Promise<UiControlResult>;
  /** The task list the mod can read (`GET /task_list`). */
  taskList(): unknown;
}

export interface FcaUiControlsOptions {
  /** One line to her mind from this player; true when she answered. */
  say(speaker: { uuid: string; name: string }, message: string): Promise<boolean>;
  uuidOf(name: string): string | undefined;
  /** Players on the server other than the body. */
  humans(): string[];
  /** Aborts the commands running now; the number aborted. */
  abortActive(): number;
  /** The task the mod is showing (its id), if any. */
  currentTaskId(): string | null;
  taskList(): unknown;
  /** Says a short line in game chat and in the mod. */
  tell(message: string): void;
}

const NO_MIND = 'いま心と話せないよ。';
const UNKNOWN_PLAYER = '誰が言っているのか分からないよ。ゲーム内チャットで話しかけてね。';

export function createFcaUiControls(options: FcaUiControlsOptions): FcaUiControls {
  const speak = async (name: string, message: string): Promise<UiControlResult | null> => {
    const uuid = options.uuidOf(name);
    if (!uuid) return { success: false, result: UNKNOWN_PLAYER, status: 409 };
    let answered = false;
    try { answered = await options.say({ uuid, name }, message); } catch { /* reported below */ }
    return answered ? null : { success: false, result: NO_MIND, status: 503 };
  };
  /** The mod sends no name with these; with exactly one other player on the server it is that player. */
  const onlyHuman = (): string | null => { const humans = options.humans(); return humans.length === 1 ? humans[0] : null; };

  const command = async (cmd: BotCommand, sender: string): Promise<UiControlResult> => {
    const stands = cmd === 'STOP' || cmd === 'CANCEL';
    const aborted = stands ? options.abortActive() : 0;
    const refused = await speak(sender || onlyHuman() || '', COMMAND_WORDS[cmd]);
    if (!refused) return { success: true, result: 'sent to her mind' };
    // Standing still does not need her mind; the rest does.
    if (stands) { options.tell('止まったよ。'); return { success: true, result: aborted ? 'stopped locally' : 'nothing was running' }; }
    return refused;
  };
  return {
    command,
    async giveItem(item, count) {
      const name = onlyHuman();
      if (!name) return { success: false, result: UNKNOWN_PLAYER, status: 409 };
      const clean = item.includes(':') ? item.split(':')[1] : item;
      return (await speak(name, `${clean}を${Math.max(1, Math.floor(count))}個ちょうだい`)) ?? { success: true, result: 'sent to her mind' };
    },
    async switchSkill(skillName, enabled) {
      if (skillName !== 'auto-follow') return { success: false, result: 'this body has no always-on skills to switch', status: 409 };
      const name = onlyHuman();
      if (!name) return { success: false, result: UNKNOWN_PLAYER, status: 409 };
      return command(enabled ? 'FOLLOW' : 'STOP', name);
    },
    async taskAction(action, taskId) {
      if (action === 'prioritize') return { success: false, result: 'her mind decides the order of work', status: 409 };
      const current = options.currentTaskId();
      if (!current || current !== taskId) return { success: false, result: 'task not found', status: 404 };
      const name = onlyHuman();
      if (!name) return { success: false, result: UNKNOWN_PLAYER, status: 409 };
      return command('CANCEL', name);
    },
    taskList: () => options.taskList(),
  };
}
