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
export function bodySkillCatalog(skills: readonly BodySkill[], bot: object) {
  const entries = skills.filter(skill => skill.isToolForLLM && /^[a-z][a-z0-9-]{0,58}$/.test(skill.skillName)
    && !forbidden.test(skill.skillName) && Number.isFinite(skill.maxDurationMs) && skill.maxDurationMs > 0)
    .map(skill => {
      const tool = new InstantSkillTool(skill, bot as any);
      const schema = normalizeSkillSchema((zodToJsonSchema as unknown as (schema: unknown, options: { $refStrategy: 'none' }) => unknown)(tool.schema, { $refStrategy: 'none' }));
      const definition: MinecraftSkillDefinition = { name: skill.skillName, description: skill.description.slice(0, 3000),
        inputSchema: schema, readOnly: skillCategory(skill.skillName) === 'query' };
      return { skill, schema: tool.schema.strict(), definition };
    });
  if (entries.length > 128 || JSON.stringify(entries.map(e => e.definition)).length > 250_000
    || new Set(entries.map(e => e.definition.name)).size !== entries.length) throw Error('BODY_SKILL_CATALOG_SIZE');
  return {
    definitions: entries.map(e => e.definition),
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
