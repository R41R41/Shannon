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
export function normalizeSkillSchema(raw: any, depth = 0): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 6 || raw.$ref || raw.definitions || raw.$defs) throw Error('BODY_SKILL_SCHEMA');
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
 * Installed and runnable, but not offered to the planner. Every one was a whole tool definition on every decision for
 * something the planner already has, or for nothing:
 * - what `minecraft.observe` and each decision's observation already say (position, health and food, the pack, what is
 *   worn (`world.worn`), the time and weather);
 * - control toggles whose effect the body undoes as the command ends (`release` clears the control states and lowers
 *   the held item), so nothing of them was left for the next step. The pace that lasts is set-movement-pace.
 */
export const OFFERED_ELSEWHERE: ReadonlySet<string> = new Set(['get-position', 'get-health', 'get-equipment', 'list-inventory-items',
  'get-bot-status', 'get-time-and-weather', 'set-sprint', 'set-sneak', 'set-shield']);
/**
 * Life in the Overworld that the way to the dragon does not pass through: hidden only while the task is the dragon
 * (see isDragonGoal), and offered again as soon as a task is anything else. Food on the way is hunted
 * (attack-continuously) or harvested (harvest-crop), both still offered.
 */
export const HIDDEN_FOR_DRAGON: ReadonlySet<string> = new Set(['breed-animal', 'plant-crop', 'use-bone-meal', 'fish', 'brew-potion',
  'enchant-item', 'use-stonecutter', 'trade-with-villager', 'repair-item']);
/**
 * The requests the API binds to the dragon's native evidence (mc.goal-evidence): a mirror of the closed set in Shannon API
 * wiring/fcaMinecraftGoalBinding.ts (update both together). Closed on purpose: "farm before the dragon" is not one of them,
 * so an ordinary request never loses a tool.
 */
const DRAGON_GOALS = new Set([
  'エンダードラゴンを倒して', 'エンダードラゴンを倒してきて', 'エンダードラゴンを倒す',
  'エンダードラゴンを倒してください', 'エンダードラゴンを倒してきてください',
  'エンダードラゴンを討伐して', 'エンダードラゴンを討伐してください', 'エンダードラゴン討伐して',
  'エンドラを倒して', 'エンドラを倒してきて', 'エンドラを倒す', 'エンドラを倒してください', 'エンドラを倒してきてください',
  'エンドラを討伐して', 'エンドラを討伐してください', 'エンドラ討伐して',
  'kill the ender dragon', 'defeat the ender dragon', 'kill the enderdragon', 'defeat the enderdragon',
  'please kill the ender dragon', 'please defeat the ender dragon',
]);
export function isDragonGoal(goal: unknown): boolean {
  return typeof goal === 'string' && DRAGON_GOALS.has(goal.normalize('NFKC').trim().toLowerCase().replace(/[。.!！]+$/u, '').trim());
}
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
  const definitions = entries.map(e => e.definition).filter(definition => !OFFERED_ELSEWHERE.has(definition.name));
  return {
    /** What the planner is offered. */
    definitions,
    /** What it is offered while the task is the dragon. */
    dragonDefinitions: definitions.filter(definition => !HIDDEN_FOR_DRAGON.has(definition.name)),
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
