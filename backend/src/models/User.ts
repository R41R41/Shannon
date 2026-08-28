import mongoose from 'mongoose';

interface IUser {
  firebaseUid?: string;
  firebaseProjectId?: string;
  name: string;
  email: string;
  createdAt: Date;
  isAuthorized: boolean;
  isAdmin: boolean;
}

const userSchema = new mongoose.Schema<IUser>({
  firebaseUid: { type: String },
  firebaseProjectId: { type: String },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, index: true },
  createdAt: { type: Date, default: Date.now },
  isAuthorized: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
}, { autoIndex: false });

// インデックスを確実に作成
userSchema.index({ email: 1 }, { unique: true });

// Legacy rows without an explicitly reviewed Firebase binding are not authorized.
userSchema.index({ firebaseProjectId: 1, firebaseUid: 1 }, {
  unique: true,
  partialFilterExpression: { firebaseProjectId: { $type: 'string' }, firebaseUid: { $type: 'string' } },
});
export const User = mongoose.model<IUser>('User', userSchema);
