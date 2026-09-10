import { Types } from 'mongoose';
import type { AnyMessageContent } from '@webwhatsapp/engine';
import { QuickReply, type IFlowNode } from '../db/models';
import { toBaileys } from '../channels/baileys/to-baileys';
import type { OutboundMessage, OutboundButton } from '../messaging/outbound-types';
import { isPublicHttpUrl } from '../shared/url-security';

// A flow author (or, via campaign audience / variable interpolation, a value an
// attacker influenced) can put anything in a media/link URL field. The engine
// falls back to reading non-http(s) values as a local file path, and any http(s)
// value reaches the target host directly from this server — so every URL a flow
// block sends onward must be a public http(s) URL, same gate as the manual send
// route (messages.routes.ts) and the automation.webhook block (runner.ts). Blocks
// with an invalid URL are treated the same as a block with no URL: skipped (see
// the empty-string checks elsewhere in this file).
function safeUrl(url: string): string {
  return url.trim() && isPublicHttpUrl(url) ? url : '';
}

// ─── Variable interpolation ─────────────────────────────────────────────────

export interface FlowContext {
  variables: Record<string, unknown>;
  contact: { name?: string; phone?: string; email?: string; company?: string };
  /** WhatsApp key of the last inbound message (for reactions / quoting). */
  lastInboundKey?: { id: string; remoteJid: string; fromMe: boolean };
  /** WhatsApp key of the message that started this flow run (message.reaction "trigger" target). */
  triggerKey?: { id: string; remoteJid: string; fromMe: boolean };
}

// Fixed timezone (not the host machine's) so {{data}}/{{hora}} are deterministic
// regardless of where the server runs — matches condition.time/condition.weekday,
// which already pass an explicit IANA zone instead of relying on the OS default.
const BUILTIN_TZ = 'America/Sao_Paulo';

/** Replace {{tokens}} with contact fields or saved variables. */
export function interpolate(text: string, ctx: FlowContext): string {
  if (!text) return text;
  const now = new Date();
  const map: Record<string, string> = {
    nome: ctx.contact.name ?? '',
    telefone: ctx.contact.phone ?? '',
    email: ctx.contact.email ?? '',
    empresa: ctx.contact.company ?? '',
    data: now.toLocaleDateString('pt-BR', { timeZone: BUILTIN_TZ }),
    hora: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: BUILTIN_TZ }),
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

/**
 * Translate a flow block into the channel-neutral message IR (see
 * messaging/outbound-types.ts). Returns null for blocks that don't send a
 * message (conditions, actions, delays — handled by the runner). This is the
 * single place that maps our blocks onto every message resource (interactive
 * buttons, lists, carousel, media flags, reactions…) — channel-specific wire
 * formats live in the per-channel translators under channels/ (to-baileys.ts, to-cloud-api.ts).
 *
 * Async (and takes `workspaceId`) because `message.quick_reply` needs a DB read
 * to resolve the saved canned message before it can build content — every other
 * case is pure/sync and just awaits through.
 */
