import type { FastifyInstance } from 'fastify';
import { createHash, createHmac } from 'crypto';
import pino from 'pino';
import { Instance, Conversation, Message, MetaWebhookEvent, WhatsAppTemplate, CampaignRecipient, Campaign } from '../../db/models';
import type { WebSocketGateway } from '../../ws/gateway';
import type { SessionManager } from '../../session-manager/SessionManager';
import type { OutboundMessage } from '../../messaging/outbound-types';
import { ingestInboundMessage } from '../../messaging/ingest-inbound';
import { extractInboundMessages, extractStatusUpdates, type MetaWebhookPayload } from '../../channels/cloud-api/normalize-inbound';
import { decryptSecret, safeEqual } from '../../shared/crypto';
import { downloadCloudApiMedia } from '../../channels/cloud-api/graph-client';
import { archiveMessageMedia } from '../../shared/media-storage';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };
const MAX_ATTEMPTS = 8;

function registerRawBodyCapture(fastify: FastifyInstance): void {
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    try {
      const raw = body as Buffer;
      done(null, { raw, json: raw.length ? JSON.parse(raw.toString('utf8')) : {} });
    } catch (err) {
      done(err as Error, undefined);
    }
  });
}

function phoneNumberId(payload: MetaWebhookPayload): string | undefined {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const id = change.value?.metadata?.phone_number_id;
      if (id) return id;
    }
  }
  return undefined;
}

function payloadWabaId(payload: MetaWebhookPayload): string | undefined {
  return payload.entry?.find((entry) => entry.id)?.id;
}

async function applyAccountEvents(instanceId: string, payload: MetaWebhookPayload): Promise<void> {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value as Record<string, unknown> | undefined;
      if (!value) continue;
      if (change.field === 'message_template_status_update') {
        const name = String(value.message_template_name ?? '');
        const language = String(value.message_template_language ?? '');
        const event = String(value.event ?? '').toUpperCase();
        if (name && ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED'].includes(event)) {
          await WhatsAppTemplate.updateMany(
            { instanceId, name, ...(language ? { language } : {}) },
            { $set: { status: event, syncedAt: new Date() } }
          );
        }
      }
      if (change.field === 'phone_number_quality_update') {
        await Instance.updateOne({ _id: instanceId }, { $set: {
          'cloudApi.qualityRating': String(value.current_quality_rating ?? value.quality_rating ?? ''),
          'cloudApi.messagingLimit': String(value.current_limit ?? ''),
          'cloudApi.lastHealthCheckAt': new Date(),
        } });
      }
      if (change.field === 'account_update') {
        const event = String(value.event ?? '').toUpperCase();
        if (event.includes('DISABLE') || event.includes('BAN')) {
          await Instance.updateOne({ _id: instanceId }, { $set: { status: 'banned', errorMessage: `Meta account update: ${event}` } });
        }
      }
    }
  }
}

async function applyStatusUpdate(
  workspaceId: string,
  messageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted',
  wsGateway: WebSocketGateway,
  error?: { code?: number; title?: string; message?: string; details?: string }
): Promise<void> {
  const filter: Record<string, unknown> = { messageId, workspaceId };
  if (status !== 'failed' && status !== 'deleted') {
    const allowed = Object.entries(STATUS_RANK).filter(([, rank]) => rank <= STATUS_RANK[status]).map(([s]) => s);
    filter.status = { $in: allowed };
  }
  const update: Record<string, unknown> = { status };
  if (error) update.providerError = error;
  const doc = await Message.findOneAndUpdate(filter, { $set: update }, { new: true });
  if (!doc) return;
  const recipientFilter: Record<string, unknown> = { workspaceId, messageId };
  if (status === 'sent') recipientFilter.status = { $in: ['pending', 'sending', 'sent'] };
  if (status === 'delivered') recipientFilter.status = { $in: ['pending', 'sending', 'sent', 'delivered'] };
  if (status === 'read') recipientFilter.status = { $in: ['pending', 'sending', 'sent', 'delivered', 'read'] };
  const recipient = await CampaignRecipient.findOneAndUpdate(
    recipientFilter,
    { $set: { status: status === 'deleted' ? 'failed' : status, ...(error ? { error: error.details ?? error.message ?? error.title } : {}) } },
    { new: true }
  );
  if (recipient) {
    const [sent, delivered, read, failed, skipped, pending] = await Promise.all(
      ['sent', 'delivered', 'read', 'failed', 'skipped', 'pending'].map((value) => CampaignRecipient.countDocuments({ campaignId: recipient.campaignId, status: value }))
    );
    await Campaign.updateOne({ _id: recipient.campaignId }, { $set: { 'stats.sent': sent, 'stats.delivered': delivered, 'stats.read': read, 'stats.failed': failed, 'stats.skipped': skipped, 'stats.pending': pending } });
  }
  const parent = await Conversation.findById(doc.conversationId).select('assignedAgentId').lean();
  wsGateway.broadcastToConversationVisibility(workspaceId, parent?.assignedAgentId?.toString(), 'message:status', {
    conversationId: doc.conversationId.toString(), messageId: doc._id.toString(), status, providerError: error,
  });
}

