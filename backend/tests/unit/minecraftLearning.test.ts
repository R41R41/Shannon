import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyConsolidation, applyReflection, assertGeneralKnowledgeText, attackReach, conditionsMatch, confidence, describeSituation, minecraftKnowledgeScope, restoreMergedLessons,
  describePace, parseReflection, recountLegacyEvidence, retrieveKnowledge, seedItems, type KnowledgeItem, type ObservationLike,
} from '../../src/modules/minecraftLearning/index.js';
import { MinecraftLearningService } from '../../src/services/minebot/learning/MinecraftLearningService.js';

const observation = (overrides: Partial<ObservationLike> = {}): ObservationLike => ({
  dimension: 'minecraft:overworld', position: { x: 10, y: 70, z: -4 }, health: 20, food: 20, oxygen: 20, isInWater: false,
  time: '15000', heldItem: 'stone_pickaxe', inventory: [{ name: 'cobblestone', count: 12 }],
  nearbyEntities: [{ name: 'zombie', kind: 'hostile', distance: 7 }, { name: 'cow', kind: 'passive', distance: 12 }],
  ...overrides,
});
const item = (overrides: Partial<KnowledgeItem>): KnowledgeItem => ({ id: 'k-1', kind: 'avoid', situation: '状況', advice: '助言',
  conditions: {}, source: 'reflection', provenance: [], support: 0, contradict: 0, uses: 0,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...overrides });

