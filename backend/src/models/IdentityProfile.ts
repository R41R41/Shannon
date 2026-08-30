import mongoose from 'mongoose';
import type { AudiencePolicyView } from '../modules/identity/types.js';
import type { StoredChannelBinding, WritableChannelKind } from '../modules/identity/bindingWrite.js';

interface IIdentityProfile {
  firebaseProjectId: string;
  firebaseUid: string;
  bindings: Partial<Record<WritableChannelKind, StoredChannelBinding>>;
  audience: AudiencePolicyView;
  revision: number;
  updatedAt: Date;
}

const bindingSchema = new mongoose.Schema({
  externalId: { type: String, required: true },
  label: { type: String, required: true },
  linkedAtIso: { type: String, required: true },
  expiresAtIso: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, { _id: false });

const identityProfileSchema = new mongoose.Schema<IIdentityProfile>({
  firebaseProjectId: { type: String, required: true },
  firebaseUid: { type: String, required: true },
  bindings: {
    discord: { type: bindingSchema, required: false },
    line: { type: bindingSchema, required: false },
    minecraft: { type: bindingSchema, required: false },
    radar: { type: bindingSchema, required: false },
  },
  audience: {
    memoryChannels: { type: [String], required: true },
    lineDeliveryEnabled: { type: Boolean, required: true },
    radarPersonalFeed: { type: Boolean, required: true },
  },
  revision: { type: Number, required: true, default: 0 },
  updatedAt: { type: Date, default: Date.now },
}, { autoIndex: false, collection: 'identityprofiles' });

identityProfileSchema.index({ firebaseProjectId: 1, firebaseUid: 1 }, { unique: true });
identityProfileSchema.index({ firebaseProjectId: 1, 'bindings.discord.externalId': 1 }, { sparse: true });

export const IdentityProfile = mongoose.model<IIdentityProfile>('IdentityProfile', identityProfileSchema);
