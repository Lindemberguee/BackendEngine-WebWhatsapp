import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class WebSocketGateway {
  // workspaceId → Set of connected WS clients
  private rooms = new Map<string, Set<WebSocket>>();
  // userId → Set of connected WS clients (a user can have multiple tabs/devices)
  private userSockets = new Map<string, Set<WebSocket>>();

  register(fastify: FastifyInstance): void {
    fastify.get(
      '/ws',
      { websocket: true },
      (socket, request) => {
        // Browsers can't set Authorization headers on a WS handshake, so the JWT
        // arrives as a query param: ws://host/ws?token=<jwt>. Verify it here.
        let workspaceId: string | undefined;
        let userId: string | undefined;
        try {
          const url = new URL(request.url, 'http://localhost');
          const token = url.searchParams.get('token');
          if (token) {
            const decoded = fastify.jwt.verify(token) as { workspaceId?: string; sub?: string };
            workspaceId = decoded.workspaceId;
            userId = decoded.sub;
          }
        } catch (err) {
          logger.warn({ err }, '[WS] Token verification failed');
        }

        if (!workspaceId) {
          socket.close(1008, 'Unauthorized');
          return;
        }

        this.addClient(workspaceId, socket);
        if (userId) this.addUserClient(userId, socket);
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
