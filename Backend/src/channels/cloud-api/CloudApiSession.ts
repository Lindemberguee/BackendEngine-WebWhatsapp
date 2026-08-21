import pino from 'pino';
import { Instance, Conversation, Message, type IFlow, type MessageType } from '../../db/models';
import type { WebSocketGateway } from '../../ws/gateway';
import type { IChannelSession, ChannelKind, TriggerFlowParams } from '../types';
import type { OutboundMessage } from '../../messaging/outbound-types';
import { parseJid } from '../../utils/message.utils';
import { decryptSecret } from '../../shared/crypto';
import { validatePhoneNumber, validateWabaPhoneNumber, subscribeAppToWaba, sendCloudApiMessage, GraphApiError } from './graph-client';
import { toCloudApi } from './to-cloud-api';

const WINDOW_MS = 24 * 60 * 60 * 1000;

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * WhatsApp Cloud API session — no persistent socket (unlike Baileys), just
 * validated credentials and an HTTP client. "Connected" means the last
 * credential check against the Graph API succeeded.
 *
 * Sending enforces the 24h customer-service window (see sendMessage) and
 * media is link-based only (Meta fetches the URL itself — no upload flow yet).
 * Flow dispatch (triggerFlow/continueDelayedFlowRun/continueTimedOutFlowRun)
 * still isn't wired up — a flow attached to a Cloud API instance won't run
 * until that lands; inbound messages are still stored/shown/routed normally.
 */
export class CloudApiSession implements IChannelSession {
  readonly channel: ChannelKind = 'cloud_api';
  private ready = false;
  private destroyed = false;

  constructor(
    public readonly instanceId: string,
    private readonly wsGateway: WebSocketGateway,
    private readonly onLoggedOut?: () => void
  ) {}

  async connect(): Promise<void> {
    const instance = await Instance.findById(this.instanceId);
    if (!instance) throw new Error(`Instance ${this.instanceId} not found`);
    if (!instance.cloudApi) throw new Error(`Instance ${this.instanceId} has no Cloud API credentials configured`);

    const workspaceId = instance.workspaceId.toString();
    await Instance.updateOne({ _id: this.instanceId }, { $set: { status: 'connecting' }, $unset: { errorMessage: 1 } });
    this.wsGateway.broadcastInstanceStatus(workspaceId, this.instanceId, 'connecting');

    try {
      const accessToken = decryptSecret(instance.cloudApi.accessTokenEnc);
      await validateWabaPhoneNumber(
        instance.cloudApi.wabaId,
        instance.cloudApi.phoneNumberId,
        accessToken,
        instance.cloudApi.graphVersion
      );
      const { displayPhoneNumber, verifiedName, qualityRating } = await validatePhoneNumber({
        phoneNumberId: instance.cloudApi.phoneNumberId,
        accessToken,
        graphVersion: instance.cloudApi.graphVersion,
      });
      await subscribeAppToWaba(instance.cloudApi.wabaId, accessToken, instance.cloudApi.graphVersion);
      this.ready = true;
      const phone = displayPhoneNumber ?? instance.cloudApi.displayPhoneNumber;
      await Instance.updateOne({ _id: this.instanceId }, {
        $set: {
          status: 'connected', lastConnectedAt: new Date(), ...(phone ? { phone } : {}),
          'cloudApi.displayPhoneNumber': displayPhoneNumber,
          'cloudApi.verifiedName': verifiedName,
          'cloudApi.qualityRating': qualityRating,
          'cloudApi.webhookSubscribed': true,
          'cloudApi.lastHealthCheckAt': new Date(),
        },
      });
      this.wsGateway.broadcastInstanceStatus(workspaceId, this.instanceId, 'connected', { phone });
      logger.info({ instanceId: this.instanceId }, '[CloudApiSession] Connected');
    } catch (err) {
      this.ready = false;
      const message = err instanceof GraphApiError ? err.message : 'Falha ao validar credenciais da Meta';
      await Instance.updateOne({ _id: this.instanceId }, { $set: { status: 'error', errorMessage: message } });
      this.wsGateway.broadcastInstanceStatus(workspaceId, this.instanceId, 'error', { errorMessage: message });
      throw err;
    }
  }

  async sendMessage(jid: string, msg: OutboundMessage, options?: unknown): Promise<{ providerMessageId?: string; raw?: unknown }> {
    const instance = await Instance.findById(this.instanceId);
    if (!instance?.cloudApi) throw new Error('Instância da API Oficial não encontrada ou sem credenciais');

    // Outside the 24h customer-service window, Meta only accepts an approved
    // template — anything else is rejected by the Graph API itself, but
    // checking here first gives a much clearer error than Meta's raw 131047.
    if (msg.kind !== 'template') {
      const conv = await Conversation.findOne({ workspaceId: instance.workspaceId, instanceId: instance._id, jid }).select('lastInboundAt').lean();
      const withinWindow = conv?.lastInboundAt && Date.now() - conv.lastInboundAt.getTime() < WINDOW_MS;
      if (!withinWindow) {
        throw new Error('Fora da janela de 24h — só é possível enviar um template aprovado para este contato.');
      }
    }

    const translated = toCloudApi(msg);
    if (!translated) return {};
    const quotedId = (options as { quoted?: { key?: { id?: string } } } | undefined)?.quoted?.key?.id;
    const body = quotedId ? { ...translated, context: { message_id: quotedId } } : translated;

    const accessToken = decryptSecret(instance.cloudApi.accessTokenEnc);
    const to = parseJid(jid);
    try {
      const result = await sendCloudApiMessage(
        { phoneNumberId: instance.cloudApi.phoneNumberId, accessToken, graphVersion: instance.cloudApi.graphVersion },
        to,
        body
      );
      return { providerMessageId: result.id, raw: result };
    } catch (err) {
      throw err instanceof GraphApiError ? new Error(err.message) : err;
    }
  }

