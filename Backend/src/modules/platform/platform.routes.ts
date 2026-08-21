import { timingSafeEqual } from 'crypto';
import { Types } from 'mongoose';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Workspace, User, Subscription, Instance, Conversation, Invoice, PricingRate } from '../../db/models';
import type { PricingCategory } from '../../db/models';
import { getPlan, PLANS } from '../billing/plans.config';
import { describeMediaStorage, testMediaStorageConnection } from '../../shared/media-storage';

function secureEqual(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function platformAuthenticate(request: FastifyRequest, reply: FastifyReply) {
  const expected = process.env.PLATFORM_ADMIN_API_KEY;
  if (!expected) return reply.status(503).send({ error: 'Administração da plataforma não configurada' });
  const received = request.headers['x-platform-admin-key'];
  if (typeof received !== 'string' || !secureEqual(received, expected)) {
    return reply.status(401).send({ error: 'Não autorizado' });
  }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export async function platformRoutes(fastify: FastifyInstance): Promise<void> {
  const adminOnly = { preHandler: [platformAuthenticate] };

  fastify.get('/overview', adminOnly, async (_request, reply) => {
    const now = new Date();
    const [workspaces, activeWorkspaces, suspendedWorkspaces, users, instances, conversations, subscriptions, paidInvoices] = await Promise.all([
      Workspace.countDocuments(), Workspace.countDocuments({ status: { $ne: 'suspended' } }), Workspace.countDocuments({ status: 'suspended' }),
      User.countDocuments({ isActive: true }), Instance.countDocuments(), Conversation.countDocuments(), Subscription.find().lean(),
      Invoice.aggregate<{ total: number }>([
        { $match: { status: 'paid', paidAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) } } },
        { $group: { _id: null, total: { $sum: '$amountCents' } } },
      ]),
    ]);
    const byPlan = { starter: 0, pro: 0, enterprise: 0 };
    const byStatus = { trialing: 0, active: 0, past_due: 0, canceled: 0, paused: 0 };
    for (const sub of subscriptions) {
      byPlan[getPlan(sub.planId)?.tier ?? 'starter'] += 1;
      byStatus[sub.status] += 1;
    }
    return reply.send({ data: { workspaces, activeWorkspaces, suspendedWorkspaces, users, instances, conversations, monthlyRevenueCents: paidInvoices[0]?.total ?? 0, byPlan, byStatus } });
  });

  fastify.get('/storage', adminOnly, async (_request, reply) => {
    return reply.send({ data: describeMediaStorage() });
  });

  fastify.post('/storage/test', adminOnly, async (request, reply) => {
    const result = await testMediaStorageConnection();
    request.log.info({ provider: result.provider, service: result.service, reachable: result.reachable, errorCode: result.errorCode }, '[platform] media storage diagnostic');
    return reply.send({ data: result });
  });

  fastify.get('/workspaces', adminOnly, async (request, reply) => {
    const { search = '', plan = '', status = '', page = '1', limit = '20' } = request.query as Record<string, string>;
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
    const filter: Record<string, unknown> = {};
    if (search.trim()) filter.$or = [{ name: { $regex: search.trim(), $options: 'i' } }, { slug: { $regex: search.trim(), $options: 'i' } }];
    if (['starter', 'pro', 'enterprise'].includes(plan)) filter.plan = plan;
    if (status === 'active') filter.status = { $ne: 'suspended' };
    if (status === 'suspended') filter.status = 'suspended';
    const [items, total] = await Promise.all([
      Workspace.find(filter).sort({ createdAt: -1 }).skip((pageNumber - 1) * pageSize).limit(pageSize).lean(), Workspace.countDocuments(filter),
    ]);
    const ids = items.map((item) => item._id);
    const [owners, subscriptions, userCounts, instanceCounts, conversationCounts] = await Promise.all([
      User.find({ _id: { $in: items.map((item) => item.ownerId) } }).select('name email').lean(), Subscription.find({ workspaceId: { $in: ids } }).lean(),
      User.aggregate<{ _id: Types.ObjectId; count: number }>([{ $match: { workspaceId: { $in: ids }, isActive: true } }, { $group: { _id: '$workspaceId', count: { $sum: 1 } } }]),
      Instance.aggregate<{ _id: Types.ObjectId; count: number }>([{ $match: { workspaceId: { $in: ids } } }, { $group: { _id: '$workspaceId', count: { $sum: 1 } } }]),
      Conversation.aggregate<{ _id: Types.ObjectId; count: number }>([{ $match: { workspaceId: { $in: ids } } }, { $group: { _id: '$workspaceId', count: { $sum: 1 } } }]),
    ]);
    const ownerMap = new Map(owners.map((owner) => [owner._id.toString(), owner]));
    const subscriptionMap = new Map(subscriptions.map((sub) => [sub.workspaceId.toString(), sub]));
    const countMap = <T extends { _id: Types.ObjectId; count: number }>(rows: T[]) => new Map(rows.map((row) => [row._id.toString(), row.count]));
    const usersByWorkspace = countMap(userCounts), instancesByWorkspace = countMap(instanceCounts), conversationsByWorkspace = countMap(conversationCounts);
    return reply.send({ data: items.map((workspace) => {
      const id = workspace._id.toString(), owner = ownerMap.get(workspace.ownerId.toString()), subscription = subscriptionMap.get(id);
      return {
        id, name: workspace.name, slug: workspace.slug, plan: workspace.plan, status: workspace.status ?? 'active', suspendedAt: workspace.suspendedAt?.toISOString(),
        createdAt: workspace.createdAt.toISOString(), owner: owner ? { name: owner.name, email: owner.email } : null,
        subscription: subscription ? { id: subscription._id.toString(), status: subscription.status, cycle: subscription.cycle, currentPeriodEnd: subscription.currentPeriodEnd.toISOString(), trialEndsAt: subscription.trialEndsAt?.toISOString(), cancelAtPeriodEnd: subscription.cancelAtPeriodEnd } : null,
        usage: { users: usersByWorkspace.get(id) ?? 0, instances: instancesByWorkspace.get(id) ?? 0, conversations: conversationsByWorkspace.get(id) ?? 0 },
      };
    }), meta: { page: pageNumber, limit: pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  });

  fastify.patch('/workspaces/:id/status', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status?: 'active' | 'suspended' };
    if (!Types.ObjectId.isValid(id) || !['active', 'suspended'].includes(status ?? '')) return reply.status(400).send({ error: 'Dados inválidos' });
    const update = status === 'suspended' ? { $set: { status, suspendedAt: new Date() } } : { $set: { status }, $unset: { suspendedAt: 1 } };
    const workspace = await Workspace.findByIdAndUpdate(id, update, { new: true });
    if (!workspace) return reply.status(404).send({ error: 'Workspace não encontrado' });
    if (status === 'suspended') await User.updateMany({ workspaceId: workspace._id }, { $inc: { tokenVersion: 1 } });
    request.log.info({ workspaceId: id, status }, '[platform] workspace status changed');
    return reply.send({ data: { id, status: workspace.status, suspendedAt: workspace.suspendedAt?.toISOString() } });
  });

  fastify.patch('/workspaces/:id/subscription', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { planId, cycle = 'monthly', status = 'active', trialDays } = request.body as { planId?: string; cycle?: 'monthly' | 'annual'; status?: 'trialing' | 'active' | 'past_due' | 'canceled' | 'paused'; trialDays?: number };
    const plan = planId ? getPlan(planId) : undefined;
    if (!Types.ObjectId.isValid(id) || !plan || !['monthly', 'annual'].includes(cycle) || !['trialing', 'active', 'past_due', 'canceled', 'paused'].includes(status)) return reply.status(400).send({ error: 'Assinatura inválida' });
    if (!(await Workspace.exists({ _id: id }))) return reply.status(404).send({ error: 'Workspace não encontrado' });
    const now = new Date(), normalizedTrialDays = Math.min(365, Math.max(1, Number(trialDays) || 14));
    const end = status === 'trialing' ? addDays(now, normalizedTrialDays) : addDays(now, cycle === 'annual' ? 365 : 30);
    const update = { $set: { planId: plan.id, cycle, status, provider: 'manual', currentPeriodStart: now, currentPeriodEnd: end, cancelAtPeriodEnd: false, ...(status === 'trialing' ? { trialEndsAt: end } : {}) }, ...(status !== 'trialing' ? { $unset: { trialEndsAt: 1 } } : {}) };
    const sub = await Subscription.findOneAndUpdate({ workspaceId: id }, update, { new: true, upsert: true, setDefaultsOnInsert: true });
    await Workspace.updateOne({ _id: id }, { $set: { plan: plan.tier } });
    request.log.info({ workspaceId: id, planId: plan.id, cycle, status }, '[platform] subscription changed manually');
    return reply.send({ data: { id: sub._id.toString(), planId: sub.planId, plan: plan.tier, cycle: sub.cycle, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd.toISOString(), trialEndsAt: sub.trialEndsAt?.toISOString() } });
  });

  fastify.get('/plans', adminOnly, async (_request, reply) => reply.send({ data: PLANS.map((plan) => ({ id: plan.id, tier: plan.tier, name: plan.name })) }));

  // ── Pricing rates (Meta's own WhatsApp template rate card) ────────────────
  // Platform-wide, not per-workspace — this is what Meta charges per template
  // send by country + category, not anything about this SaaS's own plans.
  // Meta doesn't expose a live quote API (confirmed against their docs), only
  // a static rate card that changes on fixed quarterly dates, so this is the
  // thing a platform admin keeps in sync by hand via this CRUD.
  const CATEGORIES: PricingCategory[] = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];

  /** Seeds 3 obvious placeholder rows for Brazil (R$ 0,00, flagged PENDENTE) the
   *  first time the rates screen is opened and nothing exists yet — same
   *  lazy-create-on-first-use pattern as ensureDefaultPipeline (crm.service.ts).
   *  Never overwrites a real value; only fires when the collection is empty. */
  async function ensurePlaceholderRates(): Promise<void> {
    if (await PricingRate.exists({})) return;
    await PricingRate.insertMany(CATEGORIES.map((category) => ({
      region: 'BR', label: 'Brasil', countryCallingCodes: ['55'], category,
      currency: 'BRL', priceCents: 0, effectiveFrom: new Date(),
      notes: 'PENDENTE — preencher com o valor real de business.whatsapp.com/products/platform-pricing',
    })));
  }

  fastify.get('/pricing-rates', adminOnly, async (_request, reply) => {
    await ensurePlaceholderRates();
    const rates = await PricingRate.find().sort({ region: 1, category: 1 });
    return reply.send({ data: rates.map((r) => r.toJSON()) });
  });

  fastify.post('/pricing-rates', adminOnly, async (request, reply) => {
    const body = request.body as {
      region?: string; label?: string; countryCallingCodes?: string[];
      category?: string; currency?: string; priceCents?: number; notes?: string;
    };
    const region = body.region?.trim().toUpperCase();
    const label = body.label?.trim();
    const currency = body.currency?.trim().toUpperCase();
    if (!region || !label || !currency || !CATEGORIES.includes(body.category as PricingCategory)) {
      return reply.status(400).send({ error: 'Preencha região, rótulo, categoria e moeda' });
    }
    if (typeof body.priceCents !== 'number' || body.priceCents < 0) {
      return reply.status(400).send({ error: 'Valor inválido' });
    }
    try {
      const rate = await PricingRate.create({
        region, label, category: body.category, currency,
        priceCents: body.priceCents,
        countryCallingCodes: Array.isArray(body.countryCallingCodes) ? body.countryCallingCodes.map((c) => c.trim()).filter(Boolean) : [],
        notes: body.notes?.trim() || undefined,
        effectiveFrom: new Date(),
      });
      return reply.status(201).send({ data: rate.toJSON() });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return reply.status(409).send({ error: 'Já existe uma tarifa para essa região + categoria' });
      throw err;
    }
  });

  fastify.patch('/pricing-rates/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) return reply.status(404).send({ error: 'Tarifa não encontrada' });
    const body = request.body as {
      label?: string; countryCallingCodes?: string[]; currency?: string; priceCents?: number; notes?: string;
    };
    const update: Record<string, unknown> = {};
    if (body.label !== undefined) update.label = body.label.trim();
    if (body.currency !== undefined) update.currency = body.currency.trim().toUpperCase();
    if (body.countryCallingCodes !== undefined) update.countryCallingCodes = body.countryCallingCodes.map((c) => c.trim()).filter(Boolean);
    if (body.notes !== undefined) update.notes = body.notes.trim() || undefined;
    if (body.priceCents !== undefined) {
      if (typeof body.priceCents !== 'number' || body.priceCents < 0) return reply.status(400).send({ error: 'Valor inválido' });
      update.priceCents = body.priceCents;
      update.effectiveFrom = new Date();
    }
    const rate = await PricingRate.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!rate) return reply.status(404).send({ error: 'Tarifa não encontrada' });
    return reply.send({ data: rate.toJSON() });
  });

  fastify.delete('/pricing-rates/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) return reply.status(404).send({ error: 'Tarifa não encontrada' });
    await PricingRate.deleteOne({ _id: id });
    return reply.status(204).send();
  });
}
