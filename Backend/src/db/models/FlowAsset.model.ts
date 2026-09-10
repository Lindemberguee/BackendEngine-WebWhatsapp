import { Schema, model, Document, Types } from 'mongoose';
import type { MediaStorageProvider } from '../../shared/media-storage';

/**
 * A file uploaded from the flow builder (boleto PDF, QR image, block media) and
 * kept in object storage. Referenced by flow block configs via its public URL
 * `${PUBLIC_API_URL}/api/flow-assets/<_id>`, which is fetched unauthenticated by
 * WhatsApp/Baileys — so the `_id` is the only capability token (24 hex chars).
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
    return r;
  },
});

export const FlowAsset = model<IFlowAsset>('FlowAsset', FlowAssetSchema);
