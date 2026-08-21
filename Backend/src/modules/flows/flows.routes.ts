import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { Flow, FlowRun, Conversation } from '../../db/models';
import { notifyWorkspaceOwner } from '../notifications/notification.service';
import type { WebSocketGateway } from '../../ws/gateway';
import { assertCanActivateAutomation } from '../billing/billing.service';
import { requireRole } from '../../utils/require-role';
import { validateFlowGraph, normalizeNodes, normalizeEdges } from '../../flow-executor/graph';
import { cancelFlowRunsForFlow } from '../../flow-executor';
import { parsePagination } from '../../utils/pagination';
import type { IFlow } from '../../db/models';

const TRIGGER_TYPES = ['keyword', 'any_message', 'new_contact', 'scheduled', 'manual', 'crm_event', 'webhook'] as const;
const CRM_EVENTS = ['stage_changed', 'won', 'lost'] as const;
const SCHEDULED_EVENTS = ['conversation_created', 'no_reply', 'conversation_closed'] as const;
const MAX_KEYWORD_LENGTH = 100;
const MAX_KEYWORDS = 50;
const MIN_SCHEDULED_DELAY_MINUTES = 1;
const MAX_SCHEDULED_DELAY_MINUTES = 30 * 24 * 60; // 30 days

// Derive the denormalized trigger (type + keywords + crm_event fields) from the flow's trigger node.
// `existingToken` preserves a previously-generated webhook token across saves — only
// minted once, the first time a flow's trigger becomes 'webhook'.
function extractTrigger(nodes: unknown, existingToken?: string): {
  type: typeof TRIGGER_TYPES[number]; keywords: string[]; allowGroups?: boolean;
  crmEvent?: typeof CRM_EVENTS[number]; crmPipelineId?: Types.ObjectId; crmStageId?: string;
  webhookToken?: string;
  scheduledEvent?: typeof SCHEDULED_EVENTS[number]; scheduledDelayMinutes?: number;
} {
  const list = Array.isArray(nodes) ? (nodes as Array<Record<string, any>>) : [];
  const trig = list.find((n) => (n?.data?.blockType ?? n?.blockType) === 'automation.trigger');
  const cfg = (trig?.data?.config ?? trig?.config ?? {}) as Record<string, unknown>;
  const type = (cfg.triggerType as any) ?? 'manual';
  // A keyword that's blank/whitespace-only (e.g. " ") previously passed the `k &&`
  // guard as truthy and matched *every* message via .includes() in index.ts — an
  // accidental catch-all that silently ran over every other flow's trigger. Trim,
  // drop blanks, cap length/count so one bad entry can't blow up the match or the
  // document size.
  const keywords = Array.isArray(cfg.keywords)
    ? (cfg.keywords as unknown[])
        .map((k) => String(k ?? '').trim())
        .filter((k) => k.length > 0)
        .slice(0, MAX_KEYWORDS)
        .map((k) => k.slice(0, MAX_KEYWORD_LENGTH))
    : [];
  const allowGroups = Boolean(cfg.allowGroups);
  const crmEvent = CRM_EVENTS.includes(cfg.crmEvent as any) ? (cfg.crmEvent as typeof CRM_EVENTS[number]) : undefined;
  const crmPipelineId = typeof cfg.crmPipelineId === 'string' && Types.ObjectId.isValid(cfg.crmPipelineId)
    ? new Types.ObjectId(cfg.crmPipelineId) : undefined;
  const crmStageId = typeof cfg.crmStageId === 'string' && cfg.crmStageId ? cfg.crmStageId : undefined;
  const resolvedType = TRIGGER_TYPES.includes(type) ? type : 'manual';
  const webhookToken = resolvedType === 'webhook' ? (existingToken ?? randomBytes(24).toString('hex')) : undefined;
  const scheduledEvent = resolvedType === 'scheduled' && SCHEDULED_EVENTS.includes(cfg.scheduledEvent as any)
    ? (cfg.scheduledEvent as typeof SCHEDULED_EVENTS[number]) : undefined;
  const scheduledDelayMinutes = resolvedType === 'scheduled'
    ? Math.min(MAX_SCHEDULED_DELAY_MINUTES, Math.max(MIN_SCHEDULED_DELAY_MINUTES, Number(cfg.scheduledDelayMinutes) || 60))
    : undefined;
  return {
    type: resolvedType,
    keywords, allowGroups, crmEvent, crmPipelineId, crmStageId, webhookToken,
    scheduledEvent, scheduledDelayMinutes,
  };
}

// Derive the target instance from the flow's "Instância" block (null = any instance).
function extractInstance(nodes: unknown): Types.ObjectId | null {
  const list = Array.isArray(nodes) ? (nodes as Array<Record<string, any>>) : [];
  const node = list.find((n) => (n?.data?.blockType ?? n?.blockType) === 'automation.instance');
  const id = (node?.data?.config ?? node?.config ?? {}).instanceId;
  return typeof id === 'string' && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
}

const REDACTED = '••••••••';

