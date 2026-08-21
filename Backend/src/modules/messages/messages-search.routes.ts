import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Message, Conversation } from '../../db/models';
import { scopeConversationFilter } from '../../utils/conversation-visibility';
import { parsePagination } from '../../utils/pagination';

interface PopulatedConversation {
  _id: Types.ObjectId;
  name?: string;
  phone?: string;
  avatarUrl?: string;
}

/**
 * Global message search — GET /api/messages/search?q=&page=&limit=
 * Uses the `msg_fulltext` text index on Message (content.text/content.caption).
 * Separate from messagesRoutes (registered under /api/conversations/*) since
 * this endpoint isn't scoped to a single conversation.
 */
export async function messagesSearchRoutes(fastify: FastifyInstance): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };

  fastify.get('/search', auth, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { q = '' } = request.query as Record<string, string>;
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);

    const query = q.trim();
    if (!query) {
      return reply.send({
        data: [],
        pagination: { page: 1, limit, total: 0, totalPages: 0, hasNextPage: false },
      });
    }

    const filter: Record<string, unknown> = { workspaceId, $text: { $search: query } };
    // This searches Message directly (workspace-wide), which bypassed the same
    // assigned-to-me-or-unassigned rule every other conversation/message route
    // enforces — an agent could read the full content of a colleague's messages
    // just by searching. Restrict to the set of conversations this actor can see.
    if (role === 'agent' || role === 'viewer') {
      const visibleConvIds = await Conversation.find(
        scopeConversationFilter({ workspaceId }, { role, sub }),
        { _id: 1 }
      ).lean();
      filter.conversationId = { $in: visibleConvIds.map((c) => c._id) };
    }

    const [msgDocs, total] = await Promise.all([
      Message.find(filter, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .skip(skip)
        .limit(limit)
        .populate<{ conversationId: PopulatedConversation }>('conversationId', 'name phone avatarUrl'),
      Message.countDocuments(filter),
    ]);

    const data = msgDocs.map((m) => {
      const json = m.toJSON() as Record<string, unknown>;
      const conv = m.conversationId as unknown as PopulatedConversation | null;
      return {
        ...json,
        conversationId: conv?._id ? conv._id.toString() : json.conversationId,
        conversation: conv?._id
          ? { id: conv._id.toString(), name: conv.name, phone: conv.phone, avatarUrl: conv.avatarUrl }
          : undefined,
      };
    });

    return reply.send({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: skip + data.length < total,
      },
    });
  });
}
