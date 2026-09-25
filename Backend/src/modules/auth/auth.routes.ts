import { accountMembershipFilter } from './account.service';
import { requireHumanSession } from '../auth/authenticate';
import type { FastifyInstance } from 'fastify';
import {
  registerWorkspace, loginUser, getUserById, updateProfile, changeOwnPassword,
  bumpTokenVersion, getMyStats, getMyActivity,
} from './auth.service';
import { saveAvatar, avatarUrlFor, AvatarError } from './avatar.service';
import { notify } from '../notifications/notification.service';
import type { WebSocketGateway } from '../../ws/gateway';
import { Avatar, User } from '../../db/models';
import { safeEqual } from '../../shared/crypto';
import { clearSessionCookies, issueSession, issueWsTicket, refreshSession, revokeAllUserSessions, revokeSession } from './session.service';
import { ResetEmailNotConfiguredError } from './resend';
import { requestPasswordReset, resetPasswordWithToken } from './password-reset.service';

function toMeResponse(user: NonNullable<Awaited<ReturnType<typeof getUserById>>>) {
  return {
    id: user._id, name: user.name, email: user.email, role: user.role, workspaceId: user.workspaceId,
    avatarUrl: user.avatarUrl, phone: user.phone, timezone: user.timezone, language: user.language,
    status: user.status, lastLoginAt: user.lastLoginAt?.toISOString(), createdAt: user.createdAt.toISOString(),
  };
}

