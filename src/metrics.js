// Turns the dataset into everything the dashboard shows, for one filter slice:
// period (from..to, compared with the previous period of the same length), company, sales team, salesperson.
const AMC_MONTHS = Number(process.env.AMC_TERM_MONTHS || 12);
const AMC_FROM = process.env.AMC_EXPIRY_FROM || 'created'; // 'created' (order creation date, as requested) or 'confirmed'
const licenses = require('./licenses');

const D = 86400000;
const parse = (s) => new Date(s + 'T00:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(parse(s).getTime() + n * D));
const addMonths = (s, n) => { const d = parse(s); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return iso(d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / D);
const inRange = (d, a, b) => d && d >= a && d <= b;
const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);
const ym = (s) => s.slice(0, 7);

function monthsEnding(endIso, n) {
  const out = []; const d = parse(endIso.slice(0, 7) + '-01');
  for (let i = n - 1; i >= 0; i--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); out.push(iso(x).slice(0, 7)); }
  return out;
}

function topN(map, n, valueKey = 'value') {
  const rows = [...map.values()].sort((a, b) => b[valueKey] - a[valueKey]);
  if (rows.length <= n) return rows;
  const head = rows.slice(0, n - 1), rest = rows.slice(n - 1);
  const other = { name: `Other (${rest.length})`, other: true };
  for (const k of Object.keys(rest[0])) if (typeof rest[0][k] === 'number') other[k] = sum(rest, (r) => r[k]);
  return [...head, other];
}

// one filter slice: company, sales team, salesperson
const sliceOf = (f) => (r) => (!f.company || r.companyId === f.company) && (!f.team || r.teamId === f.team) && (!f.user || r.userId === f.user);

