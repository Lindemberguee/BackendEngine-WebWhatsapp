import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { CloseReason } from '../../db/models';
import { colorForName } from '../labels/labels.service';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export async function closeReasonsRoutes(fastify: FastifyInstance): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };

  // GET /api/close-reasons — list workspace closing reasons
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const reasons = await CloseReason.find({ workspaceId: new Types.ObjectId(workspaceId) })
      .collation({ locale: 'pt', strength: 2 })
      .sort({ label: 1 });
    return reply.send(reasons.map((r) => r.toJSON()));
  });

  // POST /api/close-reasons — create { label, color? }
  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { label, color } = request.body as { label?: string; color?: string };

    const trimmed = (label ?? '').trim();
    if (!trimmed) return reply.status(400).send({ error: 'Motivo é obrigatório' });
    if (color && !HEX_RE.test(color)) return reply.status(400).send({ error: 'Cor inválida (use hex #RRGGBB)' });

    const existing = await CloseReason.findOne({ workspaceId: new Types.ObjectId(workspaceId), label: trimmed })
      .collation({ locale: 'pt', strength: 2 });
    if (existing) return reply.status(409).send({ error: 'Já existe um motivo com esse nome' });

    const reason = await CloseReason.create({
      workspaceId: new Types.ObjectId(workspaceId),
      label: trimmed,
      color: color ?? colorForName(trimmed),
    });
    return reply.status(201).send(reason.toJSON());
  });

  // PATCH /api/close-reasons/:id — rename / recolor
  fastify.patch('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { label, color } = request.body as { label?: string; color?: string };

    if (color && !HEX_RE.test(color)) return reply.status(400).send({ error: 'Cor inválida (use hex #RRGGBB)' });

    const reason = await CloseReason.findOne({ _id: id, workspaceId: new Types.ObjectId(workspaceId) });
    if (!reason) return reply.status(404).send({ error: 'Motivo não encontrado' });

    const newLabel = label?.trim();
    if (newLabel && newLabel !== reason.label) {
      const clash = await CloseReason.findOne({
        _id: { $ne: reason._id },
        workspaceId: new Types.ObjectId(workspaceId),
        label: newLabel,
      }).collation({ locale: 'pt', strength: 2 });
      if (clash) return reply.status(409).send({ error: 'Já existe um motivo com esse nome' });
      reason.label = newLabel;
    }
    if (color) reason.color = color;
    await reason.save();

    return reply.send(reason.toJSON());
  });

  // DELETE /api/close-reasons/:id — old conversation references become stale (shown as "Motivo removido")
  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };

    const reason = await CloseReason.findOneAndDelete({ _id: id, workspaceId: new Types.ObjectId(workspaceId) });
    if (!reason) return reply.status(404).send({ error: 'Motivo não encontrado' });

    return reply.status(204).send();
  });
}
