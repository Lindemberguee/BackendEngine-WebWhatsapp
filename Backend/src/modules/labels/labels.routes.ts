import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Label, Conversation, Contact } from '../../db/models';
import { LABEL_PALETTE, colorForName, usageCounts } from './labels.service';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export async function labelsRoutes(fastify: FastifyInstance): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };

  // GET /api/labels  — list workspace labels (optionally with usage counts via ?withUsage=1)
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { withUsage } = request.query as { withUsage?: string };

    const labels = await Label.find({ workspaceId: new Types.ObjectId(workspaceId) })
      .collation({ locale: 'pt', strength: 2 })
      .sort({ name: 1 });

    if (withUsage) {
      const counts = await usageCounts(workspaceId, labels.map((l) => l.name));
      return reply.send(
        labels.map((l) => ({ ...l.toJSON(), usageCount: counts[l.name] ?? 0 }))
      );
    }
    return reply.send(labels.map((l) => l.toJSON()));
  });

  // POST /api/labels  — create { name, color? }
  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { name, color } = request.body as { name?: string; color?: string };

    const trimmed = (name ?? '').trim();
    if (!trimmed) return reply.status(400).send({ error: 'Nome é obrigatório' });
    if (color && !HEX_RE.test(color)) return reply.status(400).send({ error: 'Cor inválida (use hex #RRGGBB)' });

    const existing = await Label.findOne({ workspaceId: new Types.ObjectId(workspaceId), name: trimmed })
      .collation({ locale: 'pt', strength: 2 });
    if (existing) return reply.status(409).send({ error: 'Já existe uma etiqueta com esse nome' });

    const label = await Label.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name: trimmed,
      color: color ?? colorForName(trimmed),
    });
    return reply.status(201).send(label.toJSON());
  });

  // PATCH /api/labels/:id  — rename / recolor (cascades a rename across tags arrays)
  fastify.patch('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { name, color } = request.body as { name?: string; color?: string };

    if (color && !HEX_RE.test(color)) return reply.status(400).send({ error: 'Cor inválida (use hex #RRGGBB)' });

    const label = await Label.findOne({ _id: id, workspaceId: new Types.ObjectId(workspaceId) });
    if (!label) return reply.status(404).send({ error: 'Etiqueta não encontrada' });

    const oldName = label.name;
    const newName = name?.trim();

    if (newName && newName !== oldName) {
      // Guard against colliding with another existing label.
      const clash = await Label.findOne({
        _id: { $ne: label._id },
        workspaceId: new Types.ObjectId(workspaceId),
        name: newName,
      }).collation({ locale: 'pt', strength: 2 });
      if (clash) return reply.status(409).send({ error: 'Já existe uma etiqueta com esse nome' });

      label.name = newName;
      // Cascade rename to all documents that reference the old name.
      await Promise.all([
        Conversation.updateMany(
          { workspaceId: new Types.ObjectId(workspaceId), tags: oldName },
          { $set: { 'tags.$[el]': newName } },
          { arrayFilters: [{ el: oldName }] }
        ),
        Contact.updateMany(
          { workspaceId: new Types.ObjectId(workspaceId), tags: oldName },
          { $set: { 'tags.$[el]': newName } },
          { arrayFilters: [{ el: oldName }] }
        ),
      ]);
    }
    if (color) label.color = color;
    await label.save();

    return reply.send(label.toJSON());
  });

  // DELETE /api/labels/:id  — delete + cascade $pull from conversations & contacts
  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };

    const label = await Label.findOneAndDelete({ _id: id, workspaceId: new Types.ObjectId(workspaceId) });
    if (!label) return reply.status(404).send({ error: 'Etiqueta não encontrada' });

    await Promise.all([
      Conversation.updateMany(
        { workspaceId: new Types.ObjectId(workspaceId), tags: label.name },
        { $pull: { tags: label.name } }
      ),
      Contact.updateMany(
        { workspaceId: new Types.ObjectId(workspaceId), tags: label.name },
        { $pull: { tags: label.name } }
      ),
    ]);

    return reply.status(204).send();
  });

  // GET /api/labels/palette  — the suggested color palette for the picker UI
  fastify.get('/palette', auth, async (_request, reply) => {
    return reply.send(LABEL_PALETTE);
  });
}