describe('world-independent situation and general knowledge', () => {
  it('describes time, depth, water and threats without coordinates', () => {
    const features = describeSituation(observation());
    expect(features).toMatchObject({ timeBand: 'night', depthBand: 'surface', inWater: false,
      threats: [{ name: 'zombie', distance: 7 }], others: ['cow'] });
    expect(JSON.stringify(features)).not.toContain('-4');
    expect(describeSituation(observation({ position: { x: 0, y: -20, z: 0 }, time: '1000' }))).toMatchObject({ timeBand: 'day', depthBand: 'deep' });
    // Day and night are the overworld's: at the same hour in the Nether nothing is said of the time
    // (lessons about the night, and waiting for morning, do not apply there).
    expect(describeSituation(observation({ dimension: 'overworld', time: '18000' })).timeBand).toBe('night');
    expect(describeSituation(observation({ dimension: 'the_nether', time: '18000' })).timeBand).toBe('unknown');
  });

  it('rejects world facts such as coordinates or URLs in stored text', () => {
    expect(() => assertGeneralKnowledgeText('(-72, 99, -44)の原木は崖の上')).toThrow('MINECRAFT_KNOWLEDGE_HAS_COORDINATES');
    expect(() => assertGeneralKnowledgeText('x=12 に村がある')).toThrow('MINECRAFT_KNOWLEDGE_HAS_COORDINATES');
    expect(() => assertGeneralKnowledgeText('https://example.com')).toThrow('MINECRAFT_KNOWLEDGE_HAS_URL');
    expect(() => assertGeneralKnowledgeText('夜の地上で敵が2体以上いたら地下へ移る')).not.toThrow();
  });

  it('matches only lessons whose stated conditions hold, preferring confident specific ones', () => {
    const features = describeSituation(observation());
    expect(conditionsMatch({ timeBands: ['night'], threatsPresent: true }, features)).toBe(true);
    expect(conditionsMatch({ inWater: true }, features)).toBe(false);
    expect(conditionsMatch({ tools: ['dig-shelter'] }, features, ['move-to'])).toBe(false);
    const items = [item({ id: 'general', support: 3 }), item({ id: 'specific', support: 3, conditions: { timeBands: ['night'] } }),
      item({ id: 'doubtful', contradict: 5, conditions: { timeBands: ['night'] } }), item({ id: 'water', conditions: { inWater: true } }),
      item({ id: 'retired', retired: true })];
    expect(retrieveKnowledge(items, features).map(entry => entry.item.id)).toEqual(['specific', 'general', 'doubtful']);
  });

  it('folds a reflection: new lessons, reinforcement instead of duplicates, and retirement of contradicted ones', () => {
    const state = { scope: minecraftKnowledgeScope('test-lab'), items: [
      item({ id: 'k-old', advice: '水辺へ逃げない', support: 0 }), item({ id: 'k-bad', advice: '夜でも地上を歩き回る', contradict: 2 })] };
    let n = 0;
    const summary = applyReflection(state, {
      lessons: [{ kind: 'avoid', situation: '敵から逃げる時', advice: '水辺へ逃げない。', conditions: { emergency: true } },
        { kind: 'prefer', situation: '水中で酸素が減った時', advice: '真上に泳いで水面で息をしてから陸へ上がる', conditions: { inWater: true, bogus: 1 } as any }],
      assessments: [{ id: 'k-bad', verdict: 'contradicted' }, { id: 'k-missing', verdict: 'supported' }],
    }, 'run-1:death', '2026-10-01T01:00:00.000Z', () => `k-new-${++n}`);
    expect(summary.reinforced).toEqual(['k-old']);
    expect(summary.added).toEqual(['k-new-1']);
    expect(summary.retired).toEqual(['k-bad']);
    expect(state.items.find(entry => entry.id === 'k-new-1')?.conditions).toEqual({ inWater: true });
    expect(confidence(state.items[0])).toBeCloseTo(2 / 3);
  });

  it('counts each run once: repeated confirmations within a run do not inflate confidence, a later failure overrides', () => {
    const state = { scope: minecraftKnowledgeScope('test-lab'), items: [item({ id: 'k-a', support: 1, contradict: 0, evidence: {} })] };
    const reflect = (provenance: string, verdict: 'supported' | 'contradicted') =>
      applyReflection(state, { lessons: [], assessments: [{ id: 'k-a', verdict }] }, provenance, '2026-10-01T01:00:00.000Z', () => 'k-x');
    for (const n of [1, 2, 3]) reflect(`run-1:milestone:${n}`, 'supported');
    expect(state.items[0]).toMatchObject({ support: 2, contradict: 0 });
    reflect('run-1:death:4', 'contradicted');
    expect(state.items[0]).toMatchObject({ support: 1, contradict: 1 });
    reflect('run-1:run_end:5', 'supported');
    expect(state.items[0]).toMatchObject({ support: 1, contradict: 1 });
    reflect('run-2:milestone:6', 'supported');
    expect(state.items[0]).toMatchObject({ support: 2, contradict: 1, evidence: { 'run-1': 'contradicted', 'run-2': 'supported' } });
  });

  it('re-bases counts kept before per-run evidence to the runs that touched each item', () => {
    const provenance = ['r1:milestone:a', 'r1:milestone:b', 'r1:stall:c', 'r2:run_end:d', 'r3:consolidation:e'];
    const state = { scope: minecraftKnowledgeScope('test-lab'), items: [
      item({ id: 'seed-x', source: 'human-seed', support: 33, contradict: 3, provenance }), item({ id: 'k-new', support: 2, evidence: { r9: 'supported' } })] };
    expect(recountLegacyEvidence(state)).toEqual(['seed-x']);
    expect(state.items[0]).toMatchObject({ support: 2, contradict: 2, evidence: {} });
    expect(state.items[1]).toMatchObject({ support: 2 });
  });

  it('merges only what says the same thing in the same situation, and never sums a run twice', () => {
    const fresh = () => ({ scope: minecraftKnowledgeScope('test-lab'), items: [
      item({ id: 'k-night', advice: '夜は乾いた地面の遮蔽へ退避する', conditions: { timeBands: ['night'] }, support: 2, evidence: { r1: 'supported', r2: 'supported' } }),
      item({ id: 'k-night2', advice: '夜は乾いた地面の遮蔽に入る', conditions: { timeBands: ['night'] }, support: 1, evidence: { r1: 'supported', r3: 'contradicted' }, contradict: 1 }),
      item({ id: 'k-water', advice: '水中では岸へ戻る', conditions: { inWater: true }, support: 1, evidence: { r1: 'supported' } }),
      item({ id: 'k-tools', advice: '木のつるはしは板材3枚と棒2本で作る', support: 1, evidence: { r2: 'supported' },
        conditions: { dimensions: ['overworld'], timeBands: ['day'], carryingAny: ['oak_log'], threatsPresent: false } })] });
    const merge = (ids: string[], conditions: unknown, advice = '夜は乾いた地面の遮蔽へ退避する') => {
      const state = fresh();
      return { state, result: applyConsolidation(state, [{ ids, kind: 'avoid', situation: '夜の地上', advice, conditions }],
        'r4:consolidation:x', '2026-10-01T02:00:00.000Z', () => 'k-merged') };
    };
    // The same lesson twice: one item, each run counted once, a later contradiction kept.
    const same = merge(['k-night', 'k-night2'], { timeBands: ['night'] });
    expect(same.result.merged).toHaveLength(1);
    expect(same.state.items.find(entry => entry.id === 'k-merged')).toMatchObject({ support: 2, contradict: 1 });
    // Different situations folded into something that holds everywhere, or elsewhere.
    expect(merge(['k-night', 'k-water'], {}).result.rejected[0]).toContain('MINECRAFT_CONSOLIDATION_OVERGENERAL');
    expect(merge(['k-night', 'k-water'], { threatsPresent: true }).result.rejected[0]).toContain('MINECRAFT_CONSOLIDATION_BROADENS:drops timeBands');
    // The situation widened: a value none of... one source did not allow, or two of a specific lesson's conditions dropped.
    expect(merge(['k-night', 'k-night2'], { timeBands: ['night', 'dusk'] }).result.rejected[0]).toContain('timeBands wider than k-night');
    expect(merge(['k-night', 'k-tools'], { dimensions: ['overworld'], timeBands: ['night'] }).result.rejected[0]).toContain('BROADENS');
    // Several pieces of advice strung together.
    expect(merge(['k-night', 'k-night2'], { timeBands: ['night'] },
      '行動の前に所持品・設備・足場・経路・退路・目標の状態を確認し、夜は乾いた地面の遮蔽へ退避し、水辺を避け、敵の位置を確かめ、道具の耐久も見る').result.rejected[0])
      .toContain('advice longer than any source');
    // A narrower situation is allowed, and a specific lesson may lose one of its many conditions to a true duplicate.
    expect(merge(['k-night', 'k-night2'], { timeBands: ['night'], threatsPresent: true }).result.merged).toHaveLength(1);
    const five = fresh();
    five.items.push(item({ id: 'k-tools2', advice: '木のつるはしは板材3と棒2', conditions: { dimensions: ['overworld'], timeBands: ['day'], carryingAny: ['oak_log'] } }));
    expect(applyConsolidation(five, [{ ids: ['k-tools', 'k-tools2'], kind: 'procedure', situation: '序盤', advice: '木のつるはしは板材3枚と棒2本で作る',
      conditions: { dimensions: ['overworld'], timeBands: ['day'], carryingAny: ['oak_log'] } }], 'r4:consolidation:y', '2026-10-01T02:00:00.000Z', () => 'k-m2').merged).toHaveLength(1);
    const many = fresh();
    for (let i = 0; i < 4; i++) many.items.push(item({ id: `k-n${i}`, advice: '夜は乾いた地面の遮蔽へ退避する', conditions: { timeBands: ['night'] } }));
    expect(applyConsolidation(many, [{ ids: ['k-night', 'k-n0', 'k-n1', 'k-n2', 'k-n3'], kind: 'avoid', situation: '夜', advice: '夜は乾いた地面の遮蔽へ退避する',
      conditions: { timeBands: ['night'] } }], 'r4:consolidation:z', '2026-10-01T02:00:00.000Z', () => 'k-m3').rejected[0]).toContain('GROUP_TOO_LARGE');
  });

  it('brings back the specific lessons that generalising merges had folded away (450 lessons had become 26)', () => {
    const state: any = { scope: minecraftKnowledgeScope('test-lab'), items: [
      item({ id: 'leaf-1', advice: '木のつるはしは板材3枚と棒2本', retired: true, mergedInto: 'mid', support: 1, evidence: { r1: 'supported' } }),
      item({ id: 'leaf-2', advice: '原木1個で板材4枚', retired: true, mergedInto: 'mid', support: 1, evidence: { r2: 'supported' } }),
      item({ id: 'mid', advice: 'レシピの数量を確認する', retired: true, mergedInto: 'blob', support: 2 }),
      item({ id: 'leaf-3', advice: '夜は水辺へ逃げない', retired: true, mergedInto: 'blob', support: 1 }),
      item({ id: 'blob', advice: '行動の前にすべてを確認する', support: 13, contradict: 10, uses: 7742 }),
      item({ id: 'plain', advice: '鉄は精錬前に燃料を数える', support: 3 }),
      item({ id: 'disproved', advice: '夜でも走り続ける', retired: true, support: 0, contradict: 4 }),
      item({ id: 'seed-night-surface', source: 'human-seed', retired: true, support: 1, contradict: 2 })] };
    const result = restoreMergedLessons(state, '2026-10-01T10:00:00.000Z');
    const active = state.items.filter((entry: KnowledgeItem) => !entry.retired).map((entry: KnowledgeItem) => entry.id).sort();
    expect(active).toEqual(['leaf-1', 'leaf-2', 'leaf-3', 'plain', 'seed-night-surface']);
    expect(result.retiredProducts).toEqual(['blob']);
    expect(state.items.find((entry: KnowledgeItem) => entry.id === 'leaf-1')).toMatchObject({ support: 1, evidence: { r1: 'supported' } });
    expect(state.items.find((entry: KnowledgeItem) => entry.id === 'leaf-1').mergedInto).toBeUndefined();
    expect(restoreMergedLessons(state, '2026-10-01T11:00:00.000Z')).toMatchObject({ restored: [], retiredProducts: [] }); // idempotent
  });

  it('parses a reply with prose around the JSON, dropping lessons with world facts and unknown ids', () => {
    const reply = '振り返りです:\n{"lessons":[{"kind":"avoid","situation":"(-3, 5, -60)付近","advice":"掘る","conditions":{}},'
      + '{"kind":"prefer","situation":"地下で鉄を探す時","advice":"Y=16前後を水平に掘り進む","conditions":{"depthBands":["cave"]}}],'
      + '"assessments":[{"id":"seed-night-surface","verdict":"supported"},{"id":"nope","verdict":"supported"}]}\n以上';
    const parsed = parseReflection(reply, new Set(['seed-night-surface']));
    expect(parsed.lessons.map(lesson => lesson.advice)).toEqual(['Y=16前後を水平に掘り進む']);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.assessments).toEqual([{ id: 'seed-night-surface', verdict: 'supported', reason: undefined }]);
  });
});

