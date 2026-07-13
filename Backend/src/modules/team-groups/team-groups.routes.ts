import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { TeamGroup, User } from '../../db/models';
import type { IBusinessHours, ITeamGroupSla, RoutingStrategy } from '../../db/models';
import { requireRole } from '../../utils/require-role';

function wsOid(workspaceId: string) {
  return new Types.ObjectId(workspaceId);
}

async function buildGroup(g: {
  _id: unknown; workspaceId: unknown; name: string; emoji?: string; color?: string; description?: string;
  leadId?: unknown; memberIds?: unknown[]; createdAt: Date; updatedAt: Date;
  routingStrategy?: RoutingStrategy; roundRobinCursor?: number; businessHours?: IBusinessHours; sla?: ITeamGroupSla;
}) {
  const memberIds = (g.memberIds ?? []) as Types.ObjectId[];
  const members = await User.find({ _id: { $in: memberIds } })
    .select('name email avatarUrl role isActive')
    .lean();
  const lead = g.leadId
    ? await User.findById(g.leadId).select('name email avatarUrl role').lean()
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
    const data = await Promise.all(groups.map(buildGroup));
    return reply.send({ data });
  });

  // GET /api/team-groups/:id
  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: 'ID inválido' });
    const g = await TeamGroup.findOne({ _id: id, workspaceId: wsOid(workspaceId) }).lean();
    if (!g) return reply.status(404).send({ error: 'Equipe não encontrada' });
    return reply.send({ data: await buildGroup(g) });
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
      leadId: leadId && Types.ObjectId.isValid(leadId) ? new Types.ObjectId(leadId) : undefined,
      memberIds: (memberIds ?? []).filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)),
      routingStrategy: routingStrategy && ['round_robin', 'least_busy', 'manual'].includes(routingStrategy) ? routingStrategy : undefined,
      businessHours: businessHours ?? undefined,
      sla: sla ?? undefined,
    });

    return reply.status(201).send({ data: await buildGroup(g.toObject()) });
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
    if (leadId !== undefined) g.leadId = leadId && Types.ObjectId.isValid(leadId) ? new Types.ObjectId(leadId) : undefined;
    if (memberIds !== undefined) {
      g.memberIds = memberIds.filter((mid) => Types.ObjectId.isValid(mid)).map((mid) => new Types.ObjectId(mid));
    }
    if (routingStrategy !== undefined && ['round_robin', 'least_busy', 'manual'].includes(routingStrategy)) {
      g.routingStrategy = routingStrategy;
    }
    if (businessHours !== undefined) g.businessHours = businessHours ?? undefined;
    if (sla !== undefined) g.sla = sla ?? undefined;

    await g.save();
    return reply.send({ data: await buildGroup(g.toObject()) });
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
