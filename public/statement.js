// Statement of Account: /statement.html?partner=12 (or partner=12,34,56 for one page per customer; 12_34 = one customer held twice in Odoo),
// optional &company=1, &print=1 opens the print dialog.
// Edit mode: every text can be changed and invoices left out before printing; totals, ageing and the letter follow.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (s) => { if (!s) return ''; const [y, m, d] = s.split('-'); return `${d}-${MON[m - 1]}-${y}`; };   // 27-Oct-2026
const amt = (v) => (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const AGES = [['Not due', 0, 0], ['1-30 days', 1, 30], ['31-60 days', 31, 60], ['61-90 days', 61, 90], ['Over 90 days', 91, Infinity]];

const q = new URLSearchParams(location.search);
const ids = (q.get('partner') || '').split(',').filter((g) => /^\d+(_\d+)*$/.test(g));
const company = q.get('company') || '';
$('#back').href = '/' + (q.get('back') ? '#' + q.get('back') : '');

// the standard texts you change are remembered on this computer for the next statements (customer details and amounts are not)
const KEEP = ['greeting', 'closing', 'query', 'regards', 'signature'];
const store = {
  get(k) { try { return localStorage.getItem('soa.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('soa.' + k, v); } catch { /* private mode */ } },
  clear() { try { for (const k of KEEP) localStorage.removeItem('soa.' + k); } catch { /* ignore */ } },
};

let PAGES = [];   // [{ d, excluded:Set, letterEdited:boolean }]

function letterText(d, total, overdue) {
  const cur = d.currency?.name || 'AED';
  return `Please find below the statement of your account as at ${dmy(d.date)}. Our records show an outstanding balance of ${cur} ${amt(total)}`
    + (overdue > 0 ? `, of which ${cur} ${amt(overdue)} is overdue. We would appreciate your settlement of the overdue amount at your earliest convenience.`
      : '. Kindly arrange payment by the due dates shown below.')
    + ' If you have already made payment, please disregard this reminder and send us the remittance advice.';
}

function pageHtml(p, i) {
  const d = p.d, c = d.customer, s = d.soa, cur = d.currency?.name || 'AED';
  const addr = [c.street, c.street2, [c.city, c.state, c.zip].filter(Boolean).join(' '), c.country && c.country !== 'United Arab Emirates' ? c.country : ''].filter(Boolean).join('\n');
  const kept = (k, def) => store.get(k) ?? def;
  const lines = [...d.lines].sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));   // newest first
  const ed = (k, html, tag = 'div', cls = '') => `<${tag} class="${cls}" data-ed="${k}">${html}</${tag}>`;
  return `<section class="page" data-p="${i}">
    <div class="top">${ed('company', esc(s.company), 'div', 'co')}
      <div class="title"><h1>Statement of Account</h1>${ed('asat', `As at ${dmy(d.date)}`, 'div', 'asat')}</div></div>
    <div class="cust">${ed('name', esc(c.name), 'div', 'name')}${ed('addr', esc(addr), 'div', 'addr')}</div>
    ${ed('greeting', esc(kept('greeting', s.greeting)), 'p', 'greet')}
    ${ed('letter', '', 'p', 'letter')}
    <table class="inv"><thead><tr><th class="sel"></th><th>Invoice no</th><th>Date</th><th>Order no</th><th>Product</th><th class="r">Amount incl.<br>VAT (${esc(cur)})</th><th>Due date</th><th class="r">Overdue<br>days</th></tr></thead>
      <tbody>${lines.map((l) => `<tr data-id="${l.id}" class="${l.type === 'refund' ? 'credit' : ''}">
          <td class="sel"><input type="checkbox" checked aria-label="Include ${esc(l.name)}"></td>
          <td class="nw">${esc(l.name)}${l.type === 'refund' ? ' <small>(credit note)</small>' : ''}</td><td class="nw">${dmy(l.date)}</td>
          <td data-ed="ref">${esc(l.ref)}</td><td data-ed="product">${esc(l.product)}</td>
          <td class="r">${amt(l.amount)}</td><td class="nw">${dmy(l.due)}</td><td class="od">${l.overdue > 0 ? l.overdue : ''}</td></tr>`).join('')
        || '<tr><td class="sel"></td><td colspan="7">No outstanding invoices.</td></tr>'}
        <tr class="tot"><td class="sel"></td><td colspan="4">Total outstanding</td><td class="r" data-v="total"></td><td></td><td></td></tr>
        <tr class="odr"><td class="sel"></td><td colspan="4">of which overdue</td><td class="r" data-v="overdue"></td><td></td><td></td></tr></tbody></table>
    <table class="age"><thead><tr><th>Ageing (${esc(cur)})</th>${AGES.map(([n]) => `<th>${n}</th>`).join('')}</tr></thead>
      <tbody><tr><td></td>${AGES.map((_, k) => `<td data-age="${k}"></td>`).join('')}</tr></tbody></table>
    <div class="closing">${ed('closing', esc(kept('closing', s.closing)), 'p')}${ed('query', esc(kept('query', s.query)), 'p')}${ed('regards', esc(kept('regards', 'Kind regards,')), 'p')}</div>
    ${ed('signature', esc(kept('signature', [s.signature, s.company, s.email].filter(Boolean).join('\n'))), 'div', 'sign')}
  </section>`;
}

// totals, "of which overdue", ageing and the letter from the invoices still ticked
function recalc(i) {
  const p = PAGES[i], el = $(`.page[data-p="${i}"]`);
  const inc = p.d.lines.filter((l) => !p.excluded.has(String(l.id)));
  const total = inc.reduce((a, l) => a + l.amount, 0), overdue = inc.filter((l) => l.overdue > 0).reduce((a, l) => a + l.amount, 0);
  $('[data-v="total"]', el).textContent = amt(total);
  $('[data-v="overdue"]', el).textContent = amt(overdue);
  $('tr.odr', el).style.display = overdue > 0 ? '' : 'none';
  AGES.forEach(([, a, b], k) => { $(`[data-age="${k}"]`, el).textContent = amt(inc.filter((l) => l.overdue >= a && l.overdue <= b).reduce((s, l) => s + l.amount, 0)); });
  if (!p.letterEdited) $('[data-ed="letter"]', el).textContent = letterText(p.d, total, overdue);
}

function render() {
  $('#out').innerHTML = PAGES.map(pageHtml).join('');
  PAGES.forEach((p, i) => {
    const el = $(`.page[data-p="${i}"]`);
    recalc(i);
    $$('tbody tr[data-id] input', el).forEach((cb) => {
      cb.onchange = () => { const tr = cb.closest('tr'); tr.classList.toggle('excluded', !cb.checked); cb.checked ? p.excluded.delete(tr.dataset.id) : p.excluded.add(tr.dataset.id); recalc(i); changed(); };
    });
    $$('[data-ed]', el).forEach((n) => n.addEventListener('input', () => {
      const k = n.dataset.ed;
      if (k === 'letter') p.letterEdited = true;
      if (KEEP.includes(k)) store.set(k, n.innerText.replace(/\n$/, ''));
      changed();
    }));
  });
  setEditing(editing);
}

let editing = false;
function setEditing(on) {
  editing = on;
  document.body.classList.toggle('editing', on);
  $('#edit').setAttribute('aria-pressed', on);
  $('#edit').textContent = on ? '✓ Done editing' : '✎ Edit';
  $$('[data-ed]').forEach((n) => (on ? n.setAttribute('contenteditable', 'true') : n.removeAttribute('contenteditable')));
  $('#hint').textContent = on ? 'Click any text to change it. Untick an invoice to leave it out; totals, ageing and the letter update. Greeting, closing and signature changes are remembered on this computer.'
    : 'Click Edit to change any text or leave out invoices before printing. Choose "Save as PDF" in the print window to get a file.';
}
function changed() { $('#reset').hidden = false; }

$('#edit').onclick = () => setEditing(!editing);
$('#print').onclick = () => { setEditing(false); setTimeout(() => print(), 50); };
$('#reset').onclick = () => {
  if (!confirm('Undo all changes on this statement and go back to the standard texts?')) return;
  store.clear();
  PAGES = PAGES.map((p) => ({ d: p.d, excluded: new Set(), letterEdited: false }));
  render(); $('#reset').hidden = true;
};

async function run() {
  if (!ids.length) { $('#out').innerHTML = '<div class="err">No customer chosen. Open a statement from the Invoices screen of the dashboard.</div>'; return; }
  try {
    const list = await Promise.all(ids.map(async (id) => {
      const res = await fetch(`/api/statement?partner=${id}${company ? '&company=' + encodeURIComponent(company) : ''}`, { credentials: 'same-origin' });
      if (res.status === 401) throw new Error('Please sign in to the dashboard first, then open the statement again.');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Error ${res.status}`);
      if (!d.available) throw new Error(d.error ? `Odoo said: ${d.error}` : 'Invoices are not available from Odoo for this user.');
      return d;
    }));
    PAGES = list.map((d) => ({ d, excluded: new Set(), letterEdited: false }));
    render();
    // the browser offers this as the PDF file name: "Statement - Berger Paints - 2026-10-27"
    document.title = list.length === 1 ? `Statement - ${list[0].customer.name} - ${list[0].date}` : `Statements of Account - ${list[0].date}`;
    if (q.get('print') === '1') setTimeout(() => print(), 300);
  } catch (e) {
    $('#out').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}
run();
