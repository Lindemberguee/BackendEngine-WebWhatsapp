import { Campaign } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import type { WebSocketGateway } from '../../ws/gateway';
import { sendNextRecipient, maybeCompleteCampaign } from './campaign.service';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const TICK_MS = 4_000;
let timer: ReturnType<typeof setInterval> | null = null;

function randomDelaySeconds(min: number, max: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + Math.random() * (hi - lo);
}

/**
 * Global campaign dispatcher — ticks every few seconds, advancing every
 * workspace's active campaigns by at most one message per tick, paced by
 * each campaign's own `nextSendAt` cursor. Persisted in Mongo (not
 * in-memory), so it survives server restarts without losing progress or
 * re-sending anything already marked sent.
 */
export function startCampaignDispatcher(sessionManager: SessionManager, gateway: WebSocketGateway): void {
  if (timer) return;
  timer = setInterval(() => { tick(sessionManager, gateway).catch((err) => logger.error({ err }, '[campaign] dispatcher tick failed')); }, TICK_MS);
  logger.info('[campaign] dispatcher started');
}

export function stopCampaignDispatcher(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick(sessionManager: SessionManager, gateway: WebSocketGateway): Promise<void> {
  const now = new Date();

  // Promote due scheduled campaigns to sending.
  await Campaign.updateMany(
    { status: 'scheduled', scheduledAt: { $lte: now } },
    { $set: { status: 'sending' } }
  );

  const due = await Campaign.find({ status: 'sending', $or: [{ nextSendAt: { $lte: now } }, { nextSendAt: { $exists: false } }] });
  for (const campaign of due) {
    try {
      const result = await sendNextRecipient(sessionManager, gateway, campaign);
      if (result === 'empty') {
        await maybeCompleteCampaign(gateway, campaign);
        continue;
      }
      if (result === 'no_capacity') {
        // Try again next tick instead of hammering — back off a bit longer than one tick.
        await Campaign.updateOne({ _id: campaign._id }, { $set: { nextSendAt: new Date(Date.now() + TICK_MS * 3) } });
        continue;
      }
      const delay = randomDelaySeconds(campaign.throttle.minDelaySeconds, campaign.throttle.maxDelaySeconds);
      await Campaign.updateOne({ _id: campaign._id }, { $set: { nextSendAt: new Date(Date.now() + delay * 1000) } });
    } catch (err) {
      logger.warn({ err, campaignId: campaign._id }, '[campaign] failed to advance');
    }
  }
}
