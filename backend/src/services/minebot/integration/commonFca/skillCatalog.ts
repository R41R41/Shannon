import { Vec3 } from 'vec3';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { InstantSkillTool } from '../../skills/InstantSkillTool.js';
import { skillCategory } from '../../execution/SkillExecutor.js';
import type { MinecraftSkillDefinition } from './minecraftControlContract.js';

export interface BodySkill {
  skillName: string; description: string; isToolForLLM: boolean; maxDurationMs: number;
  params: { name: string; type: string; required?: boolean; default?: unknown }[];
  run(...args: any[]): Promise<{ success: boolean; result: string; failureType?: string }>;
}
const forbidden = /(?:campaign|planner|agent|command|chat|constant|script|code|background|schedule|routine|self-test|switch-auto)/;
const allowedKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'anyOf', 'default']);
/** No references or permissive objects cross the wire; native Zod validation still runs before dispatch. */
// Eight deep, not six: act's `done` (a list of lists of clauses, optional and nullable) is two levels deeper than any other param.
export function normalizeSkillSchema(raw: any, depth = 0): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 8 || raw.$ref || raw.definitions || raw.$defs) throw Error('BODY_SKILL_SCHEMA');
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === '$schema') continue;
    if (!allowedKeys.has(key)) throw Error(`BODY_SKILL_SCHEMA:${key}`);
    output[key] = value;
  }
  if (Array.isArray(output.type)) {
    const { type, ...rest } = output;
    return { anyOf: type.map((type: string) => normalizeSkillSchema({ ...rest, type }, depth + 1)) };
  }
  if (output.anyOf) {
    // Zod optional values may encode an impossible JSON/undefined branch as {not:{}}.
    // Removing only that mathematically empty branch preserves every JSON value and property omission.
    const choices = output.anyOf.filter((value: any) => !(value && Object.keys(value).length === 1 && value.not
      && typeof value.not === 'object' && Object.keys(value.not).length === 0));
    if (!choices.length) throw Error('BODY_SKILL_NO_JSON_VALUES');
    // A choice of one is that one (Zod writes every optional string as anyOf:[{anyOf:[{type:string}]}, {type:null}]):
    // the same values, in fewer characters on every decision.
    if (choices.length === 1 && choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0])) {
      const { anyOf: _single, ...rest } = output;
      return normalizeSkillSchema({ ...choices[0], ...rest }, depth + 1);
    }
    output.anyOf = choices.map((value: unknown) => normalizeSkillSchema(value, depth + 1));
  }
  else if (output.type === 'object') {
    output.properties = Object.fromEntries(Object.entries(output.properties ?? {}).map(([name, schema]) => [name, normalizeSkillSchema(schema, depth + 1)]));
    output.required ??= [];
    output.additionalProperties = false;
  } else if (output.type === 'array') output.items = normalizeSkillSchema(output.items, depth + 1);
  else if (!['string', 'integer', 'number', 'boolean', 'null'].includes(output.type)) throw Error('BODY_SKILL_SCHEMA');
  if (JSON.stringify(output).length > 16_000) throw Error('BODY_SKILL_SCHEMA_SIZE');
  return output;
}
/**
 * What the planner is shown of a skill's input. An optional value is written as "its type, or null", but null and leaving it
 * out are read the same way (as the default, see resolve), so only its own type is shown: the same calls, in fewer
 * characters on every decision. The body's own validation still takes null.
 */
export function offeredSchema(schema: Record<string, any>): Record<string, any> {
  if (schema.type !== 'object' || !schema.properties) return schema;
  return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).map(([name, property]: [string, any]) => {
    const choices = Array.isArray(property?.anyOf) ? property.anyOf.filter((choice: any) => choice?.type !== 'null') : null;
    if (!choices || choices.length !== 1 || choices.length === property.anyOf.length) return [name, property];
    const { anyOf: _choices, ...rest } = property;
    if (rest.default === null) delete rest.default;
    return [name, { ...choices[0], ...rest }];
  })) };
}
/** A skill's own time, within one second and ten minutes (0 or nonsense: the old flat two minutes). */
export function skillRunLimit(maxDurationMs: number): number {
  return Number.isFinite(maxDurationMs) && maxDurationMs > 0 ? Math.min(600_000, Math.max(1_000, Math.round(maxDurationMs))) : 120_000;
}
/**
 * The requests the API binds to the dragon's native evidence (mc.goal-evidence): a mirror of the closed set in Shannon API
 * wiring/fcaMinecraftGoalBinding.ts (update both together). Closed on purpose: "farm before the dragon" is not one of them,
 * so an ordinary request never loses a tool. Only dragon requests are in it; the verbs and the short forms owners say in the game chat
 * (「エンドラ倒して」, 「エンドラを討伐してきて」, 「エンドラ討伐」) are there too (mc-chat-stale-frame, 2026-10-26).
 */
