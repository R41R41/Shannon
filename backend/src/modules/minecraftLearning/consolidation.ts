import { assertGeneralKnowledgeText, confidence, sanitizeConditions, MAX_ACTIVE_ITEMS, type EvidenceVerdict, type KnowledgeConditions, type KnowledgeItem, type KnowledgeKind, type KnowledgeStoreState } from './knowledge.js';

const MAX_MERGE_GROUP = 4;
const MERGED_ADVICE_SLACK = 40;

/**
 * Memory consolidation: de-duplication, nothing more. Separate reflections on
 * similar events produce the same lesson twice; the model points out such
 * groups and each becomes one lesson. Evidence carries over per run (a run
 * that confirmed two of the merged lessons still counts once), the merged
 * items retire with a pointer to their successor, and nothing is deleted.
 *
 * It used to ask for "one more general lesson" per group and ran after every
 * few reflections, on its own output. Over 28 runs it folded 421 of 450
 * lessons into 26: one of them the product of 108 lessons and 24 rounds, with
 * the conditions worn down from five keys to "overworld, no hostile near" and
 * the advice to "check everything first". What was specific and usable was
 * retired; what was shown thousands of times said nothing. A merge that
 * widens the situation or lists more advice is now refused in code.
 */
export const CONSOLIDATION_SYSTEM_PROMPT = `あなたはMinecraftで行動するAIエージェントの「記憶の整理」担当です。
経験から得た教訓の一覧を読み、同じ状況で同じ判断を促している重複だけを見つけて、1つにまとめます。

守ること:
- まとめるのは、状況も助言も実質的に同じものだけ。似た話題でも、状況が違う（水中と地上、夜と昼、持ち物や道具が違う）もの、助言の中身が違うものはまとめない。
- まとめた教訓を元より一般的・抽象的にしない。助言は元の教訓のどれか1つと同じ具体さにし、複数の助言を並べた一覧にしない。具体的な数量や品名は残す。
- 条件(conditions)は元の教訓より広げない。元の教訓すべてにあるキーは残し、値も元のどれより広くしない。
- 1グループは最大${MAX_MERGE_GROUP}件。迷ったらまとめない。まとめるものが無ければ空の配列を返す（それが普通）。
- 座標・特定の場所・プレイヤー名は書かない。

出力はJSONオブジェクトだけ:
{"merges":[{"ids":["まとめる元のid", "..."],"kind":"avoid|prefer|procedure|fact","situation":"状況","advice":"どうする/何を避けるか（理由を含む）","conditions":{...}}]}`;

export function buildConsolidationMessage(items: KnowledgeItem[]): string {
  return `## 現在の教訓（${items.length}件）\n` + items.map(item =>
    `- [${item.id}] (${item.kind}, 確信度${Math.round(confidence(item) * 100)}%, 確認${item.support}/反例${item.contradict}) ${item.situation} → ${item.advice} 条件=${JSON.stringify(item.conditions)}`,
  ).join('\n');
}

export interface ConsolidationMerge { ids: string[]; kind: KnowledgeKind; situation: string; advice: string; conditions: unknown }

const KINDS: KnowledgeKind[] = ['avoid', 'prefer', 'procedure', 'fact'];

/**
 * How a proposed merge would say less than its sources, or null when it does
 * not: a condition one of them had is gone (one may go), a kept condition
 * admits more than a source did, or the advice outgrew the longest source.
 */
function broadening(from: KnowledgeItem[], merged: KnowledgeConditions, advice: string): string | null {
  for (const source of from) {
    // A lesson pinned by three or more conditions may lose one; a looser one must keep all it has.
    const keys = Object.keys(source.conditions);
    const dropped = keys.filter(key => !(key in merged));
    if (dropped.length > (keys.length >= 3 ? 1 : 0)) return `drops ${dropped.join(',')} of ${source.id}`;
    for (const [key, value] of Object.entries(merged) as Array<[keyof KnowledgeConditions, unknown]>) {
      const original = source.conditions[key];
      if (original === undefined) continue;
      if (Array.isArray(value) && Array.isArray(original)) {
        if (value.some(entry => !(original as string[]).includes(entry as string))) return `${key} wider than ${source.id}`;
      } else if (typeof value === 'number' && typeof original === 'number') {
        if (key.startsWith('min') ? value < original : value > original) return `${key} wider than ${source.id}`;
      } else if (value !== original) return `${key} differs from ${source.id}`;
    }
  }
  const longest = Math.max(...from.map(entry => entry.advice.length));
  return advice.trim().length > longest + MERGED_ADVICE_SLACK ? 'advice longer than any source' : null;
}

