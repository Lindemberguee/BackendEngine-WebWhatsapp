import 'dotenv/config';
import * as Sentry from '@sentry/node';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { connectDatabase, disconnectDatabase } from './db/connection';
import { User, ApiKey } from './db/models';
import { deduplicateConversations } from './db/migrations/dedup-conversations';
import { WebSocketGateway } from './ws/gateway';
import { SessionManager } from './session-manager/SessionManager';
import { authRoutes } from './modules/auth/auth.routes';
import { instancesRoutes } from './modules/instances/instances.routes';
import { conversationsRoutes } from './modules/conversations/conversations.routes';
import { messagesRoutes } from './modules/messages/messages.routes';
import { contactsRoutes } from './modules/contacts/contacts.routes';
import { labelsRoutes } from './modules/labels/labels.routes';
import { flowsRoutes } from './modules/flows/flows.routes';
import { flowFoldersRoutes } from './modules/flows/flow-folders.routes';
import { teamRoutes } from './modules/team/team.routes';
import { crmRoutes } from './modules/crm/crm.routes';
import { workspacesRoutes } from './modules/workspaces/workspaces.routes';
import { auditRoutes } from './modules/audit/audit.routes';
import { teamGroupsRoutes } from './modules/team-groups/team-groups.routes';
import { analyticsRoutes } from './modules/analytics/analytics.routes';
import { notificationsRoutes } from './modules/notifications/notifications.routes';
import { campaignsRoutes } from './modules/campaigns/campaigns.routes';
import { startCampaignDispatcher, stopCampaignDispatcher } from './modules/campaigns/campaign-dispatcher';
import { billingRoutes } from './modules/billing/billing.routes';
import { startBillingScheduler, stopBillingScheduler } from './modules/billing/billing-scheduler';
import { startSlaScheduler, stopSlaScheduler } from './modules/routing/sla-scheduler';
import { startWorkspaceDeletionScheduler, stopWorkspaceDeletionScheduler } from './modules/workspaces/workspace-deletion-scheduler';
import { webhooksRoutes } from './modules/webhooks/webhooks.routes';
import { webhooksInRoutes } from './modules/webhooks/webhooks-in.routes';
import { startWebhookDispatcher, stopWebhookDispatcher } from './modules/webhooks/webhook-dispatcher';
import { apiKeysRoutes } from './modules/api-keys/api-keys.routes';

// ── Error tracking ─────────────────────────────────────────────────────────────
// No-op without a DSN — local/dev never sends anything anywhere. Set SENTRY_DSN
// in production to start capturing unhandled exceptions (see the error handler below).
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV ?? 'development' });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(process.env.NODE_ENV !== 'production' ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  },
});