describe('MinecraftLearningService', () => {
  const directories: string[] = [];
  afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-learning-')); directories.push(dir); return dir; };
  const bot = (time = 15000) => Object.assign(new EventEmitter(), {
    username: 'MinebotTrial', health: 20, food: 20, oxygenLevel: 20, time: { timeOfDay: time }, game: { dimension: 'minecraft:overworld' },
    entity: { position: { x: 0, y: 70, z: 0 }, isInWater: false }, entities: {}, inventory: { items: () => [] }, heldItem: null,
  });
  const reply = (json: unknown) => ({ messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(json) }] })) } });

  it('seeds human knowledge once, injects only matching lessons in feedback mode, and stays silent in shadow mode', () => {
    const directory = tempDir();
    const feedback = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'r1' });
    const night = feedback.promptSection(bot(15000), { emergency: false, recentTools: [] });
    expect(night).toContain('seed-night-surface');
    expect(night).toContain('人間の初期知識');
    expect(feedback.promptSection(bot(1000), { emergency: false, recentTools: [] })).not.toContain('seed-night-surface');
    const shadow = new MinecraftLearningService({ mode: 'shadow', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'r2' });
    expect(shadow.promptSection(bot(15000), { emergency: false, recentTools: [] })).toBeNull();
    const stored = JSON.parse(fs.readFileSync(path.join(directory, 'knowledge.json'), 'utf8'));
    expect(stored.items.filter((entry: KnowledgeItem) => entry.id === 'seed-night-surface')).toHaveLength(1);
    expect(fs.readFileSync(path.join(directory, 'experience', 'r2.jsonl'), 'utf8')).toContain('"mode":"shadow"');
  });

  it('reflects after repeated physical failures and stores the lesson for the next world', async () => {
    const directory = tempDir();
    const client = reply({ lessons: [{ kind: 'avoid', situation: '同じ高い場所の資源に何度も届かない時',
      advice: '別の場所の同じ資源を探す', conditions: { tools: ['mine-block'] } }], assessments: [] });
    const service = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'r1', modelClient: client as any });
    const actor = bot(1000);
    for (let i = 0; i < 6; i++) service.recordAction(actor, { tool: 'mine-block', args: { blockName: 'oak_log' }, success: false,
      failureType: 'movement_failed', result: '移動失敗', durationMs: 30000, emergency: false });
    service.recordAction(actor, { tool: 'get-position', args: {}, success: true, failureType: null, result: 'ok', durationMs: 1, emergency: false });
    await service.flush(5000);
    expect(client.messages.create).toHaveBeenCalledOnce();
    expect(service.summary()).toMatchObject({ reflections: 1, added: 1, learnedItems: 1 });
    const nextWorld = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'r2' });
    expect(nextWorld.promptSection(bot(1000), { emergency: false, recentTools: ['mine-block'] })).toContain('別の場所の同じ資源を探す');
  });

  it('reflects on a death message from the server and keeps parallel writers consistent', async () => {
    const directory = tempDir();
    const a = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'a',
      modelClient: reply({ lessons: [{ kind: 'avoid', situation: '地下の水たまりで酸素が減る時', advice: '水中で採掘を続けず先に水から出る', conditions: { inWater: true } }], assessments: [] }) as any });
    const b = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'b',
      modelClient: reply({ lessons: [{ kind: 'avoid', situation: '夜の地上でゾンビに追われる時', advice: '開けた場所で背を向け続けない', conditions: { timeBands: ['night'] } }], assessments: [] }) as any });
    const botA = bot(); const botB = bot();
    a.attach(botA); b.attach(botB);
    botA.emit('messagestr', 'MinebotTrial drowned');
    botB.emit('messagestr', 'MinebotTrial was slain by Zombie');
    botA.emit('messagestr', '<MinebotTrial> was this a chat?');
    await Promise.all([a.flush(5000), b.flush(5000)]);
    const stored = JSON.parse(fs.readFileSync(path.join(directory, 'knowledge.json'), 'utf8')).items
      .filter((entry: KnowledgeItem) => entry.source === 'reflection').map((entry: KnowledgeItem) => entry.advice).sort();
    expect(stored).toEqual(['水中で採掘を続けず先に水から出る', '開けた場所で背を向け続けない'].sort());
    expect(fs.existsSync(path.join(directory, 'knowledge.json.lock'))).toBe(false);
  });

  it('reflects on advancements and on long stretches without any new item, whatever the cause', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const directory = tempDir();
      const client = reply({ lessons: [], assessments: [] });
      const service = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'r', modelClient: client as any });
      const actor = bot(1000);
      service.attach(actor);
      actor.emit('messagestr', 'MinebotTrial has made the advancement [Stone Age]');
      await service.flush(5000);
      expect(client.messages.create).toHaveBeenCalledTimes(1);
      expect((client.messages.create.mock.calls[0] as any)[0].messages[0].content).toContain('milestone');
      const ok = { tool: 'move-to', args: {}, success: true, failureType: null, result: 'ok', durationMs: 1, emergency: false };
      service.recordAction(actor, ok);
      vi.setSystemTime(Date.now() + 9 * 60_000);
      service.recordAction(actor, ok);
      await service.flush(5000);
      expect(client.messages.create).toHaveBeenCalledTimes(2);
      expect((client.messages.create.mock.calls[1] as any)[0].messages[0].content).toContain('新しい種類のアイテムも実績も得られていない');
    } finally { vi.useRealTimers(); }
  });

  it('folds duplicate lessons into one that keeps their evidence once per run', async () => {
    const directory = tempDir();
    const lessons = Array.from({ length: 6 }, (_, i) => ({ kind: 'avoid', situation: `夜に水辺でドラウンドに襲われる状況${i}`,
      advice: `夜は水辺から離れて乾いた地面の遮蔽へ退避する(${i})`, conditions: { timeBands: ['night'] } }));
    let reflections = 0;
    const client = { messages: { create: vi.fn(async (request: any) => {
      if (request.system.includes('記憶の整理')) {
        const ids = [...request.messages[0].content.matchAll(/\[(k-[^\]]+)\]/g)].map((m: RegExpMatchArray) => m[1]);
        // Two groups of true duplicates, each spanning both runs.
        const group = (members: string[]) => ({ ids: members, kind: 'avoid', situation: '夜の水辺で水棲の敵がいる時',
          advice: '水辺を離れ、乾いた地面の遮蔽へ退避する', conditions: { timeBands: ['night'], threatsPresent: true } });
        return { content: [{ type: 'text', text: JSON.stringify({ merges: [group([ids[0], ids[3], ids[4]]), group([ids[1], ids[2], ids[5]])] }) }] };
      }
      const batch = lessons.slice(reflections * 3, reflections * 3 + 3);
      reflections++;
      return { content: [{ type: 'text', text: JSON.stringify({ lessons: batch, assessments: [] }) }] };
    }) } };
    // Two runs, three lessons each: six lessons, but two runs of evidence.
    const first = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'r1', modelClient: client as any });
    await first.reflect(bot(), 'death', 'テスト1');
    expect(first.summary()).toMatchObject({ consolidations: 0 }); // only 3 new lessons yet
    const service = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'r2', modelClient: client as any });
    await service.reflect(bot(), 'run_end', 'テスト2');
    const items = JSON.parse(fs.readFileSync(path.join(directory, 'knowledge.json'), 'utf8')).items as KnowledgeItem[];
    const merged = items.filter(item => item.advice === '水辺を離れ、乾いた地面の遮蔽へ退避する');
    expect(merged).toHaveLength(2);
    for (const entry of merged) {
      expect(entry).toMatchObject({ support: 2, contradict: 0, conditions: { timeBands: ['night'], threatsPresent: true },
        evidence: { r1: 'supported', r2: 'supported' } });
      expect(items.filter(item => item.mergedInto === entry.id && item.retired)).toHaveLength(3);
    }
    expect(service.summary()).toMatchObject({ consolidations: 1, merged: 6, learnedItems: 2 });
  });

  it('traces a late death back to advice shown long before, with the run\'s course (paid run L11 starved)', async () => {
    const directory = tempDir();
    const client = reply({ lessons: [], assessments: [] });
    const service = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'r', modelClient: client as any });
    const actor = bot(1000);
    expect(service.promptSection(actor, { emergency: false, recentTools: [] })).toContain('seed-food-not-yet'); // shown while fed
    for (let i = 0; i < 84; i++) { // more events than the recent window holds
      actor.food = Math.max(0, 20 - Math.floor(i / 4));
      service.recordAction(actor, { tool: 'get-health', args: {}, success: true, failureType: null, result: 'ok', durationMs: 1, emergency: false });
    }
    await service.reflect(actor, 'death', '死亡メッセージ: MinebotTrial was slain by Zombie');
    const message = (client.messages.create.mock.calls[0][0] as any).messages[0].content as string;
    expect(message).toContain('[seed-food-not-yet]');
    expect(message).toContain('この試行で1回表示');
    expect(message).toContain('## この試行の経過');
    expect(message).toMatch(/food=20[\s\S]*food=0/);
  });

  it('shares measured combat statistics across runs and keeps priors in memory when off', () => {
    const directory = tempDir();
    const first = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'a' });
    const memory = first.encounterMemory();
    memory.recordHit('zombie', 3); memory.recordContact('zombie', 1000);
    memory.recordFight('iron_pickaxe', 'zombie', { killed: true, elapsedMs: 1500 });
    memory.flush();
    const second = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'b' });
    const stats = second.encounterMemory().stats();
    expect(stats.weapons['iron_pickaxe|zombie']).toEqual({ fights: 1, kills: 1, killMs: 1500 });
    expect(stats.mobs.zombie.hits).toBe(2); // one prior pseudo-hit plus one observed
    // How far a kind has hit from is kept across runs too, as the farthest seen.
    const reaching = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'r1' });
    reaching.encounterMemory().recordHit('skeleton', 4, 11.4); reaching.encounterMemory().recordHit('skeleton', 4, 15.26); reaching.encounterMemory().recordHit('skeleton', 3);
    reaching.encounterMemory().flush();
    const later = new MinecraftLearningService({ mode: 'feedback', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'r2' });
    later.encounterMemory().recordHit('skeleton', 4, 9);
    expect(later.encounterMemory().stats().mobs.skeleton.reach).toBe(15.3);
    expect(attackReach(later.encounterMemory().stats(), 'skeleton')).toBe(15.3);
    expect(attackReach(later.encounterMemory().stats(), 'zombie')).toBe(0); // never hit from afar
    reaching.encounterMemory().dispose(); later.encounterMemory().dispose();
    first.encounterMemory().dispose(); second.encounterMemory().dispose();
    const off = new MinecraftLearningService({ mode: 'off', scope: minecraftKnowledgeScope('test-lab'), directory: tempDir(), runId: 'c' });
    expect(off.encounterMemory().stats().weapons['stone_sword|*']).toBeDefined();
  });

  it('does nothing at all when off', () => {
    const directory = tempDir();
    const service = new MinecraftLearningService({ mode: 'off', scope: minecraftKnowledgeScope('test-lab'), directory, runId: 'r' });
    expect(service.promptSection(bot(), { emergency: false, recentTools: [] })).toBeNull();
    service.recordAction(bot(), { tool: 'mine-block', args: {}, success: false, failureType: 'x', result: '', durationMs: 1, emergency: false });
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('keeps places for knowledge that has not been tried yet, so new teaching reaches the planner', () => {
    const features = describeSituation(observation({ time: '6000',
      nearbyEntities: [{ name: 'sheep', kind: 'passive', distance: 9 }, { name: 'cow', kind: 'passive', distance: 12 }] }));
    // Twelve established lessons that all match and all outscore a fresh, untested one.
    const established = Array.from({ length: 12 }, (_, index) => item({ id: `old-${index}`, support: 4 + index % 3, uses: 40,
      conditions: { dimensions: ['overworld'], timeBands: ['day'] } }));
    const taught = seedItems('2026-10-01T00:00:00.000Z');
    const shown = retrieveKnowledge([...established, ...taught], features).map(entry => entry.item.id);
    expect(shown).toHaveLength(8);
    // Matching taught advice keeps up to three places at the front (see the taught slots); the rest go by score.
    expect(shown.filter(id => id.startsWith('seed-')).length).toBeGreaterThanOrEqual(1);
    expect(shown.filter(id => id.startsWith('old-')).length).toBeGreaterThanOrEqual(3);   // three taught at the front, two kept for the least tried
    expect(shown).toContain('seed-bed-from-sheep');
    // Without sheep in sight the sheep advice does not apply; the village advice applies when a village is in view.
    const noSheep = describeSituation(observation({ time: '6000', nearbyEntities: [{ name: 'cow', kind: 'passive', distance: 12 }] }));
    expect(conditionsMatch({ othersAny: ['sheep'] }, noSheep)).toBe(false);
    const idsFor = (features: typeof noSheep) => retrieveKnowledge([...established, ...taught], features).map(entry => entry.item.id);
    expect(idsFor(noSheep)).not.toContain('seed-bed-from-sheep');
    expect(idsFor(noSheep)).not.toContain('seed-village-in-sight');
    expect(idsFor({ ...noSheep, landmarks: ['village'] })).toContain('seed-village-in-sight');
    // Once tested as much as the rest, it competes on its score like any other lesson.
    const tested = taught.map(entry => ({ ...entry, support: 1, contradict: 6, uses: 60 }));
    expect(retrieveKnowledge([...established, ...tested], features).map(entry => entry.item.id)).not.toContain('seed-bed-from-sheep');
    // A short list is returned whole, in score order.
    expect(retrieveKnowledge(established.slice(0, 3), features)).toHaveLength(3);
  });

  it('shows only a few of the lessons that match everywhere, leaving room for what this situation calls up', () => {
    const features = describeSituation(observation({ time: '6000' }));
    const general = Array.from({ length: 7 }, (_, index) => item({ id: `general-${index}`, support: 9, conditions: { dimensions: ['overworld'] } }));
    const situational = Array.from({ length: 6 }, (_, index) => item({ id: `here-${index}`, support: 1, uses: 5,
      conditions: { dimensions: ['overworld'], timeBands: ['day'], carryingAny: ['cobblestone'] } }));
    const byScore = retrieveKnowledge([...general, ...situational], features).map(entry => entry.item.id);
    const alwaysOn = new Set(general.map(entry => entry.id));
    const shown = retrieveKnowledge([...general, ...situational], features, { alwaysOn }).map(entry => entry.item.id);
    expect(shown.filter(id => id.startsWith('general-'))).toHaveLength(3);
    expect(shown.filter(id => id.startsWith('here-'))).toHaveLength(5);
    expect(byScore.filter(id => id.startsWith('here-'))).toHaveLength(2); // by score alone the general ones crowd them out

    // The service measures "matches everywhere" on its own calls: day and night alternate, the general lesson matches both.
    const directory = tempDir();
    const scope = minecraftKnowledgeScope('test-lab');
    fs.writeFileSync(path.join(directory, 'knowledge.json'), JSON.stringify({ scope, items: [
      ...Array.from({ length: 9 }, (_, index) => item({ id: `k-general-${index}`, support: 9, conditions: { dimensions: ['overworld'] },
        evidence: Object.fromEntries(Array.from({ length: 9 }, (_, run) => [`r${run}`, 'supported' as const])) })),
      ...Array.from({ length: 6 }, (_, index) => item({ id: `k-night-${index}`, support: 1, evidence: { r0: 'supported' }, conditions: { timeBands: ['night'], dimensions: ['overworld'] } }))] }));
    const service = new MinecraftLearningService({ mode: 'feedback', scope, directory, runId: 'r1' });
    let last = '';
    for (let call = 0; call < 24; call++) last = service.promptSection(bot(call % 2 ? 15000 : 1000), { emergency: false, recentTools: [] }) ?? '';
    last = service.promptSection(bot(15000), { emergency: false, recentTools: [] }) ?? '';
    expect((last.match(/k-general-/g) ?? []).length).toBe(3);
    expect((last.match(/k-night-/g) ?? []).length).toBeGreaterThanOrEqual(3); // the rest go to untried night seeds
    expect(last).toContain('人間の初期知識');
  });

  it('adds newly taught seeds to a store that already exists, once, and leaves what experience did to old ones', () => {
    const directory = tempDir();
    const scope = minecraftKnowledgeScope('test-lab');
    fs.mkdirSync(directory, { recursive: true });
    const old = seedItems('2026-09-01T00:00:00.000Z').filter(entry => entry.id === 'seed-night-surface')
      .map(entry => ({ ...entry, support: 2, contradict: 1, evidence: { a: 'supported', b: 'supported', c: 'contradicted' } }));
    const retired = seedItems('2026-09-01T00:00:00.000Z').filter(entry => entry.id === 'seed-no-fish-chasing').map(entry => ({ ...entry, retired: true }));
    fs.writeFileSync(path.join(directory, 'knowledge.json'), JSON.stringify({ scope, items: [...old, ...retired] }));
    const service = new MinecraftLearningService({ mode: 'feedback', scope, directory, runId: 'r1' });
    service.promptSection(bot(15000), { emergency: false, recentTools: [] });
    new MinecraftLearningService({ mode: 'feedback', scope, directory, runId: 'r2' });
    const stored: KnowledgeItem[] = JSON.parse(fs.readFileSync(path.join(directory, 'knowledge.json'), 'utf8')).items;
    for (const id of ['seed-bed-from-sheep', 'seed-village-in-sight', 'seed-sleep-through-night'])
      expect(stored.filter(entry => entry.id === id)).toHaveLength(1);
    expect(stored.find(entry => entry.id === 'seed-night-surface')).toMatchObject({ support: 2, contradict: 1 });
    expect(stored.find(entry => entry.id === 'seed-no-fish-chasing')?.retired).toBe(true);
    // A reworded seed replaces the old wording only while that has not been tested.
    const reworded = stored.map(entry => entry.id === 'seed-village-in-sight' ? { ...entry, advice: '旧い文面', conditions: { timeBands: ['day'] } }
      : entry.id === 'seed-bed-from-sheep' ? { ...entry, advice: '試された旧い文面', support: 1, evidence: { r9: 'supported' } } : entry);
    fs.writeFileSync(path.join(directory, 'knowledge.json'), JSON.stringify({ scope, items: reworded }));
    new MinecraftLearningService({ mode: 'feedback', scope, directory, runId: 'r3' });
    const after: KnowledgeItem[] = JSON.parse(fs.readFileSync(path.join(directory, 'knowledge.json'), 'utf8')).items;
    expect(after.find(entry => entry.id === 'seed-village-in-sight')).toMatchObject({ conditions: { landmarksAny: ['village'] } });
    expect(after.find(entry => entry.id === 'seed-bed-from-sheep')?.advice).toBe('試された旧い文面');
  });

  it('migrated the strategy rules out of code into human-seeded knowledge', () => {
    const ids = seedItems('2026-10-01T00:00:00.000Z').map(entry => entry.id);
    expect(ids).toEqual(expect.arrayContaining(['seed-night-surface', 'seed-food-not-yet', 'seed-no-fish-chasing', 'seed-emergency-no-water']));
    const executor = fs.readFileSync(path.resolve('src/services/llm/graph/ShannonExecutor.ts'), 'utf8');
    expect(executor).not.toContain('空腹度に余裕がある（14以上）');
    expect(executor).not.toContain('夜の地上は敵が多い');
  });
});

