import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../../session-manager/SessionManager';
import { createInstancesService } from './instances.service';

export async function instancesRoutes(fastify: FastifyInstance, opts: { sessionManager: SessionManager }): Promise<void> {
  const svc = createInstancesService(opts.sessionManager);
  const auth = { preHandler: [fastify.authenticate] };

  // GET /api/instances
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    return reply.send(await svc.list(workspaceId));
  });

  // POST /api/instances
  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { name, webhookUrl } = request.body as { name: string; webhookUrl?: string };
    if (!name) return reply.status(400).send({ error: 'Nome é obrigatório' });
    try {
      const instance = await svc.create(workspaceId, name, webhookUrl);
      return reply.status(201).send(instance);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // GET /api/instances/:id
  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const instance = await svc.get(workspaceId, id);
    if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' });
    return reply.send(instance);
  });

  // PATCH /api/instances/:id — rename / update webhook
  fastify.patch('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; webhookUrl?: string };
    try {
      return reply.send(await svc.update(workspaceId, id, body));
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });

  // POST /api/instances/:id/connect
  fastify.post('/:id/connect', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    try {
      return reply.send(await svc.connect(workspaceId, id));
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // POST /api/instances/:id/disconnect
  fastify.post('/:id/disconnect', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    return reply.send(await svc.disconnect(workspaceId, id));
  });

  // POST /api/instances/:id/logout
  fastify.post('/:id/logout', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    return reply.send(await svc.logout(workspaceId, id));
  });

  // POST /api/instances/:id/restart
  fastify.post('/:id/restart', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    return reply.send(await svc.restart(workspaceId, id));
  });

  // POST /api/instances/:id/pair  — request pairing code
  fastify.post('/:id/pair', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { phone } = request.body as { phone: string };
    if (!phone) return reply.status(400).send({ error: 'Telefone é obrigatório' });
    try {
      return reply.send(await svc.requestPairingCode(workspaceId, id, phone));
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // DELETE /api/instances/:id
  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    try {
      return reply.send(await svc.delete(workspaceId, id));
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });
}
