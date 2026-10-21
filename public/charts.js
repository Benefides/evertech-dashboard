// Small SVG chart kit: columns, grouped columns, horizontal bars. Hover tooltips, keyboard focus, table view twin.
// Specs: bars <= 24px with 4px rounded data-end, hairline grid, text in ink tokens (never series color).
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const text = (parent, x, y, str, attrs = {}) => { const t = el('text', { x, y, ...attrs }, parent); t.textContent = str; return t; };

// one tooltip for the page
let tip;
function tooltip() {
  if (!tip) { tip = document.createElement('div'); tip.className = 'viz-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
  return tip;
}
function showTip(evt, title, rows, anchor) {
  const t = tooltip();
  t.replaceChildren();
  const h = document.createElement('div'); h.className = 'viz-tip-title'; h.textContent = title; t.appendChild(h);
  for (const r of rows) {
    const line = document.createElement('div'); line.className = 'viz-tip-row';
    if (r.color) { const k = document.createElement('span'); k.className = 'viz-tip-key'; k.style.background = r.color; line.appendChild(k); }
    const v = document.createElement('b'); v.textContent = r.value; line.appendChild(v);
    const l = document.createElement('span'); l.textContent = r.label; line.appendChild(l);
    t.appendChild(line);
  }
  t.style.display = 'block';
  let x, y;
  if (evt && evt.clientX != null && evt.type !== 'focus') { x = evt.clientX; y = evt.clientY; }
  else { const b = anchor.getBoundingClientRect(); x = b.left + b.width / 2; y = b.top; }
  const w = t.offsetWidth, hgt = t.offsetHeight;
  let left = x + 14, top = y - hgt - 10;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  if (top < 8) top = y + 16;
  t.style.left = Math.max(8, left) + 'px'; t.style.top = top + 'px';
}
function hideTip() { if (tip) tip.style.display = 'none'; }
window.addEventListener('scroll', hideTip, { passive: true });

// path for a bar with rounded data-end, square at the baseline
function barPath(x, y, w, h, dir) {
  const r = Math.min(4, Math.abs(dir === 'up' ? h : w) / 2, (dir === 'up' ? w : h) / 2);
  if (dir === 'up') { if (h <= 0) return ''; return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; }
  if (w <= 0) return ''; return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
  return ([1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].find((s) => n <= s)) * p;   // all divide into 4 tidy ticks
}

function hit(g, mark, onTip) {
  mark.setAttribute('tabindex', '0');
  mark.addEventListener('pointermove', (e) => { g.classList.add('hover'); onTip(e); });
  mark.addEventListener('pointerleave', () => { g.classList.remove('hover'); hideTip(); });
  mark.addEventListener('focus', (e) => { g.classList.add('hover'); onTip(e); });
  mark.addEventListener('blur', () => { g.classList.remove('hover'); hideTip(); });
}

/**
 * Vertical columns. series: [{key, name, color}], rows: [{label, short, [key]: number, tip?: [{label,value}]}]
 * One series = simple columns; two = grouped side by side.
 */
export function columns(host, { rows, series, fmt, fmtAxis, height = 240, highlightLast = false, labels = false, line = false, ariaLabel }) {
  const W = Math.max(280, host.clientWidth), H = height;
  const m = { t: labels ? 24 : 18, r: 8, b: 26, l: 46 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const max = niceMax(Math.max(...rows.flatMap((r) => series.map((s) => r[s.key] || 0))));
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': ariaLabel || '' });
  const grid = el('g', { class: 'viz-grid' }, svg);
  for (let i = 0; i <= 4; i++) {
    const y = m.t + ph - (ph * i) / 4;
    el('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: i === 0 ? 'viz-base' : '' }, grid);
    text(grid, m.l - 8, y + 4, fmtAxis((max * i) / 4), { 'text-anchor': 'end', class: 'viz-tick' });
  }
  const band = pw / rows.length;
  const gap = 2, n = series.length;
  const bw = Math.min(24, (band * 0.72 - gap * (n - 1)) / n);
  const groupW = bw * n + gap * (n - 1);
  const every = band < 34 ? 2 : 1;
  rows.forEach((r, i) => {
    const g = el('g', { class: 'viz-mark' + (highlightLast && i === rows.length - 1 ? ' current' : '') }, svg);
    const x0 = m.l + band * i + (band - groupW) / 2;
    series.forEach((s, k) => {
      const v = r[s.key] || 0, h = (v / max) * ph;
      const p = barPath(x0 + k * (bw + gap), m.t + ph - h, bw, h, 'up');
      if (p) el('path', { d: p, fill: s.color, class: 'viz-bar' }, g);
    });
    if (i % every === 0 || i === rows.length - 1) text(svg, m.l + band * i + band / 2, H - 8, r.short || r.label, { 'text-anchor': 'middle', class: 'viz-tick' });
    const hitbox = el('rect', { x: m.l + band * i, y: m.t, width: band, height: ph, fill: 'transparent', class: 'viz-hit', 'aria-label': `${r.label}: ${series.map((s) => `${s.name} ${fmt(r[s.key] || 0)}`).join(', ')}` }, g);
    hit(g, hitbox, (e) => showTip(e, r.label, [...series.map((s) => ({ color: s.color, value: fmt(r[s.key] || 0), label: s.name })), ...(r.tip || [])], hitbox));
  });
  const top = (i) => ({ x: m.l + band * i + band / 2, y: m.t + ph - ((rows[i][series[0].key] || 0) / max) * ph });
  // trend line joining the column tops (single series)
  if (line && n === 1 && rows.length > 1) {
    const g = el('g', { class: 'viz-trend', 'aria-hidden': 'true' }, svg);
    el('path', { d: rows.map((_, i) => `${i ? 'L' : 'M'}${top(i).x.toFixed(1)},${top(i).y.toFixed(1)}`).join('') }, g);
    rows.forEach((_, i) => el('circle', { cx: top(i).x, cy: top(i).y, r: 3 }, g));
  }
  // value on top of every column (every other one when columns are narrow), else only on the last (current) one
  if (labels && n === 1) {
    const step = band < 38 ? 2 : 1;
    rows.forEach((r, i) => {
      if ((rows.length - 1 - i) % step) return;
      text(svg, top(i).x, top(i).y - 8, fmtAxis(r[series[0].key] || 0), { 'text-anchor': 'middle', class: 'viz-label viz-halo' });
    });
  } else if (n === 1 && rows.length) {
    const last = rows[rows.length - 1], v = last[series[0].key] || 0, h = (v / max) * ph;
    text(svg, m.l + band * (rows.length - 1) + band / 2, m.t + ph - h - 6, fmtAxis(v), { 'text-anchor': 'middle', class: 'viz-label' });
  }
  host.replaceChildren(svg);
}

/** Horizontal bars, one series. rows: [{label, value, note?, tip?}] */
export function hbars(host, { rows, color, fmt, ariaLabel, labelWidth }) {
  const W = Math.max(260, host.clientWidth);
  const rowH = 30, bh = 16;
  const lw = labelWidth || Math.min(190, Math.max(96, W * 0.36));
  const vw = 74;
  const H = rows.length * rowH + 4;
  const pw = W - lw - vw - 8;
  // an 'Other' roll-up row is shown as a value only, so it doesn't squash the scale of the named rows
  const max = Math.max(1, ...rows.filter((r) => !r.other).map((r) => r.value));
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': ariaLabel || '' });
  el('line', { x1: lw, x2: lw, y1: 0, y2: rows.filter((r) => !r.other).length * rowH + 4, class: 'viz-base' }, svg);
  rows.forEach((r, i) => {
    const y = i * rowH + (rowH - bh) / 2 + 2;
    const g = el('g', { class: 'viz-mark' + (r.other ? ' other' : '') }, svg);
    const w = r.other ? 0 : (r.value / max) * pw;
    const t = text(g, lw - 10, y + bh / 2 + 4, r.label, { 'text-anchor': 'end', class: 'viz-cat' });
    clip(t, lw - 16);
    const p = r.other ? '' : barPath(lw, y, Math.max(w, r.value > 0 ? 2 : 0), bh, 'right');
    if (p) el('path', { d: p, fill: r.other ? 'var(--viz-other)' : color, class: 'viz-bar' }, g);
    text(g, lw + (r.other ? 0 : w) + 8, y + bh / 2 + 4, fmt(r.value), { class: r.other ? 'viz-label viz-other-label' : 'viz-label' });
    const hb = el('rect', { x: 0, y: i * rowH, width: W, height: rowH, fill: 'transparent', class: 'viz-hit', 'aria-label': `${r.label}: ${fmt(r.value)}` }, g);
    hit(g, hb, (e) => showTip(e, r.label, [{ color: r.other ? 'var(--viz-other)' : color, value: fmt(r.value), label: r.valueLabel || '' }, ...(r.tip || [])], hb));
  });
  host.replaceChildren(svg);
}

// shorten an SVG label to fit (full text stays in tooltip/table)
function clip(t, maxW) {
  requestAnimationFrame(() => {
    try {
      if (t.getComputedTextLength() <= maxW) return;
      const full = t.textContent; let s = full;
      while (s.length > 3 && t.getComputedTextLength() > maxW) { s = s.slice(0, -1); t.textContent = s.trimEnd() + '…'; }
      const title = el('title', {}, t); title.textContent = full;
    } catch (_) { /* not rendered */ }
  });
}

/** Simple accessible table twin for any chart. cols: [{label, get, num}] */
export function table(host, rows, cols) {
  const tbl = document.createElement('table'); tbl.className = 'viz-table';
  const thead = tbl.createTHead().insertRow();
  for (const c of cols) { const th = document.createElement('th'); th.textContent = c.label; if (c.num) th.className = 'num'; thead.appendChild(th); }
  const tb = tbl.createTBody();
  for (const r of rows) {
    const tr = tb.insertRow();
    for (const c of cols) { const td = tr.insertCell(); td.textContent = c.get(r); if (c.num) td.className = 'num'; }
  }
  host.replaceChildren(tbl);
}

/** Tiny 12-point sparkline for stat tiles (de-emphasis line, current point in accent). */
export function sparkline(host, values) {
  const W = 96, H = 28, max = Math.max(1, ...values), min = Math.min(0, ...values);
  const x = (i) => 2 + (i * (W - 6)) / Math.max(1, values.length - 1), y = (v) => H - 4 - ((v - min) / (max - min || 1)) * (H - 8);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', class: 'spark' });
  el('path', { d: values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''), class: 'spark-line' }, svg);
  const li = values.length - 1;
  el('circle', { cx: x(li), cy: y(values[li]), r: 3.5, class: 'spark-dot' }, svg);
  host.replaceChildren(svg);
}