function compute(ds, f) {
  const today = f.today || iso(new Date());
  const from = f.from, to = f.to;
  const len = daysBetween(from, to) + 1;
  // compare with the previous period of equal length, or ('ly') the same dates last year
  // (a month-to-date range compares with the same days of the previous month)
  const sameMonth = from.slice(8) === '01' && from.slice(0, 7) === to.slice(0, 7);
  let prevFrom, prevTo;
  if (f.compare === 'ly') { prevFrom = addMonths(from, -12); prevTo = addMonths(to, -12); }
  else if (sameMonth) { prevFrom = addMonths(from, -1); prevTo = addMonths(to, -1); }
  else { prevTo = addDays(from, -1); prevFrom = addDays(prevTo, -(len - 1)); }
  const slice = sliceOf(f);

  const orders = ds.orders.filter(slice);
  const sold = orders.filter((o) => o.state === 'sale');
  const soldIn = (a, b) => sold.filter((o) => inRange(o.dateOrder, a, b));
  const cur = soldIn(from, to), prev = soldIn(prevFrom, prevTo);
  const revenue = sum(cur, (o) => o.amount), revenuePrev = sum(prev, (o) => o.amount);
  // margin = Odoo's sale.order margin (Sales Margin module): untaxed amount minus product cost; null when Odoo doesn't have it
  const margin = (arr) => (ds.hasMargin ? sum(arr, (o) => o.margin || 0) : null);
  // year to date: 1 Jan of the period-end year up to the period end, compared with the same dates last year
  const ytdFrom = to.slice(0, 4) + '-01-01', ytdPrevFrom = addMonths(ytdFrom, -12), ytdPrevTo = addMonths(to, -12);
  const ytd = soldIn(ytdFrom, to), ytdPrev = soldIn(ytdPrevFrom, ytdPrevTo);
  const toInvoice = sold.filter((o) => o.invoiceStatus === 'to invoice');

  const leads = ds.leads.filter(slice);
  const open = leads.filter((l) => l.status === 'open');
  const closedIn = (status, a, b) => leads.filter((l) => l.status === status && inRange(l.closed, a, b));
  const won = closedIn('won', from, to), lost = closedIn('lost', from, to);
  const wonPrev = closedIn('won', prevFrom, prevTo), lostPrev = closedIn('lost', prevFrom, prevTo);
  const rate = (w, l) => (w.length + l.length ? w.length / (w.length + l.length) : null);
  const cycle = (arr) => (arr.length ? sum(arr, (l) => Math.max(0, daysBetween(l.created, l.closed))) / arr.length : null);
  const newLeads = leads.filter((l) => inRange(l.created, from, to)), newLeadsPrev = leads.filter((l) => inRange(l.created, prevFrom, prevTo));
  const acts = ds.activities.filter((a) => (!f.company || a.companyId === f.company) && (!f.team || a.teamId === f.team) && (!f.user || a.userId === f.user));

  const kpis = {
    revenue: { value: revenue, prev: revenuePrev },
    orders: { value: cur.length, prev: prev.length },
    margin: { value: margin(cur), prev: margin(prev), revenue, revenuePrev },
    ytd: { from: ytdFrom, to, prevFrom: ytdPrevFrom, prevTo: ytdPrevTo,
      revenue: sum(ytd, (o) => o.amount), revenuePrev: sum(ytdPrev, (o) => o.amount),
      margin: margin(ytd), marginPrev: margin(ytdPrev), orders: ytd.length, ordersPrev: ytdPrev.length },
    toInvoice: { value: sum(toInvoice, (o) => o.toInvoice ?? o.amount), count: toInvoice.length },
    pipeline: { value: sum(open, (l) => l.expected), weighted: sum(open, (l) => (l.expected * l.probability) / 100), count: open.length },
    won: { value: sum(won, (l) => l.expected), count: won.length, prev: sum(wonPrev, (l) => l.expected), prevCount: wonPrev.length },
    winRate: { value: rate(won, lost), prev: rate(wonPrev, lostPrev), won: won.length, lost: lost.length },
    cycle: { value: cycle(won), prev: cycle(wonPrev) },
    newLeads: { value: newLeads.length, prev: newLeadsPrev.length },
    overdue: { value: acts.length },
  };

  // 12-month trends ending at the period end
  const months = monthsEnding(to, 12);
  const mIdx = Object.fromEntries(months.map((m, i) => [m, i]));
  const revByMonth = months.map((m) => ({ month: m, value: 0, orders: 0 }));
  for (const o of sold) { const i = mIdx[ym(o.dateOrder)]; if (i != null) { revByMonth[i].value += o.amount; revByMonth[i].orders++; } }
  // same months one year earlier, for the tooltip comparison
  const lastYear = months.map((m) => addMonths(m + '-01', -12).slice(0, 7));
  const lyIdx = Object.fromEntries(lastYear.map((m, i) => [m, i]));
  for (const o of sold) { const i = lyIdx[ym(o.dateOrder)]; if (i != null) revByMonth[i].lastYear = (revByMonth[i].lastYear || 0) + o.amount; }
  const wonLost = months.map((m) => ({ month: m, won: 0, lost: 0, wonValue: 0 }));
  for (const l of leads) {
    if (!l.closed || (l.status !== 'won' && l.status !== 'lost')) continue;
    const i = mIdx[ym(l.closed)]; if (i == null) continue;
    wonLost[i][l.status]++; if (l.status === 'won') wonLost[i].wonValue += l.expected;
  }

  // rankings for the period
  const cust = new Map();
  for (const o of cur) { const c = cust.get(o.partnerId) || { name: o.partner, value: 0, margin: 0, orders: 0 }; c.value += o.amount; c.margin += o.margin || 0; c.orders++; cust.set(o.partnerId, c); }
  const people = new Map();
  const person = (id, name) => { if (!people.has(id)) people.set(id, { id, name, revenue: 0, orders: 0, won: 0, lost: 0, wonValue: 0, pipeline: 0, overdue: 0 }); return people.get(id); };
  for (const o of cur) { const p = person(o.userId, o.user); p.revenue += o.amount; p.orders++; }
  for (const l of won) { const p = person(l.userId, l.user); p.won++; p.wonValue += l.expected; }
  for (const l of lost) person(l.userId, l.user).lost++;
  for (const l of open) person(l.userId, l.user).pipeline += l.expected;
  for (const a of acts) person(a.userId, a.user).overdue++;
  const salespeople = [...people.values()].map((p) => ({ ...p, winRate: p.won + p.lost ? p.won / (p.won + p.lost) : null }))
    .sort((a, b) => b.revenue - a.revenue || b.pipeline - a.pipeline);

  // pipeline by stage (open opportunities), in stage order
  const stageRows = ds.stages.filter((s) => !s.isWon).map((s) => ({ id: s.id, name: s.name, count: 0, value: 0, weighted: 0 }));
  const sIdx = Object.fromEntries(stageRows.map((s, i) => [s.id, i]));
  for (const l of open) { const i = sIdx[l.stageId]; if (i == null) continue; stageRows[i].count++; stageRows[i].value += l.expected; stageRows[i].weighted += (l.expected * l.probability) / 100; }

  const src = new Map();
  for (const l of newLeads) { const s = src.get(l.source) || { name: l.source, value: 0, won: 0 }; s.value++; if (l.status === 'won') s.won++; src.set(l.source, s); }
  const reasons = new Map();
  for (const l of lost) { const s = reasons.get(l.lostReason) || { name: l.lostReason, value: 0, amount: 0 }; s.value++; s.amount += l.expected; reasons.set(l.lostReason, s); }

  // ---- monthly target: each month salespeople commit opportunities in CRM by setting their Expected Closing date in that month.
  // Target = expected revenue of opportunities (won, lost or still open) whose Expected Closing date is in the period; achieved = won in the period.
  // A period running to today (this month, YTD…) takes the target to the end of that month.
  const tTo = to >= today ? addDays(addMonths(to.slice(0, 7) + '-01', 1), -1) : to;
  const planned = (a, b) => leads.filter((l) => l.deadline && inRange(l.deadline, a, b));
  const targetOf = (pl, wn) => {
    const op = pl.filter((l) => l.status === 'open'), ls = pl.filter((l) => l.status === 'lost'), late = op.filter((l) => l.deadline < today);
    const target = sum(pl, (l) => l.expected), achieved = sum(wn, (l) => l.expected);
    return { target, count: pl.length, achieved, wonCount: wn.length, pct: target ? achieved / target : null,
      plannedWon: sum(pl.filter((l) => l.status === 'won'), (l) => l.expected),
      open: sum(op, (l) => l.expected), openCount: op.length, late: sum(late, (l) => l.expected), lateCount: late.length,
      lost: sum(ls, (l) => l.expected), lostCount: ls.length };
  };
  const tPlanned = planned(from, tTo);
  const tPeople = new Map();
  for (const l of [...tPlanned, ...won]) if (!tPeople.has(l.userId)) tPeople.set(l.userId, l.user);
  const tMonths = Array.from({ length: 9 }, (_, i) => addMonths(to.slice(0, 7) + '-01', i - 6).slice(0, 7));
  const target = {
    from, to: tTo,
    total: targetOf(tPlanned, won),
    bySalesperson: [...tPeople].map(([id, name]) => ({ id, name, ...targetOf(tPlanned.filter((l) => l.userId === id), won.filter((l) => l.userId === id)) }))
      .sort((x, y) => y.target - x.target || y.achieved - x.achieved),
    months: tMonths.map((m) => {
      const a = m + '-01', b = addDays(addMonths(a, 1), -1);
      const t = targetOf(planned(a, b), closedIn('won', a, b));
      return a > today ? { ...t, month: m, future: true, pct: null } : { ...t, month: m };
    }),
  };

  const closingSoon = open.filter((l) => l.deadline && l.deadline <= addDays(today, 30))
    .sort((a, b) => a.deadline.localeCompare(b.deadline) || b.expected - a.expected).slice(0, 12)
    .map((l) => ({ id: l.id, name: l.name, partner: l.partner, user: l.user, stage: l.stage, expected: l.expected, probability: l.probability, deadline: l.deadline, late: l.deadline < today }));

  // ---- AMC renewals: expiry = order creation date + 12 months (not limited by the period filter) ----
  const amcOrders = sold.filter((o) => o.isAmc);
  const amcRows = amcOrders.map((o) => {
    const start = AMC_FROM === 'confirmed' ? o.dateOrder : o.created;
    const expiry = addMonths(start, AMC_MONTHS);
    const left = daysBetween(today, expiry);
    const renewal = amcOrders.find((x) => x.id !== o.id && x.partnerId === o.partnerId && x.created > addDays(expiry, -90) && x.created <= addDays(expiry, 60) && x.created > start);
    return { id: o.id, name: o.name, partner: o.partner, user: o.user, amount: o.amount, start, expiry, daysLeft: left, renewedBy: renewal ? renewal.name : null };
  }).filter((x) => x.daysLeft <= 60 && x.daysLeft >= -120);
  const amc = {
    rows: amcRows.sort((a, b) => (a.renewedBy ? 1 : 0) - (b.renewedBy ? 1 : 0) || a.daysLeft - b.daysLeft),
    overdue: amcRows.filter((x) => x.daysLeft < 0 && !x.renewedBy).length,
    due30: amcRows.filter((x) => x.daysLeft >= 0 && x.daysLeft <= 30 && !x.renewedBy).length,
    due60: amcRows.filter((x) => x.daysLeft > 30 && !x.renewedBy).length,
    valueAtRisk: sum(amcRows.filter((x) => !x.renewedBy), (x) => x.amount),
    termMonths: AMC_MONTHS, from: AMC_FROM, totalActive: amcOrders.length,
  };

  // ---- licence renewals (Microsoft, Fortinet…): expiry = order date + the line's term; one row per order + vendor + expiry ----
  // Renewal = a newer licence line for the same customer and vendor, created by anyone (so the salesperson filter can't hide it).
  const allLic = ds.licenses || [];
  const licGroups = new Map();
  for (const l of allLic.filter(slice)) {
    const expiry = addMonths(l.start, l.termMonths);
    const left = daysBetween(today, expiry);
    if (left > 60 || left < -120) continue;
    const key = `${l.orderId}|${l.vendor}|${expiry}`;
    const g = licGroups.get(key) || { id: l.orderId, name: l.order, partner: l.partner, partnerId: l.partnerId, user: l.user, vendor: l.vendor,
      products: [], amount: 0, start: l.start, expiry, termMonths: l.termMonths, daysLeft: left };
    if (!g.products.includes(l.product)) g.products.push(l.product);
    g.amount += l.amount;
    licGroups.set(key, g);
  }
  const licRows = [...licGroups.values()].map(({ partnerId, ...g }) => {
    const renewal = allLic.find((x) => x.orderId !== g.id && x.partnerId === partnerId && x.vendor === g.vendor
      && x.start > g.start && x.start > addDays(g.expiry, -90) && x.start <= addDays(g.expiry, 60));
    return { ...g, renewedBy: renewal ? renewal.order : null };
  });
  const licOpen = licRows.filter((x) => !x.renewedBy);
  const byVendor = new Map();
  for (const x of licOpen) byVendor.set(x.vendor, (byVendor.get(x.vendor) || 0) + 1);
  const licenseRenewals = {
    rows: licRows.sort((a, b) => (a.renewedBy ? 1 : 0) - (b.renewedBy ? 1 : 0) || a.daysLeft - b.daysLeft),
    overdue: licOpen.filter((x) => x.daysLeft < 0).length,
    due30: licOpen.filter((x) => x.daysLeft >= 0 && x.daysLeft <= 30).length,
    due60: licOpen.filter((x) => x.daysLeft > 30).length,
    valueAtRisk: sum(licOpen, (x) => x.amount),
    byVendor: [...byVendor].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    from: licenses.FROM, vendors: licenses.vendors.map((v) => v.name), totalLines: allLic.length,
  };

  return {
    period: { from, to, prevFrom, prevTo, days: len, compare: f.compare === 'ly' ? 'ly' : 'prev' }, today,
    kpis, revByMonth, wonLost,
    topCustomers: topN(cust, 11).map((c) => (ds.hasMargin ? c : { ...c, margin: null })),
    salespeople, stages: stageRows,
    sources: [...src.values()].sort((a, b) => b.value - a.value),
    lostReasons: [...reasons.values()].sort((a, b) => b.value - a.value),
    closingSoon, target,
    overdueActivities: acts.sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 10)
      .map((a) => ({ lead: a.lead, user: a.user, summary: a.summary, deadline: a.deadline, daysLate: daysBetween(a.deadline, today), leadId: a.leadId })),
    amc, licenses: licenseRenewals,
  };
}

