import { columns, hbars, table, sparkline } from './charts.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const TV = new URLSearchParams(location.search).get('tv') === '1';
if (TV) document.body.classList.add('tv');

let META = null, DATA = null, DETAIL = null;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- theme ----------
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch (_) {}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch (_) {}
  renderCharts();
}

// ---------- formatting ----------
const cur = () => DATA?.currency?.symbol || META?.currency?.symbol || '';
function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return String(parseFloat((v / 1e6).toFixed(a >= 1e7 ? 1 : 2))) + 'M';
  if (a >= 1e3) return String(parseFloat((v / 1e3).toFixed(a >= 1e5 ? 0 : 1))) + 'K';
  return String(Math.round(v));
}
const money = (v) => (v == null ? '–' : `${cur()} ${compact(v)}`);
const moneyFull = (v) => (v == null ? '–' : `${cur()} ${Math.round(v).toLocaleString('en-US')}`);
const int = (v) => (v == null ? '–' : Math.round(v).toLocaleString('en-US'));
const pct = (v) => (v == null ? '–' : Math.round(v * 100) + '%');
const dmy = (s) => { if (!s) return '–'; const [y, m, d] = s.split('-'); return `${Number(d)} ${MONTHS[m - 1]} ${y}`; };
const monthLabel = (ym) => { const [y, m] = ym.split('-'); return `${MONTHS[m - 1]} ${y}`; };
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const odooLink = (model, id, label) => (META?.odooUrl && id ? `<a href="${esc(META.odooUrl)}/web#id=${id}&model=${model}&view_type=form" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label));

function delta(cur, prev, { good = 'up', kind = 'pct' } = {}) {
  if (cur == null || prev == null) return '<span>no comparison</span>';
  let d, txt;
  if (kind === 'pts') { d = cur - prev; txt = `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 100))} pts`; }
  else if (kind === 'abs') { d = cur - prev; txt = `${d >= 0 ? '+' : '−'}${int(Math.abs(d))}`; }
  else { if (!prev) return '<span>new</span>'; d = (cur - prev) / Math.abs(prev); txt = `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%`; }
  if (Math.abs(d) < 1e-9) return '<b>±0</b>';
  const better = good === 'up' ? d > 0 : d < 0;
  return `<b class="${better ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${txt}</b>`;
}
const vsLabel = () => (DATA.period.compare === 'ly' ? 'vs same period last year' : 'vs previous period');

