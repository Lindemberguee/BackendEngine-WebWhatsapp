import { accountMembershipFilter } from '../auth/account.service';
import { Subscription, Invoice, Workspace, Instance, User, Flow, Conversation, Pipeline } from '../../db/models';
import type { ISubscription, BillingCycle } from '../../db/models';
import { PLANS, getPlan, getPlanByTier, DEFAULT_TRIAL_TIER, TRIAL_DAYS, type PlanDefinition } from './plans.config';
import { notify, notifyWorkspaceOwner } from '../notifications/notification.service';
import type { WebSocketGateway } from '../../ws/gateway';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

function periodLength(cycle: BillingCycle): number {
  return cycle === 'annual' ? 365 : 30;
}

/** Thrown by the assertCan* helpers below — routes catch it and return 400 with the message as-is. */
export class PlanLimitError extends Error {}

// ── Plans (public, no auth needed to browse) ────────────────────────────────

export function listPlans(): PlanDefinition[] {
  return PLANS;
}

// ── Subscription lifecycle ───────────────────────────────────────────────────

/** Explicit provisioning only; read endpoints must not create trials. */
export async function getOrCreateSubscription(workspaceId: string): Promise<ISubscription> {
  let sub = await Subscription.findOne({ workspaceId });
  if (sub) return sub;

  const trialPlan = getPlanByTier(DEFAULT_TRIAL_TIER)!;
  const now = new Date();
  sub = await Subscription.findOneAndUpdate({ workspaceId }, { $setOnInsert: {
    workspaceId,
    planId: trialPlan.id,
    status: 'trialing',
    cycle: 'monthly',
    currentPeriodStart: now,
    currentPeriodEnd: addDays(now, TRIAL_DAYS),
    trialEndsAt: addDays(now, TRIAL_DAYS),
  } }, { upsert: true, new: true });
  if (!sub) throw new Error('Falha ao provisionar assinatura');
  await Workspace.updateOne({ _id: workspaceId }, { $set: { plan: trialPlan.tier } });
  return sub;
}

function invoiceAmountCents(plan: PlanDefinition, cycle: BillingCycle): number {
  if (plan.monthlyPriceCents == null || plan.annualPriceCents == null) return 0; // enterprise — billed manually outside the system
  return cycle === 'annual' ? plan.annualPriceCents * 12 : plan.monthlyPriceCents;
}

