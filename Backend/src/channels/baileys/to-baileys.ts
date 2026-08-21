import type { AnyMessageContent } from '@webwhatsapp/engine';
import type { OutboundMessage, OutboundButton } from '../../messaging/outbound-types';

// Native-flow (interactive) button → Baileys NativeFlowButton
function nativeButton(btn: OutboundButton) {
  switch (btn.type) {
    case 'url':  return { name: 'cta_url',  buttonParamsJson: JSON.stringify({ display_text: btn.label, url: btn.value }) };
    case 'call': return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: btn.label, phone_number: btn.value }) };
    case 'copy': return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: btn.label, copy_code: btn.value }) };
    default:     return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.label, id: btn.value }) };
  }
}

/** Translate the channel-neutral IR into Baileys' `AnyMessageContent`. Mirrors,
 *  1:1, what `buildMessageContent()`'s switch used to build inline. */
export function toBaileys(msg: OutboundMessage): AnyMessageContent | null {
  switch (msg.kind) {
    case 'text':
      return { text: msg.text };

    case 'image':
      return { image: { url: msg.url }, caption: msg.caption, viewOnce: msg.viewOnce } as AnyMessageContent;

    case 'video':
      return { video: { url: msg.url }, caption: msg.caption, gifPlayback: msg.gifPlayback, viewOnce: msg.viewOnce } as AnyMessageContent;

    case 'audio':
      return { audio: { url: msg.url }, ptt: msg.ptt, mimetype: 'audio/mp4' } as AnyMessageContent;

    case 'document':
      return { document: { url: msg.url }, fileName: msg.fileName, mimetype: msg.mimetype, caption: msg.caption } as AnyMessageContent;

    case 'buttons':
      return {
        text: msg.body,
        interactiveButtons: msg.buttons.map(nativeButton),
      } as unknown as AnyMessageContent;

    case 'cta': {
      const interactiveButtons = msg.buttons.map(nativeButton);
      if (msg.headerImageUrl) {
        return { image: { url: msg.headerImageUrl }, caption: msg.body, footer: msg.footer, interactiveButtons } as unknown as AnyMessageContent;
      }
      return { text: msg.body, footer: msg.footer, interactiveButtons } as unknown as AnyMessageContent;
    }

    case 'list':
      return {
        text: msg.body,
        title: msg.title,
        buttonText: msg.buttonText,
        sections: msg.sections.map((sec) => ({
          title: sec.title,
          rows: sec.rows.map((r) => ({ rowId: r.id, title: r.title, description: r.description })),
        })),
      } as unknown as AnyMessageContent;

    case 'carousel':
      return {
        text: ' ',
        cards: msg.cards.map((card) => ({
          image: card.imageUrl ? { url: card.imageUrl } : undefined,
          title: card.title,
          buttons: [nativeButton({ type: 'reply', label: card.buttonLabel || 'Ver', value: card.id })],
        })),
      } as unknown as AnyMessageContent;

    case 'pix': {
      const interactiveButtons = [nativeButton({ type: 'copy', label: msg.buttonLabel, value: msg.pixKey })];
      if (msg.qrCodeUrl) return { image: { url: msg.qrCodeUrl }, caption: msg.body, footer: msg.footer, interactiveButtons } as unknown as AnyMessageContent;
      return { text: msg.body, footer: msg.footer, interactiveButtons } as unknown as AnyMessageContent;
    }

    case 'poll':
      return { poll: { name: msg.question, values: msg.options, selectableCount: msg.multiSelect ? msg.options.length : 1 } } as unknown as AnyMessageContent;

    case 'location':
      return { location: { degreesLatitude: msg.latitude, degreesLongitude: msg.longitude, name: msg.name, address: msg.address } } as AnyMessageContent;

    case 'contact': {
      const waid = msg.phone.replace(/\D/g, '');
      const vcard = [
        'BEGIN:VCARD', 'VERSION:3.0', `FN:${msg.name}`,
        msg.organization ? `ORG:${msg.organization}` : '',
        `TEL;type=CELL;type=VOICE;waid=${waid}:${msg.phone}`,
        'END:VCARD',
      ].filter(Boolean).join('\n');
      return { contacts: { displayName: msg.name, contacts: [{ displayName: msg.name, vcard }] } } as unknown as AnyMessageContent;
    }

    case 'reaction':
      return { react: { text: msg.emoji, key: msg.key } } as AnyMessageContent;

    case 'template':
      // Baileys has no HSM concept — buildOutboundMessage() never produces this
      // for a Baileys-targeted flow, but guard here too rather than send garbage.
      return null;

    default:
      return null;
  }
}
