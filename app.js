/* Advanced Physics — PWA shell.

   Reads index.json (written by Admin/app/deploy.py).  The look is calc's and
   astro's (Ryan, 2026-11-04): a rail on the left with three tabs --
     Schedule   every class day in Units 1-3, built or not, in collapsible units
     Labs       each lab with its handout and date
     Reference  the calculus primer
   -- and a reader on the right: the day's head, a chip per document, and the
   document itself.  At phone width the rail is the home screen; a day opens full
   screen with a back arrow.  On a computer the next class day opens by itself.

   Routes (hash, so every view is a deep link):
     #schedule  #labs  #ref         a rail tab
     #day=<key>[&doc=<file>]        a day, on one of its documents
     #doc=<file>[&at=<anchor>]      a document (search hits, older links)

   PDFs on iPhone and iPad: an iframe shows only page 1 there, and handing the
   PDF to the system (target=_blank) strands the installed home-screen app on a
   bare PDF with no way back (Ryan, 2026-10-29: "no return path if i open
   pdfs").  So there the reader draws every page itself with the bundled
   PDF.js (lib/, precached by sw.js, works offline).  Add ?pdfjs=1 to the URL
   to force that path on any browser for testing.

   Documents are requested as  q/foo.html?h=<hash>  so a changed document is a
   different URL and the service worker can cache-first without going stale. */

const DOCS_CACHE = 'advphys-docs-v1';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const docURL = it => `${it.file}?h=${it.hash.slice(0, 12)}`;

const S = { idx: null, tab: 'schedule', cached: new Set(), offline: false, route: null, rows: new Map() };

// ───────────────────────────────────────────────────────────── loading ──

async function load() {
  try {
    const res = await fetch('index.json', { cache: 'no-store' });
    S.offline = res.headers.get('X-From-Cache') === '1';
    S.idx = await res.json();
  } catch (e) {
    S.offline = true;
    $('#bootmsg').textContent = 'Offline, and nothing is saved yet. Open the app once with a connection.';
    renderNet(); return;
  }
  // Every row gets a key for its #day= route.  Reference documents become rows of one.
  S.idx.units.forEach(u => u.rows.forEach((r, i) => { r.key = `u${u.n}-${i}`; r.unit = u.n; S.rows.set(r.key, r); }));
  (S.idx.labs || []).forEach((r, i) => { r.key = `lab-${i}`; S.rows.set(r.key, r); });
  S.refs = (S.idx.reference || []).map((it, i) => ({ kind: 'ref', key: `ref-${i}`, name: it.label, items: [it] }));
  S.refs.forEach(r => S.rows.set(r.key, r));
  $('#meets').textContent = S.idx.meets || 'Block 3';
  if (isPhone()) $('#search').placeholder = 'Search';
  await refreshCached();
  buildSearch();
  document.body.classList.add('ready');
  route();
  renderNet();
}

async function refreshCached() {
  S.cached = new Set();
  if (!('caches' in window)) return;
  try {
    const c = await caches.open(DOCS_CACHE);
    for (const r of await c.keys()) {
      const u = new URL(r.url);
      S.cached.add(decodeURIComponent(u.pathname.split('/').slice(-2).join('/')) + u.search);
    }
  } catch (e) { /* private window: no cache, nothing to mark */ }
}
const isCached = it => S.cached.has(docURL(it));

// ─────────────────────────────────────────────────────────────── dates ──

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const allRows = () => S.idx.units.flatMap(u => u.rows);
const nextDate = () => (allRows().find(r => r.date && r.date >= todayISO()) || {}).date;

// ───────────────────────────────────────────────────────────── helpers ──

// iPadOS reports itself as a Mac; touch points give it away.
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const PDFJS = IOS || /[?&]pdfjs=1\b/.test(location.search);
const STANDALONE = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isPDF = it => it.file.endsWith('.pdf');
const isPhone = () => matchMedia('(max-width:760px)').matches;
const tabOf = r => r.key.startsWith('lab-') ? 'labs' : r.key.startsWith('ref-') ? 'ref' : 'schedule';

const sectionHasHW = code => allRows().some(r => r.kind === 'hwday' && r.code === code);
const rowTitle = r => r.kind === 'lab' ? `${r.code}: ${r.name}`
  : r.kind === 'hwday' ? `${r.code} ${r.title} · HW day`
  : r.code ? `${r.code} ${r.name}${r.part > 1 ? ` · day ${r.part}` : ''}` : r.name;
