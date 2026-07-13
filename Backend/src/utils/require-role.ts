import type { FastifyRequest, FastifyReply } from 'fastify';

/** Shared RBAC preHandler — rejects the request with 403 unless request.user.role is in `roles`. */
export function requireRole(roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { role } = request.user as { role: string };
    if (!roles.includes(role)) {
      reply.status(403).send({ error: 'Você não tem permissão para esta ação' });
    }
  };
}
