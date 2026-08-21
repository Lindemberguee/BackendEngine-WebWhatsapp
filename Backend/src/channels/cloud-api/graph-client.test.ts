import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendCloudApiMessage } from './graph-client';

describe('graph client retry safety', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not retry a message POST after an ambiguous server failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 500, message: 'temporary' } }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    ));

    await expect(sendCloudApiMessage(
      { phoneNumberId: 'phone1', accessToken: 'token', graphVersion: 'v25.0' },
      '5511999999999',
      { type: 'text', text: { body: 'Olá' } }
    )).rejects.toThrow('temporary');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
