/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import { Campaign, CampaignRecipient, Contact, Conversation, Message, Instance, Lead } from '../../db/models';
import type { ICampaign, ICampaignAudience, IFlowNode } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import type { WebSocketGateway } from '../../ws/gateway';
import { notify, notifyWorkspaceOwner } from '../notifications/notification.service';
import { emitWebhookEvent } from '../webhooks/webhook.service';
import { buildMessageContent, type FlowContext } from '../../flow-executor/senders';
import { ensureDefaultPipeline, nextOrder, logLeadActivity } from '../crm/crm.service';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const CONSECUTIVE_FAILURE_LIMIT = 5;

/** Shape returned by `.lean()` Contact queries — enough for audience resolution/personalization. */
export interface LeanContact {
  _id: Types.ObjectId;
  jid: string;
  phone: string;
  name: string;
  email?: string;
  status: string;
  optedOutAt?: Date;
}

/** Opted-out / blocked contacts are excluded from every audience type, always. */
function baseAudienceFilter(workspaceId: string) {
  return { workspaceId, status: { $ne: 'blocked' }, optedOutAt: { $exists: false } };
}

/** Resolve a campaign's audience definition into the concrete list of eligible contacts. */
export async function resolveAudience(workspaceId: string, audience: ICampaignAudience): Promise<LeanContact[]> {
  const base = baseAudienceFilter(workspaceId);
  switch (audience.type) {
    case 'all':
      return Contact.find(base).lean();

    case 'tag':
      if (!audience.tags?.length) return [];
      return Contact.find({ ...base, tags: { $in: audience.tags } }).lean();

    case 'crm_stage': {
      if (!audience.pipelineId || !audience.stageId) return [];
      const leads = await Lead.find({ workspaceId, pipelineId: audience.pipelineId, stageId: audience.stageId, status: 'open' }).select('contactId').lean();
      const contactIds = leads.map((l) => l.contactId);
      if (!contactIds.length) return [];
      return Contact.find({ ...base, _id: { $in: contactIds } }).lean();
    }

    case 'manual':
      if (!audience.contactIds?.length) return [];
      return Contact.find({ ...base, _id: { $in: audience.contactIds } }).lean();

    default:
      return [];
  }
}

/** Maps a campaign message block type onto the Message document's `type` enum. */
function toMessageDocType(blockType: string): string {
  const map: Record<string, string> = {
    'message.text': 'text', 'message.image': 'image', 'message.video': 'video', 'message.audio': 'audio',
    'message.document': 'document', 'message.location': 'location', 'message.contact': 'contact', 'message.poll': 'poll',
    'message.buttons': 'interactive', 'message.cta': 'interactive', 'message.list': 'interactive', 'payment.pix': 'interactive',
  };
  return map[blockType] ?? 'text';
}

/** Appends an opt-out hint to whichever text-bearing field the built content has, in place. */
function appendOptOutFooter(content: Record<string, unknown>): void {
  const hint = '\n\n_Não quer mais receber essas mensagens? Responda PARAR._';
  if (typeof content.text === 'string' && content.text.trim()) content.text += hint;
  else if (typeof content.caption === 'string' && content.caption.trim()) content.caption += hint;
}

/** Snapshot the resolved audience into CampaignRecipient rows and flip the campaign to scheduled/sending. */
export async function launchCampaign(campaignId: string, workspaceId: string): Promise<ICampaign | null> {
  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) return null;
  if (!['draft', 'paused'].includes(campaign.status)) return campaign;

  // Only snapshot recipients the first time (draft → launch). Resuming from pause reuses existing rows.
  if (campaign.status === 'draft') {
    const contacts = await resolveAudience(workspaceId, campaign.audience);
    if (contacts.length === 0) throw new Error('Nenhum contato elegível para esse público');
    await CampaignRecipient.insertMany(
      contacts.map((c) => ({
        workspaceId, campaignId: campaign._id, contactId: c._id, jid: c.jid, name: c.name, status: 'pending',
      }))
    );
    campaign.stats.total = contacts.length;
    campaign.stats.pending = contacts.length;
    campaign.consecutiveFailures = 0;
  }

  const isFuture = campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now();
  campaign.status = isFuture ? 'scheduled' : 'sending';
  campaign.startedAt = campaign.startedAt ?? new Date();
  campaign.nextSendAt = isFuture ? campaign.scheduledAt : new Date();
  await campaign.save();
  return campaign;
}