// "Wed 11/4" -> ["11/4", "Wed"]
const dateParts = r => { const m = /^(\w+)\s+(.+)$/.exec(r.label || ''); return m ? [m[2], m[1]] : [r.label || '', '']; };
const emptyText = r => r.kind === 'lab' && r.handout === false ? 'Handout in class'
  : (r.kind === 'lesson' || r.kind === 'lab' || r.kind === 'hwday') ? 'Materials coming' : '';

function tags(r, withItems) {
  const t = [];
  if (r.date && r.date === todayISO()) t.push('<span class="tag today">Today</span>');
  if (r.kind === 'hwday') t.push('<span class="tag hw">HW day</span>');
  else if (r.part > 1 || (r.kind === 'lesson' && sectionHasHW(r.code))) t.push(`<span class="tag">Day ${r.part}</span>`);
  if (r.kind === 'lab') t.push('<span class="tag lab">Lab</span>');
  if (withItems) {
    const items = r.items || [];
    if (items.length) {
      const saved = items.every(isCached) ? '<span class="ok" title="Saved for offline"></span>' : '';
      t.push(`${saved}<span>${items.length} item${items.length > 1 ? 's' : ''}</span>`);
    } else if (emptyText(r)) t.push(`<span>${emptyText(r)}</span>`);
  }
  return t.join('');
}

// ──────────────────────────────────────────────────────────────── rail ──

// Units the student has opened or closed on this device. A unit never touched follows
// the default (the current unit open), so the default moves with the year.
let unitState = {};
try { unitState = JSON.parse(localStorage.getItem('advphys-units')) || {}; } catch (e) { /* defaults */ }
function currentUnit() {
  const next = nextDate();
  const u = next && S.idx.units.find(u => u.rows.some(r => r.date === next));
  return (u || S.idx.units[S.idx.units.length - 1]).n;
}

const CHEV = '<span class="chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg></span>';

function rowHTML(r, onKey) {
  if (r.kind === 'break') return `<div class="brk">${esc(r.text)}</div>`;
  const on = r.key === onKey ? ' on' : '';
  const past = r.date && r.date < todayISO() ? ' past' : '';
  if (r.kind === 'quiz' || r.kind === 'test')
    return `<button class="assess ${r.kind}${on}${past}" data-go="#day=${r.key}">${esc(r.name)}<span>${esc(r.label || '')}</span></button>`;
  const [md, dow] = dateParts(r);
  const code = (r.kind === 'lesson' || r.kind === 'hwday' || r.kind === 'lab') && r.code ? `<span class="dcode">${esc(r.code)}</span>` : '';
  const title = r.kind === 'hwday' ? r.title : r.name;
  const empty = (r.items || []).length ? '' : ' empty';
  const today = r.date === todayISO() ? ' today' : '';
  return `<button class="drow${on}${past}${empty}${today}" data-go="#day=${r.key}">` +
    `<div class="ddate">${esc(md || '—')}<i>${esc(dow)}</i></div>` +
    `<div class="dmeta"><div class="dtitle">${code}${esc(title)}</div><div class="dsub">${tags(r, true)}</div></div></button>`;
}

function renderRail() {
  document.querySelectorAll('#tabs .utab').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const body = $('#railbody');
  const keep = body.dataset.tab === S.tab ? railScroll : null;     // hidden while reading on a phone, so remembered
  const onKey = S.route && S.route.row ? S.route.row.key : null;
  const onRow = onKey && S.rows.get(onKey);
  let h = '';
  if (S.tab === 'schedule') {
    const next = nextDate(), cur = currentUnit();
    let nowPlaced = false;
    for (const u of S.idx.units) {
      const classes = u.rows.filter(r => r.kind !== 'break').length;
      const open = (u.n in unitState ? unitState[u.n] : u.n === cur) || (onRow && onRow.unit === u.n && !isPhone());
      h += `<details class="ufold" data-unit="${u.n}"${open ? ' open' : ''}>` +
           `<summary class="unit">${CHEV}<b>Unit ${u.n} · ${esc(u.title)}</b><span class="n">${classes}</span></summary>`;
      const earlier = u.rows.filter(r => r.kind !== 'break' && !r.date);
      if (earlier.length)
        h += `<details class="earlier"${onRow && earlier.includes(onRow) ? ' open' : ''}><summary>Earlier in Unit ${u.n} (${earlier.length})</summary>${earlier.map(r => rowHTML(r, onKey)).join('')}</details>`;
      u.rows.filter(r => r.kind === 'break' || r.date).forEach((r, i) => {
        if (!nowPlaced && r.date && r.date === next) {
          nowPlaced = true;
          if (next !== todayISO() && i > 0) h += '<div class="nowline">Today</div>';
        }
        h += rowHTML(r, onKey);
      });
      h += '</details>';
    }
  } else if (S.tab === 'labs') {
    h = '<div class="rsec">Labs</div>' + (S.idx.labs || []).map(r => rowHTML(r, onKey)).join('');
  } else {
    h = '<div class="rsec">Reference</div>' + (S.refs.length ? S.refs.map(r => rowHTML(r, onKey)).join('')
      : '<div class="drow empty"><div class="ddate"></div><div class="dmeta"><div class="dtitle">Calculus primer</div><div class="dsub">Materials coming</div></div></div>');
  }
  body.innerHTML = h;
  if (keep !== null) body.scrollTop = keep;
  else {
    body.scrollTop = 0;
    body.dataset.tab = S.tab;
    const target = body.querySelector('.drow.on, .assess.on') || (S.tab === 'schedule' &&
      [...body.querySelectorAll('[data-go]')].find(b => { const r = S.rows.get(b.dataset.go.slice(5)); return r && r.date === nextDate(); }));
    if (target && target.offsetParent) target.scrollIntoView({ block: 'center' });
  }
  renderSave();
}

