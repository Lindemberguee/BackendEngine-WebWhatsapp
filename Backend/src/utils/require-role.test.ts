import { describe, it, expect, vi } from 'vitest';
import { requireRole } from './require-role';

function mockReply() {
  const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
  return reply as unknown as { status: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
}

describe('requireRole', () => {
  it('allows a request whose role is in the allowed list', async () => {
    const handler = requireRole(['owner', 'admin']);
    const reply = mockReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ user: { role: 'admin' } } as any, reply as any);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('rejects with 403 when the role is not in the allowed list', async () => {
    const handler = requireRole(['owner', 'admin']);
    const reply = mockReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ user: { role: 'agent' } } as any, reply as any);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Você não tem permissão para esta ação' });
  });

  it('rejects a viewer just as strictly as an unrelated role', async () => {
    const handler = requireRole(['owner']);
    const reply = mockReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler({ user: { role: 'viewer' } } as any, reply as any);
    expect(reply.status).toHaveBeenCalledWith(403);
  });
});
