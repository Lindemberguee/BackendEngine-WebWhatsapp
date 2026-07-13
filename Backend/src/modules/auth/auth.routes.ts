import type { FastifyInstance } from 'fastify';
import {
  registerWorkspace, loginUser, getUserById, updateProfile, changeOwnPassword,
  bumpTokenVersion, getMyStats, getMyActivity,
} from './auth.service';
import { saveAvatar, avatarUrlFor, AvatarError } from './avatar.service';
import { notify } from '../notifications/notification.service';
import type { WebSocketGateway } from '../../ws/gateway';
import { Avatar } from '../../db/models';

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
      const token = fastify.jwt.sign({
        sub: user._id!.toString(),
        workspaceId,
        role: user.role,
        tokenVersion: user.tokenVersion,
      });
      return reply.status(201).send({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, workspaceId } });
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
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
      const token = fastify.jwt.sign({ sub: user._id!.toString(), workspaceId, role: user.role, tokenVersion: user.tokenVersion });
      void notify(opts.wsGateway, {
        workspaceId, recipientId: user._id!.toString(), type: 'security.new_login',
        title: 'Novo login realizado', message: `Login em ${new Date().toLocaleString('pt-BR')}`,
        link: '/settings',
      });
      return reply.send({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, workspaceId, avatarUrl: user.avatarUrl } });
    } catch (err) {
      return reply.status(401).send({ error: (err as Error).message });
    }
  });

  // POST /api/auth/forgot-password
  // Always responds with the same generic message so we never reveal whether an
  // email is registered (enumeration protection). NOTE: actual email delivery is
  // not wired yet — it requires an email provider (SMTP/Resend/SES). Until then this
  // endpoint validates input and no-ops; the reset link is not sent.
  fastify.post('/forgot-password', bruteForceGuard, async (request, reply) => {
    const { email } = request.body as { email?: string };
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply.status(400).send({ error: 'E-mail inválido' });
    }
    fastify.log.warn({ email }, '[auth] forgot-password requested — email delivery not configured (no reset link sent)');
    // TODO: generate a short-lived reset token, persist it, and email the reset link.
    return reply.send({ message: 'Se este e-mail estiver cadastrado, você receberá as instruções.' });
  });

  // POST /api/auth/refresh  (requires valid JWT — re-issues with fresh expiry)
  fastify.post('/refresh', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { sub, workspaceId, role, tokenVersion } = request.user as { sub: string; workspaceId: string; role: string; tokenVersion?: number };
    const token = fastify.jwt.sign({ sub, workspaceId, role, tokenVersion: tokenVersion ?? 0 });
    return reply.send({ token });
  });

  // GET /api/auth/me  (requires auth)
  fastify.get('/me', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    const user = await getUserById(sub);
    if (!user) return reply.status(404).send({ error: 'Usuário não encontrado' });
    return reply.send(toMeResponse(user));
  });

  // PATCH /api/auth/me  (self-service profile edit — never role/email/password)
  fastify.patch('/me', { preHandler: [fastify.authenticate] }, async (request, reply) => {
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
        await saveAvatar(sub, workspaceId, body.avatarUrl);
        body.avatarUrl = avatarUrlFor(sub);
      } catch (err) {
        if (err instanceof AvatarError) return reply.status(400).send({ error: err.message });
        throw err;
      }
    }

    const user = await updateProfile(sub, body);
    if (!user) return reply.status(404).send({ error: 'Usuário não encontrado' });
    return reply.send(toMeResponse(user));
  });

  // GET /api/auth/avatar/:userId — public (no auth needed, same exposure as a WhatsApp
  // contact photo): serves the raw image bytes for <img src> everywhere avatarUrl is rendered.
  fastify.get('/avatar/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    // Not .lean() — Mongoose's schema casting turns the stored BSON Binary back into a real
    // Buffer here; a lean query would hand back the raw Binary wrapper instead (see the media
    // rendering fix in messages.routes.ts for the same pitfall with stored Buffers).
    const avatar = await Avatar.findOne({ userId });
    if (!avatar) return reply.status(404).send();
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.type(avatar.mimeType).send(avatar.data);
  });

  // POST /api/auth/me/password  (self-service password change)
  fastify.post('/me/password', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { sub, workspaceId, role } = request.user as { sub: string; workspaceId: string; role: string };
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
    const token = fastify.jwt.sign({ sub, workspaceId, role, tokenVersion: user?.tokenVersion ?? 0 });
    return reply.send({ token });
  });

  // POST /api/auth/me/logout-other-sessions  (invalidate every JWT except the caller's, which is re-issued)
  fastify.post('/me/logout-other-sessions', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { sub, workspaceId, role } = request.user as { sub: string; workspaceId: string; role: string };
    const newTokenVersion = await bumpTokenVersion(sub);
    const token = fastify.jwt.sign({ sub, workspaceId, role, tokenVersion: newTokenVersion });
    return reply.send({ token });
  });

  // GET /api/auth/me/stats  (personal performance snapshot)
  fastify.get('/me/stats', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { sub, workspaceId } = request.user as { sub: string; workspaceId: string };
    return reply.send(await getMyStats(workspaceId, sub));
  });

  // GET /api/auth/me/activity  (self-scoped audit log — any role, unlike GET /api/audit)
  fastify.get('/me/activity', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { sub, workspaceId } = request.user as { sub: string; workspaceId: string };
    const { page = '1', limit = '15' } = request.query as { page?: string; limit?: string };
    return reply.send(await getMyActivity(workspaceId, sub, Math.max(1, Number(page) || 1), Math.min(50, Number(limit) || 15)));
  });
}
