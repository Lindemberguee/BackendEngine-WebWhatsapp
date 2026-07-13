import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { Message, Conversation, Instance } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import type { WAMessage } from '@webwhatsapp/engine';
import { lastMessagePreview } from '../../utils/message.utils';
import type { MessageType } from '../../db/models';
import { markFirstResponse } from '../routing/sla.service';

// Minimal shape of a @fastify/multipart part (the plugin's type augmentation isn't
// reliably picked up here, so we access request.parts() through this cast).
interface MultipartPart {
  type: 'file' | 'field';
  fieldname: string;
  filename?: string;
  mimetype?: string;
  value?: unknown;
  toBuffer(): Promise<Buffer>;
}
type MultipartRequest = FastifyRequest & { parts(): AsyncIterableIterator<MultipartPart> };

/** Map a MIME type to our message type when the client didn't send an explicit one. */
function inferType(mime: string): 'image' | 'video' | 'audio' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Recursively convert BSON Binary values back to Node Buffers. Mongo persists
 * Buffers as Binary; Baileys' media crypto (mediaKey, fileEncSha256, …) needs real
 * byte arrays, so a stored payload must be normalized before downloadMediaMessage.
 */
function normalizeBinary(value: unknown): unknown {
  if (value == null || Buffer.isBuffer(value)) return value;
  const b = value as { _bsontype?: string; buffer?: Buffer; value?: () => Buffer };
  if (b._bsontype === 'Binary') {
    if (Buffer.isBuffer(b.buffer)) return b.buffer;
    if (typeof b.value === 'function') return Buffer.from(b.value());
  }
  if (Array.isArray(value)) return value.map(normalizeBinary);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object)) {
      out[k] = normalizeBinary((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export async function messagesRoutes(fastify: FastifyInstance, opts: { sessionManager: SessionManager }): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };

  // GET /api/conversations/:conversationId/messages
  fastify.get('/:conversationId/messages', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { conversationId } = request.params as { conversationId: string };
    const { page = '1', limit = '30' } = request.query as Record<string, string>;

    const conv = await Conversation.findOne({ _id: conversationId, workspaceId });
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

    const skip = (Number(page) - 1) * Number(limit);
    const [msgDocs, total] = await Promise.all([
      Message.find({ conversationId }).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Message.countDocuments({ conversationId }),
    ]);

    const data = msgDocs.map((m) => m.toJSON()).reverse(); // oldest first

    return reply.send({
      data,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)), hasNextPage: skip + data.length < total },
    });
  });

  // POST /api/conversations/:conversationId/messages  — send message
  fastify.post('/:conversationId/messages', auth, async (request, reply) => {
    const { workspaceId, sub: agentId } = request.user as { workspaceId: string; sub: string };
    const { conversationId } = request.params as { conversationId: string };
    const body = request.body as { type: string; text?: string; url?: string; caption?: string; fileName?: string; mimeType?: string; quotedMessageId?: string };

    try {
      const conv = await Conversation.findOne({ _id: conversationId, workspaceId });
      if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

      // Resolve the instance to send through. Older conversations may have no
      // instanceId stored, so fall back to any connectable instance and backfill it.
      let resolvedInstanceId = conv.instanceId;
      if (!resolvedInstanceId) {
        const inst = await Instance.findOne({ workspaceId, status: { $in: ['connected', 'connecting', 'error'] } });
        if (!inst) return reply.status(503).send({ error: 'Nenhuma instância WhatsApp configurada' });
        resolvedInstanceId = inst._id;
        await Conversation.updateOne({ _id: conversationId }, { $set: { instanceId: inst._id } });
      }

      // Lazily (re)establish the session if it isn't in memory (e.g. after a server
      // restart orphaned it), then wait for the WhatsApp connection to be open.
      const session = await opts.sessionManager.ensureSession(resolvedInstanceId.toString());
      const ready = await session.waitUntilReady(8000);
      if (!ready) {
        return reply.status(503).send({ error: 'WhatsApp reconectando. Tente novamente em alguns segundos.' });
      }

      // Build Baileys content
      let baileysContent: Record<string, unknown>;
      if (body.type === 'text' && body.text) {
        baileysContent = { text: body.text };
      } else if (body.type === 'image' && body.url) {
        baileysContent = { image: { url: body.url }, caption: body.caption };
      } else if (body.type === 'video' && body.url) {
        baileysContent = { video: { url: body.url }, caption: body.caption };
      } else if (body.type === 'audio' && body.url) {
        baileysContent = { audio: { url: body.url }, mimetype: body.mimeType ?? 'audio/mp4' };
      } else if (body.type === 'document' && body.url) {
        baileysContent = { document: { url: body.url }, mimetype: body.mimeType ?? 'application/octet-stream', fileName: body.fileName };
      } else {
        return reply.status(400).send({ error: 'Tipo de mensagem inválido ou campos faltando' });
      }

      const options: Record<string, unknown> = {};
      if (body.quotedMessageId) {
        const quoted = await Message.findOne({ messageId: body.quotedMessageId, conversationId }).lean();
        if (quoted?.rawPayload) options.quoted = { key: { id: quoted.messageId, remoteJid: conv.jid }, message: quoted.rawPayload };
      }

      const sent = await session.sendMessage(conv.jid, baileysContent as never, options);

      const savedMsg = await Message.create({
        workspaceId,
        instanceId: resolvedInstanceId,
        conversationId,
        jid: conv.jid,
        messageId: sent?.key?.id ?? `temp_${Date.now()}`,
        direction: 'outbound',
        type: body.type,
        status: 'sent',
        fromMe: true,
        content: { text: body.text, url: body.url, caption: body.caption, fileName: body.fileName, mimeType: body.mimeType },
        agentId,
        quotedMessageId: body.quotedMessageId,
      });

      await Conversation.updateOne({ _id: conversationId }, {
        lastMessage: {
          content: lastMessagePreview(body.type as MessageType, body.text ?? body.caption ?? ''),
          type: body.type,
          direction: 'outbound',
          timestamp: new Date(),
        },
      });
      // A human agent (not a flow/bot) just replied — stop the first-response SLA clock.
      void markFirstResponse(conversationId);

      return reply.status(201).send(savedMsg);
    } catch (err) {
      fastify.log.error({ err, conversationId }, 'Failed to send message');
      return reply.status(500).send({ error: `Falha ao enviar: ${(err as Error).message}` });
    }
  });

  // POST /api/conversations/:conversationId/messages/media — send an uploaded file
  // Accepts multipart/form-data: file + fields (type, caption, quotedMessageId).
  // The file bytes are sent to Baileys directly (a browser blob: URL can't be fetched
  // server-side, which is why URL-based media sending never worked).
  fastify.post('/:conversationId/messages/media', auth, async (request, reply) => {
    const { workspaceId, sub: agentId } = request.user as { workspaceId: string; sub: string };
    const { conversationId } = request.params as { conversationId: string };

    try {
      // ── Parse multipart ────────────────────────────────────────────────────
      let buffer: Buffer | undefined;
      let fileName = 'arquivo';
      let fileMime = 'application/octet-stream';
      const fields: Record<string, string> = {};
      for await (const part of (request as MultipartRequest).parts()) {
        if (part.type === 'file') {
          buffer = await part.toBuffer();
          fileName = part.filename || fileName;
          fileMime = part.mimetype || fileMime;
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
      if (!buffer || buffer.length === 0) return reply.status(400).send({ error: 'Arquivo ausente' });

      const type = (fields.type as 'image' | 'video' | 'audio' | 'document') || inferType(fileMime);
      const caption = fields.caption?.trim() || undefined;

      const conv = await Conversation.findOne({ _id: conversationId, workspaceId });
      if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

      // Resolve + ready the session (same self-healing path as text send).
      let resolvedInstanceId = conv.instanceId;
      if (!resolvedInstanceId) {
        const inst = await Instance.findOne({ workspaceId, status: { $in: ['connected', 'connecting', 'error'] } });
        if (!inst) return reply.status(503).send({ error: 'Nenhuma instância WhatsApp configurada' });
        resolvedInstanceId = inst._id;
        await Conversation.updateOne({ _id: conversationId }, { $set: { instanceId: inst._id } });
      }
      const session = await opts.sessionManager.ensureSession(resolvedInstanceId.toString());
      if (!(await session.waitUntilReady(8000))) {
        return reply.status(503).send({ error: 'WhatsApp reconectando. Tente novamente em alguns segundos.' });
      }

      // Build Baileys content from the raw buffer.
      let baileysContent: Record<string, unknown>;
      if (type === 'image') baileysContent = { image: buffer, caption };
      else if (type === 'video') baileysContent = { video: buffer, caption };
      else if (type === 'audio') baileysContent = { audio: buffer, mimetype: fileMime, ptt: fields.ptt === 'true' };
      else baileysContent = { document: buffer, mimetype: fileMime, fileName, caption };

      const options: Record<string, unknown> = {};
      if (fields.quotedMessageId) {
        const quoted = await Message.findOne({ messageId: fields.quotedMessageId, conversationId }).lean();
        if (quoted?.rawPayload) options.quoted = { key: { id: quoted.messageId, remoteJid: conv.jid }, message: quoted.rawPayload };
      }

      const sent = await session.sendMessage(conv.jid, baileysContent as never, options);

      // Persist with a proxy URL so it renders on reload, and keep the sent payload
      // so the media can be re-downloaded later.
      const msgObjectId = new Types.ObjectId();
      const url = `/api/conversations/${conversationId}/messages/${msgObjectId}/media`;
      const savedMsg = await Message.create({
        _id: msgObjectId,
        workspaceId,
        instanceId: resolvedInstanceId,
        conversationId,
        jid: conv.jid,
        messageId: sent?.key?.id ?? `temp_${Date.now()}`,
        direction: 'outbound',
        type,
        status: 'sent',
        fromMe: true,
        content: { caption, fileName, mimeType: fileMime, url, fileSize: buffer.length },
        agentId,
        quotedMessageId: fields.quotedMessageId,
        rawPayload: sent as unknown as Record<string, unknown>,
      });

      await Conversation.updateOne({ _id: conversationId }, {
        lastMessage: { content: lastMessagePreview(type, caption ?? ''), type, direction: 'outbound', timestamp: new Date() },
      });
      void markFirstResponse(conversationId);

      return reply.status(201).send(savedMsg);
    } catch (err) {
      fastify.log.error({ err, conversationId }, 'Failed to send media');
      return reply.status(500).send({ error: `Falha ao enviar mídia: ${(err as Error).message}` });
    }
  });

  // GET /api/conversations/:conversationId/messages/:messageId/media — stream media
  fastify.get('/:conversationId/messages/:messageId/media', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { conversationId, messageId } = request.params as { conversationId: string; messageId: string };

    const msg = await Message.findOne({ _id: messageId, workspaceId, conversationId }).lean();
    if (!msg) return reply.status(404).send({ error: 'Mensagem não encontrada' });
    if (!msg.rawPayload) return reply.status(404).send({ error: 'Mídia não disponível' });

    try {
      const { downloadMediaMessage } = await import('@webwhatsapp/engine');

      // Mongo stores Buffers as BSON Binary. Baileys' crypto needs raw Uint8Array/Buffer
      // (mediaKey, fileEncSha256, etc.) — pass a Binary and decryption silently fails.
      // Normalize the whole payload back to Buffers before downloading.
      const rawMessage = normalizeBinary(msg.rawPayload) as WAMessage;

      // Provide reuploadRequest so media whose CDN URL expired can be re-fetched.
      const session = msg.instanceId ? opts.sessionManager.getSession(msg.instanceId.toString()) : null;
      const reuploadRequest = session?.updateMediaMessage;

      const buffer = await downloadMediaMessage(
        rawMessage,
        'buffer',
        {},
        reuploadRequest ? { logger: fastify.log as never, reuploadRequest } : {} as never
      );

      const inner = rawMessage.message ?? {};
      const mimeType =
        (inner.imageMessage?.mimetype || inner.videoMessage?.mimetype || inner.audioMessage?.mimetype ||
         inner.documentMessage?.mimetype || inner.stickerMessage?.mimetype) ??
        ((msg.content as Record<string, unknown>)?.mimeType as string | undefined) ??
        'application/octet-stream';

      reply.header('Content-Type', mimeType);
      reply.header('Cache-Control', 'private, max-age=604800');
      return reply.send(buffer);
    } catch (err) {
      const errorCode = (err as { code?: string }).code;
      const level = errorCode === 'ERR_OSSL_BAD_DECRYPT' ? 'warn' : 'error';
      fastify.log[level]({ err, messageId }, 'Failed to download media');
      return reply.status(410).send({ error: 'Mídia não disponível ou expirada' });
    }
  });

  // DELETE /api/conversations/:conversationId/messages/:messageId
  fastify.delete('/:conversationId/messages/:messageId', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const { conversationId, messageId } = request.params as { conversationId: string; messageId: string };

    const conv = await Conversation.findOne({ _id: conversationId, workspaceId });
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

    const msg = await Message.findOne({ _id: messageId, conversationId });
    if (!msg) return reply.status(404).send({ error: 'Mensagem não encontrada' });

    const session = conv.instanceId ? opts.sessionManager.getSession(conv.instanceId.toString()) : undefined;
    if (session && msg.fromMe) {
      try {
        await session.sendMessage(conv.jid, { delete: { id: msg.messageId, remoteJid: conv.jid, fromMe: true } } as never);
      } catch { /* ignore if WA delete fails */ }
    }

    await Message.updateOne({ _id: messageId }, { status: 'deleted' });
    return reply.send({ ok: true });
  });
}

