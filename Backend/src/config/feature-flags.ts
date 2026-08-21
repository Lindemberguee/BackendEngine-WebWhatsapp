/**
 * Launch-time feature gates. Flip to `false` and redeploy if any of these
 * ever need to be pulled again — kept in one place instead of scattering
 * "is this on" checks across route files.
 *
 * Campaigns/Templates/Meta Cloud API were locked at launch, then re-enabled
 * once a real customer needed to send a template campaign through the
 * official Meta Cloud API (see the "Campanha via template Meta" plan).
 *
 * This is a server-side gate, not just a UI hint — the routes these guard
 * reject with 403 even if someone calls the API directly, bypassing the
 * frontend's locked/"coming soon" state entirely.
 */
export const FEATURE_FLAGS = {
  campaigns: true,
  templates: true,
  metaCloudApi: true,
} as const;
