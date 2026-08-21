import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import {
  Workspace, User, Conversation, Message, Contact, Lead, Pipeline, Campaign, AuditLog,
} from '../../db/models';
import { getOrCreateSubscription, assertCanCreateWorkspace } from '../billing/billing.service';
import { notify } from '../notifications/notification.service';
import { deletionDeadline } from './workspace-deletion.service';
import { validateWorkspaceTheme, type WorkspaceTheme } from './theme-validation';
import { requireRole } from '../../utils/require-role';
import type { WebSocketGateway } from '../../ws/gateway';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildWorkspacePayload(ws: { _id: unknown; name: string; slug: string; plan: string; logoUrl?: string; ownerId: unknown; createdAt: Date }) {
  const oid = ws._id instanceof Types.ObjectId ? ws._id : new Types.ObjectId(String(ws._id));
  const id = oid.toString();
  const [memberCount, conversationCount, monthlyMessageCount] = await Promise.all([
    User.countDocuments({ workspaceId: oid }),
    Conversation.countDocuments({ workspaceId: oid }),
    Message.countDocuments({
      workspaceId: oid,
      createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
    }),
  ]);
  return {
    id,
    name: ws.name,
    slug: ws.slug,
    plan: ws.plan,
    logoUrl: ws.logoUrl ?? null,
    ownerId: String(ws.ownerId),
    memberCount,
    conversationCount,
    monthlyMessageCount,
    createdAt: ws.createdAt.toISOString(),
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function workspacesRoutes(fastify: FastifyInstance, opts: { wsGateway: WebSocketGateway }): Promise<void> {
  // GET /api/workspaces  — list all workspaces the authenticated user belongs to
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { sub, workspaceId } = request.user as { sub: string; workspaceId: string };

    // Find the caller's user record to get their email
    const me = await User.findById(sub).lean();
    if (!me) return reply.status(401).send({ error: 'Usuário não encontrado' });

    // Find all user records with the same email (across all workspaces)
    const allUsers = await User.find({ email: me.email }).lean();
    const wsIds = allUsers.map((u) => u.workspaceId);

    const workspaces = await Workspace.find({ _id: { $in: wsIds } }).lean();

    // Sort: current workspace first, then by createdAt
    workspaces.sort((a, b) => {
      const aIsCurrent = String(a._id) === workspaceId ? -1 : 0;
      const bIsCurrent = String(b._id) === workspaceId ? -1 : 0;
      if (aIsCurrent !== bIsCurrent) return aIsCurrent - bIsCurrent;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    const data = await Promise.all(workspaces.map(buildWorkspacePayload));
    return reply.send({ data });
  });

  // GET /api/workspaces/current — current workspace with live stats
  fastify.get('/current', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    if (!Types.ObjectId.isValid(workspaceId)) return reply.status(400).send({ error: 'workspaceId inválido' });

    const ws = await Workspace.findById(workspaceId).lean();
    if (!ws) return reply.status(404).send({ error: 'Workspace não encontrado' });

    return reply.send({ data: await buildWorkspacePayload(ws) });
  });

  // GET /api/workspaces/:id
  fastify.get('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { sub } = request.user as { sub: string };

    if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: 'ID inválido' });

    // Verify caller belongs to this workspace
    const me = await User.findById(sub).lean();
    const user = me ? await User.findOne({ email: me.email, workspaceId: new Types.ObjectId(id) }).lean() : null;
    if (!user) return reply.status(403).send({ error: 'Sem acesso a este workspace' });

    const ws = await Workspace.findById(id).lean();
    if (!ws) return reply.status(404).send({ error: 'Workspace não encontrado' });

    return reply.send({ data: await buildWorkspacePayload(ws) });
  });

  // POST /api/workspaces — create new workspace
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    const { name, slug } = request.body as { name?: string; slug?: string };

    if (!name?.trim()) return reply.status(400).send({ error: 'Nome do workspace é obrigatório' });

    try {
      await assertCanCreateWorkspace(sub);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    // Get creator's info
    const creator = await User.findById(sub).lean();
    if (!creator) return reply.status(401).send({ error: 'Usuário não encontrado' });

    const finalSlug = slug?.trim() || slugify(name.trim());

    // Check slug uniqueness
    const slugTaken = await Workspace.exists({ slug: finalSlug });
    if (slugTaken) {
      return reply.status(409).send({ error: `Slug "${finalSlug}" já está em uso` });
    }

    // Create workspace
    const ws = await Workspace.create({
      name: name.trim(),
      slug: finalSlug,
      ownerId: new Types.ObjectId(sub),
    });
    // Starts its own 14-day Pro trial — each workspace is billed independently for now.
    await getOrCreateSubscription(ws._id.toString());

    // Create owner user record in new workspace
    await User.create({
      workspaceId: ws._id,
      name: creator.name,
      email: creator.email,
      passwordHash: creator.passwordHash,
      role: 'owner',
      avatarUrl: creator.avatarUrl,
      isActive: true,
    });

    const data = await buildWorkspacePayload(ws.toObject());
    return reply.status(201).send({ data });
  });

  // PATCH /api/workspaces/:id — update workspace settings
  fastify.patch('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };

    if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: 'ID inválido' });
    if (id !== workspaceId) return reply.status(403).send({ error: 'Sem acesso' });
    if (!['owner', 'admin'].includes(role)) return reply.status(403).send({ error: 'Sem permissão' });

    const { name, logoUrl } = request.body as { name?: string; logoUrl?: string };
    const updates: Record<string, unknown> = {};
    if (name?.trim()) updates.name = name.trim();
    if (typeof logoUrl === 'string') updates.logoUrl = logoUrl;

    const ws = await Workspace.findByIdAndUpdate(id, { $set: updates }, { new: true }).lean();
    if (!ws) return reply.status(404).send({ error: 'Workspace não encontrado' });

    // Audit
    try {
      const me = await User.findById((request.user as { sub: string }).sub).lean();
      if (me) {
        await AuditLog.create({
          workspaceId: new Types.ObjectId(workspaceId),
          actor: { id: me._id, name: me.name, email: me.email },
          type: 'workspace.settings_updated',
          metadata: updates,
        });
      }
    } catch { /* audit failure is non-fatal */ }

    return reply.send({ data: await buildWorkspacePayload(ws) });
  });

  // GET /api/workspaces/:id/theme — any member can read (needed to render the app)
  fastify.get('/:id/theme', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { workspaceId } = request.user as { workspaceId: string };

    if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: 'ID inválido' });
    if (id !== workspaceId) return reply.status(403).send({ error: 'Sem acesso' });

    const ws = await Workspace.findById(id).select('settings').lean();
    if (!ws) return reply.status(404).send({ error: 'Workspace não encontrado' });

    const theme = (ws.settings as Record<string, unknown> | undefined)?.theme ?? null;
    return reply.send({ data: theme });
  });

  // PATCH /api/workspaces/:id/theme — owner/admin only, writes settings.theme without touching other settings keys
  fastify.patch('/:id/theme', { preHandler: [fastify.authenticate, requireRole(['owner', 'admin'])] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { workspaceId } = request.user as { workspaceId: string };

    if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: 'ID inválido' });
    if (id !== workspaceId) return reply.status(403).send({ error: 'Sem acesso' });

    const result = validateWorkspaceTheme(request.body);
    if ('error' in result) return reply.status(400).send({ error: result.error });

    const theme: WorkspaceTheme = result.theme;
    const ws = await Workspace.findByIdAndUpdate(
      id,
      { $set: { 'settings.theme': theme } },
      { new: true },
    ).select('settings').lean();
    if (!ws) return reply.status(404).send({ error: 'Workspace não encontrado' });

    try {
      const me = await User.findById((request.user as { sub: string }).sub).lean();
      if (me) {
        await AuditLog.create({
          workspaceId: new Types.ObjectId(workspaceId),
          actor: { id: me._id, name: me.name, email: me.email },
          type: 'workspace.settings_updated',
          metadata: { theme: 'updated' },
        });
      }
    } catch { /* audit failure is non-fatal */ }

    return reply.send({ data: theme });
  });

  // POST /api/workspaces/switch — switch to another workspace, return new JWT
  fastify.post('/switch', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    const { workspaceId: targetWsId } = request.body as { workspaceId?: string };

    if (!targetWsId || !Types.ObjectId.isValid(targetWsId)) {
      return reply.status(400).send({ error: 'workspaceId inválido' });
    }

    // Find the caller
    const me = await User.findById(sub).lean();
    if (!me) return reply.status(401).send({ error: 'Usuário não encontrado' });

    // Find their user record in the target workspace
    const targetUser = await User.findOne({ email: me.email, workspaceId: new Types.ObjectId(targetWsId) }).lean();
    if (!targetUser) return reply.status(403).send({ error: 'Você não pertence a este workspace' });

    const ws = await Workspace.findById(targetWsId).lean();
    if (!ws) return reply.status(404).send({ error: 'Workspace não encontrado' });

    // Issue new token scoped to target workspace. Every other jwt.sign() call site
    // includes tokenVersion — omitting it here meant `authenticate` (server.ts),
    // which treats a missing claim as 0, rejected this token the moment the target
    // user had ever changed their password, hit "log out other sessions", or had
    // their role changed (all of which bump tokenVersion above 0): instant 401 right
    // after switching, indistinguishable from a broken feature.
    const token = fastify.jwt.sign({
      sub: String(targetUser._id),
      workspaceId: targetWsId,
      role: targetUser.role,
      tokenVersion: targetUser.tokenVersion ?? 0,
    });

    const workspace = await buildWorkspacePayload(ws);

    return reply.send({
      data: { workspace },
      token,
      user: {
        id: targetUser._id,
        name: targetUser.name,
        email: targetUser.email,
        role: targetUser.role,
        workspaceId: targetWsId,
        avatarUrl: targetUser.avatarUrl ?? null,
      },
    });
  });

  // POST /api/workspaces/:id/delete-request — LGPD right to erasure. Owner-only: deleting
  // the account means shutting down the whole business's workspace, not just one member
  // (non-owner members are already removable individually via /api/team). A 30-day grace
  // period gives room to change your mind before the cascade in workspace-deletion-scheduler.ts runs.
  fastify.post('/:id/delete-request', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { sub, workspaceId, role } = request.user as { sub: string; workspaceId: string; role: string };
    if (id !== workspaceId) return reply.status(403).send({ error: 'Sem acesso' });
    if (role !== 'owner') return reply.status(403).send({ error: 'Apenas o proprietário pode excluir o workspace' });

    const { password } = request.body as { password?: string };
    const user = await User.findById(sub);
    if (!user || !password || !(await user.comparePassword(password))) {
      return reply.status(400).send({ error: 'Senha incorreta' });
    }

    const now = new Date();
    const scheduledFor = deletionDeadline(now);
    await Workspace.updateOne({ _id: id }, { $set: { deletionRequestedAt: now, deletionScheduledFor: scheduledFor } });

    void notify(opts.wsGateway, {
      workspaceId: id, recipientId: sub, type: 'workspace.deletion_requested',
      title: 'Exclusão de workspace agendada',
      message: `Seu workspace será excluído permanentemente em ${scheduledFor.toLocaleDateString('pt-BR')}. Cancele a qualquer momento antes disso em Configurações.`,
      link: '/settings',
    });

    return reply.send({ data: { deletionRequestedAt: now.toISOString(), deletionScheduledFor: scheduledFor.toISOString() } });
  });

  // POST /api/workspaces/:id/delete-cancel — undo a pending deletion request before the grace period ends
  fastify.post('/:id/delete-cancel', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { sub, workspaceId, role } = request.user as { sub: string; workspaceId: string; role: string };
    if (id !== workspaceId) return reply.status(403).send({ error: 'Sem acesso' });
    if (role !== 'owner') return reply.status(403).send({ error: 'Apenas o proprietário pode cancelar a exclusão' });

    await Workspace.updateOne({ _id: id }, { $unset: { deletionRequestedAt: 1, deletionScheduledFor: 1 } });

    void notify(opts.wsGateway, {
      workspaceId: id, recipientId: sub, type: 'workspace.deletion_cancelled',
      title: 'Exclusão de workspace cancelada', message: 'Seu workspace não será mais excluído — tudo continua normal.',
      link: '/settings',
    });

    return reply.send({ data: { ok: true } });
  });

  // GET /api/workspaces/:id/export — LGPD data portability. Synchronous JSON dump of
  // structured data (no message media — that already lives on WhatsApp's own servers).
  // Fine as a synchronous request for a workspace at this stage of scale; revisit as an
  // async job with file storage if export payloads start timing out.
  fastify.get('/:id/export', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };
    if (id !== workspaceId) return reply.status(403).send({ error: 'Sem acesso' });
    if (!['owner', 'admin'].includes(role)) return reply.status(403).send({ error: 'Sem permissão' });

    const [workspace, users, contacts, conversations, messages, leads, pipelines, campaigns] = await Promise.all([
      Workspace.findById(id).select('name slug plan createdAt').lean(),
      User.find({ workspaceId: id }).select('name email role createdAt').lean(),
      Contact.find({ workspaceId: id }).select('name phone email source createdAt').lean(),
      Conversation.find({ workspaceId: id }).select('name phone status jid createdAt updatedAt').lean(),
      Message.find({ workspaceId: id }).select('conversationId direction type content.text createdAt').limit(50_000).lean(),
      Lead.find({ workspaceId: id }).select('title value status pipelineId stageId createdAt').lean(),
      Pipeline.find({ workspaceId: id }).select('name stages').lean(),
      Campaign.find({ workspaceId: id }).select('name status stats createdAt').lean(),
    ]);

    reply.header('Content-Disposition', `attachment; filename="workspace-export-${id}.json"`);
    return reply.send({
      exportedAt: new Date().toISOString(),
      workspace, users, contacts, conversations, messages, leads, pipelines, campaigns,
    });
  });
}
