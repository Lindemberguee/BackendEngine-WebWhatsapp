/**
 * Server-side mirror of the frontend's allowlist in
 * `src/features/appearance/theme-schema.ts` (separate repo, can't share an
 * import — keep the key lists in sync by hand). This is the actual security
 * boundary: values here end up written straight into a `<style>` tag on the
 * client, so anything outside a strict #RRGGBB hex is CSS injection.
 */

const BRAND_TOKENS = new Set([
  'primary-50', 'primary-100', 'primary-400', 'primary-500', 'primary-600', 'primary-900',
  'action-50', 'action-400', 'action-500', 'action-600',
  'accent-atendimento', 'accent-crm', 'accent-automacao', 'accent-campanhas', 'accent-analytics', 'accent-instancias',
  'success', 'warning', 'danger', 'info',
]);

const SURFACE_TOKENS = new Set([
  'bg-base', 'bg-raised', 'bg-sidebar', 'bg-card', 'bg-hover', 'bg-selected',
  'text-primary', 'text-secondary', 'text-tertiary', 'border-default',
]);

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface WorkspaceTheme {
  version: 1;
  brand: Record<string, string>;
  light: Record<string, string>;
  dark: Record<string, string>;
}

/** Returns a sanitized theme (only allowlisted keys with valid hex values) or an error message. */
export function validateWorkspaceTheme(input: unknown): { theme: WorkspaceTheme } | { error: string } {
  if (typeof input !== 'object' || input === null) {
    return { error: 'Tema inválido' };
  }
  const raw = input as Record<string, unknown>;

  const pickSection = (sectionKey: 'brand' | 'light' | 'dark', allowlist: Set<string>): Record<string, string> | null => {
    const section = raw[sectionKey];
    if (section === undefined) return {};
    if (typeof section !== 'object' || section === null || Array.isArray(section)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
      if (!allowlist.has(key)) return null;
      if (typeof value !== 'string' || !HEX_RE.test(value)) return null;
      out[key] = value.toUpperCase();
    }
    return out;
  };

  const brand = pickSection('brand', BRAND_TOKENS);
  if (brand === null) return { error: 'Cor inválida (use hex #RRGGBB) ou chave de token desconhecida' };
  const light = pickSection('light', SURFACE_TOKENS);
  if (light === null) return { error: 'Cor inválida (use hex #RRGGBB) ou chave de token desconhecida' };
  const dark = pickSection('dark', SURFACE_TOKENS);
  if (dark === null) return { error: 'Cor inválida (use hex #RRGGBB) ou chave de token desconhecida' };

  return { theme: { version: 1, brand, light, dark } };
}
