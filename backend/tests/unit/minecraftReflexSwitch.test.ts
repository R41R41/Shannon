import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { describeFloorConfig, floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { loadFloorLayer } from '../../src/services/minebot/utils/floorLayer.js';
import { LEDGER_SIZE, ReflexLedger, SUMMARY_MAX_CHARS, ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

describe('floorConfig (the reflex switch, P8; defaults changed 2026-10-19)', () => {
  it('runs everything P8 built when nothing is set: the floor, the flee, the combat knowledge, the tag and the budget', () => {
    const config = floorConfig({});
    expect(config).toMatchObject({ mode: 'default', floor: true, retreat: true, eat: true, flee: true, ledgerTag: true, combatKnowledge: true, budget: true, wideThreats: true });
    expect(config.warnings).toEqual([]); expect(config.denied).toEqual([]);
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: 'default' })).toEqual(config);
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: '  DEFAULT ' }).mode).toBe('default');
  });
  it('`floor` is exactly the 2026-10-16 production floor (65b4bd1): retreat and eat only, with no flee, no combat knowledge, no budget and its own list of enemy names (P8 third review, M3)', () => {
    const config = floorConfig({ MINEBOT_FCA_REFLEXES: 'floor' });
    expect(config).toMatchObject({ mode: 'floor', floor: true, retreat: true, eat: true, flee: false, combatKnowledge: false, budget: false, wideThreats: false });
    // Asking for the budget by name does not bring it back: it is not part of that floor.
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: 'floor', MINEBOT_FCA_REFLEX_OFF: 'ledger-tag' })).toMatchObject({ budget: false, wideThreats: false });
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: ' Floor ' })).toEqual(config);
    // The receipt's tag is the one thing of P8's reporting that can be taken away from it.
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: 'floor', MINEBOT_FCA_REFLEX_OFF: 'ledger-tag' })).toMatchObject({ ledgerTag: false, flee: false });
  });
  it('off is rollback only: no floor, no flee, no combat-knowledge providers; the receipt tag is still its own switch', () => {
    const config = floorConfig({ MINEBOT_FCA_REFLEXES: 'off' });
    expect(config).toMatchObject({ mode: 'off', floor: false, retreat: false, eat: false, flee: false, combatKnowledge: false, budget: false, wideThreats: false, ledgerTag: true });
  });
  it('the deny list removes flee, combat, budget, ledger-tag and the floor\'s three one by one, whatever the mode', () => {
    const only = (name: string) => floorConfig({ MINEBOT_FCA_REFLEX_OFF: name });
    expect(only('flee')).toMatchObject({ flee: false, combatKnowledge: true, retreat: true, eat: true, budget: true, ledgerTag: true });
    expect(only('combat')).toMatchObject({ combatKnowledge: false, flee: true, retreat: true, ledgerTag: true });
    expect(only('budget')).toMatchObject({ budget: false, flee: true, eat: true });
    expect(only('ledger-tag')).toMatchObject({ ledgerTag: false, flee: true, combatKnowledge: true });
    for (const name of ['retreat', 'eat'] as const) expect(only(name)).toMatchObject({ [name]: false, floor: true, flee: true });
  });
  it('reads the deny list once, normalised, and ignores what it does not know with a warning', () => {
    const config = floorConfig({ MINEBOT_FCA_REFLEX_OFF: ' Eat, flee,,ledger-tag,bogus ,eat' });
    expect(config).toMatchObject({ eat: false, retreat: true, flee: false, ledgerTag: false });
    expect(config.denied).toEqual(['eat', 'flee', 'ledger-tag']);
    expect(config.warnings.join(' ')).toContain('bogus');
    // Denying something that was off anyway changes nothing.
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: 'floor', MINEBOT_FCA_REFLEX_OFF: 'flee,combat' })).toMatchObject({ flee: false, combatKnowledge: false, retreat: true });
    expect(floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'retreat' })).toMatchObject({ retreat: false, eat: true, floor: true });
  });
  it('reads `extended` (the old name) as default, with a warning', () => {
    const config = floorConfig({ MINEBOT_FCA_REFLEXES: 'extended' });
    expect(config.mode).toBe('default'); expect(config.floor).toBe(true); expect(config.flee).toBe(true);
    expect(config.warnings[0]).toContain('extended'); expect(config.warnings[0].startsWith('‼')).toBe(false);
  });
  it('lands an unknown mode (a typo) on the production floor, never on all of P8 and never on off, with a loud warning (P8 third review, M4)', () => {
    for (const value of ['on', 'flor', 'deafult', 'true', '1', 'Extnded']) {
      const config = floorConfig({ MINEBOT_FCA_REFLEXES: value });
      expect(config.mode, value).toBe('floor'); expect(config.floor, value).toBe(true);
      expect(config).toMatchObject({ retreat: true, eat: true, flee: false, combatKnowledge: false, budget: false, wideThreats: false });
      expect(config.warnings, value).toHaveLength(1); expect(config.warnings[0].startsWith('‼'), value).toBe(true); expect(config.warnings[0]).toContain(value.toLowerCase());
      expect(config.warnings[0]).toContain('floor');
    }
    // The deny list still applies on top of it.
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: 'flor', MINEBOT_FCA_REFLEX_OFF: 'eat' })).toMatchObject({ mode: 'floor', eat: false, retreat: true });
    // An empty or blank value is no value.
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: '   ' }).warnings).toEqual([]);
  });
  it('splits the deny list at commas, spaces, semicolons, tabs and newlines, and says loudly which name it did not know (M4)', () => {
    for (const list of ['flee,combat', 'flee combat', 'flee;combat', ' flee ; combat ', 'flee, combat', 'FLEE\tCombat', 'flee\ncombat', 'flee,;  combat,']) {
      const config = floorConfig({ MINEBOT_FCA_REFLEX_OFF: list });
      expect(config.denied, JSON.stringify(list)).toEqual(['flee', 'combat']); expect(config.warnings, JSON.stringify(list)).toEqual([]);
      expect(config).toMatchObject({ flee: false, combatKnowledge: false, eat: true });
    }
    const config = floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'flee;pickpu eat,Armour' });
    expect(config.denied).toEqual(['eat', 'flee']);
    expect(config.warnings).toHaveLength(2);
    expect(config.warnings.every(warning => warning.startsWith('‼'))).toBe(true);
    expect(config.warnings.join(' ')).toContain('pickpu'); expect(config.warnings.join(' ')).toContain('armour');
    expect(config.flee).toBe(false); // the typo stopped nothing else, and it says so
  });
  it('says what is on in one start-up line', () => {
    expect(describeFloorConfig(floorConfig({}))).toBe('🧱 床の反射: default（retreat,eat,flee） 台帳=on タグ=on 戦闘知識=on 予算=on 拒否=[]');
    expect(describeFloorConfig(floorConfig({ MINEBOT_FCA_REFLEXES: 'floor' }))).toBe('🧱 床の反射: floor（retreat,eat） 台帳=on タグ=on 戦闘知識=off 予算=off 拒否=[]');
    expect(describeFloorConfig(floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'ledger-tag,flee' })))
      .toBe('🧱 床の反射: default（retreat,eat） 台帳=on タグ=off 戦闘知識=on 予算=on 拒否=[flee,ledger-tag]');
    expect(describeFloorConfig(floorConfig({ MINEBOT_FCA_REFLEXES: 'off' }))).toContain('off（なし）');
    expect(describeFloorConfig(floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'combat,budget' }))).toContain('戦闘知識=off 予算=off 拒否=[combat,budget]');
  });
});

