import { createHmac } from 'crypto';
import pino from 'pino';
import { WebhookDelivery, WebhookSubscription } from '../../db/models';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const TICK_MS = 5_000;
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;
// attempt 1 fails → retry in ~1min; attempt 2 fails → retry in ~5min; attempt 3 fails → give up.
const BACKOFF_MS = [60_000, 300_000];

let timer: ReturnType<typeof setInterval> | null = null;
// Re-entrancy guard — a batch of 20 deliveries at up to 8s each can outlast the
// 5s tick interval; without this, an overlapping tick re-fetches the same
// still-`pending` rows and POSTs the customer's endpoint twice for one event.
let running = false;

/** HMAC-SHA256 signature of a delivery body — pulled out for direct unit testing. */
export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Global webhook delivery dispatcher — ticks every few seconds, sending any
 * WebhookDelivery that's due (covers both the first attempt and every retry, so
 * there's one code path for the whole lifecycle). Mirrors the campaign-dispatcher's
 * setInterval + persisted-state shape (see campaigns/campaign-dispatcher.ts) so it
 * survives restarts without losing or double-sending anything.
 */
export function startWebhookDispatcher(): void {
  if (timer) return;
  timer = setInterval(() => { tick().catch((err) => logger.error({ err }, '[webhooks] dispatcher tick failed')); }, TICK_MS);
  logger.info('[webhooks] dispatcher started');
}

export function stopWebhookDispatcher(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = await WebhookDelivery.find({ status: 'pending', nextAttemptAt: { $lte: new Date() } }).limit(BATCH_SIZE);
    for (const delivery of due) {
      try {
        await deliver(delivery);
      } catch (err) {
        logger.warn({ err, deliveryId: delivery._id }, '[webhooks] delivery attempt threw unexpectedly');
      }
    }
  } finally {
    running = false;
  }
}

async function deliver(delivery: InstanceType<typeof WebhookDelivery>): Promise<void> {
  const subscription = await WebhookSubscription.findById(delivery.subscriptionId);
  if (!subscription || !subscription.enabled) {
    await WebhookDelivery.updateOne({ _id: delivery._id }, {
      $set: { status: 'failed', error: 'Assinatura removida ou desativada' },
    });
    return;
  }

  const body = JSON.stringify({ event: delivery.event, data: delivery.payload, timestamp: new Date().toISOString() });
  const signature = signPayload(subscription.secret, body);

  try {
    const res = await fetch(subscription.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event': delivery.event,
        'X-Webhook-Id': delivery._id.toString(),
        'X-Webhook-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Don't auto-follow redirects: the target URL passed isPublicHttpUrl() at
      // creation time, but a 3xx response body is attacker-controlled once the URL
      // belongs to a customer's own webhook receiver — following it would let a
      // "public" URL redirect straight to an internal address (SSRF via redirect).
      redirect: 'manual',
    });

    if (res.ok) {
      await WebhookDelivery.updateOne({ _id: delivery._id }, { $set: { status: 'success', responseStatus: res.status } });
      return;
    }
    await failAttempt(delivery, `HTTP ${res.status}`, res.status);
  } catch (err) {
    await failAttempt(delivery, (err as Error).message);
  }
}

async function failAttempt(delivery: InstanceType<typeof WebhookDelivery>, error: string, responseStatus?: number): Promise<void> {
  const attempts = delivery.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await WebhookDelivery.updateOne({ _id: delivery._id }, { $set: { status: 'failed', attempts, error, responseStatus } });
    return;
  }
  const nextAttemptAt = new Date(Date.now() + BACKOFF_MS[attempts - 1]);
  await WebhookDelivery.updateOne({ _id: delivery._id }, { $set: { attempts, error, responseStatus, nextAttemptAt } });
}
