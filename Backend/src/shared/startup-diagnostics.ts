import type { FastifyBaseLogger } from 'fastify';
import { testMediaStorageConnection } from './media-storage';

export type IntegrationStatus = 'connected' | 'warning' | 'disabled' | 'error';

export interface IntegrationDiagnostic {
  integration: 'storage' | 'meta';
  label: string;
  status: IntegrationStatus;
  message: string;
  latencyMs?: number;
  missing?: string[];
  details?: Record<string, string | number | boolean>;
}

const META_GRAPH_BASE = 'https://graph.facebook.com';
const CHECK_TIMEOUT_MS = 10_000;

function configured(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function storageMissingVariables(): string[] {
  const missing: string[] = [];
  if (!configured('MEDIA_S3_BUCKET')) missing.push('MEDIA_S3_BUCKET');
  if (!configured('MEDIA_S3_ACCESS_KEY_ID')) missing.push('MEDIA_S3_ACCESS_KEY_ID');
  if (!configured('MEDIA_S3_SECRET_ACCESS_KEY')) missing.push('MEDIA_S3_SECRET_ACCESS_KEY');
  if (!configured('MEDIA_R2_ACCOUNT_ID') && !configured('MEDIA_S3_ENDPOINT')) {
    missing.push('MEDIA_R2_ACCOUNT_ID ou MEDIA_S3_ENDPOINT');
  }
  return missing;
}

export async function checkStorageIntegration(
  testConnection = testMediaStorageConnection,
): Promise<IntegrationDiagnostic> {
  const driver = process.env.MEDIA_STORAGE_DRIVER === 's3' ? 's3' : 'local';
  const missing = storageMissingVariables();

  if (driver !== 's3') {
    return {
      integration: 'storage',
      label: 'Cloudflare R2 / S3',
      status: 'disabled',
      message: 'desativado; armazenamento local está ativo',
      ...(missing.length ? { missing } : {}),
      details: { driver },
    };
  }

  if (missing.length) {
    return {
      integration: 'storage',
      label: 'Cloudflare R2 / S3',
      status: 'error',
      message: 'configuração incompleta',
      missing,
      details: { driver },
    };
  }

  const result = await testConnection();
  if (!result.reachable) {
    return {
      integration: 'storage',
      label: result.service === 'cloudflare-r2' ? 'Cloudflare R2' : 'S3',
      status: 'error',
      message: storageErrorMessage(result.errorCode),
      latencyMs: result.latencyMs,
      details: {
        driver,
        service: result.service,
        bucket: result.bucket ?? 'não informado',
        errorCode: result.errorCode ?? 'unavailable',
      },
    };
  }

  return {
    integration: 'storage',
    label: result.service === 'cloudflare-r2' ? 'Cloudflare R2' : 'S3',
    status: 'connected',
    message: 'upload, leitura e remoção validados',
    latencyMs: result.latencyMs,
    details: {
      driver,
      service: result.service,
      bucket: result.bucket ?? 'não informado',
    },
  };
}

function storageErrorMessage(code?: string): string {
  switch (code) {
    case 'access_denied': return 'acesso negado; verifique as credenciais e permissões do bucket';
    case 'bucket_not_found': return 'bucket não encontrado';
    case 'timeout': return 'tempo esgotado ao acessar o storage';
    case 'not_configured': return 'configuração incompleta';
    default: return 'não foi possível acessar o storage';
  }
}

interface MetaAppResponse {
  id?: string;
  name?: string;
  error?: { code?: number; message?: string; type?: string };
}

export async function checkMetaIntegration(
  fetchImpl: typeof fetch = fetch,
): Promise<IntegrationDiagnostic> {
  const required = ['META_APP_ID', 'META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN'];
  const missing = required.filter((name) => !configured(name));
  const embeddedSignupConfigured = configured('META_EMBEDDED_SIGNUP_CONFIG_ID');
  const version = process.env.META_GRAPH_VERSION?.trim() || 'v25.0';

  if (missing.length) {
    return {
      integration: 'meta',
      label: 'Meta WhatsApp Cloud API',
      status: 'warning',
      message: 'configuração incompleta; canal Baileys continua disponível',
      missing,
      details: { graphVersion: version, embeddedSignupConfigured },
    };
  }

  const appId = process.env.META_APP_ID!.trim();
  const appSecret = process.env.META_APP_SECRET!.trim();
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(
      `${META_GRAPH_BASE}/${version}/${encodeURIComponent(appId)}?fields=id,name`,
      {
        headers: { Authorization: `Bearer ${appId}|${appSecret}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      },
    );
    const body = (await response.json().catch(() => ({}))) as MetaAppResponse;
    const latencyMs = Date.now() - startedAt;

    if (!response.ok || !body.id) {
      return {
        integration: 'meta',
        label: 'Meta WhatsApp Cloud API',
        status: 'error',
        message: metaErrorMessage(response.status, body.error?.code),
        latencyMs,
        details: { graphVersion: version, httpStatus: response.status, errorCode: body.error?.code ?? response.status },
      };
    }

    return {
      integration: 'meta',
      label: 'Meta WhatsApp Cloud API',
      status: embeddedSignupConfigured ? 'connected' : 'warning',
      message: embeddedSignupConfigured
        ? 'aplicativo validado e Embedded Signup configurado'
        : 'aplicativo validado; Embedded Signup ainda não configurado',
      latencyMs,
      ...(!embeddedSignupConfigured ? { missing: ['META_EMBEDDED_SIGNUP_CONFIG_ID'] } : {}),
      details: { graphVersion: version, appName: body.name ?? 'sem nome', embeddedSignupConfigured },
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      integration: 'meta',
      label: 'Meta WhatsApp Cloud API',
      status: 'error',
      message: timedOut ? 'tempo esgotado ao contatar a Meta' : 'falha de rede ao contatar a Meta',
      latencyMs: Date.now() - startedAt,
      details: { graphVersion: version, networkError: true },
    };
  }
}

function metaErrorMessage(httpStatus: number, errorCode?: number): string {
  if (httpStatus === 401 || httpStatus === 403 || errorCode === 190) {
    return 'credenciais do aplicativo inválidas ou sem permissão';
  }
  if (httpStatus === 429) return 'limite de requisições da Meta atingido';
  if (httpStatus >= 500) return 'serviço da Meta indisponível';
  return 'aplicativo rejeitado pela Meta; verifique App ID, App Secret e versão da Graph API';
}

const statusView: Record<IntegrationStatus, { level: 'info' | 'warn' | 'error'; icon: string }> = {
  connected: { level: 'info', icon: '[OK]' },
  warning: { level: 'warn', icon: '[ATENÇÃO]' },
  disabled: { level: 'warn', icon: '[DESATIVADO]' },
  error: { level: 'error', icon: '[FALHA]' },
};

/** Windows consoles still commonly run with a legacy code page even when Node
 * writes UTF-8. Keep Linux/production output intact, but gracefully downgrade
 * only terminal-facing messages to ASCII on Windows so logs never become mojibake. */
function consoleSafe(message: string): string {
  if (process.platform !== 'win32') return message;
  return message
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[╭╰]/g, '+')
    .replace(/│/g, '|')
    .replace(/─/g, '-');
}

export async function runStartupDiagnostics(logger: FastifyBaseLogger): Promise<IntegrationDiagnostic[]> {
  logger.info(consoleSafe('╭─ Diagnóstico de integrações ─────────────────────────────────────'));
  const results = await Promise.all([checkStorageIntegration(), checkMetaIntegration()]);

  for (const result of results) {
    const view = statusView[result.status];
    const suffix = result.latencyMs === undefined ? '' : ` (${result.latencyMs} ms)`;
    logger[view.level](
      {
        event: 'startup.integration',
        integration: result.integration,
        status: result.status,
        latencyMs: result.latencyMs,
        missing: result.missing,
        ...result.details,
      },
      consoleSafe(`│ ${view.icon} ${result.label}: ${result.message}${suffix}`),
    );
    if (result.missing?.length) {
      logger.warn(
        { event: 'startup.integration.missing', integration: result.integration, missing: result.missing },
        consoleSafe(`│    Variáveis pendentes: ${result.missing.join(', ')}`),
      );
    }
  }

  const connected = results.filter((result) => result.status === 'connected').length;
  const failed = results.filter((result) => result.status === 'error').length;
  logger.info(
    { event: 'startup.integrations.complete', connected, failed, total: results.length },
    consoleSafe(`╰─ Resultado: ${connected} conectado(s), ${failed} falha(s), ${results.length - connected - failed} aviso(s)`),
  );
  return results;
}
