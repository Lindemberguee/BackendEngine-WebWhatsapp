import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import pino from 'pino';
import { User } from '../db/models';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class WebSocketGateway {
  // workspaceId → Set of connected WS clients
  private rooms = new Map<string, Set<WebSocket>>();
  // userId → Set of connected WS clients (a user can have multiple tabs/devices)
  private userSockets = new Map<string, Set<WebSocket>>();
  // Per-socket identity, needed to filter conversation-scoped broadcasts by who's
  // actually allowed to see that conversation (mirrors scopeConversationFilter's
  // REST-side rule: owner/admin see everything, agent/viewer only their own +
  // unassigned). Without this, every workspace-wide broadcast — full message
  // content included — reached every connected agent regardless of assignment.
  private socketMeta = new Map<WebSocket, { userId?: string; role?: string }>();

  register(fastify: FastifyInstance): void {
    fastify.get(
      '/ws',
      { websocket: true },
      async (socket, request) => {
        // Browsers can't set Authorization headers on a WS handshake, so the JWT
        // arrives as a query param: ws://host/ws?token=<jwt>. Verify it here.
        let workspaceId: string | undefined;
        let userId: string | undefined;
        let role: string | undefined;
        let tokenVersion: number | undefined;
        try {
          const url = new URL(request.url, 'http://localhost');
          const token = url.searchParams.get('token');
          if (token) {
            const decoded = fastify.jwt.verify(token) as { workspaceId?: string; sub?: string; role?: string; tokenVersion?: number };
            workspaceId = decoded.workspaceId;
            userId = decoded.sub;
            role = decoded.role;
            tokenVersion = decoded.tokenVersion;
          }
        } catch (err) {
          logger.warn({ err }, '[WS] Token verification failed');
        }

        if (!workspaceId) {
          socket.close(1008, 'Unauthorized');
          return;
        }

        // Mirror the REST `authenticate` decorator's revocation check (server.ts) — a
        // JWT signature alone doesn't reflect "logged out other sessions", a password
        // change, a role change, or deactivation, all of which only take effect by
        // bumping tokenVersion. Without this, a deactivated/demoted agent's existing
        // socket (or a freshly-opened one with their old token) kept receiving
        // workspace-wide events — including full message content — for up to 30 days.
        if (userId) {
          const current = await User.findById(userId).select('tokenVersion isActive').lean();
          if (!current || (current.tokenVersion ?? 0) !== (tokenVersion ?? 0) || current.isActive === false) {
            socket.close(1008, 'Unauthorized');
            return;
          }
        }

        this.addClient(workspaceId, socket);
        if (userId) this.addUserClient(userId, socket);
        this.socketMeta.set(socket, { userId, role });
        logger.debug({ workspaceId, userId }, '[WS] Client connected');

        socket.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString()) as { type: string; payload: unknown };
            // ping/pong keepalive
            if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
          } catch { /* ignore malformed */ }
        });

        socket.on('close', () => {
          this.removeClient(workspaceId, socket);
          if (userId) this.removeUserClient(userId, socket);
          this.socketMeta.delete(socket);
          logger.debug({ workspaceId, userId }, '[WS] Client disconnected');
        });
      }
    );
  }

  broadcastToWorkspace(workspaceId: string, type: string, data: Record<string, unknown>): void {
    const clients = this.rooms.get(workspaceId);
    if (!clients?.size) return;

    const payload = JSON.stringify({ type, ...data });
    for (const client of clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(payload);
      }
    }
  }

  /**
   * Same as broadcastToWorkspace, but only to sockets allowed to see the conversation
   * this event belongs to: owner/admin (unrestricted), the assigned agent, or — when
   * the conversation is unassigned — every agent/viewer (it's still in the shared queue).
   * Use this for anything carrying message content or other per-conversation data;
   * plain workspace-wide status events (e.g. instance:status) should keep using
   * broadcastToWorkspace.
   */
  broadcastToConversationVisibility(
    workspaceId: string,
    assignedAgentId: string | null | undefined,
    type: string,
    data: Record<string, unknown>
  ): void {
    const clients = this.rooms.get(workspaceId);
    if (!clients?.size) return;

    const payload = JSON.stringify({ type, ...data });
    for (const client of clients) {
      if (client.readyState !== 1 /* OPEN */) continue;
      const meta = this.socketMeta.get(client);
      const role = meta?.role;
      const canSee =
        role === 'owner' || role === 'admin' || !role || // unknown role: fail open to avoid breaking older tokens
        !assignedAgentId ||
        meta?.userId === assignedAgentId;
      if (canSee) client.send(payload);
    }
  }

  /** Send to only the given user's connections (all their open tabs/devices) — not the whole workspace. */
  sendToUser(userId: string, type: string, data: Record<string, unknown>): void {
    const clients = this.userSockets.get(userId);
    if (!clients?.size) return;

    const payload = JSON.stringify({ type, ...data });
    for (const client of clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(payload);
      }
    }
  }

  broadcastInstanceStatus(
    workspaceId: string,
    instanceId: string,
    status: string,
    extra?: Record<string, unknown>
  ): void {
    this.broadcastToWorkspace(workspaceId, 'instance:status', { instanceId, status, ...extra });
  }

  private addClient(workspaceId: string, socket: WebSocket): void {
    if (!this.rooms.has(workspaceId)) this.rooms.set(workspaceId, new Set());
    this.rooms.get(workspaceId)!.add(socket);
  }

  private removeClient(workspaceId: string, socket: WebSocket): void {
    this.rooms.get(workspaceId)?.delete(socket);
  }

  private addUserClient(userId: string, socket: WebSocket): void {
    if (!this.userSockets.has(userId)) this.userSockets.set(userId, new Set());
    this.userSockets.get(userId)!.add(socket);
  }

  private removeUserClient(userId: string, socket: WebSocket): void {
    const set = this.userSockets.get(userId);
    set?.delete(socket);
    if (set && set.size === 0) this.userSockets.delete(userId);
  }
}