describe('the observation says when the body stands closed in (paid run L70 asked for a shelter from inside one)', () => {
  it('sealedInShelter appears only while every side is solid', async () => {
    const { captureWorldObservation } = await import('../../src/services/minebot/cognition/worldFrame.js');
    const { Vec3 } = await import('vec3');
    const shaft = (roof: boolean) => (pos: any) => pos.x === 0 && pos.z === 0 && (pos.y === 62 || pos.y === 63 || (!roof && pos.y === 64))
      ? { name: 'air', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' };
    const body = (roof: boolean) => ({ entity: { position: new Vec3(0.5, 62, 0.5), isInWater: false }, health: 20, food: 20,
      inventory: { items: () => [] }, entities: {}, blockAt: shaft(roof) });
    expect(captureWorldObservation(body(true)).sealedInShelter).toBe(true);
    expect('sealedInShelter' in captureWorldObservation(body(false))).toBe(false);
    expect('sealedInShelter' in captureWorldObservation({ selfState: { botPosition: { x: 0, y: 62, z: 0 } } })).toBe(false);
  });
});

describe("the observation says what the body's reserves come to (paid runs L64, L65, L70 went back to work with nothing left)", () => {
  it('time to dark and to light, whether health comes back, food in the pack, and hits left by measured damage', async () => {
    const { captureWorldObservation } = await import('../../src/services/minebot/cognition/worldFrame.js');
    const { Vec3 } = await import('vec3');
    const body = (timeOfDay: number, health: number, food: number, extra: Record<string, unknown> = {}) => ({
      entity: { id: 1, position: new Vec3(0.5, 64, 0.5), isInWater: false }, health, food, time: { timeOfDay },
      inventory: { items: () => [{ name: 'cooked_beef', count: 3 }, { name: 'cobblestone', count: 40 }, { name: 'bread', count: 1 }] },
      registry: { foodsByName: { cooked_beef: {}, bread: {} }, entitiesByName: { zombie: { type: 'hostile' }, skeleton: { type: 'hostile' } } },
      entities: { 2: { id: 2, name: 'zombie', position: new Vec3(6.5, 64, 0.5) }, 3: { id: 3, name: 'skeleton', position: new Vec3(0.5, 64, 12.5) } },
      combatStats: () => ({ mobs: { zombie: { hits: 4, damage: 12 }, skeleton: { hits: 2, damage: 9 } } }), ...extra });
    // Late afternoon, hurt and hungry: 100 seconds to dark, no regeneration, 4 things to eat, two skeleton hits left.
    expect(captureWorldObservation(body(11000, 7, 9)).margin).toEqual({ darkInSeconds: 100, regenerating: false, foodItems: 4, hitsLeft: { from: 'skeleton', hits: 2 } });
    // Night: dark now, 250 seconds to morning. Fed and whole.
    expect(captureWorldObservation(body(18000, 20, 20)).margin).toMatchObject({ darkInSeconds: 0, lightInSeconds: 250, regenerating: true, hitsLeft: { from: 'skeleton', hits: 5 } });
    // Nothing hostile near: no hits to count. No measurements: nothing said about hits.
    expect('hitsLeft' in captureWorldObservation(body(1000, 20, 20, { entities: {} })).margin!).toBe(false);
    expect('hitsLeft' in captureWorldObservation(body(1000, 20, 20, { combatStats: undefined })).margin!).toBe(false);
    // A cached self-state is not a live body: no margin.
    expect('margin' in captureWorldObservation({ selfState: { botPosition: { x: 0, y: 64, z: 0 } } })).toBe(false);
  });
});

describe('body awareness in the native observation', () => {
  it('shows how worn each tool is (paid run L13 lost its pickaxes unannounced)', async () => {
    const { captureWorldObservation } = await import('../../src/services/minebot/cognition/worldFrame.js');
    const world = captureWorldObservation({ inventory: { items: () => [
      { name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 120 }, { name: 'cobblestone', count: 12 }] } });
    expect(world.inventory).toEqual([{ name: 'cobblestone', count: 12 },
      { name: 'stone_pickaxe', count: 1, durability: { left: 11, max: 131 } }]);
  });
});

describe('body economy: what moving costs', () => {
  it('meters walking, sprinting and jumps, and shows them with the hunger reserve in the observation', async () => {
    const { installExertionMeter } = await import('../../src/services/minebot/utils/exertionMeter.js');
    const { captureWorldObservation } = await import('../../src/services/minebot/cognition/worldFrame.js');
    const controls: Record<string, boolean> = {};
    const bot: any = Object.assign(new EventEmitter(), { entity: { position: { x: 0, y: 64, z: 0 }, onGround: true, isInWater: false },
      getControlState: (c: string) => controls[c] ?? false, foodSaturation: 2.44, food: 18, health: 20 });
    installExertionMeter(bot);
    const step = (dx: number, onGround = true) => { bot.entity.position = { x: bot.entity.position.x + dx, y: 64, z: 0 }; bot.entity.onGround = onGround; bot.emit('physicsTick'); };
    step(0);
    for (let i = 0; i < 10; i++) step(0.2);                         // 2m walked
    controls.sprint = true; for (let i = 0; i < 10; i++) step(0.28); // 2.8m sprinted
    controls.jump = true; step(0.28, false); step(0.28, true);       // one jump
    step(40);                                                        // a teleport is not exertion
    expect(bot.exertion.walkedMetres).toBeCloseTo(2, 5);
    expect(bot.exertion.sprintedMetres).toBeCloseTo(3.36, 5);
    expect(bot.exertion.jumps).toBe(1);
    const world = captureWorldObservation(bot);
    expect(world).toMatchObject({ saturation: 2.4, movementPace: 'sprint', exertion: { walkedMetres: 2, sprintedMetres: 3, jumps: 1 } });
    bot.movementPace = 'walk';
    expect(captureWorldObservation(bot).movementPace).toBe('walk');
    expect(captureWorldObservation({ health: 20 })).not.toHaveProperty('exertion');
  });

  it('puts the distance by gait beside the hunger in the run course a reflection reads', async () => {
    const { renderTrajectory, describeSituation } = await import('../../src/modules/minecraftLearning/index.js');
    const at = (food: number, sprinted: number) => describeSituation({ dimension: 'minecraft:overworld', position: { x: 0, y: 70, z: 0 },
      health: 20, food, oxygen: 20, saturation: 0, exertion: { walkedMetres: 10, sprintedMetres: sprinted, swumMetres: 0, jumps: 4 },
      movementPace: 'sprint', isInWater: false, time: '1000', heldItem: null, inventory: [], nearbyEntities: [] });
    const lines = renderTrajectory([{ sec: 0, features: at(20, 0) }, { sec: 480, features: at(9, 470) }]);
    expect(lines[1]).toContain('food=9(余力0)');
    expect(lines[1]).toContain('走470m');
  });

  it('walks when the planner chose to, except in an emergency', async () => {
    const { setMovements } = await import('../../src/services/minebot/utils/setMovements.js');
    const SetMovementPace = (await import('../../src/services/minebot/instantSkills/setMovementPace.js')).default;
    let installed: any = null;
    const bot: any = { version: '1.21.11', registry: (await import('minecraft-data')).default('1.21.11'),
      inventory: { items: () => [] }, pathfinder: { setMovements: (m: any) => { installed = m; } }, entity: { position: { x: 0, y: 64, z: 0 } } };
    setMovements(bot); expect(installed.allowSprinting).toBe(true);
    expect(installed.infiniteLiquidDropdownDistance).toBe(false); // a drop into water is bounded like any other
    expect((await new SetMovementPace(bot).runImpl('walk')).success).toBe(true);
    setMovements(bot); expect(installed.allowSprinting).toBe(false);
    bot.minebotControlState = 'emergency_reflect';
    setMovements(bot); expect(installed.allowSprinting).toBe(true);
    expect((await new SetMovementPace(bot).runImpl('fly' as any)).success).toBe(false);
  });
});

describe('a lesson can wait on what the body has yet to make (the user, 2026-10-05: sheep near the spawn first, for a bed)', () => {
  it('shows the sheep-and-bed lesson while sheep are near and no bed of any colour is carried, and not after', () => {
    const seed = seedItems('2026-10-05T00:00:00.000Z').find(entry => entry.id === 'seed-bed-from-sheep')!;
    expect(seed).toBeDefined();
    const withSheep = (inventory: Array<{ name: string; count: number }>) => describeSituation(observation({ time: '6000', inventory,
      nearbyEntities: [{ name: 'sheep', kind: 'passive', distance: 9 }] }));
    expect(conditionsMatch(seed.conditions, withSheep([{ name: 'oak_log', count: 4 }]))).toBe(true);
    expect(conditionsMatch(seed.conditions, withSheep([{ name: 'red_bed', count: 1 }]))).toBe(false);
    expect(conditionsMatch(seed.conditions, describeSituation(observation({ time: '6000' })))).toBe(false);   // a cow, no sheep
    // The same pattern works for carryingAny.
    expect(conditionsMatch({ carryingAny: ['*_bed'] }, withSheep([{ name: 'white_bed', count: 1 }]))).toBe(true);
  });
});

describe('how the run\'s time has gone, in numbers (L96, L98-L100 lost 11-22 minutes an hour to waiting, and nothing showed the sum)', () => {
  const t0 = 1_000_000_000;
  const min = 60_000;
  it('says the time since the start and the last advancement, and what the last stretch\'s actions took, largest first', () => {
    const entries = [
      { at: t0 + 30 * min, tool: 'mine-block', ms: 2 * min, emergency: false },
      { at: t0 + 35 * min, tool: 'wait-time', ms: 110_000, emergency: false },
      { at: t0 + 37 * min, tool: 'wait-time', ms: 110_000, emergency: false },
      { at: t0 + 38 * min, tool: 'start-smelting', ms: 5_000, emergency: false },    // too short to name
      { at: t0 + 39 * min, tool: 'attack-continuously', ms: 40_000, emergency: true },
      { at: t0 + 10 * min, tool: 'wait-time', ms: 9 * min, emergency: false },       // outside the last fifteen minutes
    ];
    const text = describePace(entries, { now: t0 + 40 * min, startedAt: t0, lastMilestone: { name: 'Acquire Hardware', at: t0 + 22 * min } })!;
    expect(text).toContain('開始から40分');
    expect(text).toContain('最後の実績「Acquire Hardware」から18分');
    expect(text).toContain('待機 3.7分・採掘 2.0分');
    expect(text).toContain('緊急対応中 0.7分');
    expect(text).not.toContain('精錬');
  });
  it('says nothing in the first minutes', () => {
    expect(describePace([], { now: t0 + 4 * min, startedAt: t0 })).toBeNull();
    expect(describePace([], { now: t0 + 6 * min, startedAt: t0 })).toContain('まだ実績なし');
  });
});

describe('what a person taught keeps a place among the lessons shown (L101-L103: "at night go on mining" ranked 18th and never reached the planner)', () => {
  it('shows up to three matching taught items ahead of higher-scoring self-taught lessons, and the rest by score', () => {
    const features = describeSituation(observation({ time: '19000', nearbyEntities: [] }));
    const learned = Array.from({ length: 12 }, (_, index) => item({ id: `learned-${index}`, source: 'reflection', support: 15, uses: 5,
      conditions: { dimensions: ['overworld'], timeBands: ['night'], depthBands: ['surface'], minHealth: 10, carryingAny: ['cobblestone'] } }));
    const taught = item({ id: 'seed-night', source: 'human-seed', support: 3, contradict: 1, conditions: { timeBands: ['night'] } });
    const shown = retrieveKnowledge([...learned, taught], features).map(entry => entry.item.id);
    expect(shown).toHaveLength(8);
    expect(shown[0]).toBe('seed-night');
    expect(shown.filter(id => id.startsWith('learned-'))).toHaveLength(7);
  });
});

