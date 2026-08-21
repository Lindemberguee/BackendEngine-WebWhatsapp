import { Types } from 'mongoose';
import { User, AuditLog } from '../../db/models';
import type { IUser, UserRole, IUserStatus, UserAvailability } from '../../db/models';
import { assertCanCreateAgent } from '../billing/billing.service';

// Roles an admin/owner may assign (never 'owner').
const ASSIGNABLE_ROLES: UserRole[] = ['admin', 'agent', 'viewer'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  avatarUrl?: string;
  status?: IUserStatus;
  availability: UserAvailability;
  maxConcurrentChats: number;
  lastLoginAt?: Date;
  createdAt: Date;
}

export function toTeamMember(u: IUser): TeamMember {
  return {
    id: u._id!.toString(),
    name: u.name,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    avatarUrl: u.avatarUrl,
    status: u.status,
    availability: u.availability,
    maxConcurrentChats: u.maxConcurrentChats,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

export async function listTeam(workspaceId: string): Promise<TeamMember[]> {
  const users = await User.find({ workspaceId: new Types.ObjectId(workspaceId) }).sort({ createdAt: 1 });
  return users.map(toTeamMember);
}

export async function createAgent(
  workspaceId: string,
  data: { name?: string; email?: string; password?: string; role?: string },
  actor?: { id: string; name: string; email: string }
): Promise<TeamMember> {
  const name = (data.name ?? '').trim();
  const email = (data.email ?? '').toLowerCase().trim();
  if (!name) throw new Error('Nome é obrigatório');
  if (!EMAIL_RE.test(email)) throw new Error('E-mail inválido');
  if (!data.password || data.password.length < 6) throw new Error('Senha deve ter ao menos 6 caracteres');
  const role = ASSIGNABLE_ROLES.includes((data.role ?? '') as UserRole) ? (data.role as UserRole) : 'agent';

  // Check uniqueness within the workspace
  const existing = await User.findOne({ email, workspaceId: new Types.ObjectId(workspaceId) });
  if (existing) throw new Error('E-mail já cadastrado neste workspace');

  await assertCanCreateAgent(workspaceId);

  const user = await User.create({
    workspaceId: new Types.ObjectId(workspaceId),
    name, email, passwordHash: data.password, role, isActive: true,
  });

  if (actor) {
    await AuditLog.create({
      workspaceId: new Types.ObjectId(workspaceId),
      actor: { id: new Types.ObjectId(actor.id), name: actor.name, email: actor.email },
      type: 'team.member_invited',
      target: { type: 'user', id: user._id!.toString(), label: `${name} (${email})` },
      metadata: { role },
    }).catch(() => {});
  }

  return toTeamMember(user);
}

export async function updateAgent(
  workspaceId: string,
  id: string,
  actorId: string,
  data: { name?: string; role?: string; isActive?: boolean; maxConcurrentChats?: number },
  actor?: { id: string; name: string; email: string }
): Promise<TeamMember> {
  const user = await User.findOne({ _id: id, workspaceId: new Types.ObjectId(workspaceId) });
  if (!user) throw new Error('Usuário não encontrado');
  if (user.role === 'owner') throw new Error('O proprietário não pode ser alterado');
  if (user._id!.toString() === actorId && data.isActive === false) throw new Error('Você não pode desativar a si mesmo');
  // assertCanCreateAgent only guards createAgent — reactivating a deactivated agent
  // is the same "one more active seat" event and was bypassing the cap entirely:
  // create up to the limit, deactivate one, create another (passes, since the
  // deactivated one doesn't count), then reactivate the first — over the limit.
  if (data.isActive === true && !user.isActive) {
    await assertCanCreateAgent(workspaceId);
  }

  const changes: Record<string, unknown> = {};
  if (data.name !== undefined) { user.name = data.name.trim(); changes.name = data.name.trim(); }
  if (data.role !== undefined && ASSIGNABLE_ROLES.includes(data.role as UserRole)) {
    changes.previousRole = user.role;
    changes.newRole = data.role;
    user.role = data.role as UserRole;
  }
  if (data.isActive !== undefined) { user.isActive = data.isActive; changes.isActive = data.isActive; }
  if (typeof data.maxConcurrentChats === 'number' && data.maxConcurrentChats >= 0) {
    user.maxConcurrentChats = data.maxConcurrentChats; changes.maxConcurrentChats = data.maxConcurrentChats;
  }
  // A role change or deactivation must invalidate any JWT already issued to this
  // user — otherwise their old token keeps working with the old (higher, or
  // simply still-active) privileges until it naturally expires. Same mechanism
  // already used for password changes (see hashPassword below).
  if (changes.newRole !== undefined || changes.isActive !== undefined) {
    user.tokenVersion += 1;
  }
  await user.save();

  if (actor && Object.keys(changes).length > 0) {
    const auditType = changes.newRole ? 'team.role_changed' : 'workspace.settings_updated';
    await AuditLog.create({
      workspaceId: new Types.ObjectId(workspaceId),
      actor: { id: new Types.ObjectId(actor.id), name: actor.name, email: actor.email },
      type: auditType,
      target: { type: 'user', id: user._id!.toString(), label: user.name },
      metadata: changes,
    }).catch(() => {});
  }

  return toTeamMember(user);
}

export async function removeAgent(
  workspaceId: string,
  id: string,
  actorId: string,
  actorRole: string,
  actor?: { id: string; name: string; email: string }
): Promise<void> {
  const user = await User.findOne({ _id: id, workspaceId: new Types.ObjectId(workspaceId) });
  if (!user) throw new Error('Usuário não encontrado');
  if (user.role === 'owner') throw new Error('O proprietário não pode ser removido');
  if (user._id!.toString() === actorId) throw new Error('Você não pode remover a si mesmo');
  // Admin cannot remove another admin — only owner can
  if (user.role === 'admin' && actorRole !== 'owner') throw new Error('Apenas o proprietário pode remover admins');

  const removedName = user.name;
  const removedEmail = user.email;
  await User.deleteOne({ _id: id });

  if (actor) {
    await AuditLog.create({
      workspaceId: new Types.ObjectId(workspaceId),
      actor: { id: new Types.ObjectId(actor.id), name: actor.name, email: actor.email },
      type: 'team.member_removed',
      target: { type: 'user', id, label: `${removedName} (${removedEmail})` },
    }).catch(() => {});
  }
}

export async function resetAgentPassword(
  workspaceId: string,
  id: string,
  actorId: string,
  newPassword: string
): Promise<void> {
  if (!newPassword || newPassword.length < 6) throw new Error('Senha deve ter ao menos 6 caracteres');
  const user = await User.findOne({ _id: id, workspaceId: new Types.ObjectId(workspaceId) });
  if (!user) throw new Error('Usuário não encontrado');
  if (user._id!.toString() === actorId) throw new Error('Use o perfil para alterar sua própria senha');
  // Same guard as updateAgent/removeAgent: without it, an admin can reset the
  // owner's password and sign in as them — the one role update/removal can't touch.
  if (user.role === 'owner') throw new Error('O proprietário não pode ser alterado');

  // The pre-save hook hashes the password. Also bump tokenVersion so any session
  // signed in with the old password is invalidated immediately.
  user.passwordHash = newPassword;
  user.tokenVersion += 1;
  await user.save();
}

const AVAILABILITY_VALUES: UserAvailability[] = ['available', 'busy', 'offline'];

/** Self-service: an agent flips their own readiness to receive auto-routed conversations. */
export async function updateAvailability(workspaceId: string, userId: string, availability: string): Promise<TeamMember> {
  if (!AVAILABILITY_VALUES.includes(availability as UserAvailability)) throw new Error('Disponibilidade inválida');
  const user = await User.findOneAndUpdate(
    { _id: userId, workspaceId: new Types.ObjectId(workspaceId) },
    { $set: { availability } },
    { new: true }
  );
  if (!user) throw new Error('Usuário não encontrado');
  return toTeamMember(user);
}

export async function getTeamStats(workspaceId: string): Promise<{
  total: number;
  active: number;
  inactive: number;
  byRole: Record<string, number>;
}> {
  const users = await User.find({ workspaceId: new Types.ObjectId(workspaceId) }).lean();
  const byRole: Record<string, number> = { owner: 0, admin: 0, agent: 0, viewer: 0 };
  let active = 0;
  for (const u of users) {
    byRole[u.role] = (byRole[u.role] ?? 0) + 1;
    if (u.isActive) active++;
  }
  return { total: users.length, active, inactive: users.length - active, byRole };
}