export async function buildOutboundMessage(node: IFlowNode, ctx: FlowContext, workspaceId: string): Promise<OutboundMessage | null> {
  const c = node.config;
  const t = (v: unknown) => interpolate(s(v), ctx);
  const button = (btn: { type?: string; id?: string; label: string; value?: string }): OutboundButton => ({
    type: (btn.type as OutboundButton['type']) ?? 'reply',
    label: interpolate(btn.label, ctx),
    value: btn.type && btn.type !== 'reply' ? String(btn.value ?? '') : String(btn.id ?? ''),
  });

  switch (node.blockType) {
    case 'message.quick_reply': {
      const id = String(c.quickReplyId ?? '');
      if (!Types.ObjectId.isValid(id)) return null;
      const doc = await QuickReply.findOne({ _id: id, workspaceId }).select('content').lean();
      if (!doc?.content?.trim()) return null;
      return { kind: 'text', text: interpolate(doc.content, ctx) };
    }

    case 'message.text':
      // Guard: never send an empty text.
      return t(c.content).trim() ? { kind: 'text', text: t(c.content) } : null;

    case 'message.image': {
      const url = safeUrl(s(c.url));
      return url ? { kind: 'image', url, caption: t(c.caption) || undefined, viewOnce: b(c.viewOnce) } : null;
    }

    case 'message.video': {
      const url = safeUrl(s(c.url));
      return url ? { kind: 'video', url, caption: t(c.caption) || undefined, gifPlayback: b(c.gifPlayback), viewOnce: b(c.viewOnce) } : null;
    }

    case 'message.audio': {
      const url = safeUrl(s(c.url));
      return url ? { kind: 'audio', url, ptt: b(c.ptt) } : null;
    }

    case 'message.document': {
      const url = safeUrl(s(c.url));
      if (!url) return null;
      const fileName = s(c.filename) || 'arquivo';
      return { kind: 'document', url, fileName, mimetype: guessMime(fileName), caption: t(c.caption) || undefined };
    }

    case 'message.buttons': {
      const list = Array.isArray(c.buttons) ? (c.buttons as { id: string; label: string }[]) : [];
      if (!t(c.body).trim() || list.length === 0) return null;
      return { kind: 'buttons', body: t(c.body), buttons: list.map((btn) => button({ ...btn, type: 'reply' })) };
    }

    case 'message.cta': {
      const list = Array.isArray(c.buttons) ? (c.buttons as { id: string; type: string; label: string; value: string }[]) : [];
      if (!t(c.body).trim() || list.length === 0) return null;
      return {
        kind: 'cta',
        body: t(c.body),
        footer: t(c.footer) || undefined,
        headerImageUrl: safeUrl(s(c.headerImage)) || undefined,
        buttons: list.map(button),
      };
    }

    case 'message.list': {
      const sections = Array.isArray(c.sections) ? (c.sections as { title: string; rows: { id: string; title: string; description: string }[] }[]) : [];
      if (!t(c.title).trim() || sections.every((sec) => sec.rows.length === 0)) return null;
      return {
        kind: 'list',
        body: t(c.body) || t(c.title),
        title: t(c.title) || undefined,
        buttonText: s(c.buttonText) || 'Ver opções',
        sections: sections.map((sec) => ({
          title: interpolate(sec.title, ctx),
          rows: sec.rows.map((r) => ({ id: r.id, title: interpolate(r.title, ctx), description: interpolate(r.description, ctx) || undefined })),
        })),
      };
    }

    case 'message.carousel': {
      const cards = Array.isArray(c.cards) ? (c.cards as { id: string; title: string; imageUrl: string; buttonLabel: string }[]) : [];
      if (cards.length === 0) return null;
      return {
        kind: 'carousel',
        cards: cards.map((card) => ({
          id: card.id,
          title: interpolate(card.title, ctx),
          imageUrl: safeUrl(card.imageUrl) || undefined,
          buttonLabel: interpolate(card.buttonLabel, ctx) || 'Ver',
        })),
      };
    }

    case 'payment.pix': {
      // Charge card: auto-composed header (nº/valor/vencimento) + free text +
      // optional boleto PDF link + 1-2 "copy" buttons. Same engine path as cta.
      const pixCode = t(c.pixKey).trim();
      const hasBoleto = b(c.hasBoleto);
      const boletoCode = hasBoleto ? t(c.boletoCode).trim() : '';
      if (!pixCode && !boletoCode) return null;

      const chargeId = t(c.chargeId).trim();
      const amount = t(c.amount).trim();
      const dueDate = t(c.dueDate).trim();
      const pdfUrl = hasBoleto ? safeUrl(s(c.boletoPdfUrl)) : '';

      const header = [
        chargeId && `🧾 Cobrança ${chargeId}`,
        amount && `💰 Total: R$ ${amount}`,
        dueDate && `📅 Vencimento: ${dueDate}`,
      ].filter(Boolean).join('\n');

      const body = [
        header,
        t(c.body).trim(),
        pdfUrl && `📄 Boleto (PDF): ${pdfUrl}`,
      ].filter(Boolean).join('\n\n') || '💠 Pagamento';

      const buttons: { label: string; code: string }[] = [];
      if (pixCode) buttons.push({ label: t(c.pixButtonLabel).trim() || t(c.buttonLabel).trim() || 'Copiar código Pix', code: pixCode });
      if (boletoCode) buttons.push({ label: t(c.boletoButtonLabel).trim() || 'Copiar código do boleto', code: boletoCode });

      return {
        kind: 'pix',
        body,
        footer: t(c.footer) || undefined,
        qrCodeUrl: safeUrl(s(c.qrCodeUrl)) || undefined,
        buttons,
      };
    }

    case 'message.poll': {
      const question = t(c.question).trim();
      const options = Array.isArray(c.options)
        ? (c.options as { text: string }[]).map((o) => interpolate(String(o?.text ?? ''), ctx).trim()).filter(Boolean)
        : [];
      if (!question || options.length < 2) return null;
      return { kind: 'poll', question, options, multiSelect: b(c.multiSelect) };
    }

    case 'message.location': {
      const lat = Number(c.latitude);
      const lng = Number(c.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { kind: 'location', latitude: lat, longitude: lng, name: t(c.name) || undefined, address: t(c.address) || undefined };
    }

    case 'message.contact': {
      const name = t(c.name).trim();
      const phone = String(c.phone ?? '').trim();
      if (!name || !phone) return null;
      return { kind: 'contact', name, phone, organization: t(c.organization).trim() || undefined };
    }

    case 'message.reaction': {
      const key = c.target === 'trigger' ? (ctx.triggerKey ?? ctx.lastInboundKey) : ctx.lastInboundKey;
      if (!key) return null;
      return { kind: 'reaction', emoji: s(c.emoji) || '👍', key };
    }

    case 'message.template': {
      // Cloud API only (see toBaileys, which returns null for this kind) — an
      // approved HSM template, variables filled with interpolated strings so
      // {{nome}}/{{telefone}}/saved flow variables work inside a template param
      // the same way they do in every other block.
      const templateName = s(c.templateName).trim();
      const language = s(c.language).trim();
      if (!templateName || !language) return null;
      const variables = Array.isArray(c.variables) ? (c.variables as unknown[]) : [];
      const components = variables.length
        ? [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: t(v) })) }]
        : undefined;
      return { kind: 'template', templateName, language, components };
    }

    default:
      return null; // condition / action / attendance / crm / ai / automation → runner handles
  }
}

/**
 * Baileys-shaped call site kept for backward compatibility — every existing
 * caller (flow runner, campaigns) wants `AnyMessageContent` directly and is
 * Baileys-only today. Equivalent to `toBaileys(await buildOutboundMessage(...))`.
 */
export async function buildMessageContent(node: IFlowNode, ctx: FlowContext, workspaceId: string): Promise<AnyMessageContent | null> {
  const msg = await buildOutboundMessage(node, ctx, workspaceId);
  return msg ? toBaileys(msg) : null;
}
