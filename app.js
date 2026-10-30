/* Advanced Physics — PWA shell.

   Reads index.json (written by Admin/app/deploy.py) and draws three tabs:
     Schedule   every class day in Units 1-3, built or not; opens at the next class
     Labs       each lab with its handout and date
     Reference  the calculus primer
   Every document opens inside the app, in a framed viewer with a back bar, a
   switcher across that day's documents, Present (full screen) and an "open in a
   new tab" escape hatch -- as calc's app does.

   PDFs on iPhone and iPad: an iframe shows only page 1 there, and handing the
   PDF to the system (target=_blank) strands the installed home-screen app on a
   bare PDF with no way back (Ryan, 2026-10-29: "no return path if i open
   pdfs").  So there the viewer draws every page itself with the bundled
   PDF.js (lib/, precached by sw.js, works offline).  Add ?pdfjs=1 to the URL
   to force that path on any browser for testing.

   Documents are requested as  q/foo.html?h=<hash>  so a changed document is a
   different URL and the service worker can cache-first without going stale. */

const DOCS_CACHE = 'advphys-docs-v1';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const docURL = it => `${it.file}?h=${it.hash.slice(0, 12)}`;

const S = { idx: null, tab: 'schedule', q: '', cached: new Set(), offline: false };

// ───────────────────────────────────────────────────────────── loading ──

async function load() {
  try {
    const res = await fetch('index.json', { cache: 'no-store' });
    S.offline = res.headers.get('X-From-Cache') === '1';
    S.idx = await res.json();
  } catch (e) {
    S.offline = true;
    $('#view').innerHTML = '<p class="muted center" style="padding:40px 0">Offline, and nothing is saved yet. Open the app once with a connection.</p>';
    renderNet(); return;
  }
  $('#meets').textContent = S.idx.meets || 'Block 3';
  await refreshCached();
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

// ───────────────────────────────────────────────────────────── drawing ──

// iPadOS reports itself as a Mac; touch points give it away.
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const PDFJS = IOS || /[?&]pdfjs=1\b/.test(location.search);
const STANDALONE = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const framed = () => true;                       // every document opens in the viewer
const isPDF = it => it.file.endsWith('.pdf');

function itemLink(it) {
  const cls = it.kind === 'lab' ? 'item lab' : 'item';
  const dot = isCached(it) ? '<span class="ok" title="Saved for offline"></span>' : '';
  if (framed(it))
    return `<a class="${cls}" href="#doc=${encodeURIComponent(it.file)}" data-file="${esc(it.file)}">${dot}${esc(it.label)}</a>`;
  return `<a class="${cls}" href="${esc(docURL(it))}" target="_blank" rel="noopener">${dot}${esc(it.label)}</a>`;
}

function rowHTML(r, next) {
  if (r.kind === 'break') return `<div class="brk">${esc(r.text)}</div>`;
  const today = r.date === todayISO();
  const past = r.date && r.date < todayISO();
  const code = (r.kind === 'lesson' || r.kind === 'hwday') ? `<span class="code">${esc(r.code)}</span>` : '';
  const title = r.kind === 'lab' ? `${r.code}: ${r.name}`
    : r.kind === 'hwday' ? `${r.title}` : r.name;
  const part = r.kind === 'hwday' ? '<span class="tag hw">HW day</span>'
    : (r.part > 1 || (r.kind === 'lesson' && sectionHasHW(r.code))) ? `<span class="tag day">Day ${r.part}</span>` : '';
  const tag = part + (r.kind === 'lab' ? '<span class="tag lab">Lab</span>' : '') +
              (today ? '<span class="tag today">Today</span>' : '');
  const exam = (r.kind === 'quiz' || r.kind === 'test') ? ` class="tag ${r.kind}"` : '';
  const name = exam ? `<span${exam}>${esc(title)}</span>` : `${code}${esc(title)}`;
  const items = r.items || [];
  let body = r.topics ? `<div class="topics">${esc(r.topics)}</div>` : '';
  if (items.length) body += `<div class="items">${items.map(itemLink).join('')}</div>`;
  else if (r.kind === 'lab' && r.handout === false) body += '<div class="coming">Handout in class</div>';
  else if (r.kind === 'lesson' || r.kind === 'lab' || r.kind === 'hwday') body += '<div class="coming">Materials coming</div>';
  const cls = ['row', r.date && r.date === next ? 'next' : '', past ? 'past' : ''].join(' ');
  return `<div class="${cls}" ${r.date === next ? 'id="next"' : ''}>
    <div class="rhead"><span class="date">${esc(r.label || '')}</span><span class="name">${name}${tag}</span></div>${body}</div>`;
}

const sectionHasHW = code => allRows().some(r => r.kind === 'hwday' && r.code === code);

// Units the student has opened or closed on this device. A unit never touched follows
// the default (the current unit open), so the default moves with the year.
let unitState = {};
try { unitState = JSON.parse(localStorage.getItem('advphys-units')) || {}; } catch (e) { /* defaults */ }
function currentUnit() {
  const next = nextDate();
  const u = next && S.idx.units.find(u => u.rows.some(r => r.date === next));
  return (u || S.idx.units[S.idx.units.length - 1]).n;
}

function renderSchedule() {
  const next = nextDate();
  const cur = currentUnit();
  let h = saveBar();
  for (const u of S.idx.units) {
    const classes = u.rows.filter(r => r.kind !== 'break').length;
    h += `<details class="unitfold" data-unit="${u.n}"${(u.n in unitState ? unitState[u.n] : u.n === cur) ? ' open' : ''}>` +
         `<summary class="unit"><span>Unit ${u.n} · ${esc(u.title)}</span><span class="n">${classes}</span></summary>`;
    const earlier = u.rows.filter(r => r.kind !== 'break' && !r.date);
    if (earlier.length)
      h += `<details class="earlier"><summary>Earlier in Unit ${u.n} (${earlier.length})</summary>${earlier.map(r => rowHTML(r, next)).join('')}</details>`;
    h += u.rows.filter(r => r.kind === 'break' || r.date).map(r => rowHTML(r, next)).join('');
    h += '</details>';
  }
  $('#view').innerHTML = h;
  const n = $('#next');
  if (n && n.closest('.unitfold').open) n.scrollIntoView({ block: 'start' });
}

function renderLabs() {
  const next = nextDate();
  $('#view').innerHTML = '<div class="unit">Labs</div>' +
    S.idx.labs.map(r => rowHTML({ ...r, topics: r.topics }, next)).join('');
}

function renderRef() {
  const refs = S.idx.reference || [];
  $('#view').innerHTML = '<div class="unit">Reference</div>' + (refs.length
    ? refs.map(it => `<div class="row"><div class="name">${esc(it.label)}</div><div class="items" style="padding-left:0">${itemLink({ ...it, label: 'Open' })}</div></div>`).join('')
    : '<div class="row"><div class="name">Calculus primer</div><div class="coming" style="padding-left:0">Materials coming</div></div>');
}

function saveBar() {
  const all = everyItem();
  if (!all.length || !('caches' in window)) return '';
  const saved = all.filter(isCached).length;
  return `<div class="savebar"><span>${saved} of ${all.length} documents saved for offline</span>
    ${saved < all.length ? '<button class="btn" id="saveall">Save all</button>' : ''}</div>`;
}

const everyItem = () => [...allRows().flatMap(r => r.items || []), ...(S.idx.reference || [])]
  .filter((it, i, a) => a.findIndex(o => o.file === it.file) === i);

async function saveAll(btn) {
  btn.disabled = true;
  const todo = everyItem().filter(it => !isCached(it));
  let done = 0;
  for (const it of todo) {
    btn.textContent = `Saving ${++done}/${todo.length}…`;
    try { await fetch(docURL(it)); } catch (e) { break; }
  }
  await refreshCached();
  render();
}

// ────────────────────────────────────────────────────────────── search ──

const fold = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const hl = (s, q) => { const i = fold(s).indexOf(q); return i < 0 ? esc(s)
  : esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length)); };

