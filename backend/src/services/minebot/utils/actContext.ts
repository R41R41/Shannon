import { nativeActionHost } from '../execution/ActionExecution.js';

/**
 * What the running `act` command is, as the control body knows it and the act does not (continue contracts 3 and 8): the command's id and queue item,
 * the life it was made for, and the numbers of its inventory events. The control body sets it before the act runs and clears it after; the act reads it
 * for the ids of its events (`${command}:${pass}:${hand}:${seq}`) and for the record of where each hand began. Without it (a test, a probe) the act
 * runs as before and its events carry the id of `act`.
 */
export interface ActContext {
  command: string;
  item?: string;
  queue?: string;
  life: number;
  headBoot?: string;
  bodyBoot?: string;
  /** Called with the hand about to begin: the body's record of the hand's start (utils/handStart). */
  onHandStart?(info: { hand: number; pass: number }): void;
  /** Called before each hand moves the body: a lapse (a new life, a changed connection or lease, a changed dimension on the first hand) stops the act with its code. */
  lapse?(first: boolean): { code: string; why: string } | null;
}
const contexts = new WeakMap<object, ActContext>();
export function setActContext(bot: object, context: ActContext | null): void {
  const host = nativeActionHost(bot);
  if (context) contexts.set(host, context); else contexts.delete(host);
}
export function actContextOf(bot: object): ActContext | null { return contexts.get(nativeActionHost(bot)) ?? null; }
