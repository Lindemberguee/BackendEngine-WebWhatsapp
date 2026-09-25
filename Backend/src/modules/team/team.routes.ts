import { requireHumanSession } from '../auth/authenticate';
import { createInvitation, acceptInvitation } from './invitations.service';
import type { FastifyInstance } from 'fastify';
import { User } from '../../db/models';
import { listTeam, updateAgent, removeAgent, resetAgentPassword, getTeamStats, updateAvailability } from './team.service';
import { notify } from '../notifications/notification.service';
import type { WebSocketGateway } from '../../ws/gateway';
import { requireRole } from '../../utils/require-role';

async function actorInfo(sub: string) {
  const u = await User.findById(sub).lean();
  return u ? { id: sub, name: u.name, email: u.email } : undefined;
}

export async function teamRoutes(fastify: FastifyInstance, opts: { wsGateway: WebSocketGateway }): Promise<void> {
  const auth      = { preHandler: [fastify.authenticate] };
  const adminOnly = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin'])] };

  // GET /api/team — any authenticated member
  fastify.post('/invitations/accept', { preHandler: [fastify.authenticate, requireHumanSession] }, async (request, reply) => {
    try {
      const user = await acceptInvitation(request.user.sub, (request.body as { token?: unknown })?.token);
      return reply.send({ data: { workspaceId: String(user.workspaceId), userId: String(user._id) } });
    } catch (error) { return reply.status(400).send({ error: (error as Error).message }); }
  });

  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    return reply.send({ data: await listTeam(workspaceId) });
  });

  // PATCH /api/team/availability — self-service, any authenticated member
  fastify.patch('/availability', auth, async (request, reply) => {
    const { workspaceId, sub } = request.user as { workspaceId: string; sub: string };
    const { availability } = request.body as { availability: string };
    try {
      const member = await updateAvailability(workspaceId, sub, availability);
      return reply.send({ data: member });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // GET /api/team/stats — aggregate stats (owner/admin)
  fastify.get('/stats', adminOnly, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    return reply.send({ data: await getTeamStats(workspaceId) });
  });

  // POST /api/team — invite / create member (owner/admin)
  fastify.post('/', { preHandler: [fastify.authenticate, requireHumanSession, requireRole(['owner', 'admin'])] }, async (request, reply) => {
    const { workspaceId, sub } = request.user as { workspaceId: string; sub: string };
    try {
      const invitation = await createInvitation(workspaceId, sub, request.body);
      return reply.status(201).send({ data: invitation });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // PATCH /api/team/:id — update name / role / isActive (owner/admin)
  fastify.patch('/:id', adminOnly, async (request, reply) => {
    const { workspaceId, sub } = request.user as { workspaceId: string; sub: string };
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    try {
      const actor = await actorInfo(sub);
      const member = await updateAgent(workspaceId, id, sub, body, actor);
      opts.wsGateway.disconnectUser(id);
      if ('role' in body && id !== sub) {
        void notify(opts.wsGateway, {
          workspaceId, recipientId: id, type: 'team.role_changed',
          title: 'Seu cargo foi alterado', message: `${actor?.name ?? 'Um administrador'} alterou seu cargo para ${member.role}`,
          link: '/settings',
        });
      }
      return reply.send({ data: member });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // DELETE /api/team/:id — remove member (owner/admin)
  fastify.delete('/:id', adminOnly, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    try {
      const actor = await actorInfo(sub);
      await removeAgent(workspaceId, id, sub, role, actor);
      opts.wsGateway.disconnectUser(id);
      return reply.status(204).send();
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // POST /api/team/:id/password — admin resets a member's password
  fastify.post('/:id/password', adminOnly, async (request, reply) => {
    const { workspaceId, sub } = request.user as { workspaceId: string; sub: string };
    const { id } = request.params as { id: string };
    const { password } = request.body as { password?: string };
    try {
      await resetAgentPassword(workspaceId, id, sub, password ?? '');
      const actor = await actorInfo(sub);
      void notify(opts.wsGateway, {
        workspaceId, recipientId: id, type: 'team.password_reset',
        title: 'Sua senha foi redefinida', message: `${actor?.name ?? 'Um administrador'} redefiniu sua senha`,
        link: '/settings',
      });
      return reply.send({ message: 'Senha redefinida com sucesso' });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });
}