function renderSearch() {
  const q = fold(S.q.trim());
  const hits = [];
  for (const r of allRows()) {
    if (r.kind === 'break' || r.kind === 'hwday' || r.part > 1) continue;
    const title = r.kind === 'lesson' ? `${r.code} ${r.name}` : r.kind === 'lab' ? `${r.code}: ${r.name}` : r.name;
    if (fold(title).includes(q) || fold(r.topics || '').includes(q))
      hits.push(`<div class="hit"><b>${hl(title, q)}</b><small>${esc(r.label || 'Earlier')} · ${hl(r.topics || '', q)}</small>
        ${(r.items || []).length ? `<div class="items" style="padding-left:0">${r.items.map(itemLink).join('')}</div>` : ''}</div>`);
  }
  for (const s of S.idx.search || [])
    for (const sec of s.sections)
      if (fold(sec.text).includes(q))
        hits.push(`<a class="hit" href="#doc=${encodeURIComponent(s.file)}&at=${encodeURIComponent(sec.id)}"><b>${hl(sec.text, q)}</b><small>in ${esc(s.title)}</small></a>`);
  $('#view').innerHTML = hits.length ? hits.join('') : '<p class="muted center" style="padding:30px 0">No matches.</p>';
}

// ─────────────────────────────────────────────────────────────── viewer ──

function findItem(file) {
  return [...allRows().flatMap(r => (r.items || []).map(it => ({ ...it, row: r }))), ...(S.idx.reference || [])]
    .find(it => it.file === file);
}

const rowTitle = r => r.kind === 'lab' ? `${r.code}: ${r.name}`
  : r.kind === 'hwday' ? `${r.code} ${r.title} · HW day`
  : r.code ? `${r.code} ${r.name}${r.part > 1 ? ` · day ${r.part}` : ''}` : r.name;

