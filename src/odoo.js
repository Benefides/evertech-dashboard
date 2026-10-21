// Odoo external API client (JSON-RPC, /jsonrpc). Read-only: this app only calls search_read / fields_get / read.
// Needs one Odoo user + API key. On Odoo Online the external API is available on the Custom plan.

const cfg = () => ({
  url: (process.env.ODOO_URL || '').replace(/\/$/, ''),
  db: process.env.ODOO_DB || '',
  login: process.env.ODOO_LOGIN || '',
  key: process.env.ODOO_API_KEY || '',
});

let uidCache = null;
const fieldCache = new Map();

async function rpc(service, method, args) {
  const { url } = cfg();
  const res = await fetch(url + '/jsonrpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Odoo HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) {
    const msg = j.error.data?.message || j.error.message || 'Odoo error';
    const err = new Error(msg); err.odoo = true; throw err;
  }
  return j.result;
}

async function uid() {
  if (uidCache) return uidCache;
  const c = cfg();
  if (!c.url || !c.db || !c.login || !c.key) throw new Error('Odoo is not configured: set ODOO_URL, ODOO_DB, ODOO_LOGIN and ODOO_API_KEY (or DEMO=1).');
  const u = await rpc('common', 'login', [c.db, c.login, c.key]);
  if (!u) throw new Error('Odoo login failed: check ODOO_DB, ODOO_LOGIN and ODOO_API_KEY.');
  uidCache = u;
  return u;
}

async function call(model, method, args = [], kwargs = {}) {
  const c = cfg();
  return rpc('object', 'execute_kw', [c.db, await uid(), c.key, model, method, args, kwargs]);
}

/** Field names that exist on a model (so the same code works on Odoo 16, 17, 18, 19). */
async function fieldsOf(model) {
  if (!fieldCache.has(model)) {
    try {
      const f = await call(model, 'fields_get', [], { attributes: ['type'] });
      fieldCache.set(model, new Set(Object.keys(f)));
    } catch (e) {
      if (/doesn't exist|does not exist|not found/i.test(e.message)) fieldCache.set(model, null);
      else throw e;
    }
  }
  return fieldCache.get(model);
}
async function hasModel(model) { return (await fieldsOf(model)) !== null; }
async function pick(model, wanted) {
  const have = await fieldsOf(model);
  return have ? wanted.filter((f) => have.has(f)) : [];
}

/** search_read every matching record, 2,000 at a time. */
async function readAll(model, domain, fields, context = {}, order = 'id') {
  const out = [];
  const limit = 2000;
  for (let offset = 0; ; offset += limit) {
    const batch = await call(model, 'search_read', [domain], { fields, limit, offset, order, context });
    out.push(...batch);
    if (batch.length < limit) break;
  }
  return out;
}

function reset() { uidCache = null; fieldCache.clear(); }

module.exports = { call, readAll, fieldsOf, pick, hasModel, uid, reset, configured: () => { const c = cfg(); return !!(c.url && c.db && c.login && c.key); } };
