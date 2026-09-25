import bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import { Account } from '../../db/models/Account.model';
import { User, Workspace, AuthSession } from '../../db/models';
import type { IUser } from '../../db/models';

export function accountMembershipFilter(user: { _id?: unknown; accountId?: Types.ObjectId }) {
  // A legacy record without an explicit link authorizes only itself.
  return user.accountId ? { accountId: user.accountId } : { _id: user._id };
}

export async function ensureAccount(user: IUser) {
  if (user.accountId) {
    const account = await Account.findById(user.accountId);
    if (!account) throw new Error('Conta indisponível');
    return account;
  }
  const account = await Account.findOneAndUpdate({ _id: user._id }, { $setOnInsert: {
    email: user.email, passwordHash: user.passwordHash,
  } }, { upsert: true, new: true });
  await User.updateOne({ _id: user._id, accountId: { $exists: false } }, { $set: { accountId: account._id } });
  user.accountId = account._id;
  return account;
}

/** Explicit recovery for pre-account memberships. Both identities must be proven. */
export async function linkLegacyMembership(userId: string, workspaceId: unknown, password: unknown) {
  if (typeof workspaceId !== 'string' || !Types.ObjectId.isValid(workspaceId) || typeof password !== 'string' || password.length > 72) throw new Error('Dados de vinculação inválidos');
  const user = await User.findOne({ _id: userId, isActive: true });
  if (!user) throw new Error('Sessão inválida');
  const account = await ensureAccount(user);
  const target = await User.findOne({ workspaceId, email: account.email, isActive: true });
  if (!target || !(await Workspace.exists({ _id: workspaceId, status: { $ne: 'suspended' } }))) throw new Error('Cadastro ou credenciais inválidos');
  const targetAccount = target.accountId ? await Account.findById(target.accountId) : null;
  const hash = target.accountId ? targetAccount?.passwordHash : target.passwordHash;
  if (!hash || !(await bcrypt.compare(password, hash))) throw new Error('Cadastro ou credenciais inválidos');
  if (String(target.accountId) === String(account._id)) return String(target._id);
  const result = await User.updateOne({ _id: target._id, tokenVersion: target.tokenVersion, accountId: target.accountId ?? { $exists: false } }, {
    $set: { accountId: account._id, passwordHash: account.passwordHash }, $inc: { tokenVersion: 1 },
  });
  if (!result.modifiedCount) throw new Error('Cadastro alterado durante a vinculação; tente novamente');
  await AuthSession.updateMany({ userId: target._id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
  return String(target._id);
}