/** Revenue details: every confirmed order behind the Revenue/Margin/Orders tiles, plus breakdowns. range 'ytd' = 1 Jan to the period end. */
function details(ds, f, range) {
  const from = range === 'ytd' ? f.to.slice(0, 4) + '-01-01' : f.from, to = f.to;
  const teams = Object.fromEntries(ds.teams.map((t) => [t.id, t.name]));
  const companies = Object.fromEntries(ds.companies.map((c) => [c.id, c.name]));
  const sold = ds.orders.filter(sliceOf(f)).filter((o) => o.state === 'sale' && inRange(o.dateOrder, from, to))
    .sort((a, b) => b.dateOrder.localeCompare(a.dateOrder) || b.amount - a.amount);
  const mg = (o) => (ds.hasMargin ? o.margin || 0 : null);
  const group = (key, name) => {
    const g = new Map();
    for (const o of sold) {
      const k = key(o); const r = g.get(k) || { name: name(o), value: 0, margin: ds.hasMargin ? 0 : null, orders: 0 };
      r.value += o.amount; if (ds.hasMargin) r.margin += o.margin || 0; r.orders++; g.set(k, r);
    }
    return [...g.values()].sort((a, b) => b.value - a.value);
  };
  const byMonth = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addMonths(m + '-01', 1).slice(0, 7)) byMonth.push({ month: m, value: 0, margin: ds.hasMargin ? 0 : null, orders: 0 });
  const mIdx = Object.fromEntries(byMonth.map((r, i) => [r.month, i]));
  for (const o of sold) { const r = byMonth[mIdx[ym(o.dateOrder)]]; r.value += o.amount; if (ds.hasMargin) r.margin += o.margin || 0; r.orders++; }
  const revenue = sum(sold, (o) => o.amount);
  return {
    range, from, to, hasMargin: !!ds.hasMargin,
    total: { revenue, margin: ds.hasMargin ? sum(sold, (o) => o.margin || 0) : null, orders: sold.length, customers: new Set(sold.map((o) => o.partnerId)).size },
    byMonth,
    bySalesperson: group((o) => o.userId, (o) => o.user),
    byCustomer: group((o) => o.partnerId, (o) => o.partner),
    byTeam: group((o) => o.teamId, (o) => teams[o.teamId] || 'No team'),
    orders: sold.map((o) => ({ id: o.id, name: o.name, date: o.dateOrder, partner: o.partner, user: o.user, team: teams[o.teamId] || '',
      company: companies[o.companyId] || '', amount: o.amount, margin: mg(o), invoiceStatus: o.invoiceStatus })),
  };
}

