import { Instance, Message, Conversation } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import { assertCanCreateInstance } from '../billing/billing.service';

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

    async update(workspaceId: string, instanceId: string, patch: { name?: string; webhookUrl?: string }) {
      const update: Record<string, unknown> = {};
      if (patch.name?.trim()) update.name = patch.name.trim();
      if ('webhookUrl' in patch) update.webhookUrl = patch.webhookUrl?.trim() || undefined;
      const instance = await Instance.findOneAndUpdate({ _id: instanceId, workspaceId }, update, { new: true }).select('-authCreds -authKeys');
      if (!instance) throw new Error('Instância não encontrada');
      return instance;
    },

    async connect(workspaceId: string, instanceId: string) {
      const instance = await Instance.findOne({ _id: instanceId, workspaceId });
      if (!instance) throw new Error('Instância não encontrada');
      if (sessionManager.hasSession(instanceId)) throw new Error('Instância já está conectada');
      await sessionManager.startSession(instanceId);
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
      await Instance.findByIdAndUpdate(instanceId, { status: 'disconnected', qrCode: undefined, pairingCode: undefined });
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

      let session = sessionManager.getSession(instanceId);
      if (!session) {
        session = await sessionManager.startSession(instanceId);
        // Give socket time to initialize before requesting pairing
        await new Promise((r) => setTimeout(r, 2000));
      }
      const code = await session.requestPairingCode(phone.replace(/\D/g, ''));
      return { pairingCode: code };
    },

    async delete(workspaceId: string, instanceId: string) {
      const instance = await Instance.findOne({ _id: instanceId, workspaceId });
      if (!instance) throw new Error('Instância não encontrada');
      await sessionManager.logoutSession(instanceId);
      await Instance.findByIdAndDelete(instanceId);
      return { message: 'Instância excluída' };
    },
  };
}
