import { isLikelyHostileMobName, isThreatEntity } from './hostileMobHints.js';

/**
 * Who owns a fight (run 21): the planner chose to fight a skeleton and a creeper in a cave three times (combat, combat-engage,
 * attack-nearest), full iron armour and an iron sword on the body, and for 140 s nobody attacked. Each choice was dropped because the
 * body's state kept changing under it: the planner's own fast judgment (flee, dig-shelter) and the floor's low-health flee and its
 * fallback shelter (floorReflexes: at health 8 or less, run; no way out, wall in) took the body from the fight again and again.
 *
 * The planner's fight is marked here for as long as the fight skill runs (types/skills.ts, next to the engagement it already
 * declares), and for CLEAR_AFTER_MS after it began while the creature it was after is still alive and near. While it is marked
 * the floor does not run away from it and does not wall the body in. What stays with the floor: eating at health 6 or less,
 * putting armour on, a lit creeper's fuse, breath, lava, fire and the fall guards (they are other reflexes, which do not look
 * here), and everything at health HEAD_COMBAT_YIELD_HEALTH or less, where the body's own limit is stronger than the planner's choice.
 *
 * MINEBOT_HEAD_COMBAT_OWNER=off puts the old behaviour back (the floor flees and walls in whatever the planner chose).
 */

/**
 * The skills that are the planner's fight (engagement.ts's FIGHT_SKILLS without build-around-self, which is a wall, not a fight). Run 39: the act's `fight`
 * hand is one (it marks itself, `primitives/fight.ts`): its `retreatHp` is the planner's own limit, so above `HEAD_COMBAT_YIELD_HEALTH` the floor does not flee for it.
 */
export const HEAD_COMBAT_SKILLS: ReadonlySet<string> = new Set(['combat', 'combat-engage', 'attack-nearest', 'attack-continuously', 'shoot-bow', 'fight']);
/** A fight that has ended (or been cut off) is still the planner's for this long after it began, while its target lives and is near. */
export const HEAD_COMBAT_GRACE_MS = 20_000;
/** How near the target must be for the grace to hold. */
export const HEAD_COMBAT_NEAR = 16;
/** At or below this health the floor runs and walls in as before, fight or no fight (combat skills end themselves at 6). */
export const HEAD_COMBAT_YIELD_HEALTH = 5;

/** `target`: the one creature a fight hand set out after (its grace is that creature's, not its kind's). */
interface Mark { skill: string; kinds: string[]; startedAt: number; endedAt?: number; target?: number }
interface CombatBody {
  health?: number;
  entity?: { id?: number; position?: { distanceTo(other: unknown): number } };
  entities?: Record<string, { id?: number; name?: string | null; type?: string | null; metadata?: unknown[]; position?: unknown; isValid?: boolean; health?: number } | undefined>;
  registry?: { entitiesByName?: Record<string, { type?: string } | undefined> } | null;
  headCombat?: Mark[];
  floorReflexes?: { busy?: string | null; fleeEpisode?: unknown; retreat?: { engaged?: boolean } };
}

export function headCombatOwnerEnabled(): boolean {
  return String(process.env.MINEBOT_HEAD_COMBAT_OWNER ?? '').toLowerCase() !== 'off';
}

/**
 * The planner's fight `skillName` begins (kinds: what it sets out to fight, `*` for whatever is hostile, as engagement.ts reads
 * them). The returned call ends it, once; the mark then lives on as the grace.
 */
export function markHeadCombat(bot: object, skillName: string, kinds: string[] | null, now = Date.now(), target?: number): () => void {
  if (!HEAD_COMBAT_SKILLS.has(skillName) || !headCombatOwnerEnabled()) return () => undefined;
  // run62 (02:34:22〜37): 豚との fight の印が 20 秒の猶予ごと床を握り、スケルトンの矢 5 発の間 cover も逃走も動かず、丸腰で死んだ。
  // 印は、体を傷つけうる相手との戦いの時だけ立てる（狩り・家畜は印を立てない。床の反射はふだんどおり動く）。
  if (!fightsAHostile(bot as CombatBody, kinds, target, now)) return () => undefined;
  const marks = ((bot as CombatBody).headCombat ??= []);
  prune(marks, now);
  const mark: Mark = { skill: skillName, kinds: (kinds?.length ? kinds : ['*']).map(kind => kind.toLowerCase()), startedAt: now,
    ...(typeof target === 'number' ? { target } : {}) };
  marks.push(mark);
  return () => { mark.endedAt ??= Date.now(); };
}

