import { requireCapability, type RequestContext } from '../access/index.js';

export interface ModelSettingsRepository {
  snapshot(): { current: Record<string, string>; overrides: Record<string, string> };
  set(key: string, model: string): void;
  reset(): void;
}
export class ModelSettingsInputError extends Error {}
/** Authorization lives here as well as at the transport boundary. */
export class ModelSettingsService {
  constructor(private readonly repository: ModelSettingsRepository, private readonly now: () => number = Date.now) {}
  read(context: RequestContext | null) {
    requireCapability(context, 'models:read', this.now());
    return this.repository.snapshot();
  }
  update(context: RequestContext | null, key: unknown, model: unknown): void {
    requireCapability(context, 'models:write', this.now());
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(this.repository.snapshot().current, key)) {
      throw new ModelSettingsInputError('Unknown model key');
    }
    if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)) {
      throw new ModelSettingsInputError('Invalid model name');
    }
    this.repository.set(key, model);
  }
  reset(context: RequestContext | null) {
    requireCapability(context, 'models:write', this.now());
    this.repository.reset();
    return this.repository.snapshot().current;
  }
}
