/**
 * The body's reflex switch, read in one place (P8, 2026-10-17).
 *
 *   MINEBOT_FCA_REFLEXES unset or `floor`  today's behaviour: the floor's retreat, eat and armour reflexes (and the resident
 *                                           lava, breath, shield, knock and edge plugins), plus the reflex ledger, the
 *                                           `interrupted_by_reflex` tag and the combat-knowledge providers. No new movement.
 *   `off`                                   the floor is not loaded at all. For rollback only: the resident plugins stay, the
 *                                           ledger keeps counting them, the combat-knowledge providers are not installed.
 *   `extended`                              `floor` plus the two new motor reflexes: low-health immediate flee and idle pickup.
 *
 * MINEBOT_FCA_REFLEX_OFF is a comma separated deny list (retreat, eat, armor, flee, pickup, ledger-tag, combat). `combat` removes
 * the combat-knowledge providers alone (they are on by default: they restore what the legacy mode had). `ledger-tag` turns off
 * both the receipt's reflex note and the `interrupted_by_reflex` failure type, so an API that dislikes the new type can be
 * answered at once with the old `interrupted`.
 *
 * Read once at start up (a pure function of the environment), never per physics tick.
 */
export type ReflexMode = 'floor' | 'off' | 'extended';
export const REFLEX_NAMES = ['retreat', 'eat', 'armor', 'flee', 'pickup', 'ledger-tag', 'combat'] as const;
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
  /** Low-health immediate flee (extended only). */
  flee: boolean;
  /** Idle pickup of nearby drops (extended only). */
  pickup: boolean;
  /** The receipt's reflex note and the `interrupted_by_reflex` failure type. */
  ledgerTag: boolean;
  /** `bot.combatStats()` and the other combat-knowledge providers are installed. */
  combatKnowledge: boolean;
  /** What was wrong with the environment, for the start-up log. */
  warnings: string[];
}

export function floorConfig(env: Record<string, string | undefined> = process.env): FloorConfig {
  const warnings: string[] = [];
  const raw = (env.MINEBOT_FCA_REFLEXES ?? '').trim().toLowerCase();
  let mode: ReflexMode = 'floor';
  if (raw === 'off' || raw === 'extended' || raw === 'floor') mode = raw;
  else if (raw !== '') warnings.push(`MINEBOT_FCA_REFLEXES=${raw.slice(0, 20)} は未知の値: floor として扱う`);
  const denied = new Set<ReflexName>();
  for (const part of (env.MINEBOT_FCA_REFLEX_OFF ?? '').split(',')) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if ((REFLEX_NAMES as readonly string[]).includes(name)) denied.add(name as ReflexName);
    else warnings.push(`MINEBOT_FCA_REFLEX_OFF の ${name.slice(0, 20)} は未知の名前: 無視する`);
  }
  const floor = mode !== 'off';
  const allowed = (name: ReflexName) => floor && !denied.has(name);
  return {
    mode, denied: REFLEX_NAMES.filter(name => denied.has(name)), floor,
    retreat: allowed('retreat'), eat: allowed('eat'), armor: allowed('armor'),
    flee: mode === 'extended' && !denied.has('flee'), pickup: mode === 'extended' && !denied.has('pickup'),
    ledgerTag: !denied.has('ledger-tag'), combatKnowledge: mode !== 'off' && !denied.has('combat'), warnings,
  };
}

/** The one start-up line: what the journal shows of the switch. */
export function describeFloorConfig(config: FloorConfig): string {
  const on = (['retreat', 'eat', 'armor', 'flee', 'pickup'] as const).filter(name => config[name]);
  return `🧱 床の反射: ${config.mode}（${on.join(',') || 'なし'}） 台帳=on タグ=${config.ledgerTag ? 'on' : 'off'} 戦闘知識=${config.combatKnowledge ? 'on' : 'off'} 拒否=[${config.denied.join(',')}]`;
}
