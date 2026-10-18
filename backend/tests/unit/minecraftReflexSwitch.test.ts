import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeFloorConfig, floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { LEDGER_SIZE, ReflexLedger, SUMMARY_MAX_CHARS, ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

describe('floorConfig (the reflex switch, P8)', () => {
  it('keeps today\'s floor when nothing is set, and adds no new movement', () => {
    const config = floorConfig({});
    expect(config).toMatchObject({ mode: 'floor', floor: true, retreat: true, eat: true, armor: true, flee: false, pickup: false, ledgerTag: true, combatKnowledge: true });
    expect(config.warnings).toEqual([]);
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: 'floor' })).toEqual(config);
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: '  FLOOR ' }).mode).toBe('floor');
  });
  it('off is rollback only: no floor, no new movement, no combat-knowledge providers; the receipt tag is still its own switch', () => {
    const config = floorConfig({ MINEBOT_FCA_REFLEXES: 'off' });
    expect(config).toMatchObject({ mode: 'off', floor: false, retreat: false, eat: false, armor: false, flee: false, pickup: false, combatKnowledge: false, ledgerTag: true });
  });
  it('extended adds the low-health flee and the idle pickup', () => {
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: 'extended' })).toMatchObject({ mode: 'extended', floor: true, retreat: true, flee: true, pickup: true });
  });
  it('reads the deny list once, normalised, and ignores what it does not know with a warning', () => {
    const config = floorConfig({ MINEBOT_FCA_REFLEXES: 'extended', MINEBOT_FCA_REFLEX_OFF: ' Eat, pickup,,ledger-tag,bogus ,eat' });
    expect(config).toMatchObject({ eat: false, retreat: true, armor: true, flee: true, pickup: false, ledgerTag: false });
    expect(config.denied).toEqual(['eat', 'pickup', 'ledger-tag']);
    expect(config.warnings.join(' ')).toContain('bogus');
    // Denying something that was off anyway changes nothing, and the floor's own reflexes can be denied one by one.
    expect(floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'retreat,armor' })).toMatchObject({ retreat: false, armor: false, eat: true, floor: true });
  });
  it('treats an unknown mode as floor, never as off', () => {
    const config = floorConfig({ MINEBOT_FCA_REFLEXES: 'on' });
    expect(config.mode).toBe('floor'); expect(config.floor).toBe(true);
    expect(config.warnings[0]).toContain('未知');
  });
  it('says what is on in one start-up line', () => {
    expect(describeFloorConfig(floorConfig({}))).toBe('🧱 床の反射: floor（retreat,eat,armor） 台帳=on タグ=on 戦闘知識=on 拒否=[]');
    expect(describeFloorConfig(floorConfig({ MINEBOT_FCA_REFLEXES: 'extended', MINEBOT_FCA_REFLEX_OFF: 'ledger-tag' })))
      .toBe('🧱 床の反射: extended（retreat,eat,armor,flee,pickup） 台帳=on タグ=off 戦闘知識=on 拒否=[ledger-tag]');
    expect(describeFloorConfig(floorConfig({ MINEBOT_FCA_REFLEXES: 'off' }))).toContain('off（なし）');
    expect(describeFloorConfig(floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'combat' }))).toContain('戦闘知識=off 拒否=[combat]');
  });
  it('loads the combat-knowledge providers by default (they restore what the legacy mode had), and `combat` alone removes them', () => {
    expect(floorConfig({}).combatKnowledge).toBe(true);
    expect(floorConfig({ MINEBOT_FCA_REFLEXES: 'extended' }).combatKnowledge).toBe(true);
    const without = floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'combat' });
    expect(without).toMatchObject({ combatKnowledge: false, retreat: true, eat: true, armor: true, ledgerTag: true });
    expect(without.denied).toEqual(['combat']);
    // The client loads the plugin exactly when the config says so.
    const client = readFileSync(new URL('../../src/services/minebot/client.ts', import.meta.url), 'utf8');
    expect(client).toMatch(/if \(reflexes\.combatKnowledge\) this\.bot\.loadPlugin\(combatKnowledgePlugin\)/u);
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
