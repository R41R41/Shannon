import type { MinebotOutput, SkillParameters } from '@shannon/common';

type SkillHandler = (parameters: unknown[]) => Promise<MinebotOutput>;

const handlers = new Map<string, SkillHandler>();

export function registerMinebotSkillHandler(skillName: string, handler: SkillHandler): void {
  if (handlers.has(skillName)) throw new Error(`Minebot skill handler already registered: ${skillName}`);
  handlers.set(skillName, handler);
}

export function unregisterMinebotSkillHandler(skillName: string): void {
  handlers.delete(skillName);
}

export async function invokeMinebotSkill(skillName: string, args: unknown[]): Promise<MinebotOutput> {
  const handler = handlers.get(skillName);
  if (!handler) {
    return { success: false, result: `Skill not registered: ${skillName}` };
  }
  try {
    return await handler(args);
  } catch (error) {
    return {
      success: false,
      result: error instanceof Error ? error.message : String(error),
    };
  }
}

export function invokeMinebotSkillFromParameters(
  skillName: string,
  data: SkillParameters | unknown[],
): Promise<MinebotOutput> {
  const raw = (data as SkillParameters)?.skillParameters;
  const parameters: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(raw)
      ? raw
      : [];
  return invokeMinebotSkill(skillName, parameters);
}

export function clearMinebotSkillHandlers(): void {
  handlers.clear();
}
