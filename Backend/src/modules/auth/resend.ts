const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export class ResetEmailNotConfiguredError extends Error {
  constructor() {
    super('Password reset email is not configured');
    this.name = 'ResetEmailNotConfiguredError';
  }
}

function resetLink(token: string): string {
  const base = process.env.PUBLIC_APP_URL?.trim();
  if (!base) throw new ResetEmailNotConfiguredError();
  let url: URL;
  try { url = new URL(base); } catch { throw new ResetEmailNotConfiguredError(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) {
    throw new ResetEmailNotConfiguredError();
  }
  url.pathname = '/reset-password';
  url.search = '';
  url.hash = '';
  url.searchParams.set('token', token);
  return url.toString();
}

export function isResetEmailConfigured(): boolean {
  if (!process.env.RESEND_API_KEY?.trim() || !process.env.RESET_EMAIL_FROM?.trim()) return false;
  try { resetLink('configuration-check'); return true; } catch { return false; }
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESET_EMAIL_FROM?.trim();
  if (!apiKey || !from) throw new ResetEmailNotConfiguredError();

  const link = resetLink(token);
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Redefina sua senha',
      html: `<p>Recebemos um pedido para redefinir a senha da sua conta.</p><p><a href="${link}">Criar uma nova senha</a></p><p>O link expira em 30 minutos e só pode ser usado uma vez. Se você não pediu esta alteração, ignore este e-mail.</p>`,
      text: `Recebemos um pedido para redefinir sua senha. Acesse ${link} para criar uma nova senha. O link expira em 30 minutos e só pode ser usado uma vez. Se você não pediu esta alteração, ignore este e-mail.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error(`Resend rejected password reset email with status ${response.status}`);
}