// ────────────────────────────────────────────────────────────── reader ──

/** Mount each document of the open day once and toggle by [hidden].  Never
 *  destroy while the day is open -- a reloaded iframe loses its widget state
 *  (calc's mountFrames rule). */
function renderReader() {
  const r = S.route, head = $('#dochead'), chips = $('#chips'), stage = $('#stage');
  if (!r.row) { head.innerHTML = ''; chips.innerHTML = ''; stage.innerHTML = ''; stage.dataset.key = ''; return; }
  const row = r.row, items = row.items || [];
  const it = items.find(x => x.file === r.file) || items[0];
  const kicker = [row.label || (row.unit ? `Earlier in Unit ${row.unit}` : ''), row.unit ? `Unit ${row.unit}` : ''].filter(Boolean).join(' · ');
  const url = it ? docURL(it) + (r.at ? `#${r.at}` : '') : '';
  const tools = it ? `<div class="dh-tools">` +
    (document.fullscreenEnabled ? `<button class="iconbtn" id="present" title="Present (full screen)  F" aria-label="Present (full screen)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>` : '') +
    (IOS && STANDALONE ? '' :            // a new tab there is the same dead end
      `<a class="iconbtn" href="${esc(url)}" target="_blank" rel="noopener" title="Open in a new tab" aria-label="Open in a new tab"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>`) +
    '</div>' : '';
  head.innerHTML = `<div class="dh-main"><div class="dh-kicker">${esc(kicker)}${tags(row, false)}</div>` +
    `<h1 class="dh-title">${esc(rowTitle(row))}</h1>${row.topics ? `<div class="dh-sub">${esc(row.topics)}</div>` : ''}</div>${tools}`;
  chips.innerHTML = items.length > 1 || (items.length === 1 && row.kind !== 'ref')
    ? items.map(d => `<button class="chip${d === it ? ' on' : ''}" role="tab" data-file="${esc(d.file)}">${isCached(d) ? '<span class="ok" title="Saved for offline"></span>' : ''}${esc(d.label)}</button>`).join('')
    : '';

  if (stage.dataset.key !== row.key) { stage.innerHTML = ''; stage.dataset.key = row.key; }
  if (!it) {
    stage.innerHTML = `<div class="pane"><div class="emptyday"><b>${esc(emptyText(row) || 'Nothing to open for this day.')}</b>${row.topics ? esc(row.topics) : ''}</div></div>`;
    return;
  }
  let f = [...stage.children].find(x => x.dataset.file === it.file);
  if (!f && PDFJS && isPDF(it)) {
    f = document.createElement('div');
    f.className = 'pdfview';
    f.dataset.file = it.file;
    f.setAttribute('aria-label', it.label);
    stage.appendChild(f);
    drawPDF(f, docURL(it));
  } else if (!f) {
    f = document.createElement('iframe');
    f.dataset.file = it.file;
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('aria-label', it.label);
    stage.appendChild(f);
  }
  if (f.tagName === 'IFRAME' && (!f.src || r.at)) f.src = url;
  [...stage.children].forEach(x => { x.hidden = x !== f; });
}

