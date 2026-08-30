import { config } from '../../config/env.js';

/** Enforced at the API boundary as well as at callers, including direct calls and retries. */
export function assertTwitterEnabled(): void {
  if (config.twitter.disabled) throw new Error('TWITTER_DISABLED');
}