export const DRAGON_GOALS: ReadonlySet<string> = new Set([
  'エンダードラゴンを倒して', 'エンダードラゴンを倒してきて', 'エンダードラゴンを倒す',
  'エンダードラゴンを倒してください', 'エンダードラゴンを倒してきてください',
  'エンダードラゴンを討伐して', 'エンダードラゴンを討伐してください', 'エンダードラゴン討伐して',
  'エンダードラゴン倒して', 'エンダードラゴン倒してきて', 'エンダードラゴンを討伐してきて', 'エンダードラゴン討伐してきて', 'エンダードラゴン討伐',
  'エンドラを倒して', 'エンドラを倒してきて', 'エンドラを倒す', 'エンドラを倒してください', 'エンドラを倒してきてください',
  'エンドラを討伐して', 'エンドラを討伐してください', 'エンドラ討伐して',
  'エンドラ倒して', 'エンドラ倒してきて', 'エンドラを討伐してきて', 'エンドラ討伐してきて', 'エンドラ討伐',
  'kill the ender dragon', 'defeat the ender dragon', 'kill the enderdragon', 'defeat the enderdragon',
  'please kill the ender dragon', 'please defeat the ender dragon',
]);
/** The game's name before a request says where, not what (「マイクラでエンドラを討伐して」): dropped once, at the front. Never a goal. */
const GAME_PLACE = /^(?:マイクラ|マインクラフト|minecraft)で/u;
export function isDragonGoal(goal: unknown): boolean {
  if (typeof goal !== 'string') return false;
  const said = goal.normalize('NFKC').trim().toLowerCase().replace(/[。.!！]+$/u, '').trim();
  return DRAGON_GOALS.has(said.replace(GAME_PLACE, '').trim());
}
/**
 * What the planner is offered (design mb-llm-centric 2.4 and 4): `act`, `view` and `probe` (r4: the reading tools, path · sight · column ·
 * around · history · scan), and the readers and the few interactions that are one exact thing each (a trade, an enchantment, a brew, a
 * repair, a stonecutter). The skills that choose for the planner (move-to, mine-block, stair-mine, the shelters, the fights' own tactics)
 * are not offered; they still run if asked for. The same list for every task. The goal evidence is added by the body.
 */
export const OFFERED_TOOLS: readonly string[] = ['act', 'view', 'probe', 'find-blocks', 'check-recipe', 'recall-places', 'find-structure',
  'list-nearby-entities', 'check-container', 'check-furnace', 'get-entity-look-direction', 'trade-with-villager', 'enchant-item',
  'brew-potion', 'repair-item', 'use-stonecutter', 'set-movement-pace', 'accept-threat', 'get-advancements'];
export function bodySkillCatalog(skills: readonly BodySkill[], bot: object) {
  const entries = skills.filter(skill => skill.isToolForLLM && /^[a-z][a-z0-9-]{0,58}$/.test(skill.skillName)
    && !forbidden.test(skill.skillName) && Number.isFinite(skill.maxDurationMs) && skill.maxDurationMs > 0)
    .map(skill => {
      const tool = new InstantSkillTool(skill, bot as any);
      const schema = normalizeSkillSchema((zodToJsonSchema as unknown as (schema: unknown, options: { $refStrategy: 'none' }) => unknown)(tool.schema, { $refStrategy: 'none' }));
      const definition: MinecraftSkillDefinition = { name: skill.skillName, description: skill.description.slice(0, 3000),
        inputSchema: offeredSchema(schema), readOnly: skillCategory(skill.skillName) === 'query', maxDurationMs: skillRunLimit(skill.maxDurationMs) };
      return { skill, schema: tool.schema.strict(), definition };
    });
  if (entries.length > 128 || JSON.stringify(entries.map(e => e.definition)).length > 250_000
    || new Set(entries.map(e => e.definition.name)).size !== entries.length) throw Error('BODY_SKILL_CATALOG_SIZE');
  const all = entries.map(e => e.definition);
  const definitions = OFFERED_TOOLS.map(name => all.find(definition => definition.name === name)).filter((definition): definition is MinecraftSkillDefinition => !!definition);
  return {
    /** What the planner is offered. */
    definitions,
    /** Everything that can run: a skill no longer offered is still carried out if it is asked for. */
    runnable: entries.map(e => e.definition),
    resolve(name: string, input: unknown): { skill: BodySkill; args: unknown[] } {
      const entry = entries.find(e => e.definition.name === name);
      if (!entry || JSON.stringify(input).length > 32_000) throw Error('BODY_SKILL_NOT_ALLOWED');
      const data = entry.schema.parse(input);
      return { skill: entry.skill, args: entry.skill.params.map(param => {
        const value = data[param.name] ?? param.default;
        return param.type === 'Vec3' && value ? new Vec3(value.x, value.y, value.z) : value;
      }) };
    },
  };
}
