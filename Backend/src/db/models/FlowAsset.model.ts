import { Schema, model, Document, Types } from 'mongoose';
import type { MediaStorageProvider } from '../../shared/media-storage';

/**
 * A file uploaded from the flow builder (boleto PDF, QR image, block media) and
 * kept in object storage. Referenced by flow block configs via its public URL,
 * fetched unauthenticated by WhatsApp/Baileys.
 *
 * `accessToken` (32 random bytes, hex) is the real capability token for assets
 * uploaded after this field was added — `${PUBLIC_API_URL}/api/flow-assets/<_id>/<accessToken>`.
 * It's optional because pre-existing assets never got one: their URL (just the
 * `_id`) is already baked into saved flow block configs, so backfilling would
 * either break every flow using them or require rewriting arbitrary JSON across
 * every Flow document. Those keep working via the bare `_id` route instead —
 * lower entropy than a real token, but no worse than before this field existed.
 */
export interface IFlowAsset extends Document {
  workspaceId: Types.ObjectId;
  uploadedBy: Types.ObjectId;
  key: string;
  provider: MediaStorageProvider;
  mimeType: string;
  fileName: string;
  size: number;
  sha256: string;
  accessToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

const FlowAssetSchema = new Schema<IFlowAsset>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    uploadedBy:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key:         { type: String, required: true },
    provider:    { type: String, enum: ['local', 's3'], required: true },
    mimeType:    { type: String, required: true },
    fileName:    { type: String, required: true },
    size:        { type: Number, required: true },
    sha256:      { type: String, required: true },
    accessToken: { type: String },
  },
  { timestamps: true }
);

FlowAssetSchema.index({ workspaceId: 1, createdAt: -1 });

FlowAssetSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    delete r.key;
    delete r.provider;
    delete r.accessToken;
    return r;
  },
});

export const FlowAsset = model<IFlowAsset>('FlowAsset', FlowAssetSchema);
