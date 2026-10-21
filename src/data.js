// Loads the raw records the dashboard needs from Odoo (or demo data) into one normalised dataset, cached in memory.
// Everything is converted to the API user's company currency, untaxed.
const odoo = require('./odoo');
const demo = require('./demo');
const licenses = require('./licenses');

const CACHE_MS = Number(process.env.CACHE_MINUTES || 10) * 60000;
const AMC_KEYWORD = (process.env.AMC_KEYWORD || 'AMC').toLowerCase();
let cache = null;       // { data, at }
let inflight = null;

const m2o = (v) => (Array.isArray(v) ? { id: v[0], name: v[1] } : { id: null, name: '' });
const day = (s) => (s ? String(s).slice(0, 10) : null);
const iso = (d) => d.toISOString().slice(0, 10);

function since() {
  const now = new Date();
  const a = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));           // 1 Jan last year (YTD vs last year)
  const b = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 25, 1)); // 25 months back (AMC expiries)
  return iso(a < b ? a : b);
}

function isAmcText(s) { return String(s || '').toLowerCase().includes(AMC_KEYWORD); }

async function fromOdoo() {
  const uid = await odoo.uid();
  const [me] = await odoo.call('res.users', 'read', [[uid]], { fields: ['company_id', 'company_ids'] });
  const companyIds = me.company_ids;
  const ctx = { allowed_company_ids: companyIds, active_test: false };
  const companies = await odoo.call('res.company', 'read', [companyIds], { fields: ['name', 'currency_id'] });
  const home = companies.find((c) => c.id === me.company_id[0]) || companies[0];
  const currencies = await odoo.readAll('res.currency', [['active', 'in', [true, false]]], ['name', 'symbol', 'rate'], { ...ctx, company_id: home.id });
  const rate = Object.fromEntries(currencies.map((c) => [c.id, c.rate || 1]));
  const base = currencies.find((c) => c.id === home.currency_id[0]) || { name: home.currency_id[1], symbol: '' };
  const conv = (amount, cur) => (Number(amount) || 0) / (rate[Array.isArray(cur) ? cur[0] : cur] || 1);
  const from = since();

  // ---- sales ----
  const soFields = await odoo.pick('sale.order', ['name', 'partner_id', 'user_id', 'team_id', 'company_id', 'state', 'date_order', 'create_date',
    'amount_untaxed', 'margin', 'currency_id', 'invoice_status', 'opportunity_id', 'tag_ids', 'validity_date', 'is_subscription', 'end_date', 'next_invoice_date']);
  const soRaw = await odoo.readAll('sale.order', ['|', ['date_order', '>=', from], ['create_date', '>=', from]], soFields, ctx);
  const tagIds = [...new Set(soRaw.flatMap((o) => o.tag_ids || []))];
  let tags = {};
  if (tagIds.length) {
    try { tags = Object.fromEntries((await odoo.call('crm.tag', 'read', [tagIds], { fields: ['name'] })).map((t) => [t.id, t.name])); } catch (_) { /* tags optional */ }
  }

  const lineFields = await odoo.pick('sale.order.line', ['order_id', 'product_id', 'name', 'price_subtotal', 'product_uom_qty', 'currency_id', 'display_type']);
  const lineDomain = [['order_id.state', 'in', ['sale', 'done']], ['order_id.date_order', '>=', from]];
  if (lineFields.includes('display_type')) lineDomain.push(['display_type', '=', false]);
  const lineRaw = await odoo.readAll('sale.order.line', lineDomain, lineFields, ctx);
  const amcByLine = new Set(lineRaw.filter((l) => isAmcText(m2o(l.product_id).name) || isAmcText(l.name)).map((l) => m2o(l.order_id).id));

  const toOrder = (o) => {
    const t = (o.tag_ids || []).map((id) => tags[id]).filter(Boolean);
    return {
      id: o.id, name: o.name, partnerId: m2o(o.partner_id).id, partner: m2o(o.partner_id).name,
      userId: m2o(o.user_id).id, user: m2o(o.user_id).name || 'Unassigned', teamId: m2o(o.team_id).id, companyId: m2o(o.company_id).id,
      state: ['sale', 'done'].includes(o.state) ? 'sale' : o.state === 'cancel' ? 'cancel' : 'quote',
      dateOrder: day(o.date_order), created: day(o.create_date), amount: conv(o.amount_untaxed, o.currency_id), margin: conv(o.margin, o.currency_id),
      invoiceStatus: o.invoice_status || null, tags: t, subscriptionEnd: day(o.end_date), opportunityId: m2o(o.opportunity_id).id,
      isAmc: t.some(isAmcText) || amcByLine.has(o.id) || isAmcText(o.name),
    };
  };
  const orders = soRaw.map(toOrder);

  // ---- still to invoice: every confirmed order Odoo marks "to invoice", however old, with the untaxed amount left on each line ----
  orders.push(...(await odoo.readAll('sale.order', [['invoice_status', '=', 'to invoice'], ['state', 'in', ['sale', 'done']],
    ['date_order', '<', from], ['create_date', '<', from]], soFields, ctx)).map(toOrder));
  const invFields = await odoo.pick('sale.order.line', ['order_id', 'product_id', 'name', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'qty_to_invoice',
    'price_subtotal', 'untaxed_amount_to_invoice', 'untaxed_amount_invoiced', 'currency_id', 'display_type']);
  const hasInvoiceAmounts = invFields.includes('untaxed_amount_to_invoice');
  const invIds = orders.filter((o) => o.state === 'sale' && o.invoiceStatus === 'to invoice').map((o) => o.id);
  let invoiceLines = [];
  if (invIds.length) {
    const dom = [['order_id', 'in', invIds]];
    if (invFields.includes('display_type')) dom.push(['display_type', '=', false]);
    invoiceLines = (await odoo.readAll('sale.order.line', dom, invFields, ctx)).map((l) => ({
      orderId: m2o(l.order_id).id, product: m2o(l.product_id).name || l.name, qty: l.product_uom_qty || 0,
      delivered: l.qty_delivered ?? null, invoiced: l.qty_invoiced ?? null, toInvoiceQty: l.qty_to_invoice ?? null, subtotal: conv(l.price_subtotal, l.currency_id),
      toInvoice: hasInvoiceAmounts ? conv(l.untaxed_amount_to_invoice, l.currency_id) : null,
      invoicedAmount: invFields.includes('untaxed_amount_invoiced') ? conv(l.untaxed_amount_invoiced, l.currency_id) : null,
    }));
    if (hasInvoiceAmounts) {
      const left = new Map();
      for (const l of invoiceLines) left.set(l.orderId, (left.get(l.orderId) || 0) + l.toInvoice);
      for (const o of orders) if (left.has(o.id)) o.toInvoice = left.get(o.id);
    }
  }
  const toLine = (l) => ({ id: l.id, orderId: m2o(l.order_id).id, productId: m2o(l.product_id).id, product: m2o(l.product_id).name || l.name,
    text: l.name, subtotal: conv(l.price_subtotal, l.currency_id), qty: l.product_uom_qty || 0 });
  const lines = lineRaw.map(toLine);

  // ---- licences (Microsoft, Fortinet…): only lines naming a vendor, read further back than sales because terms run up to 5 years ----
  let licenseRows = [];
  const kws = licenses.vendors.flatMap((v) => v.keywords);
  if (kws.length) {
    const now = new Date();
    const licFrom = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - licenses.LOOKBACK_MONTHS, 1)));
    const any = kws.flatMap((k) => [['name', 'ilike', k], ['product_id.name', 'ilike', k]]);
    const domain = [['order_id.state', 'in', ['sale', 'done']], ['order_id.date_order', '>=', licFrom], ...Array(any.length - 1).fill('|'), ...any];
    if (lineFields.includes('display_type')) domain.push(['display_type', '=', false]);
    const licRaw = await odoo.readAll('sale.order.line', domain, lineFields, ctx);
    const byId = new Map(orders.map((o) => [o.id, o]));
    const missing = [...new Set(licRaw.map((l) => m2o(l.order_id).id))].filter((id) => !byId.has(id));
    for (let i = 0; i < missing.length; i += 500) {
      for (const o of await odoo.call('sale.order', 'read', [missing.slice(i, i + 500)], { fields: soFields, context: ctx })) byId.set(o.id, toOrder(o));
    }
    licenseRows = licenses.build(licRaw.map(toLine), byId);
  }

  // ---- CRM ----
  let stages = [], leads = [], activities = [];
  if (await odoo.hasModel('crm.lead')) {
    stages = (await odoo.readAll('crm.stage', [], await odoo.pick('crm.stage', ['name', 'sequence', 'is_won', 'fold']), ctx, 'sequence,id'))
      .map((s) => ({ id: s.id, name: s.name, sequence: s.sequence, isWon: !!s.is_won, fold: !!s.fold }));
    const won = new Set(stages.filter((s) => s.isWon).map((s) => s.id));
    const lf = await odoo.pick('crm.lead', ['name', 'partner_id', 'partner_name', 'type', 'user_id', 'team_id', 'company_id', 'stage_id', 'active',
      'expected_revenue', 'probability', 'create_date', 'date_closed', 'date_deadline', 'source_id', 'medium_id', 'lost_reason_id', 'company_currency']);
    const raw = await odoo.readAll('crm.lead',
      ['|', '|', ['create_date', '>=', from], ['date_closed', '>=', from], '&', ['active', '=', true], ['probability', '<', 100]], lf, ctx);
    leads = raw.map((l) => {
      const st = m2o(l.stage_id);
      const status = !l.active ? (Number(l.probability) === 0 ? 'lost' : 'archived') : (won.has(st.id) || Number(l.probability) >= 100 ? 'won' : 'open');
      return {
        id: l.id, name: l.name, partner: m2o(l.partner_id).name || l.partner_name || '', type: l.type || 'opportunity',
        userId: m2o(l.user_id).id, user: m2o(l.user_id).name || 'Unassigned', teamId: m2o(l.team_id).id, companyId: m2o(l.company_id).id,
        stageId: st.id, stage: st.name, status, expected: conv(l.expected_revenue, l.company_currency || base.id), probability: Number(l.probability) || 0,
        created: day(l.create_date), closed: day(l.date_closed), deadline: day(l.date_deadline),
        source: m2o(l.source_id).name || m2o(l.medium_id).name || 'No source', lostReason: m2o(l.lost_reason_id).name || 'No reason given',
      };
    }).filter((l) => l.status !== 'archived');
    const byId = Object.fromEntries(leads.map((l) => [l.id, l]));
    const acts = await odoo.readAll('mail.activity', [['res_model', '=', 'crm.lead'], ['date_deadline', '<', iso(new Date())]],
      await odoo.pick('mail.activity', ['res_id', 'res_name', 'user_id', 'summary', 'activity_type_id', 'date_deadline']), { allowed_company_ids: companyIds });
    activities = acts.map((a) => ({ id: a.id, leadId: a.res_id, lead: a.res_name, userId: m2o(a.user_id).id, user: m2o(a.user_id).name || 'Unassigned',
      summary: a.summary || m2o(a.activity_type_id).name || 'Activity', deadline: day(a.date_deadline),
      companyId: byId[a.res_id]?.companyId ?? null, teamId: byId[a.res_id]?.teamId ?? null }));
  }

  const teams = (await odoo.readAll('crm.team', [], ['name', 'company_id'], ctx)).map((t) => ({ id: t.id, name: t.name, companyId: m2o(t.company_id).id }));
  const userIds = new Map();
  for (const r of [...orders, ...leads]) if (r.userId) userIds.set(r.userId, r.user);

  return {
    source: 'odoo', odooUrl: process.env.ODOO_URL, currency: { name: base.name, symbol: base.symbol || base.name },
    companies: companies.map((c) => ({ id: c.id, name: c.name })), teams,
    users: [...userIds].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    stages, orders, lines, leads, activities, licenses: licenseRows, hasMargin: soFields.includes('margin'),
    invoiceLines, hasInvoiceAmounts, hasOpportunityLink: soFields.includes('opportunity_id'),
  };
}

async function load(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = process.env.DEMO === '1' || !odoo.configured() ? demo.dataset() : await fromOdoo();
      data.fetchedAt = new Date().toISOString();
      cache = { data, at: Date.now() };
      return data;
    } finally { inflight = null; }
  })();
  return inflight;
}

module.exports = { load, isAmcText };
