import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { signPayload } from './webhook-dispatcher';

describe('signPayload', () => {
  it('is deterministic for the same secret and body', () => {
    const a = signPayload('shh', '{"event":"crm.lead_won"}');
    const b = signPayload('shh', '{"event":"crm.lead_won"}');
    expect(a).toBe(b);
  });

  it('changes when the body changes', () => {
    const a = signPayload('shh', '{"event":"crm.lead_won"}');
    const b = signPayload('shh', '{"event":"crm.lead_lost"}');
    expect(a).not.toBe(b);
  });

  it('changes when the secret changes', () => {
    const a = signPayload('secret-a', '{"event":"crm.lead_won"}');
    const b = signPayload('secret-b', '{"event":"crm.lead_won"}');
    expect(a).not.toBe(b);
  });

  it('matches a plain crypto.createHmac computation (verifies the exact algorithm a receiver would use)', () => {
    const body = '{"event":"conversation.resolved"}';
    const expected = createHmac('sha256', 'my-secret').update(body).digest('hex');
    expect(signPayload('my-secret', body)).toBe(expected);
  });
});
