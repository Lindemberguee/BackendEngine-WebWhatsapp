import { createHash, randomBytes } from 'crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthSession, User, Workspace } from '../../db/models';
import type { IUser } from '../../db/models';

export const ACCESS_COOKIE = 'ww_access';
export const REFRESH_COOKIE = 'ww_refresh';
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const WS_TICKET_TTL_SECONDS = 30;

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieOptions(maxAge: number) {
  // The frontend and this API are on different registrable domains today
  // (e.g. a Vercel preview/production domain talking to api.<ourdomain>), which
  // makes every request — including the WS gateway's handshake — cross-site.
  // SameSite=Lax cookies are never attached to a cross-site subresource request
  // (fetch or WebSocket), only to a top-level navigation, so the WS handshake
  // reached the server with no cookie at all and got closed as unauthorized
  // every time. SameSite=None is the standard fix for a split-domain SPA+API —
  // it requires Secure (HTTPS, already the case in production) and is safe
  // here because CORS is locked to an explicit origin allowlist with
  // credentials (see server.ts), not a wildcard: an arbitrary third-party site
  // can't complete the CORS preflight to ride this cookie, which is the actual
  // CSRF gate. Left as Lax outside production, where Secure (and therefore
  // None) isn't available and everything runs same-origin on localhost anyway.
  const secure = process.env.NODE_ENV === 'production';
  const sameSite: 'none' | 'lax' = secure ? 'none' : 'lax';
  return {
    httpOnly: true,
    secure,
    sameSite,
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

/**
 * Short-lived (30s), single-purpose credential for the WS handshake — a
 * fallback for when the ACCESS_COOKIE never reaches the gateway at all.
 *
 * The gateway can't rely solely on the cookie: SameSite=None/Secure covers
 * the common split-domain case (see cookieOptions above), but a browser or
 * network path that still drops it (strict third-party-cookie blocking, a
 * stale cookie from before this attribute existed, a corporate proxy) leaves
 * the handshake with nothing to authenticate against and no way to recover
 * short of a full re-login. This ticket is fetched over an already-cookie-
 * authenticated REST call (proven to work, since every other API call does)
 * and passed as `?ticket=` on the WS URL instead — query strings aren't
 * subject to any cookie policy at all. It intentionally is NOT the real
 * session JWT: 30s of validity bounds the blast radius of it ever leaking
 * into a proxy/access log, unlike a 15-minute access token.
 */
export function issueWsTicket(
  fastify: FastifyInstance,
  claims: { sub: string; workspaceId: string; role: string; tokenVersion?: number },
): string {
  return fastify.jwt.sign(
    { sub: claims.sub, workspaceId: claims.workspaceId, role: claims.role, tokenVersion: claims.tokenVersion ?? 0 },
    { expiresIn: WS_TICKET_TTL_SECONDS },
  );
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
