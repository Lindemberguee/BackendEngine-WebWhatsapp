import type { IFlow } from '../db/models';
import type { OutboundMessage } from '../messaging/outbound-types';
import type { RunnerDeps } from '../flow-executor/runner';

export type ChannelKind = 'baileys' | 'cloud_api';

export interface TriggerFlowParams {
  conversationId: string;
  jid: string;
  contact: { name?: string; phone?: string };
  /** Extra variables to seed the run with (e.g. a webhook trigger's custom payload fields). */
  _inheritedVariables?: Record<string, unknown>;
  /** scheduled trigger only — see FlowRunner.start(). */
  _scheduledEventSourceAt?: Date;
}

/**
 * The channel-neutral contract every messaging session must satisfy — derived
 * from the actual surface `SessionManager`/routes/flow-executor/campaigns
 * consume today (BaileysSession has always implemented this shape, just not
 * as a named interface). A second implementation (CloudApiSession, WhatsApp
 * Cloud API) plugs in here without touching any call site that only depends
 * on this interface.
 */
export interface IChannelSession {
  readonly instanceId: string;
  readonly channel: ChannelKind;

  connect(): Promise<void>;
  /** Translates the neutral IR (messaging/outbound-types.ts) to the channel's
   *  wire format and sends it. */
  sendMessage(jid: string, msg: OutboundMessage, options?: unknown): Promise<{ providerMessageId?: string; raw?: unknown }>;
  /** Flow send that also persists/broadcasts providers without an outbound echo. */
  sendFlowMessage?(jid: string, msg: OutboundMessage): Promise<{ key?: { id?: string } } | undefined>;
  isReady(): boolean;
  waitUntilReady(timeoutMs?: number): Promise<boolean>;
  logout(): Promise<void>;
  disconnect(): void;

  triggerFlow(flow: IFlow, params: TriggerFlowParams): Promise<void>;
  continueDelayedFlowRun(runId: string): Promise<void>;
  continueTimedOutFlowRun(runId: string): Promise<void>;

  // Capabilities only some channels expose — callers must feature-detect
  // (`session.checkOnWhatsApp?.(...)`) rather than assume every channel has them.
  /** Baileys only — the Cloud API has no equivalent lookup; number validity is
   *  only known from the send's own success/failure. */
  checkOnWhatsApp?(...jids: string[]): Promise<Array<{ exists: boolean; jid: string }> | undefined>;
  /** Baileys only — pairing-code linking has no Cloud API equivalent. */
  requestPairingCode?(phone: string): Promise<string>;
  /** Baileys only — used as `reuploadRequest` when re-downloading expired media. */
  readonly updateMediaMessage?: unknown;
  /** Baileys only — raw, provider-shaped send for capabilities the neutral IR
   *  doesn't cover yet (message delete/revoke, uploaded-buffer media, reactions). */
  sendRaw?(jid: string, content: unknown, options?: unknown): Promise<unknown>;
}

export type { RunnerDeps };
