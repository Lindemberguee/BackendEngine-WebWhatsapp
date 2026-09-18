import { Agent, fetch } from 'undici';
import { resolvePublicHostname } from './url-security';

const dispatcher = new Agent({
  connect: {
    lookup(hostname, _options, callback) {
      void resolvePublicHostname(hostname)
        .then(({ address, family }) => callback(null, address, family))
        .catch((error: Error) => callback(error, '', 0));
    },
  },
});

/** Performs DNS resolution inside the connection path, eliminating the validation-to-connect
 * gap that allows DNS rebinding to redirect an otherwise valid public URL to an internal host. */
export function fetchPublicUrl(url: string, init?: Parameters<typeof fetch>[1]) {
  return fetch(url, { ...init, dispatcher });
}
