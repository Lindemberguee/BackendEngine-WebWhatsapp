import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { FlowAsset } from '../../db/models';
import { storeMedia, readMedia } from '../../shared/media-storage';

// Files the flow builder can upload (boleto PDF, QR image, block media). Kept
// deliberately narrow — these become publicly fetchable URLs.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

interface MultipartPart {
  type: 'file' | 'field';
  fieldname: string;
  filename?: string;
  mimetype?: string;
  toBuffer(): Promise<Buffer>;
}
type MultipartRequest = FastifyRequest & { parts(): AsyncIterableIterator<MultipartPart> };

export async function flowAssetsRoutes(fastify: FastifyInstance): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };

  // POST /api/flow-assets — multipart/form-data with a single `file`. Returns the
  // absolute public URL to reference from a flow block.
  fastify.post('/', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { workspaceId, sub: userId } = request.user as { workspaceId: string; sub: string };

    let buffer: Buffer | undefined;
    let fileName = 'arquivo';
    let mimeType = 'application/octet-stream';
    for await (const part of (request as MultipartRequest).parts()) {
      if (part.type === 'file') {
        buffer = await part.toBuffer();
        fileName = part.filename || fileName;
        mimeType = part.mimetype || mimeType;
      }
    }

    if (!buffer || buffer.length === 0) return reply.status(400).send({ error: 'Arquivo ausente' });
    if (buffer.length > MAX_BYTES) return reply.status(413).send({ error: 'Arquivo acima de 8 MB' });
    if (!ALLOWED_MIME.has(mimeType)) return reply.status(415).send({ error: 'Tipo não suportado (use PDF, PNG, JPG ou WebP)' });

    const stored = await storeMedia({ workspaceId, buffer, mimeType, fileName });
    const asset = await FlowAsset.create({
      workspaceId, uploadedBy: userId,
      key: stored.key, provider: stored.provider,
      mimeType, fileName: fileName.slice(0, 200), size: buffer.length, sha256: stored.sha256,
    });

    const base = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
    return reply.status(201).send({
      data: { ...asset.toJSON(), url: `${base}/api/flow-assets/${asset._id.toString()}` },
    });
  });

  // GET /api/flow-assets/:id — unauthenticated: WhatsApp / Baileys fetch this URL
  // directly. The 24-hex id is the capability token; no directory listing exists.
  fastify.get('/:id', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!Types.ObjectId.isValid(id)) return reply.status(404).send({ error: 'Não encontrado' });

    const asset = await FlowAsset.findById(id).select('key provider mimeType fileName').lean();
    if (!asset) return reply.status(404).send({ error: 'Não encontrado' });

    let bytes: Buffer;
    try {
      bytes = await readMedia(asset.key, asset.provider);
    } catch {
      return reply.status(404).send({ error: 'Arquivo indisponível' });
    }

    return reply
      .header('Content-Type', asset.mimeType)
      .header('Content-Disposition', `inline; filename="${asset.fileName.replace(/["\r\n]/g, '')}"`)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(bytes);
  });
}
