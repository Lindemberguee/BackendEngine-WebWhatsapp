import type { FastifyInstance } from "fastify";
import { Types } from "mongoose";
import { Contact, Conversation, Message, AuditLog, User, Lead, CampaignRecipient } from "../../db/models";
import { ensureLabel } from "../labels/labels.service";
import {
  CreateContactSchema,
  UpdateContactSchema,
  ListContactsQuerySchema,
  BulkTagSchema,
  BulkStatusSchema,
  ImportContactsSchema,
  type ContactResponse,
  type ContactDetailResponse,
  type ListContactsResponse,
} from "./contacts.dto";
import { requireRole } from "../../utils/require-role";

/** Best-effort audit entry for a contact action — merged back into GET
 *  /:id/activity so the timeline shows more than just "message" events (the
 *  types themselves — contact.updated/contact.deleted — already existed in
 *  workspace.types.ts's AuditEventType, just never written for contacts). */
async function logContactAudit(
  workspaceId: string, actorId: string | undefined, contactId: string,
  type: 'contact.updated' | 'contact.deleted', label: string
): Promise<void> {
  try {
    if (!actorId || !Types.ObjectId.isValid(actorId)) return;
    const actor = await User.findById(actorId).select('name email').lean();
    if (!actor) return;
    await AuditLog.create({
      workspaceId: new Types.ObjectId(workspaceId),
      actor: { id: actor._id, name: actor.name, email: actor.email },
      type,
      target: { type: 'contact', id: contactId, label },
    });
  } catch { /* audit failure is non-fatal */ }
}

