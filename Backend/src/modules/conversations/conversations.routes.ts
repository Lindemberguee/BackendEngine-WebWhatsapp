import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { parsePagination } from '../../utils/pagination';
import { Conversation, Message, Contact, Instance, Lead, ScheduledMessage, User, Notification } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import type { WebSocketGateway } from '../../ws/gateway';
import { ensureLabel } from '../labels/labels.service';
import { cancelFlowRuns } from '../../flow-executor';
import { notify } from '../notifications/notification.service';
import { getAutoRouteMode, routeConversation } from '../routing/routing.service';
import { clearSlaTimers } from '../routing/sla.service';
import { emitWebhookEvent } from '../webhooks/webhook.service';
import { scopeConversationFilter } from '../../utils/conversation-visibility';
import { escapeRegex } from '../../shared/string-utils';
import { requireRole } from '../../utils/require-role';
import { decryptSecret } from '../../shared/crypto';
import { markCloudApiMessageRead } from '../../channels/cloud-api/graph-client';

/** Any scheduled ("send later") message for this conversation is pointless
 *  once it's resolved/closed/archived — cancel proactively instead of
 *  waiting for the dispatcher's own per-tick status check to catch it. */
function cancelScheduledMessages(conversationId: string): void {
  void ScheduledMessage.updateMany(
    { conversationId, status: 'scheduled' },
    { $set: { status: 'cancelled', failureReason: 'Conversa encerrada/arquivada' } }
  ).catch(() => {});
}

// Transform MongoDB conversation doc to API response format
function toConversationResponse(doc: any, extra?: { instanceChannel?: string }) {
  const name = doc.name || doc.phone || 'Unknown';
  const phone = doc.phone || '';

  return {
    id: doc._id?.toString() || doc.id,
    name,
    phone,
    jid: doc.jid,
    status: doc.status || 'open',
    isGroup: doc.isGroup || false,
    unreadCount: doc.unreadCount || 0,
    tags: doc.tags || [],
    avatarUrl: doc.avatarUrl,
    contactId: doc.contactId?.toString(),
    lastMessage: doc.lastMessage ? {
      content: doc.lastMessage.content,
      type: doc.lastMessage.type,
      direction: doc.lastMessage.direction,
      timestamp: doc.lastMessage.timestamp,
      senderName: doc.lastMessage.senderName,
    } : undefined,
    // Timestamp of the last message FROM the contact — the Cloud API 24h
    // free-form window is measured from this, not from lastMessage.timestamp
    // (which also advances on our own outbound sends).
    lastInboundAt: doc.lastInboundAt?.toISOString(),
    // Which channel this conversation's linked instance sends through — only
    // populated on the single-conversation GET (see route below); undefined
    // elsewhere means "unknown/assume baileys" to the frontend, not "official".
    instanceChannel: extra?.instanceChannel,
    instanceId: doc.instanceId?.toString(),
    chatMetadata: doc.chatMetadata,
    snoozedUntil: doc.snoozedUntil?.toISOString(),
    channel: 'whatsapp',
    allowBotInGroups: doc.allowBotInGroups ?? false,
    // Assignee: populated user → { id, name }; raw ObjectId → { id } only.
    assignee: doc.assignedAgentId
      ? (typeof doc.assignedAgentId === 'object' && doc.assignedAgentId.name
          ? { id: doc.assignedAgentId._id.toString(), name: doc.assignedAgentId.name, avatarUrl: doc.assignedAgentId.avatarUrl }
          : { id: doc.assignedAgentId.toString() })
      : undefined,
    contactStatus: (doc as any)._contactStatus ?? undefined,
    // Team group: populated or raw ObjectId
    teamGroup: doc.teamGroupId
      ? (typeof doc.teamGroupId === 'object' && doc.teamGroupId.name
          ? { id: doc.teamGroupId._id.toString(), name: doc.teamGroupId.name, emoji: doc.teamGroupId.emoji ?? null, color: doc.teamGroupId.color ?? null }
          : { id: doc.teamGroupId.toString(), name: '', emoji: null, color: null })
      : undefined,
    attendanceMode: doc.attendanceMode ?? 'idle',
    attendanceModeChangedAt: doc.attendanceModeChangedAt?.toISOString(),
    routedAt: doc.routedAt?.toISOString(),
    sla: {
      firstResponseDueAt: doc.firstResponseDueAt?.toISOString(),
      firstRespondedAt: doc.firstRespondedAt?.toISOString(),
      resolutionDueAt: doc.resolutionDueAt?.toISOString(),
      firstResponseBreached: doc.slaFirstResponseBreached ?? false,
      resolutionBreached: doc.slaResolutionBreached ?? false,
    },
    closeReasonId: doc.closeReasonId?.toString(),
    resolvedAt: doc.resolvedAt?.toISOString(),
    createdAt: doc.createdAt?.toISOString() || new Date().toISOString(),
    updatedAt: doc.updatedAt?.toISOString() || new Date().toISOString(),
    contact: {
      id: doc.contactId?.toString() || doc._id?.toString() || doc.id,
      name,
      phone,
    },
  };
}

