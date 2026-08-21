import type { FastifyInstance } from 'fastify';
import { Instance, WhatsAppTemplate } from '../../db/models';
import { requireRole } from '../../utils/require-role';
import { decryptSecret } from '../../shared/crypto';
import { listTemplates, createTemplate, deleteTemplate, GraphApiError, type RemoteTemplate } from '../../channels/cloud-api/graph-client';
import { FEATURE_FLAGS } from '../../config/feature-flags';

/** Counts the highest {{n}} placeholder across every component's text — the
 *  number of variable inputs the campaign/flow UI needs to render. Meta
 *  numbers placeholders from 1, so the count IS the highest n found. */
function deriveVariableCount(components: unknown): number {
  if (!Array.isArray(components)) return 0;
  let max = 0;
  for (const c of components as Array<{ text?: string }>) {
    const matches = String(c?.text ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g);
    for (const m of matches) max = Math.max(max, Number(m[1]) || 0);
  }
  return max;
}

export async function templatesRoutes(fastify: FastifyInstance): Promise<void> {
  // Locked for launch (see feature-flags.ts) — rejects every route in this
  // plugin with 403 even if called directly, not just hidden in the UI.
  fastify.addHook('preHandler', async (_request, reply) => {
    if (!FEATURE_FLAGS.templates) return reply.status(403).send({ error: 'Templates ainda não estão disponíveis.' });
  });

  const auth = { preHandler: [fastify.authenticate] };
  // Sync spends a real Graph API call and writes to the DB — same write-role
  // split used everywhere else that touches an external credential (flows'
  // webhook token regen, instances connect/pair).
  const canWrite = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin'])] };

  // GET /api/templates?instanceId=&status=
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { instanceId, status } = request.query as { instanceId?: string; status?: string };
    const filter: Record<string, unknown> = { workspaceId };
    if (instanceId) filter.instanceId = instanceId;
    if (status) filter.status = status;
    const templates = await WhatsAppTemplate.find(filter).sort({ name: 1 });
    return reply.send({ data: templates });
  });

  // POST /api/templates/:instanceId/sync — pulls the current template list from
  // the Meta Graph API and replaces the local cache for this instance.
  fastify.post('/:instanceId/sync', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { instanceId } = request.params as { instanceId: string };

    const instance = await Instance.findOne({ _id: instanceId, workspaceId });
    if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' });
    if (instance.channel !== 'cloud_api' || !instance.cloudApi) {
      return reply.status(400).send({ error: 'Templates só existem para instâncias da API Oficial da Meta' });
    }

    let remote: RemoteTemplate[];
    try {
      const accessToken = decryptSecret(instance.cloudApi.accessTokenEnc);
      remote = await listTemplates(instance.cloudApi.wabaId, accessToken, instance.cloudApi.graphVersion);
    } catch (err) {
      const message = err instanceof GraphApiError ? err.message : 'Falha ao buscar templates da Meta';
      return reply.status(502).send({ error: message });
    }

    const syncedAt = new Date();
    await Promise.all(remote.map((t) =>
      WhatsAppTemplate.findOneAndUpdate(
        { workspaceId, instanceId, name: t.name, language: t.language },
        {
          $set: {
            category: t.category, status: t.status, components: t.components,
            variableCount: deriveVariableCount(t.components), syncedAt,
          },
        },
        { upsert: true }
      )
    ));
    // Anything not touched by this sync no longer exists on the WABA (deleted,
    // renamed) — drop it so the picker never offers a template that would 404.
    await WhatsAppTemplate.deleteMany({ workspaceId, instanceId, syncedAt: { $lt: syncedAt } });

    const templates = await WhatsAppTemplate.find({ workspaceId, instanceId }).sort({ name: 1 });
    return reply.send({ data: templates });
  });

  fastify.post('/:instanceId', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { instanceId } = request.params as { instanceId: string };
    const body = request.body as { name?: string; language?: string; category?: string; components?: unknown[] };
    if (!body.name?.match(/^[a-z0-9_]+$/) || !body.language || !body.category || !Array.isArray(body.components) || !body.components.length) {
      return reply.status(400).send({ error: 'Nome, idioma, categoria e componentes válidos são obrigatórios.' });
    }
    const instance = await Instance.findOne({ _id: instanceId, workspaceId, channel: 'cloud_api' });
    if (!instance?.cloudApi) return reply.status(404).send({ error: 'Instância oficial não encontrada' });
    try {
      const token = decryptSecret(instance.cloudApi.accessTokenEnc);
      const remote = await createTemplate(instance.cloudApi.wabaId, token, {
        name: body.name, language: body.language, category: body.category, components: body.components,
      }, instance.cloudApi.graphVersion);
      const template = await WhatsAppTemplate.findOneAndUpdate(
        { workspaceId, instanceId, name: body.name, language: body.language },
        { $set: { category: remote.category ?? body.category, status: remote.status ?? 'PENDING', components: body.components, variableCount: deriveVariableCount(body.components), syncedAt: new Date() } },
        { upsert: true, new: true }
      );
      return reply.status(201).send({ data: template });
    } catch (err) {
      return reply.status(502).send({ error: err instanceof GraphApiError ? err.message : 'Falha ao criar template na Meta' });
    }
  });

  fastify.delete('/:instanceId/:name', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { instanceId, name } = request.params as { instanceId: string; name: string };
    const instance = await Instance.findOne({ _id: instanceId, workspaceId, channel: 'cloud_api' });
    if (!instance?.cloudApi) return reply.status(404).send({ error: 'Instância oficial não encontrada' });
    try {
      await deleteTemplate(instance.cloudApi.wabaId, decryptSecret(instance.cloudApi.accessTokenEnc), name, instance.cloudApi.graphVersion);
      await WhatsAppTemplate.deleteMany({ workspaceId, instanceId, name });
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(502).send({ error: err instanceof GraphApiError ? err.message : 'Falha ao excluir template na Meta' });
    }
  });
}
