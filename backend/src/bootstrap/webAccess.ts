import { randomUUID } from 'node:crypto';
import { AccessService } from '../modules/access/index.js';
import { ModelSettingsService } from '../modules/modelSettings/index.js';
import { IdentityManifestReviewService, IdentityStatusService } from '../modules/identity/index.js';
import { FirebaseIdentityVerifier } from '../adapters/access/FirebaseIdentityVerifier.js';
import { MongoAccessUserRepository } from '../adapters/access/MongoAccessUserRepository.js';
import { modelManager } from '../config/modelManager.js';
import { StaticIdentityStatusRepository } from '../adapters/identity/StaticIdentityStatusRepository.js';
import { MongoIdentityMigrationUserRepository } from '../adapters/identity/MongoIdentityMigrationUserRepository.js';
import { reviewedBindingManifestPlanner } from '../adapters/identity/reviewedBindingManifestPlanner.js';

/** Composition only. No connections, timers, model calls, or role migrations here. */
export function createWebAccess(projectId: string) {
  const access = new AccessService(new FirebaseIdentityVerifier(projectId), new MongoAccessUserRepository(), randomUUID);
  const modelSettings = new ModelSettingsService({
    snapshot: () => ({ current: modelManager.getAll(), overrides: modelManager.getOverrides() }),
    set: (key, model) => {
      if (key.startsWith('minebot.')) {
        modelManager.setMinebotModel(key.slice('minebot.'.length) as Parameters<typeof modelManager.setMinebotModel>[0], model);
      } else {
        modelManager.set(key as Parameters<typeof modelManager.set>[0], model);
      }
    },
    reset: () => modelManager.resetAll(),
  });
  const identityStatus = new IdentityStatusService(new StaticIdentityStatusRepository());
  const identityManifestReview = new IdentityManifestReviewService(
    new MongoIdentityMigrationUserRepository(),
    reviewedBindingManifestPlanner,
  );
  return { access, modelSettings, identityStatus, identityManifestReview };
}
