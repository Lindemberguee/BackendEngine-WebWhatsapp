import { Schema, model, Document, Types } from 'mongoose';
import bcrypt from 'bcrypt';

export type UserRole = 'owner' | 'admin' | 'agent' | 'viewer';
export type UserAvailability = 'available' | 'busy' | 'offline';

export interface IUserStatus {
  emoji?: string;
  text?: string;
  updatedAt?: Date;
}

export interface IUser extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  avatarUrl?: string;
  phone?: string;
  timezone?: string;
  language?: string;
  /** WhatsApp-style presence shown to teammates (e.g. in the transfer picker). */
  status?: IUserStatus;
  /** Self-reported readiness to receive auto-routed conversations. Defaults to offline so new agents aren't routed to until they opt in. */
  availability: UserAvailability;
  /** Cap on concurrently-assigned open/pending conversations for auto-routing. 0 = unlimited. */
  maxConcurrentChats: number;
  isActive: boolean;
  lastLoginAt?: Date;
  /** Set once, at registration — required to create an account (see auth.service.ts). */
  termsAcceptedAt?: Date;
  /** Bumped to invalidate every previously-issued JWT ("log out other sessions"). */
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(plain: string): Promise<boolean>;
}

const UserStatusSchema = new Schema<IUserStatus>(
  { emoji: { type: String }, text: { type: String, trim: true, maxlength: 80 }, updatedAt: { type: Date } },
  { _id: false }
);

const UserSchema = new Schema<IUser>(
  {
    workspaceId:  { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name:         { type: String, required: true, trim: true },
    email:        { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role:         { type: String, enum: ['owner', 'admin', 'agent', 'viewer'], default: 'agent' },
    avatarUrl:    { type: String },
    phone:        { type: String, trim: true },
    timezone:     { type: String, default: 'America/Sao_Paulo' },
    language:     { type: String, default: 'pt-BR' },
    status:       { type: UserStatusSchema },
    availability: { type: String, enum: ['available', 'busy', 'offline'], default: 'offline' },
    maxConcurrentChats: { type: Number, default: 0, min: 0 },
    isActive:     { type: Boolean, default: true },
    lastLoginAt:  { type: Date },
    termsAcceptedAt: { type: Date },
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

UserSchema.index({ email: 1, workspaceId: 1 }, { unique: true });

UserSchema.methods.comparePassword = function (plain: string): Promise<boolean> {
  return bcrypt.compare(plain, this.passwordHash);
};

UserSchema.pre('save', async function () {
  if (this.isModified('passwordHash')) {
    this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
  }
});

export const User = model<IUser>('User', UserSchema);
