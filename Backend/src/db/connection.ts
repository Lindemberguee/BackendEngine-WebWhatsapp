import mongoose from 'mongoose';
import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';

const fallbackLogger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export async function connectDatabase(logger: FastifyBaseLogger = fallbackLogger): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not defined');

  mongoose.connection.on('connected', () => logger.info('[MongoDB] Connected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, '[MongoDB] Error'));
  mongoose.connection.on('disconnected', () => logger.warn('[MongoDB] Disconnected'));

  await mongoose.connect(uri, {
    // 10 (Mongoose's own default) starves fast under this app's real fan-out: a
    // single GET /api/analytics/overview or /api/reports/summary issues ~20 queries
    // in one Promise.all, and 8 schedulers poll concurrently on top of normal
    // request traffic — all sharing one pool, across every tenant. A connection is
    // cheap on the MongoDB side; queuing every other tenant's requests behind one
    // dashboard load is not.
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  // Migrate the legacy one-thread-per-contact index to one thread per business
  // number. Contact identity remains unified in the Contact collection.
  const conversations = mongoose.connection.collection('conversations');
  const indexes = await conversations.indexes();
  const legacy = indexes.find((idx) => idx.name === 'workspaceId_1_jid_1' && idx.unique);
  if (legacy) await conversations.dropIndex(legacy.name!);
  await conversations.createIndex({ workspaceId: 1, jid: 1 }, { name: 'workspaceId_1_jid_1' });
  await conversations.createIndex(
    { workspaceId: 1, instanceId: 1, jid: 1 },
    { name: 'workspaceId_1_instanceId_1_jid_1', unique: true, sparse: true }
  );
}

export async function disconnectDatabase(logger: FastifyBaseLogger = fallbackLogger): Promise<void> {
  await mongoose.disconnect();
  logger.info('[MongoDB] Disconnected gracefully');
}
