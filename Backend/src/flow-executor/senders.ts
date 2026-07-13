import type { AnyMessageContent } from '@webwhatsapp/engine';
import type { IFlowNode } from '../db/models';

// ─── Variable interpolation ─────────────────────────────────────────────────

export interface FlowContext {
  variables: Record<string, unknown>;
  contact: { name?: string; phone?: string; email?: string; company?: string };
  /** WhatsApp key of the last inbound message (for reactions / quoting). */
  lastInboundKey?: { id: string; remoteJid: string; fromMe: boolean };
}

/** Replace {{tokens}} with contact fields or saved variables. */
export function interpolate(text: string, ctx: FlowContext): string {
  if (!text) return text;
  const map: Record<string, string> = {
    nome: ctx.contact.name ?? '',
    telefone: ctx.contact.phone ?? '',
    email: ctx.contact.email ?? '',
    empresa: ctx.contact.company ?? '',
    data: new Date().toLocaleDateString('pt-BR'),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (key in map) return map[key];
    const v = ctx.variables[key];
    return v == null ? '' : String(v);
  });
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const b = (v: unknown) => v === true;

function guessMime(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv', txt: 'text/plain', zip: 'application/zip',
  };
  return (ext && map[ext]) || 'application/octet-stream';
}

// Native-flow (interactive) button → Baileys NativeFlowButton
function nativeButton(type: string, label: string, value: string) {
  switch (type) {
    case 'url':  return { name: 'cta_url',  buttonParamsJson: JSON.stringify({ display_text: label, url: value }) };
    case 'call': return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: label, phone_number: value }) };
    case 'copy': return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: label, copy_code: value }) };
    default:     return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: label, id: value }) };
  }
}

/**
 * Translate a flow block into Baileys message content. Returns null for blocks
 * that don't send a message (conditions, actions, delays — handled by the runner).
 * This is the single place that maps our blocks onto ALL of Baileys' message
 * resources (interactive buttons, lists, carousel, media flags, reactions…).
 */