async function nextInvoiceNumber(workspaceId: string): Promise<string> {
  const count = await Invoice.countDocuments({ workspaceId });
  return `INV-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
}

/** Records the charge for a (re)started period. Always 'paid' — see payment-gateway.ts for why. */
async function generateInvoice(sub: ISubscription, plan: PlanDefinition): Promise<void> {
  const amount = invoiceAmountCents(plan, sub.cycle);
  if (amount <= 0) return; // enterprise — no self-serve invoice
  await Invoice.create({
    workspaceId: sub.workspaceId,
    subscriptionId: sub._id,
    number: await nextInvoiceNumber(sub.workspaceId.toString()),
    status: 'paid',
    amountCents: amount,
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
    paidAt: new Date(),
    dueDate: sub.currentPeriodStart,
    description: `Plano ${plan.name} — ${sub.cycle === 'annual' ? 'Anual' : 'Mensal'}`,
  });
}

export async function changePlan(workspaceId: string, planId: string, cycle: BillingCycle): Promise<ISubscription> {
  const plan = getPlan(planId);
  if (!plan) throw new Error('Plano inválido');
  if (plan.tier === 'enterprise') throw new Error('Plano Enterprise não tem assinatura self-service — fale com vendas');

  const sub = await getOrCreateSubscription(workspaceId);
  const now = new Date();
  sub.planId = plan.id;
  sub.cycle = cycle;
  sub.status = 'active';
  sub.currentPeriodStart = now;
  sub.currentPeriodEnd = addDays(now, periodLength(cycle));
  sub.cancelAtPeriodEnd = false;
  sub.trialEndsAt = undefined;
  await sub.save();

  await Workspace.updateOne({ _id: workspaceId }, { $set: { plan: plan.tier } });
  await generateInvoice(sub, plan);
  return sub;
}

export async function cancelSubscription(workspaceId: string): Promise<ISubscription> {
  const sub = await getOrCreateSubscription(workspaceId);
  sub.cancelAtPeriodEnd = true;
  await sub.save();
  return sub;
}

/** Undo a pending cancellation — only meaningful before the period actually ends. */
export async function resumeSubscription(workspaceId: string): Promise<ISubscription> {
  const sub = await getOrCreateSubscription(workspaceId);
  if (!sub.cancelAtPeriodEnd) return sub;
  sub.cancelAtPeriodEnd = false;
  await sub.save();
  return sub;
}

// ── Response shaping (matches the frontend's billing.types.ts contract) ─────

export async function getSubscriptionResponse(workspaceId: string) {
  const sub = await Subscription.findOne({ workspaceId });
  if (!sub) throw Object.assign(new Error('Assinatura não provisionada; contate o suporte'), { statusCode: 409 });
  const plan = getPlan(sub.planId) ?? getPlanByTier('starter')!;
  return {
    id: sub._id.toString(),
    planId: plan.id,
    plan: toPlanResponse(plan),
    status: sub.status,
    cycle: sub.cycle,
    currentPeriodStart: sub.currentPeriodStart.toISOString(),
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    trialEndsAt: sub.trialEndsAt?.toISOString(),
    nextInvoiceAmount: sub.cancelAtPeriodEnd ? 0 : invoiceAmountCents(plan, sub.cycle),
    nextInvoiceDate: sub.currentPeriodEnd.toISOString(),
  };
}

function toPlanResponse(plan: PlanDefinition) {
  return {
    id: plan.id,
    tier: plan.tier,
    name: plan.name,
    description: plan.description,
    monthlyPrice: plan.monthlyPriceCents ?? 0,
    annualPrice: plan.annualPriceCents ?? 0,
    limits: {
      instances: plan.limits.instances ?? 'unlimited',
      conversations: plan.limits.maxConversationsPerMonth ?? 'unlimited',
      agents: plan.limits.agents ?? 'unlimited',
      automations: plan.limits.activeAutomations ?? 'unlimited',
      campaignsEnabled: plan.limits.campaignsEnabled,
      apiAccessEnabled: plan.limits.apiAccessEnabled,
      crmMultiPipeline: plan.limits.crmMultiPipeline,
      analyticsRetentionDays: plan.limits.analyticsRetentionDays ?? 'unlimited',
      multiWorkspace: plan.limits.multiWorkspace,
    },
    features: plan.features,
    highlight: plan.highlight,
    badge: plan.badge,
  };
}

export function listPlansResponse() {
  return PLANS.map(toPlanResponse);
}

export async function getUsage(workspaceId: string) {
  const sub = await Subscription.findOne({ workspaceId });
  const plan = getPlan(sub?.planId ?? '') ?? getPlanByTier('starter')!;

  const [instances, agents, activeAutomations, conversations] = await Promise.all([
    Instance.countDocuments({ workspaceId }),
    User.countDocuments({ workspaceId, isActive: true }),
    Flow.countDocuments({ workspaceId, enabled: true }),
    Conversation.countDocuments({ workspaceId, createdAt: { $gte: sub?.currentPeriodStart ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) } }),
  ]);

  return [
    { key: 'instances', label: 'Instâncias WhatsApp', current: instances, limit: plan.limits.instances ?? 'unlimited', unit: 'instâncias', warnAt: 80 },
    { key: 'agents', label: 'Agentes', current: agents, limit: plan.limits.agents ?? 'unlimited', unit: 'agentes', warnAt: 80 },
    { key: 'automations', label: 'Automações ativas', current: activeAutomations, limit: plan.limits.activeAutomations ?? 'unlimited', unit: 'fluxos', warnAt: 80 },
    { key: 'conversations', label: 'Conversas neste período', current: conversations, limit: plan.limits.maxConversationsPerMonth ?? 'unlimited', unit: 'conversas', warnAt: 80 },
  ];
}

// ── Plan-limit enforcement — call before creating the resource ──────────────

async function currentPlan(workspaceId: string): Promise<PlanDefinition> {
  const sub = await Subscription.findOne({ workspaceId });
  return getPlan(sub?.planId ?? '') ?? getPlanByTier('starter')!;
}

/** New conversations in the current billing period — createdAt, not
 *  updatedAt, so an old conversation getting a new message doesn't count
 *  again (it isn't a *new* conversation). */
async function conversationsThisPeriod(workspaceId: string): Promise<{ count: number; plan: PlanDefinition }> {
  const sub = await Subscription.findOne({ workspaceId });
  const plan = getPlan(sub?.planId ?? '') ?? getPlanByTier('starter')!;
  const count = await Conversation.countDocuments({ workspaceId, createdAt: { $gte: sub?.currentPeriodStart ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) } });
  return { count, plan };
}

/** Hard gate for deliberate conversation creation (manual "Nova conversa" in
 *  the UI, campaign sends creating a fresh thread) — these are actions someone
 *  chose to take, so blocking them at the limit (like every other assertCan*
 *  here) is fine. Do NOT use this on the inbound-message path — see
 *  conversationQuotaJustExceeded below for why. */
export async function assertCanCreateConversation(workspaceId: string): Promise<void> {
  const { count, plan } = await conversationsThisPeriod(workspaceId);
  if (plan.limits.maxConversationsPerMonth == null) return;
  if (count >= plan.limits.maxConversationsPerMonth) {
    throw new PlanLimitError(`Seu plano ${plan.name} permite até ${plan.limits.maxConversationsPerMonth} conversas novas por mês. Faça upgrade pra continuar.`);
  }
}

/** Non-blocking check for the inbound-message path (ingest-inbound.ts): a
 *  customer messaging in for the first time must never be dropped just
 *  because the workspace is over its plan's monthly conversation count — that
 *  would silently lose real customer messages, which is worse than letting
 *  one workspace run over quota. Call AFTER the conversation upsert, only
 *  when it was a brand-new conversation; returns non-null exactly once per
 *  overage (the count equals limit+1 only on the message that crossed it), so
 *  callers can fire a single "you're over quota" notification instead of one
 *  per message from then on. */
export async function conversationQuotaJustExceeded(
  workspaceId: string
): Promise<{ plan: PlanDefinition; limit: number } | null> {
  const { count, plan } = await conversationsThisPeriod(workspaceId);
  const limit = plan.limits.maxConversationsPerMonth;
  if (limit == null || count !== limit + 1) return null;
  return { plan, limit };
}

export async function assertCanCreateInstance(workspaceId: string): Promise<void> {
  const plan = await currentPlan(workspaceId);
  if (plan.limits.instances == null) return;
  const count = await Instance.countDocuments({ workspaceId });
  if (count >= plan.limits.instances) {
    throw new PlanLimitError(`Seu plano ${plan.name} permite até ${plan.limits.instances} instância(s) WhatsApp. Faça upgrade pra conectar mais números.`);
  }
}

export async function assertCanCreateAgent(workspaceId: string): Promise<void> {
  const plan = await currentPlan(workspaceId);
  if (plan.limits.agents == null) return;
  const count = await User.countDocuments({ workspaceId, isActive: true });
  if (count >= plan.limits.agents) {
    throw new PlanLimitError(`Seu plano ${plan.name} permite até ${plan.limits.agents} agente(s). Faça upgrade pra adicionar mais membros ao time.`);
  }
}

export async function assertCampaignsEnabled(workspaceId: string): Promise<void> {
  const plan = await currentPlan(workspaceId);
  if (!plan.limits.campaignsEnabled) {
    throw new PlanLimitError(`Campanhas não estão disponíveis no plano ${plan.name}. Faça upgrade pro plano Pro pra desbloquear.`);
  }
}

export async function assertOfficialChannelEnabled(workspaceId: string): Promise<void> {
  const plan = await currentPlan(workspaceId);
  if (!plan.limits.officialChannelEnabled) {
    throw new PlanLimitError(`A API Oficial da Meta não está disponível no plano ${plan.name}. Faça upgrade pro plano Pro pra desbloquear.`);
  }
}

/** Gates creating a new workspace-level API key or webhook subscription —
 *  existing ones from before a downgrade keep working, this just stops new ones. */
export async function assertApiAccessEnabled(workspaceId: string): Promise<void> {
  const plan = await currentPlan(workspaceId);
  if (!plan.limits.apiAccessEnabled) {
    throw new PlanLimitError(`API e webhooks não estão disponíveis no plano ${plan.name}. Faça upgrade pro plano Profissional pra desbloquear.`);
  }
}

/** Clamps a requested analytics/report start date to what the workspace's plan
 *  is allowed to look back on — a request for a wider range than the plan
 *  covers silently gets the earliest date the plan permits, instead of the
 *  requested `from` (the retention field existed on the plan config and was
 *  shown in the billing UI, but nothing actually enforced it). */
export async function clampAnalyticsFrom(workspaceId: string, from: Date): Promise<Date> {
  const plan = await currentPlan(workspaceId);
  const days = plan.limits.analyticsRetentionDays;
  if (days == null) return from;
  const earliestAllowed = new Date(Date.now() - days * DAY_MS);
  return from < earliestAllowed ? earliestAllowed : from;
}

export async function assertCanActivateAutomation(workspaceId: string): Promise<void> {
  const plan = await currentPlan(workspaceId);
  if (plan.limits.activeAutomations == null) return;
  const count = await Flow.countDocuments({ workspaceId, enabled: true });
  if (count >= plan.limits.activeAutomations) {
    throw new PlanLimitError(`Seu plano ${plan.name} permite até ${plan.limits.activeAutomations} automação(ões) ativa(s) ao mesmo tempo. Desative outra ou faça upgrade.`);
  }
}

export async function assertCanCreatePipeline(workspaceId: string): Promise<void> {
  const plan = await currentPlan(workspaceId);
  if (plan.limits.crmMultiPipeline) return;
  const count = await Pipeline.countDocuments({ workspaceId });
  if (count >= 1) {
    throw new PlanLimitError(`Seu plano ${plan.name} permite apenas 1 funil de CRM. Faça upgrade pro plano Pro pra criar múltiplos funis.`);
  }
}

/** multiWorkspace is per-owner, not per-workspace: the first workspace a user
 *  creates is always free, but a 2nd+ requires that at least one workspace
 *  they already own is on a plan with multiWorkspace enabled (today, only
 *  Enterprise). Checking this BEFORE the new workspace exists also closes the
 *  loophole where creating workspace after workspace kept minting fresh
 *  14-day Pro trials (getOrCreateSubscription never runs for a rejected create). */
export async function assertCanCreateWorkspace(ownerId: string): Promise<void> {
  const caller = await User.findById(ownerId).select('accountId').lean();
  const ownerIds = caller ? await User.find(accountMembershipFilter(caller)).distinct('_id') : [ownerId];
  const owned = await Workspace.find({ ownerId: { $in: ownerIds } }).select('_id').lean();
  if (owned.length === 0) return;
  const subs = await Subscription.find({ workspaceId: { $in: owned.map((w) => w._id) } }).lean();
  const anyMultiWorkspace = subs.some((s) => getPlan(s.planId)?.limits.multiWorkspace);
  if (!anyMultiWorkspace) {
    throw new PlanLimitError('Criar múltiplos workspaces exige o plano Enterprise em pelo menos um deles. Fale com vendas para habilitar.');
  }
}

// ── Trial expiration (called by billing-scheduler.ts) ────────────────────────

export async function expireDueTrials(wsGateway: WebSocketGateway): Promise<void> {
  const now = new Date();
  const due = await Subscription.find({ status: 'trialing', trialEndsAt: { $lte: now } });
  const starter = getPlanByTier('starter')!;

  for (const sub of due) {
    try {
      sub.planId = starter.id;
      sub.status = 'active';
      sub.currentPeriodStart = now;
      sub.currentPeriodEnd = addDays(now, periodLength(sub.cycle));
      sub.trialEndsAt = undefined;
      await sub.save();
      await Workspace.updateOne({ _id: sub.workspaceId }, { $set: { plan: starter.tier } });

      const ws = await Workspace.findById(sub.workspaceId).select('ownerId').lean();
      if (ws?.ownerId) {
        void notify(wsGateway, {
          workspaceId: sub.workspaceId.toString(), recipientId: ws.ownerId.toString(),
          type: 'billing.plan_changed', title: 'Seu teste grátis terminou',
          message: `O período de teste do plano Pro acabou — sua conta foi movida pro plano ${starter.name}. Instâncias/agentes já criados continuam funcionando; para criar novos além do limite, faça upgrade.`,
          link: '/billing',
        });
      }
    } catch (err) {
      logger.warn({ err, workspaceId: sub.workspaceId }, '[billing] failed to expire trial');
    }
  }
}

/** Applies a requested cancellation when the paid period ends. Data remains intact;
 * the workspace returns to the baseline Starter tier and can be upgraded again. */
export async function expireDueCancellations(wsGateway: WebSocketGateway): Promise<void> {
  const now = new Date();
  const due = await Subscription.find({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: { $lte: now } });
  const starter = getPlanByTier('starter')!;
  for (const sub of due) {
    sub.planId = starter.id;
    sub.status = 'canceled';
    sub.cancelAtPeriodEnd = false;
    sub.currentPeriodStart = now;
    sub.currentPeriodEnd = addDays(now, 30);
    sub.provider = 'manual';
    sub.externalSubscriptionId = undefined;
    await sub.save();
    await Workspace.updateOne({ _id: sub.workspaceId }, { $set: { plan: starter.tier } });
    void notifyWorkspaceOwner(wsGateway, sub.workspaceId.toString(), {
      type: 'billing.plan_changed', title: 'Assinatura encerrada',
      message: 'O período contratado terminou e o workspace voltou para o plano Starter.', link: '/billing',
    });
  }
}

export async function notifyPlanChanged(workspaceId: string, wsGateway: WebSocketGateway, title: string, message: string): Promise<void> {
  await notifyWorkspaceOwner(wsGateway, workspaceId, { type: 'billing.plan_changed', title, message, link: '/billing' });
}
