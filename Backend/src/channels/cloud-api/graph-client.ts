// Minimal WhatsApp Cloud API (Meta Graph API) HTTP client. There's no shared
// HTTP client or retry utility anywhere in this codebase — the two existing
// outbound-fetch call sites (webhook-dispatcher.ts, runner.ts's
// automation.webhook block) are both one-shot `fetch` calls. This one needs
// retry (Meta's 429/5xx are common under load) and pt-BR error messages a
// non-technical operator can act on, so it's a small dedicated client rather
// than a third copy-pasted fetch.

const GRAPH_VERSION_DEFAULT = process.env.META_GRAPH_VERSION ?? 'v25.0';
const GRAPH_BASE = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

// A handful of the Meta error codes an operator will actually hit in practice.
// Anything not in this map falls back to Meta's own message — better than
// nothing, but these specific ones get a message that says what to DO about it.
const ERROR_MESSAGES: Record<number, string> = {
  131047: 'Fora da janela de 24h — só é possível enviar um template aprovado para este contato.',
  132000: 'Template não aprovado, não encontrado, ou os parâmetros não batem com o template cadastrado na Meta.',
  130429: 'Limite de envio da Meta excedido para este número — aguarde e tente novamente.',
  133010: 'Este número não está registrado na Cloud API da Meta.',
  190: 'Token de acesso inválido ou expirado — reconecte a instância com um novo token.',
  100: 'Requisição rejeitada pela Meta — confira o Phone Number ID e os parâmetros enviados.',
};

export class GraphApiError extends Error {
  constructor(public readonly code: number, public readonly rawMessage: string) {
    super(ERROR_MESSAGES[code] ?? rawMessage);
    this.name = 'GraphApiError';
  }
}

export interface GraphCredentials {
  phoneNumberId: string;
  accessToken: string;
  graphVersion?: string;
}

export async function exchangeEmbeddedSignupCode(code: string): Promise<string> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) throw new GraphApiError(0, 'Embedded Signup ainda não foi configurado no servidor.');
  const version = process.env.META_GRAPH_VERSION ?? 'v25.0';
  const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
  const res = await fetch(`${GRAPH_BASE}/${version}/oauth/access_token?${params}`, {
    method: 'GET', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: { code?: number; message?: string } };
  if (!res.ok || !data.access_token) {
    throw new GraphApiError(data.error?.code ?? res.status, data.error?.message ?? 'A Meta não retornou um token de acesso.');
  }
  return data.access_token;
}

