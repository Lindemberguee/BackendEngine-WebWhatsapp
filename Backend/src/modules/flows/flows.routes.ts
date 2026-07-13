import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { Flow } from '../../db/models';
import { notifyWorkspaceOwner } from '../notifications/notification.service';
import type { WebSocketGateway } from '../../ws/gateway';
import { assertCanActivateAutomation } from '../billing/billing.service';

const TRIGGER_TYPES = ['keyword', 'any_message', 'new_contact', 'scheduled', 'manual', 'crm_event', 'webhook'] as const;
const CRM_EVENTS = ['stage_changed', 'won', 'lost'] as const;

// Derive the denormalized trigger (type + keywords + crm_event fields) from the flow's trigger node.
// `existingToken` preserves a previously-generated webhook token across saves — only
// minted once, the first time a flow's trigger becomes 'webhook'.
function extractTrigger(nodes: unknown, existingToken?: string): {
  type: typeof TRIGGER_TYPES[number]; keywords: string[]; allowGroups?: boolean;
  crmEvent?: typeof CRM_EVENTS[number]; crmPipelineId?: Types.ObjectId; crmStageId?: string;
  webhookToken?: string;
} {
  const list = Array.isArray(nodes) ? (nodes as Array<Record<string, any>>) : [];
  const trig = list.find((n) => (n?.data?.blockType ?? n?.blockType) === 'automation.trigger');
  const cfg = (trig?.data?.config ?? trig?.config ?? {}) as Record<string, unknown>;
  const type = (cfg.triggerType as any) ?? 'manual';
  const keywords = Array.isArray(cfg.keywords) ? (cfg.keywords as string[]) : [];
  const allowGroups = Boolean(cfg.allowGroups);
  const crmEvent = CRM_EVENTS.includes(cfg.crmEvent as any) ? (cfg.crmEvent as typeof CRM_EVENTS[number]) : undefined;
  const crmPipelineId = typeof cfg.crmPipelineId === 'string' && Types.ObjectId.isValid(cfg.crmPipelineId)
    ? new Types.ObjectId(cfg.crmPipelineId) : undefined;
  const crmStageId = typeof cfg.crmStageId === 'string' && cfg.crmStageId ? cfg.crmStageId : undefined;
  const resolvedType = TRIGGER_TYPES.includes(type) ? type : 'manual';
  const webhookToken = resolvedType === 'webhook' ? (existingToken ?? randomBytes(24).toString('hex')) : undefined;
  return {
    type: resolvedType,
    keywords, allowGroups, crmEvent, crmPipelineId, crmStageId, webhookToken,
  };
}

// Derive the target instance from the flow's "Instância" block (null = any instance).
function extractInstance(nodes: unknown): Types.ObjectId | null {
  const list = Array.isArray(nodes) ? (nodes as Array<Record<string, any>>) : [];
  const node = list.find((n) => (n?.data?.blockType ?? n?.blockType) === 'automation.instance');
  const id = (node?.data?.config ?? node?.config ?? {}).instanceId;
  return typeof id === 'string' && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
}

export async function flowsRoutes(fastify: FastifyInstance, opts: { wsGateway: WebSocketGateway }): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };
  const valid = (id: string) => Types.ObjectId.isValid(id);

  // GET /api/flows
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const flows = await Flow.find({ workspaceId: new Types.ObjectId(workspaceId) }).sort({ updatedAt: -1 });
    return reply.send({ data: flows.map((f) => f.toJSON()) });
  });

  // GET /api/flows/:id
  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    const flow = await Flow.findOne({ _id: id, workspaceId });
    if (!flow) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    return reply.send(flow.toJSON());
  });

  // POST /api/flows
  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { name, description } = request.body as { name?: string; description?: string };
    const flow = await Flow.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name: name?.trim() || 'Novo Fluxo',
      description,
      enabled: false,
      trigger: { type: 'manual', keywords: [] },
      nodes: [], edges: [],
    });
    return reply.status(201).send(flow.toJSON());
  });

  // PATCH /api/flows/:id  (save name/nodes/edges/enabled; re-derive trigger)
  fastify.patch('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; description?: string; nodes?: unknown; edges?: unknown; enabled?: boolean; folderId?: string | null };
    if (!valid(id)) return reply.status(404).send({ error: 'Fluxo não encontrado' });

    const existing = await Flow.findOne({ _id: id, workspaceId }).select('enabled trigger.webhookToken').lean();
    if (body.enabled === true && existing && !existing.enabled) {
      try {
        await assertCanActivateAutomation(workspaceId);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    }

    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.description !== undefined) update.description = body.description;
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.folderId !== undefined) {
      update.folderId = body.folderId && Types.ObjectId.isValid(body.folderId)
        ? new Types.ObjectId(body.folderId)
        : null;
    }
    if (body.nodes !== undefined) {
      update.nodes = body.nodes;
      update.trigger = extractTrigger(body.nodes, existing?.trigger?.webhookToken);
      update.instanceId = extractInstance(body.nodes);
    }
    if (body.edges !== undefined) update.edges = body.edges;

    const flow = await Flow.findOneAndUpdate({ _id: id, workspaceId }, { $set: update }, { new: true });
    if (!flow) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    return reply.send(flow.toJSON());
  });

  // POST /api/flows/:id/webhook-token/regenerate — rotate the public trigger token (e.g. after a leak)
  fastify.post('/:id/webhook-token/regenerate', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    const flow = await Flow.findOneAndUpdate(
      { _id: id, workspaceId, 'trigger.type': 'webhook' },
      { $set: { 'trigger.webhookToken': randomBytes(24).toString('hex') } },
      { new: true }
    );
    if (!flow) return reply.status(404).send({ error: 'Fluxo não encontrado ou gatilho não é webhook' });
    return reply.send(flow.toJSON());
  });

  // POST /api/flows/:id/publish
  fastify.post('/:id/publish', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    const existing = await Flow.findOne({ _id: id, workspaceId }).select('enabled').lean();
    if (existing && !existing.enabled) {
      try {
        await assertCanActivateAutomation(workspaceId);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    }
    const flow = await Flow.findOneAndUpdate({ _id: id, workspaceId }, { $set: { enabled: true } }, { new: true });
    if (!flow) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    void notifyWorkspaceOwner(opts.wsGateway, workspaceId, {
      type: 'flow.published', title: 'Fluxo publicado', message: `O fluxo "${flow.name}" foi publicado e está ativo`,
      link: '/automation/flows', metadata: { flowId: id },
    });
    return reply.send(flow.toJSON());
  });

  // DELETE /api/flows/:id
  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    const flow = await Flow.findOneAndDelete({ _id: id, workspaceId });
    if (!flow) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    return reply.status(204).send();
  });
}
