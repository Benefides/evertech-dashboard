const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const data = require('./data');
const metrics = require('./metrics');
const odoo = require('./odoo');

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

// ---------- access: one shared password for staff, plus an optional read-only link for a TV screen ----------
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const TV_TOKEN = process.env.TV_TOKEN || '';
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const issue = (res, kind) => {
  const exp = Date.now() + (kind === 'tv' ? 365 : 14) * 86400000;
  const v = `${kind}.${exp}`;
  res.cookie('dash', `${v}.${sign(v)}`, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: exp - Date.now() });
};
function session(req) {
  if (!PASSWORD) return 'open';
  const c = req.cookies.dash || '';
  const i = c.lastIndexOf('.');
  if (i < 0) return null;
  const v = c.slice(0, i), sig = c.slice(i + 1);
  const ok = sig.length === 64 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(v)));
  const [kind, exp] = v.split('.');
  return ok && Number(exp) > Date.now() ? kind : null;
}
const eq = (a, b) => { const x = Buffer.from(sign(String(a))), y = Buffer.from(sign(String(b))); return crypto.timingSafeEqual(x, y); };

const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!PASSWORD || !eq(req.body?.password || '', PASSWORD)) { a.n++; attempts.set(ip, a); return res.status(401).json({ error: 'Wrong password.' }); }
  attempts.delete(ip);
  issue(res, 'staff');
  res.json({ ok: true });
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
  req.kind = s; next();
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
    companies: ds.companies, teams: ds.teams, users: ds.users, kind: req.kind, canLogout: !!PASSWORD && req.kind === 'staff',
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
  const sets = {
    'to-invoice': [inv?.orders || [], [['Order', 'name'], ['Order date', 'date'], ['Days since order', 'age'], ['Customer', 'partner'], ['Salesperson', 'user'], ['Sales team', 'team'], [`Order total (${ds.currency.name})`, (r) => r2(r.amount)], [`Invoiced (${ds.currency.name})`, (r) => r2(r.invoiced)], [`To invoice (${ds.currency.name})`, (r) => r2(r.toInvoice)], ['Lines to invoice', (r) => r.lines.map((l) => `${l.product} x ${l.toInvoiceQty ?? l.qty}`).join('; ')]]],
    opportunities: [tgt ? [...tgt.planned.map((r) => ({ ...r, inTarget: 'Yes' })), ...tgt.unplanned.map((r) => ({ ...r, inTarget: 'No (won outside target)' }))] : [],
      [['Opportunity', 'name'], ['Customer', 'partner'], ['Salesperson', 'user'], ['Stage', 'stage'], ['Status', (r) => STATUS[r.status] || r.status], ['In target', 'inTarget'], ['Expected closing', 'deadline'], ['Closed', 'closed'], ['Created', 'created'], [`Expected revenue (${ds.currency.name})`, (r) => r2(r.expected)], ['Probability', (r) => r.probability + '%'], ['Sales orders', sos], [`SO amount (${ds.currency.name})`, (r) => r2(r.orders.reduce((a, o) => a + o.amount, 0))]]],
    orders: [det?.orders || [], [['Order', 'name'], ['Date', 'date'], ['Customer', 'partner'], ['Salesperson', 'user'], ['Sales team', 'team'], ['Company', 'company'], [`Revenue (${ds.currency.name})`, (r) => r2(r.amount)], [`Margin (${ds.currency.name})`, (r) => r2(r.margin)], ['Margin %', mPct], ['Invoice status', 'invoiceStatus']]],
    amc: [m.amc.rows, [['Order', 'name'], ['Customer', 'partner'], ['Salesperson', 'user'], ['AMC start', 'start'], ['Expires', 'expiry'], ['Days left', 'daysLeft'], [`Amount (${ds.currency.name})`, (r) => r2(r.amount)], ['Renewal order', 'renewedBy']]],
    licenses: [m.licenses.rows, [['Order', 'name'], ['Customer', 'partner'], ['Vendor', 'vendor'], ['Products', (r) => r.products.join('; ')], ['Term (months)', 'termMonths'], ['Salesperson', 'user'], ['Start', 'start'], ['Expires', 'expiry'], ['Days left', 'daysLeft'], [`Amount (${ds.currency.name})`, (r) => r2(r.amount)], ['Renewal order', 'renewedBy']]],
    target: [m.target.bySalesperson, [['Salesperson', 'name'], ['Planned opportunities', 'count'], [`Target (${ds.currency.name})`, (r) => r2(r.target)], [`Won (${ds.currency.name})`, (r) => r2(r.achieved)], ['Achievement', (r) => (r.pct == null ? '' : Math.round(r.pct * 1000) / 10 + '%')], [`Still open (${ds.currency.name})`, (r) => r2(r.open)], ['Past expected date', 'lateCount'], [`Lost (${ds.currency.name})`, (r) => r2(r.lost)]]],
    salespeople: [m.salespeople, [['Salesperson', 'name'], [`Revenue (${ds.currency.name})`, (r) => r2(r.revenue)], ['Orders', 'orders'], ['Won', 'won'], ['Lost', 'lost'], ['Win rate', (r) => (r.winRate == null ? '' : Math.round(r.winRate * 100) + '%')], [`Open pipeline (${ds.currency.name})`, (r) => r2(r.pipeline)], ['Overdue activities', 'overdue']]],
    customers: [m.topCustomers, [['Customer', 'name'], [`Revenue (${ds.currency.name})`, (r) => r2(r.value)], [`Margin (${ds.currency.name})`, (r) => r2(r.margin)], ['Margin %', (r) => (r.margin == null || !r.value ? '' : Math.round((r.margin / r.value) * 1000) / 10 + '%')], ['Orders', 'orders']]],
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
    if (!PASSWORD) console.log('  WARNING: DASHBOARD_PASSWORD is not set, so anyone who can reach this URL can see the data.');
    if (!process.env.SESSION_SECRET) console.log('  Note: set SESSION_SECRET so sign-ins survive restarts.');
  });
  data.load().catch((e) => console.error('  First data load failed:', e.message));
}
module.exports = app;