export async function debugAccessToken(accessToken: string): Promise<{ expiresAt?: Date; scopes: string[] }> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) throw new GraphApiError(0, 'Credenciais do Meta App não configuradas.');
  const version = process.env.META_GRAPH_VERSION ?? 'v25.0';
  const params = new URLSearchParams({ input_token: accessToken });
  const res = await fetch(`${GRAPH_BASE}/${version}/debug_token?${params}`, {
    headers: { Authorization: `Bearer ${appId}|${appSecret}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { is_valid?: boolean; expires_at?: number; scopes?: string[] }; error?: { code?: number; message?: string } };
  if (!res.ok || !body.data?.is_valid) throw new GraphApiError(body.error?.code ?? res.status, body.error?.message ?? 'Token da Meta inválido.');
  return {
    expiresAt: body.data.expires_at ? new Date(body.data.expires_at * 1000) : undefined,
    scopes: body.data.scopes ?? [],
  };
}

async function graphRequest(path: string, creds: GraphCredentials, init?: RequestInit, attempt = 1): Promise<Record<string, unknown>> {
  const version = creds.graphVersion || GRAPH_VERSION_DEFAULT;
  const url = `${GRAPH_BASE}/${version}/${path}`;
  let res: Response;
  const method = (init?.method ?? 'GET').toUpperCase();
  const mayRetry = method === 'GET' || method === 'HEAD';
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (mayRetry && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt * 1000));
      return graphRequest(path, creds, init, attempt + 1);
    }
    throw new GraphApiError(0, `Falha de rede ao contatar a Meta: ${(err as Error).message}`);
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = body.error as Record<string, unknown> | undefined;
    const code = typeof error?.code === 'number' ? error.code : res.status;
    // Retry only on rate-limit/server errors — a 4xx like "bad token" or "bad
    // template" will never succeed by retrying it verbatim.
    if (mayRetry && (res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt * 1000));
      return graphRequest(path, creds, init, attempt + 1);
    }
    throw new GraphApiError(code, String(error?.message ?? `Erro ${res.status} da Meta`));
  }
  return body;
}

/** GET the phone number's own metadata — the cheapest possible call to prove
 *  a Phone Number ID + access token pair is actually valid and linked. */
export async function validatePhoneNumber(creds: GraphCredentials): Promise<{ displayPhoneNumber?: string; verifiedName?: string; qualityRating?: string }> {
  const data = await graphRequest(`${creds.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, creds, { method: 'GET' });
  return {
    displayPhoneNumber: typeof data.display_phone_number === 'string' ? data.display_phone_number : undefined,
    verifiedName: typeof data.verified_name === 'string' ? data.verified_name : undefined,
    qualityRating: typeof data.quality_rating === 'string' ? data.quality_rating : undefined,
  };
}

export interface RemoteTemplate {
  name: string;
  language: string;
  category: string;
  status: string;
  components: unknown;
}

/** Lists every message template registered on the WABA (approved, pending, and
 *  rejected) — used to populate the local WhatsAppTemplate cache. */
export async function listTemplates(wabaId: string, accessToken: string, graphVersion?: string): Promise<RemoteTemplate[]> {
  const out: RemoteTemplate[] = [];
  let path: string | null = `${wabaId}/message_templates?fields=name,language,category,status,components&limit=100`;
  // Meta paginates via an absolute `next` URL — cap at 10 pages (1000 templates)
  // as a sane upper bound against an unexpected infinite-pagination response.
  for (let page = 0; page < 10 && path; page++) {
    const data = await graphRequest(path, { phoneNumberId: wabaId, accessToken, graphVersion });
    const items = (data.data as RemoteTemplate[] | undefined) ?? [];
    out.push(...items);
    const next = (data.paging as { next?: string } | undefined)?.next;
    path = next ? next.replace(`${GRAPH_BASE}/${graphVersion || GRAPH_VERSION_DEFAULT}/`, '') : null;
  }
  return out;
}

export async function createTemplate(
  wabaId: string,
  accessToken: string,
  template: { name: string; language: string; category: string; components: unknown[] },
  graphVersion?: string
): Promise<{ id?: string; status?: string; category?: string }> {
  const data = await graphRequest(`${wabaId}/message_templates`, { phoneNumberId: wabaId, accessToken, graphVersion }, {
    method: 'POST', body: JSON.stringify(template),
  });
  return { id: typeof data.id === 'string' ? data.id : undefined, status: typeof data.status === 'string' ? data.status : undefined, category: typeof data.category === 'string' ? data.category : undefined };
}

export async function deleteTemplate(wabaId: string, accessToken: string, name: string, graphVersion?: string): Promise<void> {
  await graphRequest(`${wabaId}/message_templates?name=${encodeURIComponent(name)}`, { phoneNumberId: wabaId, accessToken, graphVersion }, { method: 'DELETE' });
}

/** POST a message body (see to-cloud-api.ts) to `/{phoneNumberId}/messages`. */
export async function sendCloudApiMessage(creds: GraphCredentials, to: string, body: Record<string, unknown>): Promise<{ id?: string }> {
  const data = await graphRequest(`${creds.phoneNumberId}/messages`, creds, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...body }),
  });
  const messages = data.messages as Array<{ id?: string }> | undefined;
  return { id: messages?.[0]?.id };
}

/** Mirrors the agent opening an inbound message in our inbox back to WhatsApp. */
export async function markCloudApiMessageRead(creds: GraphCredentials, messageId: string): Promise<void> {
  await graphRequest(`${creds.phoneNumberId}/messages`, creds, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  });
}

/** Required once per WABA before Meta sends its phone-number webhook events. */
export async function subscribeAppToWaba(wabaId: string, accessToken: string, graphVersion?: string): Promise<void> {
  await graphRequest(`${wabaId}/subscribed_apps`, { phoneNumberId: wabaId, accessToken, graphVersion }, { method: 'POST' });
}

export async function registerPhoneNumber(creds: GraphCredentials, pin: string): Promise<void> {
  if (!/^\d{6}$/.test(pin)) throw new GraphApiError(100, 'O PIN de verificação em duas etapas deve ter 6 dígitos.');
  await graphRequest(`${creds.phoneNumberId}/register`, creds, {
    method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  });
}

/** Ensures a pasted Phone Number ID really belongs to the pasted WABA. */
export async function validateWabaPhoneNumber(wabaId: string, phoneNumberId: string, accessToken: string, graphVersion?: string): Promise<void> {
  const data = await graphRequest(`${wabaId}/phone_numbers?fields=id&limit=100`, { phoneNumberId, accessToken, graphVersion });
  const phones = (data.data as Array<{ id?: string }> | undefined) ?? [];
  if (!phones.some((phone) => phone.id === phoneNumberId)) {
    throw new GraphApiError(100, 'O Phone Number ID não pertence à WABA informada.');
  }
}