/** Still to invoice: every confirmed order Odoo marks "to invoice" (any date), with the lines left to invoice and how old it is. */
function invoiceDetails(ds, f) {
  const today = f.today;
  const teams = Object.fromEntries(ds.teams.map((t) => [t.id, t.name]));
  const linesBy = new Map();
  for (const l of ds.invoiceLines || []) { if (!linesBy.has(l.orderId)) linesBy.set(l.orderId, []); linesBy.get(l.orderId).push(l); }
  const rows = ds.orders.filter(sliceOf(f)).filter((o) => o.state === 'sale' && o.invoiceStatus === 'to invoice').map((o) => {
    const ls = linesBy.get(o.id) || [];
    return { id: o.id, name: o.name, date: o.dateOrder, age: daysBetween(o.dateOrder, today), partner: o.partner, user: o.user, team: teams[o.teamId] || '',
      amount: o.amount, invoiced: ds.hasInvoiceAmounts ? sum(ls, (l) => l.invoicedAmount || 0) : null, toInvoice: o.toInvoice ?? o.amount,
      lines: ls.filter((l) => !ds.hasInvoiceAmounts || l.toInvoice || l.toInvoiceQty) };
  }).sort((a, b) => b.age - a.age);
  const group = (key) => {
    const g = new Map();
    for (const r of rows) { const k = key(r); const x = g.get(k) || { name: k, value: 0, orders: 0 }; x.value += r.toInvoice; x.orders++; g.set(k, x); }
    return [...g.values()].sort((a, b) => b.value - a.value);
  };
  const ages = [['0–30 days', 0, 30], ['31–60 days', 31, 60], ['61–90 days', 61, 90], ['Over 90 days', 91, Infinity]]
    .map(([name, a, b]) => { const rs = rows.filter((r) => r.age >= a && r.age <= b); return { name, value: sum(rs, (r) => r.toInvoice), orders: rs.length }; });
  return {
    hasAmounts: !!ds.hasInvoiceAmounts, today,
    total: { toInvoice: sum(rows, (r) => r.toInvoice), orders: rows.length, oldest: rows.length ? rows[0].age : null,
      over60: sum(rows.filter((r) => r.age > 60), (r) => r.toInvoice), over60Count: rows.filter((r) => r.age > 60).length },
    ages, bySalesperson: group((r) => r.user), byCustomer: group((r) => r.partner), orders: rows,
  };
}

