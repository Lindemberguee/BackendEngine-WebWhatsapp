import 'dotenv/config';
import * as Sentry from '@sentry/node';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { connectDatabase, disconnectDatabase } from './db/connection';
import { User, ApiKey, Workspace } from './db/models';
import { deduplicateConversations } from './db/migrations/dedup-conversations';
import { WebSocketGateway } from './ws/gateway';
import { SessionManager } from './session-manager/SessionManager';
import { authRoutes } from './modules/auth/auth.routes';
import { instancesRoutes } from './modules/instances/instances.routes';
import { conversationsRoutes } from './modules/conversations/conversations.routes';
import { messagesRoutes } from './modules/messages/messages.routes';
import { messagesSearchRoutes } from './modules/messages/messages-search.routes';
import { contactsRoutes } from './modules/contacts/contacts.routes';
import { labelsRoutes } from './modules/labels/labels.routes';
import { quickRepliesRoutes } from './modules/quick-replies/quick-replies.routes';
import { closeReasonsRoutes } from './modules/close-reasons/close-reasons.routes';
import { flowsRoutes } from './modules/flows/flows.routes';
import { flowFoldersRoutes } from './modules/flows/flow-folders.routes';
import { teamRoutes } from './modules/team/team.routes';
import { crmRoutes } from './modules/crm/crm.routes';
import { workspacesRoutes } from './modules/workspaces/workspaces.routes';
import { auditRoutes } from './modules/audit/audit.routes';
import { teamGroupsRoutes } from './modules/team-groups/team-groups.routes';
import { analyticsRoutes } from './modules/analytics/analytics.routes';
import { reportsRoutes } from './modules/reports/reports.routes';
import { notificationsRoutes } from './modules/notifications/notifications.routes';
import { campaignsRoutes } from './modules/campaigns/campaigns.routes';
import { startCampaignDispatcher, stopCampaignDispatcher } from './modules/campaigns/campaign-dispatcher';
import { billingRoutes } from './modules/billing/billing.routes';
import { startBillingScheduler, stopBillingScheduler } from './modules/billing/billing-scheduler';
import { startSlaScheduler, stopSlaScheduler } from './modules/routing/sla-scheduler';
import { startRoutingScheduler, stopRoutingScheduler } from './modules/routing/routing-scheduler';
import { startWorkspaceDeletionScheduler, stopWorkspaceDeletionScheduler } from './modules/workspaces/workspace-deletion-scheduler';
import { startFlowRunScheduler, stopFlowRunScheduler } from './flow-executor/flow-run-scheduler';
import { recoverStuckFlowRuns } from './flow-executor/recover-stuck-runs';
import { webhooksRoutes } from './modules/webhooks/webhooks.routes';
import { webhooksInRoutes } from './modules/webhooks/webhooks-in.routes';
import { webhooksMetaRoutes } from './modules/webhooks/webhooks-meta.routes';
import { startWebhookDispatcher, stopWebhookDispatcher } from './modules/webhooks/webhook-dispatcher';
import { apiKeysRoutes } from './modules/api-keys/api-keys.routes';
import { templatesRoutes } from './modules/templates/templates.routes';
import { scheduledMessagesRoutes } from './modules/scheduled-messages/scheduled-messages.routes';
import { platformRoutes } from './modules/platform/platform.routes';
import { startScheduledMessageDispatcher, stopScheduledMessageDispatcher } from './modules/scheduled-messages/scheduled-message-scheduler';
import { validateMediaStorageConfig } from './shared/media-storage';
import { runStartupDiagnostics } from './shared/startup-diagnostics';

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
    ...(process.env.NODE_ENV !== 'production' ? {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
          customColors: 'info:green,warn:yellow,error:red,fatal:bgRed',
        },
      },
    } : {}),
    // The WS handshake (ws/gateway.ts) carries its JWT as ?token=... — browsers
    // can't set a header on a WebSocket upgrade, so the query string is the only
    // option there. Fastify's default request serializer logs req.url verbatim on
    // every request, which would put a 30-day-lived bearer token into the access
    // log (and whatever aggregator/Sentry breadcrumb reads it) on every connect.
    serializers: {
      req(request) {
        return { method: request.method, url: request.url.split('?')[0], hostname: request.hostname, remoteAddress: request.ip };
      },
    },
  },
});

