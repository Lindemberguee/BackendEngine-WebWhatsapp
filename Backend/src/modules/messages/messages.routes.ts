import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { Message, Conversation, Instance, WhatsAppTemplate } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import type { WebSocketGateway } from '../../ws/gateway';
import type { WAMessage, WASocket } from '@webwhatsapp/engine';
import { lastMessagePreview, extractPreview } from '../../utils/message.utils';
import type { MessageType } from '../../db/models';
import { markFirstResponse } from '../routing/sla.service';
import { sendTextMessageViaSession, resolveFallbackInstance } from './send-message.service';
import { scopeConversationFilter } from '../../utils/conversation-visibility';
import { requireRole } from '../../utils/require-role';
import { decryptSecret } from '../../shared/crypto';
import { downloadCloudApiMedia, uploadCloudApiMedia, sendCloudApiMessage } from '../../channels/cloud-api/graph-client';
import { isPublicHttpUrl } from '../../shared/url-security';
import { parsePagination } from '../../utils/pagination';
import { archiveMessageMedia, readMedia } from '../../shared/media-storage';

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

// Bounds what a client can push through to WhatsApp as an uploaded "document" —
// without this, `type: 'document'` accepts literally any mimetype (executables,
// scripts, etc.) since inferType() falls back to 'document' for anything unmatched.
const ALLOWED_MEDIA_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'text/plain', 'text/csv', 'application/zip'];