/**
 * Masks automation.webhook header *values* (API keys/tokens a workspace owner
 * typed into the flow) for any role below owner/admin — GET /api/flows and
 * GET /api/flows/:id were previously returning them in full to `agent`/`viewer`
 * roles, and the same values are embedded verbatim in the exported .flow.json.
 * Keys are left visible (so the block still reads sensibly), only values are
 * replaced.
 */
function redactWebhookHeaders<T extends Record<string, unknown>>(flowJson: T): T {
  const nodes = Array.isArray(flowJson.nodes) ? (flowJson.nodes as Array<Record<string, any>>) : [];
  let changed = false;
  const redactedNodes = nodes.map((n) => {
    const blockType = n?.data?.blockType ?? n?.blockType;
    if (blockType !== 'automation.webhook') return n;
    const cfg = (n?.data?.config ?? n?.config) as Record<string, unknown> | undefined;
    const headers = cfg?.headers;
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return n;
    changed = true;
    const maskedHeaders = Object.fromEntries(Object.keys(headers as Record<string, unknown>).map((k) => [k, REDACTED]));
    const newConfig = { ...cfg, headers: maskedHeaders };
    return n.data ? { ...n, data: { ...n.data, config: newConfig } } : { ...n, config: newConfig };
  });
  return changed ? { ...flowJson, nodes: redactedNodes } : flowJson;
}

/** Run the shared graph validator against a flow doc's current (or about-to-be-saved)
 *  nodes/edges — used to gate both publish and enabling via PATCH. */
function validateForActivation(flow: Pick<IFlow, 'nodes' | 'edges'>): string | null {
  const nodes = normalizeNodes(flow as IFlow);
  const edges = normalizeEdges(flow as IFlow);
  const errors = validateFlowGraph(nodes, edges);
  if (!errors.length) return null;
  return errors.map((e) => e.message).join('; ');
}

