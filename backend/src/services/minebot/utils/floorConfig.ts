/**
 * The body's reflex switch, read in one place (P8, 2026-10-17; defaults changed by the owner 2026-10-19).
 *
 *   MINEBOT_FCA_REFLEXES unset or `default`  everything P8 built: the floor's retreat, eat and armour reflexes (and the resident
 *                                             lava, breath, shield, knock and edge plugins), the low-health flee and the idle pickup
 *                                             (what the legacy mode's constant skills did), the combat-knowledge providers (shield
 *                                             toward archers, the dig guard's threat radius, hitsLeft in the observation), the reflex
 *                                             ledger and the `interrupted_by_reflex` tag, and the floor's budget.
 *   `floor`                                   exactly the production floor of 2026-10-16: retreat, eat and armour only. No flee, no
 *                                             pickup, no combat knowledge. (The ledger, the tag and the budget are not movement: take
 *                                             the tag away with `ledger-tag` in the deny list.)
 *   `off`                                     the floor is not loaded at all. For rollback only: the resident plugins stay, the ledger
 *                                             keeps counting them. It switches off the PRODUCTION floor too: the P8 rollback is the
 *                                             deny list below, not this.
 *   `extended`                                the old name of `default` (it used to add flee and pickup); accepted, with a warning.
 *   anything else                             `default`, with a warning.
 *
 * MINEBOT_FCA_REFLEX_OFF is a comma separated deny list, applied on top of the mode:
 *   retreat, eat, armor   the floor's own reflexes one by one
 *   flee                  the low-health flee           pickup  the idle pickup
 *   combat                the combat-knowledge providers alone
 *   budget                the floor's budget (cooldowns, the per-minute allowance and the stuck latch); the reflexes then run unmetered
 *   ledger-tag            the receipt's reflex note and the `interrupted_by_reflex` failure type, so an API that dislikes the new type
 *                         can be answered at once with the old `interrupted`
 * Denying what the mode does not run changes nothing. What cannot be switched off: the ledger's counting, the observation's
 * `reflexes`, `jobs` and `biome` (they only say what is so; a body without them is blind to its own state).
 *
 * Read once at start up (a pure function of the environment), never per physics tick.
 */
export type ReflexMode = 'default' | 'floor' | 'off';
export const REFLEX_NAMES = ['retreat', 'eat', 'armor', 'flee', 'pickup', 'ledger-tag', 'combat', 'budget'] as const;
export type ReflexName = typeof REFLEX_NAMES[number];

export interface FloorConfig {
  mode: ReflexMode;
  /** The deny list as given (known names only), in a stable order. */
  denied: ReflexName[];
  /** The floor plugin is loaded at all. */
  floor: boolean;
  retreat: boolean;
  eat: boolean;
  armor: boolean;
  /** Low-health immediate flee. */
  flee: boolean;
  /** Idle pickup of nearby drops. */
  pickup: boolean;
  /** The receipt's reflex note and the `interrupted_by_reflex` failure type. */
  ledgerTag: boolean;
  /** `bot.combatStats()` and the other combat-knowledge providers are installed. */
  combatKnowledge: boolean;
  /** The floor's cooldowns, allowance and latch (see floorBudget.ts). */
  budget: boolean;
  /** What was wrong with the environment, for the start-up log. */
  warnings: string[];
}

export function floorConfig(env: Record<string, string | undefined> = process.env): FloorConfig {
  const warnings: string[] = [];
  const raw = (env.MINEBOT_FCA_REFLEXES ?? '').trim().toLowerCase();
  let mode: ReflexMode = 'default';
  if (raw === 'off' || raw === 'floor' || raw === 'default') mode = raw;
  else if (raw === 'extended') warnings.push('MINEBOT_FCA_REFLEXES=extended は default と同じになった（旧名）: default として扱う');
  else if (raw !== '') warnings.push(`MINEBOT_FCA_REFLEXES=${raw.slice(0, 20)} は未知の値: default として扱う`);
  const denied = new Set<ReflexName>();
  for (const part of (env.MINEBOT_FCA_REFLEX_OFF ?? '').split(',')) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if ((REFLEX_NAMES as readonly string[]).includes(name)) denied.add(name as ReflexName);
    else warnings.push(`MINEBOT_FCA_REFLEX_OFF の ${name.slice(0, 20)} は未知の名前: 無視する`);
  }
  const floor = mode !== 'off', full = mode === 'default';
  const allowed = (name: ReflexName) => floor && !denied.has(name);
  return {
    mode, denied: REFLEX_NAMES.filter(name => denied.has(name)), floor,
    retreat: allowed('retreat'), eat: allowed('eat'), armor: allowed('armor'),
    flee: full && !denied.has('flee'), pickup: full && !denied.has('pickup'),
    ledgerTag: !denied.has('ledger-tag'), combatKnowledge: full && !denied.has('combat'), budget: floor && !denied.has('budget'), warnings,
  };
}

/** The one start-up line: what the journal shows of the switch. */
export function describeFloorConfig(config: FloorConfig): string {
  const on = (['retreat', 'eat', 'armor', 'flee', 'pickup'] as const).filter(name => config[name]);
  const flag = (value: boolean) => value ? 'on' : 'off';
  return `🧱 床の反射: ${config.mode}（${on.join(',') || 'なし'}） 台帳=on タグ=${flag(config.ledgerTag)} 戦闘知識=${flag(config.combatKnowledge)} 予算=${flag(config.budget)} 拒否=[${config.denied.join(',')}]`;
}