async function processEvent(eventId: string, wsGateway: WebSocketGateway, sessionManager: SessionManager): Promise<void> {
  const event = await MetaWebhookEvent.findOneAndUpdate(
    { _id: eventId, status: { $in: ['pending', 'retry'] } },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { new: true }
  );
  if (!event) return;

  try {
    const instance = await Instance.findById(event.instanceId);
    if (!instance?.cloudApi || instance.channel !== 'cloud_api') throw new Error('Instância Cloud API indisponível');
    const workspaceId = event.workspaceId.toString();
    const payload = event.payload as MetaWebhookPayload;

    await applyAccountEvents(instance._id.toString(), payload);

    for (const status of extractStatusUpdates(payload)) {
      await applyStatusUpdate(workspaceId, status.messageId, status.status, wsGateway, status.error);
    }

    const inboundMessages = extractInboundMessages(payload);
    const session = inboundMessages.length > 0
      ? await sessionManager.ensureSession(instance._id.toString())
      : null;
    for (const message of inboundMessages) {
      if (message.type === 'reaction' && typeof message.content.targetMessageId === 'string') {
        const target = await Message.findOne({ workspaceId, instanceId: instance._id, messageId: message.content.targetMessageId });
        if (target) {
          target.reactions = target.reactions ?? [];
          const emoji = String(message.content.emoji ?? '');
          const existing = target.reactions.find((reaction) => reaction.jid === message.jid);
          if (emoji && existing) { existing.emoji = emoji; existing.timestamp = message.timestamp; }
          else if (emoji) target.reactions.push({ emoji, jid: message.jid, phone: message.phone, timestamp: message.timestamp });
          else target.reactions = target.reactions.filter((reaction) => reaction.jid !== message.jid);
          await target.save();
          wsGateway.broadcastToWorkspace(workspaceId, 'message:reactions-update', {
            conversationId: target.conversationId.toString(), messageId: target._id.toString(), reactions: target.reactions,
          });
        }
        continue;
      }
      await ingestInboundMessage({
        workspaceId,
        instanceId: instance._id.toString(),
        jid: message.jid,
        messageId: message.messageId,
        fromMe: false,
        isGroup: false,
        phone: message.phone,
        type: message.type,
        text: message.text,
        content: message.content,
        quoted: message.quoted,
        senderName: message.contactName ?? message.phone,
        contactDisplayName: message.contactName,
        conversationName: message.contactName ?? message.phone,
        timestamp: message.timestamp,
        rawPayload: message.content,
        providerMessage: message.providerMessage,
      }, {
        wsGateway,
        sendMessage: async (jid, content) => {
          if (session!.sendFlowMessage) return session!.sendFlowMessage(jid, content as unknown as OutboundMessage);
          const sent = await session!.sendMessage(jid, content as unknown as OutboundMessage);
          return sent.providerMessageId ? { key: { id: sent.providerMessageId } } : undefined;
        },
        archiveMedia: typeof message.content.mediaId === 'string' ? async (savedMessageId) => {
          const { buffer, mimeType } = await downloadCloudApiMedia(message.content.mediaId as string, {
            phoneNumberId: instance.cloudApi!.phoneNumberId,
            accessToken: decryptSecret(instance.cloudApi!.accessTokenEnc),
            graphVersion: instance.cloudApi!.graphVersion,
          });
          await archiveMessageMedia(savedMessageId, workspaceId, buffer, mimeType, typeof message.content.fileName === 'string' ? message.content.fileName : undefined);
        } : undefined,
      });
    }

    await MetaWebhookEvent.updateOne({ _id: event._id }, {
      $set: { status: 'processed', processedAt: new Date() },
      $unset: { error: 1, nextAttemptAt: 1 },
    });
  } catch (err) {
    const attempts = event.attempts;
    const dead = attempts >= MAX_ATTEMPTS;
    const delayMs = Math.min(60 * 60_000, 2 ** Math.max(0, attempts - 1) * 5_000);
    await MetaWebhookEvent.updateOne({ _id: event._id }, {
      $set: {
        status: dead ? 'dead' : 'retry',
        error: err instanceof Error ? err.message : String(err),
        ...(!dead ? { nextAttemptAt: new Date(Date.now() + delayMs) } : {}),
      },
    });
    logger.error({ err, eventId, attempts }, '[webhooks/meta] queued event processing failed');
  }
}

