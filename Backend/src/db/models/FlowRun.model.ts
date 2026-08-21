import { Schema, model, Document, Types } from 'mongoose';

// 'delayed' — parked mid-automation.delay, waiting for `resumeAt` via the flow-run
// scheduler (see flow-executor/flow-run-scheduler.ts) instead of an in-process
// setTimeout, so it survives a process restart.
export type FlowRunStatus = 'running' | 'waiting' | 'delayed' | 'completed' | 'failed' | 'cancelled';

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
    /** How many non-matching replies have been received in a row at this node —
     *  buttons/list/cta/carousel blocks with `retryOnInvalid` on use this to send
     *  a nudge and eventually fall through to the 'invalid' port instead of
     *  waiting silently forever. */
    invalidAttempts?: number;
  };
  /** When status='delayed', when the flow-run scheduler should resume this run. */
  resumeAt?: Date;
  /** Total nodes advanced through across this run's whole lifetime (including
   *  resumes after delay/waiting) — a hard budget against infinite loops. */
  stepCount: number;
  /** How many automation.jump_flow hops led to this run (0 for a directly-triggered
   *  run) — carried forward on every jump so a jump cycle (A→B→A→...) can't spawn
   *  runs forever. */
  jumpDepth: number;
  /** Set when status='failed' — why the run stopped (budget exceeded, node threw, etc). */
  failureReason?: string;
  triggerMessageId?: string;
  lastInboundMessageId?: string;
  /** Set only for a run started by a 'scheduled' trigger — a snapshot of the anchor
   *  timestamp (conversation.createdAt / lastMessage.timestamp / resolvedAt) that
   *  fired it. Lets the scheduled-event sweep tell "already fired for this episode"
   *  apart from "the anchor moved (new message/reopen) and it's due again" without
   *  a separate cooldown table. */
  scheduledEventSourceAt?: Date;
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
    status: { type: String, enum: ['running', 'waiting', 'delayed', 'completed', 'failed', 'cancelled'], default: 'running' },
    waiting: {
      nodeId: { type: String },
      portIds: [{ type: String }],
      kind: { type: String, enum: ['reply', 'button', 'list', 'poll'] },
      waitingUntil: { type: Date },
    },
    resumeAt: { type: Date },
    stepCount: { type: Number, default: 0 },
    jumpDepth: { type: Number, default: 0 },
    failureReason: { type: String },
    triggerMessageId: { type: String },
    lastInboundMessageId: { type: String },
    scheduledEventSourceAt: { type: Date },
  },
  { timestamps: true }
);

// At most one active run per conversation (a conversation follows one flow at a time).
FlowRunSchema.index({ conversationId: 1, status: 1 });
FlowRunSchema.index({ workspaceId: 1, status: 1 });
// Covers the flow-run scheduler's sweep for delayed continuations and wait_response
// timeouts (see flow-run-scheduler.ts).
FlowRunSchema.index({ status: 1, resumeAt: 1 });
FlowRunSchema.index({ status: 1, 'waiting.waitingUntil': 1 });
// Covers GET /api/flows/:id/runs (execution history) — find({flowId, workspaceId}).sort({updatedAt:-1}).
FlowRunSchema.index({ flowId: 1, workspaceId: 1, updatedAt: -1 });
// Covers the scheduled-event trigger's per-conversation dedup check (already fired
// for this anchor timestamp?) in scheduled-event-trigger.ts.
FlowRunSchema.index({ flowId: 1, conversationId: 1, scheduledEventSourceAt: 1 });

export const FlowRun = model<IFlowRun>('FlowRun', FlowRunSchema);
