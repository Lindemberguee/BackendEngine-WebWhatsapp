import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { TeamGroup, User } from '../../db/models';
import type { IBusinessHours, ITeamGroupSla, RoutingStrategy } from '../../db/models';
import { requireRole } from '../../utils/require-role';

function wsOid(workspaceId: string) {
  return new Types.ObjectId(workspaceId);
}

/** Filters a list of candidate user ids down to the ones that are both valid
 *  ObjectIds AND actually belong to this workspace — the only thing that
 *  previously stood between this and a cross-tenant reference was
 *  Types.ObjectId.isValid(), which checks shape, not ownership. */
async function memberIdsInWorkspace(workspaceId: string, ids: unknown[]): Promise<Types.ObjectId[]> {
  const candidates = ids.filter((id): id is string => typeof id === 'string' && Types.ObjectId.isValid(id));
  if (!candidates.length) return [];
  const users = await User.find({ _id: { $in: candidates }, workspaceId: wsOid(workspaceId) }).select('_id').lean();
  return users.map((u) => u._id as Types.ObjectId);
}

async function leadIdInWorkspace(workspaceId: string, id: unknown): Promise<Types.ObjectId | undefined> {
  if (typeof id !== 'string' || !Types.ObjectId.isValid(id)) return undefined;
  const exists = await User.exists({ _id: id, workspaceId: wsOid(workspaceId) });
  return exists ? new Types.ObjectId(id) : undefined;
}

