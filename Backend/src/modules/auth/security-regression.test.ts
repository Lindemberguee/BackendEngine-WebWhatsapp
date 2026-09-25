import { getCrmReport } from '../crm/crm.service';
import { getSubscriptionResponse, getUsage, clampAnalyticsFrom } from '../billing/billing.service';
import { crmRoutes } from '../crm/crm.routes';
import { createInstancesService } from '../instances/instances.service';
import { contactsRoutes } from '../contacts/contacts.routes';
import { flowsRoutes } from '../flows/flows.routes';
import { labelsRoutes } from '../labels/labels.routes';
import { triggerWebhookFlow } from '../webhooks/webhook-flow-trigger';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createHash } from 'crypto';
import { User, Workspace, ApiKey, AuthSession, PasswordResetToken, PlatformLoginAttempt, Contact, Conversation, Message, Flow, Instance, Label, Lead, Subscription, Pipeline } from '../../db/models';
import { Account } from '../../db/models/Account.model';
import { WorkspaceInvitation } from '../../db/models/WorkspaceInvitation.model';
import { registerWorkspace, loginUser, changeOwnPassword } from './auth.service';
import { createAgent, resetAgentPassword } from '../team/team.service';
import { createInvitation, acceptInvitation } from '../team/invitations.service';
import { accountMembershipFilter, linkLegacyMembership } from './account.service';
import { registerAuthentication } from './authenticate';
import { authRoutes } from './auth.routes';
import { workspacesRoutes } from '../workspaces/workspaces.routes';
import { platformRoutes } from '../platform/platform.routes';
import { issueSession, refreshSession, issueWsTicket } from './session.service';

let db: MongoMemoryServer;
const app = Fastify();
const gateway = { broadcastToUser() {}, broadcast() {}, disconnectUser() {} } as never;
beforeAll(async () => {
  db = await MongoMemoryServer.create();
  await mongoose.connect(db.getUri());
  await Promise.all([User.init(), Account.init(), WorkspaceInvitation.init(), AuthSession.init(), PasswordResetToken.init(), PlatformLoginAttempt.init()]);
  await app.register(cookie); await app.register(jwt, { secret: 'test-only-secret-at-least-32-characters', cookie: { cookieName: 'ww_access', signed: false } });
  registerAuthentication(app);
  await app.register(authRoutes, { prefix: '/api/auth', wsGateway: gateway });
  await app.register(workspacesRoutes, { prefix: '/api/workspaces', wsGateway: gateway });
  await app.register(platformRoutes, { prefix: '/api/platform', wsGateway: gateway });
  app.get('/integration', { preHandler: [app.authenticate] }, async (req) => ({ role: req.user.role }));
  await app.register(contactsRoutes, { prefix: '/api/contacts' });
  await app.register(flowsRoutes, { prefix: '/api/flows', wsGateway: gateway });
  await app.register(labelsRoutes, { prefix: '/api/labels' });
  await app.register(crmRoutes, { prefix: '/api/crm', wsGateway: gateway, sessionManager: {} as never });
  await app.ready();
}, 30_000);
afterAll(async () => { await app.close(); await mongoose.disconnect(); await db?.stop(); });
const register = (email: string) => registerWorkspace({ workspaceName: email.split('@')[0], ownerName: 'Test Owner', email, password: 'safe-test-password', acceptedTerms: true });
const bearer = (user: Awaited<ReturnType<typeof loginUser>>) => ({ authorization: 'Bearer ' + app.jwt.sign({ sub: String(user._id), workspaceId: String(user.workspaceId), role: user.role, tokenVersion: user.tokenVersion }) });

it('never joins legacy records by email, changes victim password, or switches to victim workspace', async () => {
  const { user: victim } = await register('victim@example.test');
  const { user: attacker } = await register('attacker@example.test');
  const legacy = await User.create({ workspaceId: attacker.workspaceId, name: 'Forged', email: victim.email, passwordHash: 'attacker-chosen-password', role: 'agent' });
  const logged = await loginUser(victim.email, 'attacker-chosen-password');
  expect(String(logged._id)).toBe(String(legacy._id));
  const members = await User.find(accountMembershipFilter(logged));
  expect(members).toHaveLength(1);
  const response = await app.inject({ method: 'POST', url: '/api/workspaces/switch', headers: bearer(logged), payload: { workspaceId: String(victim.workspaceId) } });
  expect(response.statusCode).toBe(403);
  await changeOwnPassword(String(logged._id), 'attacker-chosen-password', 'new-attacker-password');
  expect(String((await loginUser(victim.email, 'safe-test-password'))._id)).toBe(String(victim._id));
  await expect(resetAgentPassword(String(attacker.workspaceId), String(legacy._id), String(attacker._id), 'new-password')).rejects.toThrow('conta pessoal');
  await expect(createAgent(String(attacker.workspaceId), { name: 'Fake', email: victim.email, password: 'guess' })).rejects.toThrow('convite');
});

