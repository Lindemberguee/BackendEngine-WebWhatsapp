import type { FastifyInstance } from "fastify";
import { Types } from "mongoose";
import pino from "pino";
import { Contact, Conversation, Message } from "../../db/models";
import { ensureLabel } from "../labels/labels.service";
import {
  CreateContactSchema,
  UpdateContactSchema,
  ListContactsQuerySchema,
  BulkTagSchema,
  BulkStatusSchema,
  type ContactResponse,
  type ContactDetailResponse,
  type ListContactsResponse,
} from "./contacts.dto";

const logger = pino();

function toContactResponse(doc: any): ContactResponse {
  return {
    id: doc._id.toString(),
    phone: doc.phone,
    name: doc.name,
    email: doc.email,
    avatarUrl: doc.avatarUrl,
    tags: doc.tags || [],
    status: doc.status || "active",
    source: doc.source || "whatsapp",
    notes: doc.notes,
    lastSeenAt: doc.lastSeenAt?.toISOString(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    conversationCount: doc.conversationCount || 0,
  };
}

function toContactDetailResponse(doc: any, recentMessages: any[] = []): ContactDetailResponse {
  return {
    ...toContactResponse(doc),
    pushName: doc.pushName,
    jid: doc.jid,
    recentMessages: recentMessages.map((msg) => ({
      id: msg._id.toString(),
      content: msg.content?.text || msg.content?.caption || `[${msg.type}]`,
      direction: msg.direction,
      timestamp: msg.createdAt.toISOString(),
    })),
  };
}

export async function contactsRoutes(fastify: FastifyInstance): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };

  fastify.get("/", auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const query = ListContactsQuerySchema.parse(request.query);

      const filter: any = { workspaceId: new Types.ObjectId(workspaceId) };
      if (query.status) filter.status = query.status;
      if (query.tag) filter.tags = query.tag;
      if (query.search) filter.$text = { $search: query.search };

      const sort: any = {};
      if (query.sortBy === "name") sort.name = query.sortOrder === "asc" ? 1 : -1;
      else if (query.sortBy === "lastSeen") sort.lastSeenAt = query.sortOrder === "asc" ? 1 : -1;
      else if (query.sortBy === "createdAt") sort.createdAt = query.sortOrder === "asc" ? 1 : -1;

      const [total, contacts] = await Promise.all([
        Contact.countDocuments(filter),
        Contact.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit),
      ]);

      const totalPages = Math.ceil(total / query.limit);
      const response: ListContactsResponse = {
        data: contacts.map(toContactResponse),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages,
          hasNextPage: query.page < totalPages,
          hasPreviousPage: query.page > 1,
        },
      };

      reply.send(response);
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.get<{ Params: { id: string } }>("/:id", auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const { id } = request.params;

      if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: "Invalid contact ID" });

      const contact = await Contact.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!contact) return reply.status(404).send({ error: "Contact not found" });

      let recentMessages: any[] = [];
      const conversation = await Conversation.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        jid: contact.jid,
        isGroup: false,
      });

      if (conversation) {
        recentMessages = await Message.find({ conversationId: conversation._id }).sort({ createdAt: -1 }).limit(5);
      }

      reply.send(toContactDetailResponse(contact, recentMessages));
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.post("/", auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const input = CreateContactSchema.parse(request.body);

      const phone = input.phone.replace(/\D/g, "");
      const jid = `${phone}@s.whatsapp.net`;

      const existing = await Contact.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        $or: [{ phone }, { jid }],
      });

      if (existing) return reply.status(409).send({ error: "Contact already exists" });

      const contact = await Contact.create({
        workspaceId: new Types.ObjectId(workspaceId),
        phone,
        jid,
        name: input.name,
        email: input.email,
        tags: input.tags,
        notes: input.notes,
        source: input.source,
      });

      reply.status(201).send(toContactResponse(contact));
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.patch<{ Params: { id: string } }>("/:id", auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const { id } = request.params;

      if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: "Invalid contact ID" });

      const input = UpdateContactSchema.parse(request.body);

      const contact = await Contact.findOneAndUpdate(
        { _id: new Types.ObjectId(id), workspaceId: new Types.ObjectId(workspaceId) },
        {
          $set: {
            ...(input.name && { name: input.name }),
            ...(input.email !== undefined && { email: input.email }),
            ...(input.tags && { tags: input.tags }),
            ...(input.notes !== undefined && { notes: input.notes }),
            ...(input.status && { status: input.status }),
          },
        },
        { new: true }
      );

      if (!contact) return reply.status(404).send({ error: "Contact not found" });

      if (input.name) {
        await Conversation.updateMany(
          { workspaceId: new Types.ObjectId(workspaceId), jid: contact.jid, isGroup: false },
          { $set: { name: input.name } }
        );
      }

      reply.send(toContactResponse(contact));
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.delete<{ Params: { id: string } }>("/:id", auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const { id } = request.params;

      if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: "Invalid contact ID" });

      const contact = await Contact.findOneAndDelete({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!contact) return reply.status(404).send({ error: "Contact not found" });

      reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.post<{ Params: { id: string }; Body: { tag: string } }>("/:id/tags", auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const { id } = request.params;
      const { tag } = request.body;

      if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: "Invalid contact ID" });
      if (!tag) return reply.status(400).send({ error: "Tag is required" });

      await ensureLabel(workspaceId, tag.trim());
      const contact = await Contact.findOneAndUpdate(
        { _id: new Types.ObjectId(id), workspaceId: new Types.ObjectId(workspaceId), tags: { $ne: tag } },
        { $addToSet: { tags: tag.trim() } },
        { new: true }
      );

      if (!contact) return reply.status(404).send({ error: "Contact not found" });
      reply.send(toContactResponse(contact));
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.delete<{ Params: { id: string; tag: string } }>("/:id/tags/:tag", auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const { id, tag } = request.params;

      if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: "Invalid contact ID" });

      const contact = await Contact.findOneAndUpdate(
        { _id: new Types.ObjectId(id), workspaceId: new Types.ObjectId(workspaceId) },
        { $pull: { tags: decodeURIComponent(tag) } },
        { new: true }
      );

      if (!contact) return reply.status(404).send({ error: "Contact not found" });
      reply.send(toContactResponse(contact));
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.post("/batch/tags", auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const input = BulkTagSchema.parse(request.body);
      const contactIds = input.contactIds.map((id) => new Types.ObjectId(id));

      if (input.action === "add") {
        await ensureLabel(workspaceId, input.tag.trim());
        await Contact.updateMany(
          { _id: { $in: contactIds }, workspaceId: new Types.ObjectId(workspaceId) },
          { $addToSet: { tags: input.tag } }
        );
      } else {
        await Contact.updateMany(
          { _id: { $in: contactIds }, workspaceId: new Types.ObjectId(workspaceId) },
          { $pull: { tags: input.tag } }
        );
      }

      reply.send({ success: true, updated: contactIds.length });
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  // GET /api/contacts/:id/conversations
  fastify.get<{ Params: { id: string } }>("/:id/conversations", auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const { id } = request.params;

      if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: "Invalid contact ID" });

      const contact = await Contact.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!contact) return reply.status(404).send({ error: "Contact not found" });

      const conversations = await Conversation.find({
        workspaceId: new Types.ObjectId(workspaceId),
        $or: [{ jid: contact.jid }, { contactId: contact._id }],
      }).sort({ updatedAt: -1 }).limit(20);

      reply.send({
        data: conversations.map((c) => ({
          id: c._id.toString(),
          name: c.name,
          status: c.status,
          unreadCount: c.unreadCount,
          tags: c.tags ?? [],
          lastMessage: c.lastMessage
            ? { content: c.lastMessage.content, type: c.lastMessage.type, direction: c.lastMessage.direction, timestamp: c.lastMessage.timestamp?.toISOString() }
            : undefined,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
        })),
      });
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  // GET /api/contacts/:id/activity
  fastify.get<{ Params: { id: string } }>("/:id/activity", auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const { id } = request.params;

      if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: "Invalid contact ID" });

      const contact = await Contact.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!contact) return reply.status(404).send({ error: "Contact not found" });

      const conversations = await Conversation.find({
        workspaceId: new Types.ObjectId(workspaceId),
        $or: [{ jid: contact.jid }, { contactId: contact._id }],
      }).sort({ updatedAt: -1 }).limit(10);

      const activity = conversations.map((conv) => ({
        id: conv._id.toString(),
        type: "message" as const,
        description: conv.lastMessage?.content || "Conversa iniciada",
        metadata: { conversationId: conv._id.toString(), status: conv.status },
        timestamp: conv.updatedAt.toISOString(),
        actor: { id: "system", name: "Sistema" },
      }));

      reply.send({ data: activity });
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.post("/batch/status", auth, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const input = BulkStatusSchema.parse(request.body);
      const contactIds = input.contactIds.map((id) => new Types.ObjectId(id));

      const result = await Contact.updateMany(
        { _id: { $in: contactIds }, workspaceId: new Types.ObjectId(workspaceId) },
        { $set: { status: input.status } }
      );

      reply.send({ success: true, updated: result.modifiedCount });
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });
}
