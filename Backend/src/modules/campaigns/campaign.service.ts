/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import { Campaign, CampaignRecipient, Contact, Conversation, Message, Instance, Lead, WhatsAppTemplate } from '../../db/models';
import type { ICampaign, ICampaignAudience, IFlowNode } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import type { WebSocketGateway } from '../../ws/gateway';
import { notify, notifyWorkspaceOwner } from '../notifications/notification.service';
import { emitWebhookEvent } from '../webhooks/webhook.service';
import { buildOutboundMessage, type FlowContext } from '../../flow-executor/senders';
import { toBaileys } from '../../channels/baileys/to-baileys';
import type { OutboundMessage } from '../../messaging/outbound-types';
import { ensureDefaultPipeline, nextOrder, logLeadActivity } from '../crm/crm.service';
import { findRateForSend } from './rate-lookup';
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
  whatsappOptInAt?: Date;
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

/** Appends an opt-out hint to whichever text-bearing field the message has, in
 *  place. Never called for a 'template' kind — Meta rejects any deviation from
 *  an approved template's exact approved body text. */
function appendOptOutFooter(msg: OutboundMessage): void {
  const hint = '\n\n_Não quer mais receber essas mensagens? Responda PARAR._';
  if (msg.kind === 'text' && msg.text.trim()) msg.text += hint;
  else if ('caption' in msg) msg.caption = (msg.caption ? msg.caption + hint : hint.trim());
}

/** Builds the content stored on the Message doc + a plain-text preview for the
 *  conversation list. Templates use the synced approved body with the actual
 *  recipient variables substituted; other messages reuse their Baileys shape. */
async function toStoredContent(
  outbound: OutboundMessage,
  blockType: string,
  workspaceId: Types.ObjectId,
  instanceId: Types.ObjectId
): Promise<{ content: Record<string, unknown>; preview: string; docType: string }> {
  if (outbound.kind === 'template') {
    const template = await WhatsAppTemplate.findOne({
      workspaceId, instanceId, name: outbound.templateName, language: outbound.language,
    }).lean();
    const rawComponents = Array.isArray(template?.components) ? template.components as Array<Record<string, unknown>> : [];
    const body = rawComponents.find((component) => String(component.type).toUpperCase() === 'BODY');
    let preview = typeof body?.text === 'string' ? body.text : `Template: ${outbound.templateName}`;
    const sentComponents = Array.isArray(outbound.components) ? outbound.components as Array<Record<string, unknown>> : [];
    const sentBody = sentComponents.find((component) => String(component.type).toLowerCase() === 'body');
    const parameters = Array.isArray(sentBody?.parameters) ? sentBody.parameters as Array<Record<string, unknown>> : [];
    parameters.forEach((parameter, index) => {
      const value = typeof parameter.text === 'string' ? parameter.text : '';
      preview = preview.replace(new RegExp(`\\{\\{\\s*${index + 1}\\s*\\}\\}`, 'g'), value);
    });
    return { content: { text: preview, template: { name: outbound.templateName, language: outbound.language, components: outbound.components } }, preview, docType: 'text' };
  }
  const content = (toBaileys(outbound) as Record<string, unknown> | null) ?? {};
  const preview = typeof content.text === 'string' ? content.text : typeof content.caption === 'string' ? content.caption : '[mídia]';
  return { content, preview, docType: toMessageDocType(blockType) };
}