function toContactResponse(doc: any): ContactResponse {
  return {
    id: doc._id.toString(),
    phone: doc.phone,
    name: doc.name,
    email: doc.email,
    company: doc.company,
    position: doc.position,
    avatarUrl: doc.avatarUrl,
    tags: doc.tags || [],
    status: doc.status || "active",
    source: doc.source || "whatsapp",
    notes: doc.notes,
    lastSeenAt: doc.lastSeenAt?.toISOString(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    conversationCount: doc.conversationCount || 0,
    whatsappOptInAt: doc.whatsappOptInAt?.toISOString(),
    whatsappOptInSource: doc.whatsappOptInSource,
    whatsappOptInProof: doc.whatsappOptInProof,
  };
}

function toContactDetailResponse(doc: any, recentMessages: any[] = []): ContactDetailResponse {
  return {
    ...toContactResponse(doc),
    pushName: doc.pushName,
    jid: doc.jid,
    customFields: doc.customFields instanceof Map ? Object.fromEntries(doc.customFields) : (doc.customFields ?? {}),
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
  // Matches the real permission matrix (workspace.types.ts): agent has contacts:write
  // but not contacts:delete; viewer has neither.
  const canWrite = { preHandler: [fastify.authenticate, requireRole(["owner", "admin", "agent"])] };
  const canDelete = { preHandler: [fastify.authenticate, requireRole(["owner", "admin"])] };

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

  fastify.post("/", canWrite, async (request, reply) => {
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
        company: input.company,
        position: input.position,
        tags: input.tags,
        notes: input.notes,
        source: input.source,
        ...(input.marketingOptIn ? {
          whatsappOptInAt: new Date(),
          whatsappOptInSource: input.marketingOptInSource ?? 'manual',
          whatsappOptInProof: input.marketingOptInProof,
        } : {}),
      });

      reply.status(201).send(toContactResponse(contact));
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  // POST /api/contacts/import — bulk create/update from a client-parsed CSV.
  // Uses bulkWrite+upsert (not the single-contact 409-on-duplicate path above)
  // so a batch with some already-existing contacts doesn't fail outright.
  fastify.post("/import", canWrite, async (request, reply) => {
    try {
      const { workspaceId } = request.user as { workspaceId: string };
      const input = ImportContactsSchema.parse(request.body);
      const wsObjectId = new Types.ObjectId(workspaceId);
      const optInAt = input.marketingOptIn ? new Date() : undefined;

      const seenJids = new Set<string>();
      const errors: { row: number; reason: string }[] = [];
      const ops: Array<{
        updateOne: {
          filter: { workspaceId: Types.ObjectId; jid: string };
          update: { $set: Record<string, unknown>; $unset?: Record<string, 1> };
          upsert: true;
        };
      }> = [];

      input.contacts.forEach((c, row) => {
        const phone = c.phone.replace(/\D/g, "");
        if (!phone) { errors.push({ row, reason: "Telefone inválido" }); return; }
        const jid = `${phone}@s.whatsapp.net`;
        if (seenJids.has(jid)) { errors.push({ row, reason: "Duplicado na planilha" }); return; }
        seenJids.add(jid);
        ops.push({
          updateOne: {
            filter: { workspaceId: wsObjectId, jid },
            update: {
              $set: {
                phone, jid, name: c.name, email: c.email, tags: c.tags, notes: c.notes, source: "import",
                ...(optInAt ? {
                  whatsappOptInAt: optInAt,
                  whatsappOptInSource: input.marketingOptInSource!.trim(),
                  ...(input.marketingOptInProof?.trim() ? { whatsappOptInProof: input.marketingOptInProof.trim() } : {}),
                } : {}),
              },
              ...(optInAt ? { $unset: { optedOutAt: 1 } } : {}),
            },
            upsert: true,
          },
        });
      });

      if (ops.length === 0) {
        return reply.send({ created: 0, updated: 0, skipped: errors.length, errors });
      }

      const result = await Contact.bulkWrite(ops, { ordered: false });
      reply.send({
        created: result.upsertedCount ?? 0,
        updated: result.modifiedCount ?? 0,
        skipped: errors.length,
        errors,
      });
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.patch<{ Params: { id: string } }>("/:id", canWrite, async (request, reply) => {
    try {
      const { workspaceId, sub } = request.user as { workspaceId: string; sub?: string };
      const { id } = request.params;

      if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: "Invalid contact ID" });

      const input = UpdateContactSchema.parse(request.body);

      const contact = await Contact.findOneAndUpdate(
        { _id: new Types.ObjectId(id), workspaceId: new Types.ObjectId(workspaceId) },
        {
          $set: {
            ...(input.name && { name: input.name }),
            ...(input.email !== undefined && { email: input.email }),
            ...(input.company !== undefined && { company: input.company }),
            ...(input.position !== undefined && { position: input.position }),
            ...(input.tags && { tags: input.tags }),
            ...(input.notes !== undefined && { notes: input.notes }),
            ...(input.status && { status: input.status }),
            ...(input.marketingOptIn === true && {
              whatsappOptInAt: new Date(),
              whatsappOptInSource: input.marketingOptInSource ?? 'manual',
              ...(input.marketingOptInProof ? { whatsappOptInProof: input.marketingOptInProof } : {}),
            }),
            ...(input.marketingOptIn === false && { optedOutAt: new Date() }),
          },
          ...(input.marketingOptIn === true ? { $unset: { optedOutAt: 1 } } : {}),
          ...(input.marketingOptIn === false ? { $unset: { whatsappOptInAt: 1, whatsappOptInSource: 1, whatsappOptInProof: 1 } } : {}),
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

      if (input.status) {
        const STATUS_LABEL: Record<string, string> = { active: "reativado", blocked: "bloqueado", archived: "arquivado" };
        void logContactAudit(workspaceId, sub, id, "contact.updated", `Contato ${STATUS_LABEL[input.status] ?? input.status}`);
      }

      reply.send(toContactResponse(contact));
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.delete<{ Params: { id: string } }>("/:id", canDelete, async (request, reply) => {
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

  // POST /api/contacts/:id/merge — merge duplicate contacts into :id (the
  // survivor); sourceIds are folded in and deleted. Same role gate as DELETE
  // /:id since this permanently removes the source contacts.
  fastify.post<{ Params: { id: string }; Body: { sourceIds?: string[] } }>("/:id/merge", canDelete, async (request, reply) => {
    try {
      const { workspaceId, sub } = request.user as { workspaceId: string; sub?: string };
      const { id } = request.params;
      const sourceIds = (request.body.sourceIds ?? []).filter((sid) => Types.ObjectId.isValid(sid) && sid !== id);

      if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: "Invalid contact ID" });
      if (sourceIds.length === 0) return reply.status(400).send({ error: "sourceIds é obrigatório" });

      const wsId = new Types.ObjectId(workspaceId);
      const primary = await Contact.findOne({ _id: id, workspaceId: wsId });
      if (!primary) return reply.status(404).send({ error: "Contact not found" });

      const sources = await Contact.find({ _id: { $in: sourceIds }, workspaceId: wsId });
      if (sources.length === 0) return reply.status(404).send({ error: "Nenhum contato duplicado encontrado" });

      // Union tags, fill blank scalar fields, append secondary notes.
      const tagSet = new Set(primary.tags ?? []);
      const noteLines: string[] = [];
      for (const s of sources) {
        for (const t of s.tags ?? []) tagSet.add(t);
        if (!primary.email && s.email) primary.email = s.email;
        if (!primary.company && s.company) primary.company = s.company;
        if (!primary.position && s.position) primary.position = s.position;
        if (s.notes?.trim()) noteLines.push(s.notes.trim());
      }
      primary.tags = [...tagSet];
      if (noteLines.length) primary.notes = [primary.notes?.trim(), ...noteLines].filter(Boolean).join("\n---\n");
      await primary.save();

      // Reassign every relation that points at a merged-away contact.
      const sourceObjectIds = sources.map((s) => s._id);
      await Promise.all([
        Conversation.updateMany({ workspaceId: wsId, contactId: { $in: sourceObjectIds } }, { $set: { contactId: primary._id } }),
        Lead.updateMany({ workspaceId: wsId, contactId: { $in: sourceObjectIds } }, { $set: { contactId: primary._id } }),
        CampaignRecipient.updateMany({ contactId: { $in: sourceObjectIds } }, { $set: { contactId: primary._id } }),
      ]);

      await Contact.deleteMany({ _id: { $in: sourceObjectIds } });

      void logContactAudit(workspaceId, sub, id, "contact.updated", `Mesclado com ${sources.length} contato(s) duplicado(s)`);

      reply.send(toContactResponse(primary));
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.post<{ Params: { id: string }; Body: { tag: string } }>("/:id/tags", canWrite, async (request, reply) => {
    try {
      const { workspaceId, sub } = request.user as { workspaceId: string; sub?: string };
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
      void logContactAudit(workspaceId, sub, id, 'contact.updated', `Etiqueta "${tag.trim()}" adicionada`);
      reply.send(toContactResponse(contact));
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.delete<{ Params: { id: string; tag: string } }>("/:id/tags/:tag", canWrite, async (request, reply) => {
    try {
      const { workspaceId, sub } = request.user as { workspaceId: string; sub?: string };
      const { id, tag } = request.params;

      if (!Types.ObjectId.isValid(id)) return reply.status(400).send({ error: "Invalid contact ID" });

      const contact = await Contact.findOneAndUpdate(
        { _id: new Types.ObjectId(id), workspaceId: new Types.ObjectId(workspaceId) },
        { $pull: { tags: decodeURIComponent(tag) } },
        { new: true }
      );

      if (!contact) return reply.status(404).send({ error: "Contact not found" });
      void logContactAudit(workspaceId, sub, id, 'contact.updated', `Etiqueta "${decodeURIComponent(tag)}" removida`);
      reply.send(toContactResponse(contact));
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.post("/batch/tags", canWrite, async (request, reply) => {
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

      const [conversations, auditEntries] = await Promise.all([
        Conversation.find({
          workspaceId: new Types.ObjectId(workspaceId),
          $or: [{ jid: contact.jid }, { contactId: contact._id }],
        }).sort({ updatedAt: -1 }).limit(10),
        AuditLog.find({
          workspaceId: new Types.ObjectId(workspaceId),
          "target.type": "contact",
          "target.id": id,
        }).sort({ createdAt: -1 }).limit(30),
      ]);

      const messageActivity = conversations.map((conv) => ({
        id: conv._id.toString(),
        type: "message" as const,
        description: conv.lastMessage?.content || "Conversa iniciada",
        metadata: { conversationId: conv._id.toString(), status: conv.status },
        timestamp: conv.updatedAt.toISOString(),
        actor: { id: "system", name: "Sistema" },
      }));

      // AuditLog.type is 'contact.updated'/'contact.deleted' — map to the
      // frontend timeline's tag_added/status_changed buckets via the label text.
      const auditActivity = auditEntries.map((entry) => ({
        id: entry._id.toString(),
        type: (entry.target?.label ?? "").startsWith("Etiqueta") ? ("tag_added" as const) : ("status_changed" as const),
        description: entry.target?.label ?? "Contato atualizado",
        metadata: entry.metadata ?? {},
        timestamp: entry.createdAt.toISOString(),
        actor: { id: entry.actor.id.toString(), name: entry.actor.name },
      }));

      const activity = [...messageActivity, ...auditActivity].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      reply.send({ data: activity });
    } catch (err) {
      fastify.log.error(err);
      reply.status(400).send({ error: "Invalid request" });
    }
  });

  fastify.post("/batch/status", canWrite, async (request, reply) => {
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
