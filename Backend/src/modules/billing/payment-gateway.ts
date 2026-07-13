import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * Everything billing.service.ts needs from a real payment processor. Today
 * only ManualPaymentGateway exists — plan changes are applied directly with
 * no actual charge. To go live with Stripe (or another gateway), implement
 * this interface as `StripePaymentGateway` and swap the instantiation in
 * `getPaymentGateway()` below; nothing in billing.service.ts or the routes
 * needs to change.
 */
export interface PaymentGateway {
  readonly name: 'manual' | 'stripe';

  /** True once real credentials are configured — routes can use this to decide whether to show "assinar" vs "em breve". */
  isConfigured(): boolean;

  /** Create a hosted checkout session for a new/changed subscription. */
  createCheckoutSession(params: {
    workspaceId: string;
    planId: string;
    cycle: 'monthly' | 'annual';
  }): Promise<{ checkoutUrl: string | null }>;

  /** Create a hosted portal session for the customer to manage payment method/invoices. */
  createPortalSession(params: { workspaceId: string; externalCustomerId?: string }): Promise<{ portalUrl: string | null }>;

  /** Cancel at the gateway (no-op for manual — cancellation is just a DB flag until a real gateway exists). */
  cancelExternalSubscription(externalSubscriptionId?: string): Promise<void>;
}

/**
 * No real gateway configured — self-serve plan changes are applied straight
 * to our own Subscription record, and invoices are generated locally,
 * already marked 'paid'. Safe default for launching before Stripe is wired.
 */
export class ManualPaymentGateway implements PaymentGateway {
  readonly name = 'manual' as const;

  isConfigured(): boolean {
    return false;
  }

  async createCheckoutSession(): Promise<{ checkoutUrl: string | null }> {
    logger.info('[billing] createCheckoutSession called with no payment gateway configured — applying plan change directly');
    return { checkoutUrl: null };
  }

  async createPortalSession(): Promise<{ portalUrl: string | null }> {
    logger.info('[billing] createPortalSession called with no payment gateway configured');
    return { portalUrl: null };
  }

  async cancelExternalSubscription(): Promise<void> {
    // nothing to cancel externally
  }
}

let gateway: PaymentGateway | null = null;

export function getPaymentGateway(): PaymentGateway {
  if (!gateway) gateway = new ManualPaymentGateway();
  return gateway;
}