export async function pauseCampaign(campaignId: string, workspaceId: string): Promise<ICampaign | null> {
  return Campaign.findOneAndUpdate({ _id: campaignId, workspaceId, status: { $in: ['sending', 'scheduled'] } }, { $set: { status: 'paused' } }, { new: true });
}

export async function cancelCampaign(campaignId: string, workspaceId: string): Promise<ICampaign | null> {
  const campaign = await Campaign.findOneAndUpdate(
    { _id: campaignId, workspaceId, status: { $in: ['draft', 'scheduled', 'sending', 'paused'] } },
    { $set: { status: 'cancelled' } },
    { new: true }
  );
  if (campaign) {
    const res = await CampaignRecipient.updateMany({ campaignId, status: 'pending' }, { $set: { status: 'skipped', skipReason: undefined } });
    await Campaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.skipped': res.modifiedCount, 'stats.pending': -res.modifiedCount } });
  }
  return campaign;
}

/** Send a campaign's configured message to an ad-hoc phone number, bypassing recipient bookkeeping — for previewing before a real launch. */
export async function sendTestMessage(sessionManager: SessionManager, campaign: ICampaign, phone: string): Promise<void> {
  const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
  const instance = await Instance.findOne({ _id: { $in: campaign.instanceIds }, status: 'connected' });
  if (!instance) throw new Error('Nenhuma instância conectada nessa campanha');
  const session = sessionManager.getSession(instance._id.toString());
  if (!session) throw new Error('Sessão não está pronta');

  const ctx: FlowContext = { variables: {}, contact: { name: 'Você (teste)', phone } };
  const node = { id: 'campaign-test', blockType: campaign.message.blockType, config: campaign.message.config } as unknown as IFlowNode;
  const content = buildMessageContent(node, ctx) as Record<string, unknown> | null;
  if (!content) throw new Error('Mensagem inválida — confira o conteúdo configurado');
  if (campaign.includeOptOutFooter) appendOptOutFooter(content);
  await (session.sendMessage as (jid: string, c: unknown) => Promise<any>)(jid, content);
}

/**
 * Send one message to one recipient: validates the number is on WhatsApp, picks an
 * instance (round-robin, respecting hourly/daily caps), finds-or-creates the
 * Contact's Conversation, sends via the live Baileys session, and persists a real
 * Message so it shows up in the normal conversation view like any other outbound
 * message. Tags the contact with the campaign's name for future segmentation.
 */
