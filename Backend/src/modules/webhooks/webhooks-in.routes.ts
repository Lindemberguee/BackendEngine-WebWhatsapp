import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../../session-manager/SessionManager';
import { triggerWebhookFlow, WebhookTriggerError, isValidWebhookToken } from './webhook-flow-trigger';

/**
 * Public (no auth) inbound trigger for flows with a 'webhook' trigger — the token
 * in the URL itself is the credential (see Flow.model.ts trigger.webhookToken).
 */
export async function webhooksInRoutes(fastify: FastifyInstance, opts: { sessionManager: SessionManager }): Promise<void> {
  fastify.post('/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    // Cheap format check before hitting Mongo — the real credential check is the
    // DB lookup in triggerWebhookFlow, this just rejects obviously-malformed
    // tokens (e.g. a scanner brute-forcing short strings) without a round-trip.
    if (!isValidWebhookToken(token)) return reply.status(400).send({ error: 'Token inválido' });
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
