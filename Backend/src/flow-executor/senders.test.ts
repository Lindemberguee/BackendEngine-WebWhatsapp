import { describe, it, expect } from 'vitest';
import { buildMessageContent, type FlowContext } from './senders';
import type { IFlowNode } from '../db/models';

// Guards the OutboundMessage IR refactor: buildMessageContent() must still
// produce byte-identical Baileys payloads after the split into
// buildOutboundMessage() + toBaileys().
const ctx: FlowContext = { variables: {}, contact: { name: 'Ana', phone: '5511999999999' } };
const node = (blockType: string, config: Record<string, unknown>): IFlowNode =>
  ({ id: 'n1', blockType, config } as unknown as IFlowNode);

describe('buildMessageContent (Baileys translation)', () => {
  it('message.text interpolates and returns { text }', async () => {
    const out = await buildMessageContent(node('message.text', { content: 'Olá {{nome}}' }), ctx, 'ws1');
    expect(out).toEqual({ text: 'Olá Ana' });
  });

  it('message.text returns null when empty after interpolation', async () => {
    const out = await buildMessageContent(node('message.text', { content: '   ' }), ctx, 'ws1');
    expect(out).toBeNull();
  });

  it('message.buttons builds interactiveButtons with quick_reply entries', async () => {
    const out = await buildMessageContent(
      node('message.buttons', { body: 'Escolha', buttons: [{ id: 'a', label: 'Opção A' }] }),
      ctx, 'ws1'
    ) as { text: string; interactiveButtons: { name: string; buttonParamsJson: string }[] };
    expect(out.text).toBe('Escolha');
    expect(out.interactiveButtons).toHaveLength(1);
    expect(out.interactiveButtons[0].name).toBe('quick_reply');
    expect(JSON.parse(out.interactiveButtons[0].buttonParamsJson)).toEqual({ display_text: 'Opção A', id: 'a' });
  });

  it('message.cta with a header image emits an image-header interactive card', async () => {
    const out = await buildMessageContent(
      node('message.cta', { body: 'Confira', headerImage: 'https://x/img.png', buttons: [{ id: 'x', type: 'url', label: 'Abrir', value: 'https://x' }] }),
      ctx, 'ws1'
    ) as { image: { url: string }; caption: string; interactiveButtons: { name: string }[] };
    expect(out.image).toEqual({ url: 'https://x/img.png' });
    expect(out.caption).toBe('Confira');
    expect(out.interactiveButtons[0].name).toBe('cta_url');
  });

  it('message.image returns null without a url', async () => {
    const out = await buildMessageContent(node('message.image', { caption: 'sem url' }), ctx, 'ws1');
    expect(out).toBeNull();
  });

  it('message.poll requires at least 2 non-empty options', async () => {
    const oneOption = await buildMessageContent(node('message.poll', { question: 'Q?', options: [{ text: 'A' }] }), ctx, 'ws1');
    expect(oneOption).toBeNull();
    const out = await buildMessageContent(
      node('message.poll', { question: 'Q?', options: [{ text: 'A' }, { text: 'B' }], multiSelect: true }),
      ctx, 'ws1'
    ) as { poll: { name: string; values: string[]; selectableCount: number } };
    expect(out.poll).toEqual({ name: 'Q?', values: ['A', 'B'], selectableCount: 2 });
  });

  it('unknown block type returns null', async () => {
    const out = await buildMessageContent(node('condition.branch', {}), ctx, 'ws1');
    expect(out).toBeNull();
  });
});
