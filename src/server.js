const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const data = require('./data');
const metrics = require('./metrics');
const odoo = require('./odoo');
const mail = require('./mail');

const app = express();
app.disable('x-powered-by');
// behind a host's proxy (Render, Railway, Azure, nginx) so req.ip is the visitor, not the proxy — login rate limit is per IP
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'");
  next();
});

// ---------- access ----------
// Personal sign-in: DASHBOARD_USERS lists who may sign in (emails, or "@evertechme.com" for a whole domain); each person gets a
// 6-digit code by email (Microsoft 365, see mail.js). Without DASHBOARD_USERS: one shared DASHBOARD_PASSWORD (or open if unset).
// TV_TOKEN gives a read-only link for a meeting-room screen either way.
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const TV_TOKEN = process.env.TV_TOKEN || '';
const USERS = (process.env.DASHBOARD_USERS || '').split(/[,;\s]+/).map((u) => u.trim().toLowerCase()).filter(Boolean);
const MODE = USERS.length ? 'otp' : PASSWORD ? 'password' : 'open';
const OTP_MIN = Number(process.env.OTP_MINUTES || 10);
const allowed = (email) => !!email && USERS.some((u) => (u.startsWith('@') ? email.endsWith(u) : email === u));
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const b64 = (s) => Buffer.from(s).toString('base64url'), unb64 = (s) => Buffer.from(s, 'base64url').toString();
const cookieOpts = (ms) => ({ httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: ms });
// signed cookie value: parts joined by "." + signature (parts must not contain "."; emails are base64url-encoded)
const seal = (parts) => { const v = parts.join('.'); return `${v}.${sign(v)}`; };
function unseal(c) {
  const i = (c || '').lastIndexOf('.');
  if (i < 0) return null;
  const v = c.slice(0, i), sig = c.slice(i + 1);
  return sig.length === 64 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(v))) ? v.split('.') : null;
}
const issue = (res, kind, email = '') => {
  const exp = Date.now() + (kind === 'tv' ? 365 : 14) * 86400000;
  res.cookie('dash', seal(email ? [kind, exp, b64(email)] : [kind, exp]), cookieOpts(exp - Date.now()));
};
/** { kind: 'staff' | 'user' | 'tv' | 'open', email? } or null */
function session(req) {
  if (MODE === 'open') return { kind: 'open' };
  const p = unseal(req.cookies.dash);
  if (!p || Number(p[1]) <= Date.now()) return null;
  if (p[0] === 'tv') return { kind: 'tv' };
  if (MODE === 'otp') {
    const email = p[0] === 'user' && p[2] ? unb64(p[2]) : '';
    return allowed(email) ? { kind: 'user', email } : null;   // removed from DASHBOARD_USERS = signed out
  }
  return p[0] === 'staff' ? { kind: 'staff' } : null;
}
const eq = (a, b) => { const x = Buffer.from(sign(String(a))), y = Buffer.from(sign(String(b))); return crypto.timingSafeEqual(x, y); };

// simple in-memory limits (per server instance): wrong passwords/codes per IP, codes sent per email
const limits = new Map();
function limited(key, max, minutes) {
  const now = Date.now(), a = limits.get(key) || { n: 0, t: now };
  if (now - a.t > minutes * 60000) { a.n = 0; a.t = now; }
  a.n++; limits.set(key, a);
  return a.n > max;
}

app.get('/api/auth', (req, res) => res.json({ mode: MODE, minutes: OTP_MIN, mailReady: MODE !== 'otp' || mail.configured() }));

app.post('/api/login', (req, res) => {
  if (MODE !== 'password') return res.status(400).json({ error: 'Sign in with your email instead.' });
  if (limited('pw:' + req.ip, 10, 15)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!eq(req.body?.password || '', PASSWORD)) return res.status(401).json({ error: 'Wrong password.' });
  limits.delete('pw:' + req.ip);
  issue(res, 'staff');
  res.json({ ok: true });
});

