import type {
  ActionDispatcher,
  MinecraftAction,
  MinebotOutput,
  RequestEnvelope,
  ShannonActionPlan,
  SkillParameters,
} from '@shannon/common';
import { getEventBus } from '../../eventBus/index.js';
import { createLogger } from '../../../utils/logger.js';
const logger = createLogger('MinebotDispatcher', 'minebot');

type SkillInvocation = {
  skillName: string;
  args: unknown[];
};

let minebotDispatchQueue: Promise<void> = Promise.resolve();

export const minebotDispatcher: ActionDispatcher = {
  channel: 'minecraft',

  async dispatch(_envelope: RequestEnvelope, plan: ShannonActionPlan): Promise<void> {
    const actions = plan.minecraftActions ?? [];
    const invocations = actions.length > 0
      ? actions.flatMap(mapActionToInvocations)
      : plan.message
        ? [{ skillName: 'chat', args: [plan.message] }]
        : [];

    const run = minebotDispatchQueue.catch(() => undefined).then(async () => {
      for (const invocation of invocations) {
        await invokeMinebotSkill(invocation);
      }
    });
    minebotDispatchQueue = run;

    await run;
  },
};

function mapActionToInvocations(action: MinecraftAction): SkillInvocation[] {
  switch (action.type) {
    case 'say':
      return [{ skillName: 'chat', args: [action.text] }];

    case 'move_to':
      return [{ skillName: 'move-to', args: [action.x, action.y, action.z, 1, 'near'] }];

    case 'follow':
      return [{ skillName: 'follow-entity', args: [action.target, action.distance ?? 2, 30000] }];

    case 'mine':
      return [{ skillName: 'mine-block', args: [action.block, action.count ?? 1, 32] }];

    case 'craft': {
      const count = Math.max(1, action.count ?? 1);
      return Array.from({ length: count }, () => ({
        skillName: 'craft-one',
        args: [action.item],
      }));
    }

    case 'place':
      return [{ skillName: 'place-block-at', args: [action.item, action.x, action.y, action.z] }];

    case 'attack':
      return [{ skillName: 'attack-nearest', args: [action.target, 4.5] }];

    case 'observe':
      return [{ skillName: 'list-nearby-entities', args: [action.radius ?? 24, 10] }];

    case 'defend':
      return [{ skillName: 'attack-nearest', args: ['', 6] }];

    case 'use_skill':
      return [{
        skillName: action.skillName,
        args: Array.isArray(action.args) ? action.args : Object.values(action.args),
      }];
  }

  return [];
}

async function invokeMinebotSkill(invocation: SkillInvocation): Promise<void> {
  const eventBus = getEventBus();
  const resultType = `minebot:${invocation.skillName}Result` as `minebot:${string}`;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const unsubscribe = eventBus.subscribe(resultType, (event) => {
      const result = event.data as MinebotOutput;
      if (result?.success === false) {
        const resultMsg = typeof result.result === 'string' ? result.result : String(result.result ?? '');
        const failureType = (result as MinebotOutput & { failureType?: string | null }).failureType
          ?? classifyFailureType(resultMsg);
        logger.warn(`[MinebotDispatcher] ${invocation.skillName} failed: ${resultMsg || 'unknown error'} (${failureType})`);
        finish(new Error(`${invocation.skillName} failed [failure_type=${failureType}]: ${resultMsg || 'unknown error'}`));
        return;
      }
      finish(undefined);
    });

    const timeout = setTimeout(() => {
      logger.warn(`[MinebotDispatcher] ${invocation.skillName} timed out`);
      finish(new Error(`${invocation.skillName} timed out [failure_type=timeout]`));
    }, 30000);

    eventBus.publish({
      type: `minebot:${invocation.skillName}`,
      memoryZone: 'minecraft',
      data: { skillParameters: invocation.args } as SkillParameters,
    });
  });
}

function classifyFailureType(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('見つかりません')) return 'target_not_found';
  if (normalized.includes('必要です') || normalized.includes('ありません')) return 'material_missing';
  if (normalized.includes('遠すぎ')) return 'distance_too_far';
  if (normalized.includes('タイムアウト')) return 'timeout';
  if (normalized.includes('中断')) return 'interrupted';
  if (normalized.includes('パスが見つかりません')) return 'path_not_found';
  if (normalized.includes('危険') || normalized.includes('unsafe')) return 'unsafe';
  return 'action_failed';
}
