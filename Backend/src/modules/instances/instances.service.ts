import { Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { Instance, Message, Conversation, Campaign, AuditLog } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import { assertCanCreateInstance, assertOfficialChannelEnabled } from '../billing/billing.service';
import { encryptSecret, last4 } from '../../shared/crypto';

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v25.0';

type Actor = { id: string; name: string; email: string };

/** Attaches real, computed usage stats to an instance response — no fabricated numbers. */
async function withStats(instanceDoc: { toJSON: () => Record<string, unknown> } | null) {
  if (!instanceDoc) return null;
  const instance = instanceDoc.toJSON();
  const instanceId = instance.id as string;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [sent, received, todayCount, conversationsTotal] = await Promise.all([
    Message.countDocuments({ instanceId, direction: 'outbound' }),
    Message.countDocuments({ instanceId, direction: 'inbound' }),
    Message.countDocuments({ instanceId, createdAt: { $gte: todayStart } }),
    Conversation.countDocuments({ instanceId }),
  ]);

  return {
    ...instance,
    stats: { messagesSent: sent, messagesReceived: received, messagesToday: todayCount, conversationsTotal },
  };
}

export function createInstancesService(sessionManager: SessionManager) {
  return {
    async list(workspaceId: string) {
      const docs = await Instance.find({ workspaceId }).select('-authCreds -authKeys').sort({ createdAt: -1 });
      return Promise.all(docs.map((d) => withStats(d)));
    },

    async get(workspaceId: string, instanceId: string) {
      const doc = await Instance.findOne({ _id: instanceId, workspaceId }).select('-authCreds -authKeys');
      return withStats(doc);
    },

    async create(workspaceId: string, name: string, webhookUrl?: string) {
      await assertCanCreateInstance(workspaceId);
      const instance = await Instance.create({ workspaceId, name, webhookUrl, status: 'disconnected' });
      // Auto-start session to generate QR code immediately (fire-and-forget)
      sessionManager.startSession(instance._id.toString()).catch(() => {});
      return instance;
    },

    /**
     * Creates a channel='cloud_api' instance from manually-pasted BYO-WABA
     * credentials (Phone Number ID, WABA ID, access token) — the "colar
     * credenciais" onboarding path. Access token is encrypted at rest and
     * never returned again; validation against the Graph API happens via
     * sessionManager.startSession() → CloudApiSession.connect() right after,
     * same as how a Baileys instance validates by actually trying to connect.
     */
    async createCloudApi(workspaceId: string, params: { name: string; phoneNumberId: string; wabaId: string; accessToken: string; businessId?: string; tokenExpiresAt?: Date; tokenScopes?: string[] }) {
      await assertCanCreateInstance(workspaceId);
      await assertOfficialChannelEnabled(workspaceId);
      const instance = await Instance.create({
        workspaceId,
        name: params.name,
        channel: 'cloud_api',
        status: 'disconnected',
        cloudApi: {
          phoneNumberId: params.phoneNumberId,
          wabaId: params.wabaId,
          businessId: params.businessId,
          accessTokenEnc: encryptSecret(params.accessToken),
          // appSecretEnc is required by the schema/type for the webhook HMAC step
          // (a later stage) but isn't collected in this manual-credentials flow yet —
          // stored empty until that UI field is added; the webhook route treats an
          // empty secret as "signature verification not yet configured".
          appSecretEnc: encryptSecret(process.env.META_APP_SECRET ?? ''),
          verifyToken: randomBytes(24).toString('hex'),
          tokenLast4: last4(params.accessToken),
          graphVersion: DEFAULT_GRAPH_VERSION,
          tokenExpiresAt: params.tokenExpiresAt,
          tokenScopes: params.tokenScopes,
        },
      });
      // Validate the credentials immediately (fire-and-forget, same pattern as
      // the Baileys create() below) — errors surface via status/errorMessage on
      // the instance, picked up by the frontend's existing polling/WS status flow.
      sessionManager.startSession(instance._id.toString()).catch(() => {});
      return instance;
    },

    /** The verify token + webhook path an owner/admin pastes into the Meta App
     *  Dashboard's WhatsApp webhook configuration for this instance. */
    async getWebhookConfig(workspaceId: string, instanceId: string) {
      const instance = await Instance.findOne({ _id: instanceId, workspaceId, channel: 'cloud_api' }).select('cloudApi').lean();
      if (!instance?.cloudApi) return null;
      const sharedVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
      const webhookPath = sharedVerifyToken
        ? '/api/webhooks/meta'
        : `/api/webhooks/meta/${instanceId}`;
      const publicApiUrl = process.env.PUBLIC_API_URL?.replace(/\/$/, '');
      return {
        instanceId,
        webhookPath,
        webhookUrl: publicApiUrl ? `${publicApiUrl}${webhookPath}` : undefined,
        legacyWebhookPath: `/api/webhooks/meta/${instanceId}`,
        verifyToken: sharedVerifyToken || instance.cloudApi.verifyToken,
      };
    },

    /** Sets/rotates the App Secret used to verify Meta's `X-Hub-Signature-256`
     *  on inbound webhook deliveries (see webhooks-meta.routes.ts). Its own
     *  method — deliberately not folded into update() — since it only exists
     *  for channel='cloud_api' and needs encryption, unlike every other
     *  updatable instance field. */
    async setAppSecret(workspaceId: string, instanceId: string, appSecret: string) {
      const instance = await Instance.findOneAndUpdate(
        { _id: instanceId, workspaceId, channel: 'cloud_api' },
        { $set: { 'cloudApi.appSecretEnc': encryptSecret(appSecret) } },
        { new: true }
      ).select('-authCreds -authKeys');
      if (!instance) throw new Error('Instância não encontrada ou não é da API Oficial');
      return instance;
    },

    async update(workspaceId: string, instanceId: string, patch: { name?: string; webhookUrl?: string }) {
      // `$set: { field: undefined }` is silently dropped by the Mongo driver — it
      // does NOT clear the field. Clearing webhookUrl (an empty string in the
      // patch) needs an actual $unset, or it was impossible to ever remove one
      // once set.
      const set: Record<string, unknown> = {};
      const unset: Record<string, unknown> = {};
      if (patch.name?.trim()) set.name = patch.name.trim();
      if ('webhookUrl' in patch) {
        const trimmed = patch.webhookUrl?.trim();
        if (trimmed) set.webhookUrl = trimmed;
        else unset.webhookUrl = 1;
      }
      const update: Record<string, unknown> = {};
      if (Object.keys(set).length) update.$set = set;
      if (Object.keys(unset).length) update.$unset = unset;
      const instance = await Instance.findOneAndUpdate({ _id: instanceId, workspaceId }, update, { new: true }).select('-authCreds -authKeys');
      if (!instance) throw new Error('Instância não encontrada');
      return instance;
    },

    async connect(workspaceId: string, instanceId: string) {
      const instance = await Instance.findOne({ _id: instanceId, workspaceId });
      if (!instance) throw new Error('Instância não encontrada');
      // A session stays "in memory" (SessionManager.hasSession) the whole time it's
      // connecting, showing a QR, backing off after an error, etc. — not just once
      // it's actually connected. Rejecting on any of those with "já está conectada"
      // made the frontend's "atualizar QR" (retry) button fail 400 every single
      // time — the exact scenario a QR refresh happens in. Only a genuinely
      // connected instance should refuse a redundant connect(); every other
      // in-memory state should restart the session to produce a fresh QR.
      if (instance.status === 'connected') throw new Error('Instância já está conectada');
      if (sessionManager.hasSession(instanceId)) {
        await sessionManager.restartSession(instanceId);
      } else {
        await sessionManager.startSession(instanceId);
      }
      return { message: 'Conectando...' };
    },

    async disconnect(workspaceId: string, instanceId: string) {
      const instance = await Instance.findOne({ _id: instanceId, workspaceId });
      if (!instance) throw new Error('Instância não encontrada');
      await sessionManager.disconnectSession(instanceId);
      await Instance.findByIdAndUpdate(instanceId, { status: 'disconnected' });
      return { message: 'Desconectado' };
    },

    /** Unlike disconnect(), invalidates the saved WhatsApp session — reconnecting requires a fresh QR/pairing scan. */
    async logout(workspaceId: string, instanceId: string) {
      const instance = await Instance.findOne({ _id: instanceId, workspaceId });
      if (!instance) throw new Error('Instância não encontrada');
      await sessionManager.logoutSession(instanceId);
      // Same $set/undefined pitfall as update() above — qrCode/pairingCode were
      // never actually cleared, so a logged-out instance kept showing (and the
      // API kept returning) a stale, already-invalid QR/pairing code forever.
      await Instance.findByIdAndUpdate(instanceId, { $set: { status: 'disconnected' }, $unset: { qrCode: 1, pairingCode: 1 } });
      return { message: 'Sessão encerrada' };
    },

    async restart(workspaceId: string, instanceId: string) {
      const instance = await Instance.findOne({ _id: instanceId, workspaceId });
      if (!instance) throw new Error('Instância não encontrada');
      await sessionManager.restartSession(instanceId);
      return { message: 'Reiniciando...' };
    },

    async requestPairingCode(workspaceId: string, instanceId: string, phone: string) {
      const instance = await Instance.findOne({ _id: instanceId, workspaceId });
      if (!instance) throw new Error('Instância não encontrada');
      // requestPairingCode overwrites authState.creds.me with the given phone
      // number (see BaileysSession.requestPairingCode) — issuing it against an
      // already-connected instance silently repoints its live, working session at
      // a different number's identity and corrupts it. Block explicitly.
      if (instance.status === 'connected') {
        throw new Error('Instância já está conectada — desconecte antes de parear outro número');
      }

      const cleanPhone = phone.replace(/\D/g, '');
      if (cleanPhone.length < 10 || cleanPhone.length > 15) throw new Error('Telefone inválido');

      const session = sessionManager.getSession(instanceId) ?? await sessionManager.startSession(instanceId);

      // The socket object exists as soon as startSession() resolves, but the
      // underlying WebSocket handshake to WhatsApp's servers may not have finished
      // yet — requestPairingCode can fail in that narrow window. A single fixed
      // 2s guess either wasted time when the socket was already ready, or wasn't
      // long enough on a slow connection. Retry with a short backoff instead.
      let lastErr: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const code = await session.requestPairingCode!(cleanPhone);
          return { pairingCode: code };
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('Falha ao gerar código de pareamento');
    },

    async delete(workspaceId: string, instanceId: string, actor?: Actor) {
      const instance = await Instance.findOne({ _id: instanceId, workspaceId });
      if (!instance) throw new Error('Instância não encontrada');

      // logoutSession() is a no-op when the session isn't currently loaded in
      // memory (e.g. it errored out and got evicted, or the process just
      // restarted) — deleting in that state previously left the WhatsApp number
      // still linked on the customer's phone forever, with no way to unlink it
      // from the app anymore. Spin up a session first so logout can actually
      // reach WhatsApp's servers; best-effort — the instance is deleted either way.
      try {
        if (!sessionManager.hasSession(instanceId)) {
          const session = await sessionManager.ensureSession(instanceId);
          await session.waitUntilReady(5000);
        }
        await sessionManager.logoutSession(instanceId);
      } catch { /* best-effort device unlink — still proceed with deletion */ }

      await Instance.findByIdAndDelete(instanceId);

      // Previously left every Conversation/Message pointing at this instanceId
      // dangling forever — send-message.service.ts only falls back to another
      // instance when instanceId is *absent*, so those conversations became
      // permanently unusable (every send threw "Instance not found"). Clearing it
      // lets them recover via the normal fallback-instance path. Also detach from
      // any campaign still referencing this instance.
      await Promise.all([
        Conversation.updateMany({ workspaceId, instanceId }, { $unset: { instanceId: 1 } }).catch(() => {}),
        Campaign.updateMany({ workspaceId }, { $pull: { instanceIds: new Types.ObjectId(instanceId) } }).catch(() => {}),
      ]);

      if (actor) {
        await AuditLog.create({
          workspaceId: new Types.ObjectId(workspaceId),
          actor: { id: new Types.ObjectId(actor.id), name: actor.name, email: actor.email },
          type: 'instance.deleted',
          target: { type: 'instance', id: instanceId, label: instance.name },
        }).catch(() => {});
      }

      return { message: 'Instância excluída' };
    },
  };
}
