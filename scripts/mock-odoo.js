// Test helper: node scripts/mock-odoo.js  then run the app with ODOO_URL=http://localhost:3299 ODOO_DB=evertech ODOO_LOGIN=x ODOO_API_KEY=TESTKEY
// Mock Odoo JSON-RPC server built from the demo dataset, in Odoo's own record format.
// Lets us check the real fromOdoo() path end to end and compare its numbers with the demo path.
const http = require('http');
const demo = require('../src/demo.js').dataset();

const dt = (d) => (d ? d + ' 08:30:00' : false);
const m2o = (id, name) => (id ? [id, name] : false);
const AED = [1, 'AED'], USD = [2, 'USD'];
const stagesById = Object.fromEntries(demo.stages.map((s) => [s.id, s]));
const DB = {
  'res.users': [{ id: 2, company_id: [1, demo.companies[0].name], company_ids: demo.companies.map((c) => c.id) }],
  'res.company': demo.companies.map((c) => ({ id: c.id, name: c.name, currency_id: AED })),
  'res.currency': [{ id: 1, name: 'AED', symbol: 'AED', rate: 1, active: true }, { id: 2, name: 'USD', symbol: '$', rate: 0.2723, active: true }],
  'crm.tag': [{ id: 1, name: 'AMC' }],
  'crm.team': demo.teams.map((t) => ({ id: t.id, name: t.name, company_id: m2o(t.companyId, 'c') })),
  'crm.stage': demo.stages.map((s) => ({ id: s.id, name: s.name, sequence: s.sequence, is_won: s.isWon, fold: false })),
  'sale.order': demo.orders.map((o) => ({ id: o.id, name: o.name, partner_id: m2o(o.partnerId, o.partner), user_id: m2o(o.userId, o.user), team_id: m2o(o.teamId, 't'),
    company_id: m2o(o.companyId, 'c'), state: o.state === 'quote' ? 'draft' : o.state, date_order: dt(o.dateOrder), create_date: dt(o.created),
    amount_untaxed: o.amount, margin: o.margin, opportunity_id: m2o(o.opportunityId, 'lead'), currency_id: AED, invoice_status: o.invoiceStatus, tag_ids: o.tags.length ? [1] : [] })),
  'sale.order.line': demo.lines.map((l, i) => ({ id: i + 1, order_id: m2o(l.orderId, 'S'), product_id: m2o(l.productId, l.product), name: l.product,
    price_subtotal: l.subtotal, product_uom_qty: l.qty, currency_id: AED, display_type: false,
    qty_delivered: l.delivered, qty_invoiced: l.invoicedQty, qty_to_invoice: l.toInvoiceQty, untaxed_amount_to_invoice: l.toInvoice, untaxed_amount_invoiced: l.invoicedAmount })),
  'crm.lead': demo.leads.map((l) => ({ id: l.id, name: l.name, partner_id: m2o(1, l.partner), partner_name: l.partner, type: 'opportunity', user_id: m2o(l.userId, l.user),
    team_id: m2o(l.teamId, 't'), company_id: m2o(l.companyId, 'c'), stage_id: m2o(l.stageId, stagesById[l.stageId].name), active: l.status !== 'lost',
    expected_revenue: l.expected, probability: l.probability, create_date: dt(l.created), date_closed: dt(l.closed), date_deadline: l.deadline || false,
    source_id: m2o(1, l.source), medium_id: false, lost_reason_id: l.status === 'lost' ? m2o(1, l.lostReason) : false, company_currency: AED })),
  'mail.activity': demo.activities.map((a) => ({ id: a.id, res_model: 'crm.lead', res_id: a.leadId, res_name: a.lead, user_id: m2o(a.userId, a.user),
    summary: a.summary, activity_type_id: m2o(1, 'To-Do'), date_deadline: a.deadline })),
};
// one USD order (1,000 USD) to test currency conversion
const usd = { ...DB['sale.order'].find((o) => o.state === 'sale' && o.date_order.startsWith('2026-10')), id: 99999, name: 'S99999', amount_untaxed: 1000, margin: 200, currency_id: USD, tag_ids: [] };
DB['sale.order'].push(usd);
const REL = { 'sale.order.line': { order_id: 'sale.order' } };

function val(model, rec, path) {
  const [f, ...rest] = path.split('.');
  let v = rec[f];
  if (!rest.length) return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'string' ? v[0] : v;
  const target = REL[model]?.[f];
  if (!target) return rest.join('.') === 'name' && Array.isArray(v) ? v[1] : undefined; // e.g. product_id.name
  const r = DB[target].find((x) => x.id === v[0]);
  return r ? val(target, r, rest.join('.')) : undefined;
}
function test(model, rec, [f, op, x]) {
  const v = val(model, rec, f);
  const cmp = (a) => (typeof a === 'string' && typeof x === 'string' ? a.slice(0, x.length) : a);
  switch (op) {
    case '=': return v === x || (x === false && !v);
    case '!=': return v !== x;
    case 'in': return x.includes(v);
    case 'ilike': return String(v || '').toLowerCase().includes(String(x).toLowerCase());
    case '>=': return v !== false && v != null && cmp(v) >= x;
    case '<': return v !== false && v != null && cmp(v) < x;
    default: throw new Error('op ' + op);
  }
}
function evalDomain(model, rec, dom) {
  const stack = [];
  for (let i = dom.length - 1; i >= 0; i--) {
    const t = dom[i];
    if (t === '|') { const a = stack.pop(), b = stack.pop(); stack.push(a || b); }
    else if (t === '&') { const a = stack.pop(), b = stack.pop(); stack.push(a && b); }
    else stack.push(test(model, rec, t));
  }
  return stack.every(Boolean);
}
const calls = [];
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const { params } = JSON.parse(b);
    let result, error;
    try {
      if (params.service === 'common') result = params.args[2] === 'TESTKEY' ? 2 : false;
      else {
        const [, uid, key, model, method, args = [], kw = {}] = params.args;
        if (key !== 'TESTKEY') throw new Error('Access Denied');
        calls.push(`${model}.${method}`);
        const rows = DB[model];
        if (!rows) throw new Error(`Object ${model} doesn't exist`);
        const pickF = (r, fields) => (fields?.length ? Object.fromEntries([['id', r.id], ...fields.map((f) => { if (!(f in r)) return [f, false]; return [f, r[f]]; })]) : r);
        if (method === 'fields_get') result = Object.fromEntries(Object.keys(rows[0] || {}).map((k) => [k, { type: 'x' }]));
        else if (method === 'read') result = rows.filter((r) => args[0].includes(r.id)).map((r) => pickF(r, kw.fields));
        else if (method === 'search_read') {
          const ctx = kw.context || {};
          let rs = rows.filter((r) => evalDomain(model, r, args[0] || []));
          if (!ctx.active_test === false || ctx.active_test !== false) rs = rs.filter((r) => r.active !== false);
          rs = rs.slice(kw.offset || 0, (kw.offset || 0) + (kw.limit || 1e9));
          result = rs.map((r) => pickF(r, kw.fields));
        } else throw new Error('method ' + method);
      }
    } catch (e) { error = { message: 'Odoo Server Error', data: { message: e.message } }; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(error ? { jsonrpc: '2.0', id: 1, error } : { jsonrpc: '2.0', id: 1, result }));
  });
}).listen(3299, () => console.log('mock odoo on 3299'));
process.on('SIGTERM', () => { console.log('calls', calls.length); process.exit(0); });
