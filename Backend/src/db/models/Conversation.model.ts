import { Schema, model, Document, Types } from 'mongoose';

export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'snoozed' | 'closed';

export interface ILastMessage {
  content: string;
  type: string;
  direction: 'inbound' | 'outbound';
  timestamp: Date;
  /** Group messages only — who sent it, so the list preview can show "João: texto". */
  senderName?: string;
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
  /** Group conversations only — lets the bot run in this specific group even when the
   *  matching flow's trigger doesn't have allowGroups on workspace-wide. Default off:
   *  the bot never runs in a group unless explicitly turned on here. */
  allowBotInGroups?: boolean;
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
  /** Set when a conversation is resolved (manually or by a flow) — the reason itself is optional. */
  closeReasonId?: Types.ObjectId;
  resolvedAt?: Date;
  /** Timestamp of the last message FROM the contact (inbound only — unlike
   *  `lastMessage.timestamp`, which also advances on our own outbound sends).
   *  Cloud API channel only: enforces the 24h free-form messaging window —
   *  outside it, only an approved template can be sent. See CloudApiSession.sendMessage. */
  lastInboundAt?: Date;
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
      content:    { type: String },
      type:       { type: String },
      direction:  { type: String, enum: ['inbound', 'outbound'] },
      timestamp:  { type: Date },
      senderName: { type: String },
    },
    isGroup:      { type: Boolean, default: false },
    allowBotInGroups: { type: Boolean, default: false },
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
    closeReasonId: { type: Schema.Types.ObjectId, ref: 'CloseReason' },
    resolvedAt:    { type: Date },
    lastInboundAt: { type: Date },
  },
  { timestamps: true }
);

ConversationSchema.index({ workspaceId: 1, status: 1 });
ConversationSchema.index({ workspaceId: 1, instanceId: 1, jid: 1 }, { unique: true, sparse: true });
ConversationSchema.index({ workspaceId: 1, jid: 1 }); // Shared-contact history lookup; conversations stay isolated per instance.
ConversationSchema.index({ workspaceId: 1, assignedAgentId: 1 });
ConversationSchema.index({ workspaceId: 1, teamGroupId: 1 });
ConversationSchema.index({ workspaceId: 1, attendanceMode: 1 });
ConversationSchema.index({ updatedAt: -1 });
ConversationSchema.index({ workspaceId: 1, slaFirstResponseBreached: 1, firstResponseDueAt: 1 });
ConversationSchema.index({ workspaceId: 1, slaResolutionBreached: 1, resolutionDueAt: 1 });
// Covers GET /api/conversations's actual query shape: filtered by workspace + archived
// flag, sorted by updatedAt — the old global `{ updatedAt: -1 }` index above isn't
// workspace-prefixed, so this exact (and most common) query fell back to an in-memory
// sort across every matching document instead of a covered index scan.
ConversationSchema.index({ workspaceId: 1, 'chatMetadata.archived': 1, updatedAt: -1 });
// Covers the lazy snooze-expiry sweep (conversations.routes.ts's GET /) — status +
// snoozedUntil range together, not just status alone.
ConversationSchema.index({ workspaceId: 1, status: 1, snoozedUntil: 1 });
// Covers the `?tag=` filter on the same listing route.
ConversationSchema.index({ workspaceId: 1, tags: 1 });
// Covers instances.service.ts's countDocuments({instanceId}) per-instance stat —
// the existing {workspaceId,instanceId,jid} unique index requires jid too, so it
// doesn't serve an instanceId-only count.
ConversationSchema.index({ instanceId: 1 });
// Covers reports.service.ts's and scheduled-event-trigger.ts's workspace + date-range
// queries (created-in-period, resolved-in-period) — same reasoning as Message's
// {workspaceId,createdAt} index above: without these, those queries fetch every
// conversation in the workspace to filter the date in memory.
ConversationSchema.index({ workspaceId: 1, createdAt: -1 });
ConversationSchema.index({ workspaceId: 1, resolvedAt: -1 });

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
