import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'crypto';
import { User, ApiKey, Workspace } from '../../db/models';
const ROLE_RANK = { viewer: 1, agent: 2, admin: 3, owner: 4 } as const;

export async function requireHumanSession(request: FastifyRequest, reply: FastifyReply) {
  if (request.authKind !== 'session') return reply.status(403).send({ error: 'Esta operação exige uma sessão pessoal' });
}

export function registerAuthentication(fastify: FastifyInstance) {
  fastify.decorateRequest('authKind', null);
  fastify.decorate('authenticate', async (request: Parameters<typeof fastify.authenticate>[0], reply: Parameters<typeof fastify.authenticate>[1]) => {
    const authHeader = request.headers.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (bearer.startsWith('wsk_')) {
      const keyHash = createHash('sha256').update(bearer).digest('hex');
      const key = await ApiKey.findOne({ keyHash, revokedAt: { $exists: false } });
      if (!key) return reply.status(401).send({ error: 'Chave de API inválida ou revogada' });
      const keyWorkspace = await Workspace.findById(key.workspaceId).select('status').lean();
      if (!keyWorkspace || keyWorkspace.status === 'suspended') return reply.status(403).send({ error: 'Workspace suspenso' });
      const creator = await User.findOne({ _id: key.createdBy, workspaceId: key.workspaceId, isActive: true }).select('role').lean();
      if (!creator) return reply.status(401).send({ error: 'Invalid API key' });
      const role = ROLE_RANK[key.role] <= ROLE_RANK[creator.role] ? key.role : creator.role;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request.authKind = 'api-key';
      (request as any).user = { sub: key.createdBy.toString(), workspaceId: key.workspaceId.toString(), role };
      void ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
      return;
    }

    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: 'Token inválido ou expirado' });
    }
    if (request.user.purpose && request.user.purpose !== 'access') return reply.status(401).send({ error: 'Token não autorizado para HTTP' });
    request.authKind = 'session';
    // tokenVersion check — lets "change password" / "log out other sessions" invalidate
    // every previously-issued JWT immediately, since JWTs are otherwise stateless.
    // Tokens signed before this field existed have tokenVersion undefined and are treated as 0.
    const { sub, tokenVersion, workspaceId } = request.user as { sub: string; tokenVersion?: number; workspaceId?: string };
    const current = await User.findById(sub).select('tokenVersion isActive workspaceId role').lean();
    if (!current || (current.tokenVersion ?? 0) !== (tokenVersion ?? 0) || current.workspaceId.toString() !== workspaceId) {
      return reply.status(401).send({ error: 'Sessão expirada — faça login novamente' });
    }
    // A deactivated agent's existing token stays structurally valid (same
    // tokenVersion) until something else bumps it — deny explicitly here too,
    // since this query already runs on every authenticated request either way.
    if (current.isActive === false) {
      return reply.status(401).send({ error: 'Conta desativada' });
    }
    request.user.role = current.role;
    const workspace = await Workspace.findById(current.workspaceId).select('status').lean();
    if (!workspace || workspace.status === 'suspended') {
      return reply.status(403).send({ error: 'Workspace suspenso — fale com o suporte' });
    }
  });
}

declare module 'fastify' {
  interface FastifyRequest { authKind: 'api-key' | 'session' | null }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; workspaceId: string; role: string; tokenVersion?: number; purpose?: 'access' | 'ws'; exp?: number; sessionExpiresAt?: number };
    user: { sub: string; workspaceId: string; role: string; tokenVersion?: number; purpose?: 'access' | 'ws'; exp?: number; sessionExpiresAt?: number };
  }
}
