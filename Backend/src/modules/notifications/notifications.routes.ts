import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Notification } from '../../db/models';
import { toNotificationResponse } from './notification.service';

const valid = (id: string) => Types.ObjectId.isValid(id);

export async function notificationsRoutes(fastify: FastifyInstance): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };

  // GET /api/notifications  — paginated, newest first
  fastify.get('/', auth, async (request, reply) => {
    const { sub, workspaceId } = request.user as { sub: string; workspaceId: string };
    const { page = '1', limit = '20', unreadOnly } = request.query as { page?: string; limit?: string; unreadOnly?: string };
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(50, Math.max(1, Number(limit) || 20));

    const filter: Record<string, unknown> = { workspaceId, recipientId: sub };
    if (unreadOnly === 'true') filter.read = false;

    const [entries, total, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ workspaceId, recipientId: sub, read: false }),
    ]);

    return reply.send({
      data: entries.map(toNotificationResponse),
      meta: { page: p, limit: l, total, totalPages: Math.ceil(total / l), unreadCount },
    });
  });

  // GET /api/notifications/unread-count  — cheap poll target for the bell badge
  fastify.get('/unread-count', auth, async (request, reply) => {
    const { sub, workspaceId } = request.user as { sub: string; workspaceId: string };
    const unreadCount = await Notification.countDocuments({ workspaceId, recipientId: sub, read: false });
    return reply.send({ unreadCount });
  });

  // POST /api/notifications/:id/read
  fastify.post('/:id/read', auth, async (request, reply) => {
    const { sub, workspaceId } = request.user as { sub: string; workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Notificação não encontrada' });
    const doc = await Notification.findOneAndUpdate(
      { _id: id, workspaceId, recipientId: sub },
      { $set: { read: true, readAt: new Date() } },
      { new: true }
    );
    if (!doc) return reply.status(404).send({ error: 'Notificação não encontrada' });
    return reply.send(toNotificationResponse(doc));
  });

  // POST /api/notifications/read-all
  fastify.post('/read-all', auth, async (request, reply) => {
    const { sub, workspaceId } = request.user as { sub: string; workspaceId: string };
    await Notification.updateMany({ workspaceId, recipientId: sub, read: false }, { $set: { read: true, readAt: new Date() } });
    return reply.send({ ok: true });
  });

  // DELETE /api/notifications/:id  — dismiss
  fastify.delete('/:id', auth, async (request, reply) => {
    const { sub, workspaceId } = request.user as { sub: string; workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Notificação não encontrada' });
    const doc = await Notification.findOneAndDelete({ _id: id, workspaceId, recipientId: sub });
    if (!doc) return reply.status(404).send({ error: 'Notificação não encontrada' });
    return reply.status(204).send();
  });
}
