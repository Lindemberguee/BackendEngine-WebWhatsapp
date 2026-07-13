import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { AuditLog } from '../../db/models';

export async function auditRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/audit  — paginated audit log for the current workspace
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };

    // Only admins and owners can read audit logs
    if (!['owner', 'admin'].includes(role)) {
      return reply.status(403).send({ error: 'Sem permissão para acessar o audit log' });
    }

    if (!Types.ObjectId.isValid(workspaceId)) {
      return reply.status(400).send({ error: 'workspaceId inválido' });
    }

    const query = request.query as {
      type?: string;
      actorId?: string;
      from?: string;
      to?: string;
      page?: string;
      limit?: string;
    };

    const page  = Math.max(1, parseInt(query.page ?? '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(query.limit ?? '10', 10)));
    const skip  = (page - 1) * limit;

    // Build filter
    const filter: Record<string, unknown> = { workspaceId: new Types.ObjectId(workspaceId) };
    if (query.type)    filter.type = query.type;
    if (query.actorId && Types.ObjectId.isValid(query.actorId)) filter['actor.id'] = new Types.ObjectId(query.actorId);
    if (query.from || query.to) {
      const dateFilter: Record<string, Date> = {};
      if (query.from) dateFilter.$gte = new Date(query.from);
      if (query.to)   dateFilter.$lte = new Date(query.to);
      filter.createdAt = dateFilter;
    }

    const [entries, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);

    return reply.send({
      data: entries.map((e) => ({
        id: String(e._id),
        type: e.type,
        actor: {
          id:    String(e.actor.id),
          name:  e.actor.name,
          email: e.actor.email,
        },
        target: e.target?.type ? e.target : undefined,
        metadata: e.metadata,
        ip: e.ip,
        createdAt: e.createdAt.toISOString(),
      })),
      meta: { page, limit, total, totalPages, hasNextPage: page < totalPages },
    });
  });
}
