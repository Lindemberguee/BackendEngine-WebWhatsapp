import { Schema, model, Document, Types } from 'mongoose';

export type InstanceStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_pending'
  | 'pairing_pending'
  | 'connected'
  | 'banned'
  | 'error';

export interface IInstance extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  /** 'baileys' (default) = unofficial WhatsApp Web protocol, QR/pairing-code
   *  linked. 'cloud_api' = Meta's official WhatsApp Cloud API, BYO-WABA
   *  credentials (see the `cloudApi` subdoc, added alongside CloudApiSession). */
  channel: 'baileys' | 'cloud_api';
  phone?: string;
  status: InstanceStatus;
  qrCode?: string;       // base64 PNG
  pairingCode?: string;  // 8-digit code
  // Baileys auth state stored directly in document
  authCreds?: Record<string, unknown>;
  authKeys?: Record<string, Record<string, unknown>>;
  webhookUrl?: string;
  lastConnectedAt?: Date;
  lastDisconnectedAt?: Date;
  errorMessage?: string;
  /** channel='cloud_api' only — BYO-WABA credentials, pasted by the workspace
   *  owner/admin. accessTokenEnc/appSecretEnc are AES-256-GCM ciphertext (see
   *  shared/crypto.ts) — never stored or returned in plaintext. */
  cloudApi?: {
    phoneNumberId: string;
    wabaId: string;
    businessId?: string;
    displayPhoneNumber?: string;
    accessTokenEnc: string;
    appSecretEnc: string;
    /** Random, server-generated — compared against Meta's webhook handshake
     *  `hub.verify_token`. Not chosen by the client. */
    verifyToken: string;
    /** Last 4 chars of the access token, for the UI to show "connected as ...1234"
     *  without ever exposing the full token again. */
    tokenLast4: string;
    graphVersion: string;
    verifiedName?: string;
    qualityRating?: string;
    webhookSubscribed?: boolean;
    phoneRegisteredAt?: Date;
    lastHealthCheckAt?: Date;
    messagingLimit?: string;
    tokenExpiresAt?: Date;
    tokenExpiryAlertedAt?: Date;
    tokenScopes?: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

const InstanceSchema = new Schema<IInstance>(
  {
    workspaceId:         { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name:                { type: String, required: true, trim: true },
    channel:             { type: String, enum: ['baileys', 'cloud_api'], default: 'baileys' },
    phone:               { type: String },
    status:              { type: String, enum: ['disconnected', 'connecting', 'qr_pending', 'pairing_pending', 'connected', 'banned', 'error'], default: 'disconnected' },
    qrCode:              { type: String },
    pairingCode:         { type: String },
    authCreds:           { type: Schema.Types.Mixed },
    authKeys:            { type: Schema.Types.Mixed },
    webhookUrl:          { type: String },
    lastConnectedAt:     { type: Date },
    lastDisconnectedAt:  { type: Date },
    errorMessage:        { type: String },
    cloudApi: {
      phoneNumberId:      { type: String },
      wabaId:             { type: String },
      businessId:         { type: String },
      displayPhoneNumber: { type: String },
      accessTokenEnc:     { type: String },
      appSecretEnc:       { type: String },
      verifyToken:        { type: String },
      tokenLast4:         { type: String },
      graphVersion:       { type: String },
      verifiedName:       { type: String },
      qualityRating:      { type: String },
      webhookSubscribed:  { type: Boolean, default: false },
      phoneRegisteredAt:   { type: Date },
      lastHealthCheckAt:  { type: Date },
      messagingLimit:     { type: String },
      tokenExpiresAt:     { type: Date },
      tokenExpiryAlertedAt: { type: Date },
      tokenScopes:        [{ type: String }],
    },
  },
  { timestamps: true }
);

// Covers instances.service.ts's list() query: find({workspaceId}).sort({createdAt:-1}).
InstanceSchema.index({ workspaceId: 1, createdAt: -1 });
InstanceSchema.index({ status: 1 });

// Never return auth credentials in API responses
InstanceSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    delete r.authCreds;
    delete r.authKeys;
    const cloudApi = r.cloudApi as Record<string, unknown> | undefined;
    if (cloudApi) {
      delete cloudApi.accessTokenEnc;
      delete cloudApi.appSecretEnc;
      delete cloudApi.verifyToken;
    }
    return r;
  },
});

export const Instance = model<IInstance>('Instance', InstanceSchema);
