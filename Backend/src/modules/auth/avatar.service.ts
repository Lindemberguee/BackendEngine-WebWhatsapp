import { Avatar } from '../../db/models';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2MB decoded — generous for a resized profile picture
const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/;

export class AvatarError extends Error {}

/** Parses a `data:<mime>;base64,<...>` string into its raw bytes, rejecting anything oversized or malformed. */
export function parseAvatarDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) throw new AvatarError('Formato de imagem inválido');
  const [, mimeType, base64] = match;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_AVATAR_BYTES) throw new AvatarError('Imagem muito grande');
  return { buffer, mimeType };
}

/** Upserts the user's avatar into its own small collection — never inline on the User doc,
 *  so it doesn't bloat the JWT-adjacent auth flow (localStorage, React Query cache, etc). */
export async function saveAvatar(userId: string, workspaceId: string, dataUrl: string): Promise<void> {
  const { buffer, mimeType } = parseAvatarDataUrl(dataUrl);
  await Avatar.findOneAndUpdate(
    { userId },
    { $set: { workspaceId, data: buffer, mimeType } },
    { upsert: true }
  );
}

/** Public, cache-busted URL for a user's avatar — same exposure level as a WhatsApp contact
 *  photo (already rendered directly as <img src> everywhere), so no auth is required to fetch it.
 *  The route itself has a dedicated tight rate limit (see auth.routes.ts) so guessing/enumerating
 *  ObjectIds at scale isn't practical, without requiring every already-issued avatarUrl (persisted
 *  in Mongo and in signed-in browsers' localStorage) to be migrated to a new signed format. */
export function avatarUrlFor(userId: string): string {
  const base = process.env.PUBLIC_API_URL ?? 'http://localhost:3333';
  return `${base}/api/auth/avatar/${userId}?v=${Date.now()}`;
}
