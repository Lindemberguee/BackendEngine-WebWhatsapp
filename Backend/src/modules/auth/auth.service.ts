import { ensureDefaultPipeline } from '../crm/crm.service';
import { z } from 'zod';
import { Account } from '../../db/models/Account.model';
import { ensureAccount, accountMembershipFilter } from './account.service';
import { Types } from 'mongoose';
import bcrypt from 'bcrypt';
import { User, Workspace, Conversation, Message, Lead, AuditLog, Subscription, Pipeline } from '../../db/models';
import type { IUser } from '../../db/models';
import { getOrCreateSubscription } from '../billing/billing.service';

export async function registerWorkspace(data: {
  workspaceName: string;
  ownerName: string;
  email: string;
  password: string;
  acceptedTerms: boolean;
}): Promise<{ user: IUser; workspaceId: string }> {
  const parsed = z.object({
    workspaceName: z.string().trim().min(1).max(100), ownerName: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(8).max(72),
    acceptedTerms: z.literal(true, { error: 'É necessário aceitar os Termos de Uso e a Política de Privacidade' }),
  }).safeParse(data);
  if (!parsed.success) throw Object.assign(new Error(parsed.error.issues[0].message), { statusCode: 400 });
  data = parsed.data;

  // Must match the exact normalization the schema applies on save (lowercase + trim) —
  // comparing the raw client string here let "Victim@Corp.com" sail past this check
  // against an already-normalized "victim@corp.com" in the DB, creating a second
  // account under the same real email in a brand-new workspace. From there
  // GET /api/workspaces and POST /api/workspaces/switch (which match by email) treated
  // it as the same person and handed out a valid owner session for the real account.
  const normalizedEmail = data.email.trim().toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) throw new Error('E-mail já cadastrado');

  const slug = data.workspaceName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 48);

  const slugExists = await Workspace.findOne({ slug });
  const finalSlug = slugExists ? `${slug}-${Date.now()}` : slug;

  // Create workspace first (ownerId will be updated after user creation)
  const accountId = new Types.ObjectId();
  const account = await Account.create({ _id: accountId, email: normalizedEmail, signupEmail: normalizedEmail, passwordHash: await bcrypt.hash(data.password, 12) });
  let createdWorkspaceId: Types.ObjectId | undefined;
  try {
  const workspace = await Workspace.create({
    name: data.workspaceName,
    slug: finalSlug,
    ownerId: new (await import('mongoose')).default.Types.ObjectId(),
  });

  // Pass the plain password — the User pre('save') hook hashes it once.
  createdWorkspaceId = workspace._id as Types.ObjectId;
  const user = await User.create({
    accountId: account._id,
    workspaceId: workspace._id,
    name: data.ownerName,
    email: normalizedEmail,
    passwordHash: data.password,
    role: 'owner',
    isActive: true,
    termsAcceptedAt: new Date(),
  });

  workspace.ownerId = user._id as unknown as typeof workspace.ownerId;
  await workspace.save();

  // Starts a 14-day Pro trial (no card required) and syncs workspace.plan — see billing.service.ts
  await getOrCreateSubscription(workspace._id.toString());
  await ensureDefaultPipeline(workspace._id.toString());

  return { user, workspaceId: workspace._id.toString() };
  } catch (error) {
    // Compensation is restricted to resources created by this attempt.
    if (createdWorkspaceId) {
      await User.deleteMany({ workspaceId: createdWorkspaceId, accountId });
      await Subscription.deleteMany({ workspaceId: createdWorkspaceId });
      await Pipeline.deleteMany({ workspaceId: createdWorkspaceId });
      await Workspace.deleteOne({ _id: createdWorkspaceId });
    }
    await Account.deleteOne({ _id: accountId });
    throw error;
  }
}

export async function loginUser(email: string, password: string): Promise<IUser> {
  if (typeof email !== 'string' || typeof password !== 'string' || password.length > 72) throw new Error('Credenciais inválidas');
  const users = await User.find({ email: email.trim().toLowerCase(), isActive: true });
  let hasValidCredential = false;
  for (const user of users) {
    const account = user.accountId ? await Account.findById(user.accountId) : null;
    const hash = user.accountId ? account?.passwordHash : user.passwordHash;
    if (!hash || !(await bcrypt.compare(password, hash))) continue;
    hasValidCredential = true;

    const workspace = await Workspace.findById(user.workspaceId).select('status').lean();
    if (!workspace || workspace.status === 'suspended') continue;

    await ensureAccount(user);
    await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
    return user;
  }
  if (hasValidCredential) throw new Error('Workspace suspenso — fale com o suporte');
  throw new Error('Credenciais inválidas');
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
  const account = await ensureAccount(user);
  const valid = await bcrypt.compare(currentPassword, account.passwordHash);
  if (!valid) throw new Error('Senha atual incorreta');
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72) throw new Error('A nova senha deve ter pelo menos 8 caracteres');
  // A person has one credential across every workspace they can switch to. Keep
  // all identity records aligned; otherwise an older workspace record could still
  // accept the previous password or its older JWTs.
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await Account.updateOne({ _id: account._id }, { $set: { passwordHash } });
  await User.updateMany(
    accountMembershipFilter(user),
    { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
  );
}

/** Bumps tokenVersion so every previously-issued JWT stops validating — "log out other sessions". */
export async function bumpTokenVersion(userId: string): Promise<number> {
  const user = await User.findById(userId).select('accountId');
  if (!user) return 0;
  await User.updateMany(accountMembershipFilter(user), { $inc: { tokenVersion: 1 } });
  const current = await User.findById(userId).select('tokenVersion');
  return current?.tokenVersion ?? 0;
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
