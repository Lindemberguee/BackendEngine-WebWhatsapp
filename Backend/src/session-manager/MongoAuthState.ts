/**
 * MongoDB-backed auth state for Baileys.
 * Stores credentials and Signal keys directly in the Instance document.
 */
import type { AuthenticationCreds, SignalDataTypeMap, SignalKeyStore } from '@webwhatsapp/engine';
import { initAuthCreds, BufferJSON } from '@webwhatsapp/engine';
import { Instance } from '../db/models';
import { encryptSecret, decryptSecret } from '../shared/crypto';

// Baileys creds/keys are the Signal Protocol session material for the linked
// WhatsApp number — equivalent to a full session takeover if read off the
// database directly, so they're encrypted at rest the same way Cloud API
// tokens are (AES-256-GCM, see shared/crypto.ts). New values are always
// written encrypted (`v1:...` ciphertext string); a value that ISN'T in that
// format is treated as pre-encryption legacy plaintext and read as-is, so
// already-linked sessions keep working and get encrypted on their next
// natural write instead of needing a forced migration or QR re-scan.
function isCiphertext(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('v1:');
}

function decodeStored<T>(raw: unknown): T {
  const json = isCiphertext(raw) ? decryptSecret(raw) : JSON.stringify(raw);
  return JSON.parse(json, BufferJSON.reviver) as T;
}

function encodeForStorage(value: unknown): string {
  return encryptSecret(JSON.stringify(value, BufferJSON.replacer));
}

type KeyType = keyof SignalDataTypeMap;

// Signal key ids routinely contain dots — session ids are `${phone}.${deviceId}`
// (e.g. "554899999999.0"), and sender-key ids embed a JID like "...@g.us". Using
// them raw in a dot-path (`authKeys.${type}.${id}`) makes MongoDB interpret each
// dot as a nested-object path segment instead of a literal key, so
// `authKeys.session.554899999999.0` silently becomes the nested structure
// `authKeys.session["554899999999"]["0"]` on write — while the read side looks up
// the literal string key `"554899999999.0"` on a flat object, which never matches.
// Net effect: Signal sessions and sender-keys were never actually persisted across
// a process restart (decrypt failures / lost group sessions after every deploy).
// Encoding dots out of the id before building the path keeps it a single flat key.
const ID_DOT = '．'; // fullwidth full stop — safe stand-in, won't collide with real ids
function encodeKeyId(id: string): string {
  return id.replace(/\./g, ID_DOT);
}

export async function useMongoAuthState(instanceId: string, isActive: () => boolean = () => true): Promise<{
  state: { creds: AuthenticationCreds; keys: SignalKeyStore };
  saveCreds: () => Promise<void>;
  flushWrites: () => Promise<void>;
}> {
  let pendingWrite: Promise<void> = Promise.resolve();
  const enqueue = (write: () => Promise<unknown>): Promise<void> => {
    const current = pendingWrite.catch(() => {}).then(async () => { if (isActive()) await write(); });
    pendingWrite = current;
    return current;
  };
  // Only authCreds is needed here (keys are read lazily per-id in keys.get below) —
  // selecting it explicitly avoids pulling the entire (potentially large) authKeys
  // blob into memory just to read one field.
  const instance = await Instance.findById(instanceId).select('authCreds').lean();
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  // Initialize creds if empty
  const creds: AuthenticationCreds = instance.authCreds
    ? decodeStored<AuthenticationCreds>(instance.authCreds)
    : initAuthCreds();

  const keys: SignalKeyStore = {
    async get<T extends KeyType>(type: T, ids: string[]) {
      const fresh = await Instance.findById(instanceId).select('authKeys').lean();
      const bucket = (fresh?.authKeys?.[type] ?? {}) as Record<string, unknown>;

      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        const raw = bucket[encodeKeyId(id)];
        if (raw !== undefined && raw !== null) {
          result[id] = decodeStored<SignalDataTypeMap[T]>(raw);
        }
      }
      return result;
    },

    async set(data) {
      const setOps: Record<string, unknown> = {};
      const unsetOps: Record<string, unknown> = {};

      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
          const path = `authKeys.${type}.${encodeKeyId(id)}`;
          if (value === null || value === undefined) {
            unsetOps[path] = '';
          } else {
            setOps[path] = encodeForStorage(value);
          }
        }
      }

      const update: Record<string, unknown> = {};
      if (Object.keys(setOps).length) update['$set'] = setOps;
      if (Object.keys(unsetOps).length) update['$unset'] = unsetOps;

      if (Object.keys(update).length) {
        await enqueue(() => Instance.updateOne({ _id: instanceId }, update).exec());
      }
    },
  };

  const saveCreds = async () => {
    await enqueue(() => Instance.updateOne(
      { _id: instanceId },
      { $set: { authCreds: encodeForStorage(creds) } }
    ).exec());
  };

  return { state: { creds, keys }, saveCreds, flushWrites: () => pendingWrite.catch(() => {}) };
}