export interface PricingAnalyticsDataPoint {
  start?: number;
  end?: number;
  country?: string;
  tier?: string;
  pricingType?: string;
  pricingCategory?: string;
  volume?: number;
  /** In the WABA's own billing currency. `undefined` when Meta doesn't return
   *  cost for this WABA (e.g. it's under a BSP's shared credit line) — the
   *  caller must treat that as "unavailable", not zero. */
  cost?: number;
}

/**
 * Reconciliation view against Meta's own reported spend — not a per-campaign
 * or per-message figure (Meta only aggregates this by day/half-hour and
 * dimension), and `cost` is explicitly documented by Meta as approximate, not
 * a closed invoice. Requires the `whatsapp_business_management` permission on
 * the token. See GraphApiError for the shape of a permission failure.
 */
export async function getPricingAnalytics(
  wabaId: string,
  accessToken: string,
  range: { start: Date; end: Date; granularity?: 'HALF_HOUR' | 'DAILY' | 'MONTHLY' },
  graphVersion?: string
): Promise<PricingAnalyticsDataPoint[]> {
  const startUnix = Math.floor(range.start.getTime() / 1000);
  const endUnix = Math.floor(range.end.getTime() / 1000);
  const granularity = range.granularity ?? 'DAILY';
  const fields = `pricing_analytics.start(${startUnix}).end(${endUnix}).granularity(${granularity}).metric_types([COST,VOLUME]).dimensions([COUNTRY,PRICING_CATEGORY,PRICING_TYPE,TIER])`;
  const data = await graphRequest(`${wabaId}?fields=${encodeURIComponent(fields)}`, { phoneNumberId: wabaId, accessToken, graphVersion });
  const points = ((data.pricing_analytics as { data?: Array<Record<string, unknown>> } | undefined)?.data) ?? [];
  return points.map((p) => ({
    start: typeof p.start === 'number' ? p.start : undefined,
    end: typeof p.end === 'number' ? p.end : undefined,
    country: typeof p.country === 'string' ? p.country : undefined,
    tier: typeof p.tier === 'string' ? p.tier : undefined,
    pricingType: typeof p.pricing_type === 'string' ? p.pricing_type : undefined,
    pricingCategory: typeof p.pricing_category === 'string' ? p.pricing_category : undefined,
    volume: typeof p.volume === 'number' ? p.volume : undefined,
    cost: typeof p.cost === 'number' ? p.cost : undefined,
  }));
}

/**
 * Downloads a media asset by its Meta-assigned media ID — a two-hop fetch:
 * GET /{media-id} returns metadata + a signed CDN URL valid for ~5 minutes,
 * then that URL itself must be fetched with the same Bearer token (it's not
 * a public URL despite looking like one).
 */
export async function downloadCloudApiMedia(mediaId: string, creds: GraphCredentials): Promise<{ buffer: Buffer; mimeType: string }> {
  const meta = await graphRequest(mediaId, creds, { method: 'GET' });
  const url = typeof meta.url === 'string' ? meta.url : undefined;
  if (!url) throw new GraphApiError(0, 'A Meta não retornou uma URL de mídia válida');

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new GraphApiError(res.status, `Falha ao baixar mídia da Meta (${res.status})`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = typeof meta.mime_type === 'string' ? meta.mime_type : res.headers.get('content-type') ?? 'application/octet-stream';
  return { buffer, mimeType };
}

/** Uploads raw bytes (e.g. a file attached in the composer) to Meta, returning
 *  a media ID good for one outbound message (`{ image: { id } }` etc. — see
 *  sendCloudApiMessage's caller). Required for buffer-based sends: Cloud API's
 *  `link` field only works for a URL Meta's servers can reach on their own. */
export async function uploadCloudApiMedia(buffer: Buffer, mimeType: string, filename: string, creds: GraphCredentials): Promise<string> {
  const version = creds.graphVersion || GRAPH_VERSION_DEFAULT;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  let res: Response;
  try {
    res = await fetch(`${GRAPH_BASE}/${version}/${creds.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(30_000), // uploads can legitimately take longer than a JSON call
    });
  } catch (err) {
    throw new GraphApiError(0, `Falha de rede ao enviar mídia para a Meta: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = body.error as Record<string, unknown> | undefined;
    throw new GraphApiError(typeof error?.code === 'number' ? error.code : res.status, String(error?.message ?? `Erro ${res.status} da Meta ao enviar mídia`));
  }
  const id = body.id;
  if (typeof id !== 'string') throw new GraphApiError(0, 'A Meta não retornou um ID de mídia válido');
  return id;
}

export { graphRequest };
