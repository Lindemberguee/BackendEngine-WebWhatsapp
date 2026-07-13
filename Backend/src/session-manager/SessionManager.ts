import pino from 'pino';
import { Instance } from '../db/models';
import { BaileysSession } from './BaileysSession';
import type { WebSocketGateway } from '../ws/gateway';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class SessionManager {
  private sessions = new Map<string, BaileysSession>();

  constructor(private readonly wsGateway: WebSocketGateway) {}

  /**
   * Boot: restore any instance that was meant to be online.
   * We include 'connecting' and 'error' (not just 'connected') because a server
   * restart (e.g. tsx watch reload) loses the in-memory reconnect timers — those
   * instances have valid saved credentials and must be reconnected, otherwise they
   * are orphaned forever (no session in the map → sending fails with 503).
   * 'disconnected' (logged out) and 'qr_pending' (never paired) are intentionally skipped.
   */
  async initialize(): Promise<void> {
    const instances = await Instance.find({ status: { $in: ['connected', 'connecting', 'error'] } }).lean();
    logger.info(`[SessionManager] Restoring ${instances.length} instance(s)`);
    await Promise.allSettled(instances.map((i) => this.startSession(i._id.toString())));
  }

  /** Return the live session, lazily (re)starting it from saved creds if absent. */
  async ensureSession(instanceId: string): Promise<BaileysSession> {
    return this.sessions.get(instanceId) ?? this.startSession(instanceId);
  }

  async startSession(instanceId: string): Promise<BaileysSession> {
    if (this.sessions.has(instanceId)) {
      return this.sessions.get(instanceId)!;
    }
    const session = new BaileysSession(instanceId, this.wsGateway);
    this.sessions.set(instanceId, session);
    await session.connect();
    logger.info({ instanceId }, '[SessionManager] Session started');
    return session;
  }

  getSession(instanceId: string): BaileysSession | null {
    return this.sessions.get(instanceId) ?? null;
  }

  async logoutSession(instanceId: string): Promise<void> {
    const session = this.sessions.get(instanceId);
    if (session) {
      await session.logout();
      this.sessions.delete(instanceId);
      logger.info({ instanceId }, '[SessionManager] Session logged out');
    }
  }

  async disconnectSession(instanceId: string): Promise<void> {
    const session = this.sessions.get(instanceId);
    if (session) {
      session.disconnect();
      this.sessions.delete(instanceId);
      logger.info({ instanceId }, '[SessionManager] Session disconnected');
    }
  }

  async restartSession(instanceId: string): Promise<BaileysSession> {
    await this.disconnectSession(instanceId);
    return this.startSession(instanceId);
  }

  listActive(): string[] {
    return [...this.sessions.keys()];
  }

  hasSession(instanceId: string): boolean {
    return this.sessions.has(instanceId);
  }
}
