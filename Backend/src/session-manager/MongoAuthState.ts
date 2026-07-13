/**
 * MongoDB-backed auth state for Baileys.
 * Stores credentials and Signal keys directly in the Instance document.
 */
import type { AuthenticationCreds, SignalDataTypeMap, SignalKeyStore } from '@webwhatsapp/engine';
import { initAuthCreds, BufferJSON } from '@webwhatsapp/engine';
import { Instance } from '../db/models';

type KeyType = keyof SignalDataTypeMap;

export async function useMongoAuthState(instanceId: string): Promise<{
  state: { creds: AuthenticationCreds; keys: SignalKeyStore };
  saveCreds: () => Promise<void>;
}> {
  let instance = await Instance.findById(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  // Initialize creds if empty
  const creds: AuthenticationCreds = instance.authCreds
    ? JSON.parse(JSON.stringify(instance.authCreds), BufferJSON.reviver)
    : initAuthCreds();

  const keys: SignalKeyStore = {
    async get<T extends KeyType>(type: T, ids: string[]) {
      const fresh = await Instance.findById(instanceId).select('authKeys').lean();
      const bucket = (fresh?.authKeys?.[type] ?? {}) as Record<string, unknown>;

      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        const raw = bucket[id];
        if (raw !== undefined && raw !== null) {
          result[id] = JSON.parse(JSON.stringify(raw), BufferJSON.reviver) as SignalDataTypeMap[T];
        }
      }
      return result;
    },

    async set(data) {
      const setOps: Record<string, unknown> = {};
      const unsetOps: Record<string, unknown> = {};

      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
          const path = `authKeys.${type}.${id}`;
          if (value === null || value === undefined) {
            unsetOps[path] = '';
          } else {
            setOps[path] = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
          }
        }
      }

      const update: Record<string, unknown> = {};
      if (Object.keys(setOps).length) update['$set'] = setOps;
      if (Object.keys(unsetOps).length) update['$unset'] = unsetOps;

      if (Object.keys(update).length) {
        await Instance.updateOne({ _id: instanceId }, update);
      }
    },
  };

  const saveCreds = async () => {
    await Instance.updateOne(
      { _id: instanceId },
      { $set: { authCreds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)) } }
    );
  };

  return { state: { creds, keys }, saveCreds };
}
