import pino from 'pino';
import { Instance } from '../db/models';
import { BaileysSession } from './BaileysSession';
import { CloudApiSession } from '../channels/cloud-api/CloudApiSession';
import type { WebSocketGateway } from '../ws/gateway';
import type { IChannelSession } from '../channels/types';
import { decryptSecret } from '../shared/crypto';
import { validatePhoneNumber, validateWabaPhoneNumber } from '../channels/cloud-api/graph-client';
import { notifyWorkspaceOwner } from '../modules/notifications/notification.service';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class SessionManager {
  private sessions = new Map<string, IChannelSession>();
  private cloudHealthTimer?: NodeJS.Timeout;

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
    this.cloudHealthTimer = setInterval(() => void this.refreshCloudApiHealth(), 15 * 60_000);
    this.cloudHealthTimer.unref();
  }

  /** Return the live session, lazily (re)starting it from saved creds if absent. */
  async ensureSession(instanceId: string): Promise<IChannelSession> {
    return this.sessions.get(instanceId) ?? this.startSession(instanceId);
  }

  async startSession(instanceId: string): Promise<IChannelSession> {
    if (this.sessions.has(instanceId)) {
      return this.sessions.get(instanceId)!;
    }
    const instance = await Instance.findById(instanceId).select('channel').lean();
    // Evict on the channel's own "logged out" signal too, not just the explicit
    // logoutSession() path below — otherwise a dead session stays cached forever
    // and a later re-connect attempt resurrects/reuses a corpse.
    const onLoggedOut = () => {
      if (this.sessions.get(instanceId) === session) this.sessions.delete(instanceId);
    };
    const session: IChannelSession = instance?.channel === 'cloud_api'
      ? new CloudApiSession(instanceId, this.wsGateway, onLoggedOut)
      : new BaileysSession(instanceId, this.wsGateway, onLoggedOut);
    this.sessions.set(instanceId, session);
    try {
      await session.connect();
    } catch (err) {
      // connect() failed outright (e.g. the Instance doc was gone, or the engine
      // threw during socket setup) — don't leave a broken session cached forever;
      // every future ensureSession()/send would otherwise silently reuse this
      // half-built session and 503 permanently until a process restart.
      if (this.sessions.get(instanceId) === session) this.sessions.delete(instanceId);
      throw err;
    }
    logger.info({ instanceId }, '[SessionManager] Session started');
    return session;
  }

  getSession(instanceId: string): IChannelSession | null {
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

  async restartSession(instanceId: string): Promise<IChannelSession> {
    await this.disconnectSession(instanceId);
    return this.startSession(instanceId);
  }

  listActive(): string[] {
    return [...this.sessions.keys()];
  }

  hasSession(instanceId: string): boolean {
    return this.sessions.has(instanceId);
  }

  async refreshCloudApiHealth(): Promise<void> {
    const instances = await Instance.find({ channel: 'cloud_api', status: 'connected' });
    await Promise.allSettled(instances.map(async (instance) => {
      if (!instance.cloudApi) return;
      const expiresAt = instance.cloudApi.tokenExpiresAt;
      if (expiresAt && expiresAt.getTime() - Date.now() < 7 * 24 * 60 * 60_000 && (!instance.cloudApi.tokenExpiryAlertedAt || Date.now() - instance.cloudApi.tokenExpiryAlertedAt.getTime() > 24 * 60 * 60_000)) {
        await Instance.updateOne({ _id: instance._id }, { $set: { 'cloudApi.tokenExpiryAlertedAt': new Date() } });
        await notifyWorkspaceOwner(this.wsGateway, instance.workspaceId.toString(), {
          type: 'instance.token_expiring', title: 'Token da Meta próximo do vencimento',
          message: `O token da instância ${instance.name} vence em breve. Reconecte a conta para evitar interrupções.`, link: '/instances',
        });
      }
      try {
        const accessToken = decryptSecret(instance.cloudApi.accessTokenEnc);
        await validateWabaPhoneNumber(instance.cloudApi.wabaId, instance.cloudApi.phoneNumberId, accessToken, instance.cloudApi.graphVersion);
        const health = await validatePhoneNumber({ phoneNumberId: instance.cloudApi.phoneNumberId, accessToken, graphVersion: instance.cloudApi.graphVersion });
        await Instance.updateOne({ _id: instance._id }, { $set: {
          'cloudApi.qualityRating': health.qualityRating,
          'cloudApi.verifiedName': health.verifiedName,
          'cloudApi.displayPhoneNumber': health.displayPhoneNumber,
          'cloudApi.lastHealthCheckAt': new Date(),
        }, $unset: { errorMessage: 1 } });
      } catch (err) {
        await Instance.updateOne({ _id: instance._id }, { $set: { status: 'error', errorMessage: (err as Error).message, 'cloudApi.lastHealthCheckAt': new Date() } });
        this.wsGateway.broadcastInstanceStatus(instance.workspaceId.toString(), instance._id.toString(), 'error', { errorMessage: (err as Error).message });
        if (instance.status !== 'error') await notifyWorkspaceOwner(this.wsGateway, instance.workspaceId.toString(), {
          type: 'instance.health_failed', title: 'Falha na conexão com a Meta',
          message: `${instance.name}: ${(err as Error).message}`, link: '/instances',
        });
      }
    }));
  }

  async refreshCloudApiInstanceHealth(instanceId: string): Promise<void> {
    const instance = await Instance.findOne({ _id: instanceId, channel: 'cloud_api' });
    if (!instance?.cloudApi) throw new Error('Instância oficial não encontrada');
    try {
      const accessToken = decryptSecret(instance.cloudApi.accessTokenEnc);
      await validateWabaPhoneNumber(instance.cloudApi.wabaId, instance.cloudApi.phoneNumberId, accessToken, instance.cloudApi.graphVersion);
      const health = await validatePhoneNumber({ phoneNumberId: instance.cloudApi.phoneNumberId, accessToken, graphVersion: instance.cloudApi.graphVersion });
      await Instance.updateOne({ _id: instance._id }, {
        $set: {
          status: 'connected',
          'cloudApi.qualityRating': health.qualityRating,
          'cloudApi.verifiedName': health.verifiedName,
          'cloudApi.displayPhoneNumber': health.displayPhoneNumber,
          'cloudApi.lastHealthCheckAt': new Date(),
        },
        $unset: { errorMessage: 1 },
      });
    } catch (err) {
      const message = (err as Error).message;
      await Instance.updateOne({ _id: instance._id }, { $set: { status: 'error', errorMessage: message, 'cloudApi.lastHealthCheckAt': new Date() } });
      this.wsGateway.broadcastInstanceStatus(instance.workspaceId.toString(), instance._id.toString(), 'error', { errorMessage: message });
      throw err;
    }
  }

  stopHealthChecks(): void {
    if (this.cloudHealthTimer) clearInterval(this.cloudHealthTimer);
    this.cloudHealthTimer = undefined;
  }

  /** Stop background checks and close every live channel without logging out.
   * Credentials remain persisted so sessions can be restored after a deploy. */
  shutdown(): void {
    this.stopHealthChecks();
    for (const [instanceId, session] of this.sessions) {
      try {
        session.disconnect();
      } catch (err) {
        logger.warn({ err, instanceId }, '[SessionManager] Failed to disconnect session during shutdown');
      }
    }
    this.sessions.clear();
  }
}