/**
 * Run 45 (+929): a fight act came while the melee reflex was at it; the act waited for the reflex, the reflex started hand after hand, and the act began
 * after she died. While the act waits for the hand that runs, a mark of the planner's fight holds the melee from a next hand. The returned call takes the
 * mark away whole (no grace: the act's own fight puts its own mark when it begins).
 */
export function holdMeleeForHead(bot: object, now = Date.now()): () => void {
  if (!headCombatOwnerEnabled()) return () => undefined;
  const marks = ((bot as CombatBody).headCombat ??= []);
  const mark: Mark = { skill: 'fight', kinds: ['*'], startedAt: now };
  marks.push(mark);
  return () => { const index = marks.indexOf(mark); if (index >= 0) marks.splice(index, 1); };
}

/** 中立だが打てば打ち返す種類と、竜の戦いの相手。名前の表に無くても印を立てる。 */
const FIGHTS_BACK = new Set(['zombified_piglin', 'piglin', 'enderman', 'wolf', 'iron_golem', 'llama', 'trader_llama', 'polar_bear', 'bee', 'panda', 'goat', 'dolphin',
  'ender_dragon', 'end_crystal', 'wither', 'shulker', 'guardian', 'elder_guardian']);
/** 戦う相手が体を傷つけうる種類か（`*` は「敵なら何でも」なので立てる）。的の id が見えていればその名前で、無ければ種類の名前で読む。 */
export function fightsAHostile(bot: CombatBody, kinds: string[] | null, target?: number, now = Date.now()): boolean {
  const named = target !== undefined ? bot.entities?.[target]?.name : undefined;
  const names = (named ? [named] : kinds?.length ? kinds : ['*']).map(kind => String(kind ?? '').toLowerCase());
  return names.some(name => {
    if (!name || name === '*') return true;
    if (FIGHTS_BACK.has(name) || isLikelyHostileMobName(name, now)) return true;
    const entity = target !== undefined ? bot.entities?.[target] : undefined;
    return isThreatEntity({ name, type: entity?.type, metadata: entity?.metadata }, bot.registry?.entitiesByName?.[name]?.type, now, bot as never);
  });
}

function prune(marks: Mark[], now: number): void {
  for (let index = marks.length - 1; index >= 0; index--) {
    const mark = marks[index];
    if (mark.endedAt !== undefined && now - mark.startedAt > HEAD_COMBAT_GRACE_MS) marks.splice(index, 1);
  }
}

/** A creature the fight is after: alive, within HEAD_COMBAT_NEAR, and of one of these kinds (`*`: anything that threatens the body). */
function targetNear(bot: CombatBody, kinds: string[], target?: number): boolean {
  const at = bot.entity?.position;
  if (!at) return false;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity?.position || entity === bot.entity || (entity.id !== undefined && entity.id === bot.entity?.id)) continue;
    if (target !== undefined && entity.id !== target) continue;
    if (entity.isValid === false || (typeof entity.health === 'number' && entity.health <= 0)) continue;
    const name = String(entity.name ?? '').toLowerCase();
    if (!name) continue;
    const kind = kinds.includes('*') ? isThreatEntity({ name, type: entity.type, metadata: entity.metadata }, bot.registry?.entitiesByName?.[name]?.type, Date.now(), bot as never)
      : kinds.some(wanted => name.includes(wanted));
    if (!kind) continue;
    try { if (at.distanceTo(entity.position) <= HEAD_COMBAT_NEAR) return true; } catch { /* a position that cannot be measured is not near */ }
  }
  return false;
}

/**
 * Whether the planner's fight holds the body now: a fight skill running, or begun in the last HEAD_COMBAT_GRACE_MS with its target
 * still alive and near. False at HEAD_COMBAT_YIELD_HEALTH or less, and when the switch is off.
 */
