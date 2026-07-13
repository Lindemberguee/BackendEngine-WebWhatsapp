import { Schema, model, Document, Types } from 'mongoose';

export type StageKind = 'open' | 'won' | 'lost';

export interface IStage {
  id: string;
  name: string;
  order: number;
  color: string;
  kind: StageKind;
  /** Win likelihood (0-100) for weighted forecast; defaults by kind if unset. */
  probability?: number;
}

export type CustomFieldType = 'text' | 'number' | 'date' | 'select';

export interface ICustomFieldDef {
  key: string;
  label: string;
  type: CustomFieldType;
  options?: string[]; // for type: 'select'
}

export interface IPipeline extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  description?: string;
  stages: IStage[];
  isDefault: boolean;
  archived: boolean;
  /** Auto-create a lead in this pipeline whenever a brand-new conversation starts. */
  autoCreateFromConversation: boolean;
  /** Field schema for the free-form Lead.customFields map, so the UI knows what to render. */
  customFieldDefs: ICustomFieldDef[];
  createdAt: Date;
  updatedAt: Date;
}

const StageSchema = new Schema<IStage>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    color: { type: String, default: '#64748B' },
    kind: { type: String, enum: ['open', 'won', 'lost'], default: 'open' },
    probability: { type: Number, min: 0, max: 100 },
  },
  { _id: false }
);

const CustomFieldDefSchema = new Schema<ICustomFieldDef>(
  {
    key: { type: String, required: true },
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: ['text', 'number', 'date', 'select'], default: 'text' },
    options: [{ type: String }],
  },
  { _id: false }
);

const PipelineSchema = new Schema<IPipeline>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    stages: { type: [StageSchema], default: [] },
    isDefault: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    autoCreateFromConversation: { type: Boolean, default: false },
    customFieldDefs: { type: [CustomFieldDefSchema], default: [] },
  },
  { timestamps: true }
);

PipelineSchema.index({ workspaceId: 1, archived: 1 });

PipelineSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const Pipeline = model<IPipeline>('Pipeline', PipelineSchema);
