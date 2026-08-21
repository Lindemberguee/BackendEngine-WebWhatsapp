import type { OutboundMessage } from '../../messaging/outbound-types';

/** The type-specific fields of a WhatsApp Cloud API `/messages` POST body —
 *  `messaging_product`/`to` are added by the caller (graph-client), not here,
 *  since OutboundMessage has no notion of a recipient. */
export type CloudApiMessageBody = Record<string, unknown> & { type: string };

const MAX_INTERACTIVE_BUTTONS = 3; // Cloud API's hard limit — Baileys allows more.

/**
 * Translate the channel-neutral IR to a Cloud API message body. Returns null
 * for kinds the Cloud API's real-time (non-template) messaging has no
 * equivalent for — carousel and native polls are template/catalog-only
 * features on this API, and Cloud API interactive buttons only support
 * quick-reply + a single URL button (no "call"/"copy" button type), so a cta
 * block using either degrades to plain text rather than silently dropping
 * the message.
 */
export function toCloudApi(msg: OutboundMessage): CloudApiMessageBody | null {
  switch (msg.kind) {
    case 'text':
      return msg.text.trim() ? { type: 'text', text: { body: msg.text, preview_url: true } } : null;

    case 'image':
      return { type: 'image', image: { link: msg.url, caption: msg.caption } };

    case 'video':
      return { type: 'video', video: { link: msg.url, caption: msg.caption } };

    case 'audio':
      return { type: 'audio', audio: { link: msg.url } };

    case 'document':
      return { type: 'document', document: { link: msg.url, filename: msg.fileName, caption: msg.caption } };

    case 'buttons': {
      const buttons = msg.buttons.filter((b) => b.type === 'reply').slice(0, MAX_INTERACTIVE_BUTTONS);
      if (!msg.body.trim() || buttons.length === 0) return null;
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: msg.body },
          action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.value, title: b.label.slice(0, 20) } })) },
        },
      };
    }

    case 'cta': {
      const replyButtons = msg.buttons.filter((b) => b.type === 'reply').slice(0, MAX_INTERACTIVE_BUTTONS);
      const urlButton = msg.buttons.find((b) => b.type === 'url');
      if (replyButtons.length > 0) {
        return {
          type: 'interactive',
          interactive: {
            type: 'button',
            ...(msg.headerImageUrl ? { header: { type: 'image', image: { link: msg.headerImageUrl } } } : {}),
            body: { text: msg.body },
            footer: msg.footer ? { text: msg.footer } : undefined,
            action: { buttons: replyButtons.map((b) => ({ type: 'reply', reply: { id: b.value, title: b.label.slice(0, 20) } })) },
          },
        };
      }
      if (urlButton && msg.buttons.length === 1) {
        return {
          type: 'interactive',
          interactive: {
            type: 'cta_url',
            ...(msg.headerImageUrl ? { header: { type: 'image', image: { link: msg.headerImageUrl } } } : {}),
            body: { text: msg.body },
            footer: msg.footer ? { text: msg.footer } : undefined,
            action: { name: 'cta_url', parameters: { display_text: urlButton.label, url: urlButton.value } },
          },
        };
      }
      // "call"/"copy" buttons, or a mix Cloud API can't represent — degrade to
      // plain text rather than drop the message entirely.
      const fallbackText = [msg.body, msg.footer].filter(Boolean).join('\n\n');
      return fallbackText.trim() ? { type: 'text', text: { body: fallbackText, preview_url: true } } : null;
    }

    case 'list': {
      if (!msg.sections.some((sec) => sec.rows.length > 0)) return null;
      return {
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(msg.title ? { header: { type: 'text', text: msg.title } } : {}),
          body: { text: msg.body },
          action: {
            button: msg.buttonText,
            sections: msg.sections.map((sec) => ({
              title: sec.title,
              rows: sec.rows.map((r) => ({ id: r.id, title: r.title.slice(0, 24), description: r.description })),
            })),
          },
        },
      };
    }

    case 'pix': {
      // No "copy code" interactive button on the Cloud API — send the Pix key as
      // plain text so it's still copyable by the customer, just not one-tap.
      const text = [msg.body, `${msg.buttonLabel}: ${msg.pixKey}`, msg.footer].filter(Boolean).join('\n\n');
      return { type: 'text', text: { body: text, preview_url: false } };
    }

    case 'location':
      return { type: 'location', location: { latitude: msg.latitude, longitude: msg.longitude, name: msg.name, address: msg.address } };

    case 'contact': {
      const waPhone = msg.phone.replace(/\D/g, '');
      return {
        type: 'contacts',
        contacts: [{
          name: { formatted_name: msg.name, first_name: msg.name },
          org: msg.organization ? { company: msg.organization } : undefined,
          phones: [{ phone: msg.phone, wa_id: waPhone, type: 'CELL' }],
        }],
      };
    }

    case 'reaction':
      return { type: 'reaction', reaction: { message_id: msg.key.id, emoji: msg.emoji } };

    case 'template':
      return { type: 'template', template: { name: msg.templateName, language: { code: msg.language }, components: msg.components } };

    case 'carousel':
    case 'poll':
      return null;

    default:
      return null;
  }
}
