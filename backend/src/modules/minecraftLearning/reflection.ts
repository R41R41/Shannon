import { assertGeneralKnowledgeText, sanitizeConditions, type KnowledgeItem, type KnowledgeKind, type ReflectionResult, confidence } from './knowledge.js';
import type { SituationFeatures } from './situation.js';

export type ReflectionTrigger = 'death' | 'stall' | 'milestone' | 'run_end';

export interface ReflectionInput {
  trigger: ReflectionTrigger;
  /** Why this reflection runs, e.g. the death message or the repeated failure. */
  detail: string;
  situation: string;
  /** Oldest first, one line each. */
  events: string[];
  /** Knowledge that was shown to the planner around these events, plus nearby candidates. */
  knowledge: KnowledgeItem[];
  /** The whole run's course (vitals, inventory changes), for causes far earlier than the recent events. */
  trajectory?: string[];
  /** Per knowledge id, how it was shown during this run. */
  knowledgeNotes?: Record<string, string>;
}

export interface TrajectoryPoint { sec: number; features: SituationFeatures }

/** The run's course in at most `maxLines` lines, with the kinds of items gained and lost between them. */
export function renderTrajectory(points: TrajectoryPoint[], maxLines = 30): string[] {
  const step = Math.max(1, Math.ceil(points.length / maxLines));
  const picked = points.filter((_, index) => index % step === 0 || index === points.length - 1);
  let previous: Record<string, number> | null = null;
  let moved: SituationFeatures['exertion'] | null = null;
  return picked.map(point => {
    const f = point.features;
    const gained = previous ? Object.keys(f.inventory).filter(name => !(name in previous!)) : [];
    const lost = previous ? Object.keys(previous).filter(name => !(name in f.inventory)) : [];
    previous = f.inventory;
    // What the body did since the previous line, next to what its hunger did.
    const since = f.exertion && moved ? { walked: f.exertion.walkedMetres - moved.walkedMetres,
      sprinted: f.exertion.sprintedMetres - moved.sprintedMetres, jumps: f.exertion.jumps - moved.jumps } : null;
    moved = f.exertion ?? moved;
    return `+${Math.round(point.sec / 60)}分 hp=${f.health ?? '?'} food=${f.food ?? '?'}${f.saturation !== undefined && f.saturation !== null ? `(余力${f.saturation})` : ''}`
      + ` time=${f.timeBand} depth=${f.depthBand} dim=${f.dimension ?? '?'}`
      + (since && (since.walked || since.sprinted || since.jumps) ? ` 歩${since.walked}m 走${since.sprinted}m 跳${since.jumps}回` : '')
      + (f.threats.length ? ` 敵${f.threats.length}` : '')
      + (gained.length ? ` 新たに所持:${gained.slice(0, 6).join(',')}` : '')
      + (lost.length ? ` 失った:${lost.slice(0, 6).join(',')}` : '');
  });
}

const MAX_LESSONS = 3;
const KINDS: KnowledgeKind[] = ['avoid', 'prefer', 'procedure', 'fact'];

