import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { WebhookSubscription, WebhookDelivery, WebhookInboundLog, WEBHOOK_EVENTS } from '../../db/models';
import type { WebhookEvent } from '../../db/models';
import { requireRole } from '../../utils/require-role';

function validEvents(events: unknown): WebhookEvent[] {
  return Array.isArray(events) ? events.filter((e): e is WebhookEvent => WEBHOOK_EVENTS.includes(e)) : [];
}

export async function webhooksRoutes(fastify: FastifyInstance): Promise<void> {
  // Owner/admin only — a workspace webhook can exfiltrate every subscribed event to an
  // attacker-controlled URL, and its secret verifies incoming signatures, so this is as
  // sensitive as API key management (see api-keys.routes.ts's identical gating).
  const auth = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin'])] };
  const valid = (id: string) => Types.ObjectId.isValid(id);

  // GET /api/webhooks — list this workspace's subscriptions (secret included — the
  // owner needs it to verify X-Webhook-Signature on their end; it's not a login credential).
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const subs = await WebhookSubscription.find({ workspaceId }).sort({ createdAt: -1 });
    return reply.send({ data: subs.map((s) => s.toJSON()) });
  });

  // POST /api/webhooks
  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { url, events } = request.body as { url?: string; events?: string[] };
    if (!url?.trim()) return reply.status(400).send({ error: 'URL é obrigatória' });
    const validatedEvents = validEvents(events);
    if (!validatedEvents.length) return reply.status(400).send({ error: 'Selecione ao menos um evento' });

    const sub = await WebhookSubscription.create({
      workspaceId, url: url.trim(), events: validatedEvents, enabled: true,
      secret: randomBytes(32).toString('hex'),
    });
    return reply.status(201).send(sub.toJSON());
  });

  // PATCH /api/webhooks/:id
  fastify.patch('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Webhook não encontrado' });
    const { url, events, enabled } = request.body as { url?: string; events?: string[]; enabled?: boolean };

    const update: Record<string, unknown> = {};
    if (url !== undefined) update.url = url.trim();
    if (events !== undefined) update.events = validEvents(events);
    if (enabled !== undefined) update.enabled = enabled;

    const sub = await WebhookSubscription.findOneAndUpdate({ _id: id, workspaceId }, { $set: update }, { new: true });
    if (!sub) return reply.status(404).send({ error: 'Webhook não encontrado' });
    return reply.send(sub.toJSON());
  });

  // POST /api/webhooks/:id/regenerate-secret
  fastify.post('/:id/regenerate-secret', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Webhook não encontrado' });
    const sub = await WebhookSubscription.findOneAndUpdate(
      { _id: id, workspaceId },
      { $set: { secret: randomBytes(32).toString('hex') } },
      { new: true }
    );
    if (!sub) return reply.status(404).send({ error: 'Webhook não encontrado' });
    return reply.send(sub.toJSON());
  });

  // DELETE /api/webhooks/:id
  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Webhook não encontrado' });
    const res = await WebhookSubscription.deleteOne({ _id: id, workspaceId });
    if (res.deletedCount === 0) return reply.status(404).send({ error: 'Webhook não encontrado' });
    return reply.status(204).send();
  });

  // GET /api/webhooks/:id/deliveries — paginated delivery log
  fastify.get('/:id/deliveries', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { page = '1', limit = '20' } = request.query as Record<string, string>;
    if (!valid(id)) return reply.status(404).send({ error: 'Webhook não encontrado' });

    const sub = await WebhookSubscription.findOne({ _id: id, workspaceId }).select('_id').lean();
    if (!sub) return reply.status(404).send({ error: 'Webhook não encontrado' });

    const skip = (Number(page) - 1) * Number(limit);
    const [deliveries, total] = await Promise.all([
      WebhookDelivery.find({ subscriptionId: id }).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      WebhookDelivery.countDocuments({ subscriptionId: id }),
    ]);
    return reply.send({
      data: deliveries.map((d) => d.toJSON()),
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  });

  // GET /api/webhooks/inbound-logs — log of every flow webhook-trigger hit (POST /api/webhooks/in/:token)
  fastify.get('/inbound-logs', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { flowId, page = '1', limit = '20' } = request.query as Record<string, string>;

    const filter: Record<string, unknown> = { workspaceId };
    if (flowId && Types.ObjectId.isValid(flowId)) filter.flowId = flowId;

    const skip = (Number(page) - 1) * Number(limit);
    const [logs, total] = await Promise.all([
      WebhookInboundLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      WebhookInboundLog.countDocuments(filter),
    ]);
    return reply.send({
      data: logs.map((l) => l.toJSON()),
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
    });
  });

  // POST /api/webhooks/deliveries/:deliveryId/redeliver — manual resend of a failed delivery
  fastify.post('/deliveries/:deliveryId/redeliver', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { deliveryId } = request.params as { deliveryId: string };
    if (!valid(deliveryId)) return reply.status(404).send({ error: 'Entrega não encontrada' });

    const delivery = await WebhookDelivery.findOne({ _id: deliveryId, workspaceId });
    if (!delivery) return reply.status(404).send({ error: 'Entrega não encontrada' });

    delivery.status = 'pending';
    delivery.attempts = 0;
    delivery.nextAttemptAt = new Date();
    delivery.error = undefined;
    delivery.responseStatus = undefined;
    await delivery.save();
    return reply.send(delivery.toJSON());
  });
}
