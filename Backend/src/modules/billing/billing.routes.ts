import type { FastifyInstance } from 'fastify';
import type { WebSocketGateway } from '../../ws/gateway';
import { Invoice } from '../../db/models';
import {
  listPlansResponse, getSubscriptionResponse, getUsage, changePlan, cancelSubscription, resumeSubscription,
  notifyPlanChanged,
} from './billing.service';
import { getPlan } from './plans.config';
import { getPaymentGateway } from './payment-gateway';

export async function billingRoutes(fastify: FastifyInstance, opts: { wsGateway: WebSocketGateway }): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };

  // GET /api/billing/plans — public catalog, no gateway dependency
  fastify.get('/plans', auth, async (_request, reply) => {
    return reply.send({ data: listPlansResponse() });
  });

  // GET /api/billing/subscription
  fastify.get('/subscription', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    return reply.send({ data: await getSubscriptionResponse(workspaceId) });
  });

  // GET /api/billing/usage
  fastify.get('/usage', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    return reply.send({ data: await getUsage(workspaceId) });
  });

  // GET /api/billing/payment-method — no gateway configured yet, so no card on file
  fastify.get('/payment-method', auth, async (_request, reply) => {
    return reply.send({ data: null });
  });

  // Lets the UI expose the correct mode without knowing provider credentials.
  fastify.get('/gateway', auth, async (_request, reply) => {
    const gateway = getPaymentGateway();
    return reply.send({ data: { provider: gateway.name, configured: gateway.isConfigured() } });
  });

  // Future providers return a hosted customer portal URL. Manual mode stays a safe no-op.
  fastify.post('/portal', auth, async (request, reply) => {
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };
    if (role !== 'owner') return reply.status(403).send({ error: 'Apenas o proprietário pode gerenciar pagamentos' });
    const sub = await getSubscriptionResponse(workspaceId);
    const { portalUrl } = await getPaymentGateway().createPortalSession({ workspaceId });
    return reply.send({ data: { portalUrl, available: Boolean(portalUrl), subscriptionId: sub.id } });
  });

  // GET /api/billing/invoices
  fastify.get('/invoices', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const invoices = await Invoice.find({ workspaceId }).sort({ createdAt: -1 });
    return reply.send({
      data: invoices.map((inv) => ({
        id: inv._id.toString(), number: inv.number, status: inv.status, amount: inv.amountCents,
        periodStart: inv.periodStart.toISOString(), periodEnd: inv.periodEnd.toISOString(),
        paidAt: inv.paidAt?.toISOString(), dueDate: inv.dueDate.toISOString(),
        description: inv.description, pdfUrl: inv.pdfUrl,
      })),
    });
  });

  // POST /api/billing/subscribe — self-serve today (no real charge); once a
  // gateway is configured this should redirect to its checkout instead.
  fastify.post('/subscribe', auth, async (request, reply) => {
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };
    if (role !== 'owner') return reply.status(403).send({ error: 'Apenas o proprietário pode alterar o plano' });

    const { planId, cycle } = request.body as { planId: string; cycle: 'monthly' | 'annual' };
    const plan = getPlan(planId);
    if (!plan) return reply.status(400).send({ error: 'Plano inválido' });

    const gateway = getPaymentGateway();
    if (gateway.isConfigured()) {
      const { checkoutUrl } = await gateway.createCheckoutSession({ workspaceId, planId, cycle });
      if (checkoutUrl) return reply.send({ data: { checkoutUrl } });
    } else if (process.env.NODE_ENV === 'production') {
      // Without a configured gateway, changePlan() below applies the plan (and lifts
      // every usage limit) with no charge ever collected — fine for local/dev/demo,
      // but a revenue leak the moment this runs in production. Fail closed instead of
      // silently granting free upgrades until a real gateway is wired up.
      return reply.status(503).send({ error: 'Cobrança indisponível no momento. Tente novamente mais tarde.' });
    }

    try {
      await changePlan(workspaceId, planId, cycle);
      void notifyPlanChanged(workspaceId, opts.wsGateway, 'Plano alterado', `Sua assinatura foi atualizada para o plano ${plan.name}`);
      return reply.send({ data: await getSubscriptionResponse(workspaceId) });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // POST /api/billing/cancel — access continues until the end of the paid period
  fastify.post('/cancel', auth, async (request, reply) => {
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };
    if (role !== 'owner') return reply.status(403).send({ error: 'Apenas o proprietário pode cancelar a assinatura' });

    const sub = await cancelSubscription(workspaceId);
    await getPaymentGateway().cancelExternalSubscription(sub.externalSubscriptionId);
    void notifyPlanChanged(workspaceId, opts.wsGateway, 'Assinatura cancelada', 'Sua assinatura será cancelada ao fim do período atual — o acesso continua até lá.');
    return reply.send({ data: await getSubscriptionResponse(workspaceId) });
  });

  // POST /api/billing/resume — undo a pending cancellation before the period ends
  fastify.post('/resume', auth, async (request, reply) => {
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };
    if (role !== 'owner') return reply.status(403).send({ error: 'Apenas o proprietário pode reativar a assinatura' });

    await resumeSubscription(workspaceId);
    void notifyPlanChanged(workspaceId, opts.wsGateway, 'Assinatura reativada', 'O cancelamento foi desfeito — sua assinatura continua normalmente.');
    return reply.send({ data: await getSubscriptionResponse(workspaceId) });
  });
}
