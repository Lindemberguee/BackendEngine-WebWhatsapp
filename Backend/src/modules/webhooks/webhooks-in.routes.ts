import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../../session-manager/SessionManager';
import { triggerWebhookFlow, WebhookTriggerError } from './webhook-flow-trigger';

/**
 * Public (no auth) inbound trigger for flows with a 'webhook' trigger — the token
 * in the URL itself is the credential (see Flow.model.ts trigger.webhookToken).
 */
export async function webhooksInRoutes(fastify: FastifyInstance, opts: { sessionManager: SessionManager }): Promise<void> {
  fastify.post('/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const result = await triggerWebhookFlow(opts.sessionManager, token, body as { phone?: string; name?: string });
      return reply.send({ ok: true, conversationId: result.conversationId });
    } catch (err) {
      if (err instanceof WebhookTriggerError) return reply.status(err.status).send({ error: err.message });
      fastify.log.error({ err }, '[webhooks] inbound trigger failed');
      return reply.status(500).send({ error: 'Erro interno ao processar o webhook' });
    }
  });
}
