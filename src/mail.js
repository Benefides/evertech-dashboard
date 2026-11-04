// Sends the sign-in codes from a Microsoft 365 mailbox, one of two ways:
//  - graph: Microsoft Graph sendMail with an Entra (Azure AD) app registration (Mail.Send application permission). Works after
//           Microsoft retires password-based SMTP. Needs MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_FROM.
//  - smtp:  smtp.office365.com:587 with the mailbox's login (Authenticated SMTP must be allowed for it). Needs SMTP_USER, SMTP_PASS.
const env = (k) => process.env[k] || '';
const provider = () => env('MAIL_PROVIDER') || (env('MS_TENANT_ID') ? 'graph' : env('SMTP_USER') ? 'smtp' : '');
const from = () => env('MAIL_FROM') || env('SMTP_USER');

function configured() {
  const p = provider();
  if (p === 'graph') return !!(env('MS_TENANT_ID') && env('MS_CLIENT_ID') && env('MS_CLIENT_SECRET') && from());
  if (p === 'smtp') return !!(env('SMTP_USER') && env('SMTP_PASS'));
  return false;
}

let token = null;   // { value, exp }
async function graphToken() {
  if (token && token.exp > Date.now() + 60000) return token.value;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env('MS_TENANT_ID'))}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('MS_CLIENT_ID'), client_secret: env('MS_CLIENT_SECRET'), scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Microsoft sign-in for sending mail failed: ${j.error_description || j.error || res.status}`);
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

let transport = null;
async function send({ to, subject, text, html }) {
  if (provider() === 'graph') {
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from())}/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await graphToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: false }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status !== 202) { const j = await res.json().catch(() => ({})); throw new Error(`Microsoft Graph could not send the email: ${j.error?.message || res.status}`); }
    return;
  }
  if (!transport) {
    const nodemailer = require('nodemailer');
    const port = Number(env('SMTP_PORT') || 587);
    transport = nodemailer.createTransport({ host: env('SMTP_HOST') || 'smtp.office365.com', port, secure: port === 465, requireTLS: port !== 465 && env('SMTP_REQUIRE_TLS') !== '0',
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') }, connectionTimeout: 20000 });
  }
  await transport.sendMail({ from: from(), to, subject, text, html });
}

module.exports = { send, configured, provider };
