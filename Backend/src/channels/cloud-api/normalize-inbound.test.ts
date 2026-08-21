import { describe, it, expect } from 'vitest';
import { extractInboundMessages, extractStatusUpdates, type MetaWebhookPayload } from './normalize-inbound';

function payloadWith(messages: Record<string, unknown>[], contacts: Record<string, unknown>[] = []): MetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts, messages } }] }],
  };
}

describe('extractInboundMessages', () => {
  it('normalizes a text message and builds a Baileys-shaped jid', () => {
    const payload = payloadWith(
      [{ from: '5511999999999', id: 'wamid.ABC', timestamp: '1700000000', type: 'text', text: { body: 'Oi!' } }],
      [{ wa_id: '5511999999999', profile: { name: 'Ana' } }]
    );
    const [msg] = extractInboundMessages(payload);
    expect(msg.jid).toBe('5511999999999@s.whatsapp.net');
    expect(msg.phone).toBe('5511999999999');
    expect(msg.messageId).toBe('wamid.ABC');
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('Oi!');
    expect(msg.contactName).toBe('Ana');
  });

  it('flattens an interactive button reply to text (same as Baileys buttonsResponseMessage)', () => {
    const payload = payloadWith([
      { from: '5511988887777', id: 'wamid.XYZ', timestamp: '1700000001', type: 'interactive', interactive: { button_reply: { id: 'opt_a', title: 'Opção A' } } },
    ]);
    const [msg] = extractInboundMessages(payload);
    expect(msg.type).toBe('text');
    expect(msg.text).toBe('Opção A');
    expect(msg.content.replyId).toBe('opt_a');
  });

  it('skips a message with no from/id rather than crashing', () => {
    const payload = payloadWith([{ type: 'text', text: { body: 'no id' } }]);
    expect(extractInboundMessages(payload)).toHaveLength(0);
  });

  it('ignores a status-only payload (no messages array)', () => {
    const payload: MetaWebhookPayload = {
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }],
    };
    expect(extractInboundMessages(payload)).toHaveLength(0);
  });

  it('normalizes reactions, orders and reply context without dropping provider data', () => {
    const payload = payloadWith([
      { from: '5511999999999', id: 'wamid.reaction', type: 'reaction', reaction: { message_id: 'wamid.original', emoji: '👍' } },
      { from: '5511999999999', id: 'wamid.order', type: 'order', context: { id: 'wamid.catalog' }, order: { catalog_id: 'cat1', product_items: [{ product_retailer_id: 'sku1', quantity: 2 }] } },
    ]);
    const messages = extractInboundMessages(payload);
    expect(messages[0]).toMatchObject({ type: 'reaction', text: '👍', content: { targetMessageId: 'wamid.original' } });
    expect(messages[1]).toMatchObject({ type: 'interactive', text: 'Pedido recebido', quoted: { messageId: 'wamid.catalog' } });
  });
});

describe('extractStatusUpdates', () => {
  it('extracts valid statuses and drops unrecognized ones', () => {
    const payload: MetaWebhookPayload = {
      entry: [{
        changes: [{
          value: {
            statuses: [
              { id: 'wamid.1', status: 'delivered' },
              { id: 'wamid.2', status: 'read' },
              { id: 'wamid.3', status: 'weird_unknown_status' },
            ],
          },
        }],
      }],
    };
    const statuses = extractStatusUpdates(payload);
    expect(statuses).toEqual([
      { messageId: 'wamid.1', status: 'delivered' },
      { messageId: 'wamid.2', status: 'read' },
    ]);
  });

  it('preserves failure details and deleted status', () => {
    const payload: MetaWebhookPayload = { entry: [{ changes: [{ value: { statuses: [
      { id: 'wamid.failed', status: 'failed', errors: [{ code: 131047, title: 'Outside window', error_data: { details: 'Use a template' } }] },
      { id: 'wamid.deleted', status: 'deleted' },
    ] } }] }] };
    expect(extractStatusUpdates(payload)).toEqual([
      { messageId: 'wamid.failed', status: 'failed', error: { code: 131047, title: 'Outside window', message: undefined, details: 'Use a template' } },
      { messageId: 'wamid.deleted', status: 'deleted' },
    ]);
  });
});
