import { Schema, model, Document, Types } from 'mongoose';

export type InvoiceStatus = 'paid' | 'open' | 'draft' | 'void';

/**
 * Generated locally by billing.service.ts whenever a subscription period
 * rolls over — there is no real payment gateway yet, so every invoice is
 * created already 'paid' (self-serve, no actual charge). Once a real
 * PaymentGateway is wired, invoices should instead start 'open' and flip to
 * 'paid' from the gateway's webhook.
 */
export interface IInvoice extends Document {
  workspaceId: Types.ObjectId;
  subscriptionId: Types.ObjectId;
  number: string;
  status: InvoiceStatus;
  amountCents: number;
  periodStart: Date;
  periodEnd: Date;
  paidAt?: Date;
  dueDate: Date;
  description: string;
  pdfUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const InvoiceSchema = new Schema<IInvoice>(
  {
    workspaceId:    { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true },
    number:         { type: String, required: true },
    status:         { type: String, enum: ['paid', 'open', 'draft', 'void'], default: 'paid' },
    amountCents:    { type: Number, required: true },
    periodStart:    { type: Date, required: true },
    periodEnd:      { type: Date, required: true },
    paidAt:         { type: Date },
    dueDate:        { type: Date, required: true },
    description:    { type: String, required: true },
    pdfUrl:         { type: String },
  },
  { timestamps: true }
);

InvoiceSchema.index({ workspaceId: 1, createdAt: -1 });

InvoiceSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const Invoice = model<IInvoice>('Invoice', InvoiceSchema);
