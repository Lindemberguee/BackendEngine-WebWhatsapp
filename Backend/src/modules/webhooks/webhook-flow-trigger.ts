import pino from 'pino';
import { Flow, FlowRun, Contact, Conversation, WebhookInboundLog } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class WebhookTriggerError extends Error {
  constructor(message: string, public status: number = 400) { super(message); }
}

/**
 * Entry point for a flow's public webhook trigger (POST /api/webhooks/in/:token).
 * Unlike triggerCrmFlow (which requires an existing conversation), this creates the
 * contact/conversation on demand — the whole point is letting an external system
 * (CRM, e-commerce, Zapier/Make) kick off a flow for a phone number it already has,
 * without that contact having messaged first.
 */
export async function triggerWebhookFlow(
  sessionManager: SessionManager,
  token: string,
  payload: { phone?: string; name?: string; [key: string]: unknown }
): Promise<{ conversationId: string }> {
  const flow = await Flow.findOne({ 'trigger.webhookToken': token });
  // An unknown token gets no log entry — logging it would just let anyone guessing
  // tokens fill up the log, with no useful workspace/flow context to show for it.
  if (!flow) throw new WebhookTriggerError('Webhook não encontrado', 404);

  const workspaceId = flow.workspaceId.toString();
  const flowId = flow._id.toString();

  try {
    if (!flow.enabled) throw new WebhookTriggerError('Este fluxo está desativado', 409);
    if (flow.trigger?.type !== 'webhook') throw new WebhookTriggerError('Este fluxo não tem um gatilho de webhook', 409);
    if (!flow.instanceId) throw new WebhookTriggerError('Selecione uma instância no bloco "Instância" do fluxo antes de usar o gatilho de webhook', 422);

    const cleanPhone = (payload.phone ?? '').replace(/\D/g, '');
    if (!cleanPhone) throw new WebhookTriggerError('Campo "phone" é obrigatório', 400);

    const instanceId = flow.instanceId.toString();

    const session = await sessionManager.ensureSession(instanceId);
    const ready = await session.waitUntilReady(8000);
    if (!ready) throw new WebhookTriggerError('WhatsApp reconectando. Tente novamente em alguns segundos.', 503);

    const jid = `${cleanPhone}@s.whatsapp.net`;
    const name = (payload.name ?? '').trim() || cleanPhone;

    const contact = await Contact.findOneAndUpdate(
      { workspaceId, jid },
      { $setOnInsert: { workspaceId, jid, phone: cleanPhone, source: 'api' }, $set: { name } },
      { upsert: true, new: true }
    );

    const conversation = await Conversation.findOneAndUpdate(
      { workspaceId, jid },
      {
        $setOnInsert: { workspaceId, jid, isGroup: false, phone: cleanPhone, contactId: contact._id, instanceId: flow.instanceId },
        $set: { name },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const activeRun = await FlowRun.exists({ conversationId: conversation._id.toString(), status: { $in: ['running', 'waiting'] } });
    if (activeRun) {
      logger.info({ conversationId: conversation._id.toString() }, '[webhooks] flow already running for this conversation — skipping trigger');
      await logInbound(workspaceId, flowId, flow.name, 'success', payload, conversation._id.toString());
      return { conversationId: conversation._id.toString() };
    }

    const { phone: _phone, name: _name, ...customFields } = payload;
    await session.triggerFlow(flow, {
      conversationId: conversation._id.toString(),
      jid,
      contact: { name, phone: cleanPhone },
      _inheritedVariables: customFields,
    });

    await logInbound(workspaceId, flowId, flow.name, 'success', payload, conversation._id.toString());
    return { conversationId: conversation._id.toString() };
  } catch (err) {
    const message = err instanceof WebhookTriggerError ? err.message : (err as Error).message;
    await logInbound(workspaceId, flowId, flow.name, 'error', payload, undefined, message);
    throw err;
  }
}

/** Best-effort — a logging failure must never mask the real error/result from the caller. */
async function logInbound(
  workspaceId: string, flowId: string, flowName: string, status: 'success' | 'error',
  payload: Record<string, unknown>, conversationId?: string, error?: string
): Promise<void> {
  try {
    await WebhookInboundLog.create({ workspaceId, flowId, flowName, status, payload, conversationId, error });
  } catch (err) {
    logger.warn({ err, flowId }, '[webhooks] failed to write inbound log');
  }
}

export function isValidWebhookToken(token: string): boolean {
  return typeof token === 'string' && /^[a-f0-9]{48}$/.test(token);
}
