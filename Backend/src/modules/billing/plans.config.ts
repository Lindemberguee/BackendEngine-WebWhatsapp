/**
 * Single source of truth for plan pricing/limits — everything else (Subscription
 * enforcement, the /billing UI, the WorkspaceSwitcher badge) reads from here
 * instead of hardcoding numbers in more than one place.
 */

export type PlanTier = 'starter' | 'pro' | 'enterprise';

export interface PlanLimits {
  /** null = unlimited */
  instances: number | null;
  agents: number | null;
  /** New conversations (upsert-on-first-message OR manual/campaign creation)
   *  allowed per current billing period. null = unlimited. See
   *  assertCanCreateConversation / conversationsThisPeriod. */
  maxConversationsPerMonth: number | null;
  /** cap on ACTIVE (published) flows, not total flows saved */
  activeAutomations: number | null;
  campaignsEnabled: boolean;
  /** Meta WhatsApp Cloud API (BYO-WABA) as a connectable instance channel. */
  officialChannelEnabled: boolean;
  /** Workspace-level API keys + outbound webhook subscriptions (integrations),
   *  not the WhatsApp channel itself — see officialChannelEnabled for that. */
  apiAccessEnabled: boolean;
  crmMultiPipeline: boolean;
  /** null = full history */
  analyticsRetentionDays: number | null;
  multiWorkspace: boolean;
}

export interface PlanFeature {
  label: string;
  included: boolean;
  highlight?: boolean;
}

export interface PlanDefinition {
  id: string;
  tier: PlanTier;
  name: string;
  description: string;
  /** cents; null means "fale com vendas" — no plan currently uses this, all
   *  three (Essencial/Profissional/Business) have a public self-serve price. */
  monthlyPriceCents: number | null;
  annualPriceCents: number | null;
  limits: PlanLimits;
  features: PlanFeature[];
  highlight?: boolean;
  badge?: string;
}

// Numbers here MUST match the public pricing table (src/app/page.tsx's PLANS
// array, in the frontend repo) — those are two separate arrays in two separate
// repos with no shared source, so a change to one always needs the other
// updated by hand. ids/tiers ('starter'/'pro'/'enterprise') stay as internal
// identifiers (referenced elsewhere — billing.service.ts, platform.routes.ts,
// Workspace.model.ts) even though the user-facing names are now
// Essencial/Profissional/Business.
export const PLANS: PlanDefinition[] = [
  {
    id: 'plan-starter',
    tier: 'starter',
    name: 'Essencial',
    description: 'Para organizar o primeiro time de atendimento',
    monthlyPriceCents: 14_900,
    annualPriceCents: 7_900,
    limits: {
      instances: 1,
      agents: 3,
      maxConversationsPerMonth: 1_000,
      activeAutomations: 3,
      campaignsEnabled: false,
      officialChannelEnabled: false,
      apiAccessEnabled: false,
      crmMultiPipeline: false,
      analyticsRetentionDays: 30,
      multiWorkspace: false,
    },
    features: [
      { label: '1 número de WhatsApp', included: true },
      { label: '3 usuários', included: true },
      { label: '1.000 conversas por mês', included: true },
      { label: 'Até 3 automações ativas', included: true },
      { label: 'CRM (1 funil)', included: true },
      { label: 'Histórico de 30 dias', included: true },
      { label: 'Suporte por e-mail', included: true },
      { label: 'Campanhas em massa', included: false },
      { label: 'API e webhooks', included: false },
      { label: 'Multi-workspace', included: false },
    ],
  },
  {
    id: 'plan-pro',
    tier: 'pro',
    name: 'Profissional',
    description: 'Para equipes que querem vender e atender em escala',
    monthlyPriceCents: 34_900,
    annualPriceCents: 18_900,
    highlight: true,
    badge: 'Mais escolhido',
    limits: {
      instances: 3,
      agents: 10,
      maxConversationsPerMonth: 5_000,
      activeAutomations: null,
      campaignsEnabled: true,
      officialChannelEnabled: true,
      apiAccessEnabled: true,
      crmMultiPipeline: true,
      analyticsRetentionDays: 180,
      multiWorkspace: false,
    },
    features: [
      { label: '3 números de WhatsApp', included: true, highlight: true },
      { label: '10 usuários', included: true },
      { label: '5.000 conversas por mês', included: true },
      { label: 'Automações e Flow Builder ilimitados', included: true, highlight: true },
      { label: 'CRM com múltiplos funis', included: true, highlight: true },
      { label: 'Campanhas e templates oficiais', included: true, highlight: true },
      { label: 'API e webhooks', included: true },
      { label: 'Histórico de 180 dias + relatórios avançados', included: true },
      { label: 'Suporte prioritário', included: true },
      { label: 'Multi-workspace', included: false },
    ],
  },
  {
    id: 'plan-enterprise',
    tier: 'enterprise',
    name: 'Business',
    description: 'Para operações maduras, com volume e mais controle',
    monthlyPriceCents: 79_900,
    annualPriceCents: 44_900,
    limits: {
      instances: 10,
      agents: 30,
      maxConversationsPerMonth: 20_000,
      activeAutomations: null,
      campaignsEnabled: true,
      officialChannelEnabled: true,
      apiAccessEnabled: true,
      crmMultiPipeline: true,
      analyticsRetentionDays: 365,
      multiWorkspace: true,
    },
    features: [
      { label: '10 números de WhatsApp', included: true, highlight: true },
      { label: '30 usuários', included: true },
      { label: '20.000 conversas por mês', included: true },
      { label: 'Múltiplos workspaces', included: true, highlight: true },
      { label: 'API e webhooks com maior capacidade', included: true },
      { label: 'Gestão avançada de equipes e grupos', included: true },
      { label: 'Relatórios completos e exportações', included: true },
      { label: 'Histórico de 12 meses', included: true },
      { label: 'Implantação assistida', included: true },
      { label: 'Atendimento prioritário', included: true, highlight: true },
    ],
  },
];

export function getPlan(id: string): PlanDefinition | undefined {
  return PLANS.find((p) => p.id === id);
}

export function getPlanByTier(tier: PlanTier): PlanDefinition | undefined {
  return PLANS.find((p) => p.tier === tier);
}

export const DEFAULT_TRIAL_TIER: PlanTier = 'pro';
export const TRIAL_DAYS = 14;
