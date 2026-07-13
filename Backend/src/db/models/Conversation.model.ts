import { Schema, model, Document, Types } from 'mongoose';

export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'snoozed' | 'closed';

export interface ILastMessage {
  content: string;
  type: string;
  direction: 'inbound' | 'outbound';
  timestamp: Date;
}

export interface IGroupParticipant {
  jid: string;
  phone: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin?: boolean;
}

export interface IGroupInfo {
  subject: string;
  picture?: string;
  description?: string;
  participantCount: number;
  ownerId?: string;
  isReadOnly: boolean;           // announce=true (admins-only write)
  adminOnly: boolean;             // restrict=true (admins-only settings)
  isCommunity: boolean;
  participants: IGroupParticipant[];
  createdAt?: Date;
}

export interface IChatMetadata {
  archived: boolean;
  pinnedPosition?: number;       // 0 or undefined = not pinned, >0 = position
  muteExpiredAt?: Date | null;   // null = muted forever, undefined = not muted
  archivedAt?: Date;
}

export interface IConversation extends Document {
  workspaceId: Types.ObjectId;
  instanceId?: Types.ObjectId;  // Optional: only for conversations from Baileys instances
  jid: string;           // WhatsApp JID: "5511999@s.whatsapp.net" or group "@g.us"
  name: string;
  phone?: string;
  avatarUrl?: string;
  status: ConversationStatus;
  assignedAgentId?: Types.ObjectId;
  unreadCount: number;
  tags: string[];
  lastMessage?: ILastMessage;
  isGroup: boolean;
  groupInfo?: IGroupInfo;         // Only for isGroup=true
  chatMetadata?: IChatMetadata;   // Archived, pinned, muted status
  snoozedUntil?: Date;
  contactId?: Types.ObjectId;
  teamGroupId?: Types.ObjectId;
  attendanceMode: 'bot' | 'human' | 'idle';
  attendanceModeChangedAt?: Date;
  /** Set whenever auto-routing (not a manual assign) picks an agent for this conversation. */
  routedAt?: Date;
  /** When the agent's first-response clock expires (set on the inbound message that opens/reopens the ticket). Cleared on resolve. */
  firstResponseDueAt?: Date;
  /** Set once an agent (human) sends the first outbound message after the ticket was opened. */
  firstRespondedAt?: Date;
  /** When the resolution clock expires. Cleared on resolve. */
  resolutionDueAt?: Date;
  slaFirstResponseBreached: boolean;
  slaResolutionBreached: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>(
  {
    workspaceId:      { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    instanceId:       { type: Schema.Types.ObjectId, ref: 'Instance' },  // Optional: for manual conversations
    jid:              { type: String, required: true },
    name:             { type: String, required: true },
    phone:            { type: String },
    avatarUrl:        { type: String },
    status:           { type: String, enum: ['open', 'pending', 'resolved', 'snoozed', 'closed'], default: 'open' },
    assignedAgentId:  { type: Schema.Types.ObjectId, ref: 'User' },
    unreadCount:      { type: Number, default: 0, min: 0 },
    tags:             [{ type: String }],
    lastMessage: {
      content:   { type: String },
      type:      { type: String },
      direction: { type: String, enum: ['inbound', 'outbound'] },
      timestamp: { type: Date },
    },
    isGroup:      { type: Boolean, default: false },
    groupInfo: {
      subject:         { type: String },
      picture:         { type: String },
      description:     { type: String },
      participantCount: { type: Number },
      ownerId:         { type: String },
      isReadOnly:      { type: Boolean, default: false },
      adminOnly:       { type: Boolean, default: false },
      isCommunity:     { type: Boolean, default: false },
      participants: [{
        jid:           { type: String, required: true },
        phone:         { type: String },
        name:          { type: String },
        isAdmin:       { type: Boolean, default: false },
        isSuperAdmin:  { type: Boolean },
      }],
      createdAt:       { type: Date },
    },
    chatMetadata: {
      archived:       { type: Boolean, default: false },
      pinnedPosition: { type: Number },
      muteExpiredAt:  { type: Date },
      archivedAt:     { type: Date },
    },
    snoozedUntil: { type: Date },
    contactId:    { type: Schema.Types.ObjectId, ref: 'Contact' },
    teamGroupId:  { type: Schema.Types.ObjectId, ref: 'TeamGroup' },
    attendanceMode: { type: String, enum: ['bot', 'human', 'idle'], default: 'idle' },
    attendanceModeChangedAt: { type: Date },
    routedAt: { type: Date },
    firstResponseDueAt: { type: Date },
    firstRespondedAt:   { type: Date },
    resolutionDueAt:    { type: Date },
    slaFirstResponseBreached: { type: Boolean, default: false },
    slaResolutionBreached:    { type: Boolean, default: false },
  },
  { timestamps: true }
);

ConversationSchema.index({ workspaceId: 1, status: 1 });
ConversationSchema.index({ workspaceId: 1, instanceId: 1, jid: 1 }, { unique: true, sparse: true });
ConversationSchema.index({ workspaceId: 1, jid: 1 }, { unique: true, sparse: true });  // For manual conversations without instanceId
ConversationSchema.index({ workspaceId: 1, assignedAgentId: 1 });
ConversationSchema.index({ workspaceId: 1, teamGroupId: 1 });
ConversationSchema.index({ workspaceId: 1, attendanceMode: 1 });
ConversationSchema.index({ updatedAt: -1 });
ConversationSchema.index({ workspaceId: 1, slaFirstResponseBreached: 1, firstResponseDueAt: 1 });
ConversationSchema.index({ workspaceId: 1, slaResolutionBreached: 1, resolutionDueAt: 1 });

ConversationSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const Conversation = model<IConversation>('Conversation', ConversationSchema);
