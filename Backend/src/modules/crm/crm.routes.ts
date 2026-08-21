/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Pipeline, Lead, Contact, LeadActivity } from '../../db/models';
import { DEFAULT_STAGES, ensureDefaultPipeline, toLeadResponse, nextOrder, logLeadActivity, getActorName, getCrmReport, getCrossPipelineReport } from './crm.service';
import { triggerCrmFlow } from './crm-triggers';
import { notify } from '../notifications/notification.service';
import { emitWebhookEvent } from '../webhooks/webhook.service';
import type { SessionManager } from '../../session-manager/SessionManager';
import type { WebSocketGateway } from '../../ws/gateway';
import { requireRole } from '../../utils/require-role';
import { assertCanCreatePipeline } from '../billing/billing.service';
import { escapeRegex } from '../../shared/string-utils';

const valid = (id: string) => Types.ObjectId.isValid(id);

export async function crmRoutes(fastify: FastifyInstance, opts: { sessionManager: SessionManager; wsGateway: WebSocketGateway }): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };
  const canWrite = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin', 'agent'])] };
  // Archiving a whole pipeline (and every lead in it) is a bigger blast radius
  // than everyday CRM writes — restrict it past the general canWrite gate.
  const canManagePipelines = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin'])] };

  // ─── Pipelines ──────────────────────────────────────────────────────────────

  fastify.get('/pipelines', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    await ensureDefaultPipeline(workspaceId);
    const pipelines = await Pipeline.find({ workspaceId, archived: { $ne: true } }).sort({ isDefault: -1, createdAt: 1 });
    return reply.send({ data: pipelines.map((p) => p.toJSON()) });
  });

  fastify.post('/pipelines', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const body = request.body as { name?: string; description?: string; stages?: any[]; customFieldDefs?: any[]; autoCreateFromConversation?: boolean };
    if (!body.name?.trim()) return reply.status(400).send({ error: 'Nome é obrigatório' });
    try {
      await assertCanCreatePipeline(workspaceId);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
    const stages = Array.isArray(body.stages) && body.stages.length ? body.stages : DEFAULT_STAGES;
    const p = await Pipeline.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name: body.name.trim(),
      description: body.description,
      stages,
      customFieldDefs: Array.isArray(body.customFieldDefs) ? body.customFieldDefs : undefined,
      autoCreateFromConversation: body.autoCreateFromConversation ?? false,
    });
    return reply.status(201).send(p.toJSON());
  });

  fastify.patch('/pipelines/:id', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Funil não encontrado' });
    const body = request.body as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'stages', 'archived', 'autoCreateFromConversation', 'customFieldDefs']) if (k in body) update[k] = body[k];
    const p = await Pipeline.findOneAndUpdate({ _id: id, workspaceId }, update, { new: true });
    if (!p) return reply.status(404).send({ error: 'Funil não encontrado' });
    return reply.send(p.toJSON());
  });

  fastify.delete('/pipelines/:id', canManagePipelines, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Funil não encontrado' });
    // Archive (soft) so existing leads are preserved.
    const p = await Pipeline.findOneAndUpdate({ _id: id, workspaceId }, { archived: true }, { new: true });
    if (!p) return reply.status(404).send({ error: 'Funil não encontrado' });
    return reply.status(204).send();
  });

  fastify.get('/reports', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { pipelineId, from, to } = request.query as { pipelineId?: string; from?: string; to?: string };
    if (!pipelineId) return reply.status(400).send({ error: 'pipelineId é obrigatório' });
    const range = { from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined };

    if (pipelineId === 'all') {
      const report = await getCrossPipelineReport(workspaceId, range);
      if (!report) return reply.status(404).send({ error: 'Nenhum funil encontrado' });
      return reply.send(report);
    }

    if (!valid(pipelineId)) return reply.status(400).send({ error: 'pipelineId inválido' });
    const report = await getCrmReport(workspaceId, pipelineId, range);
    if (!report) return reply.status(404).send({ error: 'Funil não encontrado' });
    return reply.send(report);
  });

  // ─── Leads ──────────────────────────────────────────────────────────────────

  fastify.get('/leads', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { pipelineId, stage, assigneeId, tag, search, status } = request.query as Record<string, string>;
    const filter: Record<string, unknown> = { workspaceId };
    if (pipelineId && valid(pipelineId)) filter.pipelineId = pipelineId;
    if (stage) filter.stageId = stage;
    if (status) filter.status = status;
    if (assigneeId && valid(assigneeId)) filter.assigneeId = assigneeId;
    if (tag) filter.tags = tag;
    if (search) filter.title = { $regex: escapeRegex(search), $options: 'i' };
    const leads = await Lead.find(filter).sort({ stageId: 1, order: 1 })
      .populate('contactId', 'name phone avatarUrl email')
      .populate('assigneeId', 'name');
    return reply.send({ data: leads.map(toLeadResponse) });
  });

  fastify.get('/leads/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Lead não encontrado' });
    const lead = await Lead.findOne({ _id: id, workspaceId })
      .populate('contactId', 'name phone avatarUrl email')
      .populate('assigneeId', 'name');
    if (!lead) return reply.status(404).send({ error: 'Lead não encontrado' });
    return reply.send(toLeadResponse(lead));
  });

  fastify.post('/leads', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const body = request.body as any;
    if (!body.contactId || !valid(body.contactId)) return reply.status(400).send({ error: 'contactId é obrigatório' });
    const contact = await Contact.findOne({ _id: body.contactId, workspaceId });
    if (!contact) return reply.status(404).send({ error: 'Contato não encontrado' });
    const pipeline = body.pipelineId && valid(body.pipelineId)
      ? await Pipeline.findOne({ _id: body.pipelineId, workspaceId })
      : await ensureDefaultPipeline(workspaceId);
    if (!pipeline) return reply.status(400).send({ error: 'Funil inválido' });
    const stageId = body.stageId && pipeline.stages.some((s) => s.id === body.stageId) ? body.stageId : pipeline.stages[0]?.id;

    const wid = new Types.ObjectId(workspaceId);
    const lead = await Lead.create({
      workspaceId: wid, pipelineId: pipeline._id, stageId, contactId: contact._id,
      conversationId: body.conversationId && valid(body.conversationId) ? body.conversationId : undefined,
      title: (body.title as string)?.trim() || contact.name,
      value: Number(body.value) || 0,
      assigneeId: body.assigneeId && valid(body.assigneeId) ? body.assigneeId : undefined,
      tags: Array.isArray(body.tags) ? body.tags : (contact.tags ?? []),
      notes: body.notes ?? '',
      expectedCloseDate: body.expectedCloseDate ? new Date(body.expectedCloseDate) : undefined,
      source: ['manual', 'flow', 'conversation'].includes(body.source) ? body.source : 'manual',
      order: await nextOrder(wid, pipeline._id as Types.ObjectId, stageId),
    });
    const { sub: actorId } = request.user as { sub?: string };
    await logLeadActivity({ workspaceId: wid, leadId: lead._id, type: 'created', message: 'Lead criado', actorId, actorName: await getActorName(actorId) });
    await lead.populate('contactId', 'name phone avatarUrl email');
    return reply.status(201).send(toLeadResponse(lead));
  });

  fastify.get('/leads/:id/activity', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Lead não encontrado' });
    const activity = await LeadActivity.find({ workspaceId, leadId: id }).sort({ createdAt: -1 }).limit(200);
    return reply.send({ data: activity.map((a) => a.toJSON()) });
  });

  fastify.patch('/leads/:id', canWrite, async (request, reply) => {
    const { workspaceId, sub: actorId } = request.user as { workspaceId: string; sub?: string };
    const { id: leadId } = request.params as { id: string };
    if (!valid(leadId)) return reply.status(404).send({ error: 'Lead não encontrado' });
    const body = request.body as Record<string, unknown>;
    const existing = await Lead.findOne({ _id: leadId, workspaceId });
    if (!existing) return reply.status(404).send({ error: 'Lead não encontrado' });

    const update: Record<string, unknown> = { lastActivityAt: new Date() };
    for (const k of ['title', 'value', 'notes', 'tags', 'expectedCloseDate', 'customFields']) if (k in body) update[k] = body[k];
    if ('assigneeId' in body) update.assigneeId = body.assigneeId && valid(String(body.assigneeId)) ? body.assigneeId : null;

    const lead = await Lead.findOneAndUpdate({ _id: leadId, workspaceId }, update, { new: true })
      .populate('contactId', 'name phone avatarUrl email').populate('assigneeId', 'name');
    if (!lead) return reply.status(404).send({ error: 'Lead não encontrado' });

    const changedValue = 'value' in body && Number(body.value) !== existing.value;
    const changedNotes = 'notes' in body && body.notes && body.notes !== existing.notes;
    const changedAssignee = 'assigneeId' in body && String(update.assigneeId ?? '') !== String(existing.assigneeId ?? '');
    const newTags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined;
    const addedTags = newTags ? newTags.filter((t) => !existing.tags.includes(t)) : [];
    const removedTags = newTags ? existing.tags.filter((t) => !newTags.includes(t)) : [];
    if (changedValue || changedNotes || changedAssignee || addedTags.length || removedTags.length) {
      const actorName = await getActorName(actorId);
      for (const tag of addedTags) {
        await logLeadActivity({ workspaceId, leadId, type: 'tag_added', actorId, actorName, message: `Etiqueta "${tag}" adicionada` });
      }
      for (const tag of removedTags) {
        await logLeadActivity({ workspaceId, leadId, type: 'tag_removed', actorId, actorName, message: `Etiqueta "${tag}" removida` });
      }
      if (changedValue) {
        await logLeadActivity({
          workspaceId, leadId, type: 'value_changed', actorId, actorName,
          message: `Valor atualizado de R$ ${existing.value.toFixed(2)} para R$ ${Number(body.value).toFixed(2)}`,
          metadata: { from: existing.value, to: Number(body.value) },
        });
      }
      if (changedNotes) {
        await logLeadActivity({ workspaceId, leadId, type: 'note_added', actorId, actorName, message: String(body.notes) });
      }
      if (changedAssignee) {
        await logLeadActivity({
          workspaceId, leadId, type: 'assigned', actorId, actorName,
          message: update.assigneeId ? 'Responsável atualizado' : 'Responsável removido',
        });
        if (update.assigneeId && String(update.assigneeId) !== actorId) {
          void notify(opts.wsGateway, {
            workspaceId, recipientId: String(update.assigneeId), type: 'crm.lead_assigned',
            title: 'Oportunidade atribuída a você', message: `"${lead.title}" foi atribuída a você`,
            link: '/crm', metadata: { leadId },
          });
        }
      }
    }
    return reply.send(toLeadResponse(lead));
  });

  // Move to a stage at a position; re-sequences the target stage and applies won/lost.
  fastify.post('/leads/:id/move', canWrite, async (request, reply) => {
    const { workspaceId, sub: actorId } = request.user as { workspaceId: string; sub?: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Lead não encontrado' });
    const { stageId, order } = request.body as { stageId: string; order?: number };
    const lead = await Lead.findOne({ _id: id, workspaceId });
    if (!lead) return reply.status(404).send({ error: 'Lead não encontrado' });
    const pipeline = await Pipeline.findById(lead.pipelineId);
    const stage = pipeline?.stages.find((s) => s.id === stageId);
    if (!stage) return reply.status(400).send({ error: 'Estágio inválido' });
    const fromStageName = pipeline?.stages.find((s) => s.id === lead.stageId)?.name ?? lead.stageId;

    lead.stageId = stageId;
    lead.lastActivityAt = new Date();
    if (stage.kind === 'won') { lead.status = 'won'; lead.wonAt = new Date(); lead.lostAt = undefined; }
    else if (stage.kind === 'lost') { lead.status = 'lost'; lead.lostAt = new Date(); lead.wonAt = undefined; }
    else { lead.status = 'open'; lead.wonAt = undefined; lead.lostAt = undefined; }
    await lead.save();

    // Re-sequence the target stage with the moved lead inserted at `order`.
    const siblings = await Lead.find({ workspaceId, pipelineId: lead.pipelineId, stageId, _id: { $ne: lead._id } }).sort({ order: 1 });
    const idx = Math.max(0, Math.min(Number.isFinite(Number(order)) ? Number(order) : siblings.length, siblings.length));
    siblings.splice(idx, 0, lead);
    await Promise.all(siblings.map((l, i) => Lead.updateOne({ _id: l._id }, { order: i })));

    await logLeadActivity({
      workspaceId, leadId: lead._id, type: 'stage_changed', actorId, actorName: await getActorName(actorId),
      message: `Movido de "${fromStageName}" para "${stage.name}"`,
      metadata: { fromStageId: fromStageName, toStageId: stageId },
    });
    void triggerCrmFlow(opts.sessionManager, workspaceId, lead, 'stage_changed');
    if (stage.kind === 'won') {
      void triggerCrmFlow(opts.sessionManager, workspaceId, lead, 'won');
      void emitWebhookEvent(workspaceId, 'crm.lead_won', { leadId: id, title: lead.title, value: lead.value, pipelineId: lead.pipelineId.toString() });
    }
    if (stage.kind === 'lost') {
      void triggerCrmFlow(opts.sessionManager, workspaceId, lead, 'lost');
      void emitWebhookEvent(workspaceId, 'crm.lead_lost', { leadId: id, title: lead.title, value: lead.value, pipelineId: lead.pipelineId.toString() });
    }

    if (lead.assigneeId && lead.assigneeId.toString() !== actorId) {
      const recipientId = lead.assigneeId.toString();
      if (stage.kind === 'won') {
        void notify(opts.wsGateway, { workspaceId, recipientId, type: 'crm.lead_won', title: 'Oportunidade ganha 🎉', message: `"${lead.title}" foi marcada como ganha`, link: '/crm', metadata: { leadId: id } });
      } else if (stage.kind === 'lost') {
        void notify(opts.wsGateway, { workspaceId, recipientId, type: 'crm.lead_lost', title: 'Oportunidade perdida', message: `"${lead.title}" foi marcada como perdida`, link: '/crm', metadata: { leadId: id } });
      } else {
        void notify(opts.wsGateway, { workspaceId, recipientId, type: 'crm.lead_stage_changed', title: 'Oportunidade mudou de estágio', message: `"${lead.title}" foi movida para "${stage.name}"`, link: '/crm', metadata: { leadId: id } });
      }
    }

    await lead.populate('contactId', 'name phone avatarUrl email');
    await lead.populate('assigneeId', 'name');
    return reply.send(toLeadResponse(lead));
  });

  fastify.post('/leads/:id/win', canWrite, async (request, reply) => {
    const { workspaceId, sub: actorId } = request.user as { workspaceId: string; sub?: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Lead não encontrado' });
    const lead = await Lead.findOne({ _id: id, workspaceId });
    if (!lead) return reply.status(404).send({ error: 'Lead não encontrado' });
    const pipeline = await Pipeline.findById(lead.pipelineId);
    const wonStage = pipeline?.stages.find((s) => s.kind === 'won');
    if (wonStage) lead.stageId = wonStage.id;
    lead.status = 'won'; lead.wonAt = new Date(); lead.lastActivityAt = new Date();
    await lead.save();
    await logLeadActivity({ workspaceId, leadId: lead._id, type: 'won', actorId, actorName: await getActorName(actorId), message: 'Lead marcado como ganho 🎉' });
    void triggerCrmFlow(opts.sessionManager, workspaceId, lead, 'won');
    void emitWebhookEvent(workspaceId, 'crm.lead_won', { leadId: lead._id.toString(), title: lead.title, value: lead.value, pipelineId: lead.pipelineId.toString() });
    if (lead.assigneeId && lead.assigneeId.toString() !== actorId) {
      void notify(opts.wsGateway, {
        workspaceId, recipientId: lead.assigneeId.toString(), type: 'crm.lead_won',
        title: 'Oportunidade ganha 🎉', message: `"${lead.title}" foi marcada como ganha`,
        link: '/crm', metadata: { leadId: lead._id.toString() },
      });
    }
    await lead.populate('contactId', 'name phone avatarUrl email');
    return reply.send(toLeadResponse(lead));
  });

  fastify.post('/leads/:id/lose', canWrite, async (request, reply) => {
    const { workspaceId, sub: actorId } = request.user as { workspaceId: string; sub?: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Lead não encontrado' });
    const { reason } = request.body as { reason?: string };
    const lead = await Lead.findOne({ _id: id, workspaceId });
    if (!lead) return reply.status(404).send({ error: 'Lead não encontrado' });
    const pipeline = await Pipeline.findById(lead.pipelineId);
    const lostStage = pipeline?.stages.find((s) => s.kind === 'lost');
    if (lostStage) lead.stageId = lostStage.id;
    lead.status = 'lost'; lead.lostAt = new Date(); lead.lostReason = reason; lead.lastActivityAt = new Date();
    await lead.save();
    await logLeadActivity({
      workspaceId, leadId: lead._id, type: 'lost', actorId, actorName: await getActorName(actorId),
      message: reason ? `Lead marcado como perdido — ${reason}` : 'Lead marcado como perdido',
      metadata: { reason },
    });
    void triggerCrmFlow(opts.sessionManager, workspaceId, lead, 'lost');
    void emitWebhookEvent(workspaceId, 'crm.lead_lost', { leadId: lead._id.toString(), title: lead.title, value: lead.value, pipelineId: lead.pipelineId.toString() });
    if (lead.assigneeId && lead.assigneeId.toString() !== actorId) {
      void notify(opts.wsGateway, {
        workspaceId, recipientId: lead.assigneeId.toString(), type: 'crm.lead_lost',
        title: 'Oportunidade perdida', message: `"${lead.title}" foi marcada como perdida`,
        link: '/crm', metadata: { leadId: lead._id.toString() },
      });
    }
    await lead.populate('contactId', 'name phone avatarUrl email');
    return reply.send(toLeadResponse(lead));
  });

  fastify.delete('/leads/:id', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Lead não encontrado' });
    const lead = await Lead.findOneAndDelete({ _id: id, workspaceId });
    if (!lead) return reply.status(404).send({ error: 'Lead não encontrado' });
    await LeadActivity.deleteMany({ leadId: id });
    return reply.status(204).send();
  });
}
