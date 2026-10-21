// Realistic, repeatable demo data in the same shape data.js builds from Odoo. Used when DEMO=1 or Odoo isn't configured.
const licenses = require('./licenses');
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function dataset() {
  const r = rng(20261020);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = (a, b) => a + r() * (b - a);
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const start = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1));
  const amcStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 25, 1));
  const from = amcStart < start ? amcStart : start;
  const span = Math.round((today - from) / 86400000);

  const companies = [{ id: 1, name: 'Evertech IT Infrastructure LLC' }, { id: 2, name: 'Evertech Technologies' }];
  const teams = [{ id: 1, name: 'Infrastructure', companyId: 1 }, { id: 2, name: 'Security & Networks', companyId: 1 }, { id: 3, name: 'Managed Services', companyId: 2 }];
  const users = [
    { id: 11, name: 'Faisal Rahman', teamId: 1, skill: 1.25 }, { id: 12, name: 'Anitha Pillai', teamId: 1, skill: 1.05 },
    { id: 13, name: 'Joseph Mathew', teamId: 2, skill: 0.95 }, { id: 14, name: 'Sara Khalid', teamId: 2, skill: 1.15 },
    { id: 15, name: 'Vivek Sharma', teamId: 3, skill: 0.85 }, { id: 16, name: 'Lina Haddad', teamId: 3, skill: 1.0 },
  ];
  const customers = ['Al Noor Hospital', 'Gulf Logistics FZE', 'Emirates Steel Works', 'Desert Rose Hotels', 'Marina Mall Mgmt', 'Falcon Aviation Services',
    'Al Futtaim Trading', 'Blue Wave Shipping', 'Crescent Schools Group', 'Oasis Pharma', 'Pearl Developers', 'Zayed Medical Center', 'Horizon Telecom',
    'Sharjah Plastics Ind.', 'Atlas Engineering', 'Saffron Restaurants', 'Golden Sands Realty', 'Nakheel Facilities', 'Royal Jet Catering', 'Delta Auto Spares',
    'Summit Capital', 'Majestic Interiors', 'Al Reem Clinics', 'Coral Bay Resorts', 'Polaris Freight', 'Vista Insurance Brokers', 'Arabian Cement Co.',
    'Silverline Contracting', 'Metro Retail Group', 'Lotus Labs'].map((name, i) => ({ id: 100 + i, name, weight: 0.4 + r() * 1.6 }));
  const products = [
    ['Server Rack Installation', 18000, 1], ['Dell PowerEdge R760 Server', 42000, 1], ['Structured Cabling (per point)', 450, 1],
    ['Fortinet FortiGate 100F', 16500, 2], ['CCTV System Install', 22000, 2], ['Access Control System', 14500, 2],
    ['Microsoft 365 Business Premium (annual)', 950, 3], ['Network AMC (annual)', 24000, 3], ['Server AMC (annual)', 36000, 3],
    ['CCTV AMC (annual)', 12000, 3], ['IT Support Retainer', 8500, 3], ['Wi-Fi Survey & Deployment', 26000, 1],
    ['[FG-100F-BDL-950-12] FortiGate 100F UTP Bundle 1 Year', 9800, 2], ['[FC-10-F100F-247-02-36] FortiCare Premium 3 Year', 6200, 2],
    ['Microsoft Defender for Business (annual)', 110, 3],
  ].map(([name, price, teamHint], i) => ({ id: 500 + i, name, price, teamHint }));

  // typical gross margin by kind of product, for the demo's order margins
  const marginRate = (name) => (/AMC|Retainer/.test(name) ? 0.45 : /Install|Cabling|Survey|Access Control/.test(name) ? 0.32
    : /Bundle|FortiCare|Microsoft|Defender/.test(name) ? 0.14 : 0.18);
  const orders = [], lines = [];
  let oid = 1;
  for (let i = 0; i < 520; i++) {
    const t = Math.pow(r(), 0.8);                                        // more recent activity
    const created = addDays(from, Math.floor(t * span));
    const u = pick(users), team = teams.find((x) => x.id === u.teamId);
    const cust = customers[Math.floor(Math.pow(r(), 1.3) * customers.length)];
    const pool = products.filter((p) => p.teamHint === team.id || r() < 0.15);
    const nLines = 1 + Math.floor(r() * 3);
    const myLines = [];
    for (let k = 0; k < nLines; k++) {
      const p = pick(pool);
      const qty = p.price < 1000 ? Math.ceil(between(10, 120)) : 1 + (r() < 0.25 ? 1 : 0);
      myLines.push({ productId: p.id, product: p.name, qty, subtotal: Math.round(p.price * qty * between(0.85, 1.1)) });
    }
    const amount = myLines.reduce((a, l) => a + l.subtotal, 0) * u.skill;
    const margin = myLines.reduce((a, l) => a + l.subtotal * marginRate(l.product), 0) * u.skill;
    const age = (today - created) / 86400000;
    const p = r();
    const state = age < 20 && p < 0.5 ? 'quote' : p < 0.64 * u.skill ? 'sale' : p < 0.82 ? 'cancel' : age < 60 ? 'quote' : 'cancel';
    const dateOrder = state === 'sale' ? addDays(created, Math.floor(between(1, Math.min(25, Math.max(1, age))))) : created;
    const isAmc = myLines.some((l) => /AMC/.test(l.product));
    const id = oid++;
    const inv = state !== 'sale' ? 'no' : (today - dateOrder) / 86400000 < 45 && r() < 0.6 ? 'to invoice' : 'invoiced';
    orders.push({ id, name: `S${String(id).padStart(5, '0')}`, partnerId: cust.id, partner: cust.name, userId: u.id, user: u.name, teamId: team.id,
      companyId: team.companyId, state, dateOrder: iso(dateOrder > today ? today : dateOrder), created: iso(created), amount: Math.round(amount), margin: Math.round(margin),
      invoiceStatus: inv, tags: isAmc ? ['AMC'] : [], subscriptionEnd: null, isAmc });
    if (state === 'sale') for (const l of myLines) lines.push({ orderId: id, ...l, subtotal: Math.round(l.subtotal * u.skill) });
  }
  // a few AMC renewals so "renewal found" shows up
  for (const o of orders.filter((x) => x.isAmc && x.state === 'sale').slice(0, 6)) {
    const exp = addDays(new Date(o.created), 365);
    if (exp > addDays(today, 20) || exp < addDays(today, -120)) continue;
    const created = addDays(exp, -Math.floor(between(5, 25)));
    if (created > today) continue;
    const id = oid++;
    orders.push({ ...o, id, name: `S${String(id).padStart(5, '0')}`, created: iso(created), dateOrder: iso(created), invoiceStatus: 'to invoice' });
    lines.push({ orderId: id, productId: 507, product: 'Network AMC (annual)', qty: 1, subtotal: o.amount });
  }

  // a few licence renewals too (same customer and vendor, ordered shortly before expiry)
  const lic = (orderId) => lines.filter((l) => l.orderId === orderId && licenses.classify(l.product));
  for (const o of orders.filter((x) => x.state === 'sale' && lic(x.id).length).slice(0, 40)) {
    const first = lic(o.id)[0], c = licenses.classify(first.product);
    const exp = addDays(new Date(o.dateOrder), Math.round(c.termMonths * 30.4));
    if (exp > addDays(today, 25) || exp < addDays(today, -100) || r() < 0.45) continue;
    const created = addDays(exp, -Math.floor(between(3, 30)));
    if (created > today) continue;
    const id = oid++;
    orders.push({ ...o, id, name: `S${String(id).padStart(5, '0')}`, created: iso(created), dateOrder: iso(created), invoiceStatus: 'to invoice', isAmc: false, tags: [] });
    lines.push({ ...first, orderId: id });
  }
  lines.forEach((l, i) => { l.id = i + 1; });

  const stages = [
    { id: 1, name: 'New', sequence: 1, isWon: false }, { id: 2, name: 'Qualified', sequence: 2, isWon: false },
    { id: 3, name: 'Site Survey', sequence: 3, isWon: false }, { id: 4, name: 'Proposal Sent', sequence: 4, isWon: false },
    { id: 5, name: 'Negotiation', sequence: 5, isWon: false }, { id: 6, name: 'Won', sequence: 6, isWon: true },
  ];
  const sources = ['Website', 'Referral', 'LinkedIn', 'Trade show (GITEX)', 'Cold call', 'Existing customer'];
  const reasons = ['Price too high', 'Went with competitor', 'No budget', 'Project postponed', 'No response'];
  const leads = [];
  for (let i = 0; i < 460; i++) {
    const created = addDays(from, Math.floor(Math.pow(r(), 0.75) * span));
    const u = pick(users), team = teams.find((x) => x.id === u.teamId);
    const age = (today - created) / 86400000;
    const src = pick(sources);
    const quality = (src === 'Referral' || src === 'Existing customer' ? 1.35 : src === 'Cold call' ? 0.6 : 1) * u.skill;
    const expected = Math.round(between(8, 180) * 1000 * (r() < 0.12 ? 3 : 1));
    let status = 'open', stageId = 1 + Math.min(4, Math.floor(r() * Math.min(5, age / 12 + 1))), closed = null, prob;
    if (age > 25) {
      const p = r();
      if (p < 0.34 * quality) status = 'won'; else if (p < 0.8) status = 'lost';
    }
    if (status !== 'open') closed = iso(addDays(created, Math.min(age, Math.floor(between(12, 95)))));
    if (status === 'won') { stageId = 6; prob = 100; } else if (status === 'lost') prob = 0; else prob = [10, 25, 40, 60, 80][stageId - 1];
    const cust = pick(customers);
    leads.push({ id: 9000 + i, name: `${pick(['Data center refresh', 'Firewall upgrade', 'CCTV for new branch', 'Office network', 'Server AMC', 'Wi-Fi coverage', 'Access control', 'M365 migration'])}`,
      partner: cust.name, type: 'opportunity', userId: u.id, user: u.name, teamId: team.id, companyId: team.companyId, stageId,
      stage: stages[stageId - 1].name, status, expected, probability: prob, created: iso(created), closed,
      deadline: status === 'open' ? (r() < 0.08 ? null : iso(addDays(today, Math.floor(between(-25, 100)))))
        : iso(addDays(new Date(closed + 'T00:00:00Z'), Math.floor(between(-20, 25)))), source: src,
      lostReason: status === 'lost' ? pick(reasons) : 'No reason given' });
  }
  const activities = leads.filter((l) => l.status === 'open' && r() < 0.22).map((l, i) => ({
    id: i + 1, leadId: l.id, lead: l.name + ' – ' + l.partner, userId: l.userId, user: l.user,
    summary: pick(['Follow-up call', 'Send revised quote', 'Site visit', 'Email proposal', 'Meeting']),
    deadline: iso(addDays(today, -Math.ceil(between(1, 21)))), companyId: l.companyId, teamId: l.teamId,
  }));

  // what's left to invoice: on "to invoice" orders every other line is still open, the rest already invoiced
  const toInv = new Set(orders.filter((o) => o.state === 'sale' && o.invoiceStatus === 'to invoice').map((o) => o.id));
  const seen = new Map();
  for (const l of lines) {
    const k = seen.get(l.orderId) || 0; seen.set(l.orderId, k + 1);
    const open = toInv.has(l.orderId) && k % 2 === 0;
    Object.assign(l, { delivered: l.qty, invoicedQty: open ? 0 : l.qty, toInvoiceQty: open ? l.qty : 0, toInvoice: open ? l.subtotal : 0, invoicedAmount: open ? 0 : l.subtotal });
  }
  const invoiceLines = lines.filter((l) => toInv.has(l.orderId)).map((l) => ({ orderId: l.orderId, product: l.product, qty: l.qty, delivered: l.delivered,
    invoiced: l.invoicedQty, toInvoiceQty: l.toInvoiceQty, subtotal: l.subtotal, toInvoice: l.toInvoice, invoicedAmount: l.invoicedAmount }));
  for (const o of orders) if (toInv.has(o.id)) o.toInvoice = invoiceLines.filter((l) => l.orderId === o.id).reduce((a, l) => a + l.toInvoice, 0);
  // won opportunities → the sales order created from them (same salesperson, confirmed within ~3 weeks of winning)
  const free = orders.filter((o) => o.state === 'sale');
  for (const ld of leads.filter((x) => x.status === 'won')) {
    const t = Date.parse(ld.closed);
    const o = free.find((x) => !x.opportunityId && x.userId === ld.userId && Math.abs(Date.parse(x.dateOrder) - t) < 21 * 86400000);
    if (o) o.opportunityId = ld.id;
  }

  return { source: 'demo', currency: { name: 'AED', symbol: 'AED' }, companies, teams,
    users: users.map(({ id, name }) => ({ id, name })), stages, orders, lines, leads, activities, hasMargin: true,
    invoiceLines, hasInvoiceAmounts: true, hasOpportunityLink: true,
    licenses: licenses.build(lines, new Map(orders.map((o) => [o.id, o]))) };
}

module.exports = { dataset };