  isReady(): boolean {
    return this.ready && !this.destroyed;
  }

  async waitUntilReady(timeoutMs = 8000): Promise<boolean> {
    if (this.isReady()) return true;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.isReady()) return true;
      if (this.destroyed) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
    return this.isReady();
  }

  /** Clears the stored credentials, mirroring Baileys' logout (fully unlinks —
   *  reconnecting requires pasting the credentials again, same as re-scanning a QR). */
  async logout(): Promise<void> {
    this.destroyed = true;
    this.ready = false;
    await Instance.updateOne({ _id: this.instanceId }, { $set: { status: 'disconnected' }, $unset: { cloudApi: 1, errorMessage: 1 } });
    this.onLoggedOut?.();
  }

  disconnect(): void {
    this.destroyed = true;
    this.ready = false;
  }

  private makeFlowSend() {
    return async (jid: string, content: unknown) => {
      const outbound = content as OutboundMessage;
      const sent = await this.sendMessage(jid, outbound);
      const instance = await Instance.findById(this.instanceId).select('workspaceId').lean();
      const conversation = instance
        ? await Conversation.findOne({ workspaceId: instance.workspaceId, instanceId: this.instanceId, jid })
        : null;
      if (instance && conversation && sent.providerMessageId) {
        const type: MessageType = ['image', 'video', 'audio', 'document', 'location', 'contact', 'reaction'].includes(outbound.kind)
          ? outbound.kind as MessageType
          : outbound.kind === 'buttons' || outbound.kind === 'list' || outbound.kind === 'cta' ? 'interactive' : 'text';
        const preview = outbound.kind === 'text' ? outbound.text
          : outbound.kind === 'template' ? `Template: ${outbound.templateName}`
          : 'caption' in outbound && outbound.caption ? outbound.caption
          : 'body' in outbound && typeof outbound.body === 'string' ? outbound.body
          : `[${type}]`;
        const storedContent = {
          text: preview,
          ...(outbound.kind === 'template' ? { template: { name: outbound.templateName, language: outbound.language, components: outbound.components } } : {}),
          ...('url' in outbound ? { url: outbound.url } : {}),
        };
        const message = await Message.create({
          workspaceId: instance.workspaceId, instanceId: this.instanceId, conversationId: conversation._id,
          jid, messageId: sent.providerMessageId, direction: 'outbound', type, status: 'sent', fromMe: true, content: storedContent,
        });
        await Conversation.updateOne({ _id: conversation._id }, { $set: { lastMessage: { content: preview, type, direction: 'outbound', timestamp: new Date() } } });
        this.wsGateway.broadcastToConversationVisibility(instance.workspaceId.toString(), conversation.assignedAgentId?.toString(), 'message:new', {
          conversationId: conversation._id.toString(),
          message: { id: message._id.toString(), conversationId: conversation._id.toString(), type, content: message.content, direction: 'outbound', status: 'sent', timestamp: message.createdAt.toISOString() },
        });
      }
      return sent.providerMessageId ? { key: { id: sent.providerMessageId } } : undefined;
    };
  }

  async sendFlowMessage(jid: string, msg: OutboundMessage): Promise<{ key?: { id?: string } } | undefined> {
    return this.makeFlowSend()(jid, msg);
  }

  async triggerFlow(flow: IFlow, params: TriggerFlowParams): Promise<void> {
    const instance = await Instance.findById(this.instanceId).select('workspaceId').lean();
    if (!instance) throw new Error('Instância da API Oficial não encontrada');
    const { FlowRunner } = await import('../../flow-executor');
    const runner = new FlowRunner({ sendMessage: this.makeFlowSend(), wsGateway: this.wsGateway });
    await runner.start(flow, {
      workspaceId: instance.workspaceId.toString(), instanceId: this.instanceId,
      conversationId: params.conversationId, jid: params.jid, contact: params.contact,
      _inheritedVariables: params._inheritedVariables,
      _scheduledEventSourceAt: params._scheduledEventSourceAt,
    });
  }

  async continueDelayedFlowRun(runId: string): Promise<void> {
    const { FlowRunner } = await import('../../flow-executor');
    await new FlowRunner({ sendMessage: this.makeFlowSend(), wsGateway: this.wsGateway }).continueDelayed(runId);
  }

  async continueTimedOutFlowRun(runId: string): Promise<void> {
    const { FlowRunner } = await import('../../flow-executor');
    await new FlowRunner({ sendMessage: this.makeFlowSend(), wsGateway: this.wsGateway }).continueTimedOut(runId);
  }
}
