import { Schema, model, Document, Types } from 'mongoose';

export type TemplateStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED';

export interface IWhatsAppTemplate extends Document {
  workspaceId: Types.ObjectId;
  instanceId: Types.ObjectId;
  name: string;
  language: string;
  category: string;
  status: TemplateStatus;
  /** Raw Meta components array (header/body/footer/buttons) — kept as-is
   *  (Mixed) since it drives both preview rendering and the {{1}}/{{2}}
   *  variable count, and Meta's shape varies per component type. */
  components: unknown;
  /** Positional variable count derived from the BODY component's {{n}} tokens
   *  — lets the flow/campaign UI render one input per variable without
   *  re-parsing `components` on every render. */
  variableCount: number;
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WhatsAppTemplateSchema = new Schema<IWhatsAppTemplate>(
  {
    workspaceId:   { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    instanceId:    { type: Schema.Types.ObjectId, ref: 'Instance', required: true },
    name:          { type: String, required: true },
    language:      { type: String, required: true },
    category:      { type: String, required: true },
    status:        { type: String, enum: ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED'], required: true },
    components:    { type: Schema.Types.Mixed },
    variableCount: { type: Number, default: 0 },
    syncedAt:      { type: Date, required: true },
  },
  { timestamps: true }
);

WhatsAppTemplateSchema.index({ workspaceId: 1, instanceId: 1, name: 1, language: 1 }, { unique: true });
WhatsAppTemplateSchema.index({ workspaceId: 1, instanceId: 1, status: 1 });

WhatsAppTemplateSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const WhatsAppTemplate = model<IWhatsAppTemplate>('WhatsAppTemplate', WhatsAppTemplateSchema);
