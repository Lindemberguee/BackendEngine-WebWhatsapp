import { Schema, model, Document, Types } from 'mongoose';

export type FlowRunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface IFlowRun extends Document {
  workspaceId: Types.ObjectId;
  instanceId: Types.ObjectId;
  flowId: Types.ObjectId;
  conversationId: Types.ObjectId;
  jid: string;
  currentNodeId?: string;
  /** Saved variables (save_response, ask_ai, classify results…). */
  variables: Record<string, unknown>;
  status: FlowRunStatus;
  /** When status='waiting', which ports of currentNode a reply can resume. */
  waiting?: {
    nodeId: string;
    portIds: string[];
    kind: 'reply' | 'button' | 'list' | 'poll';
    /** Absolute timestamp after which the 'timeout' port fires (wait_response only). */
    waitingUntil?: Date;
  };
  triggerMessageId?: string;
  lastInboundMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const FlowRunSchema = new Schema<IFlowRun>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    instanceId: { type: Schema.Types.ObjectId, ref: 'Instance', required: true },
    flowId: { type: Schema.Types.ObjectId, ref: 'Flow', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    jid: { type: String, required: true },
    currentNodeId: { type: String },
    variables: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['running', 'waiting', 'completed', 'failed', 'cancelled'], default: 'running' },
    waiting: {
      nodeId: { type: String },
      portIds: [{ type: String }],
      kind: { type: String, enum: ['reply', 'button', 'list', 'poll'] },
      waitingUntil: { type: Date },
    },
    triggerMessageId: { type: String },
    lastInboundMessageId: { type: String },
  },
  { timestamps: true }
);

// At most one active run per conversation (a conversation follows one flow at a time).
FlowRunSchema.index({ conversationId: 1, status: 1 });
FlowRunSchema.index({ workspaceId: 1, status: 1 });

export const FlowRun = model<IFlowRun>('FlowRun', FlowRunSchema);
