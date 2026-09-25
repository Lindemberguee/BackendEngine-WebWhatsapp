import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Account } from '../../db/models/Account.model';
import { AuthSession, User } from '../../db/models';
import { PasswordResetToken } from '../../db/models/PasswordResetToken.model';
import { isResetEmailConfigured, ResetEmailNotConfiguredError, sendPasswordResetEmail } from './resend';

const RESET_TTL_MS = 30 * 60 * 1000;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function requestPasswordReset(emailInput: string): Promise<void> {
  // Configuration is checked before account lookup, so a missing setup has the
  // same response for registered and unregistered addresses.
  if (!isResetEmailConfigured()) throw new ResetEmailNotConfiguredError();

  const email = emailInput.trim().toLowerCase();
  const accounts = await Account.find({ email }).select('_id').limit(2).lean();
  // Old, unlinked legacy records can have duplicate account emails. Never guess
  // which identity to reset based on email alone.
  if (accounts.length !== 1) return;

  const accountId = accounts[0]._id;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  try {
    await PasswordResetToken.findOneAndUpdate(
      { accountId },
      { $set: { tokenHash, expiresAt: new Date(Date.now() + RESET_TTL_MS) } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    // Two first-time requests can race to create the unique account slot. Retry
    // as an update if the competing upsert won.
    if ((error as { code?: number }).code !== 11000) throw error;
    await PasswordResetToken.findOneAndUpdate(
      { accountId },
      { $set: { tokenHash, expiresAt: new Date(Date.now() + RESET_TTL_MS) } },
      { new: true },
    );
  }

  try {
    await sendPasswordResetEmail(email, token);
  } catch (error) {
    // Do not leave a valid but undelivered link behind. Match both fields so a
    // concurrent newer request cannot be removed by this failure handler.
    await PasswordResetToken.deleteOne({ accountId, tokenHash });
    throw error;
  }
}

export async function resetPasswordWithToken(token: string, newPassword: string): Promise<string[]> {
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72) throw new Error('A senha deve ter entre 8 e 72 caracteres');
  const reset = await PasswordResetToken.findOneAndDelete({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }).lean();
  if (!reset) throw new Error('Link inválido ou expirado');

  const account = await Account.findById(reset.accountId).select('_id');
  if (!account) throw new Error('Link inválido ou expirado');
  const members = await User.find({ $or: [{ accountId: account._id }, { _id: account._id, accountId: { $exists: false } }] }).select('_id accountId');
  if (!members.length) throw new Error('Link inválido ou expirado');

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await Account.updateOne({ _id: account._id }, { $set: { passwordHash } });
  const userIds = members.map(member => member._id);
  await User.updateMany({ _id: { $in: userIds } }, { $set: { passwordHash }, $inc: { tokenVersion: 1 } });
  await AuthSession.updateMany({ userId: { $in: userIds }, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
  return userIds.map(id => String(id));
}
