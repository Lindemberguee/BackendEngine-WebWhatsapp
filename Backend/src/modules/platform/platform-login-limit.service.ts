import { createHmac } from 'node:crypto';
import { PlatformLoginAttempt } from '../../db/models/PlatformLoginAttempt.model';

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;

export async function consumeSharedPlatformLoginAttempt(emailInput: string, now = new Date()): Promise<number> {
  const secret = process.env.PLATFORM_ADMIN_API_KEY;
  if (!secret) throw new Error('Platform admin key is not configured');

  // Store only a keyed digest so rate-limit records do not expose admin emails.
  const id = createHmac('sha256', secret).update(emailInput.trim().toLowerCase()).digest('hex');
  const windowEndsAt = new Date(now.getTime() + WINDOW_MS);
  const update = [{$set: {
    attempts: {$cond: [{$gt: ['$windowEndsAt', now]}, {$add: [{$ifNull: ['$attempts', 0]}, 1]}, 1]},
    windowEndsAt: {$cond: [{$gt: ['$windowEndsAt', now]}, '$windowEndsAt', windowEndsAt]},
  }}];

  let bucket;
  try {
    bucket = await PlatformLoginAttempt.findOneAndUpdate({ _id: id }, update, { upsert: true, new: true }).lean();
  } catch (error) {
    // Concurrent first attempts may race to upsert the same _id. Retry against
    // the record created by the winning request.
    if ((error as { code?: number }).code !== 11000) throw error;
    bucket = await PlatformLoginAttempt.findOneAndUpdate({ _id: id }, update, { new: true }).lean();
  }

  if (!bucket || bucket.attempts <= MAX_ATTEMPTS) return 0;
  return Math.max(1, Math.ceil((bucket.windowEndsAt.getTime() - now.getTime()) / 1000));
}