/** Snapshot the resolved audience into CampaignRecipient rows and flip the campaign to scheduled/sending. */
export async function launchCampaign(campaignId: string, workspaceId: string): Promise<ICampaign | null> {
  const campaign = await Campaign.findOne({ _id: campaignId, workspaceId });
  if (!campaign) return null;
  if (!['draft', 'paused'].includes(campaign.status)) return campaign;

  // Only snapshot recipients the first time (draft → launch). Resuming from pause reuses existing rows.
  if (campaign.status === 'draft') {
    let contacts = await resolveAudience(workspaceId, campaign.audience);
    const usesOfficialChannel = await Instance.exists({ _id: { $in: campaign.instanceIds }, channel: 'cloud_api' });
    if (usesOfficialChannel) contacts = contacts.filter((contact) => Boolean(contact.whatsappOptInAt));
    if (contacts.length === 0) {
      throw new Error(usesOfficialChannel
        ? 'Nenhum contato elegível com consentimento de marketing registrado para a API Oficial'
        : 'Nenhum contato elegível para esse público');
    }
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
  // ensureSession (not getSession) — a restart/reload drops the in-memory session
  // map even though Instance.status in Mongo still reads 'connected', so a plain
  // getSession() here always threw "Sessão não está pronta" for anyone testing
  // right after a deploy, indistinguishable from an actually-broken connection.
  // Same fix as every other send path (messages.routes.ts).
  const session = await sessionManager.ensureSession(instance._id.toString());
  if (!(await session.waitUntilReady(8000))) throw new Error('WhatsApp reconectando. Tente novamente em alguns segundos.');

  const ctx: FlowContext = { variables: {}, contact: { name: 'Você (teste)', phone } };
  const node = { id: 'campaign-test', blockType: campaign.message.blockType, config: campaign.message.config } as unknown as IFlowNode;
  const outbound = await buildOutboundMessage(node, ctx, campaign.workspaceId.toString());
  if (!outbound) throw new Error('Mensagem inválida — confira o conteúdo configurado');
  if (campaign.includeOptOutFooter && outbound.kind !== 'template') appendOptOutFooter(outbound);
  await session.sendMessage(jid, outbound);
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

  // Atomic claim: findOne+later-save left a window (Contact/Instance lookups,
  // capacity counts, checkOnWhatsApp — several awaits) where the SAME recipient
  // was still 'pending' and could be picked up again by an overlapping tick,
  // double-sending the campaign message to that contact. Flipping to 'sending'
  // right at the read makes the claim itself atomic.
  const recipient = await CampaignRecipient.findOneAndUpdate(
    { campaignId: campaign._id, status: 'pending' },
    { $set: { status: 'sending' } },
    { sort: { createdAt: 1 }, new: true }
  );
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
  // Any 'no_capacity' return below must release the atomic claim above back to
  // 'pending' — otherwise the recipient is stuck on 'sending' forever (it was
  // only supposed to be a transient marker while we located a send slot).
  const releaseClaim = () => CampaignRecipient.updateOne({ _id: recipient._id }, { $set: { status: 'pending' } });

  const instances = await Instance.find({ _id: { $in: campaign.instanceIds }, status: 'connected' }).lean();
  if (!instances.length) { await releaseClaim(); return 'no_capacity'; }
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
  if (!chosen) { await releaseClaim(); return 'no_capacity'; }

  // ensureSession (not getSession) — an Instance can read status:'connected' in
  // Mongo while its in-memory session was dropped by a restart/reload (see
  // SessionManager.ensureSession's own comment). A plain getSession() here made
  // a launched campaign stall at 0% forever, retried silently as 'no_capacity'
  // every tick with nothing ever surfaced to the workspace owner.
  const session = await sessionManager.ensureSession(chosen._id.toString());
  if (!(await session.waitUntilReady(8000))) {
    await releaseClaim();
    // Only alert once per 15 minutes per campaign — the dispatcher retries every
    // ~12s (3 ticks) while stalled, and without this dedup that's ~75 notifications/hour.
    const alertedRecently = campaign.sessionAlertedAt && Date.now() - campaign.sessionAlertedAt.getTime() < 15 * 60_000;
    if (!alertedRecently) {
      await Campaign.updateOne({ _id: campaign._id }, { $set: { sessionAlertedAt: new Date() } });
      void notifyWorkspaceOwner(gateway, campaign.workspaceId.toString(), {
        type: 'campaign.completed', title: 'Campanha travada — sessão não pronta',
        message: `"${campaign.name}" não consegue enviar: a conexão WhatsApp está reconectando. Verifique a instância em Instâncias.`,
        link: `/campaigns/${campaign._id.toString()}`, metadata: { campaignId: campaign._id.toString() },
      });
    }
    return 'no_capacity';
  }

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

  // status is already 'sending' from the atomic claim above.
  recipient.instanceId = chosen._id as unknown as Types.ObjectId;
  await recipient.save();
  await Campaign.updateOne({ _id: campaign._id }, { $set: { lastInstanceIndex: nextIndex } });

  try {
    const ctx: FlowContext = { variables: {}, contact: { name: contact.name, phone: contact.phone, email: contact.email } };
    const node = { id: 'campaign', blockType: campaign.message.blockType, config: campaign.message.config } as unknown as IFlowNode;
    const outbound = await buildOutboundMessage(node, ctx, campaign.workspaceId.toString());
    if (!outbound) throw new Error('Mensagem inválida — confira o conteúdo configurado');
    if (campaign.includeOptOutFooter && outbound.kind !== 'template') appendOptOutFooter(outbound);

    const sent = await session.sendMessage(recipient.jid, outbound);
    const messageId = sent.providerMessageId ?? `campaign-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Find-or-create the conversation so this shows up like any normal outbound message.
    let conversation = await Conversation.findOne({ workspaceId: campaign.workspaceId, instanceId: chosen._id, jid: recipient.jid });
    if (!conversation) {
      conversation = await Conversation.create({
        workspaceId: campaign.workspaceId, name: contact.name, phone: contact.phone, jid: recipient.jid,
        status: 'open', isGroup: false, unreadCount: 0, contactId: contact._id, instanceId: chosen._id,
      });
    }
    const now = new Date();
    const { content, preview, docType } = await toStoredContent(outbound, campaign.message.blockType, campaign.workspaceId, chosen._id);
    const savedMessage = await Message.create({
      workspaceId: campaign.workspaceId, instanceId: chosen._id, conversationId: conversation._id,
      jid: recipient.jid, messageId, direction: 'outbound', type: docType,
      status: 'sent', fromMe: true, content,
    });
    await Conversation.updateOne({ _id: conversation._id }, { $set: { lastMessage: { content: preview, type: docType, direction: 'outbound', timestamp: now } } });

    gateway.broadcastToConversationVisibility(
      campaign.workspaceId.toString(),
      conversation.assignedAgentId?.toString(),
      'message:new',
      {
        conversationId: conversation._id.toString(),
        message: {
          id: savedMessage._id.toString(),
          conversationId: conversation._id.toString(),
          type: savedMessage.type,
          content: savedMessage.content,
          direction: savedMessage.direction,
          status: savedMessage.status,
          timestamp: savedMessage.createdAt.toISOString(),
        },
      }
    );

    // Tag the contact with the campaign so future audiences can include/exclude "already reached".
    await Contact.updateOne({ _id: contact._id }, { $addToSet: { tags: `campanha:${campaign.name}` } });

    // Cost — only meaningful for a Cloud API template send; this is the
    // platform's own rate-card estimate for THIS specific send (real category
    // + real destination country), not Meta's actual bill (see rate-lookup.ts
    // / pricing.service.ts for why no live quote exists). Recorded post-send
    // so only sends that actually went out ever count toward the total.
    let costCents: number | undefined;
    let costCurrency: string | undefined;
    if (campaign.message.blockType === 'message.template') {
      const cfg = campaign.message.config as { templateName?: string; language?: string };
      const template = cfg.templateName && cfg.language
        ? await WhatsAppTemplate.findOne({ workspaceId: campaign.workspaceId, instanceId: chosen._id, name: cfg.templateName, language: cfg.language }).select('category').lean()
        : null;
      const rate = template ? await findRateForSend(contact.phone, template.category) : null;
      if (rate) { costCents = rate.priceCents; costCurrency = rate.currency; }
    }

    recipient.status = 'sent';
    recipient.messageId = messageId;
    recipient.conversationId = conversation._id as unknown as Types.ObjectId;
    recipient.sentAt = now;
    if (costCents !== undefined) { recipient.estimatedCostCents = costCents; recipient.estimatedCostCurrency = costCurrency; }
    await recipient.save();
    await Campaign.updateOne(
      { _id: campaign._id },
      {
        $inc: { 'stats.sent': 1, 'stats.pending': -1, ...(costCents ? { 'stats.estimatedCostCents': costCents } : {}) },
        $set: { consecutiveFailures: 0, ...(costCurrency ? { estimatedCostCurrency: costCurrency } : {}) },
      }
    );
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
