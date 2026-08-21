import { Schema, model, Document, Types } from 'mongoose';

export type ContactStatus = 'active' | 'blocked' | 'archived';
export type ContactSource = 'manual' | 'whatsapp' | 'import' | 'api';

export interface IContact extends Document {
  workspaceId: Types.ObjectId;
  jid: string;       // WhatsApp JID (unique per workspace)
  phone: string;     // Phone number
  name: string;      // Display name (editable)
  pushName?: string; // Name from WhatsApp (read-only)
  email?: string;    // Email address
  company?: string;  // Company name
  position?: string; // Job title
  avatarUrl?: string; // Profile picture
  tags: string[];    // Custom tags
  notes?: string;    // Internal notes
  status: ContactStatus; // active, blocked, or archived
  source: ContactSource; // How was this contact added
  customFields?: Map<string, unknown>; // Extensible data
  isBlocked: boolean; // Deprecated: use status instead, kept for backwards compat
  conversationCount: number; // Number of conversations with this contact
  lastSeenAt?: Date; // Last time they messaged us
  /** Set when the contact opts out of bulk/campaign messages (e.g. replies "PARAR"). Excluded from all campaign audiences. */
  optedOutAt?: Date;
  whatsappOptInAt?: Date;
  whatsappOptInSource?: string;
  whatsappOptInProof?: string;
  metadata?: {
    source?: string;
    importedFrom?: string;
    blockedAt?: Date;
    archivedAt?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const ContactSchema = new Schema<IContact>(
  {
    workspaceId:       { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    jid:               { type: String, required: true },
    phone:             { type: String, required: true },
    name:              { type: String, required: true, trim: true },
    pushName:          { type: String },
    email:             { type: String, lowercase: true, trim: true, sparse: true },
    company:           { type: String, trim: true },
    position:          { type: String, trim: true },
    avatarUrl:         { type: String },
    tags:              [{ type: String }],
    notes:             { type: String, default: '' },
    status:            { type: String, enum: ['active', 'blocked', 'archived'], default: 'active' },
    source:            { type: String, enum: ['manual', 'whatsapp', 'import', 'api'], default: 'whatsapp' },
    customFields:      { type: Map, of: Schema.Types.Mixed, default: {} },
    isBlocked:         { type: Boolean, default: false }, // Deprecated: use status
    conversationCount: { type: Number, default: 0, min: 0 },
    lastSeenAt:        { type: Date },
    optedOutAt:        { type: Date },
    whatsappOptInAt:   { type: Date },
    whatsappOptInSource: { type: String },
    whatsappOptInProof:  { type: String },
    metadata: {
      source:         { type: String },
      importedFrom:   { type: String },
      blockedAt:      { type: Date },
      archivedAt:     { type: Date },
    },
  },
  { timestamps: true }
);

// Indexes for optimal query performance
ContactSchema.index({ workspaceId: 1, jid: 1 }, { unique: true });
ContactSchema.index({ workspaceId: 1, phone: 1 });
ContactSchema.index({ workspaceId: 1, status: 1 });
ContactSchema.index({ workspaceId: 1, tags: 1 });
ContactSchema.index({ workspaceId: 1, email: 1 });
// Text search: name + phone (for search bar)
ContactSchema.index({ workspaceId: 1, name: 'text', phone: 'text', email: 'text' });
// For "recently active" queries
ContactSchema.index({ workspaceId: 1, lastSeenAt: -1 });
// For sorting by created date
ContactSchema.index({ workspaceId: 1, createdAt: -1 });

ContactSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const Contact = model<IContact>('Contact', ContactSchema);