// Decodes (never verifies) a Bearer JWT's payload to pull out `sub`, purely to key
// rate-limit buckets per-user instead of per-raw-header. Any malformed/non-JWT input
// just falls through to `undefined` (caller falls back to IP).
function decodeJwtSubUnsafe(authHeader: string): string | undefined {
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as { sub?: unknown };
    return typeof payload.sub === 'string' ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

async function bootstrap(): Promise<void> {
  await runStartupDiagnostics(fastify.log);
  validateMediaStorageConfig();

  // ── Database ──────────────────────────────────────────────────────────────
  await connectDatabase(fastify.log);

  // ── Plugins ───────────────────────────────────────────────────────────────
  // CORS_ORIGIN accepts a comma-separated list so one deploy can serve several
  // front-ends (e.g. local dev + the VM's public IP). @fastify/cors matches an
  // array by exact string, so each entry must be a full origin with scheme and
  // port — "localhost" and "127.0.0.1" are distinct origins to the browser.
  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  await fastify.register(cors, {
    origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Baseline security headers (HSTS, X-Content-Type-Options: nosniff, etc.) — this
  // is a JSON API plus a couple of raw-bytes endpoints (avatar images, exported
  // media), never an HTML-rendering surface, so the default CSP (built for pages
  // with inline scripts/styles) is irrelevant noise; keep it disabled and rely on
  // the other headers. crossOriginResourcePolicy is relaxed to 'cross-origin'
  // because the avatar endpoint (auth.routes.ts) is loaded via <img src> from the
  // frontend's own origin, which the default 'same-site' policy would block.
  await fastify.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
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
      if (!auth) return request.ip;
      // Key by the token's subject, not a hash of the raw header — a hash means
      // every request with a random/garbage Authorization value gets its own
      // fresh bucket, trivially bypassing the limit. Decoding (not verifying)
      // the JWT payload is enough for a rate-limit key; signature validity is
      // irrelevant here since we're not authenticating, just bucketing.
      const sub = decodeJwtSubUnsafe(auth);
      return sub ?? request.ip;
    },
    allowList: process.env.NODE_ENV !== 'production' ? ['127.0.0.1', '::1'] : [],
  });

  // Falling back to a literal secret in production would let anyone forge a
  // valid token for any user/workspace — fail loudly at boot instead of
  // silently running with a guessable secret.
  if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || ['change-me', 'change-this-to-a-random-256-bit-secret'].includes(process.env.JWT_SECRET))) {
    throw new Error('JWT_SECRET must be a random secret with at least 32 characters in production');
  }
  await fastify.register(jwt, {
    secret: process.env.JWT_SECRET ?? 'change-me',
    // No refresh-token flow exists yet, so this is the pragmatic mitigation for
    // "a leaked token is valid forever" — every fastify.jwt.sign() call across
    // the app picks this up automatically. Users simply log in again after 30d.
    sign: { expiresIn: '30d' },
  });

  await fastify.register(websocket);

  // File uploads (outbound media). 64 MB matches the frontend attachment cap.
  await fastify.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });

  // Report every unhandled route error to Sentry (no-op if SENTRY_DSN isn't set) before
  // falling back to Fastify's default error response — never swallows or changes behavior.
  fastify.setErrorHandler((err, request, reply) => {
    if (process.env.SENTRY_DSN) Sentry.captureException(err);
    const error = err as { name?: string; statusCode?: number };

    // Mongoose throws this for a malformed ObjectId (e.g. `/api/x/not-an-id`) — that's
    // a client mistake, not a server failure. A single check here covers every route
    // that doesn't already call Types.ObjectId.isValid() manually, instead of a 500.
    if (error.name === 'CastError') {
      return reply.status(400).send({ error: 'ID inválido' });
    }

    const statusCode = error.statusCode ?? 500;
    // Sentry already has the full error above — in production, a raw 5xx message can
    // leak internals (stack details, library names, file paths) to the client for no
    // benefit. Known 4xx errors (validation, auth, not-found) keep their real message
    // since those are meant to be shown to the caller.
    if (process.env.NODE_ENV === 'production' && statusCode >= 500) {
      return reply.status(statusCode).send({ error: 'Erro interno' });
    }
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
      const keyWorkspace = await Workspace.findById(key.workspaceId).select('status').lean();
      if (!keyWorkspace || keyWorkspace.status === 'suspended') return reply.status(403).send({ error: 'Workspace suspenso' });
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
    const current = await User.findById(sub).select('tokenVersion isActive workspaceId').lean();
    if (!current || (current.tokenVersion ?? 0) !== (tokenVersion ?? 0)) {
      return reply.status(401).send({ error: 'Sessão expirada — faça login novamente' });
    }
    // A deactivated agent's existing token stays structurally valid (same
    // tokenVersion) until something else bumps it — deny explicitly here too,
    // since this query already runs on every authenticated request either way.
    if (current.isActive === false) {
      return reply.status(401).send({ error: 'Conta desativada' });
    }
    const workspace = await Workspace.findById(current.workspaceId).select('status').lean();
    if (!workspace || workspace.status === 'suspended') {
      return reply.status(403).send({ error: 'Workspace suspenso — fale com o suporte' });
    }
  });

  // ── Infrastructure ────────────────────────────────────────────────────────
  const wsGateway = new WebSocketGateway();
  const sessionManager = new SessionManager(wsGateway);
  let applicationReady = false;
  let shuttingDown = false;

  // Register WebSocket endpoint
  wsGateway.register(fastify);

  // ── Routes ────────────────────────────────────────────────────────────────
  fastify.register(authRoutes,          { prefix: '/api/auth', wsGateway });
  fastify.register(instancesRoutes,     { prefix: '/api/instances', sessionManager });
  fastify.register(conversationsRoutes, { prefix: '/api/conversations', sessionManager, wsGateway });
  fastify.register(messagesRoutes,      { prefix: '/api/conversations', sessionManager, wsGateway });
  fastify.register(messagesSearchRoutes, { prefix: '/api/messages' });
  fastify.register(contactsRoutes,      { prefix: '/api/contacts' });
  fastify.register(labelsRoutes,        { prefix: '/api/labels' });
  fastify.register(quickRepliesRoutes,  { prefix: '/api/quick-replies' });
  fastify.register(closeReasonsRoutes,  { prefix: '/api/close-reasons' });
  fastify.register(flowsRoutes,         { prefix: '/api/flows', wsGateway });
  fastify.register(flowFoldersRoutes,   { prefix: '/api/flow-folders' });
  fastify.register(teamRoutes,          { prefix: '/api/team', wsGateway });
  fastify.register(crmRoutes,           { prefix: '/api/crm', sessionManager, wsGateway });
  fastify.register(workspacesRoutes,    { prefix: '/api/workspaces', wsGateway });
  fastify.register(auditRoutes,         { prefix: '/api/audit' });
  fastify.register(teamGroupsRoutes,    { prefix: '/api/team-groups' });
  fastify.register(analyticsRoutes,     { prefix: '/api/analytics' });
  fastify.register(reportsRoutes,       { prefix: '/api/reports' });
  fastify.register(notificationsRoutes, { prefix: '/api/notifications' });
  fastify.register(campaignsRoutes,     { prefix: '/api/campaigns', wsGateway, sessionManager });
  fastify.register(billingRoutes,       { prefix: '/api/billing', wsGateway });
  fastify.register(webhooksRoutes,      { prefix: '/api/webhooks' });
  fastify.register(webhooksInRoutes,    { prefix: '/api/webhooks/in', sessionManager });
  fastify.register(webhooksMetaRoutes,  { prefix: '/api/webhooks/meta', wsGateway, sessionManager });
  fastify.register(apiKeysRoutes,       { prefix: '/api/api-keys' });
  fastify.register(templatesRoutes,     { prefix: '/api/templates' });
  fastify.register(scheduledMessagesRoutes, { prefix: '/api', sessionManager, wsGateway });
  fastify.register(platformRoutes,        { prefix: '/api/platform' });

  // ── Health ────────────────────────────────────────────────────────────────
  // readyState 1 = connected. Anything else means the API is up but can't actually
  // serve requests — a load balancer/orchestrator should stop routing traffic here.
  fastify.get('/health', async (_request, reply) => {
    const dbConnected = mongoose.connection.readyState === 1;
    const healthy = dbConnected && applicationReady && !shuttingDown;
    const body = {
      status: healthy ? 'ok' : applicationReady ? 'degraded' : 'starting',
      ready: applicationReady && !shuttingDown,
      database: dbConnected ? 'connected' : 'disconnected',
      uptime: process.uptime(),
      activeSessions: sessionManager.listActive().length,
      timestamp: new Date().toISOString(),
    };
    return reply.status(healthy ? 200 : 503).send(body);
  });

  // ── Start ──────────────────────────────────────────────────────────────────
  // Register lifecycle handlers before listen/session restoration. A termination
  // during startup must follow the same cleanup path as a steady-state deploy.
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    applicationReady = false;
    fastify.log.info({ signal }, 'Shutting down...');

    try {
      stopCampaignDispatcher();
      stopBillingScheduler();
      stopSlaScheduler();
      stopRoutingScheduler();
      stopWebhookDispatcher();
      stopWorkspaceDeletionScheduler();
      stopScheduledMessageDispatcher();
      stopFlowRunScheduler();
      await fastify.close();
      sessionManager.shutdown();
      await disconnectDatabase(fastify.log);
      if (process.env.SENTRY_DSN) await Sentry.close(2_000);
    } catch (err) {
      exitCode = 1;
      fastify.log.error({ err }, 'Graceful shutdown failed');
    } finally {
      process.exit(exitCode);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('uncaughtException', (err) => {
    fastify.log.fatal({ err }, 'uncaughtException — terminating safely');
    Sentry.captureException(err);
    void shutdown('uncaughtException', 1);
  });
  process.once('unhandledRejection', (reason) => {
    fastify.log.fatal({ err: reason }, 'unhandledRejection — terminating safely');
    Sentry.captureException(reason);
    void shutdown('unhandledRejection', 1);
  });

  const port = Number(process.env.PORT ?? 3333);
  const host = process.env.HOST ?? '0.0.0.0';

  await fastify.listen({ port, host });
  fastify.log.info(`🚀 Backend running at http://${host}:${port}`);

  // ── Deduplication (background, non-blocking) ─────────────────────────────
  // Merges conversations split by @lid vs @s.whatsapp.net JID format differences.
  // This used to run serially before fastify.listen(), loading every non-group
  // conversation for every workspace into memory before the server would accept a
  // single request — fine with a handful of workspaces, but with real tenant
  // volume (thousands of conversations × many workspaces) it turns every deploy
  // into a multi-minute gap where /health doesn't exist yet, which reads as a
  // crash to an orchestrator's readiness probe and triggers a restart loop.
  // Running it after listen() lets the server accept traffic immediately; it's
  // idempotent (safe to overlap with a restart) and already retries on failure.
  void (async () => {
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
  })();

  // Restore previously connected WhatsApp instances
  await sessionManager.initialize();
  await recoverStuckFlowRuns();
  startCampaignDispatcher(sessionManager, wsGateway);
  startBillingScheduler(wsGateway);
  startSlaScheduler(wsGateway);
  startRoutingScheduler(wsGateway);
  startWebhookDispatcher();
  startWorkspaceDeletionScheduler(sessionManager);
  startScheduledMessageDispatcher(sessionManager, wsGateway);
  startFlowRunScheduler(sessionManager);
  applicationReady = true;

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
