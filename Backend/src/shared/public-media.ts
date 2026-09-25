import type { AnyMessageContent } from '@webwhatsapp/engine';
import { fetchPublicUrl } from './public-fetch';
const MAX_BYTES = 25 * 1024 * 1024;
export async function downloadPublicMedia(url: string): Promise<Buffer> {
  const response = await fetchPublicUrl(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Mídia indisponível'); }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body.cancel(); throw new Error('Mídia excede 25 MB'); }
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw new Error('Mídia excede 25 MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
/** Resolve media before it reaches the provider HTTP client, including carousel headers. */
export async function preparePublicMedia<T extends AnyMessageContent>(content: T): Promise<T> {
  let remaining = MAX_BYTES;
  async function prepare(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = { ...value };
    for (const field of ['image', 'video', 'audio', 'document', 'sticker']) {
      const media = result[field];
      if (typeof media === 'string') throw new Error('Caminho de mídia não permitido');
      if (media && typeof media === 'object' && 'url' in media) {
        const raw = (media as { url: unknown }).url;
        if (typeof raw !== 'string' && !(raw instanceof URL)) throw new Error('URL de mídia inválida');
        const bytes = await downloadPublicMedia(String(raw)); remaining -= bytes.length;
        if (remaining < 0) throw new Error('Mídias excedem 25 MB');
        result[field] = bytes;
      }
    }
    if (Array.isArray(result.cards)) {
      if (result.cards.length > 10) throw new Error('Limite de 10 cartões');
      result.cards = [];
      for (const card of value.cards as Array<Record<string, unknown>>) (result.cards as unknown[]).push(await prepare(card));
    }
    return result;
  }
  return await prepare(content as unknown as Record<string, unknown>) as unknown as T;
}