export async function authRoutes(fastify: FastifyInstance, opts: { wsGateway: WebSocketGateway }): Promise<void> {
  // Brute-force guard for the unauthenticated endpoints — much stricter than the global limit.
  const bruteForceGuard = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

  // POST /api/auth/register
  fastify.post('/register', bruteForceGuard, async (request, reply) => {
    const { workspaceName, ownerName, email, password, acceptedTerms } = request.body as {
      workspaceName: string; ownerName: string; email: string; password: string; acceptedTerms?: boolean;
    };

    if (!workspaceName || !ownerName || !email || !password) {
      return reply.status(400).send({ error: 'Todos os campos são obrigatórios' });
    }
    if (!acceptedTerms) {
      return reply.status(400).send({ error: 'É necessário aceitar os Termos de Uso e a Política de Privacidade' });
    }

    try {
      const { user, workspaceId } = await registerWorkspace({ workspaceName, ownerName, email, password, acceptedTerms });
      await issueSession(fastify, reply, user);
      return reply.status(201).send({ user: { id: user._id, name: user.name, email: user.email, role: user.role, workspaceId } });
    } catch (err) {
      return reply.status((err as { statusCode?: number }).statusCode ?? 409).send({ error: (err as Error).message });
    }
  });

  // POST /api/auth/login
  fastify.post('/login', bruteForceGuard, async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };

    if (!email || !password) {
      return reply.status(400).send({ error: 'E-mail e senha são obrigatórios' });
    }

    try {
      const user = await loginUser(email, password);
      const workspaceId = user.workspaceId.toString();
      await issueSession(fastify, reply, user);
      void notify(opts.wsGateway, {
        workspaceId, recipientId: user._id!.toString(), type: 'security.new_login',
        title: 'Novo login realizado', message: `Login em ${new Date().toLocaleString('pt-BR')}`,
        link: '/settings',
      });
      return reply.send({ user: { id: user._id, name: user.name, email: user.email, role: user.role, workspaceId, avatarUrl: user.avatarUrl } });
    } catch (err) {
      return reply.status(401).send({ error: (err as Error).message });
    }
  });

  // Keep one response for registered and unregistered accounts so this route cannot
  // be used to enumerate account emails.
  fastify.post('/forgot-password', bruteForceGuard, async (request, reply) => {
    const { email } = (request.body ?? {}) as { email?: unknown };
    if (typeof email !== 'string' || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      return reply.status(400).send({ error: 'E-mail inv\u00e1lido' });
    }
    try {
      await requestPasswordReset(email);
    } catch (error) {
      if (error instanceof ResetEmailNotConfiguredError) {
        fastify.log.warn('[auth] password reset email configuration is incomplete');
        return reply.status(503).send({ error: 'Recupera\u00e7\u00e3o de senha indispon\u00edvel. Entre em contato com o suporte.' });
      }
      // Keep the response independent of account existence and provider status.
      fastify.log.error({ err: error }, '[auth] password reset email request failed');
    }
    return reply.status(202).send({ message: 'Se o e-mail estiver cadastrado e o servi\u00e7o de envio estiver dispon\u00edvel, voc\u00ea receber\u00e1 um link para redefinir a senha.' });
  });

  fastify.post('/reset-password', async (request, reply) => {
    const { token, newPassword } = (request.body ?? {}) as { token?: unknown; newPassword?: unknown };
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return reply.status(400).send({ error: 'Link inv\u00e1lido ou expirado' });
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72) {
      return reply.status(400).send({ error: 'A senha deve ter entre 8 e 72 caracteres' });
    }
    try {
      const userIds = await resetPasswordWithToken(token, newPassword);
      for (const userId of userIds) opts.wsGateway.disconnectUser(userId);
      return reply.send({ ok: true });
    } catch {
      return reply.status(400).send({ error: 'Link inv\u00e1lido ou expirado' });
    }
  });
  // POST /api/auth/refresh  (requires valid JWT — re-issues with fresh expiry)
  fastify.post('/refresh', async (request, reply) => {
    const refreshed = await refreshSession(fastify, reply, request.cookies.ww_refresh);
    if (!refreshed) {
      clearSessionCookies(reply);
      return reply.status(401).send({ error: 'Sessão expirada — faça login novamente' });
    }
    return reply.send({ ok: true });
  });

  // POST /api/auth/ws-ticket  (requires auth) — mints a 30s single-purpose token
  // for the WS handshake, fetched over this already-cookie-authenticated call
  // and passed as ?ticket= instead. See issueWsTicket() for why this exists.
  fastify.post('/ws-ticket', { preHandler: [fastify.authenticate, requireHumanSession] }, async (request, reply) => {
    const { sub, workspaceId, role, tokenVersion } = request.user as { sub: string; workspaceId: string; role: string; tokenVersion?: number };
    return reply.send({ ticket: issueWsTicket(fastify, { sub, workspaceId, role, tokenVersion, exp: request.user.exp }) });
  });

  // GET /api/auth/me  (requires auth)
  fastify.get('/me', { preHandler: [fastify.authenticate, requireHumanSession] }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    const user = await getUserById(sub);
    if (!user) return reply.status(404).send({ error: 'Usuário não encontrado' });
    return reply.send(toMeResponse(user));
  });

  // PATCH /api/auth/me  (self-service profile edit — never role/email/password)
  fastify.patch('/me', { preHandler: [fastify.authenticate, requireHumanSession] }, async (request, reply) => {
    const { sub, workspaceId } = request.user as { sub: string; workspaceId: string };
    const body = request.body as {
      name?: string; avatarUrl?: string; phone?: string; timezone?: string; language?: string;
      status?: { emoji?: string; text?: string };
    };
    if (body.name !== undefined && !body.name.trim()) return reply.status(400).send({ error: 'Nome não pode ficar vazio' });

    // A `data:` URL is a freshly-uploaded image — store the bytes in their own collection
    // (never inline on the User doc) and swap it for a short, cacheable proxy URL before saving.
    if (body.avatarUrl?.startsWith('data:')) {
      try {
        const accessToken = await saveAvatar(sub, workspaceId, body.avatarUrl);
        body.avatarUrl = avatarUrlFor(sub, accessToken);
      } catch (err) {
        if (err instanceof AvatarError) return reply.status(400).send({ error: err.message });
        throw err;
      }
    }

    const user = await updateProfile(sub, body);
    if (!user) return reply.status(404).send({ error: 'Usuário não encontrado' });
    return reply.send(toMeResponse(user));
  });

  // GET /api/auth/avatar/:userId/:token — public (no auth needed, same exposure as a
  // WhatsApp contact photo): serves the raw image bytes for <img src> everywhere
  // avatarUrl is rendered. `token` is the real capability token (see Avatar.model.ts);
  // also serves it when the stored avatar predates the token field (accessToken unset).
  fastify.get('/avatar/:userId/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { userId, token } = request.params as { userId: string; token: string };
    // Not .lean() — Mongoose's schema casting turns the stored BSON Binary back into a real
    // Buffer here; a lean query would hand back the raw Binary wrapper instead (see the media
    // rendering fix in messages.routes.ts for the same pitfall with stored Buffers).
    const avatar = await Avatar.findOne({ userId });
    if (!avatar) return reply.status(404).send();
    if (avatar.accessToken && !safeEqual(token, avatar.accessToken)) return reply.status(404).send();
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.type(avatar.mimeType).send(avatar.data);
  });

  // GET /api/auth/avatar/:userId — legacy, no token: only serves avatars saved before
  // accessToken existed. Any avatar WITH a token must go through the route above —
  // otherwise this bare route would make the token pointless for fresh uploads.
  // Same tight rate limit as the tokened route, for the same reason.
  fastify.get('/avatar/:userId', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const avatar = await Avatar.findOne({ userId });
    if (!avatar) return reply.status(404).send();
    if (avatar.accessToken) return reply.status(404).send();
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.type(avatar.mimeType).send(avatar.data);
  });

  // POST /api/auth/me/password  (self-service password change)
  fastify.post('/me/password', { preHandler: [fastify.authenticate, requireHumanSession] }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    const { currentPassword, newPassword } = request.body as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword) return reply.status(400).send({ error: 'Informe a senha atual e a nova senha' });
    try {
      await changeOwnPassword(sub, currentPassword, newPassword);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
    // changeOwnPassword already bumped tokenVersion (invalidating every other session's token) —
    // re-issue a fresh token for THIS session so the caller isn't logged out too.
    const user = await getUserById(sub);
    if (!user) return reply.status(401).send({ error: 'Sessão expirada — faça login novamente' });
    const caller = await getUserById(sub);
    if (caller) for (const id of await User.find(accountMembershipFilter(caller)).distinct('_id')) opts.wsGateway.disconnectUser(String(id));
    await revokeAllUserSessions(sub);
    await issueSession(fastify, reply, user, request.cookies.ww_refresh);
    return reply.send({ ok: true });
  });

  // POST /api/auth/me/logout-other-sessions  (invalidate every JWT except the caller's, which is re-issued)
  fastify.post('/me/logout-other-sessions', { preHandler: [fastify.authenticate, requireHumanSession] }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    await bumpTokenVersion(sub);
    const caller = await getUserById(sub);
    if (caller) for (const id of await User.find(accountMembershipFilter(caller)).distinct('_id')) opts.wsGateway.disconnectUser(String(id));
    const user = await getUserById(sub);
    if (!user) return reply.status(401).send({ error: 'Sessão expirada — faça login novamente' });
    await revokeAllUserSessions(sub);
    await issueSession(fastify, reply, user, request.cookies.ww_refresh);
    return reply.send({ ok: true });
  });

  fastify.post('/logout', async (request, reply) => {
    await revokeSession(request.cookies.ww_refresh);
    clearSessionCookies(reply);
    return reply.status(204).send();
  });

  // GET /api/auth/me/stats  (personal performance snapshot)
  fastify.get('/me/stats', { preHandler: [fastify.authenticate, requireHumanSession] }, async (request, reply) => {
    const { sub, workspaceId } = request.user as { sub: string; workspaceId: string };
    return reply.send(await getMyStats(workspaceId, sub));
  });

  // GET /api/auth/me/activity  (self-scoped audit log — any role, unlike GET /api/audit)
  fastify.get('/me/activity', { preHandler: [fastify.authenticate, requireHumanSession] }, async (request, reply) => {
    const { sub, workspaceId } = request.user as { sub: string; workspaceId: string };
    const { page = '1', limit = '15' } = request.query as { page?: string; limit?: string };
    return reply.send(await getMyActivity(workspaceId, sub, Math.max(1, Number(page) || 1), Math.min(50, Number(limit) || 15)));
  });
}