/** Apply validated merges; groups with unknown, retired or fewer than two ids are skipped. */
export function applyConsolidation(state: KnowledgeStoreState, merges: ConsolidationMerge[], provenance: string,
  now: string, newId: () => string): { merged: Array<{ into: string; from: string[] }>; rejected: string[] } {
  const result = { merged: [] as Array<{ into: string; from: string[] }>, rejected: [] as string[] };
  const used = new Set<string>();
  for (const merge of merges) {
    try {
      const ids = [...new Set(Array.isArray(merge.ids) ? merge.ids : [])];
      const sources = ids.map(id => state.items.find(item => item.id === id && !item.retired));
      if (ids.length < 2 || sources.some(item => !item) || ids.some(id => used.has(id))) throw new Error('MINECRAFT_CONSOLIDATION_IDS_INVALID');
      if (!KINDS.includes(merge.kind)) throw new Error('MINECRAFT_CONSOLIDATION_KIND_INVALID');
      assertGeneralKnowledgeText(merge.situation);
      assertGeneralKnowledgeText(merge.advice);
      const from = sources as KnowledgeItem[];
      const conditions = sanitizeConditions(merge.conditions);
      // Lessons that each held only in some situation do not add up to one
      // that holds everywhere; summed evidence made such catch-alls dominant.
      if (!Object.keys(conditions).length && from.every(entry => Object.keys(entry.conditions).length))
        throw new Error('MINECRAFT_CONSOLIDATION_OVERGENERAL');
      if (from.length > MAX_MERGE_GROUP) throw new Error('MINECRAFT_CONSOLIDATION_GROUP_TOO_LARGE');
      const broadened = broadening(from, conditions, merge.advice);
      if (broadened) throw new Error(`MINECRAFT_CONSOLIDATION_BROADENS:${broadened}`);
      const evidence: Record<string, EvidenceVerdict> = {};
      for (const entry of from) for (const [run, verdict] of Object.entries(entry.evidence ?? {}))
        if (evidence[run] !== 'contradicted') evidence[run] = verdict;
      const counted = Object.values(evidence);
      const runsWith = (entry: KnowledgeItem, verdict: EvidenceVerdict) =>
        Object.values(entry.evidence ?? {}).filter(value => value === verdict).length;
      // Counts kept before per-run evidence cannot be de-duplicated; take the largest, never the sum.
      const legacySupport = Math.max(0, ...from.map(entry => entry.support - runsWith(entry, 'supported')));
      const legacyContradict = Math.max(0, ...from.map(entry => entry.contradict - runsWith(entry, 'contradicted')));
      const item: KnowledgeItem = {
        id: newId(), kind: merge.kind, situation: merge.situation.trim(), advice: merge.advice.trim(),
        conditions, source: 'reflection',
        provenance: [...new Set(from.flatMap(entry => entry.provenance)), provenance].slice(-20),
        support: counted.filter(verdict => verdict === 'supported').length + legacySupport,
        contradict: counted.filter(verdict => verdict === 'contradicted').length + legacyContradict,
        uses: from.reduce((sum, entry) => sum + entry.uses, 0),
        createdAt: now, updatedAt: now, evidence,
      };
      state.items.push(item);
      for (const entry of from) { entry.retired = true; entry.mergedInto = item.id; entry.updatedAt = now; used.add(entry.id); }
      result.merged.push({ into: item.id, from: ids });
    } catch (error) {
      result.rejected.push(`${String(error instanceof Error ? error.message : error)}: ${JSON.stringify(merge).slice(0, 160)}`);
    }
  }
  return result;
}

/**
 * Undo the merges of the generalising consolidation: every product of a merge
 * retires, and the lessons that were folded into it (through however many
 * rounds) come back as they were when they were merged away. Evidence the
 * products gathered afterwards is not handed down: it was gathered by a
 * different, vaguer statement. The newest are kept when the active limit
 * would be exceeded.
 */
export function restoreMergedLessons(state: KnowledgeStoreState, now: string): { restored: string[]; retiredProducts: string[]; overLimit: string[] } {
  const products = new Set(state.items.map(item => item.mergedInto).filter((id): id is string => typeof id === 'string'));
  const result = { restored: [] as string[], retiredProducts: [] as string[], overLimit: [] as string[] };
  for (const item of state.items) {
    if (products.has(item.id) || item.unmerged) {
      if (!item.retired) { item.retired = true; item.updatedAt = now; result.retiredProducts.push(item.id); }
      item.unmerged = true;
    } else if (item.retired && item.mergedInto) {
      item.retired = false; delete item.mergedInto; result.restored.push(item.id);
    } else if (item.retired && item.source === 'human-seed' && !(item.contradict >= 3 && confidence(item) < 0.35)) {
      // Retired while one run's repeated verdicts still counted separately; by
      // per-run evidence it does not meet the retirement rule.
      item.retired = false; result.restored.push(item.id);
    }
  }
  const active = state.items.filter(item => !item.retired)
    .sort((a, b) => Number(b.source === 'human-seed') - Number(a.source === 'human-seed') || b.createdAt.localeCompare(a.createdAt));
  for (const item of active.slice(MAX_ACTIVE_ITEMS)) { item.retired = true; item.updatedAt = now; result.overLimit.push(item.id); }
  return result;
}
