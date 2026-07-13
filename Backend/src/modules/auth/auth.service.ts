import { Types } from 'mongoose';
import { User, Workspace, Conversation, Message, Lead, AuditLog } from '../../db/models';
import type { IUser } from '../../db/models';
import { getOrCreateSubscription } from '../billing/billing.service';

export async function registerWorkspace(data: {
  workspaceName: string;
  ownerName: string;
  email: string;
  password: string;
  acceptedTerms: boolean;
}): Promise<{ user: IUser; workspaceId: string }> {
  if (!data.acceptedTerms) throw new Error('É necessário aceitar os Termos de Uso e a Política de Privacidade');

  const existing = await User.findOne({ email: data.email });
  if (existing) throw new Error('E-mail já cadastrado');

  const slug = data.workspaceName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 48);

  const slugExists = await Workspace.findOne({ slug });
  const finalSlug = slugExists ? `${slug}-${Date.now()}` : slug;

  // Create workspace first (ownerId will be updated after user creation)
  const workspace = await Workspace.create({
    name: data.workspaceName,
    slug: finalSlug,
    ownerId: new (await import('mongoose')).default.Types.ObjectId(),
  });

  // Pass the plain password — the User pre('save') hook hashes it once.
  const user = await User.create({
    workspaceId: workspace._id,
    name: data.ownerName,
    email: data.email,
    passwordHash: data.password,
    role: 'owner',
    isActive: true,
    termsAcceptedAt: new Date(),
  });

  workspace.ownerId = user._id as unknown as typeof workspace.ownerId;
  await workspace.save();

  // Starts a 14-day Pro trial (no card required) and syncs workspace.plan — see billing.service.ts
  await getOrCreateSubscription(workspace._id.toString());

  return { user, workspaceId: workspace._id.toString() };
}

export async function loginUser(email: string, password: string): Promise<IUser> {
  const user = await User.findOne({ email: email.toLowerCase(), isActive: true });
  if (!user) throw new Error('Credenciais inválidas');

  const valid = await user.comparePassword(password);
  if (!valid) throw new Error('Credenciais inválidas');

  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });

  return user;
}

export async function getUserById(userId: string): Promise<IUser | null> {
  return User.findById(userId);
}

/** Self-service profile update — name/avatar/phone/timezone/language/status only (never role/email/password here). */
export async function updateProfile(userId: string, patch: {
  name?: string; avatarUrl?: string; phone?: string; timezone?: string; language?: string;
  status?: { emoji?: string; text?: string };
}): Promise<IUser | null> {
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.avatarUrl !== undefined) update.avatarUrl = patch.avatarUrl;
  if (patch.phone !== undefined) update.phone = patch.phone;
  if (patch.timezone !== undefined) update.timezone = patch.timezone;
  if (patch.language !== undefined) update.language = patch.language;
  if (patch.status !== undefined) update.status = { ...patch.status, updatedAt: new Date() };
  return User.findByIdAndUpdate(userId, { $set: update }, { new: true });
}

/** Self-service password change — requires the current password. */
export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await User.findById(userId);
  if (!user) throw new Error('Usuário não encontrado');
  const valid = await user.comparePassword(currentPassword);
  if (!valid) throw new Error('Senha atual incorreta');
  if (newPassword.length < 8) throw new Error('A nova senha deve ter pelo menos 8 caracteres');
  user.passwordHash = newPassword; // pre('save') hook re-hashes
  user.tokenVersion += 1; // password change also invalidates other sessions
  await user.save();
}

/** Bumps tokenVersion so every previously-issued JWT stops validating — "log out other sessions". */
export async function bumpTokenVersion(userId: string): Promise<number> {
  const user = await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } }, { new: true }).select('tokenVersion');
  return user?.tokenVersion ?? 0;
}

/**
 * Personal performance snapshot: conversations assigned/resolved, messages sent,
 * and CRM deal outcomes — the same shape as the CRM agent leaderboard, scoped to "me".
 */
export async function getMyStats(workspaceId: string, userId: string) {
  const wid = new Types.ObjectId(workspaceId);
  const uid = new Types.ObjectId(userId);

  const [convAssigned, convResolved, messagesSent, wonLeads, lostLeads, wonValueAgg] = await Promise.all([
    Conversation.countDocuments({ workspaceId: wid, assignedAgentId: uid }),
    Conversation.countDocuments({ workspaceId: wid, assignedAgentId: uid, status: 'resolved' }),
    Message.countDocuments({ workspaceId: wid, direction: 'outbound', agentId: uid }),
    Lead.countDocuments({ workspaceId: wid, assigneeId: uid, status: 'won' }),
    Lead.countDocuments({ workspaceId: wid, assigneeId: uid, status: 'lost' }),
    Lead.aggregate([
      { $match: { workspaceId: wid, assigneeId: uid, status: 'won' } },
      { $group: { _id: null, total: { $sum: '$value' } } },
    ]),
  ]);

  const closedLeads = wonLeads + lostLeads;
  return {
    conversationsAssigned: convAssigned,
    conversationsResolved: convResolved,
    messagesSent,
    leadsWon: wonLeads,
    leadsLost: lostLeads,
    leadWinRate: closedLeads > 0 ? Math.round((wonLeads / closedLeads) * 100) : 0,
    wonValue: wonValueAgg[0]?.total ?? 0,
  };
}

/** Paginated feed of this user's own audit-log entries (any role — unlike GET /api/audit, which is admin-only). */
export async function getMyActivity(workspaceId: string, userId: string, page: number, limit: number) {
  const filter = { workspaceId, 'actor.id': userId };
  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  return {
    data: entries.map((e) => ({
      id: String(e._id), type: e.type, target: e.target?.type ? e.target : undefined,
      metadata: e.metadata, createdAt: e.createdAt.toISOString(),
    })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
