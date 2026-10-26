/**
 * What ShannonUIMod's buttons mean for the common FCA body.
 *
 * The body no longer owns a task queue, a planner or the always-on skills: Shannon's mind in the API decides what the
 * body does. So a button is something the owner says to her: it goes to her mind as the same words a player would
 * write, and her mind acts (and answers in her own voice, in game chat and in the mod). The one thing the body does at
 * once on its own is stand still: stop and cancel abort the running commands first, then tell her mind.
 *
 * dragon26: 「やめる」 (cancel) is not a conversation. Said to her as 「今の作業をやめて」 the button was refused twice as `turn_not_visible` by her
 * mind and the task ran on. A cancel of the task the mod shows now goes straight to her mind's stop of that task (`stopTask`), with the running
 * commands aborted first; only when her mind cannot be reached is it said to her as before. Every control the mod sends, and how it ended, is one log line.
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
  /** The inventory tab's "give": the owner asks her to hand the item over. `sender`: the player the mod says it is. */
  giveItem(item: string, count: number, sender?: string): Promise<UiControlResult>;
  /** The skills tab's switch. Only the follow switch has a meaning for this body. */
  switchSkill(skillName: string, enabled: boolean, sender?: string): Promise<UiControlResult>;
  /** Delete/prioritize on a task in the queue. */
  taskAction(action: 'delete' | 'prioritize', taskId: string, sender?: string): Promise<UiControlResult>;
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
  /**
   * The owner's cancel of this task, straight to her mind's stop (no message to her): what it stopped, or null when her mind could not be
   * reached (or this body cannot). Absent: a cancel is said to her as a message, as before.
   */
  stopTask?(taskId: string): Promise<{ stopped: string[]; open: number } | null>;
  /** One content-free line per control received and per result (the task ids cut to 12 characters, no text of hers or his). */
  log?(line: string): void;
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
  /** The mod sends the player's name with these; without a proper one, with exactly one other player on the server it is that player. */
  const onlyHuman = (): string | null => { const humans = options.humans(); return humans.length === 1 ? humans[0] : null; };
  const senderOr = (sender?: string): string | null => (isPlayerName(sender) ? sender : onlyHuman());

  const say = (line: string) => { try { options.log?.(line); } catch { /* a log never fails a control */ } };
  const short = (id: string | null | undefined) => (id ?? '-').slice(0, 12);
  const ended = (what: string, path: string, result: UiControlResult): UiControlResult => {
    say(`UI_MOD ${what} result success=${result.success ? 1 : 0} path=${path} status=${result.status ?? (result.success ? 200 : 400)}`);
    return result;
  };
  /** A cancel of the task the mod shows, straight to her mind's stop; null when her mind did not take it (then it is said to her). */
  const direct = async (taskId: string): Promise<UiControlResult | null> => {
    let reply: { stopped: string[]; open: number } | null = null;
    try { reply = options.stopTask ? await options.stopTask(taskId) : null; } catch { reply = null; }
    say(`UI_MOD cancel direct task=${short(taskId)} reached=${reply ? 1 : 0} stopped=${reply?.stopped.length ?? 0} open=${reply?.open ?? 0}`);
    if (!reply) return null;
    options.tell('止めたよ。');
    return { success: true, result: reply.stopped.length ? 'stopped' : 'nothing was running' };
  };

  /** `tried`: a cancel whose commands were aborted and whose direct stop was asked already (it was not taken), with the number aborted. */
  const command = async (cmd: BotCommand, sender: string, tried?: { aborted: number }): Promise<UiControlResult> => {
    const stands = cmd === 'STOP' || cmd === 'CANCEL';
    const current = options.currentTaskId();
    say(`UI_MOD command ${cmd} received task=${short(current)}`);
    const aborted = tried ? tried.aborted : stands ? options.abortActive() : 0;
    if (cmd === 'CANCEL' && current && !tried) {
      const stopped = await direct(current);
      if (stopped) return ended(`command ${cmd}`, 'direct', stopped);
    }
    const refused = await speak(sender || onlyHuman() || '', COMMAND_WORDS[cmd]);
    if (!refused) return ended(`command ${cmd}`, 'mind', { success: true, result: 'sent to her mind' });
    // Standing still does not need her mind; the rest does.
    if (stands) { options.tell('止まったよ。'); return ended(`command ${cmd}`, 'local', { success: true, result: aborted ? 'stopped locally' : 'nothing was running' }); }
    return ended(`command ${cmd}`, 'refused', refused);
  };
  return {
    command,
    async giveItem(item, count, sender) {
      const name = senderOr(sender);
      if (!name) return { success: false, result: UNKNOWN_PLAYER, status: 409 };
      const clean = item.includes(':') ? item.split(':')[1] : item;
      return (await speak(name, `${clean}を${Math.max(1, Math.floor(count))}個ちょうだい`)) ?? { success: true, result: 'sent to her mind' };
    },
    async switchSkill(skillName, enabled, sender) {
      if (skillName !== 'auto-follow') return { success: false, result: 'this body has no always-on skills to switch', status: 409 };
      const name = senderOr(sender);
      if (!name) return { success: false, result: UNKNOWN_PLAYER, status: 409 };
      return command(enabled ? 'FOLLOW' : 'STOP', name);
    },
    async taskAction(action, taskId, sender) {
      if (action === 'prioritize') return { success: false, result: 'her mind decides the order of work', status: 409 };
      const current = options.currentTaskId();
      say(`UI_MOD task_delete received task=${short(taskId)} current=${short(current)} matched=${current === taskId ? 1 : 0}`);
      if (!current || current !== taskId) return ended('task_delete', 'none', { success: false, result: 'task not found', status: 404 });
      // The commands stop first; her mind's stop of the task needs no player's name, only the words said to her do.
      const aborted = options.abortActive();
      const stopped = await direct(taskId);
      if (stopped) return ended('task_delete', 'direct', stopped);
      const name = senderOr(sender);
      if (!name) return ended('task_delete', 'none', { success: false, result: UNKNOWN_PLAYER, status: 409 });
      return command('CANCEL', name, { aborted });
    },
    taskList: () => options.taskList(),
  };
}