it('requires authenticated acceptance and secret token; accepted memberships use the same account', async () => {
  const { user: inviter } = await register('inviter@example.test');
  const { user: target } = await register('invited@example.test');
  const { user: stranger } = await register('stranger@example.test');
  const invite = await createInvitation(String(inviter.workspaceId), String(inviter._id), { name: target.name, email: target.email, role: 'agent' });
  expect(await User.exists({ workspaceId: inviter.workspaceId, email: target.email })).toBeNull();
  await expect(acceptInvitation(String(stranger._id), invite.token)).rejects.toThrow('esta conta');
  const results = await Promise.allSettled([acceptInvitation(String(target._id), invite.token), acceptInvitation(String(target._id), invite.token)]);
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  const one = await acceptInvitation(String(target._id), invite.token);
  expect(String(one.accountId)).toBe(String(target.accountId));
  expect(await User.countDocuments({ workspaceId: inviter.workspaceId, accountId: target.accountId })).toBe(1);
  const result = await app.inject({ method: 'POST', url: '/api/workspaces/switch', headers: bearer(target), payload: { workspaceId: String(inviter.workspaceId) } });
  expect(result.statusCode).toBe(200);
  expect(result.json().user.role).toBe('agent');
  await User.updateOne({ _id: one._id }, { $set: { isActive: false } });
  expect((await app.inject({ method: 'POST', url: '/api/workspaces/switch', headers: bearer(target), payload: { workspaceId: String(inviter.workspaceId) } })).statusCode).toBe(403);
  await User.deleteOne({ _id: one._id });
  await expect(acceptInvitation(String(target._id), invite.token)).rejects.toThrow('já utilizado');
});

it('API keys keep their limited role and cannot mint sessions, tickets or switch identity', async () => {
  const { user } = await register('keyowner@example.test');
  const key = 'wsk_' + 'a'.repeat(40);
  await ApiKey.create({ workspaceId: user.workspaceId, createdBy: user._id, name: 'limited', role: 'viewer', keyPrefix: 'wsk_aaa', keyHash: createHash('sha256').update(key).digest('hex') });
  const headers = { authorization: 'Bearer ' + key };
  expect((await app.inject({ url: '/integration', headers })).json().role).toBe('viewer');
  for (const url of ['/api/auth/me/logout-other-sessions', '/api/auth/ws-ticket', '/api/workspaces/switch']) {
    const response = await app.inject({ method: 'POST', url, headers, payload: { workspaceId: String(user.workspaceId) } });
    expect(response.statusCode).toBe(403); expect(response.cookies).toHaveLength(0);
  }
  const ticket = issueWsTicket(app, { sub: String(user._id), workspaceId: String(user.workspaceId), role: user.role });
  expect((await app.inject({ url: '/integration', headers: { authorization: 'Bearer ' + ticket } })).statusCode).toBe(401);
});

