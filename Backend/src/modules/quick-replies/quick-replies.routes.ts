import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { QuickReply } from '../../db/models';

export async function quickRepliesRoutes(fastify: FastifyInstance): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };

  // GET /api/quick-replies — list workspace canned messages, alphabetical by title
  fastify.get('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const replies = await QuickReply.find({ workspaceId: new Types.ObjectId(workspaceId) })
      .collation({ locale: 'pt', strength: 2 })
      .sort({ title: 1 });
    return reply.send(replies.map((r) => r.toJSON()));
  });

  // POST /api/quick-replies — create { title, content }
  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { title, content } = request.body as { title?: string; content?: string };

    const trimmedTitle = (title ?? '').trim();
    const trimmedContent = (content ?? '').trim();
    if (!trimmedTitle) return reply.status(400).send({ error: 'Título é obrigatório' });
    if (!trimmedContent) return reply.status(400).send({ error: 'Mensagem é obrigatória' });

    const doc = await QuickReply.create({
      workspaceId: new Types.ObjectId(workspaceId),
      title: trimmedTitle,
      content: trimmedContent,
    });
    return reply.status(201).send(doc.toJSON());
  });

  // PATCH /api/quick-replies/:id — edit { title?, content? }
  fastify.patch('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };
    const { title, content } = request.body as { title?: string; content?: string };

    const doc = await QuickReply.findOne({ _id: id, workspaceId: new Types.ObjectId(workspaceId) });
    if (!doc) return reply.status(404).send({ error: 'Resposta não encontrada' });

    if (typeof title === 'string') {
      const trimmed = title.trim();
      if (!trimmed) return reply.status(400).send({ error: 'Título é obrigatório' });
      doc.title = trimmed;
    }
    if (typeof content === 'string') {
      const trimmed = content.trim();
      if (!trimmed) return reply.status(400).send({ error: 'Mensagem é obrigatória' });
      doc.content = trimmed;
    }
    await doc.save();
    return reply.send(doc.toJSON());
  });

  // DELETE /api/quick-replies/:id
  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { id } = request.params as { id: string };

    const doc = await QuickReply.findOneAndDelete({ _id: id, workspaceId: new Types.ObjectId(workspaceId) });
    if (!doc) return reply.status(404).send({ error: 'Resposta não encontrada' });
    return reply.status(204).send();
  });
}
