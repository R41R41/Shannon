import { headCombatOwnerEnabled } from './combatOwner.js';
/**
 * The body's reflex switch, read in one place (P8, 2026-10-17; defaults changed by the owner 2026-10-19).
 *
 *   MINEBOT_FCA_REFLEXES unset or `default`  everything P8 built: the floor's retreat and eat reflexes (and the resident
 *                                             lava, breath, shield, knock and edge plugins), the low-health flee (with the last stand,
 *                                             the cover and the melee hand), the combat-knowledge providers (shield
 *                                             toward archers, the dig guard's threat radius, hitsLeft in the observation), the reflex
 *                                             ledger and the `interrupted_by_reflex` tag, and the floor's budget.
 *   `floor`                                   the production floor of 2026-10-16 (65b4bd1): retreat and eat only, with its
 *                                             original timings (a failed meal is retried after a fixed 3 s; no budget,
 *                                             no allowance, no latch) and its fixed list of enemy names for "an enemy is near". No flee,
 *                                             no combat knowledge. What is added besides is only reporting that moves nothing
 *                                             (the ledger, the receipt's tag, the observation's extra fields); take the tag away with
 *                                             `ledger-tag` in the deny list.
 *   `off`                                     the floor is not loaded at all. For rollback only: the resident plugins stay, the ledger
 *                                             keeps counting them. It switches off the PRODUCTION floor too: the P8 rollback is the
 *                                             deny list below, not this.
 *   `extended`                                the old name of `default` (it used to add the flee); accepted, with a warning.
 *   anything else (a typo)                    `floor`, the production floor, with a loud warning: a mistyped rollback must land on what
 *                                             production already runs, not on all of P8 (review M4). Never `off`.
 *
 * MINEBOT_FCA_REFLEX_OFF is a deny list separated by commas, spaces or semicolons, applied on top of the mode (an unknown name is ignored,
 * with a loud warning, so a typo in it cannot be mistaken for a rollback that happened):
 *   retreat, eat          the floor's own reflexes one by one
 *   flee                  the low-health flee (and the last stand, the cover and the melee hand)
 *   combat                the combat-knowledge providers alone
 *   budget                the floor's budget (cooldowns, the per-minute allowance and the stuck latch); the reflexes then run unmetered
 *                         (`floor` mode has none to begin with)
 *   ledger-tag            the receipt's reflex note and the `interrupted_by_reflex` failure type, so an API that dislikes the new type
 *                         can be answered at once with the old `interrupted`
 * Denying what the mode does not run changes nothing. What cannot be switched off: the ledger's counting, the observation's
 * `reflexes`, `jobs` and `biome` (they only say what is so; a body without them is blind to its own state).
 *
 * Read once at start up (a pure function of the environment), never per physics tick.
 */
export type ReflexMode = 'default' | 'floor' | 'off';
export const REFLEX_NAMES = ['retreat', 'eat', 'flee', 'ledger-tag', 'combat', 'budget'] as const;
export type ReflexName = typeof REFLEX_NAMES[number];

export interface FloorConfig {
  mode: ReflexMode;
  /** The deny list as given (known names only), in a stable order. */
  denied: ReflexName[];
  /** The floor plugin is loaded at all. */
  floor: boolean;
  retreat: boolean;
  eat: boolean;
  /** Low-health immediate flee. */
  flee: boolean;
  /** The receipt's reflex note and the `interrupted_by_reflex` failure type. */
  ledgerTag: boolean;
  /** `bot.combatStats()` and the other combat-knowledge providers are installed. */
  combatKnowledge: boolean;
  /** The floor's cooldowns, allowance and latch (see floorBudget.ts). Off in `floor` mode, which is the production floor's own timings. */
  budget: boolean;
  /** "An enemy is near" (eating) is the legacy `isThreatEntity`; `floor` mode keeps the production list of names. */
  wideThreats: boolean;
  /** What was wrong with the environment, for the start-up log. */
  warnings: string[];
}

