import type { MessageType } from '../../db/models';

/**
 * Meta's WhatsApp Cloud API webhook payload — typed just enough to extract
 * what ingestInboundMessage() needs. Meta's actual schema has many more
 * fields per message type; this covers the ones that matter for showing the
 * message in the inbox today. Full per-type fidelity (media captions, contact
 * cards, reactions) can be extended here without touching ingest-inbound.ts.
 */
export interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: Array<Record<string, unknown>>;
        statuses?: Array<{
          id?: string; status?: string; timestamp?: string; recipient_id?: string;
          errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
        }>;
      };
    }>;
  }>;
}

export interface NormalizedMetaMessage {
  jid: string;
  phone: string;
  messageId: string;
  type: MessageType;
  text: string;
  content: Record<string, unknown>;
  contactName?: string;
  timestamp: Date;
  providerMessage: Record<string, unknown>;
  quoted?: { messageId: string; type: MessageType; preview: string; timestamp: Date };
}

/** Meta sends bare digits ("5511999999999") — normalize to the same JID shape
 *  Baileys uses ("5511999999999@s.whatsapp.net") so a contact who writes via
 *  either channel lands in the same conversation thread (see Conversation's
 *  {workspaceId, jid} unique index). */
function toJid(waId: string): string {
  return `${waId.replace(/\D/g, '')}@s.whatsapp.net`;
}

function extractContent(msg: Record<string, unknown>): { type: MessageType; text: string; content: Record<string, unknown> } {
  const type = String(msg.type ?? 'unknown');

  switch (type) {
    case 'text':
      return { type: 'text', text: (msg.text as { body?: string } | undefined)?.body ?? '', content: { text: (msg.text as { body?: string } | undefined)?.body ?? '' } };

    case 'image': case 'video': case 'audio': case 'document': case 'sticker': {
      const media = msg[type] as { id?: string; caption?: string; mime_type?: string; sha256?: string } | undefined;
      // No `url` here — unlike Baileys (which can re-derive a download URL from
      // rawPayload at any time), Cloud API media requires a separate authenticated
      // GET /{media-id} → signed URL round-trip. Not implemented yet: the message
      // shows up with its caption/mimetype but no playable/downloadable content.
      return {
        type: type as MessageType,
        text: media?.caption ?? '',
        content: { caption: media?.caption, mimeType: media?.mime_type, mediaId: media?.id },
      };
    }

    case 'location': {
      const loc = msg.location as { latitude?: number; longitude?: number; name?: string; address?: string } | undefined;
      return { type: 'location', text: '', content: { latitude: loc?.latitude, longitude: loc?.longitude, name: loc?.name, address: loc?.address } };
    }

    case 'contacts': {
      const contacts = msg.contacts as Array<{ name?: { formatted_name?: string } }> | undefined;
      const name = contacts?.[0]?.name?.formatted_name ?? '';
      return { type: 'contact', text: name, content: { name } };
    }

    case 'interactive': {
      // Button/list replies are flattened to plain text, same as Baileys does for
      // buttonsResponseMessage/listResponseMessage — the flow runner's resume()
      // matches on text/id either way.
      const interactive = msg.interactive as { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } } | undefined;
      const reply = interactive?.button_reply ?? interactive?.list_reply;
      return { type: 'text', text: reply?.title ?? reply?.id ?? '', content: { text: reply?.title ?? '', replyId: reply?.id } };
    }

    case 'button': {
      // Legacy template quick-reply button tap.
      const button = msg.button as { text?: string; payload?: string } | undefined;
      return { type: 'text', text: button?.text ?? '', content: { text: button?.text ?? '', replyId: button?.payload } };
    }

    case 'reaction': {
      const reaction = msg.reaction as { message_id?: string; emoji?: string } | undefined;
      return { type: 'reaction', text: reaction?.emoji ?? '', content: { emoji: reaction?.emoji, targetMessageId: reaction?.message_id } };
    }

    case 'order': {
      const order = msg.order as { catalog_id?: string; product_items?: unknown[]; text?: string } | undefined;
      return { type: 'interactive', text: order?.text ?? 'Pedido recebido', content: { order } };
    }

    default:
      return { type: 'unknown', text: `[Mensagem da Meta não suportada: ${type}]`, content: { providerType: type, raw: msg[type] } };
  }
}

/** Extracts every inbound message from one webhook delivery (a single POST can
 *  batch several). Ignores delivery-status-only payloads (handled separately —
 *  see extractStatusUpdates). */
export function extractInboundMessages(payload: MetaWebhookPayload): NormalizedMetaMessage[] {
  const out: NormalizedMetaMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages?.length) continue;
      const contactsByWaId = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const msg of value.messages) {
        const from = String(msg.from ?? '');
        const id = String(msg.id ?? '');
        if (!from || !id) continue;
        const { type, text, content } = extractContent(msg);
        const ts = Number(msg.timestamp ?? 0);
        const timestamp = ts ? new Date(ts * 1000) : new Date();
        const context = msg.context as { id?: string } | undefined;
        out.push({
          jid: toJid(from),
          phone: from.replace(/\D/g, ''),
          messageId: id,
          type,
          text,
          content,
          contactName: contactsByWaId.get(from) ?? undefined,
          timestamp,
          quoted: context?.id ? { messageId: context.id, type: 'unknown', preview: 'Mensagem citada', timestamp } : undefined,
          providerMessage: {
            key: { id, remoteJid: toJid(from), fromMe: false },
            message: { conversation: text, cloudApi: msg, replyId: content.replyId },
          },
        });
      }
    }
  }
  return out;
}

export interface StatusUpdate {
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';
  error?: { code?: number; title?: string; message?: string; details?: string };
}

/** Extracts delivery-status updates (sent/delivered/read/failed) for messages
 *  WE sent — mirrors BaileysSession's messages.update handler. */
export function extractStatusUpdates(payload: MetaWebhookPayload): StatusUpdate[] {
  const out: StatusUpdate[] = [];
  const VALID = new Set(['sent', 'delivered', 'read', 'failed', 'deleted']);
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        if (s.id && s.status && VALID.has(s.status)) {
          const firstError = s.errors?.[0];
          out.push({
            messageId: s.id,
            status: s.status as StatusUpdate['status'],
            ...(firstError ? { error: {
              code: firstError.code, title: firstError.title,
              message: firstError.message, details: firstError.error_data?.details,
            } } : {}),
          });
        }
      }
    }
  }
  return out;
}
