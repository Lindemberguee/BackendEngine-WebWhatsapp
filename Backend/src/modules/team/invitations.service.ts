import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { User, Workspace } from '../../db/models';
import { WorkspaceInvitation } from '../../db/models/WorkspaceInvitation.model';
import { ensureAccount } from '../auth/account.service';
import { assertCanCreateAgent } from '../billing/billing.service';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export async function createInvitation(workspaceId: string, actorId: string, input: unknown) {
  const data = z.object({ name: z.string().trim().min(1).max(100), email: z.string().trim().toLowerCase().email().max(254), role: z.enum(['admin', 'agent', 'viewer']) }).parse(input);
  if (await User.exists({ workspaceId, email: data.email })) throw new Error('E-mail já cadastrado neste workspace');
  await assertCanCreateAgent(workspaceId);
  const token = randomBytes(32).toString('base64url');
  const invitation = await WorkspaceInvitation.create({ ...data, workspaceId, createdBy: actorId, tokenHash: digest(token), expiresAt: new Date(Date.now() + 7 * 86400_000) });
  return { id: String(invitation._id), ...data, token, expiresAt: invitation.expiresAt.toISOString() };
}

export async function acceptInvitation(userId: string, token: unknown) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Convite inválido ou expirado');
  const user = await User.findOne({ _id: userId, isActive: true });
  if (!user) throw new Error('Sessão inválida');
  const account = await ensureAccount(user);
  const invitation = await WorkspaceInvitation.findOne({ tokenHash: digest(token), expiresAt: { $gt: new Date() } });
  if (!invitation || invitation.email !== account.email) throw new Error('Convite inválido para esta conta');
  if (!(await Workspace.exists({ _id: invitation.workspaceId, status: { $ne: 'suspended' } }))) throw new Error('Workspace indisponível');
  if (!(await User.exists({ _id: invitation.createdBy, workspaceId: invitation.workspaceId, isActive: true, role: { $in: ['owner', 'admin'] } }))) throw new Error('Convite revogado');
  const existing = await User.findOne({ workspaceId: invitation.workspaceId, email: account.email });
  if (existing) {
    if (existing.isActive && String(existing.accountId) === String(account._id) && String(invitation.acceptedBy) === String(account._id)) return existing;
    throw new Error('Já existe um cadastro neste workspace; o convite não pode substituir uma identidade existente');
  }
  if (invitation.acceptedBy) throw new Error('Convite já utilizado');
  await assertCanCreateAgent(String(invitation.workspaceId));
  // Consume exactly once. A removed membership must never be recreated by replay.
  const claimed = await WorkspaceInvitation.findOneAndUpdate({ _id: invitation._id, acceptedBy: { $exists: false } }, { $set: { acceptedBy: account._id, acceptedAt: new Date() } }, { new: true });
  if (!claimed) throw new Error('Convite já utilizado');
  try {
    // updateOne deliberately bypasses User's plaintext-password save hook.
    await User.updateOne({ workspaceId: invitation.workspaceId, accountId: account._id }, { $setOnInsert: {
      name: user.name, email: account.email, passwordHash: account.passwordHash,
      role: invitation.role, isActive: true,
    } }, { upsert: true, runValidators: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  const member = await User.findOne({ workspaceId: invitation.workspaceId, accountId: account._id });
  if (!member) throw new Error('Não foi possível aceitar o convite');
  return member;
}