export function floorConfig(env: Record<string, string | undefined> = process.env): FloorConfig {
  const warnings: string[] = [];
  const raw = (env.MINEBOT_FCA_REFLEXES ?? '').trim().toLowerCase();
  let mode: ReflexMode = 'default';
  if (raw === 'off' || raw === 'floor' || raw === 'default') mode = raw;
  else if (raw === 'extended') warnings.push('MINEBOT_FCA_REFLEXES=extended は default と同じになった（旧名）: default として扱う');
  else if (raw !== '') {
    mode = 'floor';
    warnings.push(`‼ MINEBOT_FCA_REFLEXES=${raw.slice(0, 20)} は未知の値（打ち間違い？）: 本番の床（floor）で起動する。default / floor / off のどれかに直すこと`);
  }
  const denied = new Set<ReflexName>();
  for (const part of (env.MINEBOT_FCA_REFLEX_OFF ?? '').split(/[\s,;]+/u)) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if ((REFLEX_NAMES as readonly string[]).includes(name)) denied.add(name as ReflexName);
    else warnings.push(`‼ MINEBOT_FCA_REFLEX_OFF の ${name.slice(0, 20)} は未知の名前（打ち間違い？）: 無視する。外したつもりのものは外れていない（使える名前: ${REFLEX_NAMES.join(', ')}）`);
  }
  const floor = mode !== 'off', full = mode === 'default';
  const allowed = (name: ReflexName) => floor && !denied.has(name);
  return {
    mode, denied: REFLEX_NAMES.filter(name => denied.has(name)), floor,
    retreat: allowed('retreat'), eat: allowed('eat'),
    flee: full && !denied.has('flee'),
    ledgerTag: !denied.has('ledger-tag'), combatKnowledge: full && !denied.has('combat'), budget: full && !denied.has('budget'), wideThreats: full, warnings,
  };
}

/** The one start-up line: what the journal shows of the switch. */
export function describeFloorConfig(config: FloorConfig): string {
  const on = (['retreat', 'eat', 'flee'] as const).filter(name => config[name]);
  const flag = (value: boolean) => value ? 'on' : 'off';
  return `🧱 床の反射: ${config.mode}（${on.join(',') || 'なし'}） 台帳=on タグ=${flag(config.ledgerTag)} 戦闘知識=${flag(config.combatKnowledge)} 予算=${flag(config.budget)} 拒否=[${config.denied.join(',')}]`;
}

/**
 * What the body's own reflexes do under this setting, in the words the planner reads in a skill's description (acceptThreat,
 * attackContinuously): so that the text says what is really on (it once said "retreat, eat, armour" when the flee was on too).
 * Read when the skill is made, from the same switch the client loads the floor by.
 */
export function reflexPromptText(config: FloorConfig = floorConfig()): string {
  const parts: string[] = [];
  if (config.retreat) parts.push('点火したクリーパーや飛んでくる矢から下がる');
  if (config.eat) parts.push('飢え（満腹度3以下）か瀕死（体力6以下）の時だけ、実行中の命令を切ってでも食べる（ほかの食事は act の eat で）');
  if (config.flee) parts.push('体力8以下で敵が近いと走って離れる（走っている間は実行中の戦闘・作業を中断する。20秒に2回まで。逃げ道が無ければ、手の届く敵を1回殴るか、足元を1段掘って下りるか、1段積んで上がる（囲いは作らない）' + (headCombatOwnerEnabled() ? '。ただしあなたが選んだ戦闘（combat・combat-engage・attack-nearest・attack-continuously）の実行中と開始後20秒（相手が生きて近くにいる間）は、体力が5を超える限り逃げも囲いもしない' : '') + '）');
  return parts.length ? `床の反射は動く: ${parts.join('、')}。反射に命令を切られることがある` : '床の反射は動いていない';
}