import { EventEmitter } from 'events';
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const state = vi.hoisted(() => ({ user: { workspaceId: 'workspace', tokenVersion: 0, isActive: true, role: 'agent' } as any, workspace: { status: 'active' } as any }));
vi.mock('../db/models', () => ({ User: { findById: () => ({ select: () => ({ lean: async () => state.user }) }) }, Workspace: { findById: () => ({ select: () => ({ lean: async () => state.workspace }) }) } }));
vi.mock('../modules/auth/session.service', () => ({ ACCESS_COOKIE: 'ww_access' }));
import { WebSocketGateway } from './gateway';
class Socket extends EventEmitter { readyState = 1; send = vi.fn(); close = vi.fn(() => { this.readyState = 3; this.emit('close'); }); }
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('CORS_ORIGIN', 'https://app.example.test'); state.user = { workspaceId: 'workspace', tokenVersion: 0, isActive: true, role: 'agent' }; state.workspace = { status: 'active' }; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture() {
  const gateway = new WebSocketGateway(); let connect: any;
  gateway.register({ get: (_path: string, _options: unknown, handler: unknown) => { connect = handler; }, jwt: { verify: () => ({ sub: 'user', workspaceId: 'workspace', role: 'agent', tokenVersion: 0, exp: Math.floor(Date.now() / 1000) + 900 }) } } as never);
  const open = async (origin = 'https://app.example.test') => { const socket = new Socket(); await connect(socket, { headers: { origin }, cookies: { ww_access: 'token' }, query: {} }); return socket; };
  return { gateway, open };
}
it('rejects foreign origins and suspended workspaces before joining a room', async () => {
  const { gateway, open } = await fixture();
  const foreign = await open('https://evil.test'); expect(foreign.close).toHaveBeenCalled();
  state.workspace.status = 'suspended'; const suspended = await open(); expect(suspended.close).toHaveBeenCalled();
  gateway.broadcastToWorkspace('workspace', 'event', {}); expect(foreign.send).not.toHaveBeenCalled(); expect(suspended.send).not.toHaveBeenCalled();
});
it('local revocation immediately removes sockets before any further broadcast', async () => {
  const { gateway, open } = await fixture(); const socket = await open();
  gateway.disconnectUser('user'); gateway.broadcastToWorkspace('workspace', 'private', {});
  expect(socket.close).toHaveBeenCalled(); expect(socket.send).not.toHaveBeenCalled();
});
it('rechecks revocation from another process within 30 seconds', async () => {
  const { gateway, open } = await fixture(); const socket = await open(); state.user.tokenVersion = 1;
  await vi.advanceTimersByTimeAsync(30_000); expect(socket.close).toHaveBeenCalled();
  gateway.broadcastToWorkspace('workspace', 'private', {}); expect(socket.send).not.toHaveBeenCalled();
});
it('expiring an older connection does not close a fresh connection', async () => {
  const { open } = await fixture(); const older = await open(); await vi.advanceTimersByTimeAsync(10_000); const newer = await open();
  await vi.advanceTimersByTimeAsync(890_000); expect(older.close).toHaveBeenCalled(); expect(newer.close).not.toHaveBeenCalled(); newer.close();
});
