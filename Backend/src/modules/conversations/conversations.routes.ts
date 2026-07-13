import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Conversation, Message, Contact, Instance } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import type { WebSocketGateway } from '../../ws/gateway';
import { ensureLabel } from '../labels/labels.service';
import { cancelFlowRuns } from '../../flow-executor';
import { notify } from '../notifications/notification.service';
import { getAutoRouteMode, routeConversation } from '../routing/routing.service';
import { clearSlaTimers } from '../routing/sla.service';
import { emitWebhookEvent } from '../webhooks/webhook.service';

// Transform MongoDB conversation doc to API response format
function toConversationResponse(doc: any) {
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
    } : undefined,
    chatMetadata: doc.chatMetadata,
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

  // POST /api/conversations (create new conversation)
  fastify.post('/', auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const { phone, name, message } = request.body as { phone: string; name?: string; message?: string };

      if (!phone) return reply.status(400).send({ error: 'Phone is required' });

      const cleanPhone = phone.replace(/\D/g, '');
      if (!cleanPhone) return reply.status(400).send({ error: 'Invalid phone number' });

      const jid = `${cleanPhone}@s.whatsapp.net`;

      // Check if conversation already exists
      const existing = await Conversation.findOne({ workspaceId: new Types.ObjectId(workspaceId), jid });
      if (existing) return reply.status(409).send({ error: 'Conversation already exists' });

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

      // Find the active Baileys session for this workspace
      const activeInstance = await Instance.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        status: 'connected',
      });
      const session = activeInstance ? opts.sessionManager.getSession(activeInstance._id.toString()) : null;

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

        if (session) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sent = await (session.sendMessage as (jid: string, content: unknown) => Promise<any>)(jid, { text: message });
            if (sent?.key?.id) messageId = sent.key.id;
          } catch (sendErr) {
            fastify.log.warn({ sendErr, jid }, 'Failed to send initial message via WhatsApp');
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
          status: 'sent',
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
    const { status, assignedTo, assigneeId, tag, page = '1', limit = '20', search, teamGroupId, attendanceMode, isGroup, showBlocked, hasUnread, slaBreached } = request.query as Record<string, string>;

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
    if (search) filter.name = { $regex: search, $options: 'i' };
    if (teamGroupId && Types.ObjectId.isValid(teamGroupId)) filter.teamGroupId = new Types.ObjectId(teamGroupId);
    if (attendanceMode && ['bot', 'human', 'idle'].includes(attendanceMode)) filter.attendanceMode = attendanceMode;
    if (isGroup === 'true') filter.isGroup = true;
    else if (isGroup === 'false') filter.isGroup = false;
    if (hasUnread === 'true') filter.unreadCount = { $gt: 0 };

    // $or is used by both the SLA filter and the role-visibility rule below —
    // collect each as its own clause under $and instead of overwriting one another.
    const andConditions: Record<string, unknown>[] = [];
    if (slaBreached === 'true') andConditions.push({ $or: [{ slaFirstResponseBreached: true }, { slaResolutionBreached: true }] });

    // showBlocked: filter conversations where the associated contact is blocked
    if (showBlocked === 'true') {
      const blockedContacts = await Contact.find({ workspaceId, status: 'blocked' }, { _id: 1 }).lean();
      filter.contactId = { $in: blockedContacts.map((c) => c._id) };
    }

    // Multi-attendance visibility: agents/viewers only see conversations assigned to
    // them or still unassigned (the queue). Owners/admins see everything.
    if ((role === 'agent' || role === 'viewer') && !filter.assignedAgentId) {
      andConditions.push({ $or: [{ assignedAgentId: sub }, { assignedAgentId: null }, { assignedAgentId: { $exists: false } }] });
    }
    if (andConditions.length) filter.$and = andConditions;

    const skip = (Number(page) - 1) * Number(limit);
    const [convDocs, total] = await Promise.all([
      Conversation.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(Number(limit)).populate('assignedAgentId', 'name avatarUrl').populate('teamGroupId', 'name emoji color'),
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
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)), hasNextPage: skip + data.length < total },
    });
  });

  // GET /api/conversations/:id
  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const conv = await Conversation.findOne({ _id: id, workspaceId }).populate('assignedAgentId', 'name avatarUrl');
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    return reply.send(toConversationResponse(conv));
  });

  // PATCH /api/conversations/:id
  fastify.patch('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const updates = request.body as Record<string, unknown>;

    const allowed = ['status', 'assignedAgentId', 'tags', 'snoozedUntil'];
    const safeUpdates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in updates) safeUpdates[key] = updates[key];
    }

    // Finishing the attendance frees the ticket: clear the agent so a returning
    // contact is re-triaged and the catch-all flow becomes eligible again.
    const isFinishing = typeof safeUpdates.status === 'string' && ['resolved', 'closed'].includes(safeUpdates.status);
    if (isFinishing) safeUpdates.assignedAgentId = null;

    const conv = await Conversation.findOneAndUpdate({ _id: id, workspaceId }, safeUpdates, { new: true });
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    if (isFinishing) {
      await cancelFlowRuns(id); await clearSlaTimers(id);
      void emitWebhookEvent(workspaceId, 'conversation.resolved', { conversationId: id, name: conv.name, phone: conv.phone });
    }
    return reply.send(toConversationResponse(conv));
  });

  // POST /api/conversations/:id/resolve
  fastify.post('/:id/resolve', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    // Finishing frees the ticket: clear the agent so a returning contact is
    // re-triaged (and the catch-all flow becomes eligible again).
    const conv = await Conversation.findOneAndUpdate(
      { _id: id, workspaceId },
      { status: 'resolved', unreadCount: 0, assignedAgentId: null },
      { new: true }
    );
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    // Finishing the attendance ends any active flow run so a future interaction re-triggers.
    await cancelFlowRuns(id);
    await clearSlaTimers(id);
    void emitWebhookEvent(workspaceId, 'conversation.resolved', { conversationId: id, name: conv.name, phone: conv.phone });
    return reply.send(toConversationResponse(conv));
  });

  // POST /api/conversations/:id/mute — agent-side mute (null = muted forever, unset = not muted)
  fastify.post('/:id/mute', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { muted } = request.body as { muted: boolean };
    const update = muted
      ? { $set: { 'chatMetadata.muteExpiredAt': null } }
      : { $unset: { 'chatMetadata.muteExpiredAt': 1 } };
    const conv = await Conversation.findOneAndUpdate({ _id: id, workspaceId }, update, { new: true });
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    return reply.send(toConversationResponse(conv));
  });

  // POST /api/conversations/:id/assign
  fastify.post('/:id/assign', auth, async (request, reply) => {
    const { workspaceId, sub: actorId } = request.user as { workspaceId: string; sub: string };
    const { id } = request.params as { id: string };
    const { agentId } = request.body as { agentId: string };
    const valid = agentId && Types.ObjectId.isValid(agentId) ? new Types.ObjectId(agentId) : null;
    const before = await Conversation.findOne({ _id: id, workspaceId }).select('assignedAgentId');
    const conv = await Conversation.findOneAndUpdate({ _id: id, workspaceId }, { assignedAgentId: valid }, { new: true })
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
  fastify.patch('/:id/assign-team', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { teamGroupId } = request.body as { teamGroupId: string | null };
    if (!Types.ObjectId.isValid(id)) return reply.status(404).send({ error: 'Conversa não encontrada' });
    const update = teamGroupId && Types.ObjectId.isValid(teamGroupId)
      ? { teamGroupId: new Types.ObjectId(teamGroupId) }
      : { teamGroupId: null };
    const conv = await Conversation.findOneAndUpdate(
      { _id: id, workspaceId: new Types.ObjectId(workspaceId) },
      { $set: update },
      { new: true }
    ).populate('assignedAgentId', 'name avatarUrl').populate('teamGroupId', 'name emoji color');
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    return reply.send({ data: toConversationResponse(conv) });
  });

  // PATCH /api/conversations/:id/attendance-mode
  fastify.patch('/:id/attendance-mode', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { mode } = request.body as { mode: 'bot' | 'human' | 'idle' };
    if (!['bot', 'human', 'idle'].includes(mode)) return reply.status(400).send({ error: 'Modo inválido' });
    if (!Types.ObjectId.isValid(id)) return reply.status(404).send({ error: 'Conversa não encontrada' });
    const conv = await Conversation.findOneAndUpdate(
      { _id: id, workspaceId: new Types.ObjectId(workspaceId) },
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
  fastify.post('/:id/read', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    // timestamps: false — marking as read must not bump updatedAt, which drives
    // the conversation list sort order; otherwise opening a conversation jumps
    // it to the top of the inbox even with no new activity.
    await Conversation.updateOne({ _id: id, workspaceId }, { unreadCount: 0 }, { timestamps: false });
    return reply.send({ ok: true });
  });

  // POST /api/conversations/:id/tags  — add a label (auto-creates it in the catalog)
  fastify.post('/:id/tags', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { tag } = request.body as { tag?: string };

    const trimmed = (tag ?? '').trim();
    if (!trimmed) return reply.status(400).send({ error: 'Etiqueta é obrigatória' });

    await ensureLabel(workspaceId, trimmed);
    const conv = await Conversation.findOneAndUpdate(
      { _id: id, workspaceId },
      { $addToSet: { tags: trimmed } },
      { new: true }
    );
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    return reply.send(toConversationResponse(conv));
  });

  // DELETE /api/conversations/:id/tags/:tag  — remove a label from this conversation
  fastify.delete('/:id/tags/:tag', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id, tag } = request.params as { id: string; tag: string };

    const conv = await Conversation.findOneAndUpdate(
      { _id: id, workspaceId },
      { $pull: { tags: decodeURIComponent(tag) } },
      { new: true }
    );
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    return reply.send(toConversationResponse(conv));
  });

  // DELETE /api/conversations/:id
  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const conv = await Conversation.findOneAndDelete({ _id: id, workspaceId });
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });
    // Remove all messages belonging to this conversation
    await Message.deleteMany({ conversationId: id });
    await cancelFlowRuns(id);
    return reply.status(204).send();
  });
}
