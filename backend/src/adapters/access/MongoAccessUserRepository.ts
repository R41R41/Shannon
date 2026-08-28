import { User } from '../../models/User.js';
import type { AccessUserRepository, AccessUser } from '../../modules/access/index.js';

export class MongoAccessUserRepository implements AccessUserRepository {
  async findByIdentity(projectId: string, uid: string): Promise<AccessUser | null> {
    const user = await User.findOne({ firebaseProjectId: projectId, firebaseUid: uid })
      .select('firebaseUid firebaseProjectId name email isAuthorized isAdmin').lean().exec();
    if (!user) return null;
    return { projectId: user.firebaseProjectId!, uid: user.firebaseUid!, name: user.name,
      email: user.email, isAuthorized: user.isAuthorized, isAdmin: user.isAdmin };
  }
}
