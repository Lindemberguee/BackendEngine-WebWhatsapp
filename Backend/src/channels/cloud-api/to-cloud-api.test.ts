import { describe, it, expect } from 'vitest';
import { toCloudApi } from './to-cloud-api';
import type { OutboundMessage } from '../../messaging/outbound-types';

describe('toCloudApi', () => {
  it('maps text', () => {
    expect(toCloudApi({ kind: 'text', text: 'Olá' })).toEqual({ type: 'text', text: { body: 'Olá', preview_url: true } });
  });

  it('returns null for empty text', () => {
    expect(toCloudApi({ kind: 'text', text: '   ' })).toBeNull();
  });

  it('maps image to a link-based media message', () => {
    expect(toCloudApi({ kind: 'image', url: 'https://x/img.png', caption: 'legenda' }))
      .toEqual({ type: 'image', image: { link: 'https://x/img.png', caption: 'legenda' } });
  });

  it('maps reply-only buttons to interactive button, capped at 3', () => {
    const msg: OutboundMessage = {
      kind: 'buttons',
      body: 'Escolha',
      buttons: [
        { type: 'reply', label: 'A', value: 'a' },
        { type: 'reply', label: 'B', value: 'b' },
        { type: 'reply', label: 'C', value: 'c' },
        { type: 'reply', label: 'D', value: 'd' },
      ],
    };
    const out = toCloudApi(msg) as { type: string; interactive: { type: string; action: { buttons: { reply: { id: string; title: string } }[] } } };
    expect(out.type).toBe('interactive');
    expect(out.interactive.type).toBe('button');
    expect(out.interactive.action.buttons).toHaveLength(3);
    expect(out.interactive.action.buttons.map((b) => b.reply.id)).toEqual(['a', 'b', 'c']);
  });

  it('cta with a single url button becomes cta_url', () => {
    const msg: OutboundMessage = { kind: 'cta', body: 'Veja', buttons: [{ type: 'url', label: 'Abrir', value: 'https://x' }] };
    const out = toCloudApi(msg) as { type: string; interactive: { type: string; action: { parameters: { url: string } } } };
    expect(out.type).toBe('interactive');
    expect(out.interactive.type).toBe('cta_url');
    expect(out.interactive.action.parameters.url).toBe('https://x');
  });

  it('cta with a call button degrades to plain text (no Cloud API equivalent)', () => {
    const msg: OutboundMessage = { kind: 'cta', body: 'Ligue', footer: 'rodapé', buttons: [{ type: 'call', label: 'Ligar', value: '+551199999999' }] };
    const out = toCloudApi(msg) as { type: string; text: { body: string } };
    expect(out.type).toBe('text');
    expect(out.text.body).toContain('Ligue');
    expect(out.text.body).toContain('rodapé');
  });

  it('pix embeds each code as copyable text (no copy-button equivalent)', () => {
    const out = toCloudApi({
      kind: 'pix',
      body: 'Pague',
      buttons: [
        { label: 'Copiar código Pix', code: 'abc123' },
        { label: 'Copiar código do boleto', code: '00190000090123' },
      ],
    }) as { type: string; text: { body: string } };
    expect(out.type).toBe('text');
    expect(out.text.body).toContain('abc123');
    expect(out.text.body).toContain('00190000090123');
  });

  it('carousel and poll are unsupported on the Cloud API (real-time messages)', () => {
    expect(toCloudApi({ kind: 'carousel', cards: [{ id: '1', title: 'x', buttonLabel: 'Ver' }] })).toBeNull();
    expect(toCloudApi({ kind: 'poll', question: 'Q?', options: ['A', 'B'], multiSelect: false })).toBeNull();
  });

  it('maps a template message', () => {
    expect(toCloudApi({ kind: 'template', templateName: 'boas_vindas', language: 'pt_BR' }))
      .toEqual({ type: 'template', template: { name: 'boas_vindas', language: { code: 'pt_BR' }, components: undefined } });
  });

  it('maps a reaction using the shared message id', () => {
    expect(toCloudApi({ kind: 'reaction', emoji: '👍', key: { id: 'wamid.1', remoteJid: 'x', fromMe: false } }))
      .toEqual({ type: 'reaction', reaction: { message_id: 'wamid.1', emoji: '👍' } });
  });
});
