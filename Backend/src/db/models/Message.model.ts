import { Schema, model, Document, Types } from 'mongoose';

export type MessageType =
  | 'text' | 'image' | 'video' | 'audio' | 'document'
  | 'sticker' | 'location' | 'contact' | 'poll'
  | 'interactive' | 'reaction' | 'system' | 'unknown';

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';

export interface IReaction {
  emoji: string;
  jid: string;             // Who reacted
  phone: string;           // Extracted from JID
  timestamp: Date;
}

export interface IQuotedContext {
  messageId: string;       // Reference to original message ID in our DB
  type: MessageType;       // text, image, video, audio, etc.
  preview: string;         // Text preview (first 100 chars) or type emoji
  senderName?: string;     // Who sent the original message
  timestamp: Date;         // When was it sent
}

export interface IMessage extends Document {
  workspaceId: Types.ObjectId;
  instanceId?: Types.ObjectId;  // Optional: only for messages from Baileys instances
  conversationId: Types.ObjectId;
  jid: string;
  messageId: string;       // WhatsApp message ID (key.id)
  direction: 'inbound' | 'outbound';
  type: MessageType;
  status: MessageStatus;
  fromMe: boolean;
  reactions?: IReaction[]; // Emoji reactions on this message
  // Polymorphic content per type
  content: {
    text?: string;
    caption?: string;
    url?: string;          // media URL
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
    thumbnailUrl?: string;
    latitude?: number;
    longitude?: number;
    address?: string;
    name?: string;         // poll name / contact name
    options?: string[];    // poll options
    emoji?: string;        // reaction emoji
    targetMessageId?: string; // reaction target
    vcard?: string;        // contact vCard
    // Media metadata (NEW)
    image?: {
      width?: number;
      height?: number;
      thumbnail?: string;  // base64
      mediaKey?: string;
      directPath?: string;
    };
    video?: {
      width?: number;
      height?: number;
      duration?: number;   // milliseconds
      thumbnail?: string;
      isGif?: boolean;
      gifAttribution?: string;
      mediaKey?: string;
      directPath?: string;
    };
    audio?: {
      duration?: number;   // milliseconds
      isVoiceMessage?: boolean;
      waveform?: string;   // base64
      mediaKey?: string;
      directPath?: string;
    };
    document?: {
      thumbnail?: string;
      mediaKey?: string;
      directPath?: string;
    };
    sticker?: {
      isAnimated?: boolean;
      width?: number;
      height?: number;
      mediaKey?: string;
      directPath?: string;
    };
    ptt?: boolean;         // voice message flag (for audio)
  };
  quoted?: IQuotedContext;   // Context of message being replied to
  senderName?: string;       // display name of the sender (used for group messages)
  senderJid?: string;        // JID of the sender (for group messages → click to profile)
  senderPhone?: string;      // Phone of the sender (extracted from senderJid)
  agentId?: Types.ObjectId;  // who sent (outbound)
  rawPayload?: Record<string, unknown>; // original Baileys message (debug)
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    workspaceId:    { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    instanceId:     { type: Schema.Types.ObjectId, ref: 'Instance' },  // Optional: for manual messages
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    jid:            { type: String, required: true },
    messageId:      { type: String, required: true },
    direction:      { type: String, enum: ['inbound', 'outbound'], required: true },
    type:           { type: String, enum: ['text','image','video','audio','document','sticker','location','contact','poll','interactive','reaction','system','unknown'], default: 'text' },
    status:         { type: String, enum: ['pending','sent','delivered','read','failed','deleted'], default: 'sent' },
    fromMe:         { type: Boolean, required: true },
    content:        { type: Schema.Types.Mixed, default: {} },
    quoted: {
      messageId:    { type: String },
      type:         { type: String },
      preview:      { type: String },
      senderName:   { type: String },
      timestamp:    { type: Date },
    },
    senderName:     { type: String },
    senderJid:      { type: String },       // JID of message sender (for group messages)
    senderPhone:    { type: String },       // Phone extracted from senderJid
    reactions: [{
      emoji:        { type: String, required: true },
      jid:          { type: String, required: true },
      phone:        { type: String },
      timestamp:    { type: Date, default: Date.now },
    }],
    agentId:        { type: Schema.Types.ObjectId, ref: 'User' },
    rawPayload:     { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

MessageSchema.index({ conversationId: 1, createdAt: -1 });
MessageSchema.index({ workspaceId: 1, messageId: 1 }, { unique: true });
MessageSchema.index({ status: 1 });

MessageSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    delete r.rawPayload;
    return r;
  },
});

export const Message = model<IMessage>('Message', MessageSchema);
