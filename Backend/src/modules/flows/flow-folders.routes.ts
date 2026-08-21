import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { FlowFolder, Flow } from '../../db/models';
import { requireRole } from '../../utils/require-role';

export async function flowFoldersRoutes(fastify: FastifyInstance): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };
  // Same split as flows.routes.ts — folders are just organization for flows, but
  // mutating them (renaming, deleting — which unlinks flows) is still owner/admin.
  const canWrite = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin'])] };
  const valid = (id: string) => Types.ObjectId.isValid(id);

  // GET /api/flow-folders
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const folders = await FlowFolder.find({ workspaceId: new Types.ObjectId(workspaceId) }).sort({ order: 1, createdAt: 1 });
    return reply.send({ data: folders.map((f) => f.toJSON()) });
  });

  // POST /api/flow-folders
  fastify.post('/', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { name, color, description } = request.body as { name?: string; color?: string; description?: string };
    if (!name?.trim()) return reply.status(400).send({ error: 'Nome é obrigatório' });
    // order = max existing + 1
    const last = await FlowFolder.findOne({ workspaceId: new Types.ObjectId(workspaceId) }).sort({ order: -1 });
    const order = (last?.order ?? -1) + 1;
    const folder = await FlowFolder.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name: name.trim(),
      color: color ?? '#8B5CF6',
      description,
      order,
    });
    return reply.status(201).send(folder.toJSON());
  });

  // PATCH /api/flow-folders/:id
  fastify.patch('/:id', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Pasta não encontrada' });
    const { name, color, description, order } = request.body as { name?: string; color?: string; description?: string; order?: number };
    const update: Record<string, unknown> = {};
    if (name !== undefined) update.name = name.trim();
    if (color !== undefined) update.color = color;
    if (description !== undefined) update.description = description;
    if (order !== undefined) update.order = order;
    const folder = await FlowFolder.findOneAndUpdate(
      { _id: id, workspaceId: new Types.ObjectId(workspaceId) },
      { $set: update },
      { new: true }
    );
    if (!folder) return reply.status(404).send({ error: 'Pasta não encontrada' });
    return reply.send(folder.toJSON());
  });

  // DELETE /api/flow-folders/:id
  fastify.delete('/:id', canWrite, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    if (!valid(id)) return reply.status(404).send({ error: 'Pasta não encontrada' });
    const folder = await FlowFolder.findOneAndDelete({ _id: id, workspaceId: new Types.ObjectId(workspaceId) });
    if (!folder) return reply.status(404).send({ error: 'Pasta não encontrada' });
    // Desvincular flows da pasta deletada
    await Flow.updateMany(
      { workspaceId: new Types.ObjectId(workspaceId), folderId: folder._id },
      { $set: { folderId: null } }
    );
    return reply.status(204).send();
  });
}
