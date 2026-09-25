/**
 * One-off creation of the first admin workspace/owner, meant to replace the
 * auto-provisioning branch that used to live in the frontend's public
 * POST /api/auth/login route: any request that 401'd was silently checked
 * against ADMIN_EMAIL/ADMIN_PASSWORD and, on a match, registered a brand-new
 * owner workspace on the spot. Those same env vars are the fallback for the
 * platform superadmin (see platform-admin.ts's PLATFORM_ADMIN_EMAIL ??
 * ADMIN_EMAIL) — the single most sensitive credential in the system — so that
 * code path gave anyone who ever obtained it a second, permanently-live way
 * to spend it: spin up a full-owner tenant workspace through the ordinary
 * public login form, on every request, with none of the login rate-limit
 * hardening applied. This script does the same provisioning exactly once,
 * out of band, run manually by whoever holds shell/env access to the
 * deployment — not on every HTTP request forever.
 *
 * Run once: npx tsx scripts/bootstrap-admin.ts
 * Safe to re-run: bails out without creating anything if an account with
 * this email already exists.
 *
 * Requires in the environment: MONGODB_URI, ADMIN_EMAIL, ADMIN_PASSWORD.
 * Optional: ADMIN_WORKSPACE_NAME (default "Workspace Principal"),
 * ADMIN_NAME (default "Administrador Principal").
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Account } from '../src/db/models/Account.model';
import { registerWorkspace } from '../src/modules/auth/auth.service';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI não definido');

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Defina ADMIN_EMAIL e ADMIN_PASSWORD no ambiente antes de rodar.');

  await mongoose.connect(uri);

  const existing = await Account.findOne({ signupEmail: email }).lean();
  if (existing) {
    console.log('[bootstrap-admin] já existe uma conta para', email, '— nada a fazer.');
    await mongoose.disconnect();
    return;
  }

  const { workspaceId } = await registerWorkspace({
    workspaceName: process.env.ADMIN_WORKSPACE_NAME?.trim() || 'Workspace Principal',
    ownerName: process.env.ADMIN_NAME?.trim() || 'Administrador Principal',
    email,
    password,
    acceptedTerms: true,
  });

  console.log('[bootstrap-admin] ✅ criado.');
  console.log('[bootstrap-admin] login:', email);
  console.log('[bootstrap-admin] workspace:', workspaceId);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[bootstrap-admin] falhou:', err);
  await mongoose.disconnect();
  process.exit(1);
});