/** Mount each document of the open day once and toggle by [hidden].  Never
 *  destroy while the day is open -- a reloaded iframe loses its widget state
 *  (calc's mountFrames rule). */
function openDoc(file, at) {
  const it = findItem(file);
  if (!it) { location.hash = S.tab; return; }
  const docs = (it.row ? it.row.items : [it]).filter(framed);
  const box = $('#vframes');
  const key = it.row ? `${it.row.date || ''}|${it.row.code || it.row.name}` : it.file;
  if (box.dataset.key !== key) { box.innerHTML = ''; box.dataset.key = key; }

  const url = docURL(it) + (at ? `#${at}` : '');
  let f = [...box.children].find(x => x.dataset.file === file);
  if (!f && PDFJS && isPDF(it)) {
    f = document.createElement('div');
    f.className = 'pdfview';
    f.dataset.file = file;
    f.setAttribute('aria-label', it.label);
    box.appendChild(f);
    drawPDF(f, docURL(it));
  } else if (!f) {
    f = document.createElement('iframe');
    f.dataset.file = file;
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('aria-label', it.label);
    box.appendChild(f);
  }
  if (f.tagName === 'IFRAME' && (!f.src || at)) f.src = url;
  [...box.children].forEach(x => { x.hidden = x !== f; });

  $('#vtitle').textContent = it.row ? rowTitle(it.row) : it.label;
  $('#vopen').href = url;
  $('#vopen').hidden = IOS && STANDALONE;        // a new tab there is the same dead end
  const seg = $('#vseg');
  seg.hidden = docs.length < 2;
  seg.innerHTML = docs.map(d => `<button data-file="${esc(d.file)}" class="${d.file === file ? 'on' : ''}">${esc(d.label)}</button>`).join('');
  $('#vpresent').hidden = !document.fullscreenEnabled;
  $('#viewer').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDoc() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('#viewer').hidden = true;
  document.body.style.overflow = '';
  refreshCached().then(render);
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
    for (let n = 1; n <= pdf.numPages; n++) {
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
  const v = $('#viewer');
  if (!v.hidden && v.requestFullscreen) v.requestFullscreen().catch(() => {});
}

// ─────────────────────────────────────────────────────────────── routing ──

function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('doc=')) {
    const [file, at] = h.slice(4).split('&at=');
    if (!S.idx) return;
    // Back may use history only if this app pushed the document entry itself;
    // a document opened straight from a link has nothing in-app to go back to.
    if ($('#viewer').hidden) S.backInApp = S.seenTab;
    openDoc(file, at); return;
  }
  S.seenTab = true;
  if (!$('#viewer').hidden) closeDoc();
  S.tab = ['schedule', 'labs', 'ref'].includes(h) ? h : 'schedule';
  render();
}

function render() {
  if (!S.idx) return;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab && !S.q));
  if (S.q.trim()) return renderSearch();
  ({ schedule: renderSchedule, labs: renderLabs, ref: renderRef })[S.tab]();
}

function renderNet() {
  const off = S.offline || !navigator.onLine;
  $('#netpill').classList.toggle('off', off);
  $('#nettext').textContent = off ? 'Offline' : 'Up to date';
}

// ─────────────────────────────────────────────────────────────── wiring ──

document.addEventListener('click', e => {
  const t = e.target.closest('#tabs button');
  if (t) { S.q = ''; $('#search').value = ''; location.hash = t.dataset.tab; if (location.hash.slice(1) === t.dataset.tab) route(); return; }
  const fold = e.target.closest('summary.unit');
  if (fold) {
    const d = fold.parentElement;
    unitState[d.dataset.unit] = !d.open;
    try { localStorage.setItem('advphys-units', JSON.stringify(unitState)); } catch (err) { /* not remembered; fine */ }
    return;
  }
  if (e.target.id === 'saveall') saveAll(e.target);
});
$('#vback').addEventListener('click', () => S.backInApp ? history.back() : location.replace('#' + S.tab));
$('#vpresent').addEventListener('click', present);
// Switching documents within a day replaces the hash, so Back still leaves the viewer.
$('#vseg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) location.replace('#doc=' + encodeURIComponent(b.dataset.file));
});
$('#search').addEventListener('input', e => { S.q = e.target.value; render(); });
$('#themebtn').addEventListener('click', () => {
  const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
  const t = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('advphys-theme', t); } catch (e) { /* not remembered; fine */ }
});
window.addEventListener('hashchange', route);
window.addEventListener('online', renderNet);
window.addEventListener('offline', renderNet);
document.addEventListener('keydown', e => {
  if ($('#viewer').hidden || e.target.matches('input')) return;
  if (e.key === 'Escape' && !document.fullscreenElement) $('#vback').click();
  if (e.key === 'f' || e.key === 'F') present();
});

function toast(msg) { $('#toastmsg').textContent = msg; $('#toast').classList.add('open'); }
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