// workspaceId is passed in explicitly (not read off `g`) and used to scope
// BOTH member lookups below — previously these queried User by _id alone, so
// a memberIds/leadId entry pointing at another workspace's user (however it
// got there — a stale reference, a bug in the write path, a crafted request)
// would still resolve and leak that user's name/email/avatar/role across
// tenants. Scoping the read closes the leak even if a bad id somehow ends up
// stored; assertMembersInWorkspace below stops it from being stored at all.
async function buildGroup(g: {
  _id: unknown; workspaceId: unknown; name: string; emoji?: string; color?: string; description?: string;
  leadId?: unknown; memberIds?: unknown[]; createdAt: Date; updatedAt: Date;
  routingStrategy?: RoutingStrategy; roundRobinCursor?: number; businessHours?: IBusinessHours; sla?: ITeamGroupSla;
}, workspaceId: string, userMap?: Map<string, { _id: unknown; name: string; email: string; avatarUrl?: string; role: string; isActive: boolean }>) {
  const memberIds = (g.memberIds ?? []) as Types.ObjectId[];
  const members = userMap ? memberIds.map(id => userMap.get(String(id))).filter((user): user is NonNullable<typeof user> => !!user) : await User.find({ _id: { $in: memberIds }, workspaceId: wsOid(workspaceId) })
    .select('name email avatarUrl role isActive')
    .lean();
  const lead = g.leadId
    ? userMap ? userMap.get(String(g.leadId)) : await User.findOne({ _id: g.leadId, workspaceId: wsOid(workspaceId) }).select('name email avatarUrl role').lean()
    : null;

  return {
    id: String(g._id),
    name: g.name,
    emoji: g.emoji ?? null,
    color: g.color ?? null,
    description: g.description ?? null,
    leadId: g.leadId ? String(g.leadId) : null,
    lead: lead ? { id: String(lead._id), name: lead.name, email: lead.email, avatarUrl: lead.avatarUrl ?? null, role: lead.role } : null,
    memberIds: memberIds.map(String),
    members: members.map((m) => ({ id: String(m._id), name: m.name, email: m.email, avatarUrl: m.avatarUrl ?? null, role: m.role, isActive: m.isActive })),
    memberCount: memberIds.length,
    routingStrategy: g.routingStrategy ?? 'manual',
    businessHours: g.businessHours ?? null,
    sla: g.sla ?? null,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

export async function teamGroupsRoutes(fastify: FastifyInstance): Promise<void> {
  const auth      = { preHandler: [fastify.authenticate] };
  const adminOnly = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin'])] };

  // GET /api/team-groups
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const groups = await TeamGroup.find({ workspaceId: wsOid(workspaceId) }).sort({ name: 1 }).lean();
    const ids = groups.flatMap(group => [...(group.memberIds ?? []), ...(group.leadId ? [group.leadId] : [])]);
    const users = await User.find({ workspaceId: wsOid(workspaceId), _id: { $in: ids } }).select('name email avatarUrl role isActive').lean();
    const userMap = new Map(users.map(user => [String(user._id), user]));
    const data = await Promise.all(groups.map((g) => buildGroup(g, workspaceId, userMap)));
    return reply.send({ data });
  });

  // GET /api/team-groups/:id
  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: 'ID inválido' });
    const g = await TeamGroup.findOne({ _id: id, workspaceId: wsOid(workspaceId) }).lean();
    if (!g) return reply.status(404).send({ error: 'Equipe não encontrada' });
    return reply.send({ data: await buildGroup(g, workspaceId) });
  });

  // POST /api/team-groups
  fastify.post('/', adminOnly, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { name, emoji, color, description, leadId, memberIds, routingStrategy, businessHours, sla } = request.body as {
      name?: string; emoji?: string; color?: string; description?: string;
      leadId?: string; memberIds?: string[];
      routingStrategy?: RoutingStrategy; businessHours?: IBusinessHours; sla?: ITeamGroupSla;
    };

    if (!name?.trim()) return reply.status(400).send({ error: 'Nome é obrigatório' });

    const dup = await TeamGroup.exists({ workspaceId: wsOid(workspaceId), name: name.trim() });
    if (dup) return reply.status(409).send({ error: `Já existe uma equipe com o nome "${name.trim()}"` });

    const g = await TeamGroup.create({
      workspaceId: wsOid(workspaceId),
      name: name.trim(),
      emoji: emoji?.trim() || undefined,
      color: color || undefined,
      description: description?.trim() || undefined,
      leadId: await leadIdInWorkspace(workspaceId, leadId),
      memberIds: await memberIdsInWorkspace(workspaceId, memberIds ?? []),
      routingStrategy: routingStrategy && ['round_robin', 'least_busy', 'manual'].includes(routingStrategy) ? routingStrategy : undefined,
      businessHours: businessHours ?? undefined,
      sla: sla ?? undefined,
    });

    return reply.status(201).send({ data: await buildGroup(g.toObject(), workspaceId) });
  });

  // PATCH /api/team-groups/:id
  fastify.patch('/:id', adminOnly, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: 'ID inválido' });

    const g = await TeamGroup.findOne({ _id: id, workspaceId: wsOid(workspaceId) });
    if (!g) return reply.status(404).send({ error: 'Equipe não encontrada' });

    const { name, emoji, color, description, leadId, memberIds, routingStrategy, businessHours, sla } = request.body as {
      name?: string; emoji?: string | null; color?: string | null; description?: string | null;
      leadId?: string | null; memberIds?: string[];
      routingStrategy?: RoutingStrategy; businessHours?: IBusinessHours | null; sla?: ITeamGroupSla | null;
    };

    if (name !== undefined) {
      if (!name.trim()) return reply.status(400).send({ error: 'Nome não pode ser vazio' });
      const dup = await TeamGroup.exists({ workspaceId: wsOid(workspaceId), name: name.trim(), _id: { $ne: id } });
      if (dup) return reply.status(409).send({ error: `Já existe uma equipe chamada "${name.trim()}"` });
      g.name = name.trim();
    }
    if (emoji !== undefined) g.emoji = emoji ?? undefined;
    if (color !== undefined) g.color = color ?? undefined;
    if (description !== undefined) g.description = description?.trim() || undefined;
    if (leadId !== undefined) g.leadId = await leadIdInWorkspace(workspaceId, leadId);
    if (memberIds !== undefined) {
      g.memberIds = await memberIdsInWorkspace(workspaceId, memberIds);
    }
    if (routingStrategy !== undefined && ['round_robin', 'least_busy', 'manual'].includes(routingStrategy)) {
      g.routingStrategy = routingStrategy;
    }
    if (businessHours !== undefined) g.businessHours = businessHours ?? undefined;
    if (sla !== undefined) g.sla = sla ?? undefined;

    await g.save();
    return reply.send({ data: await buildGroup(g.toObject(), workspaceId) });
  });

  // DELETE /api/team-groups/:id
  fastify.delete('/:id', adminOnly, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: 'ID inválido' });
    const res = await TeamGroup.deleteOne({ _id: id, workspaceId: wsOid(workspaceId) });
    if (res.deletedCount === 0) return reply.status(404).send({ error: 'Equipe não encontrada' });
    return reply.status(204).send();
  });
}
