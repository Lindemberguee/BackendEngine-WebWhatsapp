import { Agent, fetch } from 'undici';
import { resolvePublicHostname, isPublicHttpUrl } from './url-security';

const dispatcher = new Agent({
  connect: {
    lookup(hostname, _options, callback) {
      void resolvePublicHostname(hostname)
        .then(({ address, family }) => {
          if (_options.all) {
            const allCallback = callback as unknown as (error: Error | null, addresses: Array<{ address: string; family: number }>) => void;
            allCallback(null, [{ address, family }]);
          } else callback(null, address, family);
        })
        .catch((error: Error) => callback(error, '', 0));
    },
  },
});

/** Performs DNS resolution inside the connection path, eliminating the validation-to-connect
 * gap that allows DNS rebinding to redirect an otherwise valid public URL to an internal host. */
export function fetchPublicUrl(url: string, init?: Parameters<typeof fetch>[1]) {
  if (!isPublicHttpUrl(url)) throw new Error('URL de rede interna não permitida');
  return fetch(url, { ...init, dispatcher, redirect: 'manual' });
}