async function bootstrap(): Promise<void> {
  // ── Database ──────────────────────────────────────────────────────────────
  await connectDatabase();

  // ── Deduplication ─────────────────────────────────────────────────────────
  // Remove duplicate conversations created by @lid vs @s.whatsapp.net JID format differences.
  // This runs once at startup and merges old duplicates into the canonical conversation.
  try {
    const Workspace = (await import('./db/models')).Workspace;
    const workspaces = await Workspace.find();
    let totalMerged = 0;
    for (const ws of workspaces) {
      const { merged } = await deduplicateConversations(ws._id.toString());
      totalMerged += merged;
    }
    if (totalMerged > 0) {
      fastify.log.info(`[Startup] Deduplicated ${totalMerged} conversation(s)`);
    }
  } catch (err) {
    fastify.log.warn({ err }, '[Startup] Deduplication skipped (will retry on next start)');
  }

  // ── Plugins ───────────────────────────────────────────────────────────────
  await fastify.register(cors, {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });

  // Global baseline — generous enough not to bother normal use, just to stop
  // runaway scripts/bots. Auth routes below get a much stricter override.
  //
  // Keyed by credential (a hash of the Authorization header) rather than IP when
  // present, so one leaked token or buggy integration can't exhaust the shared quota
  // for everyone else behind the same IP/NAT — each user/API key gets its own bucket.
  // Authenticated traffic also gets a higher ceiling than anonymous, since legitimate
  // polling/integration traffic is naturally heavier than anonymous requests.
  await fastify.register(rateLimit, {
    max: (request: import('fastify').FastifyRequest) => (request.headers.authorization ? 600 : 100),
    timeWindow: '1 minute',
    keyGenerator: (request: import('fastify').FastifyRequest) => {
      const auth = request.headers.authorization;
      return auth ? createHash('sha256').update(auth).digest('hex') : request.ip;
    },
    allowList: process.env.NODE_ENV !== 'production' ? ['127.0.0.1', '::1'] : [],
  });

  await fastify.register(jwt, {
    secret: process.env.JWT_SECRET ?? 'change-me',
  });

  await fastify.register(websocket);

  // File uploads (outbound media). 64 MB matches the frontend attachment cap.
  await fastify.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });

  // Report every unhandled route error to Sentry (no-op if SENTRY_DSN isn't set) before
  // falling back to Fastify's default error response — never swallows or changes behavior.
  fastify.setErrorHandler((err, request, reply) => {
    if (process.env.SENTRY_DSN) Sentry.captureException(err);
    reply.send(err);
  });

  // ── Auth decorator ────────────────────────────────────────────────────────
  // Accepts either a normal user JWT or a workspace API key (prefix 'wsk_') in the
  // same Authorization: Bearer header — this makes every existing authenticated
  // route usable by an API key automatically, scoped by the key's role, with zero
  // changes to any individual route file. See modules/api-keys/api-keys.routes.ts.
  fastify.decorate('authenticate', async (request: Parameters<typeof fastify.authenticate>[0], reply: Parameters<typeof fastify.authenticate>[1]) => {
    const authHeader = request.headers.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (bearer.startsWith('wsk_')) {
      const keyHash = createHash('sha256').update(bearer).digest('hex');
      const key = await ApiKey.findOne({ keyHash, revokedAt: { $exists: false } });
      if (!key) return reply.status(401).send({ error: 'Chave de API inválida ou revogada' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (request as any).user = { sub: key.createdBy.toString(), workspaceId: key.workspaceId.toString(), role: key.role };
      void ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
      return;
    }

    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: 'Token inválido ou expirado' });
    }
    // tokenVersion check — lets "change password" / "log out other sessions" invalidate
    // every previously-issued JWT immediately, since JWTs are otherwise stateless.
    // Tokens signed before this field existed have tokenVersion undefined and are treated as 0.
    const { sub, tokenVersion } = request.user as { sub: string; tokenVersion?: number };
    const current = await User.findById(sub).select('tokenVersion').lean();
    if (!current || (current.tokenVersion ?? 0) !== (tokenVersion ?? 0)) {
      return reply.status(401).send({ error: 'Sessão expirada — faça login novamente' });
    }
  });

  // ── Infrastructure ────────────────────────────────────────────────────────
  const wsGateway = new WebSocketGateway();
  const sessionManager = new SessionManager(wsGateway);

  // Register WebSocket endpoint
  wsGateway.register(fastify);

  // ── Routes ────────────────────────────────────────────────────────────────
  fastify.register(authRoutes,          { prefix: '/api/auth', wsGateway });
  fastify.register(instancesRoutes,     { prefix: '/api/instances', sessionManager });
  fastify.register(conversationsRoutes, { prefix: '/api/conversations', sessionManager, wsGateway });
  fastify.register(messagesRoutes,      { prefix: '/api/conversations', sessionManager });
  fastify.register(contactsRoutes,      { prefix: '/api/contacts' });
  fastify.register(labelsRoutes,        { prefix: '/api/labels' });
  fastify.register(flowsRoutes,         { prefix: '/api/flows', wsGateway });
  fastify.register(flowFoldersRoutes,   { prefix: '/api/flow-folders' });
  fastify.register(teamRoutes,          { prefix: '/api/team', wsGateway });
  fastify.register(crmRoutes,           { prefix: '/api/crm', sessionManager, wsGateway });
  fastify.register(workspacesRoutes,    { prefix: '/api/workspaces', wsGateway });
  fastify.register(auditRoutes,         { prefix: '/api/audit' });
  fastify.register(teamGroupsRoutes,    { prefix: '/api/team-groups' });
  fastify.register(analyticsRoutes,     { prefix: '/api/analytics' });
  fastify.register(notificationsRoutes, { prefix: '/api/notifications' });
  fastify.register(campaignsRoutes,     { prefix: '/api/campaigns', wsGateway, sessionManager });
  fastify.register(billingRoutes,       { prefix: '/api/billing', wsGateway });
  fastify.register(webhooksRoutes,      { prefix: '/api/webhooks' });
  fastify.register(webhooksInRoutes,    { prefix: '/api/webhooks/in', sessionManager });
  fastify.register(apiKeysRoutes,       { prefix: '/api/api-keys' });

  // ── Health ────────────────────────────────────────────────────────────────
  // readyState 1 = connected. Anything else means the API is up but can't actually
  // serve requests — a load balancer/orchestrator should stop routing traffic here.
  fastify.get('/health', async (_request, reply) => {
    const dbConnected = mongoose.connection.readyState === 1;
    const body = {
      status: dbConnected ? 'ok' : 'degraded',
      database: dbConnected ? 'connected' : 'disconnected',
      uptime: process.uptime(),
      activeSessions: sessionManager.listActive().length,
      timestamp: new Date().toISOString(),
    };
    return reply.status(dbConnected ? 200 : 503).send(body);
  });

  // ── Start ──────────────────────────────────────────────────────────────────
  const port = Number(process.env.PORT ?? 3333);
  const host = process.env.HOST ?? '0.0.0.0';

  await fastify.listen({ port, host });
  fastify.log.info(`🚀 Backend running at http://${host}:${port}`);

  // Restore previously connected WhatsApp instances
  await sessionManager.initialize();
  startCampaignDispatcher(sessionManager, wsGateway);
  startBillingScheduler(wsGateway);
  startSlaScheduler(wsGateway);
  startWebhookDispatcher();
  startWorkspaceDeletionScheduler(sessionManager);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    fastify.log.info(`Received ${signal}. Shutting down...`);
    stopCampaignDispatcher();
    stopBillingScheduler();
    stopSlaScheduler();
    stopWebhookDispatcher();
    stopWorkspaceDeletionScheduler();
    await fastify.close();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Augment Fastify types
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; workspaceId: string; role: string; tokenVersion?: number };
    user: { sub: string; workspaceId: string; role: string; tokenVersion?: number };
  }
}
