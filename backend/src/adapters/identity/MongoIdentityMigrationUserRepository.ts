import { User } from '../../models/User.js';
import type { IdentityMigrationUserRepository, MigrationUserRecord } from '../../modules/identity/index.js';

export class MongoIdentityMigrationUserRepository implements IdentityMigrationUserRepository {
  async listUsers(): Promise<readonly MigrationUserRecord[]> {
    const users = await User.find({})
      .select('_id email firebaseUid firebaseProjectId isAuthorized isAdmin')
      .sort({ _id: 1 })
      .lean()
      .exec();
    return users.map((user) => Object.freeze({
      _id: String(user._id),
      email: user.email,
      firebaseUid: user.firebaseUid ?? null,
      firebaseProjectId: user.firebaseProjectId ?? null,
      isAuthorized: user.isAuthorized,
      isAdmin: user.isAdmin,
    }));
  }
}
