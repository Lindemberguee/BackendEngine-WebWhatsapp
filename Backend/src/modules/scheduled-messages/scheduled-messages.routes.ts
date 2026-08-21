import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ScheduledMessage, Conversation } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import type { WebSocketGateway } from '../../ws/gateway';
import { scopeConversationFilter } from '../../utils/conversation-visibility';
import { requireRole } from '../../utils/require-role';

const ScheduleMessageSchema = z.object({
  text: z.string().min(1).max(4096),
  scheduledAt: z.coerce.date(),
  quotedMessageId: z.string().optional(),
});

function toResponse(doc: any) {
  return {
    id: doc._id.toString(),
    conversationId: doc.conversationId.toString(),
    type: doc.type,
    content: doc.content,
    quotedMessageId: doc.quotedMessageId,
    scheduledAt: doc.scheduledAt.toISOString(),
    status: doc.status,
    failureReason: doc.failureReason,
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * "Enviar mais tarde" — schedule/list/cancel a queued text message.
 * Registered at prefix '/api' (not scoped like messagesRoutes) since it spans
 * both /conversations/:id/messages/... and top-level /scheduled-messages/:id.
 * Actual sending happens in scheduled-message-scheduler.ts's dispatcher tick.
 */
export async function scheduledMessagesRoutes(
  fastify: FastifyInstance,
  _opts: { sessionManager: SessionManager; wsGateway: WebSocketGateway }
): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };
  // Scheduling/cancelling a real WhatsApp send is a write action — same split as
  // conversations.routes.ts/messages.routes.ts (viewer stays read-only).
  const canWrite = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin', 'agent'])] };

  // POST /api/conversations/:conversationId/messages/schedule
  fastify.post<{ Params: { conversationId: string } }>('/conversations/:conversationId/messages/schedule', canWrite, async (request, reply) => {
    try {
      const { workspaceId, sub: agentId, role } = request.user as { workspaceId: string; sub: string; role: string };
      const { conversationId } = request.params;
      const input = ScheduleMessageSchema.parse(request.body);

      if (input.scheduledAt.getTime() <= Date.now()) {
        return reply.status(400).send({ error: 'A data agendada precisa ser no futuro' });
      }

      const conv = await Conversation.findOne(scopeConversationFilter({ _id: conversationId, workspaceId }, { role, sub: agentId }));
      if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

      const scheduled = await ScheduledMessage.create({
        workspaceId: new Types.ObjectId(workspaceId),
        conversationId: conv._id,
        jid: conv.jid,
        instanceId: conv.instanceId,
        agentId: Types.ObjectId.isValid(agentId) ? new Types.ObjectId(agentId) : undefined,
        type: 'text',
        content: { text: input.text },
        quotedMessageId: input.quotedMessageId,
        scheduledAt: input.scheduledAt,
        status: 'scheduled',
      });

      reply.status(201).send(toResponse(scheduled));
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: 'Invalid request' });
    }
  });

  // GET /api/conversations/:conversationId/messages/scheduled — pending ones for this conversation
  fastify.get<{ Params: { conversationId: string } }>('/conversations/:conversationId/messages/scheduled', auth, async (request, reply) => {
    try {
      const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
      const { conversationId } = request.params;

      const conv = await Conversation.exists(scopeConversationFilter({ _id: conversationId, workspaceId }, { role, sub }));
      if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

      const items = await ScheduledMessage.find({
        workspaceId,
        conversationId,
        status: 'scheduled',
      }).sort({ scheduledAt: 1 });

      reply.send({ data: items.map(toResponse) });
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: 'Invalid request' });
    }
  });

  // DELETE /api/scheduled-messages/:id — cancel a pending scheduled message
  fastify.delete<{ Params: { id: string } }>('/scheduled-messages/:id', canWrite, async (request, reply) => {
    try {
      const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
      const { id } = request.params;
      if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: 'Invalid id' });

      const pending = await ScheduledMessage.findOne({ _id: id, workspaceId, status: 'scheduled' }).select('conversationId');
      if (!pending) return reply.status(404).send({ error: 'Mensagem agendada não encontrada' });
      const visible = await Conversation.exists(scopeConversationFilter({ _id: pending.conversationId, workspaceId }, { role, sub }));
      if (!visible) return reply.status(404).send({ error: 'Mensagem agendada não encontrada' });

      const updated = await ScheduledMessage.findOneAndUpdate(
        { _id: id, workspaceId, status: 'scheduled' },
        { $set: { status: 'cancelled' } },
        { new: true }
      );
      if (!updated) return reply.status(404).send({ error: 'Mensagem agendada não encontrada' });

      reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: 'Invalid request' });
    }
  });
}
