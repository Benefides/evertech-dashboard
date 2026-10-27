// Statement of Account: /statement.html?partner=12 (or partner=12,34,56 for one page per customer), optional &company=1, &print=1 opens the print dialog.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (s) => { if (!s) return ''; const [y, m, d] = s.split('-'); return `${d}-${MON[m - 1]}-${y.slice(2)}`; };   // 26-Oct-26, like the printed SOA
const amt = (v) => (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const q = new URLSearchParams(location.search);
const ids = (q.get('partner') || '').split(',').map(Number).filter(Boolean);
const company = q.get('company') || '';
$('#print').onclick = () => print();
$('#back').href = '/' + (q.get('back') ? '#' + q.get('back') : '');

function page(d) {
  const c = d.customer, s = d.soa, cur = d.currency?.name || 'AED';
  const addr = [c.street, c.street2, [c.city, c.state, c.zip].filter(Boolean).join(' '), c.country && c.country !== 'United Arab Emirates' ? c.country : ''].filter(Boolean);
  const rows = d.lines.map((l) => `<tr class="${l.type === 'refund' ? 'credit' : ''}"><td class="nw">${esc(l.name)}</td><td class="c nw">${dmy(l.date)}</td><td class="c">${esc(l.ref)}</td>
    <td class="c">${esc(l.type === 'refund' ? 'Credit note' + (l.product ? ' – ' + l.product : '') : l.product)}</td><td class="r">${amt(l.amount)}</td><td class="c nw">${dmy(l.due)}</td>
    <td class="od">${l.overdue > 0 ? `${l.overdue} day${l.overdue === 1 ? '' : 's'}` : ''}</td></tr>`).join('');
  return `<section class="page">
    <img class="logo" src="/logo.png" alt="${esc(s.company)}">
    <div class="head"><h1>STATEMENT OF ACCOUNT</h1><span class="date">${dmy(d.date)}</span></div>
    <div class="cust"><b>Customer:</b><div>${esc(c.name)}${addr.map((a) => '<br>' + esc(a)).join('')}</div></div>
    <p class="attn">Attn: ${esc(s.attn)}</p>
    <p class="note">${esc(s.note)}</p>
    <table><thead><tr><th>INV No.</th><th>Date</th><th>Order Ref.</th><th>Product</th><th>Amount (${esc(cur)})</th><th>Due Date</th><th>Overdue</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="c">No outstanding invoices.</td></tr>'}
        <tr class="band"><td></td><td></td><td></td><td></td><td class="r">${amt(d.total)}</td><td></td><td></td></tr>
        <tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr></tbody></table>
    <div class="total"><span>Total Outstanding</span><span>${amt(d.total)}</span></div>
    ${d.overdue > 0 ? `<div class="overdue-sum">Of which overdue: ${esc(cur)} ${amt(d.overdue)}</div>` : ''}
    <div class="sign"><b>${esc(s.signature)}</b><b>${esc(s.company)}</b><span>${esc(s.email)}</span></div>
  </section>`;
}

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
    $('#out').innerHTML = list.map(page).join('');
    document.title = list.length === 1 ? `SOA - ${list[0].customer.name} - ${dmy(list[0].date)}` : `Statements of Account - ${dmy(list[0].date)}`;
    if (q.get('print') === '1') setTimeout(() => print(), 300);
  } catch (e) {
    $('#out').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}
run();