it('atomically consumes refresh tokens, and refuses refresh after tokenVersion changes', async () => {
  const { user } = await register('refresh@example.test');
  const cookies = new Map<string, string>();
  const reply = { setCookie: (name: string, value: string) => cookies.set(name, value) } as never;
  await issueSession(app, reply, user);
  const token = cookies.get('ww_refresh');
  const results = await Promise.all([refreshSession(app, reply, token), refreshSession(app, reply, token)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
  expect(await refreshSession(app, reply, cookies.get('ww_refresh'))).toBe(false);
});

it('rejects malformed registration before persisting anything', async () => {
  const before = [await User.countDocuments(), await Workspace.countDocuments(), await Account.countDocuments()];
  for (const patch of [{ acceptedTerms: 'false' }, { password: '123' }, { email: 'bad' }, { ownerName: 42 }]) {
    await expect(registerWorkspace({ workspaceName: 'Invalid', ownerName: 'Invalid', email: 'invalid@example.test', password: 'valid-password', acceptedTerms: true, ...patch } as never)).rejects.toThrow();
  }
  expect([await User.countDocuments(), await Workspace.countDocuments(), await Account.countDocuments()]).toEqual(before);
});

it('links a legacy membership only after proof of its own password', async () => {
  const { user } = await register('legacy-owner@example.test');
  const secondWs = await Workspace.create({ name: 'Legacy second', slug: 'legacy-second', ownerId: user._id });
  const target = await User.create({ workspaceId: secondWs._id, name: user.name, email: user.email, passwordHash: 'second-workspace-password', role: 'owner' });
  await expect(linkLegacyMembership(String(user._id), String(secondWs._id), 'attacker-password')).rejects.toThrow();
  expect(await User.countDocuments(accountMembershipFilter(user))).toBe(1);
  await linkLegacyMembership(String(user._id), String(secondWs._id), 'second-workspace-password');
  expect(await User.countDocuments(accountMembershipFilter(user))).toBe(2);
  expect((await User.findById(target._id))?.tokenVersion).toBe(1);
});
it('compensates a failed registration so the same email can be retried', async () => {
  const spy = vi.spyOn(Workspace, 'create').mockRejectedValueOnce(new Error('simulated persistence failure'));
  await expect(register('retry-registration@example.test')).rejects.toThrow('simulated');
  spy.mockRestore();
  expect(await Account.exists({ email: 'retry-registration@example.test' })).toBeNull();
  await expect(register('retry-registration@example.test')).resolves.toBeDefined();
});

it('hides assigned conversations in all three contact views without losing contact filtering', async () => {
  const { user: owner } = await register('visibility@example.test');
  const agent = await User.create({ workspaceId: owner.workspaceId, name: 'Agent', email: 'visibility-agent@example.test', passwordHash: 'agent-password', role: 'agent' });
  const contact = await Contact.create({ workspaceId: owner.workspaceId, jid: '5511@s.whatsapp.net', phone: '5511', name: 'Contact' });
  const hidden = await Conversation.create({ workspaceId: owner.workspaceId, name: 'Hidden', jid: contact.jid, assignedAgentId: owner._id, contactId: contact._id, isGroup: false, lastMessage: { content: 'PRIVATE-CONTENT', type: 'text', direction: 'inbound', timestamp: new Date() } });
  await Conversation.create({ workspaceId: owner.workspaceId, name: 'Unrelated', jid: '5522@s.whatsapp.net', assignedAgentId: agent._id });
  await Message.create({ workspaceId: owner.workspaceId, conversationId: hidden._id, jid: contact.jid, messageId: 'hidden-message', direction: 'inbound', fromMe: false, type: 'text', content: { text: 'PRIVATE-CONTENT' } });
  for (const suffix of ['', '/conversations', '/activity']) {
    const response = await app.inject({ url: '/api/contacts/' + contact._id + suffix, headers: bearer(agent) });
    expect(response.statusCode).toBe(200); expect(response.body).not.toContain('PRIVATE-CONTENT'); expect(response.body).not.toContain('Unrelated');
  }
  const response = await app.inject({ url: '/api/contacts/' + contact._id + '/conversations', headers: bearer(owner) });
  expect(response.body).toContain('PRIVATE-CONTENT');
});
it('redacts webhook credentials for viewers and denies their writes/run history', async () => {
  const { user: owner } = await register('flow-viewer@example.test');
  const viewer = await User.create({ workspaceId: owner.workspaceId, name: 'Viewer', email: 'limited@example.test', passwordHash: 'viewer-password', role: 'viewer' });
  const flow = await Flow.create({ workspaceId: owner.workspaceId, name: 'Secrets', trigger: { type: 'webhook', webhookToken: 'secret-webhook' }, nodes: [], edges: [] });
  for (const url of ['/api/flows', '/api/flows/' + flow._id]) {
    const response = await app.inject({ url, headers: bearer(viewer) }); expect(response.statusCode).toBe(200); expect(response.body).not.toContain('secret-webhook');
  }
  expect((await app.inject({ url: '/api/flows/' + flow._id + '/runs', headers: bearer(viewer) })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/labels', headers: bearer(viewer), payload: { name: 'forbidden' } })).statusCode).toBe(403);
  expect(await Label.countDocuments({ workspaceId: owner.workspaceId })).toBe(0);
});
it('rejects a legacy webhook instance from another workspace before contacting WhatsApp', async () => {
  const { user: owner } = await register('flow-tenant@example.test');
  const { user: other } = await register('flow-other@example.test');
  const instance = await Instance.create({ workspaceId: other.workspaceId, name: 'Foreign instance' });
  const flow = await Flow.create({ workspaceId: owner.workspaceId, name: 'Forged', enabled: true, instanceId: instance._id, trigger: { type: 'webhook', webhookToken: 'forged-token' } });
  const manager = { ensureSession: vi.fn() };
  await expect(triggerWebhookFlow(manager as never, 'forged-token', { phone: '5512345678' })).rejects.toThrow('Instância indisponível');
  expect(manager.ensureSession).not.toHaveBeenCalled();
  const off = await app.inject({ method: 'PATCH', url: '/api/flows/' + flow._id, headers: bearer(owner), payload: { enabled: false } });
  expect(off.statusCode).toBe(200);
});
it('rejects cross-tenant CRM references without creating a lead', async () => {
  const { user: owner } = await register('crm-owner@example.test');
  const { user: foreign } = await register('crm-foreign@example.test');
  const contact = await Contact.create({ workspaceId: owner.workspaceId, jid: '5533@s.whatsapp.net', phone: '5533', name: 'CRM Contact' });
  const response = await app.inject({ method: 'POST', url: '/api/crm/leads', headers: bearer(owner), payload: { contactId: String(contact._id), assigneeId: String(foreign._id) } });
  expect(response.statusCode).toBe(400);
  expect(await Lead.countDocuments({ workspaceId: owner.workspaceId })).toBe(0);
});

it('reading legacy CRM and billing never provisions records', async () => {
  const workspace = await Workspace.create({ name: 'Read only legacy', slug: 'read-only-legacy', ownerId: new mongoose.Types.ObjectId() });
  const user = await User.create({ workspaceId: workspace._id, name: 'Legacy', email: 'readonly@example.test', passwordHash: 'legacy-password', role: 'owner' });
  const response = await app.inject({ url: '/api/crm/pipelines', headers: bearer(user) });
  expect(response.statusCode).toBe(200);
  await expect(getSubscriptionResponse(String(workspace._id))).rejects.toThrow('não provisionada');
  await getUsage(String(workspace._id)); await clampAnalyticsFrom(String(workspace._id), new Date());
  expect(await Pipeline.countDocuments({ workspaceId: workspace._id })).toBe(0);
  expect(await Subscription.countDocuments({ workspaceId: workspace._id })).toBe(0);
});
it('returns complete tenant-scoped export JSON without account secrets', async () => {
  const { user } = await register('export@example.test');
  await Contact.create({ workspaceId: user.workspaceId, jid: '5555@s.whatsapp.net', phone: '5555', name: 'Exported Contact' });
  const response = await app.inject({ url: '/api/workspaces/' + user.workspaceId + '/export', headers: bearer(user) });
  expect(response.statusCode).toBe(200); expect(response.json().contacts).toHaveLength(1);
  expect(response.body).not.toContain('passwordHash'); expect(response.json().messages).toEqual([]);
});
it('lists instance statistics with grouped queries instead of per-instance counts', async () => {
  const { user } = await register('stats@example.test');
  const [instance] = await Instance.create([{ workspaceId: user.workspaceId, name: 'A' }, { workspaceId: user.workspaceId, name: 'B' }]);
  const conversation = await Conversation.create({ workspaceId: user.workspaceId, instanceId: instance._id, jid: '5566@s.whatsapp.net', name: 'Stats' });
  await Message.create({ workspaceId: user.workspaceId, instanceId: instance._id, conversationId: conversation._id, jid: conversation.jid, messageId: 'stats-message', direction: 'outbound', fromMe: true, type: 'text', content: { text: 'Hi' } });
  const counts = vi.spyOn(Message, 'countDocuments'); const aggregates = vi.spyOn(Message, 'aggregate');
  const list = await createInstancesService({} as never).list(String(user.workspaceId));
  expect(list.find(item => item?.stats.messagesSent === 1)?.stats.conversationsTotal).toBe(1);
  expect(counts).not.toHaveBeenCalled(); expect(aggregates).toHaveBeenCalledTimes(1);
  counts.mockRestore(); aggregates.mockRestore();
});

it('paginates flow lists without skipping records and retains total count', async () => {
  const { user } = await register('pagination@example.test');
  await Flow.insertMany(Array.from({ length: 53 }, (_, index) => ({ workspaceId: user.workspaceId, name: 'Flow ' + index, nodes: [], edges: [] })));
  const first = (await app.inject({ url: '/api/flows?page=1&limit=50', headers: bearer(user) })).json();
  const second = (await app.inject({ url: '/api/flows?page=2&limit=50', headers: bearer(user) })).json();
  expect(first.meta.total).toBe(53); expect(first.data).toHaveLength(50); expect(second.data).toHaveLength(3);
  expect(new Set([...first.data, ...second.data].map(item => item.id)).size).toBe(53);
});
it('aggregated CRM report preserves counts and values beyond the first list page', async () => {
  const { user } = await register('report-total@example.test');
  const pipeline = await Pipeline.findOne({ workspaceId: user.workspaceId });
  const contact = await Contact.create({ workspaceId: user.workspaceId, jid: '5599@s.whatsapp.net', phone: '5599', name: 'Report' });
  await Lead.insertMany(Array.from({ length: 60 }, (_, index) => ({ workspaceId: user.workspaceId, pipelineId: pipeline!._id, stageId: pipeline!.stages[0].id, contactId: contact._id, title: 'Lead ' + index, value: 10, status: index < 40 ? 'open' : index < 50 ? 'won' : 'lost', wonAt: new Date(), lostAt: new Date(), assigneeId: user._id, lostReason: 'Budget' })));
  const report = await getCrmReport(String(user.workspaceId), String(pipeline!._id));
  expect(report?.pipelineValue).toBe(400); expect(report?.wonValue).toBe(100); expect(report?.conversionRate).toBe(50);
  expect(report?.byStage[0].count).toBe(40); expect(report?.byAgent[0].won).toBe(10); expect(report?.lostReasons[0].count).toBe(10);
});

it('places a Kanban drop after every unloaded sibling when dropping on the column', async () => {
  const { user } = await register('kanban-pagination@example.test');
  const pipeline = await Pipeline.findOne({ workspaceId: user.workspaceId });
  const contact = await Contact.create({ workspaceId: user.workspaceId, jid: '5588@s.whatsapp.net', phone: '5588', name: 'Kanban' });
  const stageId = pipeline!.stages[0].id;
  const leads = await Lead.insertMany(Array.from({ length: 55 }, (_, index) => ({ workspaceId: user.workspaceId, pipelineId: pipeline!._id, stageId, contactId: contact._id, title: 'Existing ' + index, order: index })));
  const moved = await Lead.create({ workspaceId: user.workspaceId, pipelineId: pipeline!._id, stageId, contactId: contact._id, title: 'Move me', order: 55 });
  const response = await app.inject({ method: 'POST', url: '/api/crm/leads/' + moved._id + '/move', headers: bearer(user), payload: { stageId } });
  expect(response.statusCode).toBe(200);
  const ordered = await Lead.find({ workspaceId: user.workspaceId, pipelineId: pipeline!._id, stageId }).sort({ order: 1 }).select('title order').lean();
  expect(ordered.at(-1)?.title).toBe('Move me'); expect(ordered.at(-1)?.order).toBe(55); expect(leads).toHaveLength(55);
});
it('places a paged drop before its target card in the absolute Kanban order', async () => {
  const { user } = await register('kanban-target@example.test');
  const pipeline = await Pipeline.findOne({ workspaceId: user.workspaceId });
  const contact = await Contact.create({ workspaceId: user.workspaceId, jid: '5577@s.whatsapp.net', phone: '5577', name: 'Kanban target' });
  const stageId = pipeline!.stages[0].id;
  const leads = await Lead.insertMany(Array.from({ length: 53 }, (_, index) => ({ workspaceId: user.workspaceId, pipelineId: pipeline!._id, stageId, contactId: contact._id, title: 'Existing ' + index, order: index })));
  const moved = await Lead.create({ workspaceId: user.workspaceId, pipelineId: pipeline!._id, stageId, contactId: contact._id, title: 'Move before last', order: 53 });
  const target = leads.at(-1)!;
  const response = await app.inject({ method: 'POST', url: '/api/crm/leads/' + moved._id + '/move', headers: bearer(user), payload: { stageId, beforeLeadId: String(target._id) } });
  expect(response.statusCode).toBe(200);
  const ordered = await Lead.find({ _id: { $in: [target._id, moved._id] } }).sort({ order: 1 }).select('title').lean();
  expect(ordered.map(item => item.title)).toEqual(['Move before last', 'Existing 52']);
});

it('sends one-use password reset links through Resend and resets every membership for the account', async () => {
  const { user } = await register('reset-owner@example.test');
  const secondWorkspace = await Workspace.create({ name: 'Second membership', slug: 'reset-membership', ownerId: new mongoose.Types.ObjectId() });
  const secondMember = await User.create({ accountId: user.accountId, workspaceId: secondWorkspace._id, name: 'Reset Owner', email: user.email, passwordHash: 'safe-test-password', role: 'agent' });
  const memberships = [user, secondMember];
  await AuthSession.insertMany(memberships.map(member => ({ userId: member._id, workspaceId: member.workspaceId, tokenVersion: member.tokenVersion, refreshTokenHash: String(member._id).padEnd(64, '0').slice(0, 64), expiresAt: new Date(Date.now() + 60_000) })));

  vi.stubEnv('RESEND_API_KEY', 're_test_key');
  vi.stubEnv('RESET_EMAIL_FROM', 'Tetra Chat <no-reply@example.test>');
  vi.stubEnv('PUBLIC_APP_URL', 'https://app.example.test');
  let sent: { to: string[]; html: string; text: string } | undefined;
  const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response('{"id":"email_test"}', { status: 200 });
  });
  vi.stubGlobal('fetch', send);

  try {
    const request = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: user.email } });
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'unknown@example.test' } });
    expect(request.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual(request.json());
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent?.to).toEqual([user.email]);

    const link = sent?.html.match(/href="(https:\/\/[^\"]+)"/)?.[1];
    expect(link).toContain('https://app.example.test/reset-password?token=');
    const token = new URL(link!).searchParams.get('token')!;
    expect(await PasswordResetToken.countDocuments({})).toBe(1);

    const reset = await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, newPassword: 'brand-new-password' } });
    expect(reset.statusCode).toBe(200);
    expect(await AuthSession.countDocuments({ userId: { $in: memberships.map(member => member._id) }, revokedAt: { $exists: false } })).toBe(0);
    expect(await PasswordResetToken.countDocuments({})).toBe(0);
    const savedMembers = await User.find({ _id: { $in: memberships.map(member => member._id) } }).select('tokenVersion passwordHash').lean();
    expect(savedMembers.every(member => member.tokenVersion === 1)).toBe(true);
    expect(new Set(savedMembers.map(member => member.passwordHash)).size).toBe(1);
    await expect(loginUser(user.email, 'safe-test-password')).rejects.toThrow('Credenciais inválidas');
    expect(String((await loginUser(user.email, 'brand-new-password'))._id)).toBe(String(user._id));
    const reused = await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, newPassword: 'another-new-password' } });
    expect(reused.statusCode).toBe(400);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it('reports password reset as unavailable before lookup when Resend settings are missing', async () => {
  vi.stubEnv('RESEND_API_KEY', '');
  vi.stubEnv('RESET_EMAIL_FROM', '');
  vi.stubEnv('PUBLIC_APP_URL', '');
  const registered = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'known@example.test' } });
  const unknown = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'unknown@example.test' } });
  expect(registered.statusCode).toBe(503);
  expect(unknown.statusCode).toBe(503);
  vi.unstubAllEnvs();
});

it('shares platform login attempts through Mongo without storing the administrator email', async () => {
  vi.stubEnv('PLATFORM_ADMIN_API_KEY', 'test-platform-api-key');
  try {
    const headers = { 'x-platform-admin-key': 'test-platform-api-key' };
    for (let attempt = 0; attempt < 10; attempt++) {
      const allowed = await app.inject({ method: 'POST', url: '/api/platform/consume-login-attempt', headers, payload: { email: 'Admin@example.test' } });
      expect(allowed.statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/platform/consume-login-attempt', headers, payload: { email: 'admin@example.test' } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    const stored = await PlatformLoginAttempt.findOne({}).lean();
    expect(stored?._id).not.toContain('admin@example.test');
    expect(await PlatformLoginAttempt.countDocuments({})).toBe(1);
  } finally {
    vi.unstubAllEnvs();
  }
});