export async function conversationsRoutes(fastify: FastifyInstance, opts: { sessionManager: SessionManager; wsGateway: WebSocketGateway }): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };
  // A viewer can look at the inbox but must not be able to send WhatsApp messages,
  // reassign/resolve tickets, or otherwise mutate conversation state — mirrors the
  // read-only/write/delete split already established in contacts.routes.ts.
  const canWrite = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin', 'agent'])] };
  const canDelete = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin'])] };

  // POST /api/conversations (create new conversation)
  fastify.post('/', canWrite, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const { phone, name, message } = request.body as { phone: string; name?: string; message?: string };

      if (!phone) return reply.status(400).send({ error: 'Phone is required' });

      const cleanPhone = phone.replace(/\D/g, '');
      if (!cleanPhone) return reply.status(400).send({ error: 'Invalid phone number' });

      const jid = `${cleanPhone}@s.whatsapp.net`;

      // Upsert Contact so the conversation has a proper contactId
      const contact = await Contact.findOneAndUpdate(
        { workspaceId: new Types.ObjectId(workspaceId), jid },
        {
          $setOnInsert: {
            workspaceId: new Types.ObjectId(workspaceId),
            jid,
            phone: cleanPhone,
            source: 'manual',
          },
          $set: { name: name || cleanPhone },
        },
        { upsert: true, new: true }
      );

      // Find the active Baileys session for this workspace — sorted so a workspace
      // with more than one connected number picks the same one deterministically
      // instead of whichever Mongo happens to return first.
      const activeInstance = await Instance.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        status: 'connected',
      }).sort({ channel: 1, lastConnectedAt: -1 }); // Prefer Baileys for an untemplated first contact.
      const session = activeInstance ? opts.sessionManager.getSession(activeInstance._id.toString()) : null;

      const existing = await Conversation.findOne({
        workspaceId: new Types.ObjectId(workspaceId), jid,
        ...(activeInstance ? { instanceId: activeInstance._id } : { instanceId: { $exists: false } }),
      });
      if (existing) return reply.status(409).send({ error: 'Conversation already exists for this number' });

      // Create conversation linked to the contact (and instance if available)
      const conversation = await Conversation.create({
        workspaceId: new Types.ObjectId(workspaceId),
        name: name || cleanPhone,
        phone: cleanPhone,
        jid,
        status: 'open',
        isGroup: false,
        unreadCount: 0,
        contactId: contact._id,
        ...(activeInstance ? { instanceId: activeInstance._id } : {}),
      });

      // If message provided: send via WhatsApp (if session exists) and persist
      if (message?.trim()) {
        const now = new Date();
        let messageId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        // Previously always recorded as 'sent' regardless of outcome — the agent saw
        // a message that looked delivered even when there was no session at all, or
        // the send itself failed. Track what actually happened.
        let sendFailed = !session;

        if (session) {
          try {
            if (session.channel === 'baileys' && session.sendRaw) {
              const sent = await session.sendRaw(jid, { text: message }) as { key?: { id?: string } } | undefined;
              if (sent?.key?.id) messageId = sent.key.id;
            } else {
              const sent = await session.sendMessage(jid, { kind: 'text', text: message });
              if (sent.providerMessageId) messageId = sent.providerMessageId;
            }
          } catch (sendErr) {
            fastify.log.warn({ sendErr, jid }, 'Failed to send initial message via WhatsApp');
            sendFailed = true;
          }
        }

        await Message.create({
          workspaceId: new Types.ObjectId(workspaceId),
          instanceId: activeInstance?._id,
          conversationId: conversation._id,
          jid,
          messageId,
          direction: 'outbound',
          type: 'text',
          status: sendFailed ? 'failed' : 'sent',
          fromMe: true,
          content: { text: message },
        });
        await Conversation.updateOne(
          { _id: conversation._id },
          { $set: { lastMessage: { content: message, type: 'text', direction: 'outbound', timestamp: now } } }
        );
        conversation.lastMessage = { content: message, type: 'text', direction: 'outbound', timestamp: now };
      }

      return reply.status(201).send(toConversationResponse(conversation));
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/conversations
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { status, assignedTo, assigneeId, tag, search, teamGroupId, attendanceMode, isGroup, showBlocked, hasUnread, slaBreached, hasLead, archived } = request.query as Record<string, string>;
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);

    // Lazy snooze expiry: reopen conversations whose snooze window has passed.
    await Conversation.updateMany(
      { workspaceId, status: 'snoozed', snoozedUntil: { $lte: new Date() } },
      { $set: { status: 'open' }, $unset: { snoozedUntil: 1 } }
    );

    const filter: Record<string, unknown> = { workspaceId };
    if (status && status !== 'all') filter.status = status;
    if (tag) filter.tags = tag;
    if (assignedTo === 'me' || assigneeId === 'me') {
      filter.assignedAgentId = sub;
    } else if (assigneeId) {
      filter.assignedAgentId = assigneeId;
    }
    if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };
    if (teamGroupId && Types.ObjectId.isValid(teamGroupId)) filter.teamGroupId = new Types.ObjectId(teamGroupId);
    if (attendanceMode && ['bot', 'human', 'idle'].includes(attendanceMode)) filter.attendanceMode = attendanceMode;
    if (isGroup === 'true') filter.isGroup = true;
    else if (isGroup === 'false') filter.isGroup = false;
    if (hasUnread === 'true') filter.unreadCount = { $gt: 0 };
    // Archived conversations are hidden from every default view (like WhatsApp's own
    // archive) unless the caller explicitly asks for the "Arquivadas" tab.
    filter['chatMetadata.archived'] = archived === 'true' ? true : { $ne: true };

    // $or is used by both the SLA filter and the role-visibility rule below —
    // collect each as its own clause under $and instead of overwriting one another.
    const andConditions: Record<string, unknown>[] = [];
    if (slaBreached === 'true') andConditions.push({ $or: [{ slaFirstResponseBreached: true }, { slaResolutionBreached: true }] });

    // showBlocked: filter conversations where the associated contact is blocked
    if (showBlocked === 'true') {
      const blockedContacts = await Contact.find({ workspaceId, status: 'blocked' }, { _id: 1 }).lean();
      filter.contactId = { $in: blockedContacts.map((c) => c._id) };
    }

    // hasLead: only conversations with a CRM opportunity linked to them
    if (hasLead === 'true') {
      const leadConvIds = await Lead.find({ workspaceId, conversationId: { $ne: null } }, { conversationId: 1 }).lean();
      filter._id = { $in: leadConvIds.map((l) => l.conversationId) };
    }

    // Multi-attendance visibility: agents/viewers only see conversations assigned to
    // them or still unassigned (the queue). Owners/admins see everything.
    //
    // Always applied — not skipped when `filter.assignedAgentId` is already set — since
    // that field is attacker-controlled via ?assigneeId=<other agent's id>. Previously an
    // explicit assigneeId bypassed this check entirely, letting any agent list another
    // agent's whole queue. Combined with the top-level `filter.assignedAgentId` equality
    // (also from assigneeId), an agent/viewer requesting someone else's id now correctly
    // yields zero results instead of a full list.
    if (role === 'agent' || role === 'viewer') {
      andConditions.push({ $or: [{ assignedAgentId: sub }, { assignedAgentId: null }, { assignedAgentId: { $exists: false } }] });
    }
    if (andConditions.length) filter.$and = andConditions;

    const [convDocs, total] = await Promise.all([
      Conversation.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate('assignedAgentId', 'name avatarUrl').populate('teamGroupId', 'name emoji color'),
      Conversation.countDocuments(filter),
    ]);

    // Batch-fetch contact info (avatarUrl + status) for all conversations
    const contactIds = convDocs.filter(c => c.contactId).map(c => c.contactId!);
    let contactInfoMap = new Map<string, { avatarUrl?: string; status?: string }>();
    if (contactIds.length > 0) {
      const contacts = await Contact.find({ _id: { $in: contactIds } }, { avatarUrl: 1, status: 1 }).lean();
      contactInfoMap = new Map(contacts.map(c => [c._id.toString(), { avatarUrl: c.avatarUrl, status: c.status as string | undefined }]));
    }

    const data = convDocs.map(doc => {
      const d = doc as typeof doc & { _contactStatus?: string };
      if (doc.contactId) {
        const info = contactInfoMap.get(doc.contactId.toString());
        if (info?.status) d._contactStatus = info.status;
      }
      const res = toConversationResponse(d);
      if (!res.avatarUrl && doc.contactId) {
        const info = contactInfoMap.get(doc.contactId.toString());
        if (info?.avatarUrl) res.avatarUrl = info.avatarUrl;
      }
      return res;
    });

    return reply.send({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasNextPage: skip + data.length < total },
    });
  });

  // GET /api/conversations/:id
  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    const conv = await Conversation.findOne(scopeConversationFilter({ _id: id, workspaceId }, { role, sub })).populate('assignedAgentId', 'name avatarUrl');
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    let instanceChannel: string | undefined;
    if (conv.instanceId) {
      const inst = await Instance.findById(conv.instanceId).select('channel').lean();
      instanceChannel = inst?.channel ?? 'baileys';
    }
    return reply.send(toConversationResponse(conv, { instanceChannel }));
  });

  // PATCH /api/conversations/:id
  fastify.patch('/:id', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    const updates = request.body as Record<string, unknown>;

    const allowed = ['status', 'assignedAgentId', 'tags', 'snoozedUntil', 'allowBotInGroups', 'closeReasonId'];
    const safeUpdates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in updates) safeUpdates[key] = updates[key];
    }

    // Same guard as POST /:id/assign — an id that doesn't resolve to a workspace
    // member would otherwise silently make the conversation invisible to everyone.
    if (safeUpdates.assignedAgentId) {
      const agentId = safeUpdates.assignedAgentId;
      if (typeof agentId !== 'string' || !Types.ObjectId.isValid(agentId)) {
        return reply.status(400).send({ error: 'assignedAgentId inválido' });
      }
      const targetUser = await User.exists({ _id: agentId, workspaceId });
      if (!targetUser) return reply.status(400).send({ error: 'Usuário inválido para este workspace' });
    }

    // Finishing the attendance frees the ticket: clear the agent so a returning
    // contact is re-triaged and the catch-all flow becomes eligible again.
    const isFinishing = typeof safeUpdates.status === 'string' && ['resolved', 'closed'].includes(safeUpdates.status);
    if (isFinishing) { safeUpdates.assignedAgentId = null; safeUpdates.resolvedAt = new Date(); }

    let conv;
    try {
      conv = await Conversation.findOneAndUpdate(scopeConversationFilter({ _id: id, workspaceId }, { role, sub }), safeUpdates, { new: true, runValidators: true });
    } catch (err) {
      if ((err as { name?: string }).name === 'ValidationError') return reply.status(400).send({ error: 'Dados inválidos' });
      throw err;
    }
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    if (isFinishing) {
      await cancelFlowRuns(id); await clearSlaTimers(id);
      cancelScheduledMessages(id);
      void emitWebhookEvent(workspaceId, 'conversation.resolved', { conversationId: id, name: conv.name, phone: conv.phone });
    }
    return reply.send(toConversationResponse(conv));
  });

  // POST /api/conversations/:id/resolve
  fastify.post('/:id/resolve', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    const { closeReasonId } = (request.body as { closeReasonId?: string } | undefined) ?? {};
    // Finishing frees the ticket: clear the agent so a returning contact is
    // re-triaged (and the catch-all flow becomes eligible again).
    const conv = await Conversation.findOneAndUpdate(
      scopeConversationFilter({ _id: id, workspaceId }, { role, sub }),
      { status: 'resolved', unreadCount: 0, assignedAgentId: null, resolvedAt: new Date(), ...(closeReasonId ? { closeReasonId } : {}) },
      { new: true }
    );
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    // Finishing the attendance ends any active flow run so a future interaction re-triggers.
    await cancelFlowRuns(id);
    await clearSlaTimers(id);
    cancelScheduledMessages(id);
    void emitWebhookEvent(workspaceId, 'conversation.resolved', { conversationId: id, name: conv.name, phone: conv.phone });
    return reply.send(toConversationResponse(conv));
  });

  // POST /api/conversations/:id/mute — agent-side mute (null = muted forever, unset = not muted)
  fastify.post('/:id/mute', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    const { muted } = request.body as { muted: boolean };
    const update = muted
      ? { $set: { 'chatMetadata.muteExpiredAt': null } }
      : { $unset: { 'chatMetadata.muteExpiredAt': 1 } };
    const conv = await Conversation.findOneAndUpdate(scopeConversationFilter({ _id: id, workspaceId }, { role, sub }), update, { new: true });
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    return reply.send(toConversationResponse(conv));
  });

  // POST /api/conversations/:id/assign
  fastify.post('/:id/assign', canWrite, async (request, reply) => {
    const { workspaceId, sub: actorId, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    const { agentId } = request.body as { agentId: string };
    let valid: Types.ObjectId | null = null;
    if (agentId && Types.ObjectId.isValid(agentId)) {
      // A bogus/foreign-workspace id would still "assign" successfully but make the
      // conversation match nobody's visibility filter — invisible to every agent,
      // including whoever it was meant for.
      const targetUser = await User.exists({ _id: agentId, workspaceId });
      if (!targetUser) return reply.status(400).send({ error: 'Usuário inválido para este workspace' });
      valid = new Types.ObjectId(agentId);
    }
    const visibilityFilter = scopeConversationFilter({ _id: id, workspaceId }, { role, sub: actorId });
    const before = await Conversation.findOne(visibilityFilter).select('assignedAgentId');
    const conv = await Conversation.findOneAndUpdate(visibilityFilter, { assignedAgentId: valid }, { new: true })
      .populate('assignedAgentId', 'name avatarUrl');
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

    // Broadcast so every connected agent's inbox reflects the change immediately —
    // not just the newly-assigned agent (who also gets a personal notification below).
    const assignee = conv.assignedAgentId
      ? { id: (conv.assignedAgentId as unknown as { _id: { toString(): string } })._id.toString(), name: (conv.assignedAgentId as unknown as { name: string }).name, avatarUrl: (conv.assignedAgentId as unknown as { avatarUrl?: string }).avatarUrl }
      : null;
    opts.wsGateway.broadcastToWorkspace(workspaceId, 'conversation:assigned', { conversationId: id, assignee });

    if (valid && valid.toString() !== actorId) {
      const wasAssigned = !!before?.assignedAgentId;
      void notify(opts.wsGateway, {
        workspaceId, recipientId: valid.toString(),
        type: wasAssigned ? 'conversation.transferred' : 'conversation.assigned',
        title: wasAssigned ? 'Conversa transferida pra você' : 'Nova conversa atribuída a você',
        message: `${conv.name || conv.phone || 'Um contato'} — ${wasAssigned ? 'foi transferida pra você' : 'foi atribuída a você'}`,
        link: '/conversations',
        metadata: { conversationId: id },
      });
    }
    return reply.send(toConversationResponse(conv));
  });

  // PATCH /api/conversations/:id/assign-team
  fastify.patch('/:id/assign-team', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    const { teamGroupId } = request.body as { teamGroupId: string | null };
    if (!Types.ObjectId.isValid(id)) return reply.status(404).send({ error: 'Conversa não encontrada' });
    const update = teamGroupId && Types.ObjectId.isValid(teamGroupId)
      ? { teamGroupId: new Types.ObjectId(teamGroupId) }
      : { teamGroupId: null };
    const conv = await Conversation.findOneAndUpdate(
      scopeConversationFilter({ _id: id, workspaceId: new Types.ObjectId(workspaceId) }, { role, sub }),
      { $set: update },
      { new: true }
    ).populate('assignedAgentId', 'name avatarUrl').populate('teamGroupId', 'name emoji color');
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    return reply.send({ data: toConversationResponse(conv) });
  });

  // PATCH /api/conversations/:id/attendance-mode
  fastify.patch('/:id/attendance-mode', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    const { mode } = request.body as { mode: 'bot' | 'human' | 'idle' };
    if (!['bot', 'human', 'idle'].includes(mode)) return reply.status(400).send({ error: 'Modo inválido' });
    if (!Types.ObjectId.isValid(id)) return reply.status(404).send({ error: 'Conversa não encontrada' });
    const conv = await Conversation.findOneAndUpdate(
      scopeConversationFilter({ _id: id, workspaceId: new Types.ObjectId(workspaceId) }, { role, sub }),
      { $set: { attendanceMode: mode, attendanceModeChangedAt: new Date() } },
      { new: true }
    );
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

    // Manual handoff to a human is the same auto-routing trigger as a flow's handoff block.
    if (mode === 'human' && !conv.assignedAgentId) {
      const autoRoute = await getAutoRouteMode(workspaceId);
      if (autoRoute === 'on_human' || autoRoute === 'on_new') void routeConversation(id, opts.wsGateway);
    }
    return reply.send({ data: toConversationResponse(conv) });
  });

  // POST /api/conversations/:id/read
  fastify.post('/:id/read', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    // timestamps: false — marking as read must not bump updatedAt, which drives
    // the conversation list sort order; otherwise opening a conversation jumps
    // it to the top of the inbox even with no new activity.
    const conv = await Conversation.findOneAndUpdate(
      scopeConversationFilter({ _id: id, workspaceId }, { role, sub }),
      { unreadCount: 0 },
      { timestamps: false, new: true }
    );
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

    if (conv.instanceId) {
      const instance = await Instance.findById(conv.instanceId).select('channel cloudApi').lean();
      if (instance?.channel === 'cloud_api' && instance.cloudApi) {
        const unread = await Message.find({
          conversationId: conv._id, direction: 'inbound', providerReadAt: { $exists: false },
          createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        }).select('_id messageId').limit(100).lean();
        const creds = {
          phoneNumberId: instance.cloudApi.phoneNumberId,
          accessToken: decryptSecret(instance.cloudApi.accessTokenEnc),
          graphVersion: instance.cloudApi.graphVersion,
        };
        const results = await Promise.allSettled(unread.map((msg) => markCloudApiMessageRead(creds, msg.messageId)));
        const succeeded = unread.filter((_, index) => results[index]?.status === 'fulfilled').map((msg) => msg._id);
        if (succeeded.length) await Message.updateMany({ _id: { $in: succeeded } }, { $set: { providerReadAt: new Date() } });
      }
    }
    return reply.send({ ok: true });
  });

  // POST /api/conversations/:id/unread — mirror of /read, for the "mark as unread" header action
  fastify.post('/:id/unread', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    await Conversation.updateOne(scopeConversationFilter({ _id: id, workspaceId }, { role, sub }), { unreadCount: 1 }, { timestamps: false });
    return reply.send({ ok: true });
  });

  // POST /api/conversations/:id/archive — manual archive/unarchive (chatMetadata.archived
  // already existed and is displayed, but had no toggle endpoint — mirrors /mute's shape)
  fastify.post('/:id/archive', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    const { archived } = request.body as { archived: boolean };
    const update = archived
      ? { $set: { 'chatMetadata.archived': true, 'chatMetadata.archivedAt': new Date() } }
      : { $set: { 'chatMetadata.archived': false }, $unset: { 'chatMetadata.archivedAt': 1 } };
    const conv = await Conversation.findOneAndUpdate(scopeConversationFilter({ _id: id, workspaceId }, { role, sub }), update, { new: true });
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    if (archived) cancelScheduledMessages(id);
    return reply.send(toConversationResponse(conv));
  });

  // POST /api/conversations/:id/tags  — add a label (auto-creates it in the catalog)
  fastify.post('/:id/tags', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    const { tag } = request.body as { tag?: string };

    const trimmed = (tag ?? '').trim();
    if (!trimmed) return reply.status(400).send({ error: 'Etiqueta é obrigatória' });

    await ensureLabel(workspaceId, trimmed);
    const conv = await Conversation.findOneAndUpdate(
      scopeConversationFilter({ _id: id, workspaceId }, { role, sub }),
      { $addToSet: { tags: trimmed } },
      { new: true }
    );
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    return reply.send(toConversationResponse(conv));
  });

  // DELETE /api/conversations/:id/tags/:tag  — remove a label from this conversation
  fastify.delete('/:id/tags/:tag', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id, tag } = request.params as { id: string; tag: string };
    let decodedTag: string;
    try {
      decodedTag = decodeURIComponent(tag);
    } catch {
      return reply.status(400).send({ error: 'Tag inválida' });
    }

    const conv = await Conversation.findOneAndUpdate(
      scopeConversationFilter({ _id: id, workspaceId }, { role, sub }),
      { $pull: { tags: decodedTag } },
      { new: true }
    );
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    return reply.send(toConversationResponse(conv));
  });

  // DELETE /api/conversations/:id
  fastify.delete('/:id', canDelete, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { id } = request.params as { id: string };
    const conv = await Conversation.findOneAndDelete(scopeConversationFilter({ _id: id, workspaceId }, { role, sub }));
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    // Remove all messages belonging to this conversation
    await Message.deleteMany({ conversationId: id });
    await cancelFlowRuns(id);
    // Clean up everything else that pointed at this conversation — previously left
    // orphaned: CRM leads kept a dangling conversationId (surfacing in the hasLead
    // filter), pending scheduled sends stayed queued forever, and notification links
    // pointed at a 404. Best-effort — a delete already in progress shouldn't fail here.
    await Promise.all([
      Lead.updateMany({ workspaceId, conversationId: id }, { $unset: { conversationId: 1 } }).catch(() => {}),
      ScheduledMessage.updateMany({ workspaceId, conversationId: id, status: 'scheduled' }, { $set: { status: 'cancelled', failureReason: 'Conversa excluída' } }).catch(() => {}),
      Notification.deleteMany({ workspaceId, 'metadata.conversationId': id }).catch(() => {}),
    ]);
    return reply.status(204).send();
  });
}
