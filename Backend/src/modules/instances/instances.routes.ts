import type { FastifyInstance } from 'fastify';
import { Instance, User } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import { createInstancesService } from './instances.service';
import { requireRole } from '../../utils/require-role';
import { debugAccessToken, exchangeEmbeddedSignupCode, registerPhoneNumber, validatePhoneNumber, validateWabaPhoneNumber, getPricingAnalytics } from '../../channels/cloud-api/graph-client';
import { decryptSecret, encryptSecret, last4 } from '../../shared/crypto';
import { FEATURE_FLAGS } from '../../config/feature-flags';

const META_NUMERIC_ID = /^\d+$/;

async function actorInfo(sub: string) {
  const u = await User.findById(sub).lean();
  return u ? { id: sub, name: u.name, email: u.email } : undefined;
}

export async function instancesRoutes(fastify: FastifyInstance, opts: { sessionManager: SessionManager }): Promise<void> {
  const svc = createInstancesService(opts.sessionManager);
  const auth = { preHandler: [fastify.authenticate] };
  // Connecting/disconnecting/deleting the workspace's WhatsApp number is as
  // destructive as it gets (an agent-level DELETE here kills the entire team's
  // attendance) — restrict every mutation to owner/admin, same split already
  // established in conversations.routes.ts. Read access (GET) stays open to any
  // authenticated role so agents can at least see connection status.
  const canWrite = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin'])] };

  // GET /api/instances
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    return reply.send(await svc.list(workspaceId));
  });

  // POST /api/instances
  fastify.post('/', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { name, webhookUrl } = request.body as { name: string; webhookUrl?: string };
    if (!name) return reply.status(400).send({ error: 'Nome é obrigatório' });
    try {
      const instance = await svc.create(workspaceId, name, webhookUrl);
      return reply.status(201).send(instance);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // POST /api/instances/cloud-api — connect a WhatsApp Cloud API (Meta official)
  // number via manually-pasted BYO-WABA credentials.
  fastify.post('/cloud-api', canWrite, async (request, reply) => {
    if (!FEATURE_FLAGS.metaCloudApi) return reply.status(403).send({ error: 'A conexão com a API Oficial da Meta ainda não está disponível.' });
    const { workspaceId } = request.user as { workspaceId: string };
    const { name, phoneNumberId, wabaId, accessToken, businessId } = request.body as
      { name?: string; phoneNumberId?: string; wabaId?: string; accessToken?: string; businessId?: string };
    if (!name?.trim()) return reply.status(400).send({ error: 'Nome é obrigatório' });
    if (!phoneNumberId?.trim() || !wabaId?.trim() || !accessToken?.trim()) {
      return reply.status(400).send({ error: 'Phone Number ID, WABA ID e token de acesso são obrigatórios' });
    }
    if (!META_NUMERIC_ID.test(phoneNumberId.trim()) || !META_NUMERIC_ID.test(wabaId.trim())) {
      return reply.status(400).send({ error: 'Phone Number ID e WABA ID devem conter somente números' });
    }
    if (businessId?.trim() && !META_NUMERIC_ID.test(businessId.trim())) {
      return reply.status(400).send({ error: 'Business Account ID deve conter somente números' });
    }
    try {
      const instance = await svc.createCloudApi(workspaceId, {
        name: name.trim(), phoneNumberId: phoneNumberId.trim(), wabaId: wabaId.trim(),
        accessToken: accessToken.trim(), businessId: businessId?.trim() || undefined,
      });
      return reply.status(201).send(instance);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // POST /api/instances/cloud-api/embedded-signup — completes Meta's hosted
  // onboarding without exposing the platform App Secret to the browser.
  fastify.post('/cloud-api/embedded-signup', canWrite, async (request, reply) => {
    if (!FEATURE_FLAGS.metaCloudApi) return reply.status(403).send({ error: 'A conexão com a API Oficial da Meta ainda não está disponível.' });
    const { workspaceId } = request.user as { workspaceId: string };
    const { name, code, phoneNumberId, wabaId, businessId } = request.body as {
      name?: string; code?: string; phoneNumberId?: string; wabaId?: string; businessId?: string;
    };
    if (!name?.trim() || !code?.trim() || !phoneNumberId?.trim() || !wabaId?.trim()) {
      return reply.status(400).send({ error: 'A Meta não retornou todos os dados necessários para concluir a conexão.' });
    }
    if (!META_NUMERIC_ID.test(phoneNumberId.trim()) || !META_NUMERIC_ID.test(wabaId.trim()) || (businessId?.trim() && !META_NUMERIC_ID.test(businessId.trim()))) {
      return reply.status(400).send({ error: 'A Meta retornou identificadores inválidos para a conta do WhatsApp.' });
    }
    try {
      const accessToken = await exchangeEmbeddedSignupCode(code.trim());
      const tokenInfo = await debugAccessToken(accessToken);
      const requiredScopes = ['whatsapp_business_messaging', 'whatsapp_business_management'];
      const missingScopes = requiredScopes.filter((scope) => !tokenInfo.scopes.includes(scope));
      if (missingScopes.length) throw new Error(`Permissões ausentes no token da Meta: ${missingScopes.join(', ')}`);
      const instance = await svc.createCloudApi(workspaceId, {
        name: name.trim(), phoneNumberId: phoneNumberId.trim(), wabaId: wabaId.trim(),
        businessId: businessId?.trim() || undefined, accessToken,
        tokenExpiresAt: tokenInfo.expiresAt, tokenScopes: tokenInfo.scopes,
      });
      return reply.status(201).send(instance);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // GET /api/instances/:id/webhook-config — the verify token is stripped from
  // every other response (see Instance.model.ts's toJSON) since it's a
  // credential; the workspace owner/admin needs to see it once to paste into
  // the Meta App Dashboard's webhook setup, so it gets its own gated route.
  fastify.get('/:id/webhook-config', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const instance = await svc.getWebhookConfig(workspaceId, id);
    if (!instance) return reply.status(404).send({ error: 'Instância não encontrada ou não é da API Oficial' });
    return reply.send(instance);
  });

  // PATCH /api/instances/:id/app-secret — sets/rotates the Cloud API webhook
  // signing secret. Separate from PATCH /:id (which is channel-agnostic) since
  // this only applies to channel='cloud_api' and needs encryption at rest.
  fastify.patch('/:id/app-secret', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { appSecret } = request.body as { appSecret?: string };
    if (!appSecret?.trim()) return reply.status(400).send({ error: 'App Secret é obrigatório' });
    try {
      const instance = await svc.setAppSecret(workspaceId, id, appSecret.trim());
      return reply.send(instance);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // PATCH /api/instances/:id/access-token — rotates a revoked/expired token.
  // Validate it against both saved identifiers before replacing the encrypted
  // credential, so a typo never takes a previously working instance offline.
  fastify.patch('/:id/access-token', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const accessToken = (request.body as { accessToken?: string }).accessToken?.trim();
    if (!accessToken) return reply.status(400).send({ error: 'Token de acesso é obrigatório' });

    const instance = await Instance.findOne({ _id: id, workspaceId, channel: 'cloud_api' });
    if (!instance?.cloudApi) return reply.status(404).send({ error: 'Instância oficial não encontrada' });

    try {
      const credentials = {
        phoneNumberId: instance.cloudApi.phoneNumberId,
        accessToken,
        graphVersion: instance.cloudApi.graphVersion,
      };
      await validateWabaPhoneNumber(instance.cloudApi.wabaId, instance.cloudApi.phoneNumberId, accessToken, instance.cloudApi.graphVersion);
      const health = await validatePhoneNumber(credentials);

      let tokenExpiresAt: Date | undefined;
      let tokenScopes: string[] | undefined;
      if (process.env.META_APP_ID && process.env.META_APP_SECRET) {
        const tokenInfo = await debugAccessToken(accessToken);
        const requiredScopes = ['whatsapp_business_messaging', 'whatsapp_business_management'];
        const missingScopes = requiredScopes.filter((scope) => !tokenInfo.scopes.includes(scope));
        if (missingScopes.length) throw new Error(`Permissões ausentes no token da Meta: ${missingScopes.join(', ')}`);
        tokenExpiresAt = tokenInfo.expiresAt;
        tokenScopes = tokenInfo.scopes;
      }

      const set: Record<string, unknown> = {
        'cloudApi.accessTokenEnc': encryptSecret(accessToken),
        'cloudApi.tokenLast4': last4(accessToken),
        'cloudApi.displayPhoneNumber': health.displayPhoneNumber,
        'cloudApi.verifiedName': health.verifiedName,
        'cloudApi.qualityRating': health.qualityRating,
        'cloudApi.lastHealthCheckAt': new Date(),
        status: 'connected',
      };
      if (tokenExpiresAt) set['cloudApi.tokenExpiresAt'] = tokenExpiresAt;
      if (tokenScopes) set['cloudApi.tokenScopes'] = tokenScopes;
      const unset: Record<string, 1> = { errorMessage: 1, 'cloudApi.tokenExpiryAlertedAt': 1 };
      if (!tokenExpiresAt) unset['cloudApi.tokenExpiresAt'] = 1;
      if (!tokenScopes) unset['cloudApi.tokenScopes'] = 1;

      await Instance.updateOne({ _id: instance._id }, { $set: set, $unset: unset });
      await opts.sessionManager.restartSession(id);
      return reply.send(await svc.get(workspaceId, id));
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  fastify.post('/:id/register-phone', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { pin } = request.body as { pin?: string };
    if (!pin?.match(/^\d{6}$/)) return reply.status(400).send({ error: 'Informe o PIN de 6 dígitos da verificação em duas etapas.' });
    const instance = await Instance.findOne({ _id: id, workspaceId, channel: 'cloud_api' });
    if (!instance?.cloudApi) return reply.status(404).send({ error: 'Instância oficial não encontrada' });
    try {
      await registerPhoneNumber({
        phoneNumberId: instance.cloudApi.phoneNumberId,
        accessToken: decryptSecret(instance.cloudApi.accessTokenEnc),
        graphVersion: instance.cloudApi.graphVersion,
      }, pin);
      await Instance.updateOne({ _id: instance._id }, { $set: { 'cloudApi.phoneRegisteredAt': new Date() } });
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  fastify.post('/:id/health-check', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const instance = await Instance.findOne({ _id: id, workspaceId, channel: 'cloud_api' }).select('_id');
    if (!instance) return reply.status(404).send({ error: 'Instância oficial não encontrada' });
    try {
      await opts.sessionManager.refreshCloudApiInstanceHealth(id);
      return reply.send(await svc.get(workspaceId, id));
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // GET /api/instances/:id/pricing-analytics?start=&end= — Meta's own reported
  // spend for this WABA (aggregated by day, not per-campaign/message — see
  // graph-client.ts's getPricingAnalytics), for reconciling against the
  // platform's own rate-card estimate (campaigns' Fase C/D).
  fastify.get('/:id/pricing-analytics', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { start, end } = request.query as { start?: string; end?: string };
    const instance = await Instance.findOne({ _id: id, workspaceId, channel: 'cloud_api' });
    if (!instance?.cloudApi) return reply.status(404).send({ error: 'Instância oficial não encontrada' });
    const endDate = end ? new Date(end) : new Date();
    const startDate = start ? new Date(start) : new Date(endDate.getTime() - 30 * 86_400_000);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate >= endDate) {
      return reply.status(400).send({ error: 'Período inválido' });
    }
    try {
      const points = await getPricingAnalytics(instance.cloudApi.wabaId, decryptSecret(instance.cloudApi.accessTokenEnc), { start: startDate, end: endDate }, instance.cloudApi.graphVersion);
      return reply.send({ data: points });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // GET /api/instances/:id
  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const instance = await svc.get(workspaceId, id);
    if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' });
    return reply.send(instance);
  });

  // PATCH /api/instances/:id — rename / update webhook
  fastify.patch('/:id', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; webhookUrl?: string };
    try {
      return reply.send(await svc.update(workspaceId, id, body));
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });

  // POST /api/instances/:id/connect
  fastify.post('/:id/connect', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    try {
      return reply.send(await svc.connect(workspaceId, id));
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // POST /api/instances/:id/disconnect
  fastify.post('/:id/disconnect', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    try {
      return reply.send(await svc.disconnect(workspaceId, id));
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });

  // POST /api/instances/:id/logout
  fastify.post('/:id/logout', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    try {
      return reply.send(await svc.logout(workspaceId, id));
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });

  // POST /api/instances/:id/restart
  fastify.post('/:id/restart', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    try {
      return reply.send(await svc.restart(workspaceId, id));
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });

  // POST /api/instances/:id/pair  — request pairing code
  fastify.post('/:id/pair', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { phone } = request.body as { phone: string };
    if (!phone) return reply.status(400).send({ error: 'Telefone é obrigatório' });
    try {
      return reply.send(await svc.requestPairingCode(workspaceId, id, phone));
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // DELETE /api/instances/:id
  fastify.delete('/:id', canWrite, async (request, reply) => {
    const { workspaceId, sub } = request.user as { workspaceId: string; sub: string };
    const { id } = request.params as { id: string };
    try {
      const actor = await actorInfo(sub);
      return reply.send(await svc.delete(workspaceId, id, actor));
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });
}
