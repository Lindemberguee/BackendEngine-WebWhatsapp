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
  // On a brand-new database the collection has never been created, and MongoDB
  // throws NamespaceNotFound (code 26) rather than returning an empty list.
  const indexes = await conversations.indexes().catch((err) => {
    if (err?.codeName === 'NamespaceNotFound' || err?.code === 26) return [];
    throw err;
  });
  const legacy = indexes.find((idx) => idx.name === 'workspaceId_1_jid_1' && idx.unique);
  if (legacy) await conversations.dropIndex(legacy.name!);
  await conversations.createIndex({ workspaceId: 1, jid: 1 }, { name: 'workspaceId_1_jid_1' });
  await conversations.createIndex(
    { workspaceId: 1, instanceId: 1, jid: 1 },
    { name: 'workspaceId_1_instanceId_1_jid_1', unique: true, sparse: true }
  );

  await migrateConversationTagsToContact(logger);
}

// Labels used to live on both Conversation and Contact independently (a tag added
// in a conversation never showed up on that contact's profile, and vice versa —
// confusing since they share one catalog). Labels are now a Contact-only property
// (see conversations.routes.ts's /tags routes); this carries over anything already
// sitting on a conversation before that change shipped, so it isn't silently
// orphaned. Idempotent — finds nothing left to do once everything's migrated.
async function migrateConversationTagsToContact(logger: FastifyBaseLogger): Promise<void> {
  const conversations = mongoose.connection.collection('conversations');
  const contacts = mongoose.connection.collection('contacts');
  const cursor = conversations.find(
    { contactId: { $exists: true, $ne: null }, tags: { $exists: true, $not: { $size: 0 } } },
    { projection: { contactId: 1, tags: 1 } }
  );
  let migrated = 0;
  for await (const conv of cursor) {
    await contacts.updateOne({ _id: conv.contactId }, { $addToSet: { tags: { $each: conv.tags } } });
    await conversations.updateOne({ _id: conv._id }, { $set: { tags: [] } });
    migrated++;
  }
  if (migrated > 0) logger.info({ migrated }, '[MongoDB] Merged legacy conversation tags into their contact');
}

export async function disconnectDatabase(logger: FastifyBaseLogger = fallbackLogger): Promise<void> {
  await mongoose.disconnect();
  logger.info('[MongoDB] Disconnected gracefully');
}
