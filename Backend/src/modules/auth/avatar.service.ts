import { randomBytes } from 'crypto';
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
 *  so it doesn't bloat the JWT-adjacent auth flow (localStorage, React Query cache, etc).
 *  Returns the fresh access token so the caller can build the new-style URL — a fresh
 *  upload always mints a fresh token, so re-uploading incidentally invalidates any
 *  previously-leaked link too. */
export async function saveAvatar(userId: string, workspaceId: string, dataUrl: string): Promise<string> {
  const { buffer, mimeType } = parseAvatarDataUrl(dataUrl);
  const accessToken = randomBytes(32).toString('hex');
  await Avatar.findOneAndUpdate(
    { userId },
    { $set: { workspaceId, data: buffer, mimeType, accessToken } },
    { upsert: true }
  );
  return accessToken;
}

/** Public, cache-busted URL for a user's avatar — same exposure level as a WhatsApp contact
 *  photo (already rendered directly as <img src> everywhere), so no auth is required to fetch it.
 *  `accessToken` is the real capability token for avatars saved after this field was added;
 *  pass it whenever you have one (i.e. right after saveAvatar()) — omit it only when just
 *  reflecting back an already-stored avatarUrl that might predate the field. The route itself
 *  also has a dedicated tight rate limit (see auth.routes.ts) as a second layer either way. */
export function avatarUrlFor(userId: string, accessToken?: string): string {
  const base = process.env.PUBLIC_API_URL ?? 'http://localhost:3333';
  const path = accessToken ? `${userId}/${accessToken}` : userId;
  return `${base}/api/auth/avatar/${path}?v=${Date.now()}`;
}