export function isHeadCombatActive(bot: object, now = Date.now()): boolean {
  if (!headCombatOwnerEnabled()) return false;
  const body = bot as CombatBody, marks = body.headCombat;
  if (!marks?.length) return false;
  if (typeof body.health === 'number' && body.health <= HEAD_COMBAT_YIELD_HEALTH) return false;
  prune(marks, now);
  return marks.some(mark => mark.endedAt === undefined || (now - mark.startedAt <= HEAD_COMBAT_GRACE_MS && targetNear(body, mark.kinds, mark.target)));
}

/**
 * Run 43 (+2,100 to +2,117, 18:36:38 to 18:36:52): the fight hand at drowned #5502 ended at once (lost: out of sight), and its grace held the floor for any
 * drowned within 16 m. Drowned #5493 hit her nine times from health 12.7 to 4.4 while the melee reflex, which had struck back at #5471 and #5502 a minute before,
 * stood still (the floor gives way to the planner's fight), and nobody fought. A fight hand that is running holds the melee reflex; one that has ended does not:
 * a blow back is the fight's own aim (the flee and the wall still wait out the grace).
 */
export function isHeadCombatRunning(bot: object, now = Date.now()): boolean {
  if (!headCombatOwnerEnabled()) return false;
  const body = bot as CombatBody, marks = body.headCombat;
  if (!marks?.length) return false;
  if (typeof body.health === 'number' && body.health <= HEAD_COMBAT_YIELD_HEALTH) return false;
  prune(marks, now);
  return marks.some(mark => mark.endedAt === undefined);
}

/**
 * `facts.combatOwner` of the observation: `head` while the planner's fight holds the body (the floor will not run or wall in),
 * `reflex` while a floor reflex is running the body away from a threat (the low-health flee, its shelter, a step back), else null.
 */
export function combatOwnerOf(bot: object, now = Date.now()): 'head' | 'reflex' | null {
  if (isHeadCombatActive(bot, now)) return 'head';
  const floor = (bot as CombatBody).floorReflexes;
  if (floor && (floor.busy === 'flee' || floor.fleeEpisode || floor.retreat?.engaged === true)) return 'reflex';
  return null;
}

/**
 * Continue contracts (4): the planner's fight that holds the body now, as the control view shows it: its skill, the enemy it is after, and until when
 * (a running fight has none: null; an ended one holds for HEAD_COMBAT_GRACE_MS). Null when none holds.
 */
export function combatMarkOf(bot: object, now = Date.now()): { skill: string; target?: number; until: number } | null {
  const body = bot as CombatBody, marks = body.headCombat;
  if (!marks?.length || !isHeadCombatActive(bot, now)) return null;
  const running = marks.find(mark => mark.endedAt === undefined) ?? marks[marks.length - 1];
  return { skill: running.skill, ...(running.target !== undefined ? { target: running.target } : {}), until: running.endedAt === undefined ? now + HEAD_COMBAT_GRACE_MS : running.startedAt + HEAD_COMBAT_GRACE_MS };
}

/** Kinds that shoot from afar and that a body with a sword and a few pieces of iron closes in on rather than runs from. */
const LONE_SHOOTERS = new Set(['skeleton', 'stray', 'bogged']);
/** Armour points of a piece, by its name (the game's table). */
const ARMOUR_POINTS: Record<string, [number, number, number, number]> = {
  leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3],
};
const ARMOUR_PIECES = ['_helmet', '_chestplate', '_leggings', '_boots'];
const IRON_OR_BETTER = ['iron', 'diamond', 'netherite'];
/** Health at or above which a well armoured body closes in on a lone archer rather than running (the planner's own rule). */
export const CLOSE_IN_HEALTH = 10;

/** Worn armour: how many pieces of iron or better, and the armour points of everything worn. */
export function armourWorn(bot: { inventory?: { slots?: Array<{ name?: string } | null | undefined> } }): { ironPieces: number; points: number } {
  let ironPieces = 0, points = 0;
  const slots = bot.inventory?.slots;
  ARMOUR_PIECES.forEach((suffix, index) => {
    const name = String(slots?.[5 + index]?.name ?? '');
    if (!name.endsWith(suffix)) return;
    const material = name.slice(0, -suffix.length);
    if (IRON_OR_BETTER.includes(material)) ironPieces++;
    points += name === 'turtle_helmet' ? 2 : ARMOUR_POINTS[material]?.[index] ?? 0;
  });
  return { ironPieces, points };
}

