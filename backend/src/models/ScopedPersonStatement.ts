import mongoose, { Schema } from 'mongoose';

export interface IScopedPersonStatement {
  _id: string;
  scopeVersion: 1;
  scopeKey: string;
  visibilityScope: 'private_user' | 'shared_channel';
  ownerUserId: string;
  subjectId: string;
  kind: 'user_quote';
  status: 'active' | 'forgotten';
  revision: number;
  quote?: string;
  source?: { messageId: string; requestId: string; receivedAt: string };
}
const sourceSchema = new Schema({
  messageId: { type: String, required: true }, requestId: { type: String, required: true }, receivedAt: { type: String, required: true },
}, { _id: false });
const schema = new Schema<IScopedPersonStatement>({
  // Deterministic origin ID provides atomic uniqueness without migrating legacy person indexes.
  _id: { type: String, required: true },
  scopeVersion: { type: Number, enum: [1], required: true },
  scopeKey: { type: String, required: true },
  visibilityScope: { type: String, enum: ['private_user', 'shared_channel'], required: true },
  ownerUserId: { type: String, required: true }, subjectId: { type: String, required: true },
  kind: { type: String, enum: ['user_quote'], required: true },
  status: { type: String, enum: ['active', 'forgotten'], required: true },
  revision: { type: Number, min: 1, required: true },
  quote: { type: String, maxlength: 1000 }, source: { type: sourceSchema },
}, { collection: 'scopedpersonstatements', autoIndex: false, autoCreate: false, strict: 'throw', versionKey: false });
// A future reviewed index migration can add query indexes. Importing this model creates none.
export const ScopedPersonStatement = mongoose.model<IScopedPersonStatement>('ScopedPersonStatement', schema);
