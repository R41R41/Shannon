/**
 * What the planner has chosen to fight, for as long as the skill doing it runs.
 *
 * A hostile in reach of the body is an emergency: the task is stopped and the body is taken out of reach. That
 * is right for a mob the body came upon, and wrong for one it went to: the planner that had decided to kill a
 * blaze had its attack stopped by the emergency for that blaze being near, and the emergency then hid the body
 * from it (paid runs L77j, L77k: the fortress was reached and no blaze was ever fought). Nothing told the
 * layer that keeps the body alive that this exposure was meant.
 *
 * A fight skill says so here while it runs. A kind being fought is not an emergency for being near, nor for
 * hitting the body: what is left to the emergency is the body's own state (health at half or less, one great
 * blow), and every other kind. The choice to fight stays the planner's; the limit stays the body's.
 */
const ANY = '*';

/**
 * The skills that are a fight, and the position of the argument that names what is fought. Walling itself in
 * where it stands is one of them, against whatever is there (no argument, -1): the body has chosen to stay,
 * and stopped three blocks into its wall it has neither the wall nor the distance.
 */
const FIGHT_SKILLS: Record<string, number> = { 'attack-nearest': 0, 'attack-continuously': 0, 'combat': 0, 'combat-engage': 0, 'shoot-bow': 0,
  'build-around-self': -1 };

/** The kinds a call of this skill sets out to fight (`*` for whatever is hostile), or null when it is no fight. */
export function engagementOf(skillName: string, args: unknown[]): string[] | null {
  const index = FIGHT_SKILLS[skillName];
  if (index === undefined) return null;
  if (index < 0) return [ANY];
  const named = String(args[index] ?? '').toLowerCase().trim();
  if (!named || named === 'hostile') return [ANY];
  return named.split(',').map(name => name.trim()).filter(Boolean);
}

interface Engaging { engagements?: Array<{ kinds: string[]; until?: number }> }

/**
 * A fight (or a stay among them) the planner chooses for a time, without a skill of its own running the whole
 * while: the walk up to a spawner through the blazes it means to deal with, say. It ends by itself. Returns
 * when it ends.
 */
export function engageFor(bot: object, kinds: string[], ms: number, now = Date.now()): number {
  const list = ((bot as Engaging).engagements ??= []);
  const until = now + ms;
  // One of these at a time: a new one takes the place of the last.
  for (let index = list.length - 1; index >= 0; index--) if (list[index].until !== undefined) list.splice(index, 1);
  list.push({ kinds: kinds.length ? kinds.map(kind => kind.toLowerCase()) : [ANY], until });
  return until;
}

/** What the planner has taken on for a time, and the seconds left of it; null when nothing. */
export function timedEngagement(bot: object | null | undefined, now = Date.now()): { kinds: string[]; secondsLeft: number } | null {
  const entry = live(bot, now).find(item => item.until !== undefined);
  return entry ? { kinds: entry.kinds.map(kind => kind === ANY ? '敵対Mobすべて' : kind), secondsLeft: Math.max(0, Math.round((entry.until! - now) / 1000)) } : null;
}

function live(bot: object | null | undefined, now = Date.now()): Array<{ kinds: string[]; until?: number }> {
  const list = (bot as Engaging | null | undefined)?.engagements;
  if (!list?.length) return [];
  for (let index = list.length - 1; index >= 0; index--) if (list[index].until !== undefined && list[index].until! <= now) list.splice(index, 1);
  return list;
}

/** A fight begins. The returned call ends it, once. */
export function beginEngagement(bot: object, kinds: string[] | null): () => void {
  if (!kinds?.length) return () => {};
  const list = ((bot as Engaging).engagements ??= []);
  const entry = { kinds };
  list.push(entry);
  return () => { const index = list.indexOf(entry); if (index >= 0) list.splice(index, 1); };
}

/** Whether a fight of the planner's choosing is on. */
export function isEngaged(bot: object | null | undefined): boolean {
  return live(bot).length > 0;
}

/** Whether this kind is one being fought by choice now. */
export function engagedWith(bot: object | null | undefined, kind: string | null | undefined): boolean {
  if (!kind) return false;
  const name = kind.toLowerCase();
  return live(bot).some(entry => entry.kinds.includes(ANY) || entry.kinds.some(fought => name.includes(fought)));
}