/** Melee enemies allowed within CLOSE_IN_MELEE_M beside the one archer (the engagement rule strikes a zombie at 4 m). */
const CLOSE_IN_MELEE_M = 8;
const CLOSE_IN_MELEE_MAX = 1;
/** Armour points that, with a shield on the arm, are enough to close in (run 8: an iron helmet and chestplate, golden boots: 9 points and a shield). */
const CLOSE_IN_SHIELD_POINTS = 8;
/** Kinds whose presence makes closing in on the archer the wrong hand: a creeper near (it swells while the body chases), a witch or a blaze in reach (more shots). */
const NOT_WITH: Readonly<Record<string, number>> = { creeper: CLOSE_IN_MELEE_M, witch: HEAD_COMBAT_NEAR, blaze: HEAD_COMBAT_NEAR };

/**
 * Whether the body should close in on this one archer and fight it, not run: the only shooter within HEAD_COMBAT_NEAR is one skeleton kind, at most one melee enemy within
 * CLOSE_IN_MELEE_M (no creeper there, no witch or blaze in reach), three pieces of iron or better worn (or ten armour points, or a shield on the arm and eight), a sword (held or
 * carried), and health CLOSE_IN_HEALTH or more. Said to the planner in `facts.closeInAdvised`, and read by the floor's cover (it cuts the line once and gives the body back).
 * Run 8 (11/13): iron helmet and chestplate, golden boots and a shield (9 points, two pieces of iron) and a zombie 6 m off: false both times, and the skeleton that kept 8 to 10 m
 * off took the body from 20 to 2.2 in 85 s while the cover ran it out of the fight's range. (The floor's own flee starts only at health 8 or less, so this never makes the floor
 * stand and be shot.)
 */
export function closeInAdvised(bot: object, now = Date.now()): boolean {
  const body = bot as CombatBody & { inventory?: { slots?: Array<{ name?: string } | null | undefined>; items?(): Array<{ name: string }> }; heldItem?: { name?: string } | null };
  if (!headCombatOwnerEnabled() || typeof body.health !== 'number' || body.health < CLOSE_IN_HEALTH) return false;
  const at = body.entity?.position;
  if (!at) return false;
  let shooters = 0, melee = 0;
  for (const entity of Object.values(body.entities ?? {})) {
    if (!entity?.position || entity === body.entity || entity.isValid === false) continue;
    const name = String(entity.name ?? '').toLowerCase();
    if (!name || !isThreatEntity({ name, type: entity.type, metadata: entity.metadata }, body.registry?.entitiesByName?.[name]?.type, now, body as never)) continue;
    let distance = Infinity;
    try { distance = at.distanceTo(entity.position); } catch { continue; }
    if (distance > HEAD_COMBAT_NEAR) continue;
    if (NOT_WITH[name] !== undefined && distance <= NOT_WITH[name]) return false;
    if (LONE_SHOOTERS.has(name)) shooters++;
    else if (distance <= CLOSE_IN_MELEE_M) melee++;
  }
  if (shooters !== 1 || melee > CLOSE_IN_MELEE_MAX) return false;
  const armour = armourWorn(body);
  const shield = body.inventory?.slots?.[45]?.name === 'shield';
  if (armour.ironPieces < 3 && armour.points < 10 && !(shield && armour.points >= CLOSE_IN_SHIELD_POINTS)) return false;
  const sword = (name?: string) => !!name && name.endsWith('_sword');
  return sword(body.heldItem?.name) || (body.inventory?.items?.() ?? []).some(item => sword(item.name));
}

/** The skeleton kinds (a bow and arrows, 7.5 to 15 m kept, a slow strafe back when walked at). */
export function isSkeletonKind(name: unknown): boolean { return LONE_SHOOTERS.has(String(name ?? '').toLowerCase().replace(/^minecraft:/u, '')); }
