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
  /** cap on ACTIVE (published) flows, not total flows saved */
  activeAutomations: number | null;
  campaignsEnabled: boolean;
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
  /** cents; null on enterprise — "fale com vendas", no public self-serve price */
  monthlyPriceCents: number | null;
  annualPriceCents: number | null;
  limits: PlanLimits;
  features: PlanFeature[];
  highlight?: boolean;
  badge?: string;
}

export const PLANS: PlanDefinition[] = [
  {
    id: 'plan-starter',
    tier: 'starter',
    name: 'Starter',
    description: 'Para quem está validando o produto',
    monthlyPriceCents: 9_700,
    annualPriceCents: 7_760,
    limits: {
      instances: 1,
      agents: 2,
      activeAutomations: 3,
      campaignsEnabled: false,
      crmMultiPipeline: false,
      analyticsRetentionDays: 7,
      multiWorkspace: false,
    },
    features: [
      { label: '1 instância WhatsApp', included: true },
      { label: '2 agentes', included: true },
      { label: 'Conversas ilimitadas', included: true },
      { label: 'Até 3 automações ativas', included: true },
      { label: 'CRM (1 funil)', included: true },
      { label: 'Analytics (7 dias)', included: true },
      { label: 'Suporte por e-mail', included: true },
      { label: 'Campanhas em massa', included: false },
      { label: 'Multi-workspace', included: false },
    ],
  },
  {
    id: 'plan-pro',
    tier: 'pro',
    name: 'Pro',
    description: 'Para times em crescimento que precisam de mais poder',
    monthlyPriceCents: 29_700,
    annualPriceCents: 23_760,
    highlight: true,
    badge: 'Mais popular',
    limits: {
      instances: 5,
      agents: 10,
      activeAutomations: null,
      campaignsEnabled: true,
      crmMultiPipeline: true,
      analyticsRetentionDays: 90,
      multiWorkspace: false,
    },
    features: [
      { label: 'Até 5 instâncias WhatsApp', included: true, highlight: true },
      { label: 'Até 10 agentes', included: true },
      { label: 'Conversas ilimitadas', included: true },
      { label: 'Automações ilimitadas', included: true, highlight: true },
      { label: 'CRM (funis ilimitados + relatórios)', included: true, highlight: true },
      { label: 'Campanhas em massa', included: true, highlight: true },
      { label: 'Analytics (90 dias) + exportação', included: true },
      { label: 'Suporte prioritário', included: true },
      { label: 'Multi-workspace', included: false },
    ],
  },
  {
    id: 'plan-enterprise',
    tier: 'enterprise',
    name: 'Enterprise',
    description: 'Para grandes operações com volume e compliance',
    monthlyPriceCents: null,
    annualPriceCents: null,
    limits: {
      instances: null,
      agents: null,
      activeAutomations: null,
      campaignsEnabled: true,
      crmMultiPipeline: true,
      analyticsRetentionDays: null,
      multiWorkspace: true,
    },
    features: [
      { label: 'Instâncias ilimitadas', included: true, highlight: true },
      { label: 'Agentes ilimitados', included: true },
      { label: 'Multi-workspace', included: true, highlight: true },
      { label: 'Automações e campanhas sem limite', included: true },
      { label: 'Analytics com histórico completo', included: true },
      { label: 'Suporte dedicado + SLA', included: true, highlight: true },
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
