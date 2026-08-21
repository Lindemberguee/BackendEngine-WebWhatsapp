/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import ExcelJS from 'exceljs';
import { Campaign, CampaignRecipient, Instance, WhatsAppTemplate } from '../../db/models';
import { resolveAudience, launchCampaign, pauseCampaign, cancelCampaign, sendTestMessage } from './campaign.service';
import { estimateCampaignCost } from './pricing.service';
import type { WebSocketGateway } from '../../ws/gateway';
import type { SessionManager } from '../../session-manager/SessionManager';
import { assertCampaignsEnabled } from '../billing/billing.service';
import { requireRole } from '../../utils/require-role';
import { FEATURE_FLAGS } from '../../config/feature-flags';

const valid = (id: string) => Types.ObjectId.isValid(id);

/** All selected instances must share one channel — mixing official/non-official
 *  in one campaign would leave the message content ambiguous (a template only
 *  makes sense on Cloud API; a flow-block message doesn't work on Cloud API at
 *  all). On a 'cloud_api'-only campaign, the message must be a template — cold
 *  outreach is never within the 24h free-form window, so anything else would
 *  fail on every single send.
 */
async function validateChannelAndMessage(workspaceId: string, instanceIds: string[], messageBlockType: string, messageConfig: Record<string, unknown>): Promise<string | null> {
  if (!instanceIds.length || instanceIds.some((id) => !valid(id))) return 'Selecione ao menos uma instância válida';
  const instances = await Instance.find({ _id: { $in: instanceIds }, workspaceId }).select('channel').lean();
  if (instances.length !== instanceIds.length) return 'Uma ou mais instâncias selecionadas são inválidas';
  const channels = new Set(instances.map((i) => i.channel ?? 'baileys'));
  if (channels.size > 1) return 'Selecione instâncias de um único canal (não é possível misturar WhatsApp e API Oficial na mesma campanha)';
  const channel = [...channels][0];
  if (channel === 'cloud_api' && messageBlockType !== 'message.template') {
    return 'Campanhas na API Oficial da Meta só podem enviar um template aprovado — contatos frios estão sempre fora da janela de 24h';
  }
  // Belt-and-suspenders against exactly the bug that shipped once already: the
  // wizard could silently leave templateName/language blank after a channel
  // switch. A template block with no template actually selected must never
  // reach launchCampaign — it fails per-recipient at send time instead of
  // being caught once, up front, with a message that says what's wrong.
  if (messageBlockType === 'message.template') {
    const templateName = typeof messageConfig.templateName === 'string' ? messageConfig.templateName.trim() : '';
    const language = typeof messageConfig.language === 'string' ? messageConfig.language.trim() : '';
    if (!templateName || !language) return 'Selecione um template aprovado antes de continuar';
    if (channel === 'cloud_api') {
      const approvedTemplates = await WhatsAppTemplate.find({
        workspaceId, instanceId: { $in: instanceIds }, name: templateName, language, status: 'APPROVED',
      }).select('variableCount components').lean();
      if (approvedTemplates.length !== instanceIds.length) return 'O template precisa estar aprovado em todas as instâncias oficiais selecionadas';
      const unsupportedTemplate = approvedTemplates.some((template) => {
        const components = Array.isArray(template.components) ? template.components as Array<Record<string, unknown>> : [];
        return components.some((component) => {
          const type = String(component.type ?? '').toUpperCase();
          const format = String(component.format ?? '').toUpperCase();
          if (type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) return true;
          if (type !== 'BODY' && /\{\{\s*\d+\s*\}\}/.test(String(component.text ?? ''))) return true;
          if (type === 'BUTTONS' && JSON.stringify(component).includes('{{')) return true;
          return false;
        });
      });
      if (unsupportedTemplate) {
        return 'Este template usa mídia ou variáveis no cabeçalho/botão; campanhas em massa atualmente aceitam variáveis somente no corpo';
      }
      const expectedVariables = approvedTemplates[0]?.variableCount ?? 0;
      if (approvedTemplates.some((template) => template.variableCount !== expectedVariables)) {
        return 'As instâncias selecionadas possuem versões incompatíveis desse template';
      }
      const variables = Array.isArray(messageConfig.variables) ? messageConfig.variables : [];
      if (variables.length !== expectedVariables || variables.some((value) => typeof value !== 'string' || !value.trim())) {
        return `Preencha as ${expectedVariables} variável(is) obrigatória(s) do template`;
      }
    }
  }
  return null;
}

