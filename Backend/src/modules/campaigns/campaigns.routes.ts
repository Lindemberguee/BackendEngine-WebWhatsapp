/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Campaign, CampaignRecipient, Instance } from '../../db/models';
import { resolveAudience, launchCampaign, pauseCampaign, cancelCampaign, sendTestMessage } from './campaign.service';
import type { WebSocketGateway } from '../../ws/gateway';
import type { SessionManager } from '../../session-manager/SessionManager';
import { assertCampaignsEnabled } from '../billing/billing.service';
import { requireRole } from '../../utils/require-role';

const valid = (id: string) => Types.ObjectId.isValid(id);

export async function campaignsRoutes(fastify: FastifyInstance, opts: { wsGateway: WebSocketGateway; sessionManager: SessionManager }): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };
  const canWrite = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin', 'agent'])] };

  // GET /api/campaigns
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const campaigns = await Campaign.find({ workspaceId }).sort({ createdAt: -1 });
    return reply.send({ data: campaigns.map((c) => c.toJSON()) });
  });

  // POST /api/campaigns/audience-preview — count (and a small sample) without creating anything
  fastify.post('/audience-preview', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const audience = request.body as any;
    const contacts = await resolveAudience(workspaceId, audience);
    return reply.send({ count: contacts.length, sample: contacts.slice(0, 5).map((c: any) => ({ id: c._id.toString(), name: c.name, phone: c.phone })) });
  });

  // GET /api/campaigns/:id
  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Campanha não encontrada' });
    const campaign = await Campaign.findOne({ _id: id, workspaceId });
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' });
    return reply.send(campaign.toJSON());
  });

  // GET /api/campaigns/:id/recipients
  fastify.get('/:id/recipients', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { status, page = '1', limit = '50' } = request.query as { status?: string; page?: string; limit?: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Campanha não encontrada' });
    const filter: Record<string, unknown> = { workspaceId, campaignId: id };
    if (status) filter.status = status;
    const p = Math.max(1, Number(page) || 1), l = Math.min(100, Math.max(1, Number(limit) || 50));
    const [entries, total] = await Promise.all([
      CampaignRecipient.find(filter).sort({ createdAt: 1 }).skip((p - 1) * l).limit(l),
      CampaignRecipient.countDocuments(filter),
    ]);
    return reply.send({ data: entries.map((e) => e.toJSON()), meta: { page: p, limit: l, total, totalPages: Math.ceil(total / l) } });
  });

  // POST /api/campaigns — create as draft
  fastify.post('/', canWrite, async (request, reply) => {
    const { workspaceId, sub } = request.user as { workspaceId: string; sub: string };
    try {
      await assertCampaignsEnabled(workspaceId);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
    const body = request.body as any;
    if (!body.name?.trim()) return reply.status(400).send({ error: 'Nome é obrigatório' });
    if (!body.audience?.type) return reply.status(400).send({ error: 'Público é obrigatório' });
    if (!body.message?.blockType) return reply.status(400).send({ error: 'Mensagem é obrigatória' });
    const instanceIds = Array.isArray(body.instanceIds) ? body.instanceIds.filter(valid) : [];
    if (!instanceIds.length) return reply.status(400).send({ error: 'Selecione ao menos uma instância conectada' });
    const owned = await Instance.countDocuments({ _id: { $in: instanceIds }, workspaceId });
    if (owned !== instanceIds.length) return reply.status(400).send({ error: 'Instância inválida' });

    const campaign = await Campaign.create({
      workspaceId, createdBy: sub, name: body.name.trim(), status: 'draft',
      instanceIds, audience: body.audience,
      message: { blockType: body.message.blockType, config: body.message.config ?? {} },
      includeOptOutFooter: body.includeOptOutFooter !== false,
      throttle: {
        minDelaySeconds: Math.max(2, Number(body.throttle?.minDelaySeconds) || 5),
        maxDelaySeconds: Math.max(3, Number(body.throttle?.maxDelaySeconds) || 15),
        maxPerInstancePerHour: Math.max(1, Number(body.throttle?.maxPerInstancePerHour) || 60),
        maxPerInstancePerDay: Math.max(1, Number(body.throttle?.maxPerInstancePerDay) || 300),
      },
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
    });
    return reply.status(201).send(campaign.toJSON());
  });

  // POST /api/campaigns/:id/test — send the configured message to one ad-hoc phone number
  fastify.post('/:id/test', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { phone } = request.body as { phone?: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Campanha não encontrada' });
    if (!phone?.trim()) return reply.status(400).send({ error: 'Informe um número para o teste' });
    const campaign = await Campaign.findOne({ _id: id, workspaceId });
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' });
    try {
      await sendTestMessage(opts.sessionManager, campaign, phone.trim());
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // PATCH /api/campaigns/:id — edit while still a draft
  fastify.patch('/:id', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Campanha não encontrada' });
    const body = request.body as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    for (const k of ['name', 'audience', 'message', 'throttle', 'instanceIds', 'scheduledAt', 'includeOptOutFooter']) if (k in body) update[k] = body[k];
    const campaign = await Campaign.findOneAndUpdate({ _id: id, workspaceId, status: 'draft' }, update, { new: true });
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada ou já iniciada' });
    return reply.send(campaign.toJSON());
  });

  // POST /api/campaigns/:id/launch
  fastify.post('/:id/launch', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Campanha não encontrada' });
    try {
      const campaign = await launchCampaign(id, workspaceId);
      if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' });
      return reply.send(campaign.toJSON());
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // POST /api/campaigns/:id/pause
  fastify.post('/:id/pause', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Campanha não encontrada' });
    const campaign = await pauseCampaign(id, workspaceId);
    if (!campaign) return reply.status(404).send({ error: 'Campanha não pode ser pausada' });
    return reply.send(campaign.toJSON());
  });

  // POST /api/campaigns/:id/resume — reuses launchCampaign (draft-only snapshot logic no-ops for paused)
  fastify.post('/:id/resume', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Campanha não encontrada' });
    try {
      const campaign = await launchCampaign(id, workspaceId);
      if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' });
      return reply.send(campaign.toJSON());
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // POST /api/campaigns/:id/cancel
  fastify.post('/:id/cancel', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Campanha não encontrada' });
    const campaign = await cancelCampaign(id, workspaceId);
    if (!campaign) return reply.status(404).send({ error: 'Campanha não pode ser cancelada' });
    return reply.send(campaign.toJSON());
  });

  // DELETE /api/campaigns/:id — only drafts
  fastify.delete('/:id', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Campanha não encontrada' });
    const campaign = await Campaign.findOneAndDelete({ _id: id, workspaceId, status: 'draft' });
    if (!campaign) return reply.status(400).send({ error: 'Só é possível excluir campanhas em rascunho' });
    await CampaignRecipient.deleteMany({ campaignId: id });
    return reply.status(204).send();
  });
}
