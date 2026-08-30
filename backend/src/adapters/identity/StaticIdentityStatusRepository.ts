import type { IdentityStatusRepository } from '../../modules/identity/index.js';
import { buildDefaultIdentityStatus } from '../../modules/identity/index.js';
import type { RequestContext } from '../../modules/access/index.js';

/** Fallback when Mongo profile repository is unavailable in tests. */
export class StaticIdentityStatusRepository implements IdentityStatusRepository {
  snapshotFor(context: RequestContext) {
    return buildDefaultIdentityStatus(context);
  }
}