/** Target details: the opportunities planned in the period (Expected Closing date) with stage, status and the sales orders made from them. */
function targetDetails(ds, f) {
  const today = f.today, t = compute(ds, f).target;
  const leads = ds.leads.filter(sliceOf(f));
  const soByLead = new Map();
  for (const o of ds.orders) {
    if (!o.opportunityId || o.state === 'cancel') continue;
    if (!soByLead.has(o.opportunityId)) soByLead.set(o.opportunityId, []);
    soByLead.get(o.opportunityId).push({ id: o.id, name: o.name, date: o.dateOrder, amount: o.amount, state: o.state });
  }
  const row = (l) => ({ id: l.id, name: l.name, partner: l.partner, user: l.user, stage: l.stage, probability: l.probability, expected: l.expected,
    created: l.created, deadline: l.deadline, closed: l.closed, status: l.status === 'open' && l.deadline && l.deadline < today ? 'late' : l.status,
    orders: (soByLead.get(l.id) || []).sort((a, b) => a.date.localeCompare(b.date)) });
  const planned = leads.filter((l) => l.deadline && inRange(l.deadline, t.from, t.to));
  const ids = new Set(planned.map((l) => l.id));
  const unplanned = leads.filter((l) => l.status === 'won' && inRange(l.closed, t.from, f.to) && !ids.has(l.id));
  return { from: t.from, to: t.to, today, hasOrders: !!ds.hasOpportunityLink, total: t.total, bySalesperson: t.bySalesperson,
    planned: planned.map(row).sort((a, b) => a.deadline.localeCompare(b.deadline) || b.expected - a.expected), unplanned: unplanned.map(row) };
}

module.exports = { compute, details, invoiceDetails, targetDetails, addDays, addMonths, iso };