export async function campaignsRoutes(fastify: FastifyInstance, opts: { wsGateway: WebSocketGateway; sessionManager: SessionManager }): Promise<void> {
  // Locked for launch (see feature-flags.ts) — rejects every route in this
  // plugin with 403 even if called directly, not just hidden in the UI.
  // Fastify plugins are encapsulated, so this hook only applies to routes
  // registered on this `fastify` instance (i.e. everything under /api/campaigns).
  fastify.addHook('preHandler', async (_request, reply) => {
    if (!FEATURE_FLAGS.campaigns) return reply.status(403).send({ error: 'Campanhas ainda não estão disponíveis.' });
  });

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
    const body = request.body as any;
    // Keep accepting the legacy raw-audience body while API clients migrate to
    // the channel-aware shape.
    const audience = body?.audience?.type ? body.audience : body;
    const instanceIds = Array.isArray(body?.instanceIds) ? body.instanceIds.filter(valid) : [];
    const contacts = await resolveAudience(workspaceId, audience);
    const usesOfficialChannel = instanceIds.length > 0 && Boolean(await Instance.exists({
      _id: { $in: instanceIds }, workspaceId, channel: 'cloud_api',
    }));
    const eligible = usesOfficialChannel ? contacts.filter((contact) => Boolean(contact.whatsappOptInAt)) : contacts;
    return reply.send({
      count: eligible.length,
      totalMatched: contacts.length,
      excludedNoOptIn: usesOfficialChannel ? contacts.length - eligible.length : 0,
      sample: eligible.slice(0, 5).map((c: any) => ({ id: c._id.toString(), name: c.name, phone: c.phone })),
    });
  });

  // POST /api/campaigns/cost-estimate — estimate what a template campaign will
  // cost using the platform's own rate card (see pricing.service.ts). Only
  // meaningful for a Cloud API template send; returns an empty estimate for
  // anything else (Baileys sends have no per-message Meta cost).
  fastify.post('/cost-estimate', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const body = request.body as { audience?: any; instanceIds?: string[]; templateCategory?: string };
    const audience = body?.audience;
    const instanceIds = Array.isArray(body?.instanceIds) ? body.instanceIds.filter(valid) : [];
    if (!audience?.type) return reply.status(400).send({ error: 'Público inválido' });
    const estimate = await estimateCampaignCost(workspaceId, audience, instanceIds, body.templateCategory);
    return reply.send(estimate);
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

  // GET /api/campaigns/:id/recipients/export — every recipient (no pagination,
  // same "full-fidelity audit dump" pattern as reports.routes.ts's export)
  // as a .xlsx workbook, so the operator can hand a client a record of exactly
  // who received what and what it cost.
  fastify.get('/:id/recipients/export', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Campanha não encontrada' });
    const campaign = await Campaign.findOne({ _id: id, workspaceId });
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' });

    const recipients = await CampaignRecipient.find({ workspaceId, campaignId: id }).sort({ createdAt: 1 }).lean();

    const STATUS_LABEL: Record<string, string> = { pending: 'Pendente', sending: 'Enviando', sent: 'Enviada', delivered: 'Entregue', read: 'Lida', failed: 'Falhou', skipped: 'Pulada' };
    const SKIP_REASON_LABEL: Record<string, string> = { blocked: 'Contato bloqueado', opted_out: 'Pediu para sair', invalid_number: 'Número inválido' };

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ZapZin';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Destinatários');
    sheet.columns = [
      { header: 'Nome', key: 'name', width: 28 },
      { header: 'Telefone', key: 'jid', width: 20 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Motivo (erro/pulo)', key: 'reason', width: 32 },
      { header: 'Custo estimado', key: 'cost', width: 16 },
      { header: 'Enviado em', key: 'sentAt', width: 20 },
      { header: 'Respondeu em', key: 'repliedAt', width: 20 },
    ];
    sheet.addRows(recipients.map((r) => ({
      name: r.name || '—',
      jid: r.jid.replace('@s.whatsapp.net', '').replace('@g.us', ' (grupo)'),
      status: STATUS_LABEL[r.status] ?? r.status,
      reason: r.error || (r.skipReason ? SKIP_REASON_LABEL[r.skipReason] ?? r.skipReason : ''),
      cost: typeof r.estimatedCostCents === 'number' ? `${(r.estimatedCostCents / 100).toFixed(2)} ${r.estimatedCostCurrency ?? ''}`.trim() : '',
      sentAt: r.sentAt ? new Date(r.sentAt).toLocaleString('pt-BR') : '',
      repliedAt: r.repliedAt ? new Date(r.repliedAt).toLocaleString('pt-BR') : '',
    })));
    sheet.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="campanha-${campaign.name.replace(/[^a-zA-Z0-9]+/g, '-')}-destinatarios.xlsx"`)
      .send(Buffer.from(buffer));
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
    const channelError = await validateChannelAndMessage(workspaceId, instanceIds, body.message.blockType, body.message.config ?? {});
    if (channelError) return reply.status(400).send({ error: channelError });

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
    const existing = await Campaign.findOne({ _id: id, workspaceId, status: 'draft' });
    if (!existing) return reply.status(404).send({ error: 'Campanha não encontrada ou já iniciada' });

    const body = request.body as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    for (const k of ['name', 'audience', 'message', 'throttle', 'instanceIds', 'scheduledAt', 'includeOptOutFooter']) if (k in body) update[k] = body[k];

    const resultingInstanceIds = (Array.isArray(update.instanceIds) ? update.instanceIds : existing.instanceIds.map(String)) as string[];
    const resultingMessage = (update.message as { blockType?: string; config?: Record<string, unknown> } | undefined);
    const resultingBlockType = resultingMessage?.blockType ?? existing.message.blockType;
    const resultingConfig = resultingMessage?.config ?? existing.message.config ?? {};
    const channelError = await validateChannelAndMessage(workspaceId, resultingInstanceIds, resultingBlockType, resultingConfig);
    if (channelError) return reply.status(400).send({ error: channelError });

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
      const existing = await Campaign.findOne({ _id: id, workspaceId });
      if (!existing) return reply.status(404).send({ error: 'Campanha não encontrada' });
      // The final gate before real sends actually start — create/edit already
      // check this, but a draft saved before this check existed (or edited by
      // some other path) must not slip through at launch time either.
      const channelError = await validateChannelAndMessage(workspaceId, existing.instanceIds.map(String), existing.message.blockType, existing.message.config ?? {});
      if (channelError) return reply.status(400).send({ error: channelError });

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
