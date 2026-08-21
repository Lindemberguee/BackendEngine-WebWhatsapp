import { Schema, model, Document, Types } from 'mongoose';

export type ScheduledMessageStatus = 'scheduled' | 'sent' | 'cancelled' | 'failed';

/**
 * A message queued to be sent later ("enviar mais tarde" in ChatInput). Kept
 * as its own collection rather than living in Message — Message.messageId is
 * a required, unique-per-workspace field (it's WhatsApp's own key.id), and a
 * not-yet-sent message doesn't have one yet. v1 scope: text only.
 */
export interface IScheduledMessage extends Document {
  workspaceId: Types.ObjectId;
  conversationId: Types.ObjectId;
  jid: string;
  instanceId?: Types.ObjectId;
  agentId?: Types.ObjectId;
  type: 'text';
  content: { text: string };
  quotedMessageId?: string;
  scheduledAt: Date;
  status: ScheduledMessageStatus;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ScheduledMessageSchema = new Schema<IScheduledMessage>(
  {
    workspaceId:    { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    jid:            { type: String, required: true },
    instanceId:     { type: Schema.Types.ObjectId, ref: 'Instance' },
    agentId:        { type: Schema.Types.ObjectId, ref: 'User' },
    type:           { type: String, enum: ['text'], default: 'text' },
    content: {
      text: { type: String, required: true },
    },
    quotedMessageId: { type: String },
    scheduledAt:     { type: Date, required: true },
    status:          { type: String, enum: ['scheduled', 'sent', 'cancelled', 'failed'], default: 'scheduled' },
    failureReason:   { type: String },
  },
  { timestamps: true }
);

ScheduledMessageSchema.index({ status: 1, scheduledAt: 1 });
ScheduledMessageSchema.index({ conversationId: 1, status: 1 });

ScheduledMessageSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const ScheduledMessage = model<IScheduledMessage>('ScheduledMessage', ScheduledMessageSchema);
