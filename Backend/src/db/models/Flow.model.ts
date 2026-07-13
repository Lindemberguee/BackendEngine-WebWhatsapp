import { Schema, model, Document, Types } from 'mongoose';

export interface IFlowNode {
  id: string;
  blockType: string;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface IFlowEdge {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
}

export interface IFlow extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  description?: string;
  enabled: boolean; // published + active
  folderId?: Types.ObjectId;
  /** Denormalized from the "Instância" block — the flow only runs on this instance. */
  instanceId?: Types.ObjectId;
  /** Denormalized from the trigger node for fast matching. */
  trigger: {
    type: 'keyword' | 'any_message' | 'new_contact' | 'scheduled' | 'manual' | 'crm_event' | 'webhook';
    keywords: string[];
    allowGroups?: boolean;
    /** crm_event only — which CRM event starts the flow. */
    crmEvent?: 'stage_changed' | 'won' | 'lost';
    /** crm_event only — restrict to a pipeline/stage; absent = any. */
    crmPipelineId?: Types.ObjectId;
    crmStageId?: string;
    /** webhook only — generated once, kept stable across saves; part of the public trigger URL /api/webhooks/in/:token. */
    webhookToken?: string;
  };
  nodes: IFlowNode[];
  edges: IFlowEdge[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const FlowSchema = new Schema<IFlow>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    enabled: { type: Boolean, default: false },
    folderId: { type: Schema.Types.ObjectId, ref: 'FlowFolder', default: null },
    instanceId: { type: Schema.Types.ObjectId, ref: 'Instance' },
    trigger: {
      type: { type: String, enum: ['keyword', 'any_message', 'new_contact', 'scheduled', 'manual', 'crm_event', 'webhook'], default: 'manual' },
      keywords: [{ type: String }],
      allowGroups: { type: Boolean, default: false },
      crmEvent: { type: String, enum: ['stage_changed', 'won', 'lost'] },
      crmPipelineId: { type: Schema.Types.ObjectId, ref: 'Pipeline' },
      crmStageId: { type: String },
      webhookToken: { type: String },
    },
    nodes: { type: Schema.Types.Mixed, default: [] },
    edges: { type: Schema.Types.Mixed, default: [] },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

FlowSchema.index({ workspaceId: 1, enabled: 1 });
FlowSchema.index({ workspaceId: 1, 'trigger.keywords': 1 });
FlowSchema.index({ workspaceId: 1, 'trigger.type': 1, 'trigger.crmEvent': 1 });
FlowSchema.index({ 'trigger.webhookToken': 1 }, { unique: true, sparse: true });

FlowSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const Flow = model<IFlow>('Flow', FlowSchema);