// ---------- api ----------
async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', ...opts };
  if (o.body) { o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(o.body); }
  const res = await fetch('/api' + path, o);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { renderLogin(); throw new Error('signin'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ---------- filters (kept in the URL hash so a view can be shared/bookmarked) ----------
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
function presetRange(p) {
  const t = todayISO(); const [y, m] = t.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const q = Math.floor((m - 1) / 3);
  switch (p) {
    case 'mtd': return { from: `${y}-${pad(m)}-01`, to: t, compare: 'prev' };
    case 'last_month': { const yy = m === 1 ? y - 1 : y, mm = m === 1 ? 12 : m - 1; return { from: `${yy}-${pad(mm)}-01`, to: `${yy}-${pad(mm)}-${lastDay(yy, mm)}`, compare: 'prev' }; }
    case 'qtd': return { from: `${y}-${pad(q * 3 + 1)}-01`, to: t, compare: 'ly' };
    case 'ytd': return { from: `${y}-01-01`, to: t, compare: 'ly' };
    case 'last_year': return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, compare: 'ly' };
    case 'last_12': { const d = new Date(Date.UTC(y, m - 12, 1)); return { from: d.toISOString().slice(0, 10), to: t, compare: 'ly' }; }
    case 'last_90': { const d = new Date(Date.parse(t) - 89 * 86400000); return { from: d.toISOString().slice(0, 10), to: t, compare: 'prev' }; }
    default: return null;
  }
}
const PRESETS = [['mtd', 'This month'], ['last_month', 'Last month'], ['last_90', 'Last 90 days'], ['qtd', 'This quarter'], ['ytd', 'Year to date'], ['last_12', 'Last 12 months'], ['last_year', 'Last year'], ['custom', 'Custom range']];
function readState() {
  const h = new URLSearchParams(location.hash.slice(1));
  const preset = h.get('p') || 'ytd';
  const r = preset === 'custom' ? { from: h.get('from') || todayISO().slice(0, 8) + '01', to: h.get('to') || todayISO(), compare: h.get('compare') || 'prev' } : presetRange(preset) || presetRange('ytd');
  if (h.get('compare')) r.compare = h.get('compare');
  return { preset, ...r, company: h.get('company') || '', team: h.get('team') || '', user: h.get('user') || '',
    view: h.get('view') || '', range: h.get('range') === 'ytd' ? 'ytd' : 'period' };
}
function hashOf(s) {
  const h = new URLSearchParams();
  h.set('p', s.preset);
  if (s.preset === 'custom') { h.set('from', s.from); h.set('to', s.to); }
  const def = s.preset === 'custom' ? 'prev' : presetRange(s.preset).compare;
  if (s.compare && s.compare !== def) h.set('compare', s.compare);
  for (const k of ['company', 'team', 'user']) if (s[k]) h.set(k, s[k]);
  if (s.view) { h.set('view', s.view); if (s.range === 'ytd') h.set('range', 'ytd'); }
  return '#' + h.toString();
}
function writeState(s) { history.replaceState(null, '', hashOf(s)); }
// link to the revenue details screen (same filters); a normal link, so the browser's Back button returns to the dashboard
const detailHref = (range) => hashOf({ ...readState(), view: 'revenue', range });
const viewHref = (view, extra = {}) => hashOf({ ...readState(), view, ...extra });

// ---------- login ----------
function renderLogin(err) {
  app.innerHTML = `<div class="login"><form id="lf">
    <img src="/logo.png" alt="EverTech" class="logo-light"><img src="/logo-dark.png" alt="EverTech" class="logo-dark">
    <h1>Sales & CRM dashboard</h1><p>Enter the dashboard password.</p>
    <input type="password" name="password" autocomplete="current-password" required autofocus>
    ${err ? `<div class="error" style="margin:0 0 12px">${esc(err)}</div>` : ''}
    <button class="btn primary">Sign in</button></form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/login', { method: 'POST', body: { password: e.target.password.value } }); boot(); }
    catch (er) { if (er.message !== 'signin') renderLogin(er.message); }
  };
}

// ---------- shell ----------
function renderShell() {
  const s = readState();
  const opts = (rows, val, all) => `<option value="">${all}</option>` + rows.map((r) => `<option value="${r.id}" ${String(r.id) === String(val) ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const teams = META.teams.filter((t) => !s.company || !t.companyId || String(t.companyId) === s.company);
  app.innerHTML = `
  <header class="top">
    <img src="/logo.png" alt="EverTech" class="logo-light"><img src="/logo-dark.png" alt="EverTech" class="logo-dark">
    <span class="title">Sales & CRM</span>
    <span class="grow"></span>
    <span class="src ${META.source === 'demo' ? 'demo' : ''}" id="src"></span>
    <button class="btn tv-hide" id="refresh" title="Fetch fresh data from Odoo">↻ Refresh</button>
    <button class="btn icon tv-hide" id="theme" title="Light / dark" aria-label="Toggle light or dark theme"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5Z" fill="currentColor"/></svg></button>
    ${META.canLogout ? '<button class="btn tv-hide" id="logout">Sign out</button>' : ''}
  </header>
  <div class="filters" role="search">
    <label>Period<select id="f-preset">${PRESETS.map(([v, l]) => `<option value="${v}" ${v === s.preset ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label id="f-range" ${s.preset === 'custom' ? '' : 'hidden'}>From – to<span class="range"><input type="date" id="f-from" value="${s.from}"><input type="date" id="f-to" value="${s.to}"></span></label>
    <label>Compare<select id="f-compare"><option value="prev" ${s.compare === 'prev' ? 'selected' : ''}>Previous period</option><option value="ly" ${s.compare === 'ly' ? 'selected' : ''}>Same period last year</option></select></label>
    ${META.companies.length > 1 ? `<label>Company<select id="f-company">${opts(META.companies, s.company, 'All companies')}</select></label>` : ''}
    <label>Sales team<select id="f-team">${opts(teams, s.team, 'All teams')}</select></label>
    <label>Salesperson<select id="f-user">${opts(META.users, s.user, 'Everyone')}</select></label>
  </div>
  <main id="main"></main>`;
  const change = () => {
    const st = readState();
    st.preset = $('#f-preset').value;
    $('#f-range').hidden = st.preset !== 'custom';
    if (st.preset === 'custom') { st.from = $('#f-from').value; st.to = $('#f-to').value; }
    const def = st.preset === 'custom' ? 'prev' : presetRange(st.preset).compare;
    st.compare = this_changed === 'f-preset' ? def : $('#f-compare').value;
    if (this_changed === 'f-preset') $('#f-compare').value = def;
    st.company = $('#f-company')?.value || ''; st.team = $('#f-team').value; st.user = $('#f-user').value;
    writeState(st); load();
  };
  let this_changed = null;
  $$('.filters select, .filters input').forEach((n) => n.addEventListener('change', () => { this_changed = n.id; change(); }));
  $('#refresh').onclick = async () => {
    const b = $('#refresh'); b.disabled = true; b.textContent = 'Refreshing…';
    try { await api('/refresh', { method: 'POST' }); META = await api('/meta'); await load(); } catch (e) { showError(e.message); }
    b.disabled = false; b.textContent = '↻ Refresh';
  };
  $('#theme').onclick = toggleTheme;
  const lo = $('#logout'); if (lo) lo.onclick = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); renderLogin(); };
}

function showError(msg) {
  const m = $('#main'); if (!m) return;
  m.classList.remove('loading');
  m.insertAdjacentHTML('afterbegin', `<div class="error">Couldn't load data: ${esc(msg)}</div>`);
}

async function load() {
  const s = readState();
  const q = new URLSearchParams({ from: s.from, to: s.to, compare: s.compare });
  for (const k of ['company', 'team', 'user']) if (s[k]) q.set(k, s[k]);
  const main = $('#main');
  main.classList.add('loading');                      // keep the old frame while refetching
  try {
    const v = VIEWS[s.view];
    if (v) { q.set('range', s.range); DETAIL = await api(v[0] + '?' + q); v[1](); }
    else { DATA = await api('/dashboard?' + q); renderMain(); }
  } catch (e) { if (e.message !== 'signin') showError(e.message); }
  main.classList.remove('loading');
}

// moving between the dashboard and the details screen (tile click, Back/Forward): reload, and keep the dashboard's scroll position
let lastView = null, dashScroll = 0;
// the filter boxes follow the address (a link can change the salesperson, Back can restore the old filters)
function syncFilters() {
  const s = readState();
  const set = (id, v) => { const e = $('#' + id); if (e) e.value = v; };
  set('f-preset', s.preset); set('f-compare', s.compare); set('f-company', s.company); set('f-team', s.team); set('f-user', s.user);
  set('f-from', s.from); set('f-to', s.to);
  const r = $('#f-range'); if (r) r.hidden = s.preset !== 'custom';
}
window.addEventListener('hashchange', async () => {
  if (!META) return;
  syncFilters();
  const v = readState().view;
  if (v === lastView) return load();
  if (!lastView) dashScroll = scrollY;
  await load();
  scrollTo(0, v ? 0 : dashScroll);
});

// ---------- main ----------
const charts = [];   // {host, draw} redrawn on resize / theme change
function renderCharts() { for (const c of charts) if (!c.asTable()) c.draw(); }
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(renderCharts, 120); });

function chartCard(id, title, sub, extra = '') {
  return `<div class="card" id="${id}"><div class="card-head"><div><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ''}</div>
    <div class="tools">${extra}<button class="btn sm" data-toggle="${id}" aria-pressed="false">Table</button></div></div>
    <div class="legend-slot"></div><div class="chart"></div></div>`;
}
function mountChart(id, draw, tableRows, tableCols, legend) {
  const card = $('#' + id); const host = $('.chart', card);
  if (legend) $('.legend-slot', card).innerHTML = `<div class="legend">${legend.map((l) => `<span><i style="background:${l.color}"></i>${esc(l.name)}</span>`).join('')}</div>`;
  let asTable = false;
  const c = { host, draw: () => draw(host), asTable: () => asTable };
  charts.push(c);
  const btn = $(`[data-toggle="${id}"]`, card);
  btn.onclick = () => {
    asTable = !asTable; btn.setAttribute('aria-pressed', asTable); btn.textContent = asTable ? 'Chart' : 'Table';
    if (asTable) table(host, tableRows, tableCols); else c.draw();
  };
  c.draw();
}
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function tile(label, value, deltaHtml, extra = '', cls = '', href = '') {
  const tag = href ? 'a' : 'div', link = href ? ` href="${href}" title="Show the orders behind this number"` : '';
  return `<${tag} class="tile ${cls}${href ? ' link' : ''}"${link}><div class="k">${label}${href ? ' <span class="go" aria-hidden="true">›</span>' : ''}</div><div class="v">${value}</div><div class="d">${deltaHtml}${extra}</div></${tag}>`;
}

const ICON = {
  critical: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.5" fill="currentColor"/><path d="M6 3v3.4M6 8.4v.2" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
  serious: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8 11.4 10.6H.6Z" fill="currentColor"/><path d="M6 4.3v2.8M6 8.8v.1" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>',
  warning: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 3.2V6l2 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  good: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.5" fill="currentColor"/><path d="m3.4 6.2 1.8 1.8 3.5-3.6" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const status = (kind, label) => `<span class="status ${kind}">${ICON[kind] || ''}${esc(label)}</span>`;

function renderMain() {
  const d = DATA, k = d.kpis, p = d.period;
  charts.length = 0; lastView = '';
  const per = detailHref('period'), ytdH = detailHref('ytd');
  const src = $('#src');
  src.textContent = (META.source === 'demo' ? 'Demo data' : 'Live from Odoo') + ' · updated ' + ago(d.fetchedAt);
  src.title = new Date(d.fetchedAt).toLocaleString();
  const vs = vsLabel();
  const months = d.revByMonth;
  const tg = d.target, tt = tg.total;
  const y = k.ytd, ytdLabel = `1 Jan – ${dmy(y.to).replace(/ \d{4}$/, '')} vs ${Number(y.to.slice(0, 4)) - 1}`;
  // margin tile: amount, change vs the comparison, and margin as % of revenue; "–" when Odoo has no margin field
  // GP growth from previous month, as a percentage
  const gpTile = (g) => {
    const short = (m) => MONTHS[Number(m.slice(5)) - 1];
    if (g.cur == null) return tile('GP growth', '–', '<span>needs the Sales Margin module in Odoo</span>');
    const v = g.value == null ? '–' : `<span class="${g.value >= 0 ? 'up' : 'down'}">${g.value >= 0 ? '+' : '−'}${Math.abs(g.value * 100).toFixed(1)}%</span>`;
    return tile('GP growth', v, `<span>${short(g.month)} ${money(g.cur)} vs ${short(g.prevMonth)} ${money(g.prev)}</span>`, '', 'gp');
  };
  const marginTile = (label, m, mPrev, rev, note, cls = '', href = '') => (m == null
    ? tile(label, '–', '<span>needs the Sales Margin module in Odoo</span>', '', cls)
    : tile(label, `<span title="${moneyFull(m)}">${money(m)}</span>`, delta(m, mPrev), ` <span>${rev ? pct(m / rev) + ' of sales · ' : ''}${note}</span>`, cls, href));

  $('#main').innerHTML = `
    ${META.source === 'demo' ? '<div class="banner tv-hide">Showing sample data. Add your Odoo URL, database, login and API key to <b>.env</b> to see Evertech\'s real numbers.</div>' : ''}
    <div class="period-note" style="margin-top:12px">${dmy(p.from)} – ${dmy(p.to)} (${p.days} days) · compared with ${dmy(p.prevFrom)} – ${dmy(p.prevTo)} · amounts in ${esc(d.currency.name)}, excl. tax</div>

    <section class="section" aria-labelledby="h-sales">
      <div class="section-head"><h2 id="h-sales">Sales</h2><span class="sub">Confirmed sales orders, by order date</span></div>
      <div class="tiles">
        <a class="tile hero link" href="${per}" title="Show the orders behind this number"><div class="k">Sales <span class="go" aria-hidden="true">›</span></div><div class="v" title="${moneyFull(k.revenue.value)}">${money(k.revenue.value)}</div>
          <div class="row"><div class="d">${delta(k.revenue.value, k.revenue.prev)} <span>${vs}</span></div><div id="spark-rev"></div></div></a>
        ${marginTile('Margin', k.margin.value, k.margin.prev, k.margin.revenue, vs, '', per)}
        ${gpTile(k.gpGrowth)}
        ${tile('Sales YTD', `<span title="${moneyFull(y.revenue)}">${money(y.revenue)}</span>`, delta(y.revenue, y.revenuePrev), ` <span>${ytdLabel}</span>`, 'ytd', ytdH)}
        ${marginTile('Margin YTD', y.margin, y.marginPrev, y.revenue, ytdLabel, 'ytd', ytdH)}
        ${tile('Orders', int(k.orders.value), delta(k.orders.value, k.orders.prev), ` <span>in the period</span>`, '', per)}
        ${tile('Orders YTD', int(y.orders), delta(y.orders, y.ordersPrev), ` <span>${ytdLabel}</span>`, 'ytd', ytdH)}
        ${tile('To invoice', money(k.toInvoice.value), `<span>${int(k.toInvoice.count)} orders since ${dmy(k.toInvoice.from)}</span>${k.toInvoice.olderCount ? ` ${status('warning', `${int(k.toInvoice.olderCount)} older to check`)}` : ''}`, '', '', viewHref('invoice'))}
      </div>
      <div class="grid g-wide" style="margin-top:14px">
        ${chartCard('c-rev', 'Sales by month', `Last 12 months to ${monthLabel(months[months.length - 1].month)}`)}
        ${chartCard('c-cust', 'Top customers', 'Sales in the period', `<a class="btn sm tv-hide" data-csv="customers">CSV</a>`)}
      </div>
      <div class="grid" style="margin-top:14px">
        <div class="card"><div class="card-head"><div><h3>Salespeople</h3><p>Sales and CRM results in the period, open pipeline now</p></div>
          <div class="tools"><a class="btn sm" data-csv="salespeople">CSV</a></div></div><div class="table-wrap" id="t-people"></div></div>
      </div>
    </section>

    <section class="section" aria-labelledby="h-ar">
      <div class="section-head"><h2 id="h-ar">Invoices & receivables</h2><span class="sub">Posted customer invoices not fully paid, as of today · incl. VAT · not affected by the period filter</span></div>
      ${d.receivables.available ? `<div class="amc-tiles">
        ${tile('Outstanding', `<span title="${moneyFull(d.receivables.outstanding)}">${money(d.receivables.outstanding)}</span>`, `<span>${int(d.receivables.invoices)} invoices · ${int(d.receivables.customers)} customers</span>`, '', '', viewHref('invoices'))}
        ${tile('Overdue', money(d.receivables.overdue), d.receivables.overdueCount ? status('critical', `${int(d.receivables.overdueCount)} invoice${d.receivables.overdueCount === 1 ? '' : 's'}`) : status('good', 'None'), '', '', viewHref('invoices'))}
        ${tile('Due in the next 30 days', money(d.receivables.due30), '<span>not overdue yet</span>', '', '', viewHref('invoices'))}
        ${tile('Statements of account', '<span class="soa-ico" aria-hidden="true">⎙</span>Print', '<span>per customer, as PDF</span>', '', '', viewHref('invoices'))}
      </div>` : `<div class="card"><div class="empty">${d.receivables.error ? `Odoo didn't allow reading invoices: ${esc(d.receivables.error)}. Give the dashboard's Odoo user read access to Invoicing (e.g. the "Billing" role).` : 'Invoices are not available in this Odoo database.'}</div></div>`}
    </section>

    <section class="section" aria-labelledby="h-crm">
      <div class="section-head"><h2 id="h-crm">CRM pipeline</h2><span class="sub">Opportunities: won/lost by close date, pipeline = open right now</span></div>
      <div class="tiles crm">
        <div class="tile hero"><div class="k">Open pipeline</div><div class="v" title="${moneyFull(k.pipeline.value)}">${money(k.pipeline.value)}</div>
          <div class="d"><span><b>${money(k.pipeline.weighted)}</b> weighted by probability · ${int(k.pipeline.count)} opportunities</span></div></div>
        ${tile('Won', money(k.won.value), delta(k.won.value, k.won.prev), ` <span>${int(k.won.count)} deals</span>`)}
        ${tile('Win rate', pct(k.winRate.value), delta(k.winRate.value, k.winRate.prev, { kind: 'pts' }), ` <span>${k.winRate.won} won · ${k.winRate.lost} lost</span>`)}
        ${tile('Days to close', k.cycle.value == null ? '–' : Math.round(k.cycle.value) + '<small>days</small>', delta(k.cycle.value, k.cycle.prev, { good: 'down' }), ' <span>avg, won deals</span>')}
        ${tile('New leads', int(k.newLeads.value), delta(k.newLeads.value, k.newLeads.prev))}
        ${tile('Overdue activities', int(k.overdue.value), k.overdue.value ? status('serious', 'Needs follow-up') : status('good', 'All on time'))}
      </div>
      <div class="grid g-wide" style="margin-top:14px">
        ${chartCard('c-target', 'Target vs won by month', 'Target = expected sales of opportunities with their Expected Closing date in the month')}
        <div class="card"><div class="card-head"><div><h3>Target</h3><p>${dmy(tg.from)} – ${dmy(tg.to)}</p></div><div class="tools"><a class="btn sm" href="${viewHref('target')}">Details ›</a></div></div>
          <dl class="fc">
            <div class="total"><dt>Target<small>${int(tt.count)} opportunities planned to close</small></dt><dd>${money(tt.target)}</dd></div>
            <div><dt>Won</dt><dd>${money(tt.achieved)}<small>${int(tt.wonCount)} deal${tt.wonCount === 1 ? '' : 's'}</small></dd></div>
            <div><dt>Achievement</dt><dd>${tt.pct == null ? '–' : pct(tt.pct)}<div class="meter" role="img" aria-label="${tt.pct == null ? 'No target' : pct(tt.pct) + ' of target'}"><i style="width:${Math.min(100, (tt.pct || 0) * 100)}%"></i></div></dd></div>
            <div><dt>Still open<small>planned, not won or lost yet</small></dt><dd>${money(tt.open)}<small>${int(tt.openCount)} open${tt.lateCount ? ` · ${status('critical', `${int(tt.lateCount)} past date`)}` : ''}</small></dd></div>
            <div><dt>Lost<small>planned but lost</small></dt><dd>${money(tt.lost)}<small>${int(tt.lostCount)} lost</small></dd></div>
          </dl></div>
      </div>
      <div class="card" style="margin-top:14px"><div class="card-head"><div><h3>Target by salesperson</h3><p>${dmy(tg.from)} – ${dmy(tg.to)} · target from Expected Closing dates, won by close date</p></div>
        <div class="tools"><a class="btn sm" data-csv="target">CSV</a><a class="btn sm" href="${viewHref('target')}">Details ›</a></div></div><div class="table-wrap" id="t-target"></div></div>
      <div class="grid g2" style="margin-top:14px">
        ${chartCard('c-stage', 'Pipeline by stage', 'Expected sales of open opportunities', `<a class="btn sm tv-hide" data-csv="pipeline">CSV</a>`)}
        ${chartCard('c-wl', 'Won and lost per month', 'Number of opportunities closed')}
      </div>
      <div class="grid g2" style="margin-top:14px">
        ${chartCard('c-src', 'Lead sources', 'New leads in the period')}
        ${chartCard('c-lost', 'Why deals were lost', 'Lost opportunities in the period')}
      </div>
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><div class="card-head"><div><h3>Closing in the next 30 days</h3><p>Open opportunities by expected closing date</p></div></div><div class="table-wrap" id="t-closing"></div></div>
        <div class="card"><div class="card-head"><div><h3>Overdue activities</h3><p>Planned CRM activities past their due date</p></div></div><div class="table-wrap" id="t-acts"></div></div>
      </div>
    </section>

    <section class="section" aria-labelledby="h-amc">
      <div class="section-head"><h2 id="h-amc">AMC renewals</h2><span class="sub">Expiry = order ${d.amc.from === 'confirmed' ? 'confirmation' : 'creation'} date + ${d.amc.termMonths} months · not affected by the period filter</span></div>
      <div class="amc-tiles">
        ${tile('Expired, not renewed', `${int(d.amc.overdue)}`, d.amc.overdue ? status('critical', 'Renew or close') : status('good', 'None'))}
        ${tile('Expiring in 30 days', `${int(d.amc.due30)}`, d.amc.due30 ? status('serious', 'Contact customer') : status('good', 'None'))}
        ${tile('Expiring in 31–60 days', `${int(d.amc.due60)}`, d.amc.due60 ? status('warning', 'Plan renewal') : status('good', 'None'))}
        ${tile('Contract value at stake', money(d.amc.valueAtRisk), '<span>expired + expiring, not renewed</span>')}
      </div>
      <div class="card"><div class="card-head"><div><h3>AMC contracts to act on</h3><p>Expired in the last 120 days or expiring in the next 60. "Renewed" = a newer AMC order exists for the same customer.</p></div>
        <div class="tools"><a class="btn sm" data-csv="amc">CSV</a></div></div><div class="table-wrap" id="t-amc"></div></div>
    </section>

    <section class="section" aria-labelledby="h-lic">
      <div class="section-head"><h2 id="h-lic">License renewals</h2><span class="sub">${esc(d.licenses.vendors.join(', '))} · expiry = order ${d.licenses.from === 'created' ? 'creation' : 'confirmation'} date + term · not affected by the period filter</span></div>
      <div class="amc-tiles">
        ${tile('Expired, not renewed', `${int(d.licenses.overdue)}`, d.licenses.overdue ? status('critical', 'Renew now') : status('good', 'None'))}
        ${tile('Expiring in 30 days', `${int(d.licenses.due30)}`, d.licenses.due30 ? status('serious', 'Send renewal quote') : status('good', 'None'))}
        ${tile('Expiring in 31–60 days', `${int(d.licenses.due60)}`, d.licenses.due60 ? status('warning', 'Plan renewal') : status('good', 'None'))}
        ${tile('License value at stake', money(d.licenses.valueAtRisk), `<span>${d.licenses.byVendor.length ? d.licenses.byVendor.map((v) => `${esc(v.name)} ${int(v.count)}`).join(' · ') : 'expired + expiring, not renewed'}</span>`)}
      </div>
      <div class="card"><div class="card-head"><div><h3>Licenses to act on</h3><p>Expired in the last 120 days or expiring in the next 60. Term from the product (e.g. "1 Year", "36 Months", Fortinet SKU "-36"), else 12 months. "Renewed" = a newer license order from the same vendor exists for the same customer.</p></div>
        <div class="tools"><a class="btn sm" data-csv="licenses">CSV</a></div></div><div class="table-wrap" id="t-lic"></div></div>
    </section>`;

  // CSV links carry the current filters
  const s = readState();
  const qp = new URLSearchParams({ from: s.from, to: s.to, compare: s.compare }); for (const kk of ['company', 'team', 'user']) if (s[kk]) qp.set(kk, s[kk]);
  $$('[data-csv]').forEach((a) => { a.href = `/api/export/${a.dataset.csv}.csv?${qp}`; a.setAttribute('download', ''); });

  sparkline($('#spark-rev'), months.map((m) => m.value));

  // revenue by month
  // sales and margin side by side per month (margin only when Odoo has it)
  const salesSeries = [{ key: 'value', name: 'Sales', color: cssVar('--series-1') }, ...(d.hasMargin ? [{ key: 'margin', name: 'Margin', color: cssVar('--series-2') }] : [])];
  const salesLegend = d.hasMargin ? [{ name: 'Sales', color: 'var(--series-1)' }, { name: 'Margin', color: 'var(--series-2)' }] : null;
  const mPct = (r) => (r.margin == null || !r.value ? '–' : pct(r.margin / r.value));
  mountChart('c-rev', (host) => columns(host, {
    rows: months.map((m) => ({ label: monthLabel(m.month), short: MONTHS[Number(m.month.slice(5)) - 1], value: m.value, margin: m.margin,
      tip: [...(m.margin == null ? [] : [{ value: mPct(m), label: 'margin %' }]), { value: int(m.orders), label: 'orders' }, ...(m.lastYear != null ? [{ value: money(m.lastYear), label: 'sales same month last year' }] : [])] })),
    series: salesSeries, fmt: moneyFull, fmtAxis: compact, height: 280, labels: true, line: true, ariaLabel: 'Sales and margin by month, last 12 months',
  }), months, [{ label: 'Month', get: (r) => monthLabel(r.month) }, { label: 'Sales', get: (r) => moneyFull(r.value), num: 1 },
    ...(d.hasMargin ? [{ label: 'Margin', get: (r) => moneyFull(r.margin), num: 1 }, { label: 'Margin %', get: mPct, num: 1 }] : []),
    { label: 'Orders', get: (r) => int(r.orders), num: 1 }, { label: 'Sales same month last year', get: (r) => (r.lastYear == null ? '–' : moneyFull(r.lastYear)), num: 1 }], salesLegend);

  const barRows = (rows, extraTip) => rows.map((r) => ({ label: r.name, value: r.value, other: r.other, tip: extraTip ? extraTip(r) : [] }));
  const empty = (host, msg) => { host.innerHTML = `<div class="empty">${msg}</div>`; };

  const marginPct = (r) => (r.margin == null || !r.value ? '–' : pct(r.margin / r.value));
  mountChart('c-cust', (host) => (d.topCustomers.length ? hbars(host, { rows: barRows(d.topCustomers, (r) => [...(r.margin == null ? [] : [{ value: `${money(r.margin)} (${marginPct(r)})`, label: 'margin' }]), { value: int(r.orders), label: 'orders' }]), color: cssVar('--series-1'), fmt: money, ariaLabel: 'Top customers by sales' }) : empty(host, 'No confirmed orders in this period.')),
    d.topCustomers, [{ label: 'Customer', get: (r) => r.name }, { label: 'Sales', get: (r) => moneyFull(r.value), num: 1 }, { label: 'Margin', get: (r) => moneyFull(r.margin), num: 1 }, { label: 'Margin %', get: marginPct, num: 1 }, { label: 'Orders', get: (r) => int(r.orders), num: 1 }]);


  mountChart('c-stage', (host) => (d.stages.some((s2) => s2.count) ? hbars(host, {
    rows: d.stages.map((s2) => ({ label: s2.name, value: s2.value, tip: [{ value: int(s2.count), label: 'opportunities' }, { value: money(s2.weighted), label: 'weighted' }] })),
    color: cssVar('--series-1'), fmt: money, ariaLabel: 'Open pipeline by stage' }) : empty(host, 'No open opportunities.')),
    d.stages, [{ label: 'Stage', get: (r) => r.name }, { label: 'Opportunities', get: (r) => int(r.count), num: 1 }, { label: 'Expected', get: (r) => moneyFull(r.value), num: 1 }, { label: 'Weighted', get: (r) => moneyFull(r.weighted), num: 1 }]);

  mountChart('c-target', (host) => columns(host, {
    rows: tg.months.map((r) => ({ label: monthLabel(r.month) + (r.future ? ' (planned)' : ''), short: MONTHS[Number(r.month.slice(5)) - 1], target: r.target, achieved: r.future ? 0 : r.achieved,
      tip: [{ value: r.pct == null || r.future ? '–' : pct(r.pct), label: 'of target' }, { value: int(r.count), label: 'opportunities planned' }, { value: int(r.openCount), label: 'still open' }] })),
    series: [{ key: 'target', name: 'Target', color: cssVar('--series-1') }, { key: 'achieved', name: 'Won', color: cssVar('--series-2') }],
    fmt: moneyFull, fmtAxis: compact, height: 250, ariaLabel: 'Monthly target and won sales',
  }), tg.months, [{ label: 'Month', get: (r) => monthLabel(r.month) }, { label: 'Target', get: (r) => moneyFull(r.target), num: 1 }, { label: 'Won', get: (r) => moneyFull(r.achieved), num: 1 },
    { label: 'Achievement', get: (r) => (r.pct == null ? '–' : pct(r.pct)), num: 1 }, { label: 'Still open', get: (r) => moneyFull(r.open), num: 1 }, { label: 'Lost', get: (r) => moneyFull(r.lost), num: 1 }],
  [{ name: 'Target', color: 'var(--series-1)' }, { name: 'Won', color: 'var(--series-2)' }]);

  $('#t-target').innerHTML = targetTable(tg.bySalesperson);

  mountChart('c-wl', (host) => columns(host, {
    rows: d.wonLost.map((m) => ({ label: monthLabel(m.month), short: MONTHS[Number(m.month.slice(5)) - 1], won: m.won, lost: m.lost,
      tip: [{ value: money(m.wonValue), label: 'won value' }, { value: m.won + m.lost ? pct(m.won / (m.won + m.lost)) : '–', label: 'win rate' }] })),
    series: [{ key: 'won', name: 'Won', color: cssVar('--series-1') }, { key: 'lost', name: 'Lost', color: cssVar('--series-2') }],
    fmt: int, fmtAxis: compact, height: 236, ariaLabel: 'Won and lost opportunities per month',
  }), d.wonLost, [{ label: 'Month', get: (r) => monthLabel(r.month) }, { label: 'Won', get: (r) => int(r.won), num: 1 }, { label: 'Lost', get: (r) => int(r.lost), num: 1 }, { label: 'Won value', get: (r) => moneyFull(r.wonValue), num: 1 }],
  [{ name: 'Won', color: 'var(--series-1)' }, { name: 'Lost', color: 'var(--series-2)' }]);

  mountChart('c-src', (host) => (d.sources.length ? hbars(host, {
    rows: d.sources.map((r) => ({ label: r.name, value: r.value, valueLabel: 'new leads', tip: [{ value: int(r.won), label: 'won so far' }, { value: r.value ? pct(r.won / r.value) : '–', label: 'converted' }] })),
    color: cssVar('--series-1'), fmt: int, ariaLabel: 'New leads by source' }) : empty(host, 'No new leads in this period.')),
    d.sources, [{ label: 'Source', get: (r) => r.name }, { label: 'New leads', get: (r) => int(r.value), num: 1 }, { label: 'Won so far', get: (r) => int(r.won), num: 1 }]);

  mountChart('c-lost', (host) => (d.lostReasons.length ? hbars(host, {
    rows: d.lostReasons.map((r) => ({ label: r.name, value: r.value, valueLabel: 'lost', tip: [{ value: money(r.amount), label: 'expected sales lost' }] })),
    color: cssVar('--series-1'), fmt: int, ariaLabel: 'Lost opportunities by reason' }) : empty(host, 'No lost opportunities in this period.')),
    d.lostReasons, [{ label: 'Reason', get: (r) => r.name }, { label: 'Lost', get: (r) => int(r.value), num: 1 }, { label: 'Expected sales', get: (r) => moneyFull(r.amount), num: 1 }]);

  // salespeople leaderboard
  const maxRev = Math.max(1, ...d.salespeople.map((x) => x.revenue));
  $('#t-people').innerHTML = d.salespeople.length ? `<table><thead><tr><th>Salesperson</th><th class="num">Sales</th><th class="bar-cell hide-sm"></th><th class="num">Orders</th><th class="num hide-sm">Won</th><th class="num">Win rate</th><th class="num hide-sm">Pipeline</th></tr></thead><tbody>
    ${d.salespeople.map((x) => `<tr><td class="name">${esc(x.name)}${x.overdue ? `<br><small>${x.overdue} overdue activit${x.overdue > 1 ? 'ies' : 'y'}</small>` : ''}</td>
      <td class="num">${money(x.revenue)}</td><td class="bar-cell hide-sm"><div class="inline-bar" style="width:${(x.revenue / maxRev) * 100}%"></div></td>
      <td class="num">${int(x.orders)}</td><td class="num hide-sm">${int(x.won)}</td><td class="num">${pct(x.winRate)}</td><td class="num hide-sm">${money(x.pipeline)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No activity in this period.</div>';

  $('#t-closing').innerHTML = d.closingSoon.length ? `<table><thead><tr><th>Opportunity</th><th class="hide-sm">Stage</th><th class="num">Expected</th><th>Closing</th></tr></thead><tbody>
    ${d.closingSoon.map((x) => `<tr><td>${odooLink('crm.lead', x.id, x.name)}<br><small>${esc(x.partner)} · ${esc(x.user)}</small></td><td class="hide-sm">${esc(x.stage)}<br><small>${x.probability}%</small></td>
      <td class="num">${money(x.expected)}</td><td>${x.late ? status('serious', dmy(x.deadline)) : esc(dmy(x.deadline))}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">Nothing expected to close in the next 30 days.</div>';

  $('#t-acts').innerHTML = d.overdueActivities.length ? `<table><thead><tr><th>Activity</th><th>Owner</th><th class="num">Late</th></tr></thead><tbody>
    ${d.overdueActivities.map((x) => `<tr><td>${esc(x.summary)}<br><small>${odooLink('crm.lead', x.leadId, x.lead)}</small></td><td>${esc(x.user)}</td>
      <td class="num">${status(x.daysLate > 7 ? 'critical' : 'serious', `${x.daysLate} day${x.daysLate === 1 ? '' : 's'}`)}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">${status('good', 'No overdue activities')}</div>`;

  const amcState = (r) => r.renewedBy ? status('good', `Renewed (${r.renewedBy})`)
    : r.daysLeft < 0 ? status('critical', `Expired ${-r.daysLeft} day${r.daysLeft === -1 ? '' : 's'} ago`)
    : r.daysLeft <= 30 ? status('serious', r.daysLeft === 0 ? 'Expires today' : `${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} left`)
    : status('warning', `${r.daysLeft} days left`);
  $('#t-amc').innerHTML = d.amc.rows.length ? `<table><thead><tr><th>Order</th><th>Customer</th><th class="hide-sm">Salesperson</th><th class="hide-sm">Started</th><th>Expires</th><th class="num">Value</th><th>Status</th></tr></thead><tbody>
    ${d.amc.rows.map((r) => `<tr><td class="mono">${odooLink('sale.order', r.id, r.name)}</td><td class="name">${esc(r.partner)}</td><td class="hide-sm">${esc(r.user)}</td>
      <td class="hide-sm">${dmy(r.start)}</td><td>${dmy(r.expiry)}</td><td class="num">${moneyFull(r.amount)}</td><td>${amcState(r)}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">No AMC contracts expiring in the next 60 days. AMC orders are found by the tag or product name containing "AMC" (${int(d.amc.totalActive)} found).</div>`;

  const years = (m) => (m % 12 ? `${m} months` : `${m / 12} year${m === 12 ? '' : 's'}`);
  $('#t-lic').innerHTML = d.licenses.rows.length ? `<table><thead><tr><th>Order</th><th>Customer</th><th>License</th><th class="hide-sm">Salesperson</th><th>Expires</th><th class="num">Value</th><th>Status</th></tr></thead><tbody>
    ${d.licenses.rows.map((r) => `<tr><td class="mono">${odooLink('sale.order', r.id, r.name)}</td><td class="name">${esc(r.partner)}</td>
      <td><b>${esc(r.vendor)}</b> · ${years(r.termMonths)}<br><small>${r.products.map(esc).join('<br>')}</small></td><td class="hide-sm">${esc(r.user)}</td>
      <td>${dmy(r.expiry)}</td><td class="num">${moneyFull(r.amount)}</td><td>${amcState(r)}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">No licenses expiring in the next 60 days. License lines are found by vendor name (${esc(d.licenses.vendors.join(', '))}) plus a word like license, subscription or "1 Year" (${int(d.licenses.totalLines)} found).</div>`;
}

// ---------- revenue details (opened from the Revenue / Margin / Orders tiles) ----------
const INVOICE = { 'to invoice': ['serious', 'To invoice'], invoiced: ['good', 'Invoiced'], upselling: ['warning', 'Upsell'], no: ['neutral', 'Nothing to invoice'] };
function renderDetail() {
  const d = DETAIL, t = d.total;
  charts.length = 0; lastView = 'revenue';
  const src = $('#src');
  src.textContent = (META.source === 'demo' ? 'Demo data' : 'Live from Odoo') + ' · updated ' + ago(d.fetchedAt);
  const mp = (r) => (r.margin == null || !(r.value ?? r.amount) ? '–' : pct(r.margin / (r.value ?? r.amount)));
  const s = readState();
  const qp = new URLSearchParams({ from: s.from, to: s.to, range: d.range }); for (const kk of ['company', 'team', 'user']) if (s[kk]) qp.set(kk, s[kk]);
  // breakdown table: name, revenue (with bar), margin, margin %, orders
  const breakdown = (rows, label, limit) => breakdownTable(rows, label, limit, { margin: d.hasMargin });

  $('#main').innerHTML = `
    <div class="detail-top">
      <a class="btn" href="${hashOf({ ...s, view: '' })}">← Dashboard</a>
      <div class="seg" role="group" aria-label="Date range">
        <a class="btn sm ${d.range === 'period' ? 'on' : ''}" href="${detailHref('period')}" aria-pressed="${d.range === 'period'}">Selected period</a>
        <a class="btn sm ${d.range === 'ytd' ? 'on' : ''}" href="${detailHref('ytd')}" aria-pressed="${d.range === 'ytd'}">Year to date</a>
      </div>
    </div>
    <section class="section" style="margin-top:16px" aria-labelledby="h-det">
      <div class="section-head"><h2 id="h-det">Sales details</h2><span class="sub">${dmy(d.from)} – ${dmy(d.to)} · confirmed sales orders by order date · ${esc(d.currency.name)}, excl. tax</span></div>
      <div class="tiles detail">
        ${tile('Sales', `<span title="${moneyFull(t.revenue)}">${money(t.revenue)}</span>`, `<span>${int(t.orders)} orders</span>`)}
        ${tile('Margin', t.margin == null ? '–' : `<span title="${moneyFull(t.margin)}">${money(t.margin)}</span>`, t.margin == null ? '<span>needs the Sales Margin module in Odoo</span>' : `<span>${t.revenue ? pct(t.margin / t.revenue) : '–'} of sales</span>`)}
        ${tile('Orders', int(t.orders), `<span>${int(t.customers)} customers</span>`)}
        ${tile('Average order', money(t.orders ? t.revenue / t.orders : null), '<span>sales per order</span>')}
      </div>
      <div class="grid g-wide" style="margin-top:14px">
        ${chartCard('c-det-month', 'Sales by month', `${monthLabel(d.byMonth[0].month)} – ${monthLabel(d.byMonth[d.byMonth.length - 1].month)}`)}
        <div class="card"><div class="card-head"><div><h3>By salesperson</h3></div></div><div class="table-wrap">${breakdown(d.bySalesperson, 'Salesperson', 12)}</div></div>
      </div>
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><div class="card-head"><div><h3>By customer</h3><p>Top 10</p></div></div><div class="table-wrap">${breakdown(d.byCustomer, 'Customer', 10)}</div></div>
        <div class="card"><div class="card-head"><div><h3>By sales team</h3></div></div><div class="table-wrap">${breakdown(d.byTeam, 'Team', 10)}</div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-head"><div><h3>Orders</h3><p id="o-count"></p></div>
          <div class="tools"><input type="search" id="o-q" class="search" placeholder="Search order, customer, salesperson" aria-label="Search orders"><a class="btn sm" href="/api/export/orders.csv?${qp}" download>CSV</a></div></div>
        <div class="table-wrap" id="t-orders"></div>
      </div>
    </section>`;

  mountChart('c-det-month', (host) => columns(host, {
    rows: d.byMonth.map((m) => ({ label: monthLabel(m.month), short: MONTHS[Number(m.month.slice(5)) - 1], value: m.value, margin: m.margin,
      tip: [...(m.margin == null ? [] : [{ value: mp(m), label: 'margin %' }]), { value: int(m.orders), label: 'orders' }] })),
    series: [{ key: 'value', name: 'Sales', color: cssVar('--series-1') }, ...(d.hasMargin ? [{ key: 'margin', name: 'Margin', color: cssVar('--series-2') }] : [])], fmt: moneyFull, fmtAxis: compact, height: 260,
    labels: d.byMonth.length <= 18, line: d.byMonth.length > 1, ariaLabel: 'Sales by month',
  }), d.byMonth, [{ label: 'Month', get: (r) => monthLabel(r.month) }, { label: 'Sales', get: (r) => moneyFull(r.value), num: 1 },
    ...(d.hasMargin ? [{ label: 'Margin', get: (r) => moneyFull(r.margin), num: 1 }, { label: 'Margin %', get: mp, num: 1 }] : []), { label: 'Orders', get: (r) => int(r.orders), num: 1 }],
  d.hasMargin ? [{ name: 'Sales', color: 'var(--series-1)' }, { name: 'Margin', color: 'var(--series-2)' }] : null);

  // order list: search, sort by any column, 100 rows at a time
  const cols = [
    ['name', 'Order'], ['date', 'Date'], ['partner', 'Customer'], ['user', 'Salesperson', 'hide-sm'], ['amount', 'Sales', 'num'],
    ...(d.hasMargin ? [['margin', 'Margin', 'num'], ['pct', 'Margin %', 'num hide-sm']] : []), ['invoiceStatus', 'Invoice', 'hide-sm'],
  ];
  const val = (r, k) => (k === 'pct' ? (r.amount ? r.margin / r.amount : -Infinity) : r[k]);
  let sortKey = 'date', dir = -1, shown = 100;
  const draw = () => {
    const q = $('#o-q').value.trim().toLowerCase();
    const rows = d.orders.filter((r) => !q || `${r.name} ${r.partner} ${r.user} ${r.team}`.toLowerCase().includes(q))
      .sort((a, b) => { const x = val(a, sortKey), y = val(b, sortKey); return (typeof x === 'string' ? x.localeCompare(y) : (x ?? 0) - (y ?? 0)) * dir; });
    $('#o-count').textContent = `${int(rows.length)} order${rows.length === 1 ? '' : 's'} · ${moneyFull(rows.reduce((a, r) => a + r.amount, 0))}`;
    $('#t-orders').innerHTML = rows.length ? `<table><thead><tr>${cols.map(([k, l, c = '']) => `<th class="${c}"><button class="sort" data-k="${k}" aria-sort="${sortKey === k ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${sortKey === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead><tbody>
      ${rows.slice(0, shown).map((r) => `<tr><td class="mono">${odooLink('sale.order', r.id, r.name)}</td><td>${dmy(r.date)}</td><td class="name">${esc(r.partner)}</td><td class="hide-sm">${esc(r.user)}</td>
        <td class="num">${moneyFull(r.amount)}</td>${d.hasMargin ? `<td class="num">${moneyFull(r.margin)}</td><td class="num hide-sm">${r.amount ? pct(r.margin / r.amount) : '–'}</td>` : ''}
        <td class="hide-sm">${INVOICE[r.invoiceStatus] ? status(...INVOICE[r.invoiceStatus]) : esc(r.invoiceStatus || '')}</td></tr>`).join('')}</tbody></table>
      ${rows.length > shown ? `<div style="text-align:center;padding:12px"><button class="btn sm" id="o-more">Show ${int(Math.min(100, rows.length - shown))} more of ${int(rows.length - shown)}</button></div>` : ''}`
      : '<div class="empty">No orders match.</div>';
    $$('#t-orders .sort').forEach((b) => { b.onclick = () => { const k = b.dataset.k; dir = sortKey === k ? -dir : (k === 'name' || k === 'partner' || k === 'user' || k === 'invoiceStatus' ? 1 : -1); sortKey = k; draw(); }; });
    const more = $('#o-more'); if (more) more.onclick = () => { shown += 100; draw(); };
  };
  $('#o-q').oninput = () => { shown = 100; draw(); };
  draw();
}

// ---------- shared pieces of the details screens ----------
function setSrc(at) {
  const src = $('#src');
  src.textContent = (META.source === 'demo' ? 'Demo data' : 'Live from Odoo') + ' · updated ' + ago(at);
  src.title = new Date(at).toLocaleString();
}
const filterQuery = (extra = {}) => {
  const s = readState(); const q = new URLSearchParams({ from: s.from, to: s.to, ...extra });
  for (const k of ['company', 'team', 'user']) if (s[k]) q.set(k, s[k]);
  return q;
};
const backBar = (right = '') => `<div class="detail-top"><a class="btn" href="${hashOf({ ...readState(), view: '' })}">← Dashboard</a>${right}</div>`;

// breakdown table: name, value (with bar), optional margin + %, count
function breakdownTable(rows, label, limit, { margin = false, valueLabel = 'Sales', countLabel = 'Orders', more = 'in the order list below' } = {}) {
  if (!rows.length) return '<div class="empty">Nothing here.</div>';
  const max = Math.max(1, ...rows.map((r) => r.value));
  const mp = (r) => (r.margin == null || !r.value ? '–' : pct(r.margin / r.value));
  return `<table><thead><tr><th>${label}</th><th class="num">${valueLabel}</th><th class="bar-cell hide-sm"></th>${margin ? '<th class="num">Margin</th><th class="num">%</th>' : ''}<th class="num">${countLabel}</th></tr></thead><tbody>
    ${rows.slice(0, limit).map((r) => `<tr><td class="name">${esc(r.name)}</td><td class="num">${money(r.value)}</td><td class="bar-cell hide-sm"><div class="inline-bar" style="width:${(r.value / max) * 100}%"></div></td>
      ${margin ? `<td class="num">${money(r.margin)}</td><td class="num">${mp(r)}</td>` : ''}<td class="num">${int(r.orders)}</td></tr>`).join('')}</tbody></table>
    ${rows.length > limit ? `<p class="muted" style="margin:8px 8px 0;font-size:12px">+ ${rows.length - limit} more ${more}</p>` : ''}`;
}

// target by salesperson (dashboard and target screen); each name opens that person's target details
const achieved = (r) => (r.pct == null ? status('neutral', 'No target') : r.pct >= 1 ? status('good', pct(r.pct)) : r.pct >= 0.7 ? status('warning', pct(r.pct)) : status('critical', pct(r.pct)));
function targetTable(rows) {
  if (!rows.length) return '<div class="empty">No opportunities with an Expected Closing date in this period.</div>';
  return `<table><thead><tr><th>Salesperson</th><th class="num">Target</th><th class="num">Won</th><th class="bar-cell hide-sm"></th><th>Achievement</th><th class="num hide-sm">Still open</th><th class="num hide-sm">Lost</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="name">${r.id ? `<a href="${viewHref('target', { user: String(r.id) })}" title="Show ${esc(r.name)}'s opportunities">${esc(r.name)}</a>` : esc(r.name)}<br><small>${int(r.count)} planned${r.lateCount ? ` · ${int(r.lateCount)} past date` : ''}</small></td>
      <td class="num">${money(r.target)}</td><td class="num">${money(r.achieved)}</td>
      <td class="bar-cell hide-sm"><div class="meter"><i style="width:${Math.min(100, (r.pct || 0) * 100)}%"></i></div></td><td>${achieved(r)}</td>
      <td class="num hide-sm">${money(r.open)}</td><td class="num hide-sm">${money(r.lost)}</td></tr>`).join('')}</tbody></table>`;
}

/**
 * Searchable, sortable list, 100 rows at a time. cols: [{ k, label, cls, html(r), sort(r) }].
 * Optional chips (filter buttons by r.tags) and expand(r) → html shown under a row when it's clicked.
 */
function listTable({ host, count, input, chips, rows, cols, sortKey, dir = -1, noun, total, match, expand, filter = 'all' }) {
  let shown = 100;
  const opened = new Set();
  const cmp = (x, y) => (x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : typeof x === 'string' ? x.localeCompare(y) * dir : (x - y) * dir);
  const draw = () => {
    const q = input ? input.value.trim().toLowerCase() : '';
    const col = cols.find((c) => c.k === sortKey);
    const list = rows.filter((r) => (!q || match(r).toLowerCase().includes(q)) && (filter === 'all' || (r.tags || []).includes(filter)))
      .sort((a, b) => cmp(col.sort(a), col.sort(b)));
    const [one, many] = Array.isArray(noun) ? noun : [noun, noun + 's'];
    if (count) count.textContent = `${int(list.length)} ${list.length === 1 ? one : many}${total ? ' · ' + moneyFull(list.reduce((a, r) => a + (total(r) || 0), 0)) : ''}`;
    host.innerHTML = list.length ? `<table class="${expand ? 'expandable' : ''}"><thead><tr>${expand ? '<th class="exp"></th>' : ''}${cols.map((c) => `<th class="${c.cls || ''}"><button class="sort" data-k="${c.k}" aria-sort="${sortKey === c.k ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.label}${sortKey === c.k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead><tbody>
      ${list.slice(0, shown).map((r, i) => `<tr${expand ? ` class="row" data-i="${rows.indexOf(r)}" aria-expanded="${opened.has(r)}"` : ''}>${expand ? `<td class="exp"><button class="twisty" aria-label="${opened.has(r) ? 'Hide' : 'Show'} lines"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button></td>` : ''}${cols.map((c) => `<td class="${c.cls || ''}">${c.html(r)}</td>`).join('')}</tr>
        ${expand && opened.has(r) ? `<tr class="sub"><td></td><td colspan="${cols.length}">${expand(r)}</td></tr>` : ''}`).join('')}</tbody></table>
      ${list.length > shown ? `<div style="text-align:center;padding:12px"><button class="btn sm more">Show ${int(Math.min(100, list.length - shown))} more of ${int(list.length - shown)}</button></div>` : ''}`
      : '<div class="empty">Nothing matches.</div>';
    host.querySelectorAll('.sort').forEach((b) => { b.onclick = () => { const k = b.dataset.k; dir = sortKey === k ? -dir : (cols.find((c) => c.k === k).asc ? 1 : -1); sortKey = k; draw(); }; });
    const more = host.querySelector('.more'); if (more) more.onclick = () => { shown += 100; draw(); };
    if (expand) host.querySelectorAll('tr.row').forEach((tr) => { tr.onclick = (e) => { if (e.target.closest('a')) return; const r = rows[tr.dataset.i]; opened.has(r) ? opened.delete(r) : opened.add(r); draw(); }; });
  };
  if (input) input.oninput = () => { shown = 100; draw(); };
  if (chips) chips.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { filter = b.dataset.f; chips.querySelectorAll('[data-f]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); }); shown = 100; draw(); }; });
  draw();
}
const qty = (v) => (v == null ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const soLinks = (orders) => (orders.length ? orders.map((o) => `<span class="nowrap">${odooLink('sale.order', o.id, o.name)} <small>${dmy(o.date)} · ${money(o.amount)}${o.state === 'quote' ? ' · quotation' : ''}</small></span>`).join('<br>') : '<span class="muted">–</span>');

// ---------- to invoice (opened from the "To invoice" tile) ----------
function renderInvoice() {
  const d = DETAIL, t = d.total;
  charts.length = 0; lastView = 'invoice'; setSrc(d.fetchedAt);
  const ageChip = (a) => status(a > 90 ? 'critical' : a > 60 ? 'serious' : a > 30 ? 'warning' : 'neutral', `${int(a)} day${a === 1 ? '' : 's'}`);
  $('#main').innerHTML = `${backBar()}
    <section class="section" style="margin-top:16px" aria-labelledby="h-inv">
      <div class="section-head"><h2 id="h-inv">To invoice</h2><span class="sub">Confirmed sales orders Odoo marks "To invoice", ordered since ${dmy(d.from)} · ${esc(d.currency.name)}, excl. tax</span></div>
      ${d.older.count ? `<div class="banner">${int(d.older.count)} order${d.older.count === 1 ? '' : 's'} from before ${dmy(d.from)} (${moneyFull(d.older.toInvoice)}) still show as "To invoice" in Odoo. They're left out of the totals; pick <b>Before ${dmy(d.from)}</b> below to check them.</div>` : ''}
      <div class="tiles detail">
        ${tile('Still to invoice', `<span title="${moneyFull(t.toInvoice)}">${money(t.toInvoice)}</span>`, `<span>${d.hasAmounts ? 'untaxed amount left on the lines' : 'order totals'}</span>`)}
        ${tile('Orders', int(t.orders), '<span>waiting for an invoice</span>')}
        ${tile('Over 60 days old', money(t.over60), t.over60Count ? status('serious', `${int(t.over60Count)} order${t.over60Count === 1 ? '' : 's'}`) : status('good', 'None'))}
        ${tile('Oldest order', t.oldest == null ? '–' : `${int(t.oldest)}<small>days</small>`, '<span>since the order date</span>')}
      </div>
      <div class="grid g3" style="margin-top:14px">
        <div class="card"><div class="card-head"><div><h3>By age</h3><p>Days since the order date</p></div></div><div class="table-wrap">${breakdownTable(d.ages.filter((a) => a.orders), 'Age', 10, { valueLabel: 'To invoice' })}</div></div>
        <div class="card"><div class="card-head"><div><h3>By salesperson</h3></div></div><div class="table-wrap">${breakdownTable(d.bySalesperson, 'Salesperson', 10, { valueLabel: 'To invoice' })}</div></div>
        <div class="card"><div class="card-head"><div><h3>By customer</h3><p>Top 10</p></div></div><div class="table-wrap">${breakdownTable(d.byCustomer, 'Customer', 10, { valueLabel: 'To invoice' })}</div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-head"><div><h3>Orders to invoice</h3><p><span id="o-count"></span> · click an order to see its lines</p></div>
          <div class="tools"><input type="search" id="o-q" class="search" placeholder="Search order, customer, salesperson" aria-label="Search orders"><a class="btn sm" id="o-csv" href="/api/export/to-invoice.csv?${filterQuery()}" download>CSV</a></div></div>
        ${d.older.count ? `<div class="seg chips" id="o-chips" role="group" aria-label="Order date"><button class="btn sm on" data-f="current" aria-pressed="true">Since ${dmy(d.from)} <small>${int(d.total.orders)}</small></button><button class="btn sm" data-f="older" aria-pressed="false">Before ${dmy(d.from)} <small>${int(d.older.count)}</small></button></div>` : ''}
        <div class="table-wrap" id="t-orders"></div>
      </div>
    </section>`;
  for (const r of d.orders) r.tags = [r.older ? 'older' : 'current'];
  const chips = $('#o-chips');
  if (chips) chips.addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (b) $('#o-csv').href = `/api/export/to-invoice.csv?${filterQuery(b.dataset.f === 'older' ? { older: '1' } : {})}`; });
  listTable({
    host: $('#t-orders'), count: $('#o-count'), input: $('#o-q'), rows: d.orders, chips, filter: 'current', noun: 'order', total: (r) => r.toInvoice, sortKey: 'age', dir: -1,
    match: (r) => `${r.name} ${r.partner} ${r.user} ${r.team}`,
    cols: [
      { k: 'name', label: 'Order', cls: 'mono', asc: 1, html: (r) => odooLink('sale.order', r.id, r.name), sort: (r) => r.name },
      { k: 'date', label: 'Order date', html: (r) => dmy(r.date), sort: (r) => r.date },
      { k: 'age', label: 'Age', html: (r) => ageChip(r.age), sort: (r) => r.age },
      { k: 'partner', label: 'Customer', cls: 'name', asc: 1, html: (r) => esc(r.partner), sort: (r) => r.partner },
      { k: 'user', label: 'Salesperson', cls: 'hide-sm', asc: 1, html: (r) => esc(r.user), sort: (r) => r.user },
      { k: 'amount', label: 'Order total', cls: 'num hide-sm', html: (r) => moneyFull(r.amount), sort: (r) => r.amount },
      ...(d.hasAmounts ? [{ k: 'invoiced', label: 'Invoiced', cls: 'num hide-sm', html: (r) => moneyFull(r.invoiced), sort: (r) => r.invoiced }] : []),
      { k: 'toInvoice', label: 'To invoice', cls: 'num', html: (r) => `<b>${moneyFull(r.toInvoice)}</b>`, sort: (r) => r.toInvoice },
    ],
    expand: (r) => (r.lines.length ? `<table class="lines"><thead><tr><th>Product</th><th class="num">Ordered</th><th class="num">Delivered</th><th class="num">Invoiced</th><th class="num">To invoice</th>${d.hasAmounts ? '<th class="num">Amount</th>' : ''}</tr></thead><tbody>
      ${r.lines.map((l) => `<tr><td>${esc(l.product)}</td><td class="num">${qty(l.qty)}</td><td class="num">${qty(l.delivered)}</td><td class="num">${qty(l.invoiced)}</td><td class="num"><b>${qty(l.toInvoiceQty)}</b></td>${d.hasAmounts ? `<td class="num">${moneyFull(l.toInvoice)}</td>` : ''}</tr>`).join('')}</tbody></table>`
      : '<span class="muted">No line details from Odoo.</span>'),
  });
}

// ---------- target details (opened from the Target card / Target by salesperson) ----------
const STATUS = { won: ['good', 'Won'], lost: ['critical', 'Lost'], open: ['neutral', 'Open'], late: ['serious', 'Past expected date'] };
function renderTarget() {
  const d = DETAIL, t = d.total;
  charts.length = 0; lastView = 'target'; setSrc(d.fetchedAt);
  const s = readState(), who = s.user ? META.users.find((u) => String(u.id) === s.user)?.name : '';
  for (const r of [...d.planned, ...d.unplanned]) r.tags = r.status === 'late' ? ['open', 'late'] : [r.status];
  const n = (st) => d.planned.filter((r) => r.tags.includes(st)).length;
  const oppCols = (dateCol) => [
    { k: 'name', label: 'Opportunity', asc: 1, html: (r) => `${odooLink('crm.lead', r.id, r.name)}<br><small>${esc(r.partner || '–')}</small>`, sort: (r) => r.name },
    { k: 'user', label: 'Salesperson', cls: 'hide-sm', asc: 1, html: (r) => esc(r.user), sort: (r) => r.user },
    { k: 'stage', label: 'Stage', cls: 'hide-sm', asc: 1, html: (r) => `${esc(r.stage || '–')}<br><small>${int(r.probability)}%</small>`, sort: (r) => r.probability },
    dateCol,
    { k: 'expected', label: 'Expected sales', cls: 'num', html: (r) => moneyFull(r.expected), sort: (r) => r.expected },
    { k: 'status', label: 'Status', asc: 1, html: (r) => status(...STATUS[r.status]), sort: (r) => ['late', 'open', 'won', 'lost'].indexOf(r.status) },
    ...(d.hasOrders ? [{ k: 'so', label: 'Sales orders', html: (r) => soLinks(r.orders), sort: (r) => (r.orders[0] ? r.orders[0].name : null) }] : []),
    { k: 'created', label: 'Created', cls: 'hide-sm', html: (r) => dmy(r.created), sort: (r) => r.created },
  ];
  const deadlineCol = { k: 'deadline', label: 'Expected closing', asc: 1, html: (r) => (r.status === 'late' ? `<b class="late">${dmy(r.deadline)}</b>` : dmy(r.deadline)), sort: (r) => r.deadline };
  const chip = (f, label, c) => `<button class="btn sm ${f === 'all' ? 'on' : ''}" data-f="${f}" aria-pressed="${f === 'all'}">${label} <small>${int(c)}</small></button>`;

  $('#main').innerHTML = `${backBar(who ? `<a class="btn sm" href="${viewHref('target', { user: '' })}">Show everyone</a>` : '')}
    <section class="section" style="margin-top:16px" aria-labelledby="h-tg">
      <div class="section-head"><h2 id="h-tg">Target details${who ? ' · ' + esc(who) : ''}</h2><span class="sub">${dmy(d.from)} – ${dmy(d.to)} · opportunities with their Expected Closing date in the period · ${esc(d.currency.name)}</span></div>
      <div class="tiles detail five">
        ${tile('Target', `<span title="${moneyFull(t.target)}">${money(t.target)}</span>`, `<span>${int(t.count)} opportunities planned</span>`)}
        ${tile('Won', money(t.achieved), `<span>${int(t.wonCount)} deal${t.wonCount === 1 ? '' : 's'} won in the period</span>`)}
        ${tile('Achievement', t.pct == null ? '–' : pct(t.pct), t.pct == null ? '<span>no target</span>' : t.pct >= 1 ? status('good', 'Target met') : t.pct >= 0.7 ? status('warning', 'Close') : status('critical', 'Behind'))}
        ${tile('Still open', money(t.open), t.lateCount ? status('serious', `${int(t.lateCount)} past date`) : `<span>${int(t.openCount)} open</span>`)}
        ${tile('Lost', money(t.lost), `<span>${int(t.lostCount)} planned but lost</span>`)}
      </div>
      ${who ? '' : `<div class="card" style="margin-top:14px"><div class="card-head"><div><h3>By salesperson</h3><p>Click a name to see only their opportunities</p></div></div><div class="table-wrap">${targetTable(d.bySalesperson)}</div></div>`}
      <div class="card" style="margin-top:14px">
        <div class="card-head"><div><h3>Planned opportunities</h3><p id="p-count"></p></div>
          <div class="tools"><input type="search" id="p-q" class="search" placeholder="Search opportunity, customer, SO number" aria-label="Search opportunities"><a class="btn sm" href="/api/export/opportunities.csv?${filterQuery()}" download>CSV</a></div></div>
        <div class="seg chips" id="p-chips" role="group" aria-label="Status">${chip('all', 'All', d.planned.length)}${chip('won', 'Won', n('won'))}${chip('open', 'Open', n('open'))}${chip('late', 'Past date', n('late'))}${chip('lost', 'Lost', n('lost'))}</div>
        <div class="table-wrap" id="t-planned"></div>
      </div>
      ${d.unplanned.length ? `<div class="card" style="margin-top:14px"><div class="card-head"><div><h3>Won outside the target</h3><p>Won in the period but not planned for it (Expected Closing date in another month) · ${int(d.unplanned.length)} · ${moneyFull(d.unplanned.reduce((a, r) => a + r.expected, 0))}</p></div></div>
        <div class="table-wrap" id="t-unplanned"></div></div>` : ''}
    </section>`;
  const match = (r) => `${r.name} ${r.partner} ${r.user} ${r.stage} ${r.orders.map((o) => o.name).join(' ')}`;
  listTable({ host: $('#t-planned'), count: $('#p-count'), input: $('#p-q'), chips: $('#p-chips'), rows: d.planned, noun: ['opportunity', 'opportunities'], total: (r) => r.expected,
    sortKey: 'deadline', dir: 1, match, cols: oppCols(deadlineCol) });
  if (d.unplanned.length) listTable({ host: $('#t-unplanned'), rows: d.unplanned, sortKey: 'closed', dir: -1, match,
    cols: oppCols({ k: 'closed', label: 'Won on', html: (r) => `${dmy(r.closed)}<br><small>planned ${dmy(r.deadline)}</small>`, sort: (r) => r.closed }) });
}

// ---------- invoices & statements of account (opened from the receivables tiles) ----------
const soaHref = (ids, print = false) => {
  const s = readState(), q = new URLSearchParams({ partner: [].concat(ids).join(','), back: hashOf(s).slice(1) });
  if (s.company) q.set('company', s.company); if (print) q.set('print', '1');
  return '/statement.html?' + q;
};
function renderReceivables() {
  const d = DETAIL;
  charts.length = 0; lastView = 'invoices'; setSrc(d.fetchedAt);
  if (!d.available) { $('#main').innerHTML = `${backBar()}<div class="card" style="margin-top:16px"><div class="empty">${d.error ? `Odoo didn't allow reading invoices: ${esc(d.error)}. Give the dashboard's Odoo user read access to Invoicing (e.g. the "Billing" role).` : 'Invoices are not available in this Odoo database.'}</div></div>`; return; }
  const t = d.total;
  const odChip = (n) => (n > 0 ? status(n > 90 ? 'critical' : n > 30 ? 'serious' : 'warning', `${int(n)} day${n === 1 ? '' : 's'}`) : '<span class="muted">–</span>');
  const amount = (v) => (v < 0 ? `<span class="muted">${moneyFull(v)}</span>` : moneyFull(v));
  const invLink = (r) => `${odooLink('account.move', r.id, r.name)}${r.type === 'refund' ? ' <small>credit note</small>' : ''}`;
  $('#main').innerHTML = `${backBar()}
    <section class="section" style="margin-top:16px" aria-labelledby="h-rec">
      <div class="section-head"><h2 id="h-rec">Invoices & receivables</h2><span class="sub">Posted customer invoices and credit notes not fully paid, as of ${dmy(d.today)} · ${esc(d.currency.name)}, incl. VAT</span></div>
      <div class="tiles detail">
        ${tile('Outstanding', `<span title="${moneyFull(t.outstanding)}">${money(t.outstanding)}</span>`, `<span>${int(t.invoices)} invoices · ${int(t.customers)} customers</span>`)}
        ${tile('Overdue', money(t.overdue), t.overdueCount ? status('critical', `${int(t.overdueCount)} invoice${t.overdueCount === 1 ? '' : 's'}`) : status('good', 'None'))}
        ${tile('Due in the next 30 days', money(t.due30), '<span>not overdue yet</span>')}
        ${tile('Customers with a balance', int(d.customers.length), `<span>${int(d.customers.filter((c) => c.overdue > 0).length)} with overdue invoices</span>`)}
      </div>
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><div class="card-head"><div><h3>By age</h3><p>Days past the due date</p></div></div><div class="table-wrap">${breakdownTable(d.ages, 'Age', 10, { valueLabel: 'Outstanding', countLabel: 'Invoices' })}</div></div>
        <div class="card"><div class="card-head"><div><h3>By salesperson</h3></div></div><div class="table-wrap">${breakdownTable(d.bySalesperson, 'Salesperson', 10, { valueLabel: 'Outstanding', countLabel: 'Invoices', more: 'in the lists below' })}</div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-head"><div><h3>Statements of account</h3><p><span id="c-count"></span> · click a customer to see their invoices</p></div>
          <div class="tools"><input type="search" id="c-q" class="search" placeholder="Search customer" aria-label="Search customers">
            <a class="btn sm" id="soa-overdue" target="_blank" rel="noopener" title="One page per customer with overdue invoices">Print all overdue</a></div></div>
        <div class="table-wrap" id="t-cust"></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-head"><div><h3>Open invoices</h3><p id="i-count"></p></div>
          <div class="tools"><input type="search" id="i-q" class="search" placeholder="Search invoice, customer, order ref." aria-label="Search invoices"><a class="btn sm" href="/api/export/receivables.csv?${filterQuery()}" download>CSV</a></div></div>
        <div class="seg chips" id="i-chips" role="group" aria-label="Status"><button class="btn sm on" data-f="all" aria-pressed="true">All</button><button class="btn sm" data-f="overdue" aria-pressed="false">Overdue <small>${int(t.overdueCount)}</small></button><button class="btn sm" data-f="notdue" aria-pressed="false">Not due yet</button></div>
        <div class="table-wrap" id="t-inv"></div>
      </div>
    </section>`;
  const od = d.customers.filter((c) => c.overdue > 0).map((c) => c.id);
  const all = $('#soa-overdue');
  if (od.length) all.href = soaHref(od, true); else { all.removeAttribute('href'); all.classList.add('disabled'); all.title = 'No overdue invoices'; }
  listTable({
    host: $('#t-cust'), count: $('#c-count'), input: $('#c-q'), rows: d.customers, noun: 'customer', total: (r) => r.outstanding, sortKey: 'outstanding', dir: -1,
    match: (r) => `${r.name} ${r.invoices.map((i) => `${i.name} ${i.ref}`).join(' ')}`,
    cols: [
      { k: 'name', label: 'Customer', cls: 'name', asc: 1, html: (r) => esc(r.name), sort: (r) => r.name },
      { k: 'count', label: 'Invoices', cls: 'num', html: (r) => int(r.count), sort: (r) => r.count },
      { k: 'outstanding', label: 'Outstanding', cls: 'num', html: (r) => `<b>${moneyFull(r.outstanding)}</b>`, sort: (r) => r.outstanding },
      { k: 'overdue', label: 'Overdue', cls: 'num', html: (r) => (r.overdue ? moneyFull(r.overdue) : '<span class="muted">–</span>'), sort: (r) => r.overdue },
      { k: 'oldest', label: 'Oldest overdue', cls: 'hide-sm', html: (r) => odChip(r.oldest), sort: (r) => r.oldest },
      { k: 'nextDue', label: 'Next due', cls: 'hide-sm', html: (r) => (r.nextDue ? dmy(r.nextDue) : '<span class="muted">–</span>'), sort: (r) => r.nextDue },
      { k: 'soa', label: 'Statement', html: (r) => `<a class="btn sm" href="${soaHref(r.id)}" target="_blank" rel="noopener">View</a> <a class="btn sm" href="${soaHref(r.id, true)}" target="_blank" rel="noopener">Print</a>`, sort: (r) => r.outstanding },
    ],
    expand: (r) => `<table class="lines"><thead><tr><th>Invoice</th><th>Date</th><th>Order ref.</th><th>Product</th><th class="num">Outstanding</th><th>Due</th><th>Overdue</th></tr></thead><tbody>
      ${r.invoices.map((i) => `<tr><td class="mono">${invLink(i)}</td><td>${dmy(i.date)}</td><td>${esc(i.ref || '–')}</td><td>${esc(i.product || '–')}</td><td class="num">${amount(i.residual)}</td><td>${dmy(i.due)}</td><td>${odChip(i.overdue)}</td></tr>`).join('')}</tbody></table>`,
  });
  for (const r of d.invoices) r.tags = [r.overdue > 0 ? 'overdue' : 'notdue'];
  listTable({
    host: $('#t-inv'), count: $('#i-count'), input: $('#i-q'), chips: $('#i-chips'), rows: d.invoices, noun: 'invoice', total: (r) => r.residual, sortKey: 'overdue', dir: -1,
    match: (r) => `${r.name} ${r.partner} ${r.ref} ${r.origin} ${r.product} ${r.user}`,
    cols: [
      { k: 'name', label: 'INV No.', cls: 'mono', asc: 1, html: invLink, sort: (r) => r.name },
      { k: 'date', label: 'Date', html: (r) => dmy(r.date), sort: (r) => r.date },
      { k: 'partner', label: 'Customer', cls: 'name', asc: 1, html: (r) => esc(r.partner), sort: (r) => r.partner },
      { k: 'ref', label: 'Order ref.', cls: 'hide-sm', asc: 1, html: (r) => `${esc(r.ref || '–')}${r.origin && r.origin !== r.ref ? `<br><small>${esc(r.origin)}</small>` : ''}`, sort: (r) => r.ref },
      { k: 'product', label: 'Product', cls: 'hide-sm', asc: 1, html: (r) => esc(r.product || '–'), sort: (r) => r.product },
      { k: 'residual', label: 'Outstanding', cls: 'num', html: (r) => `<b>${amount(r.residual)}</b>${r.residual !== r.total ? `<br><small>of ${moneyFull(r.total)}</small>` : ''}`, sort: (r) => r.residual },
      { k: 'due', label: 'Due date', html: (r) => dmy(r.due), sort: (r) => r.due },
      { k: 'overdue', label: 'Overdue', html: (r) => odChip(r.overdue), sort: (r) => r.overdue },
      { k: 'user', label: 'Salesperson', cls: 'hide-sm', asc: 1, html: (r) => esc(r.user), sort: (r) => r.user },
    ],
  });
}

const VIEWS = { revenue: ['/orders', renderDetail], invoice: ['/to-invoice', renderInvoice], target: ['/target', renderTarget], invoices: ['/receivables', renderReceivables] };

// ---------- boot ----------
async function boot() {
  try { META = await api('/meta'); } catch (e) { if (e.message !== 'signin') app.innerHTML = `<div class="login"><div class="error">${esc(e.message)}</div></div>`; return; }
  if (META.kind === 'tv') document.body.classList.add('tv');
  renderShell();
  await load();
}
// TV screens refresh themselves every 5 minutes
if (TV) setInterval(() => { if (META) api('/meta').then((m) => { META = m; return load(); }).catch(() => {}); }, 5 * 60000);
boot();
