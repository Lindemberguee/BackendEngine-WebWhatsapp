import { Schema, model, Document, Types } from 'mongoose';

export type RoutingStrategy = 'round_robin' | 'least_busy' | 'manual';

export interface IBusinessHoursDay {
  weekday: number; // 0=domingo ... 6=sábado
  enabled: boolean;
  start: string; // 'HH:mm'
  end: string;   // 'HH:mm'
}

export interface IBusinessHours {
  timezone: string;
  schedule: IBusinessHoursDay[];
}

export interface ITeamGroupSla {
  enabled: boolean;
  firstResponseMinutes?: number;
  resolutionMinutes?: number;
}

export interface ITeamGroup extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  emoji?: string;
  color?: string;
  description?: string;
  leadId?: Types.ObjectId;
  memberIds: Types.ObjectId[];
  /** How an unassigned conversation routed to this queue picks an agent. 'manual' = auto-routing skips this queue entirely. */
  routingStrategy: RoutingStrategy;
  /** Advances on every round_robin pick; index into the eligible-members array at assignment time. */
  roundRobinCursor: number;
  /** When absent, falls back to Workspace.settings.defaultBusinessHours (always-on if that's absent too). */
  businessHours?: IBusinessHours;
  /** When absent or disabled, falls back to Workspace.settings.defaultSla. */
  sla?: ITeamGroupSla;
  createdAt: Date;
  updatedAt: Date;
}

const BusinessHoursDaySchema = new Schema<IBusinessHoursDay>(
  {
    weekday: { type: Number, required: true, min: 0, max: 6 },
    enabled: { type: Boolean, default: true },
    start:   { type: String, required: true },
    end:     { type: String, required: true },
  },
  { _id: false }
);

const BusinessHoursSchema = new Schema<IBusinessHours>(
  {
    timezone: { type: String, default: 'America/Sao_Paulo' },
    schedule: [BusinessHoursDaySchema],
  },
  { _id: false }
);

const TeamGroupSlaSchema = new Schema<ITeamGroupSla>(
  {
    enabled: { type: Boolean, default: false },
    firstResponseMinutes: { type: Number, min: 1 },
    resolutionMinutes:    { type: Number, min: 1 },
  },
  { _id: false }
);

const TeamGroupSchema = new Schema<ITeamGroup>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name:        { type: String, required: true, trim: true, maxlength: 80 },
    emoji:       { type: String, maxlength: 8 },
    color:       { type: String, maxlength: 20 },
    description: { type: String, maxlength: 300 },
    leadId:      { type: Schema.Types.ObjectId, ref: 'User' },
    memberIds:   [{ type: Schema.Types.ObjectId, ref: 'User' }],
    routingStrategy:  { type: String, enum: ['round_robin', 'least_busy', 'manual'], default: 'manual' },
    roundRobinCursor: { type: Number, default: 0 },
    businessHours: { type: BusinessHoursSchema },
    sla:           { type: TeamGroupSlaSchema },
  },
  { timestamps: true }
);

TeamGroupSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

export const TeamGroup = model<ITeamGroup>('TeamGroup', TeamGroupSchema);
