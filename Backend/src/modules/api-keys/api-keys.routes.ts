import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { randomBytes, createHash } from 'crypto';
import { ApiKey } from '../../db/models';
import type { ApiKeyRole } from '../../db/models';
import { requireRole } from '../../utils/require-role';

const ASSIGNABLE_ROLES: ApiKeyRole[] = ['admin', 'agent', 'viewer'];

/** Generates a new key: `wsk_live_<48 hex chars>`. Returns the full key (shown once to the
 *  caller) plus the prefix/hash that get persisted — the full key itself is never stored. */
function generateKey(): { fullKey: string; keyPrefix: string; keyHash: string } {
  const fullKey = `wsk_live_${randomBytes(24).toString('hex')}`;
  return {
    fullKey,
    keyPrefix: fullKey.slice(0, 18),
    keyHash: createHash('sha256').update(fullKey).digest('hex'),
  };
}

export async function apiKeysRoutes(fastify: FastifyInstance): Promise<void> {
  const adminOnly = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin'])] };
  const valid = (id: string) => Types.ObjectId.isValid(id);

  // GET /api/api-keys
  fastify.get('/', adminOnly, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const keys = await ApiKey.find({ workspaceId }).sort({ createdAt: -1 });
    return reply.send({ data: keys.map((k) => k.toJSON()) });
  });

  // POST /api/api-keys — the only response that ever includes the full key
  fastify.post('/', adminOnly, async (request, reply) => {
    const { workspaceId, sub } = request.user as { workspaceId: string; sub: string };
    const { name, role } = request.body as { name?: string; role?: string };
    if (!name?.trim()) return reply.status(400).send({ error: 'Nome é obrigatório' });
    const resolvedRole = ASSIGNABLE_ROLES.includes(role as ApiKeyRole) ? (role as ApiKeyRole) : 'agent';

    const { fullKey, keyPrefix, keyHash } = generateKey();
    const key = await ApiKey.create({
      workspaceId, name: name.trim(), keyPrefix, keyHash, role: resolvedRole, createdBy: sub,
    });
    return reply.status(201).send({ ...key.toJSON(), key: fullKey });
  });

  // POST /api/api-keys/:id/revoke
  fastify.post('/:id/revoke', adminOnly, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Chave não encontrada' });
    const key = await ApiKey.findOneAndUpdate({ _id: id, workspaceId }, { $set: { revokedAt: new Date() } }, { new: true });
    if (!key) return reply.status(404).send({ error: 'Chave não encontrada' });
    return reply.send(key.toJSON());
  });

  // DELETE /api/api-keys/:id
  fastify.delete('/:id', adminOnly, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Chave não encontrada' });
    const res = await ApiKey.deleteOne({ _id: id, workspaceId });
    if (res.deletedCount === 0) return reply.status(404).send({ error: 'Chave não encontrada' });
    return reply.status(204).send();
  });
}