async function processDueEvents(wsGateway: WebSocketGateway, sessionManager: SessionManager): Promise<void> {
  await MetaWebhookEvent.updateMany(
    { status: 'processing', updatedAt: { $lt: new Date(Date.now() - 5 * 60_000) } },
    { $set: { status: 'retry', nextAttemptAt: new Date() } }
  );
  const due = await MetaWebhookEvent.find({
    status: { $in: ['pending', 'retry'] },
    $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: new Date() } }],
  }).sort({ createdAt: 1 }).limit(25).select('_id').lean();
  for (const event of due) await processEvent(event._id.toString(), wsGateway, sessionManager);
}

export async function webhooksMetaRoutes(
  fastify: FastifyInstance,
  opts: { wsGateway: WebSocketGateway; sessionManager: SessionManager }
): Promise<void> {
  registerRawBodyCapture(fastify);

  const verifyHandler = async (request: { params: unknown; query: unknown }, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) => {
    const { instanceId } = (request.params ?? {}) as { instanceId?: string };
    const query = request.query as Record<string, string>;
    if (query['hub.mode'] !== 'subscribe' || !query['hub.verify_token']) return reply.status(403).send({ error: 'Verificação inválida' });

    let expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (!expected && instanceId) {
      const instance = await Instance.findById(instanceId).select('cloudApi.verifyToken channel').lean();
      if (instance?.channel === 'cloud_api') expected = instance.cloudApi?.verifyToken;
    }
    if (!expected || !safeEqual(query['hub.verify_token'], expected)) return reply.status(403).send({ error: 'Verify token inválido' });
    return reply.status(200).send(query['hub.challenge'] ?? '');
  };

  fastify.get('/', verifyHandler as never);
  fastify.get('/:instanceId', verifyHandler as never); // compatibility with existing installations

  const postHandler = async (request: { params: unknown; body: unknown; headers: Record<string, unknown> }, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) => {
    const { instanceId } = (request.params ?? {}) as { instanceId?: string };
    const { raw, json } = request.body as { raw: Buffer; json: MetaWebhookPayload };
    if (json.object !== 'whatsapp_business_account') return reply.status(400).send({ error: 'Objeto de webhook inválido' });

    const metadataPhoneId = phoneNumberId(json);
    const eventWabaId = payloadWabaId(json);
    const instance = instanceId
      ? await Instance.findById(instanceId)
      : metadataPhoneId
        ? await Instance.findOne({ channel: 'cloud_api', 'cloudApi.phoneNumberId': metadataPhoneId })
        : eventWabaId ? await Instance.findOne({ channel: 'cloud_api', 'cloudApi.wabaId': eventWabaId }) : null;
    if (!instance?.cloudApi || instance.channel !== 'cloud_api') return reply.status(404).send({ error: 'Instância não encontrada' });
    if (metadataPhoneId && metadataPhoneId !== instance.cloudApi.phoneNumberId) return reply.status(403).send({ error: 'Phone Number ID não corresponde à instância' });
    if (!metadataPhoneId && eventWabaId !== instance.cloudApi.wabaId) return reply.status(403).send({ error: 'WABA ID não corresponde à instância' });

    const appSecret = process.env.META_APP_SECRET || (instance.cloudApi.appSecretEnc ? decryptSecret(instance.cloudApi.appSecretEnc) : '');
    const signature = request.headers['x-hub-signature-256'];
    const expected = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
    if (!appSecret || typeof signature !== 'string' || !safeEqual(signature, expected)) {
      return reply.status(401).send({ error: 'Assinatura inválida' });
    }

    const digest = createHash('sha256').update(raw).digest('hex');
    let eventId: string | undefined;
    try {
      const event = await MetaWebhookEvent.create({
        workspaceId: instance.workspaceId, instanceId: instance._id, digest, payload: json,
      });
      eventId = event._id.toString();
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }

    if (eventId) setImmediate(() => void processEvent(eventId!, opts.wsGateway, opts.sessionManager));
    return reply.status(200).send({ ok: true, queued: Boolean(eventId) });
  };

  fastify.post('/', { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, postHandler as never);
  fastify.post('/:instanceId', { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, postHandler as never);

  let timer: NodeJS.Timeout | undefined;
  fastify.addHook('onReady', async () => {
    timer = setInterval(() => void processDueEvents(opts.wsGateway, opts.sessionManager), 5_000);
    timer.unref();
    void processDueEvents(opts.wsGateway, opts.sessionManager);
  });
  fastify.addHook('onClose', async () => { if (timer) clearInterval(timer); });
}