export function buildMessageContent(node: IFlowNode, ctx: FlowContext): AnyMessageContent | null {
  const c = node.config;
  const t = (v: unknown) => interpolate(s(v), ctx);

  switch (node.blockType) {
    case 'message.text':
      // Guard: never send an empty text.
      return t(c.content).trim() ? { text: t(c.content) } : null;

    case 'message.image':
      return s(c.url).trim() ? { image: { url: s(c.url) }, caption: t(c.caption) || undefined, viewOnce: b(c.viewOnce) } as AnyMessageContent : null;

    case 'message.video':
      return s(c.url).trim() ? { video: { url: s(c.url) }, caption: t(c.caption) || undefined, gifPlayback: b(c.gifPlayback), viewOnce: b(c.viewOnce) } as AnyMessageContent : null;

    case 'message.audio':
      return s(c.url).trim() ? { audio: { url: s(c.url) }, ptt: b(c.ptt), mimetype: 'audio/mp4' } as AnyMessageContent : null;

    case 'message.document': {
      if (!s(c.url).trim()) return null;
      const fileName = s(c.filename) || 'arquivo';
      return { document: { url: s(c.url) }, fileName, mimetype: guessMime(fileName), caption: t(c.caption) || undefined } as AnyMessageContent;
    }

    case 'message.buttons': {
      const list = Array.isArray(c.buttons) ? (c.buttons as { id: string; label: string }[]) : [];
      if (!t(c.body).trim() || list.length === 0) return null;
      return {
        text: t(c.body),
        interactiveButtons: list.map((btn) => nativeButton('reply', interpolate(btn.label, ctx), btn.id)),
      } as unknown as AnyMessageContent;
    }

    case 'message.cta': {
      const list = Array.isArray(c.buttons) ? (c.buttons as { id: string; type: string; label: string; value: string }[]) : [];
      if (!t(c.body).trim() || list.length === 0) return null;
      const interactiveButtons = list.map((btn) =>
        nativeButton(btn.type, interpolate(btn.label, ctx), btn.type === 'reply' ? btn.id : btn.value)
      );
      const footer = t(c.footer) || undefined;
      const header = s(c.headerImage).trim();
      // With a media header Baileys builds an image-header interactive card:
      // the body text moves to `caption`. Without it, a plain text header.
      if (header) {
        return { image: { url: header }, caption: t(c.body), footer, interactiveButtons } as unknown as AnyMessageContent;
      }
      return { text: t(c.body), footer, interactiveButtons } as unknown as AnyMessageContent;
    }

    case 'message.list': {
      const sections = Array.isArray(c.sections) ? (c.sections as { title: string; rows: { id: string; title: string; description: string }[] }[]) : [];
      if (!t(c.title).trim() || sections.every((sec) => sec.rows.length === 0)) return null;
      return {
        text: t(c.body) || t(c.title),
        title: t(c.title) || undefined,
        buttonText: s(c.buttonText) || 'Ver opções',
        sections: sections.map((sec) => ({
          title: interpolate(sec.title, ctx),
          rows: sec.rows.map((r) => ({ rowId: r.id, title: interpolate(r.title, ctx), description: interpolate(r.description, ctx) || undefined })),
        })),
      } as unknown as AnyMessageContent;
    }

    case 'message.carousel': {
      const cards = Array.isArray(c.cards) ? (c.cards as { id: string; title: string; imageUrl: string; buttonLabel: string }[]) : [];
      if (cards.length === 0) return null;
      return {
        text: ' ',
        cards: cards.map((card) => ({
          image: card.imageUrl ? { url: card.imageUrl } : undefined,
          title: interpolate(card.title, ctx),
          buttons: [nativeButton('reply', interpolate(card.buttonLabel, ctx) || 'Ver', card.id)],
        })),
      } as unknown as AnyMessageContent;
    }

    case 'payment.pix': {
      // Pix = interactive card: QR image header + text + a "copy" button that
      // copies the Pix key / copia-e-cola code. Same engine path as message.cta.
      const key = String(c.pixKey ?? '').trim();
      if (!key) return null;
      const label = t(c.buttonLabel).trim() || 'Copiar chave Pix';
      const body = t(c.body).trim() || '💠 Pagamento via Pix';
      const footer = t(c.footer) || undefined;
      const interactiveButtons = [nativeButton('copy', label, key)];
      const qr = s(c.qrCodeUrl).trim();
      if (qr) return { image: { url: qr }, caption: body, footer, interactiveButtons } as unknown as AnyMessageContent;
      return { text: body, footer, interactiveButtons } as unknown as AnyMessageContent;
    }

    case 'message.poll': {
      const name = t(c.question).trim();
      const values = Array.isArray(c.options)
        ? (c.options as { text: string }[]).map((o) => interpolate(String(o?.text ?? ''), ctx).trim()).filter(Boolean)
        : [];
      if (!name || values.length < 2) return null;
      const selectableCount = b(c.multiSelect) ? values.length : 1;
      return { poll: { name, values, selectableCount } } as unknown as AnyMessageContent;
    }

    case 'message.location': {
      const lat = Number(c.latitude);
      const lng = Number(c.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { location: { degreesLatitude: lat, degreesLongitude: lng, name: t(c.name) || undefined, address: t(c.address) || undefined } } as AnyMessageContent;
    }

    case 'message.contact': {
      const name = t(c.name).trim();
      const phoneRaw = String(c.phone ?? '').trim();
      if (!name || !phoneRaw) return null;
      const waid = phoneRaw.replace(/\D/g, '');
      const org = t(c.organization).trim();
      const vcard = [
        'BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`,
        org ? `ORG:${org}` : '',
        `TEL;type=CELL;type=VOICE;waid=${waid}:${phoneRaw}`,
        'END:VCARD',
      ].filter(Boolean).join('\n');
      return { contacts: { displayName: name, contacts: [{ displayName: name, vcard }] } } as unknown as AnyMessageContent;
    }

    case 'message.template':
      // Meta approved templates need template infra; fall back to a plain text stub.
      return { text: `[template: ${s(c.templateId)}]` };

    case 'message.reaction':
      if (!ctx.lastInboundKey) return null;
      return { react: { text: s(c.emoji) || '👍', key: ctx.lastInboundKey } } as AnyMessageContent;

    default:
      return null; // condition / action / attendance / crm / ai / automation → runner handles
  }
}