// step 1: email → a 6-digit code by mail. Only a signed fingerprint of the code is kept, in a short-lived cookie (works on serverless hosts too).
app.post('/api/otp/request', async (req, res) => {
  if (MODE !== 'otp') return res.status(400).json({ error: 'Email sign-in is not switched on.' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter your work email address.' });
  if (!allowed(email)) return res.status(403).json({ error: "This email doesn't have access to the dashboard. Ask the administrator to add it." });
  if (!mail.configured()) return res.status(500).json({ error: 'Sending email is not set up on the server yet (Microsoft 365 settings missing).' });
  if (limited('send:' + email, 5, 15) || limited('sendip:' + req.ip, 20, 15)) return res.status(429).json({ error: 'Too many codes requested. Try again in 15 minutes.' });
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const exp = Date.now() + OTP_MIN * 60000, nonce = crypto.randomBytes(6).toString('hex');
  try {
    await mail.send({
      to: email,
      subject: `${code} is your Evertech dashboard sign-in code`,
      text: `Your sign-in code for the Evertech Sales & CRM dashboard is ${code}.\n\nIt expires in ${OTP_MIN} minutes. If you didn't try to sign in, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
        <p>Your sign-in code for the <b>Evertech Sales &amp; CRM dashboard</b> is:</p>
        <p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:14px 0;color:#155e4b">${code}</p>
        <p>It expires in ${OTP_MIN} minutes. If you didn't try to sign in, you can ignore this email.</p></div>`,
    });
  } catch (e) {
    console.error('[mail]', e.message);
    return res.status(502).json({ error: `Couldn't send the email: ${e.message}` });
  }
  res.cookie('otp', seal([b64(email), exp, nonce, sign(`${email}|${code}|${exp}|${nonce}`)]), cookieOpts(OTP_MIN * 60000));
  res.json({ ok: true, email, minutes: OTP_MIN });
});

// step 2: the code → signed in for 14 days
app.post('/api/otp/verify', (req, res) => {
  const p = unseal(req.cookies.otp);
  if (!p || Number(p[1]) <= Date.now()) return res.status(400).json({ error: 'The code has expired. Ask for a new one.', expired: true });
  const email = unb64(p[0]), code = String(req.body?.code || '').replace(/\D/g, '');
  if (limited('otp:' + email, 5, OTP_MIN) || limited('otpip:' + req.ip, 20, 15)) return res.status(429).json({ error: 'Too many wrong codes. Ask for a new code in a few minutes.' });
  if (code.length !== 6 || !eq(sign(`${email}|${code}|${p[1]}|${p[2]}`), p[3])) return res.status(401).json({ error: 'That code is not right. Check the email and try again.' });
  if (!allowed(email)) return res.status(403).json({ error: "This email doesn't have access to the dashboard." });
  limits.delete('otp:' + email);
  res.clearCookie('otp');
  issue(res, 'user', email);
  res.json({ ok: true, email });
});

app.post('/api/logout', (req, res) => { res.clearCookie('dash'); res.json({ ok: true }); });
app.get('/tv/:token', (req, res) => {
  if (!TV_TOKEN || !eq(req.params.token, TV_TOKEN)) return res.status(404).send('Not found');
  issue(res, 'tv');
  res.redirect('/?tv=1');
});

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

app.use('/api', (req, res, next) => {
  const s = session(req);
  if (!s) return res.status(401).json({ error: 'Please sign in.' });
  req.kind = s.kind; req.email = s.email || ''; next();
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[api]', e.message);
  res.status(502).json({ error: e.odoo ? `Odoo said: ${e.message}` : e.message });
});

const num = (v) => (v ? Number(v) : null);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
// "today" in the company's time zone (UAE by default), not the server's
const TZ = process.env.DASHBOARD_TZ || 'Asia/Dubai';
const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function filters(q) {
  const today = localToday();
  const to = isDate(q.to) ? q.to : today;
  const from = isDate(q.from) && q.from <= to ? q.from : today.slice(0, 7) + '-01';
  return { from, to, company: num(q.company), team: num(q.team), user: num(q.user), compare: q.compare === 'ly' ? 'ly' : 'prev', today };
}

app.get('/api/meta', wrap(async (req, res) => {
  const ds = await data.load();
  res.json({ source: ds.source, odooUrl: ds.source === 'odoo' ? ds.odooUrl : null, currency: ds.currency, fetchedAt: ds.fetchedAt,
    companies: ds.companies, teams: ds.teams, users: ds.users, kind: req.kind, email: req.email, canLogout: req.kind === 'staff' || req.kind === 'user',
    counts: { orders: ds.orders.length, leads: ds.leads.length } });
}));

app.get('/api/dashboard', wrap(async (req, res) => {
  const ds = await data.load();
  res.json({ fetchedAt: ds.fetchedAt, currency: ds.currency, ...metrics.compute(ds, filters(req.query)) });
}));

app.get('/api/orders', wrap(async (req, res) => {
  const ds = await data.load();
  res.json({ fetchedAt: ds.fetchedAt, currency: ds.currency, ...metrics.details(ds, filters(req.query), req.query.range === 'ytd' ? 'ytd' : 'period') });
}));

app.get('/api/to-invoice', wrap(async (req, res) => {
  const ds = await data.load();
  res.json({ fetchedAt: ds.fetchedAt, currency: ds.currency, ...metrics.invoiceDetails(ds, filters(req.query)) });
}));

app.get('/api/target', wrap(async (req, res) => {
  const ds = await data.load();
  res.json({ fetchedAt: ds.fetchedAt, currency: ds.currency, ...metrics.targetDetails(ds, filters(req.query)) });
}));

app.get('/api/receivables', wrap(async (req, res) => {
  const ds = await data.load();
  res.json({ fetchedAt: ds.fetchedAt, currency: ds.currency, ...metrics.receivablesDetails(ds, filters(req.query)) });
}));

app.get('/api/statement', wrap(async (req, res) => {
  const ds = await data.load();
  const ids = String(req.query.partner || '').split('_').map(Number).filter(Boolean);   // 12_34 = one customer held twice in Odoo
  if (!ids.length) return res.status(400).json({ error: 'Which customer? Add ?partner=<id>.' });
  res.json({ currency: ds.currency, odooUrl: ds.source === 'odoo' ? ds.odooUrl : null, ...metrics.statement(ds, ids, filters(req.query)) });
}));

app.post('/api/refresh', wrap(async (req, res) => {
  if (req.kind === 'tv') return res.status(403).json({ error: 'Read-only screen' });
  odoo.reset();
  const ds = await data.load(true);
  res.json({ fetchedAt: ds.fetchedAt });
}));

// CSV downloads of the tables
const csv = (rows, cols) => [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map(([, k]) => {
  const v = typeof k === 'function' ? k(r) : r[k];
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(','))].join('\n');
app.get('/api/export/:what.csv', wrap(async (req, res) => {
  const ds = await data.load();
  const m = metrics.compute(ds, filters(req.query));
  const r2 = (v) => (v == null ? '' : Math.round(v * 100) / 100);
  const mPct = (r) => (r.margin == null || !r.amount ? '' : Math.round((r.margin / r.amount) * 1000) / 10 + '%');
  const det = req.params.what === 'orders' ? metrics.details(ds, filters(req.query), req.query.range === 'ytd' ? 'ytd' : 'period') : null;
  if (det) Object.assign(m.period, { from: det.from, to: det.to });
  const inv = req.params.what === 'to-invoice' ? metrics.invoiceDetails(ds, filters(req.query)) : null;
  const tgt = req.params.what === 'opportunities' ? metrics.targetDetails(ds, filters(req.query)) : null;
  const sos = (r) => r.orders.map((o) => `${o.name} (${o.date})`).join('; ');
  const STATUS = { won: 'Won', lost: 'Lost', open: 'Open', late: 'Open, past expected date' };
  const ar = req.params.what === 'receivables' ? metrics.receivablesDetails(ds, filters(req.query)) : null;
  const sets = {
    receivables: [ar?.invoices || [], [['Invoice', 'name'], ['Type', (r) => (r.type === 'refund' ? 'Credit note' : 'Invoice')], ['Customer', 'partner'], ['Invoice date', 'date'], ['Order ref.', 'ref'], ['Product', 'product'], ['Salesperson', 'user'], [`Invoice total (${ds.currency.name})`, (r) => r2(r.total)], [`Outstanding (${ds.currency.name})`, (r) => r2(r.residual)], ['Due date', 'due'], ['Days overdue', (r) => r.overdue || '']]],
    'to-invoice': [(inv?.orders || []).filter((r) => (req.query.older === '1' ? r.older : !r.older)), [['Order', 'name'], ['Order date', 'date'], ['Days since order', 'age'], ['Customer', 'partner'], ['Salesperson', 'user'], ['Sales team', 'team'], [`Order total (${ds.currency.name})`, (r) => r2(r.amount)], [`Invoiced (${ds.currency.name})`, (r) => r2(r.invoiced)], [`To invoice (${ds.currency.name})`, (r) => r2(r.toInvoice)], ['Lines to invoice', (r) => r.lines.map((l) => `${l.product} x ${l.toInvoiceQty ?? l.qty}`).join('; ')]]],
    opportunities: [tgt ? [...tgt.planned.map((r) => ({ ...r, inTarget: 'Yes' })), ...tgt.unplanned.map((r) => ({ ...r, inTarget: 'No (won outside target)' }))] : [],
      [['Opportunity', 'name'], ['Customer', 'partner'], ['Salesperson', 'user'], ['Stage', 'stage'], ['Status', (r) => STATUS[r.status] || r.status], ['In target', 'inTarget'], ['Expected closing', 'deadline'], ['Closed', 'closed'], ['Created', 'created'], [`Expected sales (${ds.currency.name})`, (r) => r2(r.expected)], ['Probability', (r) => r.probability + '%'], ['Sales orders', sos], [`SO amount (${ds.currency.name})`, (r) => r2(r.orders.reduce((a, o) => a + o.amount, 0))]]],
    orders: [det?.orders || [], [['Order', 'name'], ['Date', 'date'], ['Customer', 'partner'], ['Salesperson', 'user'], ['Sales team', 'team'], ['Company', 'company'], [`Sales (${ds.currency.name})`, (r) => r2(r.amount)], [`Margin (${ds.currency.name})`, (r) => r2(r.margin)], ['Margin %', mPct], ['Invoice status', 'invoiceStatus']]],
    amc: [m.amc.rows, [['Order', 'name'], ['Customer', 'partner'], ['Salesperson', 'user'], ['AMC start', 'start'], ['Expires', 'expiry'], ['Days left', 'daysLeft'], [`Amount (${ds.currency.name})`, (r) => r2(r.amount)], ['Renewal order', 'renewedBy']]],
    licenses: [m.licenses.rows, [['Order', 'name'], ['Customer', 'partner'], ['Vendor', 'vendor'], ['Products', (r) => r.products.join('; ')], ['Term (months)', 'termMonths'], ['Salesperson', 'user'], ['Start', 'start'], ['Expires', 'expiry'], ['Days left', 'daysLeft'], [`Amount (${ds.currency.name})`, (r) => r2(r.amount)], ['Renewal order', 'renewedBy']]],
    target: [m.target.bySalesperson, [['Salesperson', 'name'], ['Planned opportunities', 'count'], [`Target (${ds.currency.name})`, (r) => r2(r.target)], [`Won (${ds.currency.name})`, (r) => r2(r.achieved)], ['Achievement', (r) => (r.pct == null ? '' : Math.round(r.pct * 1000) / 10 + '%')], [`Still open (${ds.currency.name})`, (r) => r2(r.open)], ['Past expected date', 'lateCount'], [`Lost (${ds.currency.name})`, (r) => r2(r.lost)]]],
    salespeople: [m.salespeople, [['Salesperson', 'name'], [`Sales (${ds.currency.name})`, (r) => r2(r.revenue)], ['Orders', 'orders'], ['Won', 'won'], ['Lost', 'lost'], ['Win rate', (r) => (r.winRate == null ? '' : Math.round(r.winRate * 100) + '%')], [`Open pipeline (${ds.currency.name})`, (r) => r2(r.pipeline)], ['Overdue activities', 'overdue']]],
    customers: [m.topCustomers, [['Customer', 'name'], [`Sales (${ds.currency.name})`, (r) => r2(r.value)], [`Margin (${ds.currency.name})`, (r) => r2(r.margin)], ['Margin %', (r) => (r.margin == null || !r.value ? '' : Math.round((r.margin / r.value) * 1000) / 10 + '%')], ['Orders', 'orders']]],
    pipeline: [m.stages, [['Stage', 'name'], ['Opportunities', 'count'], [`Expected (${ds.currency.name})`, (r) => r2(r.value)], [`Weighted (${ds.currency.name})`, (r) => r2(r.weighted)]]],
  };
  const set = sets[req.params.what];
  if (!set) return res.status(404).json({ error: 'Unknown export' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.what}-${m.period.from}-to-${m.period.to}.csv"`);
  res.send('﻿' + csv(...set));
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Evertech Sales & CRM dashboard on http://localhost:${PORT}`);
    console.log(process.env.DEMO === '1' || !odoo.configured() ? '  Using DEMO data (set ODOO_* in .env to connect)' : `  Odoo: ${process.env.ODOO_URL} / ${process.env.ODOO_DB}`);
    if (MODE === 'otp') console.log(`  Sign-in: email code for ${USERS.length} allowed address(es) via ${mail.provider() || '(mail not set up!)'}`);
    if (MODE === 'otp' && !mail.configured()) console.log('  WARNING: DASHBOARD_USERS is set but Microsoft 365 mail is not configured, so nobody can sign in.');
    if (MODE === 'open') console.log('  WARNING: neither DASHBOARD_USERS nor DASHBOARD_PASSWORD is set, so anyone who can reach this URL can see the data.');
    if (!process.env.SESSION_SECRET) console.log('  Note: set SESSION_SECRET so sign-ins survive restarts.');
  });
  data.load().catch((e) => console.error('  First data load failed:', e.message));
}
module.exports = app;