export const REFLECTION_SYSTEM_PROMPT = `あなたはMinecraftのサバイバルで行動するAIエージェント自身の「振り返り」担当です。
直前の経験記録から、別のワールドでも役立つ一般的な教訓を導き、既存の知識が今回の出来事で裏付けられたか・反証されたかを評価します。

守ること:
- 座標・特定の場所・プレイヤー名など、このワールド固有の事実は書かない。状況は特徴（時刻帯、深さ、水中か、近くの敵の種類、体力、空腹度、所持品、使った道具）で表す。
- 原因は記録に書かれた事実から推定する。記録から言えないことは断定しない。
- 結果の原因は直前ではなく、もっと前の判断や、試行の経過に表れた状態・所持品の推移にあることもある。経過があれば読み、根本の原因に関わった知識（この試行で表示されたもの）を評価する。
- 新しい教訓は本当に次の判断を変えるものだけ、最大${MAX_LESSONS}件。既存の知識と同じ内容なら新規にせず、そのidをsupportedにする。
- 既存の知識に従った結果うまくいかなかった、または状況に合わなかった時はcontradictedにする。関係ない知識はirrelevant。
- 条件(conditions)は、その教訓が当てはまる状況だけに絞る。使えるキー: dimensions(例 overworld,the_nether), timeBands(day,dusk,night,dawn), depthBands(deep,cave,low,surface,high), inWater(bool), emergency(bool), minHealth/maxHealth/minFood/maxFood(0-20), threatsAny(敵の種類名), threatsPresent(bool), othersAny(近くにいる敵以外の生き物の種類名。例 sheep,cow,villager), landmarksAny(見える範囲にある場所の種類。例 village), carryingAny(アイテムID), tools(スキル名)。

出力はJSONオブジェクトだけ:
{"lessons":[{"kind":"avoid|prefer|procedure|fact","situation":"状況","advice":"どうする/何を避けるか（理由を含む）","conditions":{...}}],
 "assessments":[{"id":"既存id","verdict":"supported|contradicted|irrelevant","reason":"短い理由"}]}`;

export function buildReflectionMessage(input: ReflectionInput): string {
  const knowledge = input.knowledge.length
    ? input.knowledge.map(item => `- [${item.id}] (${item.kind}, 確信度${Math.round(confidence(item) * 100)}%`
      + `${input.knowledgeNotes?.[item.id] ? `, ${input.knowledgeNotes[item.id]}` : ''}) ${item.situation} → ${item.advice} 条件=${JSON.stringify(item.conditions)}`).join('\n')
    : '（なし）';
  const course = input.trajectory?.length ? `\n\n## この試行の経過（古い順・抜粋）\n${input.trajectory.join('\n')}` : '';
  return `## きっかけ: ${input.trigger}\n${input.detail}\n\n## その時の状況\n${input.situation}${course}\n\n## 直前の経験（古い順）\n${input.events.join('\n')}\n\n## この試行で参照した・関連しそうな既存の知識\n${knowledge}`;
}

/** First balanced JSON object in a model reply. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('MINECRAFT_REFLECTION_NO_JSON');
  let depth = 0; let inString = false; let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('MINECRAFT_REFLECTION_UNBALANCED_JSON');
}

/**
 * Validate a reflection reply. Lessons that carry world facts or malformed
 * fields are dropped (and reported), never stored; unknown ids are ignored.
 */
export function parseReflection(text: string, knownIds: Set<string>): ReflectionResult & { rejected: string[] } {
  const raw = extractJsonObject(text) as { lessons?: unknown; assessments?: unknown };
  const rejected: string[] = [];
  const lessons = (Array.isArray(raw.lessons) ? raw.lessons : []).slice(0, MAX_LESSONS).flatMap((value: any) => {
    try {
      if (!KINDS.includes(value?.kind)) throw new Error('MINECRAFT_REFLECTION_KIND_INVALID');
      assertGeneralKnowledgeText(value.situation);
      assertGeneralKnowledgeText(value.advice);
      return [{ kind: value.kind as KnowledgeKind, situation: String(value.situation), advice: String(value.advice),
        conditions: sanitizeConditions(value.conditions) }];
    } catch (error) {
      rejected.push(`${String(error instanceof Error ? error.message : error)}: ${JSON.stringify(value).slice(0, 160)}`);
      return [];
    }
  });
  const assessments = (Array.isArray(raw.assessments) ? raw.assessments : []).flatMap((value: any) =>
    typeof value?.id === 'string' && knownIds.has(value.id) && ['supported', 'contradicted', 'irrelevant'].includes(value.verdict)
      ? [{ id: value.id, verdict: value.verdict, reason: typeof value.reason === 'string' ? value.reason.slice(0, 200) : undefined }]
      : []);
  return { lessons, assessments, rejected };
}
