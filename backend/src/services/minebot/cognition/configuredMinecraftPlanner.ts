import { companionPrimaryModel, type CompanionPrimaryModel, COMPANION_PRIMARY_MODELS } from '../integration/companionPrimaryModel.js';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicPlannerClient } from './AnthropicPlannerClient.js';
import { budgetedMinecraftFetch } from './MinecraftModelBudget.js';
import { createOpenAIPlannerClient, minecraftPlannerProvider } from './OpenAIPlannerClient.js';

export interface MinecraftPlannerConfiguration {
  anthropic: { apiKey?: string };
  openaiApiKey?: string;
  minecraftPlanner?: { provider?: string; openAIModel?: string; anthropicModel?: string };
}

/** Production planner composition only. An explicit Anthropic model fixes every
 * executor request (including summaries) to that model and the shared budget.
 * An absent setting preserves the legacy per-task SDK model selection.
 */
export function createConfiguredMinecraftPlanner(
  configuration: MinecraftPlannerConfiguration,
  fetcher: typeof fetch = budgetedMinecraftFetch,
): { client: Pick<Anthropic, 'messages'>; model?: string } {
  if (minecraftPlannerProvider(configuration) === 'openai') {
    return { client: createOpenAIPlannerClient({ apiKey: configuration.openaiApiKey!,
      model: configuration.minecraftPlanner?.openAIModel, fetcher }),
      model: configuration.minecraftPlanner?.openAIModel };
  }
  const model = configuration.minecraftPlanner?.anthropicModel?.trim();
  if (model) {
    return { client: createAnthropicPlannerClient({ apiKey: configuration.anthropic.apiKey ?? '', model, fetcher }), model };
  }
  return { client: new Anthropic({ apiKey: configuration.anthropic.apiKey || undefined }) };
}

/** The original request selects this pair once; helpers remain Haiku and use the same unchanged budget transport. */
export function createPinnedMinecraftPlanners(configuration: MinecraftPlannerConfiguration, selection: CompanionPrimaryModel,
  fetcher: typeof fetch = budgetedMinecraftFetch) {
  const pin = companionPrimaryModel(selection);
  if (!pin) throw new Error('MINECRAFT_PRIMARY_MODEL_PIN_INVALID');
  const apiKey = configuration.anthropic.apiKey ?? '';
  return { primary: { client: createAnthropicPlannerClient({ apiKey, model: pin.model, effort: pin.mode === 'sonnet' ? 'medium' : 'low', fetcher }), model: pin.model },
    auxiliary: { client: createAnthropicPlannerClient({ apiKey, model: COMPANION_PRIMARY_MODELS.haiku, effort: 'low', fetcher }), model: COMPANION_PRIMARY_MODELS.haiku } };
}
