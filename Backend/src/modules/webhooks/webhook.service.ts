import pino from 'pino';
import { WebhookSubscription, WebhookDelivery } from '../../db/models';
import type { WebhookEvent } from '../../db/models';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * Fan out an internal event to every enabled subscription that wants it. Only
 * enqueues a WebhookDelivery ('pending', due immediately) — the dispatcher
 * (webhook-dispatcher.ts) is the single place that actually sends, so the first
 * attempt and every retry share one code path. Never throws — a webhook failure
 * must never break the action that triggered it.
 */
export async function emitWebhookEvent(workspaceId: string, event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
  try {
    const subs = await WebhookSubscription.find({ workspaceId, enabled: true, events: event }).select('_id').lean();
    if (!subs.length) return;
    await WebhookDelivery.insertMany(
      subs.map((sub) => ({
        workspaceId, subscriptionId: sub._id, event, payload,
        status: 'pending', attempts: 0, nextAttemptAt: new Date(),
      }))
    );
  } catch (err) {
    logger.warn({ err, event }, '[webhooks] emitWebhookEvent failed');
  }
}