function isAllowedMediaMime(mime: string): boolean {
  return ALLOWED_MEDIA_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
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

export async function messagesRoutes(fastify: FastifyInstance, opts: { sessionManager: SessionManager; wsGateway: WebSocketGateway }): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };
  // A viewer can read the thread but must not be able to send/delete/react as the
  // agent — same read-vs-write split as conversations.routes.ts.
  const canWrite = { preHandler: [fastify.authenticate, requireRole(['owner', 'admin', 'agent'])] };

  // GET /api/conversations/:conversationId/messages
  fastify.get('/:conversationId/messages', auth, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { conversationId } = request.params as { conversationId: string };
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>, { limit: 30 });

    const conv = await Conversation.findOne(scopeConversationFilter({ _id: conversationId, workspaceId }, { role, sub }));
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

    // rawPayload holds the full Baileys WAMessage protobuf (including inline media
    // thumbnails) — toJSON() already strips it before the response goes out, so
    // fetching it here just to discard it means reading/transferring several times
    // the useful payload size for every page of every open conversation. The few
    // routes that actually need it (quote lookup, media download below) query it
    // explicitly by _id.
    const [msgDocs, total] = await Promise.all([
      Message.find({ conversationId }).select('-rawPayload').sort({ createdAt: -1 }).skip(skip).limit(limit),
      Message.countDocuments({ conversationId }),
    ]);

    const data = msgDocs.map((m) => m.toJSON()).reverse(); // oldest first

    return reply.send({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasNextPage: skip + data.length < total },
    });
  });

  // POST /api/conversations/:conversationId/messages  — send message
  fastify.post('/:conversationId/messages', canWrite, async (request, reply) => {
    const { workspaceId, sub: agentId, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { conversationId } = request.params as { conversationId: string };
    const body = request.body as { type: string; text?: string; url?: string; caption?: string; fileName?: string; mimeType?: string; quotedMessageId?: string; templateName?: string; language?: string; variables?: string[]; components?: unknown[] };

    try {
      // Visibility check up front — sendTextMessageViaSession does its own
      // internal lookup (unscoped, since it's also called by the scheduler
      // with no human actor), so this is the only place text sends get gated.
      const conv = await Conversation.findOne(scopeConversationFilter({ _id: conversationId, workspaceId }, { role, sub: agentId }));
      if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

      // Template — the only send type that goes through the channel-neutral
      // IChannelSession.sendMessage() rather than the Baileys-only sendRaw()
      // path below. This is what lets an agent reply outside the Cloud API's
      // 24h window (any other type would be rejected by CloudApiSession.sendMessage).
      if (body.type === 'template' && body.templateName && body.language) {
        if (!conv.instanceId) return reply.status(503).send({ error: 'Nenhuma instância configurada para esta conversa' });
        const approved = await WhatsAppTemplate.exists({ workspaceId, instanceId: conv.instanceId, name: body.templateName, language: body.language, status: 'APPROVED' });
        if (!approved) return reply.status(400).send({ error: 'Template não encontrado ou ainda não aprovado pela Meta. Sincronize os templates e tente novamente.' });
        const session = await opts.sessionManager.ensureSession(conv.instanceId.toString());
        const variables = Array.isArray(body.variables) ? body.variables : [];
        const components = Array.isArray(body.components)
          ? body.components
          : variables.length ? [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: String(v ?? '') })) }] : undefined;
        let sent: { providerMessageId?: string };
        try {
          sent = await session.sendMessage(conv.jid, { kind: 'template', templateName: body.templateName, language: body.language, components });
        } catch (err) {
          return reply.status(400).send({ error: (err as Error).message });
        }
        const messageId = sent.providerMessageId ?? `template-${Date.now()}`;
        const savedMsg = await Message.create({
          workspaceId, instanceId: conv.instanceId, conversationId, jid: conv.jid, messageId,
          direction: 'outbound', type: 'text', status: 'sent', fromMe: true, agentId,
          content: { text: `📄 Template: ${body.templateName}`, template: { name: body.templateName, language: body.language, components } },
        });
        await Conversation.updateOne({ _id: conversationId }, {
          $set: { lastMessage: { content: `📄 Template: ${body.templateName}`, type: 'text', direction: 'outbound', timestamp: new Date() } },
        });
        opts.wsGateway.broadcastToConversationVisibility(workspaceId, conv.assignedAgentId?.toString(), 'message:new', {
          conversationId,
          message: {
            id: savedMsg._id.toString(), conversationId, type: savedMsg.type, content: savedMsg.content,
            direction: savedMsg.direction, status: savedMsg.status, timestamp: savedMsg.createdAt.toISOString(),
          },
        });
        return reply.status(201).send(savedMsg);
      }

      // Text goes through the shared service (also used by the scheduled-message
      // dispatcher) — everything else (image/video/audio/document) stays inline below.
      if (body.type === 'text' && body.text) {
        const result = await sendTextMessageViaSession({
          workspaceId,
          conversationId,
          text: body.text,
          agentId,
          quotedMessageId: body.quotedMessageId,
          sessionManager: opts.sessionManager,
        });
        if (!result.ok) return reply.status(result.status).send({ error: result.error });
        // See the image/video/audio/document branch below for why this is needed —
        // without it only the sending agent's own tab (via its optimistic update)
        // ever saw the message.
        opts.wsGateway.broadcastToConversationVisibility(workspaceId, conv.assignedAgentId?.toString(), 'message:new', {
          conversationId,
          message: {
            id: result.message._id.toString(),
            conversationId,
            type: result.message.type,
            content: result.message.content,
            direction: result.message.direction,
            status: result.message.status,
            timestamp: result.message.createdAt.toISOString(),
            quoted: result.message.quoted,
          },
        });
        return reply.status(201).send(result.message);
      }

      // Resolve the instance to send through. Older conversations may have no
      // instanceId stored, so fall back to any connectable instance and backfill it.
      let resolvedInstanceId = conv.instanceId;
      if (!resolvedInstanceId) {
        const inst = await resolveFallbackInstance(workspaceId);
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

      // `body.url` is client-controlled and gets handed straight to the engine, which
      // falls back to reading it as a local file path (fs.createReadStream) for
      // anything that isn't http(s) — a client asking for "document" with
      // url:"/proc/self/environ" or "/app/.env" made the server read and send back
      // its own secrets over WhatsApp. Reject anything that isn't a public http(s)
      // URL before it ever reaches Baileys (also blocks SSRF to internal services).
      if (body.url && !isPublicHttpUrl(body.url)) {
        return reply.status(400).send({ error: 'URL de mídia inválida ou aponta para um host interno' });
      }

      // Build Baileys content
      let baileysContent: Record<string, unknown>;
      if (body.type === 'image' && body.url) {
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
      // quotedMessageId is our Mongo _id (see chat.api.ts toMessage()), not WhatsApp's own key.id —
      // querying by the wrong field silently dropped every reply-quote before it reached Baileys.
      let quotedContext: Record<string, unknown> | undefined;
      if (body.quotedMessageId && Types.ObjectId.isValid(body.quotedMessageId)) {
        const quoted = await Message.findOne({ _id: body.quotedMessageId, conversationId }).lean();
        if (quoted?.rawPayload) options.quoted = { key: { id: quoted.messageId, remoteJid: conv.jid }, message: quoted.rawPayload };
        // The schema has no `quotedMessageId` field — it was being silently dropped by
        // Mongoose on every send, so the reply-to context never survived a reload.
        // Build the actual `quoted` subdocument instead, same shape used for inbound replies.
        if (quoted) {
          quotedContext = {
            messageId: quoted.messageId,
            type: quoted.type,
            preview: extractPreview(quoted as never),
            senderName: quoted.fromMe ? 'Você' : quoted.senderName,
            timestamp: quoted.createdAt,
          };
        }
      }

      let providerMessageId: string | undefined;
      if (session.channel === 'cloud_api') {
        const instance = await Instance.findById(resolvedInstanceId).select('cloudApi').lean();
        if (!instance?.cloudApi) return reply.status(503).send({ error: 'Instância da API Oficial sem credenciais' });
        const creds = { phoneNumberId: instance.cloudApi.phoneNumberId, accessToken: decryptSecret(instance.cloudApi.accessTokenEnc), graphVersion: instance.cloudApi.graphVersion };
        const linkBody: Record<string, unknown> = {
          type: body.type,
          [body.type]: { link: body.url, caption: body.caption, filename: body.fileName },
          ...(quotedContext?.messageId ? { context: { message_id: quotedContext.messageId } } : {}),
        };
        const result = await sendCloudApiMessage(creds, conv.jid.replace(/\D/g, ''), linkBody);
        providerMessageId = result.id;
      } else {
        const sent = await session.sendRaw!(conv.jid, baileysContent as never, options) as WAMessage | undefined;
        providerMessageId = sent?.key?.id;
      }

      let savedMsg;
      try {
        savedMsg = await Message.create({
          workspaceId,
          instanceId: resolvedInstanceId,
          conversationId,
          jid: conv.jid,
          messageId: providerMessageId ?? `temp_${Date.now()}`,
          direction: 'outbound',
          type: body.type,
          status: 'sent',
          fromMe: true,
          content: { text: body.text, url: body.url, caption: body.caption, fileName: body.fileName, mimeType: body.mimeType },
          agentId,
          quoted: quotedContext,
        });
      } catch (err) {
        // See send-message.service.ts's identical guard — Baileys' echo of our own
        // outgoing message can race this insert on the unique messageId index.
        if ((err as { code?: number }).code === 11000 && providerMessageId) {
          const existing = await Message.findOne({ workspaceId, messageId: providerMessageId });
          if (!existing) throw err;
          savedMsg = existing;
        } else {
          throw err;
        }
      }

      // Shape must match the frontend Message contract — mirrors BaileysSession's
      // own 'message:new' broadcast (see its comment on the createdAt → timestamp
      // mapping). Without this, only the sending agent's own tab saw the message
      // (via its optimistic update); every other connected tab/agent didn't.
      opts.wsGateway.broadcastToConversationVisibility(workspaceId, conv.assignedAgentId?.toString(), 'message:new', {
        conversationId,
        message: {
          id: savedMsg._id.toString(),
          conversationId,
          type: savedMsg.type,
          content: savedMsg.content,
          direction: savedMsg.direction,
          status: savedMsg.status,
          timestamp: savedMsg.createdAt.toISOString(),
          quoted: savedMsg.quoted,
        },
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
  fastify.post('/:conversationId/messages/media', canWrite, async (request, reply) => {
    const { workspaceId, sub: agentId, role } = request.user as { workspaceId: string; sub: string; role: string };
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
      if (!isAllowedMediaMime(fileMime)) return reply.status(400).send({ error: 'Tipo de arquivo não suportado' });

      const type = (fields.type as 'image' | 'video' | 'audio' | 'document') || inferType(fileMime);
      const caption = fields.caption?.trim() || undefined;

      const conv = await Conversation.findOne(scopeConversationFilter({ _id: conversationId, workspaceId }, { role, sub: agentId }));
      if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

      // Resolve + ready the session (same self-healing path as text send).
      let resolvedInstanceId = conv.instanceId;
      if (!resolvedInstanceId) {
        const inst = await resolveFallbackInstance(workspaceId);
        if (!inst) return reply.status(503).send({ error: 'Nenhuma instância WhatsApp configurada' });
        resolvedInstanceId = inst._id;
        await Conversation.updateOne({ _id: conversationId }, { $set: { instanceId: inst._id } });
      }
      const session = await opts.sessionManager.ensureSession(resolvedInstanceId.toString());
      if (!(await session.waitUntilReady(8000))) {
        return reply.status(503).send({ error: 'WhatsApp reconectando. Tente novamente em alguns segundos.' });
      }

      const options: Record<string, unknown> = {};
      // Same fix as the text-send route above — quotedMessageId is our Mongo _id, not WhatsApp's key.id.
      let quotedContext: Record<string, unknown> | undefined;
      if (fields.quotedMessageId && Types.ObjectId.isValid(fields.quotedMessageId)) {
        const quoted = await Message.findOne({ _id: fields.quotedMessageId, conversationId }).lean();
        if (quoted?.rawPayload) options.quoted = { key: { id: quoted.messageId, remoteJid: conv.jid }, message: quoted.rawPayload };
        if (quoted) {
          quotedContext = {
            messageId: quoted.messageId,
            type: quoted.type,
            preview: extractPreview(quoted as never),
            senderName: quoted.fromMe ? 'Você' : quoted.senderName,
            timestamp: quoted.createdAt,
          };
        }
      }

      let providerMessageId: string | undefined;
      let rawSent: Record<string, unknown> | undefined;
      if (session.channel === 'cloud_api') {
        // Cloud API's `link` field only works for a URL Meta's own servers can
        // reach — an uploaded file has to go through the upload-then-reference
        // flow instead: POST the bytes, get a media ID, send by ID.
        const instance = await Instance.findById(resolvedInstanceId).select('cloudApi').lean();
        if (!instance?.cloudApi) return reply.status(503).send({ error: 'Instância da API Oficial sem credenciais' });
        const creds = { phoneNumberId: instance.cloudApi.phoneNumberId, accessToken: decryptSecret(instance.cloudApi.accessTokenEnc), graphVersion: instance.cloudApi.graphVersion };
        const mediaId = await uploadCloudApiMedia(buffer, fileMime, fileName, creds);
        const body: Record<string, unknown> = type === 'document'
          ? { type, document: { id: mediaId, filename: fileName, caption } }
          : type === 'audio'
          ? { type, audio: { id: mediaId } }
          : { type, [type]: { id: mediaId, caption } };
        if (quotedContext?.messageId) body.context = { message_id: quotedContext.messageId };
        const result = await sendCloudApiMessage(creds, conv.jid.replace(/\D/g, ''), body);
        providerMessageId = result.id;
        // So this same file can be re-served later via the media GET route's
        // cloud_api branch (which reads rawPayload.mediaId), same as an inbound one.
        rawSent = { mediaId };
      } else {
        let baileysContent: Record<string, unknown>;
        if (type === 'image') baileysContent = { image: buffer, caption };
        else if (type === 'video') baileysContent = { video: buffer, caption };
        else if (type === 'audio') baileysContent = { audio: buffer, mimetype: fileMime, ptt: fields.ptt === 'true' };
        else baileysContent = { document: buffer, mimetype: fileMime, fileName, caption };
        const sent = await session.sendRaw!(conv.jid, baileysContent as never, options) as WAMessage | undefined;
        providerMessageId = sent?.key?.id;
        rawSent = sent as unknown as Record<string, unknown> | undefined;
      }

      // Persist with a proxy URL so it renders on reload, and keep the sent payload
      // so the media can be re-downloaded later.
      const msgObjectId = new Types.ObjectId();
      const url = `/api/conversations/${conversationId}/messages/${msgObjectId}/media`;
      let savedMsg;
      try {
        savedMsg = await Message.create({
          _id: msgObjectId,
          workspaceId,
          instanceId: resolvedInstanceId,
          conversationId,
          jid: conv.jid,
          messageId: providerMessageId ?? `temp_${Date.now()}`,
          direction: 'outbound',
          type,
          status: 'sent',
          fromMe: true,
          content: { caption, fileName, mimeType: fileMime, url, fileSize: buffer.length },
          agentId,
          quoted: quotedContext,
          rawPayload: rawSent,
        });
      } catch (err) {
        // See the text-send branch above for why this race exists.
        if ((err as { code?: number }).code === 11000 && providerMessageId) {
          const existing = await Message.findOne({ workspaceId, messageId: providerMessageId });
          if (!existing) throw err;
          savedMsg = existing;
        } else {
          throw err;
        }
      }

      await archiveMessageMedia(savedMsg._id.toString(), workspaceId, buffer, fileMime, fileName);

      opts.wsGateway.broadcastToConversationVisibility(workspaceId, conv.assignedAgentId?.toString(), 'message:new', {
        conversationId,
        message: {
          id: savedMsg._id.toString(),
          conversationId,
          type: savedMsg.type,
          content: savedMsg.content,
          direction: savedMsg.direction,
          status: savedMsg.status,
          timestamp: savedMsg.createdAt.toISOString(),
          quoted: savedMsg.quoted,
        },
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
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { conversationId, messageId } = request.params as { conversationId: string; messageId: string };

    // Message lookup alone doesn't scope by visibility — check the parent
    // conversation too, same as every other route here.
    const visible = await Conversation.exists(scopeConversationFilter({ _id: conversationId, workspaceId }, { role, sub }));
    if (!visible) return reply.status(404).send({ error: 'Conversa não encontrada' });

    const msg = await Message.findOne({ _id: messageId, workspaceId, conversationId }).lean();
    if (!msg) return reply.status(404).send({ error: 'Mensagem não encontrada' });
    if (msg.mediaStorage?.key) {
      try {
        const archived = await readMedia(msg.mediaStorage.key, msg.mediaStorage.provider);
        reply.header('Content-Type', msg.mediaStorage.mimeType || 'application/octet-stream');
        reply.header('Content-Length', String(archived.length));
        reply.header('Cache-Control', 'private, max-age=31536000, immutable');
        return reply.send(archived);
      } catch (err) {
        fastify.log.error({ err, messageId }, 'Failed to read archived media');
      }
    }
    if (!msg.rawPayload) return reply.status(404).send({ error: 'Mídia não disponível' });

    // Cloud API messages store their own (non-Baileys) content shape in
    // rawPayload — downloadMediaMessage() below only understands Baileys'
    // encrypted WAMessage format and would throw on anything else, so it gets
    // its own branch: a signed-URL round-trip via GET /{media-id}, not a decrypt.
    if (msg.instanceId) {
      const instance = await Instance.findById(msg.instanceId).select('channel cloudApi').lean();
      if (instance?.channel === 'cloud_api') {
        const mediaId = (msg.rawPayload as Record<string, unknown> | undefined)?.mediaId as string | undefined;
        if (!instance.cloudApi || !mediaId) return reply.status(404).send({ error: 'Mídia não disponível' });
        try {
          const accessToken = decryptSecret(instance.cloudApi.accessTokenEnc);
          const { buffer, mimeType } = await downloadCloudApiMedia(mediaId, {
            phoneNumberId: instance.cloudApi.phoneNumberId, accessToken, graphVersion: instance.cloudApi.graphVersion,
          });
          await archiveMessageMedia(messageId, workspaceId, buffer, mimeType, typeof msg.content?.fileName === 'string' ? msg.content.fileName : undefined);
          reply.header('Content-Type', mimeType);
          reply.header('Cache-Control', 'private, max-age=604800');
          return reply.send(buffer);
        } catch (err) {
          fastify.log.warn({ err, messageId }, 'Failed to download Cloud API media');
          return reply.status(410).send({ error: 'Mídia não disponível ou expirada' });
        }
      }
    }

    try {
      const { downloadMediaMessage } = await import('@webwhatsapp/engine');

      // Mongo stores Buffers as BSON Binary. Baileys' crypto needs raw Uint8Array/Buffer
      // (mediaKey, fileEncSha256, etc.) — pass a Binary and decryption silently fails.
      // Normalize the whole payload back to Buffers before downloading.
      const rawMessage = normalizeBinary(msg.rawPayload) as WAMessage;

      // Provide reuploadRequest so media whose CDN URL expired can be re-fetched.
      const session = msg.instanceId ? opts.sessionManager.getSession(msg.instanceId.toString()) : null;
      const reuploadRequest = session?.updateMediaMessage as WASocket['updateMediaMessage'] | undefined;

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

      await archiveMessageMedia(messageId, workspaceId, Buffer.from(buffer), mimeType, typeof msg.content?.fileName === 'string' ? msg.content.fileName : undefined);

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
  fastify.delete('/:conversationId/messages/:messageId', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { conversationId, messageId } = request.params as { conversationId: string; messageId: string };

    const conv = await Conversation.findOne(scopeConversationFilter({ _id: conversationId, workspaceId }, { role, sub }));
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

    const msg = await Message.findOne({ _id: messageId, conversationId });
    if (!msg) return reply.status(404).send({ error: 'Mensagem não encontrada' });

    const session = conv.instanceId ? opts.sessionManager.getSession(conv.instanceId.toString()) : undefined;
    if (session && msg.fromMe) {
      try {
        await session.sendRaw!(conv.jid, { delete: { id: msg.messageId, remoteJid: conv.jid, fromMe: true } } as never);
      } catch { /* ignore if WA delete fails */ }
    }

    await Message.updateOne({ _id: messageId }, { status: 'deleted' });
    return reply.send({ ok: true });
  });

  // POST /api/conversations/:conversationId/messages/:messageId/react — agent reacts to a
  // message. Sends the reaction to WhatsApp AND persists it directly (doesn't rely on
  // Baileys echoing our own outgoing reaction back through 'messages.reaction' — some
  // library versions suppress self-originated echoes). Uses the fixed sentinel jid 'agent'
  // so it renders distinctly from the customer's own reactions (which use their real jid).
  const AGENT_REACTION_JID = 'agent';
  fastify.post('/:conversationId/messages/:messageId/react', canWrite, async (request, reply) => {
    const { workspaceId, sub, role } = request.user as { workspaceId: string; sub: string; role: string };
    const { conversationId, messageId } = request.params as { conversationId: string; messageId: string };
    const { emoji } = request.body as { emoji: string }; // '' removes the agent's own reaction

    const conv = await Conversation.findOne(scopeConversationFilter({ _id: conversationId, workspaceId }, { role, sub }));
    if (!conv) return reply.status(404).send({ error: 'Conversa não encontrada' });

    const msg = await Message.findOne({ _id: messageId, conversationId });
    if (!msg) return reply.status(404).send({ error: 'Mensagem não encontrada' });

    if (!conv.instanceId) return reply.status(503).send({ error: 'Nenhuma instância WhatsApp configurada' });
    const session = await opts.sessionManager.ensureSession(conv.instanceId.toString());
    if (!(await session.waitUntilReady(8000))) {
      return reply.status(503).send({ error: 'WhatsApp reconectando. Tente novamente em alguns segundos.' });
    }

    try {
      // The neutral entrypoint works for both channels here — toBaileys/toCloudApi
      // both understand 'reaction', unlike delete-for-everyone (Baileys-only concept).
      await session.sendMessage(conv.jid, {
        kind: 'reaction', emoji: emoji ?? '', key: { id: msg.messageId, remoteJid: conv.jid, fromMe: msg.fromMe },
      });
    } catch (err) {
      fastify.log.error({ err, messageId }, 'Failed to send reaction');
      return reply.status(500).send({ error: 'Falha ao reagir à mensagem' });
    }

    msg.reactions = msg.reactions ?? [];
    if (emoji) {
      const existing = msg.reactions.find((r) => r.jid === AGENT_REACTION_JID);
      if (existing) { existing.emoji = emoji; existing.timestamp = new Date(); }
      else msg.reactions.push({ emoji, jid: AGENT_REACTION_JID, phone: AGENT_REACTION_JID, timestamp: new Date() });
    } else {
      msg.reactions = msg.reactions.filter((r) => r.jid !== AGENT_REACTION_JID);
    }
    await msg.save();

    opts.wsGateway.broadcastToWorkspace(workspaceId, 'message:reactions-update', {
      conversationId, messageId, reactions: msg.reactions,
    });
    return reply.send({ ok: true, reactions: msg.reactions });
  });
}
