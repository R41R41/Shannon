/** Only trusted companion request metadata can select a primary planner; never the goal text. */
export const COMPANION_PRIMARY_MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' } as const;
export interface CompanionPrimaryModel { readonly mode: keyof typeof COMPANION_PRIMARY_MODELS; readonly model: string; readonly revision: number }
export function companionPrimaryModel(value: unknown): CompanionPrimaryModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pin = value as CompanionPrimaryModel;
  return (pin.mode === 'haiku' || pin.mode === 'sonnet') && COMPANION_PRIMARY_MODELS[pin.mode] === pin.model
    && Number.isSafeInteger(pin.revision) && pin.revision >= 0 ? Object.freeze({ mode: pin.mode, model: pin.model, revision: pin.revision }) : null;
}
/** No key value is returned or logged. Provider selection for other tasks remains unchanged. */
export function supportedCompanionPrimaryModels(configuration: { anthropic: { apiKey?: string } }): string[] {
  return configuration.anthropic.apiKey?.trim() ? Object.values(COMPANION_PRIMARY_MODELS) : [];
}
export function companionPrimaryModelFromMetadata(metadata: Record<string, unknown> | undefined): CompanionPrimaryModel | undefined {
  if (metadata?.minecraftPrimaryModel === undefined) return undefined;
  const pin = companionPrimaryModel(metadata.minecraftPrimaryModel);
  const task = metadata.companionTask as { requestId?: unknown } | undefined;
  if (!pin || typeof task?.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(task.requestId)) throw new Error('MINECRAFT_PRIMARY_MODEL_PIN_INVALID');
  return pin;
}