/** Draw every page of a PDF into `box`, page by page, at the box's width. */
async function drawPDF(box, url) {
  box.innerHTML = '<p class="pdfmsg">Opening&hellip;</p>';
  try {
    const lib = await import('./lib/pdf.min.js');
    lib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
    const pdf = await lib.getDocument({ url, disableRange: true, disableStream: true }).promise;
    box.innerHTML = '';
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.max(box.clientWidth - 16, 280);
    for (let n = 1; n <= pdf.numPages && box.isConnected; n++) {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: (width * dpr) / page.getViewport({ scale: 1 }).width });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      c.setAttribute('aria-label', `Page ${n} of ${pdf.numPages}`);
      box.appendChild(c);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    }
  } catch (e) {
    box.innerHTML = '<p class="pdfmsg">This PDF could not be shown. Connect to the internet once, then try again.</p>';
  }
}

function present() {
  const st = $('#stage');
  if (S.route && S.route.row && st.requestFullscreen && !document.fullscreenElement) st.requestFullscreen().catch(() => {});
}

// ─────────────────────────────────────────────────────── save for offline ──

const everyItem = () => [...allRows().flatMap(r => r.items || []), ...(S.idx.reference || [])]
  .filter((it, i, a) => a.findIndex(o => o.file === it.file) === i);

function renderSave() {
  const all = everyItem(), b = $('#savebtn');
  if (!all.length || !('caches' in window)) { b.hidden = true; $('#savenote').textContent = ''; return; }
  const saved = all.filter(isCached).length;
  if (!b.disabled) b.textContent = saved < all.length ? 'Save everything for offline' : 'Everything is saved';
  b.hidden = false;
  $('#savenote').textContent = `${saved} of ${all.length} documents saved on this device`;
}

async function saveAll() {
  const b = $('#savebtn');
  b.disabled = true;
  const todo = everyItem().filter(it => !isCached(it));
  let done = 0;
  for (const it of todo) {
    b.textContent = `Saving ${++done}/${todo.length}…`;
    try { await fetch(docURL(it)); } catch (e) { break; }
  }
  b.disabled = false;
  await refreshCached();
  renderRail();
}

// ────────────────────────────────────────────────────────────── search ──

const fold = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const hl = (s, q) => { const i = fold(s).indexOf(q); return i < 0 ? esc(s)
  : esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length)); };

let INDEX = [];
function buildSearch() {
  INDEX = [];
  for (const r of [...allRows(), ...(S.idx.labs || []), ...S.refs]) {
    if (r.kind === 'break' || r.kind === 'hwday' || r.part > 1) continue;
    if (r.key.startsWith('lab-') && r.date) continue;      // dated labs are found in the schedule
    const title = r.kind === 'lesson' ? `${r.code} ${r.name}` : r.kind === 'lab' ? `${r.code}: ${r.name}` : r.name;
    INDEX.push({ t: title, k: r.topics || '', s: [r.label || (r.unit ? `Unit ${r.unit}` : 'Reference'), r.topics].filter(Boolean).join(' · '), h: `#day=${r.key}` });
  }
  for (const s of S.idx.search || [])
    for (const sec of s.sections)
      INDEX.push({ t: sec.text, k: '', s: `in ${s.title}`, h: `#doc=${encodeURIComponent(s.file)}&at=${encodeURIComponent(sec.id)}` });

  const inp = $('#search'), box = $('#results');
  let sel = 0, hits = [], q = '';
  inp.oninput = () => {
    q = fold(inp.value.trim());
    if (!q) { box.classList.remove('open'); return; }
    hits = INDEX.filter(x => fold(x.t + ' ' + x.k).includes(q)).slice(0, 14);
    sel = 0; draw();
  };
  function draw() {
    box.innerHTML = hits.length ? '' : '<div class="res"><span>No matches</span></div>';
    hits.forEach((x, i) => {
      const b = document.createElement('button');
      b.className = 'res' + (i === sel ? ' on' : '');
      b.innerHTML = `<b>${hl(x.t, q)}</b><span>${hl(x.s, q)}</span>`;
      b.onmousedown = e => { e.preventDefault(); pick(x); };
      box.appendChild(b);
    });
    box.classList.add('open');
  }
  function pick(x) {
    box.classList.remove('open'); inp.value = ''; inp.blur();
    if (location.hash === x.h) route(); else location.hash = x.h;
  }
  inp.onkeydown = e => {
    if (e.key === 'ArrowDown') { sel = Math.min(hits.length - 1, sel + 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    if (e.key === 'Enter' && hits[sel]) pick(hits[sel]);
    if (e.key === 'Escape') { inp.value = ''; box.classList.remove('open'); inp.blur(); }
  };
  inp.onblur = () => setTimeout(() => box.classList.remove('open'), 150);
}

// ─────────────────────────────────────────────────────────────── routing ──

function parseHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  const p = {};
  h.split('&').forEach(kv => { const i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i)] = kv.slice(i + 1); });
  if (p.day && S.rows.has(p.day)) return { row: S.rows.get(p.day), file: p.doc || null, at: p.at || null };
  if (p.doc) {
    // A document link: the schedule day that carries it (the first one), else a lab or reference row.
    const rows = [...allRows(), ...(S.idx.labs || []), ...S.refs];
    const row = rows.find(r => (r.items || []).some(it => it.file === p.doc));
    if (row) return { row, file: p.doc, at: p.at || null };
  }
  return { tab: ['schedule', 'labs', 'ref'].includes(h) ? h : 'schedule' };
}

