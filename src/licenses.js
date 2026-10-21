// Licence renewals (Microsoft, Fortinet, …): which sales order lines are licences/subscriptions, whose they are and how long they run.
// A line is a licence when its product/description names a vendor keyword AND looks like a licence (licence, subscription, 1 Year, -12 SKU …),
// so hardware such as "FortiGate 100F" or a Surface laptop isn't counted.

const DEFAULT_VENDORS = 'Microsoft=microsoft,m365,office 365,o365,azure,exchange online,windows server,dynamics 365; Fortinet=fortinet,forti';
const vendors = (process.env.LICENSE_VENDORS || DEFAULT_VENDORS).split(';').map((s) => {
  const [name, kw = ''] = s.split('=');
  return { name: name.trim(), keywords: kw.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean) };
}).filter((v) => v.name && v.keywords.length);

const HINT = new RegExp(process.env.LICENSE_HINT || String.raw`licen[cs]e|subscription|renewal|annual|yearly|\d+\s*-?\s*(?:years?|yrs?|months?)|\b365\b|\bnce\b|\bcsp\b|forticare|fortiguard|\butp\b|\bent\b|bundle|\bbdl\b|-(?:12|24|36|48|60)\b`, 'i');
const EXCLUDE = new RegExp(process.env.LICENSE_EXCLUDE || String.raw`perpetual|\boem\b|install|implementation|configuration|migration|training|survey`, 'i');
const DEFAULT_TERM = Number(process.env.LICENSE_TERM_MONTHS || 12);
const FROM = process.env.LICENSE_EXPIRY_FROM || 'confirmed'; // 'confirmed' (order confirmation date) or 'created'
const LOOKBACK_MONTHS = 64; // longest usual term (5 years) + the 120 days of expired licences the dashboard still shows

/** Term in months from the product text: "3 Year", "36 Months", "annual", Fortinet SKU "FC-10-F100F-247-02-36"; monthly → 1. */
function termMonths(text) {
  const t = String(text || '').toLowerCase();
  let m;
  if ((m = t.match(/\b(\d{1,2})\s*-?\s*(?:years?|yrs?)\b/))) return Number(m[1]) * 12;
  if ((m = t.match(/\b(\d{1,2})\s*-?\s*(?:months?|mos?)\b/))) return Number(m[1]);
  if ((m = t.match(/\b(?:fc|fg|fp|fwf|fap|fsw|fml|faz|fmg|fct|fs|fsa|fac|lic)\d*-[a-z0-9-]*?-(12|24|36|48|60)\b/))) return Number(m[1]);
  if (/\bmonthly\b|per month|\/\s*month/.test(t)) return 1;
  if (/annual|yearly|\b1\s*yr\b/.test(t)) return 12;
  return DEFAULT_TERM;
}

/** { vendor, termMonths } for a licence line, or null. Monthly subscriptions are left out (they renew every month). */
function classify(text) {
  const t = String(text || '').toLowerCase();
  const v = vendors.find((x) => x.keywords.some((k) => t.includes(k)));
  if (!v || !HINT.test(t) || EXCLUDE.test(t)) return null;
  const term = termMonths(t);
  return term > 1 ? { vendor: v.name, termMonths: term } : null;
}

/** Licence records from order lines ({ id, orderId, product, text, qty, subtotal }) and their orders (normalised, by id). */
function build(lines, orderById) {
  const out = [];
  for (const l of lines) {
    const o = orderById.get(l.orderId);
    const c = o && o.state === 'sale' && classify(`${l.product} ${l.text || ''}`);
    if (!c) continue;
    out.push({ id: l.id, orderId: o.id, order: o.name, partnerId: o.partnerId, partner: o.partner, userId: o.userId, user: o.user,
      teamId: o.teamId, companyId: o.companyId, vendor: c.vendor, termMonths: c.termMonths, product: l.product, qty: l.qty, amount: l.subtotal,
      start: FROM === 'created' ? o.created : o.dateOrder });
  }
  return out;
}

module.exports = { vendors, classify, termMonths, build, FROM, LOOKBACK_MONTHS };