export async function flowsRoutes(fastify: FastifyInstance, opts: { wsGateway: WebSocketGateway }): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };
  // A published flow that misbehaves (loop, flood, SSRF via its webhook block) can
  // spam every contact in the workspace or reach internal network services — same
  // severity class as instance connect/disconnect. Restrict every mutation to
  // owner/admin; GET stays open to any authenticated role so agents can see what
  // automations exist.
  const canWrite = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin'])] };
  const valid = (id: string) => Types.ObjectId.isValid(id);

  // GET /api/flows
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };
    const canSeeSecrets = role === 'owner' || role === 'admin';
    const flows = await Flow.find({ workspaceId: new Types.ObjectId(workspaceId) }).sort({ updatedAt: -1 });
    const data = flows.map((f) => f.toJSON()).map((f) => (canSeeSecrets ? f : redactWebhookHeaders(f)));
    return reply.send({ data });
  });

  // GET /api/flows/:id
  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    const flow = await Flow.findOne({ _id: id, workspaceId });
    if (!flow) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    const canSeeSecrets = role === 'owner' || role === 'admin';
    return reply.send(canSeeSecrets ? flow.toJSON() : redactWebhookHeaders(flow.toJSON()));
  });

  // GET /api/flows/:id/runs — recent execution history for this flow. Previously
  // there was zero visibility into whether a published flow ever actually ran,
  // got stuck, or failed for a given contact — this is the first window into
  // that (paired with the frontend polling this on an interval while the panel
  // is open; a full push-based WS stream is a larger follow-up, not needed to
  // close the "no visibility at all" gap).
  fastify.get('/:id/runs', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    const flow = await Flow.findOne({ _id: id, workspaceId }).select('_id').lean();
    if (!flow) return reply.status(404).send({ error: 'Fluxo não encontrado' });

    const { status } = request.query as Record<string, string>;
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const filter: Record<string, unknown> = { flowId: id, workspaceId };
    if (status) filter.status = status;

    const [runs, total] = await Promise.all([
      FlowRun.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      FlowRun.countDocuments(filter),
    ]);
    // Attach a contact-facing label per run (name/phone) — the run doc itself
    // only has jid/conversationId, not enough to show a human a useful list.
    const conversationIds = runs.map((r) => r.conversationId);
    const conversations = conversationIds.length
      ? await Conversation.find({ _id: { $in: conversationIds } }).select('name phone').lean()
      : [];
    const convById = new Map(conversations.map((c) => [c._id.toString(), c]));

    const data = runs.map((r) => {
      const conv = convById.get(r.conversationId.toString());
      return {
        id: r._id.toString(),
        conversationId: r.conversationId.toString(),
        contactName: conv?.name ?? r.jid,
        contactPhone: conv?.phone,
        status: r.status,
        currentNodeId: r.currentNodeId,
        stepCount: r.stepCount,
        failureReason: r.failureReason,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });

    return reply.send({
      data,
      pagination: {
        page, limit, total, totalPages: Math.ceil(total / limit),
        hasNextPage: skip + data.length < total,
      },
    });
  });

  // POST /api/flows
  fastify.post('/', canWrite, async (request, reply) => {
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

  // POST /api/flows/:id/duplicate — clone a flow (e.g. to iterate safely on a
  // copy of one that's already published, instead of editing it live).
  fastify.post('/:id/duplicate', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    const source = await Flow.findOne({ _id: id, workspaceId }).lean();
    if (!source) return reply.status(404).send({ error: 'Fluxo não encontrado' });

    const clonedTrigger = { ...source.trigger };
    // A webhook token IS the trigger's credential (see webhook-flow-trigger.ts) —
    // two flows sharing one would mean triggering either one fires both. Mint a
    // fresh token for the clone instead of copying it, same as a brand-new flow
    // would get on its first save.
    if (clonedTrigger.type === 'webhook') clonedTrigger.webhookToken = randomBytes(24).toString('hex');

    const clone = await Flow.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name: `${source.name} (cópia)`,
      description: source.description,
      enabled: false, // a duplicate never goes live automatically
      trigger: clonedTrigger,
      instanceId: source.instanceId,
      nodes: source.nodes,
      edges: source.edges,
      folderId: source.folderId,
    });
    return reply.status(201).send(clone.toJSON());
  });

  // PATCH /api/flows/:id  (save name/nodes/edges/enabled; re-derive trigger)
  fastify.patch('/:id', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; description?: string; nodes?: unknown; edges?: unknown; enabled?: boolean; folderId?: string | null };
    if (!valid(id)) return reply.status(404).send({ error: 'Fluxo não encontrado' });

    const existing = await Flow.findOne({ _id: id, workspaceId }).select('enabled nodes edges trigger.webhookToken').lean();
    if (!existing) return reply.status(404).send({ error: 'Fluxo não encontrado' });

    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.description !== undefined) update.description = body.description;
    if (body.folderId !== undefined) {
      update.folderId = body.folderId && Types.ObjectId.isValid(body.folderId)
        ? new Types.ObjectId(body.folderId)
        : null;
    }
    if (body.nodes !== undefined) {
      update.nodes = body.nodes;
      update.trigger = extractTrigger(body.nodes, existing.trigger?.webhookToken);
      update.instanceId = extractInstance(body.nodes);
    }
    if (body.edges !== undefined) update.edges = body.edges;

    if (body.enabled === true && !existing.enabled) {
      try {
        await assertCanActivateAutomation(workspaceId);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      // Validate against the nodes/edges being saved in this same request (if any),
      // falling back to what's already persisted — either way, publishing must not
      // skip validation just because it happened to arrive alongside a save.
      const validationError = validateForActivation({
        nodes: (body.nodes ?? existing.nodes) as IFlow['nodes'],
        edges: (body.edges ?? existing.edges) as IFlow['edges'],
      });
      if (validationError) return reply.status(400).send({ error: validationError });
      update.enabled = true;
    } else if (body.enabled !== undefined) {
      update.enabled = body.enabled;
    }

    const flow = await Flow.findOneAndUpdate({ _id: id, workspaceId }, { $set: update }, { new: true });
    if (!flow) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    // Turning a flow off must stop any in-flight run for it — otherwise a contact
    // mid-conversation with a flow the operator just disabled (often *because* it
    // was misbehaving) keeps getting messages from it.
    if (body.enabled === false && existing.enabled) {
      await cancelFlowRunsForFlow(id);
    }
    return reply.send(flow.toJSON());
  });

  // POST /api/flows/:id/webhook-token/regenerate — rotate the public trigger token (e.g. after a leak)
  fastify.post('/:id/webhook-token/regenerate', canWrite, async (request, reply) => {
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
  fastify.post('/:id/publish', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    const existing = await Flow.findOne({ _id: id, workspaceId }).select('enabled nodes edges').lean();
    if (!existing) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    if (!existing.enabled) {
      try {
        await assertCanActivateAutomation(workspaceId);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    }
    // Same graph validation as PATCH .../:id with enabled:true — publish is the
    // other place a flow goes live, and previously skipped this entirely: a flow
    // with no entry node, a dangling edge, or an auto-advancing cycle could be
    // published and start running (or flooding) in production.
    const validationError = validateForActivation({ nodes: existing.nodes as IFlow['nodes'], edges: existing.edges as IFlow['edges'] });
    if (validationError) return reply.status(400).send({ error: validationError });

    const flow = await Flow.findOneAndUpdate({ _id: id, workspaceId }, { $set: { enabled: true } }, { new: true });
    if (!flow) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    void notifyWorkspaceOwner(opts.wsGateway, workspaceId, {
      type: 'flow.published', title: 'Fluxo publicado', message: `O fluxo "${flow.name}" foi publicado e está ativo`,
      link: '/automation/flows', metadata: { flowId: id },
    });
    return reply.send(flow.toJSON());
  });

  // DELETE /api/flows/:id
  fastify.delete('/:id', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    const flow = await Flow.findOneAndDelete({ _id: id, workspaceId });
    if (!flow) return reply.status(404).send({ error: 'Fluxo não encontrado' });
    // Runs already in progress for this (now-deleted) flow must not keep going —
    // previously they just hit "flow not found" on their next step.
    await cancelFlowRunsForFlow(id);
    return reply.status(204).send();
  });
}