describe('what the client loads for each setting (loadFloorLayer, run against a fake bot)', () => {
  /** A bot as far as the plugins need one: `loadPlugin` calls the plugin with it, as mineflayer does. */
  function loaded(env: Record<string, string | undefined>) {
    const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0, 65, 0) }, health: 20, food: 20, entities: {},
      inventory: { items: () => [], slots: [] }, setControlState: () => undefined, loadPlugin(plugin: (bot: unknown) => void) { plugin(this); } });
    const config = loadFloorLayer(bot, env);
    bot.emit('end');
    return { bot, config, installed: { ledger: !!bot.reflexLedger, floor: !!bot.floorReflexes, combat: !!bot.combatStats, budget: !!bot.floorReflexes?.budget } };
  }
  it('installs the whole layer by default', () => {
    expect(loaded({}).installed).toEqual({ ledger: true, floor: true, combat: true, budget: true });
  });
  it('installs the production floor alone for `floor`, and no floor at all for `off` (the ledger stays)', () => {
    expect(loaded({ MINEBOT_FCA_REFLEXES: 'floor' }).installed).toEqual({ ledger: true, floor: true, combat: false, budget: false });
    expect(loaded({ MINEBOT_FCA_REFLEXES: 'off' }).installed).toEqual({ ledger: true, floor: false, combat: false, budget: false });
  });
  it('removes exactly what the deny list names', () => {
    expect(loaded({ MINEBOT_FCA_REFLEX_OFF: 'combat' }).installed).toEqual({ ledger: true, floor: true, combat: false, budget: true });
    expect(loaded({ MINEBOT_FCA_REFLEX_OFF: 'budget' }).installed).toEqual({ ledger: true, floor: true, combat: true, budget: false });
  });
  it('the floor takes the config read here, so a denied flee is denied in the reflex itself and an allowed one runs', () => {
    const scared = (env: Record<string, string>) => {
      const { bot } = loaded(env);
      bot.health = 4; bot.entity.position = new Vec3(0, 65, 0); bot.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(2, 65, 0) } };
      bot.emit('physicsTick');
      return bot.floorReflexes.busy;
    };
    expect(scared({})).toBe('flee');
    expect(scared({ MINEBOT_FCA_REFLEX_OFF: 'flee' })).toBeNull();
    expect(scared({ MINEBOT_FCA_REFLEXES: 'floor' })).toBeNull();
  });
  it('is called by the client exactly when common-FCA mode is on', () => {
    const client = readFileSync(new URL('../../src/services/minebot/client.ts', import.meta.url), 'utf8');
    expect(client).toMatch(/if \(process\.env\.MINEBOT_COMMON_FCA === 'on'\) loadFloorLayer\(this\.bot\);/u);
    expect(client).toMatch(/import \{ loadFloorLayer \} from '\.\/utils\/floorLayer\.js';/u);
  });
});
describe('reflex ledger', () => {
  const clock = () => { let at = 1_000_000; return { now: () => at, advance: (ms: number) => { at += ms; } }; };
  it('keeps at most 16 and says nothing when empty', () => {
    const time = clock(), ledger = new ReflexLedger({}, time.now);
    expect(ledger.summary()).toBeUndefined();
    for (let i = 0; i < 40; i++) { ledger.note('eat', `食事${i}`); time.advance(10); }
    expect(ledger.entriesSince(-1)).toHaveLength(LEDGER_SIZE);
    expect(ledger.entriesSince(-1)[0].detail).toBe('食事24');
    expect(ledger.summary()!.counts.eat).toBe(40);
  });
  it('shows the last five within 180 seconds, newest first, and lets older ones expire', () => {
    const time = clock(), ledger = new ReflexLedger({}, time.now);
    ledger.note('retreat', '古い'); time.advance(181_000);
    expect(ledger.summary()).toBeUndefined();
    for (let i = 0; i < 7; i++) { ledger.note('armor', `防具${i}`); time.advance(5_000); }
    const summary = ledger.summary()!;
    expect(summary.recent).toHaveLength(5);
    expect(summary.recent.map(item => item.detail)).toEqual(['防具6', '防具5', '防具4', '防具3', '防具2']);
    expect(summary.recent[0].ageSec).toBe(5);
    expect(summary.counts.retreat).toBe(1);
  });
  it('keeps the summary within 500 characters however long the details are', () => {
    const time = clock(), ledger = new ReflexLedger({}, time.now);
    for (let i = 0; i < 16; i++) { ledger.note('eat', 'あ'.repeat(200) + i); time.advance(100); }
    expect(JSON.stringify(ledger.summary()).length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(ledger.summary()!.recent.length).toBeGreaterThan(0);
  });
  it('counts a plugin counter by its rises: one entry per rise, none for a level or a tick without one', () => {
    const time = clock();
    const bot: any = { shieldBlock: { raised: 3 }, fireballDeflect: { strikes: 0 }, knockBrace: { braced: 0 }, lavaReflex: { engagements: 0 }, breathingReflex: { engagements: 0 } };
    const ledger = new ReflexLedger(bot, time.now);
    // What was already counted when the ledger came is history.
    ledger.sample(); ledger.sample();
    expect(ledger.summary()).toBeUndefined();
    bot.shieldBlock.raised = 4; ledger.sample(); ledger.sample(); ledger.sample();
    expect(ledger.entriesSince(-1)).toHaveLength(1);
    expect(ledger.entriesSince(-1)[0]).toMatchObject({ kind: 'shield', detail: '盾を構えた', n: 1 });
    // Several rises close together are one entry with a count, not a flood.
    time.advance(500); bot.shieldBlock.raised = 6; ledger.sample();
    expect(ledger.entriesSince(-1)).toHaveLength(1);
    expect(ledger.entriesSince(-1)[0].n).toBe(3);
    // A later one, after the window, is a new entry; one tick with two kinds is two entries (one per kind).
    time.advance(10_000); bot.shieldBlock.raised = 7; bot.lavaReflex.engagements = 1; bot.fireballDeflect.strikes = 1; ledger.sample();
    expect(ledger.entriesSince(-1).map(entry => entry.kind).sort()).toEqual(['fireball', 'lava', 'shield', 'shield']);
    expect(ledger.summary()!.counts).toMatchObject({ shield: 4, lava: 1, fireball: 1 });
  });
  it('does not say a shield went up when the counter fell back or never moved (no false report)', () => {
    const bot: any = { shieldBlock: { raised: 5 } };
    const ledger = new ReflexLedger(bot);
    ledger.sample(); bot.shieldBlock.raised = 2; ledger.sample(); ledger.sample(); bot.shieldBlock.raised = undefined; ledger.sample();
    expect(ledger.entriesSince(-1)).toHaveLength(0);
  });
  it('records how a floor reflex ended, with health and food before and after', () => {
    const bot: any = { health: 8, food: 3 }, ledger = new ReflexLedger(bot);
    const handle = ledger.begin('eat', '食事（パン）');
    bot.health = 10; bot.food = 8;
    expect(ledger.end(handle, 'done')).toMatchObject({ kind: 'eat', outcome: 'done', hp: [8, 10], food: [3, 8] });
    const unchanged = ledger.begin('armor', '防具');
    expect(ledger.end(unchanged, 'cut')).not.toHaveProperty('hp');
  });
  it('says only what began after a mark (the note for a receipt), within 200 characters', () => {
    const bot: any = { health: 8, food: 3 }, ledger = new ReflexLedger(bot);
    ledger.note('retreat', '前の反射');
    const mark = ledger.mark();
    expect(ledger.noteSince(mark)).toBeNull();
    const handle = ledger.begin('eat', '食事（パン）'); bot.health = 10; ledger.end(handle, 'done');
    ledger.note('shield', '盾を構えた');
    const note = ledger.noteSince(mark)!;
    expect(note).toBe('［体の反射: 食事（パン） 体力8→10 / 盾を構えた］');
    for (let i = 0; i < 12; i++) ledger.note('eat', '長い説明'.repeat(8));
    expect(ledger.noteSince(mark)!.length).toBeLessThanOrEqual(200);
  });
  it('knows a reflex cut an action off only when it really aborted that capability after the mark', () => {
    const ledger = new ReflexLedger({});
    ledger.preempted('floor-eat', []);
    expect(ledger.preemptsSince(-1)).toHaveLength(0);
    const mark = ledger.mark();
    ledger.preempted('floor-eat', ['mine-block']);
    expect(ledger.cutOff(mark, 'mine-block')?.by).toBe('floor-eat');
    expect(ledger.cutOff(mark, 'move-to')).toBeUndefined();
    expect(ledger.cutOff(ledger.mark(), 'mine-block')).toBeUndefined();
  });
  it('is one ledger per body', () => {
    const bot: any = { on: () => undefined };
    expect(ensureReflexLedger(bot)).toBe(ensureReflexLedger(bot));
  });
});
