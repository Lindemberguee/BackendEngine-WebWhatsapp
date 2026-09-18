import { createHash, randomBytes } from 'crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthSession, User, Workspace } from '../../db/models';
import type { IUser } from '../../db/models';

export const ACCESS_COOKIE = 'ww_access';
export const REFRESH_COOKIE = 'ww_refresh';
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
    ...(process.env.AUTH_COOKIE_DOMAIN ? { domain: process.env.AUTH_COOKIE_DOMAIN } : {}),
  };
}

function setSessionCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void {
  reply.setCookie(ACCESS_COOKIE, accessToken, cookieOptions(ACCESS_TTL_SECONDS));
  reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOptions(REFRESH_TTL_SECONDS));
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, cookieOptions(0));
  reply.clearCookie(REFRESH_COOKIE, cookieOptions(0));
}

export async function issueSession(
  fastify: FastifyInstance,
  reply: FastifyReply,
  user: Pick<IUser, '_id' | 'workspaceId' | 'role' | 'tokenVersion'>,
  previousRefreshToken?: string,
): Promise<void> {
  if (previousRefreshToken) {
    await AuthSession.updateOne(
      { refreshTokenHash: hashRefreshToken(previousRefreshToken), revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
  }

  const refreshToken = randomBytes(48).toString('base64url');
  await AuthSession.create({
    userId: user._id,
    workspaceId: user.workspaceId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1_000),
  });

  const accessToken = fastify.jwt.sign(
    { sub: user._id!.toString(), workspaceId: user.workspaceId.toString(), role: user.role, tokenVersion: user.tokenVersion ?? 0 },
    { expiresIn: ACCESS_TTL_SECONDS },
  );
  setSessionCookies(reply, accessToken, refreshToken);
}

export async function refreshSession(fastify: FastifyInstance, reply: FastifyReply, refreshToken?: string): Promise<boolean> {
  if (!refreshToken) return false;
  const session = await AuthSession.findOne({
    refreshTokenHash: hashRefreshToken(refreshToken),
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  });
  if (!session) return false;

  const user = await User.findById(session.userId);
  const workspace = user ? await Workspace.findById(user.workspaceId).select('status').lean() : null;
  if (!user || !user.isActive || !workspace || workspace.status === 'suspended') {
    await AuthSession.updateOne({ _id: session._id }, { $set: { revokedAt: new Date() } });
    return false;
  }

  await issueSession(fastify, reply, user, refreshToken);
  return true;
}

export async function revokeSession(refreshToken?: string): Promise<void> {
  if (!refreshToken) return;
  await AuthSession.updateOne(
    { refreshTokenHash: hashRefreshToken(refreshToken), revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  const user = await User.findById(userId).select('email').lean();
  if (!user) return;
  const userIds = await User.find({ email: user.email }).distinct('_id');
  await AuthSession.updateMany({ userId: { $in: userIds }, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
}