export async function sendNextRecipient(
  sessionManager: SessionManager,
  gateway: WebSocketGateway,
  campaign: ICampaign
): Promise<'sent' | 'skipped' | 'no_capacity' | 'empty' | 'paused'> {
  if (campaign.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
    await Campaign.updateOne({ _id: campaign._id, status: 'sending' }, { $set: { status: 'paused' } });
    void notifyWorkspaceOwner(gateway, campaign.workspaceId.toString(), {
      type: 'campaign.completed', title: 'Campanha pausada automaticamente',
      message: `"${campaign.name}" foi pausada após ${CONSECUTIVE_FAILURE_LIMIT} falhas seguidas — verifique a conexão do número antes de retomar.`,
      link: `/campaigns/${campaign._id.toString()}`, metadata: { campaignId: campaign._id.toString() },
    });
    return 'paused';
  }

  const recipient = await CampaignRecipient.findOne({ campaignId: campaign._id, status: 'pending' }).sort({ createdAt: 1 });
  if (!recipient) return 'empty';

  const contact = await Contact.findById(recipient.contactId).lean();
  if (!contact || contact.status === 'blocked' || contact.optedOutAt) {
    recipient.status = 'skipped';
    recipient.skipReason = contact?.optedOutAt ? 'opted_out' : 'blocked';
    await recipient.save();
    await Campaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.skipped': 1, 'stats.pending': -1 } });
    return 'skipped';
  }

  // Pick a connected instance with hourly AND daily capacity left, rotating through the campaign's list.
  const instances = await Instance.find({ _id: { $in: campaign.instanceIds }, status: 'connected' }).lean();
  if (!instances.length) return 'no_capacity';
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  let chosen: (typeof instances)[number] | null = null;
  let nextIndex = campaign.lastInstanceIndex;
  for (let i = 0; i < instances.length; i++) {
    nextIndex = (nextIndex + 1) % instances.length;
    const candidate = instances[nextIndex];
    const [sentLastHour, sentToday] = await Promise.all([
      CampaignRecipient.countDocuments({ workspaceId: campaign.workspaceId, instanceId: candidate._id, status: { $in: ['sent', 'delivered', 'read'] }, sentAt: { $gte: oneHourAgo } }),
      CampaignRecipient.countDocuments({ workspaceId: campaign.workspaceId, instanceId: candidate._id, status: { $in: ['sent', 'delivered', 'read'] }, sentAt: { $gte: startOfDay } }),
    ]);
    if (sentLastHour < campaign.throttle.maxPerInstancePerHour && sentToday < campaign.throttle.maxPerInstancePerDay) { chosen = candidate; break; }
  }
  if (!chosen) return 'no_capacity';

  const session = sessionManager.getSession(chosen._id.toString());
  if (!session) return 'no_capacity';

  // Validate the number is actually registered on WhatsApp before spending a send slot on it.
  if (session.checkOnWhatsApp) {
    try {
      const results = await session.checkOnWhatsApp(recipient.jid);
      if (results && results.length > 0 && !results[0]?.exists) {
        recipient.status = 'skipped';
        recipient.skipReason = 'invalid_number';
        await recipient.save();
        await Campaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.skipped': 1, 'stats.pending': -1 } });
        return 'skipped';
      }
    } catch { /* validation unavailable/failed — proceed and let the real send surface any error */ }
  }

  recipient.status = 'sending';
  recipient.instanceId = chosen._id as unknown as Types.ObjectId;
  await recipient.save();
  await Campaign.updateOne({ _id: campaign._id }, { $set: { lastInstanceIndex: nextIndex } });

  try {
    const ctx: FlowContext = { variables: {}, contact: { name: contact.name, phone: contact.phone, email: contact.email } };
    const node = { id: 'campaign', blockType: campaign.message.blockType, config: campaign.message.config } as unknown as IFlowNode;
    const content = buildMessageContent(node, ctx) as Record<string, unknown> | null;
    if (!content) throw new Error('Mensagem inválida — confira o conteúdo configurado');
    if (campaign.includeOptOutFooter) appendOptOutFooter(content);

    const sent = await (session.sendMessage as (jid: string, c: unknown) => Promise<any>)(recipient.jid, content);
    const messageId = sent?.key?.id ?? `campaign-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Find-or-create the conversation so this shows up like any normal outbound message.
    let conversation = await Conversation.findOne({ workspaceId: campaign.workspaceId, jid: recipient.jid });
    if (!conversation) {
      conversation = await Conversation.create({
        workspaceId: campaign.workspaceId, name: contact.name, phone: contact.phone, jid: recipient.jid,
        status: 'open', isGroup: false, unreadCount: 0, contactId: contact._id, instanceId: chosen._id,
      });
    }
    const now = new Date();
    const preview = typeof content.text === 'string' ? content.text : typeof content.caption === 'string' ? content.caption : '[mídia]';
    const docType = toMessageDocType(campaign.message.blockType);
    await Message.create({
      workspaceId: campaign.workspaceId, instanceId: chosen._id, conversationId: conversation._id,
      jid: recipient.jid, messageId, direction: 'outbound', type: docType,
      status: 'sent', fromMe: true, content,
    });
    await Conversation.updateOne({ _id: conversation._id }, { $set: { lastMessage: { content: preview, type: docType, direction: 'outbound', timestamp: now } } });

    // Tag the contact with the campaign so future audiences can include/exclude "already reached".
    await Contact.updateOne({ _id: contact._id }, { $addToSet: { tags: `campanha:${campaign.name}` } });

    recipient.status = 'sent';
    recipient.messageId = messageId;
    recipient.conversationId = conversation._id as unknown as Types.ObjectId;
    recipient.sentAt = now;
    await recipient.save();
    await Campaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.sent': 1, 'stats.pending': -1 }, $set: { consecutiveFailures: 0 } });
    return 'sent';
  } catch (err) {
    logger.warn({ err, recipientId: recipient._id }, '[campaign] send failed');
    recipient.status = 'failed';
    recipient.error = err instanceof Error ? err.message : String(err);
    await recipient.save();
    await Campaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.failed': 1, 'stats.pending': -1, consecutiveFailures: 1 } });
    return 'sent'; // still consumed a pending recipient — dispatcher should still pace the next tick
  }
}

/** Marks a campaign completed once no pending recipients remain, and notifies the creator. */
export async function maybeCompleteCampaign(gateway: WebSocketGateway, campaign: ICampaign): Promise<void> {
  const pending = await CampaignRecipient.countDocuments({ campaignId: campaign._id, status: { $in: ['pending', 'sending'] } });
  if (pending > 0) return;
  await Campaign.updateOne({ _id: campaign._id, status: { $in: ['sending', 'scheduled'] } }, { $set: { status: 'completed', completedAt: new Date() } });
  void notify(gateway, {
    workspaceId: campaign.workspaceId.toString(), recipientId: campaign.createdBy.toString(), type: 'campaign.completed',
    title: 'Campanha concluída', message: `"${campaign.name}" terminou — ${campaign.stats.sent} enviadas, ${campaign.stats.failed} falharam, ${campaign.stats.skipped} puladas`,
    link: `/campaigns/${campaign._id.toString()}`, metadata: { campaignId: campaign._id.toString() },
  });
  void emitWebhookEvent(campaign.workspaceId.toString(), 'campaign.completed', {
    campaignId: campaign._id.toString(), name: campaign.name, stats: campaign.stats,
  });
}

const STATUS_RANK: Record<string, number> = { pending: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

/**
 * Called from the message-ack handler when a Message's delivery status changes.
 * Backfills the matching CampaignRecipient (by messageId) and keeps the
 * campaign's delivered/read stat buckets in sync — this is the only place that
 * ever moves a recipient past "sent", so without it delivered/read stay at 0
 * forever regardless of what actually happened on WhatsApp.
 */
export async function backfillRecipientDeliveryStatus(messageId: string, newStatus: 'sent' | 'delivered' | 'read'): Promise<void> {
  try {
    const recipient = await CampaignRecipient.findOne({ messageId });
    if (!recipient) return;
    const currentRank = STATUS_RANK[recipient.status] ?? -1;
    const newRank = STATUS_RANK[newStatus] ?? -1;
    if (newRank <= currentRank) return; // never downgrade (read can arrive after delivered, out of order acks, etc.)
    const oldStatus = recipient.status;
    recipient.status = newStatus;
    await recipient.save();
    const inc: Record<string, number> = { [`stats.${newStatus}`]: 1 };
    if (oldStatus === 'sent' || oldStatus === 'delivered') inc[`stats.${oldStatus}`] = -1;
    await Campaign.updateOne({ _id: recipient.campaignId }, { $inc: inc });
  } catch (err) {
    logger.warn({ err, messageId }, '[campaign] delivery backfill failed');
  }
}

/**
 * Called from the inbound-message handler. If this jid has an un-replied campaign
 * send in the last 14 days, marks it replied, bumps the campaign's reply stat, and
 * auto-creates a CRM lead for the contact if they don't already have an open one —
 * a reply to a campaign is exactly the kind of signal that should surface in CRM
 * without an agent having to notice and create it by hand.
 */
export async function handleCampaignReply(workspaceId: string, jid: string, conversationId: string, contactId: string): Promise<void> {
  try {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const recipient = await CampaignRecipient.findOne({
      workspaceId, jid, status: { $in: ['sent', 'delivered', 'read'] }, sentAt: { $gte: since }, repliedAt: { $exists: false },
    }).sort({ sentAt: -1 });
    if (!recipient) return;

    recipient.repliedAt = new Date();
    await recipient.save();
    await Campaign.updateOne({ _id: recipient.campaignId }, { $inc: { 'stats.replied': 1 } });

    const campaign = await Campaign.findById(recipient.campaignId);
    if (!campaign) return;

    const existingOpenLead = await Lead.findOne({ workspaceId, contactId, status: 'open' });
    if (existingOpenLead) return;

    const contact = await Contact.findById(contactId).lean();
    const pipeline = await ensureDefaultPipeline(workspaceId);
    const stageId = pipeline.stages[0]?.id;
    if (!stageId) return;
    const wid = new Types.ObjectId(workspaceId);
    const lead = await Lead.create({
      workspaceId: wid, pipelineId: pipeline._id, stageId, contactId, conversationId,
      title: contact?.name || 'Lead de campanha', source: 'campaign',
      order: await nextOrder(wid, pipeline._id as Types.ObjectId, stageId),
    });
    await logLeadActivity({
      workspaceId: wid, leadId: lead._id, type: 'created',
      message: `Lead criado automaticamente — respondeu à campanha "${campaign.name}"`, actorName: 'Automação',
    });
  } catch (err) {
    logger.warn({ err, jid }, '[campaign] reply handling failed');
  }
}
