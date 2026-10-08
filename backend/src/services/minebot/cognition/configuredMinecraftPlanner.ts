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