/** The day a tab opens on, on a computer: the next class (or lab), else the last. */
function defaultRow(tab) {
  const t = todayISO();
  if (tab === 'ref') return S.refs[0];
  const rows = tab === 'labs' ? (S.idx.labs || []) : allRows().filter(r => r.kind !== 'break' && r.date);
  return rows.find(r => r.date && r.date >= t) || rows[rows.length - 1];
}

function route() {
  if (!S.idx) return;
  let r = parseHash();
  if (r.tab && !isPhone()) {
    const row = defaultRow(r.tab);
    if (row) { history.replaceState(null, '', `#day=${row.key}`); r = { row, file: null, at: null, tab: r.tab }; }
  }
  // Back may use history only if this app pushed the day entry itself; a day
  // opened straight from a link has nothing in-app to go back to.
  if (r.row && !(S.route && S.route.row)) S.backInApp = !!S.route;
  if (r.row) S.tab = r.tab || tabOf(r.row); else S.tab = r.tab;
  S.route = r;
  if (!r.row && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  document.body.classList.toggle('reading', !!r.row);   // before drawing: a hidden rail cannot scroll
  renderRail();
  renderReader();
  $('#backbtn').hidden = !(isPhone() && r.row);
}

function renderNet() {
  const off = S.offline || !navigator.onLine;
  $('#netpill').classList.toggle('off', off);
  $('#nettext').textContent = off ? 'Offline' : 'Up to date';
}

// ─────────────────────────────────────────────────────────────── wiring ──

document.addEventListener('click', e => {
  const t = e.target.closest('#tabs .utab');
  if (t) { location.hash = t.dataset.tab; return; }
  const g = e.target.closest('[data-go]');
  if (g) { if (location.hash === g.dataset.go) route(); else location.hash = g.dataset.go; return; }
  const c = e.target.closest('#chips .chip');
  // Switching documents within a day replaces the hash, so Back still leaves the day.
  if (c) { location.replace(`#day=${S.route.row.key}&doc=${encodeURIComponent(c.dataset.file)}`); return; }
  if (e.target.closest('#present')) { present(); return; }
  const fd = e.target.closest('summary.unit');
  if (fd) {
    const d = fd.parentElement;
    unitState[d.dataset.unit] = !d.open;
    try { localStorage.setItem('advphys-units', JSON.stringify(unitState)); } catch (err) { /* not remembered; fine */ }
  }
});
$('#savebtn').addEventListener('click', saveAll);
let railScroll = 0;
$('#railbody').addEventListener('scroll', e => { if (e.target.offsetParent) railScroll = e.target.scrollTop; }, { passive: true });
$('#backbtn').addEventListener('click', () => S.backInApp ? history.back() : location.replace('#' + S.tab));
$('#brand').addEventListener('click', e => { e.preventDefault(); location.hash = 'schedule'; });
$('#themebtn').addEventListener('click', () => {
  const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
  const t = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('advphys-theme', t); } catch (e) { /* not remembered; fine */ }
});
window.addEventListener('hashchange', () => refreshCached().then(route));
window.addEventListener('online', renderNet);
window.addEventListener('offline', renderNet);
matchMedia('(max-width:760px)').addEventListener('change', () => route());
document.addEventListener('keydown', e => {
  if (e.target.matches('input')) return;
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
  if (!S.route || !S.route.row) return;
  if (e.key === 'Escape' && !document.fullscreenElement && isPhone()) $('#backbtn').click();
  if (e.key === 'f' || e.key === 'F') present();
});

function toast(msg) { $('#toastmsg').textContent = msg; $('#toast').classList.add('show'); }
$('#toastbtn').addEventListener('click', () => location.reload());

if ('serviceWorker' in navigator) {
  const hadWorker = !!navigator.serviceWorker.controller;   // first install is not an update
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => {
        if (w.state === 'activated' && hadWorker) toast('A new version is ready.');
      });
    });
  }).catch(() => { /* file:// or blocked: the app still works online */ });
}

load();
