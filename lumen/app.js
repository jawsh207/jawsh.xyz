// Lumen — a Material You Nostr client
// Deps are loaded as ES modules from jsDelivr (pinned). Swap to a local bundle if you prefer.
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, getEventHash, verifyEvent, nip04, nip19, nip44 } from 'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/+esm';
import { bech32 } from 'https://cdn.jsdelivr.net/npm/@scure/base@1.1.6/+esm';

/* ───────────────────────── state ───────────────────────── */
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'];
const META_RELAYS = ['wss://purplepag.es'];
const LS = 'lumen.state', PEND = 'lumen.pending', DRAFT = 'lumen.draft';
const SWATCHES = [285, 330, 20, 60, 110, 150, 195, 240];

const safeJSON = (s, d = {}) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const S = Object.assign({
  pubkey: null, signer: null, nsec: null, guest: false,
  relays: DEFAULT_RELAYS, nwc: null, bunker: null, media: null,
  hue: 285, mode: 'system', accent: false, zapAmount: 21,
}, safeJSON(localStorage.getItem(LS)));
const save = () => localStorage.setItem(LS, JSON.stringify(S));

const R = {
  profiles: new Map(), requested: new Set(), events: new Map(),
  contacts: null, contactsEv: null,
  stats: new Map(), statsReq: new Set(), statsSeen: new Set(),
  liked: new Set(), boosted: new Set(), zapped: new Set(),
  currentFeed: null, onPosted: null, hops: 0, barColors: {},
};
const pool = new SimplePool();

/* ───────────────────────── helpers ───────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const now = () => Math.floor(Date.now() / 1000);
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isHex64 = s => /^[0-9a-f]{64}$/.test(s || '');
const uniq = a => [...new Set(a)];
const metaRelays = () => uniq([...S.relays, ...META_RELAYS]);
const canSign = () => !!S.pubkey && ['nsec', 'nip07', 'amber', 'bunker'].includes(S.signer);
const tag = (e, k) => e.tags.find(t => t[0] === k)?.[1];
const safeUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const cssUrl = u => encodeURI(decodeURI(u)).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16));

function ago(t) {
  const d = now() - t;
  if (d < 60) return 'now';
  if (d < 3600) return Math.floor(d / 60) + 'm';
  if (d < 86400) return Math.floor(d / 3600) + 'h';
  if (d < 604800) return Math.floor(d / 86400) + 'd';
  return new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtSats(n) {
  n = Math.floor(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
function bolt11Sats(inv) {
  const m = /^ln(?:bcrt|bc|tbs|tb|sb)(\d+)([munp]?)1/i.exec(inv || '');
  if (!m) return 0;
  const n = +m[1];
  return Math.floor({ '': n * 1e8, m: n * 1e5, u: n * 100, n: n / 10, p: n / 1e4 }[m[2].toLowerCase()]);
}
function decodePk(s) {
  s = (s || '').replace(/^(web\+)?nostr:/, '');
  if (isHex64(s)) return s;
  try { const d = nip19.decode(s); if (d.type === 'npub') return d.data; if (d.type === 'nprofile') return d.data.pubkey; } catch {}
  return null;
}
function decodeId(s) {
  s = (s || '').replace(/^(web\+)?nostr:/, '');
  if (isHex64(s)) return s;
  try { const d = nip19.decode(s); if (d.type === 'note') return d.data; if (d.type === 'nevent') return d.data.id; } catch {}
  return null;
}
const npub = pk => nip19.npubEncode(pk);
const shortNpub = pk => { const n = npub(pk); return n.slice(0, 10) + '…' + n.slice(-4); };
async function copy(text, msg = 'Copied') { try { await navigator.clipboard.writeText(text); snack(msg); } catch { snack('Copy failed'); } }

let snackT;
function snack(msg, ms = 3200) {
  const el = $('#snackbar'); el.textContent = msg; el.classList.add('show');
  clearTimeout(snackT); snackT = setTimeout(() => el.classList.remove('show'), ms);
}
const spinner = () => `<div class="spin-wrap"><svg class="spinner" viewBox="0 0 48 48"><circle cx="24" cy="24" r="18"/></svg></div>`;
const emptyState = (icon, title, text = '', actions = '') =>
  `<div class="empty"><span class="ms">${icon}</span><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${actions ? `<div class="row">${actions}</div>` : ''}</div>`;
const LOGO = `<svg viewBox="0 0 512 512" fill="currentColor"><path d="M256 64c14 118 58 164 192 192-134 28-178 74-192 192-14-118-58-164-192-192 134-28 178-74 192-192z"/></svg>`;

/* ───────────────────────── Material You theme ───────────────────────── */
const cvs = document.createElement('canvas'); cvs.width = cvs.height = 1;
const cx = cvs.getContext('2d', { willReadFrequently: true });
function toHex(c) {
  cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
  const d = cx.getImageData(0, 0, 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map(x => x.toString(16).padStart(2, '0')).join('');
}
function hexHue(h) {
  const n = parseInt(h.slice(1), 16);
  const [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, B = .0259040371 * l + .7827717662 * m - .808675766 * s;
  return Math.round((Math.atan2(B, A) * 180 / Math.PI + 360) % 360);
}
function accentHue() {
  if (!window.CSS?.supports?.('color', 'AccentColor')) return null;
  const el = document.createElement('i'); el.style.color = 'AccentColor'; document.body.append(el);
  const c = getComputedStyle(el).color; el.remove();
  const m = c.match(/\d+(\.\d+)?/g); if (!m) return null;
  return hexHue('#' + m.slice(0, 3).map(x => Math.round(+x).toString(16).padStart(2, '0')).join(''));
}
function tokens(h, dark) {
  const o = (l, c, hh = h) => `oklch(${l} ${c} ${hh})`, t = (h + 60) % 360;
  return dark ? {
    primary: o(.82, .1), 'on-primary': o(.3, .09), 'primary-container': o(.38, .1), 'on-primary-container': o(.92, .05),
    secondary: o(.82, .04), 'secondary-container': o(.36, .035), 'on-secondary-container': o(.92, .02),
    tertiary: o(.82, .09, t), 'tertiary-container': o(.38, .08, t), 'on-tertiary-container': o(.92, .04, t),
    surface: o(.17, .01), 'surface-container-lowest': o(.14, .008), 'surface-container-low': o(.2, .011), 'surface-container': o(.22, .012), 'surface-container-high': o(.255, .013), 'surface-container-highest': o(.29, .014),
    'on-surface': o(.92, .01), 'on-surface-variant': o(.8, .02), outline: o(.62, .02), 'outline-variant': o(.38, .02),
    'inverse-surface': o(.92, .01), 'inverse-on-surface': o(.25, .01), like: 'oklch(.78 .15 5)', zap: 'oklch(.83 .15 75)',
  } : {
    primary: o(.5, .14), 'on-primary': '#fff', 'primary-container': o(.92, .055), 'on-primary-container': o(.28, .09),
    secondary: o(.5, .04), 'secondary-container': o(.92, .03), 'on-secondary-container': o(.28, .03),
    tertiary: o(.52, .12, t), 'tertiary-container': o(.92, .05, t), 'on-tertiary-container': o(.28, .08, t),
    surface: o(.985, .006), 'surface-container-lowest': '#fff', 'surface-container-low': o(.965, .009), 'surface-container': o(.952, .011), 'surface-container-high': o(.94, .012), 'surface-container-highest': o(.925, .013),
    'on-surface': o(.22, .012), 'on-surface-variant': o(.44, .02), outline: o(.62, .02), 'outline-variant': o(.86, .015),
    'inverse-surface': o(.3, .012), 'inverse-on-surface': o(.95, .008), like: 'oklch(.58 .2 5)', zap: 'oklch(.66 .16 65)',
  };
}
const isDark = () => S.mode === 'dark' || (S.mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme() {
  const dark = isDark();
  const h = (S.accent && accentHue()) ?? S.hue;
  const tk = tokens(h, dark), st = document.documentElement.style;
  for (const [k, v] of Object.entries(tk)) st.setProperty('--' + k, v);
  st.colorScheme = dark ? 'dark' : 'light';
  R.barColors = { flat: toHex(tk.surface), scrolled: toHex(tk['surface-container']) };
  updateBarColor();
}
function updateBarColor() {
  const bare = document.body.classList.contains('bare');
  const c = !bare && $('#appbar').classList.contains('scrolled') ? R.barColors.scrolled : R.barColors.flat;
  $('meta[name=theme-color]').content = c;
}

/* ───────────────────────── profiles ───────────────────────── */
const profile = pk => R.profiles.get(pk) || {};
function name(pk) {
  if (!pk) return '';
  const p = profile(pk);
  return (p.display_name || p.displayName || p.name || '').trim() || shortNpub(pk);
}
function avInner(pk) {
  const p = profile(pk), letter = esc((name(pk).replace(/^npub1/, '')[0] || '?').toUpperCase());
  const u = p.picture && safeUrl(p.picture);
  return `<b>${letter}</b>${u ? `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}`;
}
function setProfile(e) {
  const cur = R.profiles.get(e.pubkey);
  if (cur && cur._t >= e.created_at) return false;
  try { const m = JSON.parse(e.content); if (typeof m !== 'object' || !m) return false; m._t = e.created_at; R.profiles.set(e.pubkey, m); paintProfile(e.pubkey); return true; } catch { return false; }
}
function paintProfile(pk) {
  $$(`.av[data-pk="${pk}"]`).forEach(el => el.innerHTML = avInner(pk));
  $$(`.nm[data-pk="${pk}"]`).forEach(el => el.textContent = name(pk));
}
const wantQ = new Set(); let wantT;
function want(pk) {
  if (!pk || R.requested.has(pk)) return;
  R.requested.add(pk); wantQ.add(pk);
  clearTimeout(wantT); wantT = setTimeout(flushWant, 120);
}
function flushWant() {
  const all = [...wantQ]; wantQ.clear();
  for (let i = 0; i < all.length; i += 150) {
    const authors = all.slice(i, i + 150);
    const sub = pool.subscribeMany(metaRelays(), [{ kinds: [0], authors }], { onevent: setProfile, oneose: () => sub.close(), maxWait: 6000 });
  }
}
async function freshProfile(pk) {
  const e = await pool.get(metaRelays(), { kinds: [0], authors: [pk] }, { maxWait: 5000 });
  if (e) setProfile(e);
  return e;
}
async function loadContacts() {
  const e = await pool.get(metaRelays(), { kinds: [3], authors: [S.pubkey] }, { maxWait: 5000 });
  if (!R.contactsEv || (e && e.created_at > R.contactsEv.created_at)) R.contactsEv = e;
  R.contacts = (R.contactsEv?.tags || []).filter(t => t[0] === 'p' && isHex64(t[1])).map(t => t[1]);
  return R.contacts;
}

/* ───────────────────────── content rendering ───────────────────────── */
const IMG_RE = /\.(jpe?g|png|gif|webp|avif)(\?\S*)?$/i, VID_RE = /\.(mp4|webm|mov)(\?\S*)?$/i;
function renderText(str, types) {
  let t = esc(str);
  t = t.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]"']/g, url => {
    const raw = url.replace(/&amp;/g, '&');
    const mt = types?.get(raw) || '';
    if (IMG_RE.test(raw) || mt.startsWith('image/')) return `<img class="media" src="${url}" loading="lazy" alt="" referrerpolicy="no-referrer">`;
    if (VID_RE.test(raw) || mt.startsWith('video/')) return `<video class="media" src="${url}" controls preload="metadata" playsinline></video>`;
    const label = url.replace(/^https?:\/\/(www\.)?/, '');
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label.length > 42 ? label.slice(0, 40) + '…' : label}</a>`;
  });
  t = t.replace(/nostr:((?:npub1|nprofile1|note1|nevent1)[02-9ac-hj-np-z]+)/g, (m, code) => {
    const pk = decodePk(code);
    if (pk) { want(pk); return `<a class="mention" href="#/p/${pk}">@<span class="nm" data-pk="${pk}">${esc(name(pk))}</span></a>`; }
    const id = decodeId(code);
    if (id) return `<a class="qlink" href="#/n/${id}"><span class="ms s">format_quote</span>Quoted post</a>`;
    return m;
  });
  t = t.replace(/(^|\s)#([\p{L}\p{N}_]+)/gu, (m, sp, tg) => `${sp}<a class="hashtag" href="#/search/${encodeURIComponent('#' + tg)}">#${tg}</a>`);
  return t.replace(/\n/g, '<br>');
}
const imeta = e => {
  const m = new Map();
  for (const t of e.tags) if (t[0] === 'imeta') {
    const kv = Object.fromEntries(t.slice(1).map(x => [x.slice(0, x.indexOf(' ')), x.slice(x.indexOf(' ') + 1)]));
    if (kv.url && kv.m) m.set(kv.url, kv.m);
  }
  return m;
};
const replyTarget = e => {
  const es = e.tags.filter(t => t[0] === 'e');
  return (es.find(t => t[3] === 'reply') || es.find(t => t[3] === 'root') || es[es.length - 1])?.[1];
};
const lastE = e => e.tags.filter(t => t[0] === 'e').pop()?.[1];
const zapDesc = e => safeJSON(tag(e, 'description'), null);
const statOf = id => R.stats.get(id) || { replies: 0, boosts: 0, likes: 0, sats: 0 };

function actionsHTML(ev) {
  const s = statOf(ev.id), id = ev.id;
  const b = (act, icon, n, on, label) =>
    `<button class="act sl${on ? ' on' : ''}" data-act="${act}" aria-label="${label}"><span class="ms">${icon}</span><span class="cnt">${n ? fmtSats(n) : ''}</span></button>`;
  return `<div class="actions">
    ${b('reply', 'chat_bubble', s.replies, false, 'Reply')}
    ${b('boost', 'repeat', s.boosts, R.boosted.has(id), 'Boost')}
    ${b('like', 'favorite', s.likes, R.liked.has(id), 'Like')}
    ${b('zap', 'bolt', s.sats, R.zapped.has(id), 'Zap')}
    ${b('share', 'share', 0, false, 'Share')}
  </div>`;
}
function noteHTML(ev, { repostBy, focus, ancestor } = {}) {
  R.events.set(ev.id, ev); want(ev.pubkey); if (repostBy) want(repostBy);
  const reply = ev.tags.some(t => t[0] === 'e') && !focus;
  const rp = reply ? ev.tags.filter(t => t[0] === 'p').pop()?.[1] : null;
  if (rp) want(rp);
  const cls = ['note', focus && 'focus', ancestor && 'ancestor'].filter(Boolean).join(' ');
  return `<article class="${cls}" data-id="${ev.id}">
    ${repostBy ? `<div class="repost-by"><span class="ms s">repeat</span><span class="nm" data-pk="${repostBy}">${esc(name(repostBy))}</span>&nbsp;boosted</div>` : ''}
    <div class="note-row">
      <a class="av" data-pk="${ev.pubkey}" href="#/p/${ev.pubkey}">${avInner(ev.pubkey)}</a>
      <div class="note-body">
        <div class="note-head"><a class="nm" data-pk="${ev.pubkey}" href="#/p/${ev.pubkey}">${esc(name(ev.pubkey))}</a>${focus ? '' : `<span class="meta">· ${ago(ev.created_at)}</span>`}</div>
        ${rp ? `<div class="reply-to">Replying to&nbsp;<span class="nm" data-pk="${rp}">${esc(name(rp))}</span></div>` : ''}
        <div class="content">${renderText(ev.content, imeta(ev))}</div>
        ${focus ? `<div class="when">${new Date(ev.created_at * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</div>` : ''}
        ${actionsHTML(ev)}
      </div>
    </div>
  </article>`;
}
function itemHTML(e) {
  R.events.set(e.id, e);
  if (e.kind !== 6) return noteHTML(e);
  const inner = safeJSON(e.content, null);
  if (inner && inner.kind === 1 && inner.id && verifyEvent(inner)) return noteHTML(inner, { repostBy: e.pubkey });
  const tid = lastE(e);
  return tid ? `<div class="pending-repost" data-fetch="${tid}" data-by="${e.pubkey}"></div>` : '';
}
async function hydrateReposts(root) {
  const els = $$('.pending-repost:not([data-h])', root); if (!els.length) return;
  els.forEach(el => el.dataset.h = 1);
  const evs = await pool.querySync(S.relays, { ids: uniq(els.map(el => el.dataset.fetch)) }, { maxWait: 5000 });
  const map = new Map(evs.map(e => [e.id, e]));
  for (const el of els) {
    const ev = map.get(el.dataset.fetch);
    if (ev && ev.kind === 1) el.outerHTML = noteHTML(ev, { repostBy: el.dataset.by }); else el.remove();
  }
  loadStatsIn(root);
}

/* ───────────────────────── engagement counts ───────────────────────── */
const dirty = new Set(); let dirtyRaf = 0;
function markDirty(id) { dirty.add(id); if (!dirtyRaf) dirtyRaf = requestAnimationFrame(paintStats); }
function paintStats() {
  dirtyRaf = 0;
  for (const id of dirty) {
    const s = statOf(id);
    $$(`.note[data-id="${id}"] .actions`).forEach(a => {
      const set = (act, n, on) => { const b = $(`[data-act=${act}]`, a); if (!b) return; $('.cnt', b).textContent = n ? fmtSats(n) : ''; b.classList.toggle('on', !!on); };
      set('reply', s.replies); set('boost', s.boosts, R.boosted.has(id)); set('like', s.likes, R.liked.has(id)); set('zap', s.sats, R.zapped.has(id));
    });
  }
  dirty.clear();
}
function bump(id, key, n) { const s = statOf(id); s[key] = (s[key] || 0) + n; R.stats.set(id, s); markDirty(id); }
function loadStatsIn(root) {
  const els = $$('.note[data-id]:not([data-s])', root);
  els.forEach(el => el.dataset.s = 1);
  loadStats(els.map(el => el.dataset.id));
}
function loadStats(ids) {
  ids = uniq(ids).filter(id => !R.statsReq.has(id));
  ids.forEach(id => R.statsReq.add(id));
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60), set = new Set(chunk);
    const sub = pool.subscribeMany(S.relays, [{ kinds: [1, 6, 7, 9735], '#e': chunk, limit: 2000 }], {
      onevent(e) {
        if (R.statsSeen.has(e.id)) return; R.statsSeen.add(e.id);
        const target = e.kind === 1 ? replyTarget(e) : lastE(e);
        if (!set.has(target)) return;
        const mine = e.pubkey === S.pubkey;
        if (e.kind === 1) bump(target, 'replies', 1);
        else if (e.kind === 6) { if (mine) R.boosted.add(target); bump(target, 'boosts', 1); }
        else if (e.kind === 7) { if (e.content === '-') return; if (mine) R.liked.add(target); bump(target, 'likes', 1); }
        else if (e.kind === 9735) { if (zapDesc(e)?.pubkey === S.pubkey && S.pubkey) R.zapped.add(target); bump(target, 'sats', bolt11Sats(tag(e, 'bolt11'))); }
      },
      oneose: () => sub.close(), maxWait: 8000,
    });
  }
}

/* ───────────────────────── feed engine ───────────────────────── */
function mountFeed(listEl, filter, { sentinel, render = itemHTML, after, live = true, relays } = {}) {
  const RL = relays || S.relays;
  const seen = new Set(), buf = [], queued = [];
  let eosed = false, oldest = Infinity, loading = false, ended = false, io;
  const pill = live ? Object.assign(document.createElement('button'), { className: 'newpill sl' }) : null;
  if (pill) { pill.onclick = flushNew; document.body.append(pill); }
  const post = () => { hydrateReposts(listEl); loadStatsIn(listEl); after?.(listEl); };
  function append(evs) {
    evs.forEach(e => oldest = Math.min(oldest, e.created_at));
    listEl.insertAdjacentHTML('beforeend', evs.map(render).join('')); post();
  }
  function prepend(evs) { listEl.insertAdjacentHTML('afterbegin', evs.map(render).join('')); post(); }
  function flushNew() {
    if (!queued.length) return;
    prepend(queued.splice(0).sort((a, b) => b.created_at - a.created_at));
    pill?.classList.remove('show'); scrollTo({ top: 0, behavior: 'smooth' });
  }
  function initial() {
    if (eosed) return; eosed = true; clearTimeout(timer);
    append(buf.splice(0).sort((a, b) => b.created_at - a.created_at));
    if (!listEl.children.length) { listEl.innerHTML = emptyState('forum', 'No posts yet', 'Nothing came back from your relays. Try again later or add more relays in Settings.'); sentinel?.remove(); return; }
    if (sentinel) { io = new IntersectionObserver(es => es[0].isIntersecting && more(), { rootMargin: '900px' }); io.observe(sentinel); }
  }
  const timer = setTimeout(initial, 7000);
  const sub = pool.subscribeMany(RL, [{ ...filter, limit: 40 }], {
    onevent(e) {
      if (seen.has(e.id)) return; seen.add(e.id);
      if (!eosed) return void buf.push(e);
      if (!live || e.created_at < oldest) return;
      queued.push(e);
      if (pill) { pill.innerHTML = `<span class="ms">arrow_upward</span>${queued.length} new post${queued.length > 1 ? 's' : ''}`; pill.classList.add('show'); }
    },
    oneose: initial,
  });
  async function more() {
    if (loading || ended || !isFinite(oldest)) return; loading = true;
    try {
      const evs = (await pool.querySync(RL, { ...filter, until: oldest - 1, limit: 30 }, { maxWait: 6000 }))
        .filter(e => !seen.has(e.id) && seen.add(e.id)).sort((a, b) => b.created_at - a.created_at);
      if (!evs.length) { ended = true; io?.disconnect(); sentinel.innerHTML = `<div class="end">You're all caught up</div>`; }
      else append(evs);
    } finally { loading = false; }
  }
  return {
    close() { clearTimeout(timer); sub.close(); io?.disconnect(); pill?.remove(); },
    flushNew,
    add(e) { if (seen.has(e.id)) return; seen.add(e.id); prepend([e]); },
  };
}
function feedShell(v) {
  v.innerHTML = `<div class="list"></div><div class="sentinel">${spinner()}</div>`;
  return [$('.list', v), $('.sentinel', v)];
}

/* ───────────────────────── overlays ───────────────────────── */
let popWaiter = null;
function overlay(html) {
  const w = document.createElement('div'); w.innerHTML = html.trim();
  const el = w.firstElementChild; $('#overlay-root').append(el);
  history.pushState({ ov: 1 }, '');
  return el;
}
function closeOverlay(el) {
  return new Promise(res => {
    if (!el.isConnected) return res();
    el.classList.add('closing'); setTimeout(() => el.remove(), 180);
    if (history.state?.ov) { popWaiter = res; history.back(); } else res();
  });
}
addEventListener('popstate', () => {
  if (popWaiter) { const r = popWaiter; popWaiter = null; return r(); }
  const top = $('#overlay-root').lastElementChild;
  if (top) { top._onPop?.(); top.remove(); }
});
function dialog({ title, body = '', actions = [{ label: 'OK', value: true }], dismiss = null }) {
  return new Promise(resolve => {
    const el = overlay(`<div class="scrim"><div class="dialog" role="dialog" aria-modal="true">${title ? `<h2>${esc(title)}</h2>` : ''}<div class="body">${body}</div>
      <div class="acts">${actions.map((a, i) => `<button class="btn ${a.style || 'text'} sl" data-i="${i}">${esc(a.label)}</button>`).join('')}</div></div></div>`);
    el._onPop = () => resolve(dismiss);
    el.addEventListener('click', async e => {
      if (e.target === el) { await closeOverlay(el); return resolve(dismiss); }
      const b = e.target.closest('[data-i]'); if (!b) return;
      const a = actions[+b.dataset.i];
      const v = typeof a.value === 'function' ? a.value(el) : a.value;
      if (v === undefined) return;             // validation failed: keep open
      await closeOverlay(el); resolve(v);
    });
    setTimeout(() => $('input,textarea', el)?.focus(), 250);
  });
}
function menuSheet(items, title = '') {
  return new Promise(resolve => {
    const el = overlay(`<div class="scrim sheet-s"><div class="sheet menu"><div class="handle"></div>${title ? `<h3 style="padding:0 24px">${esc(title)}</h3>` : ''}
      ${items.map((it, i) => `<button class="li sl" data-i="${i}"><span class="ms">${it.icon}</span><span class="txt"><span class="sup">${esc(it.label)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}</span></button>`).join('')}</div></div>`);
    el._onPop = () => resolve(null);
    el.addEventListener('click', async e => {
      if (e.target === el) { await closeOverlay(el); return resolve(null); }
      const b = e.target.closest('[data-i]'); if (b) { await closeOverlay(el); resolve(items[+b.dataset.i].value); }
    });
  });
}
function lightbox(src) {
  const el = overlay(`<div class="scrim lightbox"><img src="${esc(src)}" alt=""></div>`);
  el.onclick = () => closeOverlay(el);
}
async function needLogin() {
  const go = await dialog({
    title: 'Sign in to do that', body: '<p>Posting, liking, boosting and zapping need a Nostr account.</p>',
    actions: [{ label: 'Not now', value: false }, { label: 'Sign in', value: true, style: 'filled' }],
  });
  if (go) location.hash = '#/login';
}

/* ───────────────────────── signing (nsec / NIP-07 / Amber NIP-55) ───────────────────────── */
function unsignedFor(t) {
  return { kind: t.kind, created_at: t.created_at || now(), tags: t.tags || [], content: t.content || '', pubkey: S.pubkey };
}
// Returns a signed event, or null when the signer needs a page round trip (Amber NIP-55; ctx is saved and resumed).
async function signRaw(t, ctx) {
  const tmpl = unsignedFor(t);
  if (S.signer === 'nsec') return finalizeEvent(tmpl, unhex(S.nsec));
  if (S.signer === 'nip07') {
    if (!window.nostr) throw new Error('No Nostr browser extension found');
    return window.nostr.signEvent(tmpl);
  }
  if (S.signer === 'bunker') {
    const { pubkey, ...u } = tmpl;
    const ev = safeJSON(await bunkerRpc('sign_event', [JSON.stringify(u)]), null);
    if (!ev?.sig) throw new Error('Your signer returned nothing');
    return ev;
  }
  if (S.signer === 'amber') {
    if (!ctx) throw new Error('Amber quick sign-in can’t do this. Connect Amber as a remote signer in Settings.');
    amberGo('sign_event', JSON.stringify(tmpl), ctx, tmpl);
    return null;
  }
  throw new Error('This account is read-only');
}
async function signThen(t, ctx) {
  if (!canSign()) return needLogin();
  try { const ev = await signRaw(t, ctx); if (ev) await afterSign(ev, ctx); }
  catch (e) { snack('Signing failed: ' + (e.message || e), 5000); }
}
async function broadcast(ev) {
  try { await Promise.any(pool.publish(S.relays, ev)); return true; } catch { return false; }
}
async function afterSign(ev, ctx) {
  if (!ev || !verifyEvent(ev)) return snack('The signer returned an invalid event');
  if (ctx.purpose === 'zap') return continueZap(ev, ctx);
  if (ctx.purpose === 'upload') return resumeUpload(ev, ctx);
  if (ctx.purpose === 'inbox') { dmRelayCache.set(S.pubkey, ev.tags.filter(t => t[0] === 'relay').map(t => t[1])); $('.inbox-note')?.replaceChildren(); }
  if (ctx.purpose === 'like') { R.liked.add(ctx.id); bump(ctx.id, 'likes', 1); popAct(ctx.id, 'like'); }
  if (ctx.purpose === 'boost') { R.boosted.add(ctx.id); bump(ctx.id, 'boosts', 1); popAct(ctx.id, 'boost'); }
  if (ctx.purpose === 'contacts') { R.contactsEv = ev; R.contacts = ev.tags.filter(t => t[0] === 'p').map(t => t[1]); R.onContacts?.(); }
  if (ctx.purpose === 'profile') setProfile(ev);
  if (ctx.purpose === 'post') { localStorage.removeItem(DRAFT); if (ctx.reply) bump(ctx.reply, 'replies', 1); }
  const ok = await broadcast(ev);
  if (ok && ctx.purpose === 'post') R.onPosted?.(ev);
  if (ctx.msg || !ok) snack(ok ? ctx.msg : 'Couldn’t reach any relay. Check your relay list in Settings.');
}
function popAct(id, act) {
  $$(`.note[data-id="${id}"] [data-act=${act}]`).forEach(b => { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); });
}

// Amber (NIP-55) web flow: open nostrsigner: URL, Amber redirects back to callbackUrl with the result appended.
function amberGo(type, payload, ctx, tmpl) {
  localStorage.setItem(PEND, JSON.stringify({ type, ctx, tmpl, route: location.hash || '#/home', t: Date.now() }));
  const cb = location.origin + location.pathname + '?amber=';
  const rt = type === 'sign_event' ? 'event' : 'signature';
  let url = `nostrsigner:${payload ? encodeURIComponent(payload) : ''}?compressionType=none&returnType=${rt}&type=${type}&callbackUrl=${encodeURIComponent(cb)}&appName=Lumen`;
  if (type === 'sign_event' && S.pubkey) url += `&current_user=${S.pubkey}`;
  let left = false;
  const onHide = () => { if (document.hidden) left = true; };
  document.addEventListener('visibilitychange', onHide);
  location.href = url;
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    if (!left) snack('Couldn’t open Amber. Is it installed on this device?', 5000);
  }, 2500);
}
function handleAmberReturn() {
  const q = new URLSearchParams(location.search);
  if (!q.has('amber')) return;
  const res = (q.get('amber') || '').trim();
  const pend = safeJSON(localStorage.getItem(PEND), null);
  localStorage.removeItem(PEND);
  history.replaceState(null, '', location.pathname + (pend?.route || '#/home'));
  if (!pend || Date.now() - pend.t > 15 * 60e3) return;
  if (!res) return setTimeout(() => snack('Amber request was cancelled'), 400);
  if (res.startsWith('Signer1')) return setTimeout(() => snack('Amber sent a compressed reply this app can’t read'), 400);
  if (pend.type === 'get_public_key') {
    const pk = decodePk(res);
    if (!pk) return setTimeout(() => snack('Amber returned an invalid key'), 400);
    Object.assign(S, { pubkey: pk, signer: 'amber', nsec: null, guest: false }); save();
    history.replaceState(null, '', location.pathname + '#/home');
    setTimeout(() => snack('Signed in with Amber'), 400);
  } else if (pend.type === 'sign_event') {
    let ev = safeJSON(res, null);
    if (!ev && /^[0-9a-f]{128}$/.test(res) && pend.tmpl) ev = { ...pend.tmpl, id: getEventHash(pend.tmpl), sig: res };
    setTimeout(() => afterSign(ev, pend.ctx), 300);
  }
}

/* ───────────────────────── Nostr Wallet Connect (NIP-47) ───────────────────────── */
function parseNwc(uri) {
  const m = uri.trim().match(/^nostr\+walletconnect:\/?\/?([0-9a-f]{64})\?(.+)$/i);
  if (!m) throw new Error('That isn’t a nostr+walletconnect:// connection string');
  const q = new URLSearchParams(m[2]), relays = q.getAll('relay').map(r => decodeURIComponent(r)), secret = (q.get('secret') || '').toLowerCase();
  if (!relays.length || !isHex64(secret)) throw new Error('Connection string is missing a relay or secret');
  return { wallet: m[1].toLowerCase(), relays, secret, lud16: q.get('lud16') || null };
}
async function nwcRequest(method, params = {}, timeout = 60000) {
  if (!S.nwc) throw new Error('No wallet connected');
  const { wallet, relays, secret } = S.nwc;
  const content = await nip04.encrypt(secret, wallet, JSON.stringify({ method, params }));
  const req = finalizeEvent({ kind: 23194, created_at: now(), tags: [['p', wallet]], content }, unhex(secret));
  return new Promise((resolve, reject) => {
    let done = false, sub;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(tm); sub?.close(); fn(v); };
    const tm = setTimeout(() => finish(reject, new Error('Your wallet didn’t respond in time')), timeout);
    let sent = false;
    const send = () => { if (sent) return; sent = true; Promise.any(pool.publish(relays, req)).catch(() => finish(reject, new Error('Couldn’t reach the wallet relay'))); };
    sub = pool.subscribeMany(relays, [{ kinds: [23195], authors: [wallet], '#e': [req.id] }], {
      async onevent(e) {
        try {
          const r = JSON.parse(await nip04.decrypt(secret, wallet, e.content));
          if (r.error) finish(reject, new Error(r.error.message || r.error.code)); else finish(resolve, r.result);
        } catch (err) { finish(reject, err); }
      },
      oneose: send,
    });
    setTimeout(send, 3000);
  });
}

/* ───────────────────────── zaps (NIP-57) ───────────────────────── */
function lnurlFor(p) {
  if (p.lud16 && p.lud16.includes('@')) { const [n, d] = p.lud16.trim().split('@'); return `https://${d}/.well-known/lnurlp/${n}`; }
  if (p.lud06) { try { const { words } = bech32.decode(p.lud06.toLowerCase(), 2000); return new TextDecoder().decode(bech32.fromWords(words)); } catch {} }
  return null;
}
async function openZap(pubkey, eventId) {
  if (!canSign()) return needLogin();
  want(pubkey);
  const amounts = [21, 100, 500, 1000, 5000, 21000];
  const el = overlay(`<div class="scrim sheet-s"><div class="sheet"><div class="handle"></div>
    <h3>Zap <span class="nm" data-pk="${pubkey}">${esc(name(pubkey))}</span></h3>
    <div class="chips">${amounts.map(a => `<button class="chip sl${a === S.zapAmount ? ' sel' : ''}" data-amt="${a}"><span class="ms">bolt</span>${fmtSats(a)}</button>`).join('')}</div>
    <label class="tf"><input id="zamt" type="number" inputmode="numeric" min="1" placeholder=" " value="${S.zapAmount}"><span>Amount in sats</span></label>
    <label class="tf"><input id="zmsg" placeholder=" " maxlength="200"><span>Comment (optional)</span></label>
    <div class="sheet-note"><span class="ms s">${S.nwc ? 'account_balance_wallet' : 'receipt_long'}</span>${S.nwc ? 'Pays instantly from your connected wallet' : 'No wallet connected. You’ll get an invoice to pay in any Lightning wallet.'}</div>
    <button class="btn filled big sl" id="zgo"><span class="ms">bolt</span>Zap</button></div></div>`);
  el.addEventListener('click', async e => {
    if (e.target === el) return closeOverlay(el);
    const c = e.target.closest('[data-amt]');
    if (c) { $$('.chip', el).forEach(x => x.classList.toggle('sel', x === c)); $('#zamt', el).value = c.dataset.amt; }
    if (e.target.closest('#zgo')) {
      const sats = Math.floor(+$('#zamt', el).value);
      if (!(sats > 0)) return snack('Enter an amount');
      const comment = $('#zmsg', el).value.trim();
      await closeOverlay(el);
      startZap({ pubkey, eventId, sats, comment });
    }
  });
}
async function startZap({ pubkey, eventId, sats, comment }) {
  try {
    snack('Preparing zap…', 8000);
    let p = profile(pubkey);
    if (!p.lud16 && !p.lud06) { await freshProfile(pubkey); p = profile(pubkey); }
    const lnurl = lnurlFor(p);
    if (!lnurl) throw new Error(`${name(pubkey)} hasn’t set up a Lightning address`);
    const info = await (await fetch(lnurl)).json();
    if (info.status === 'ERROR' || !info.callback) throw new Error(info.reason || 'Lightning address lookup failed');
    const msats = sats * 1000;
    if (msats < info.minSendable || msats > info.maxSendable) throw new Error(`Amount must be between ${fmtSats(info.minSendable / 1000)} and ${fmtSats(info.maxSendable / 1000)} sats`);
    const ctx = { purpose: 'zap', callback: info.callback, msats, sats, eventId, pubkey };
    if (info.allowsNostr && info.nostrPubkey) {
      const tags = [['relays', ...S.relays.slice(0, 5)], ['amount', String(msats)], ['p', pubkey]];
      if (eventId) tags.push(['e', eventId]);
      return signThen({ kind: 9734, content: comment, tags }, ctx);
    }
    await payInvoice(await getInvoice(info.callback, msats, null, comment), ctx);
  } catch (e) { snack(e.message || String(e), 5000); }
}
async function continueZap(zapReq, ctx) {
  try { await payInvoice(await getInvoice(ctx.callback, ctx.msats, zapReq), ctx); }
  catch (e) { snack(e.message || String(e), 5000); }
}
async function getInvoice(callback, msats, zapReq, comment) {
  const u = new URL(callback);
  u.searchParams.set('amount', msats);
  if (zapReq) u.searchParams.set('nostr', JSON.stringify(zapReq));
  else if (comment) u.searchParams.set('comment', comment);
  const r = await (await fetch(u)).json();
  if (r.status === 'ERROR' || !r.pr) throw new Error(r.reason || 'The recipient’s wallet didn’t return an invoice');
  if (bolt11Sats(r.pr) !== Math.floor(msats / 1000)) throw new Error('Invoice amount doesn’t match. Payment cancelled.');
  return r.pr;
}
function zapDone(ctx) {
  if (ctx.eventId) { R.zapped.add(ctx.eventId); bump(ctx.eventId, 'sats', ctx.sats); popAct(ctx.eventId, 'zap'); }
  snack(`Zapped ${fmtSats(ctx.sats)} sats to ${name(ctx.pubkey)}`);
}
async function payInvoice(pr, ctx) {
  if (S.nwc) {
    snack('Paying with your wallet…', 60000);
    await nwcRequest('pay_invoice', { invoice: pr });
    return zapDone(ctx);
  }
  if (window.webln) {
    try { await window.webln.enable(); await window.webln.sendPayment(pr); return zapDone(ctx); } catch {}
  }
  const qr = await qrSvg('lightning:' + pr.toUpperCase());
  $('#snackbar').classList.remove('show');
  const r = await dialog({
    title: `Pay ${fmtSats(ctx.sats)} sats`,
    body: `<p>Scan or open this invoice in any Lightning wallet. Connect a wallet in the Wallet tab to zap in one tap.</p>${qr ? `<div class="qr">${qr}</div>` : ''}<div class="inv">${esc(pr)}</div>`,
    actions: [{ label: 'Copy', value: 'copy' }, { label: 'Open wallet', value: 'open', style: 'filled' }],
  });
  if (r === 'copy') copy(pr, 'Invoice copied');
  if (r === 'open') location.href = 'lightning:' + pr;
}

/* ───────────────────────── actions ───────────────────────── */
async function doAct(act, id) {
  const ev = R.events.get(id); if (!ev) return;
  if (act === 'share') return shareNote(ev);
  if (!canSign()) return needLogin();
  if (act === 'reply') return openComposer(ev);
  if (act === 'zap') return openZap(ev.pubkey, id);
  if (act === 'like') {
    if (R.liked.has(id)) return;
    return signThen({ kind: 7, content: '+', tags: [['e', id], ['p', ev.pubkey], ['k', String(ev.kind)]] }, { purpose: 'like', id });
  }
  if (act === 'boost') {
    const choice = await menuSheet([
      { icon: 'repeat', label: R.boosted.has(id) ? 'Boost again' : 'Boost', sub: 'Share with your followers', value: 'boost' },
      { icon: 'format_quote', label: 'Quote', sub: 'Add your own thoughts', value: 'quote' },
    ]);
    if (choice === 'boost') signThen({ kind: 6, content: JSON.stringify(ev), tags: [['e', id, S.relays[0] || ''], ['p', ev.pubkey]] }, { purpose: 'boost', id, msg: 'Boosted' });
    if (choice === 'quote') openComposer(null, { quote: ev });
  }
}
async function shareNote(ev) {
  const url = 'https://njump.me/' + nip19.neventEncode({ id: ev.id, author: ev.pubkey });
  if (navigator.share) { try { await navigator.share({ url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  copy(url, 'Link copied');
}

/* ───────────────────────── composer ───────────────────────── */
function openComposer(replyTo = null, { quote, text, media: initMedia } = {}) {
  if (!canSign()) return needLogin();
  const draft = text ?? (!replyTo && !quote ? localStorage.getItem(DRAFT) || '' : '');
  const media = [...(initMedia || [])];
  let uploading = 0;
  const title = replyTo ? 'Reply' : quote ? 'Quote' : 'New post';
  const el = overlay(`<div class="full" role="dialog" aria-modal="true">
    <div class="fs-bar"><button class="icon-btn sl" data-x aria-label="Close"><span class="ms">close</span></button><h2>${title}</h2>
      <button class="btn filled sl" data-post disabled>${replyTo ? 'Reply' : 'Post'}</button></div>
    <div class="fs-body">
      ${replyTo ? `<div class="reply-ctx">Replying to <b class="nm" data-pk="${replyTo.pubkey}">${esc(name(replyTo.pubkey))}</b><div class="snip">${esc(replyTo.content.slice(0, 200))}</div></div>` : ''}
      <div class="compose-row"><span class="av" data-pk="${S.pubkey}">${avInner(S.pubkey)}</span>
      <textarea placeholder="${replyTo ? 'Write your reply' : 'What’s happening?'}" aria-label="Post text">${esc(draft)}</textarea></div>
      <div class="thumbs"></div>
      ${quote ? `<div class="reply-ctx"><b class="nm" data-pk="${quote.pubkey}">${esc(name(quote.pubkey))}</b><div class="snip">${esc(quote.content.slice(0, 280))}</div></div>` : ''}
    </div>
    <div class="c-tools"><button class="icon-btn sl" data-attach aria-label="Add photo or video"><span class="ms">add_photo_alternate</span></button>
      <input type="file" accept="image/*,video/*" ${S.signer === 'amber' ? '' : 'multiple'} hidden>
      <span class="hint">Uploads to ${esc(mediaServer().label)}</span></div></div>`);
  const ta = $('textarea', el), btn = $('[data-post]', el), thumbs = $('.thumbs', el), fileIn = $('input[type=file]', el);
  const sync = () => {
    btn.disabled = uploading > 0 || (!ta.value.trim() && !quote && !media.length);
    if (!replyTo && !quote) localStorage.setItem(DRAFT, ta.value);
  };
  const paint = () => {
    thumbs.innerHTML = media.map((m, i) => `<div class="thumb">${(m.type || '').startsWith('video') ? `<video src="${esc(m.url)}" muted preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="">`}
      <button class="rm" data-rm="${i}" aria-label="Remove"><span class="ms">close</span></button></div>`).join('')
      + `<div class="thumb up">${spinner()}</div>`.repeat(uploading);
    sync();
  };
  ta.addEventListener('input', sync); paint();
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 300);
  $('[data-x]', el).onclick = () => closeOverlay(el);
  thumbs.onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { media.splice(+b.dataset.rm, 1); paint(); } };
  $('[data-attach]', el).onclick = () => fileIn.click();
  fileIn.onchange = async () => {
    const files = [...fileIn.files]; fileIn.value = '';
    for (const f of files) {
      uploading++; paint();
      try {
        const up = await uploadMedia(f, { text: ta.value, media, replyId: replyTo?.id, quoteId: quote?.id });
        if (up) media.push(up);
      } catch (e) { snack(e.message || 'Upload failed', 5000); }
      finally { uploading--; paint(); }
    }
  };
  btn.onclick = async () => {
    let content = ta.value.trim();
    const tags = [], ps = new Set();
    if (replyTo) {
      const root = replyTo.tags.find(t => t[0] === 'e' && t[3] === 'root')?.[1];
      if (root) tags.push(['e', root, '', 'root'], ['e', replyTo.id, '', 'reply']);
      else tags.push(['e', replyTo.id, '', 'root']);
      ps.add(replyTo.pubkey); replyTo.tags.filter(t => t[0] === 'p').forEach(t => ps.add(t[1]));
    }
    if (media.length) {
      content = (content + '\n\n' + media.map(m => m.url).join('\n')).trim();
      media.forEach(m => tags.push(['imeta', `url ${m.url}`, ...(m.type ? [`m ${m.type}`] : []), ...(m.sha ? [`x ${m.sha}`] : []), ...(m.dim ? [`dim ${m.dim}`] : [])]));
    }
    if (quote) {
      content = (content + '\n\nnostr:' + nip19.neventEncode({ id: quote.id, author: quote.pubkey })).trim();
      tags.push(['q', quote.id]); ps.add(quote.pubkey);
    }
    for (const m of content.matchAll(/nostr:((?:npub1|nprofile1)[02-9ac-hj-np-z]+)/g)) { const pk = decodePk(m[1]); if (pk) ps.add(pk); }
    ps.delete(S.pubkey);
    ps.forEach(pk => isHex64(pk) && tags.push(['p', pk]));
    for (const m of content.matchAll(/(?:^|\s)#([\p{L}\p{N}_]+)/gu)) tags.push(['t', m[1].toLowerCase()]);
    await closeOverlay(el);
    signThen({ kind: 1, content, tags }, { purpose: 'post', msg: replyTo ? 'Reply sent' : 'Posted', reply: replyTo?.id });
  };
}

/* ───────────────────────── views ───────────────────────── */
let cleanups = [];
function bar({ title, back = false, nav = null, fab }) {
  document.body.classList.remove('bare');
  document.body.classList.toggle('detail', !nav);
  $('#bar-title').textContent = title;
  const left = $('#bar-left');
  if (back) {
    left.className = 'icon-btn sl'; left.innerHTML = '<span class="ms">arrow_back</span>'; left.setAttribute('aria-label', 'Back');
    left.onclick = () => (R.hops > 1 ? history.back() : (location.hash = '#/home'));
  } else {
    left.className = 'icon-btn sl avbtn'; left.setAttribute('aria-label', 'Your profile');
    left.innerHTML = S.pubkey ? `<span class="av sm" data-pk="${S.pubkey}">${avInner(S.pubkey)}</span>` : '<span class="ms">account_circle</span>';
    left.onclick = () => (location.hash = S.pubkey ? '#/p/' + S.pubkey : '#/login');
    want(S.pubkey);
  }
  $('#bar-actions').innerHTML = nav ? `<button class="icon-btn sl" data-go="#/search/" aria-label="Search"><span class="ms">search</span></button><button class="icon-btn sl" data-go="#/settings" aria-label="Settings"><span class="ms">settings</span></button>` : '';
  $$('#navbar a').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
  if (fab === undefined && (nav === 'home' || nav === 'explore')) fab = { icon: 'edit', label: 'Post', fn: () => (canSign() ? openComposer() : needLogin()) };
  R.fab = fab?.fn || null;
  document.body.classList.toggle('nofab', !fab);
  if (fab) { $('#fab .ms').textContent = fab.icon; $('#fab .fab-label').textContent = fab.label; $('#fab').setAttribute('aria-label', fab.label); }
  updateBarColor();
}

async function homeView(v) {
  bar({ title: 'Lumen', nav: 'home' });
  if (!S.pubkey) {
    v.innerHTML = emptyState('travel_explore', 'You’re browsing as a guest', 'Sign in to see posts from people you follow.',
      `<button class="btn filled sl" data-go="#/login">Sign in</button><button class="btn tonal sl" data-go="#/explore">Explore</button>`);
    return;
  }
  v.innerHTML = spinner();
  if (R.contacts == null) await loadContacts();
  if (!v.isConnected) return;
  if (!R.contacts.length) {
    v.innerHTML = emptyState('group_add', 'Your feed is empty', 'Follow people from Explore and their posts will show up here.', `<button class="btn filled sl" data-go="#/explore">Explore</button>`);
    return;
  }
  const [list, sentinel] = feedShell(v);
  const f = mountFeed(list, { kinds: [1, 6], authors: uniq([...R.contacts, S.pubkey]).slice(0, 1000) }, { sentinel });
  R.currentFeed = f; R.onPosted = e => f.add(e);
  cleanups.push(() => { f.close(); R.currentFeed = null; R.onPosted = null; });
}
function exploreView(v) {
  bar({ title: 'Explore', nav: 'explore' });
  const [list, sentinel] = feedShell(v);
  const f = mountFeed(list, { kinds: [1] }, { sentinel });
  R.currentFeed = f; R.onPosted = e => f.add(e);
  cleanups.push(() => { f.close(); R.currentFeed = null; R.onPosted = null; });
}
function notifHTML(e) {
  if (e.pubkey === S.pubkey) return '';
  if (e.kind === 1) return noteHTML(e);
  const target = lastE(e);
  let icon, cls, actor = e.pubkey, text, extra = '';
  if (e.kind === 7) { if (e.content === '-') return ''; icon = 'favorite'; cls = 'like'; text = e.content && e.content !== '+' ? `reacted ${esc([...e.content].slice(0, 4).join(''))} to your post` : 'liked your post'; }
  else if (e.kind === 6) { icon = 'repeat'; cls = 'boost'; text = 'boosted your post'; }
  else if (e.kind === 9735) {
    const d = zapDesc(e); icon = 'bolt'; cls = 'zap';
    actor = d?.pubkey && isHex64(d.pubkey) ? d.pubkey : e.pubkey;
    text = `zapped you ${fmtSats(bolt11Sats(tag(e, 'bolt11')))} sats`;
    if (d?.content) extra = `<div class="zap-msg">${esc(d.content)}</div>`;
  } else return '';
  want(actor);
  return `<div class="notif sl" ${target ? `data-go="#/n/${target}"` : ''}><span class="ms fill ni ${cls}">${icon}</span>
    <div class="nb"><a class="av sm" data-pk="${actor}" href="#/p/${actor}">${avInner(actor)}</a>
    <div><b class="nm" data-pk="${actor}">${esc(name(actor))}</b> ${text} <span class="meta">· ${ago(e.created_at)}</span></div>
    ${extra}${target ? `<div class="snip" data-snip="${target}"></div>` : ''}</div></div>`;
}
async function fillSnips(root) {
  const els = $$('.snip[data-snip]:not([data-h])', root); if (!els.length) return;
  els.forEach(el => el.dataset.h = 1);
  const need = uniq(els.map(el => el.dataset.snip)).filter(id => !R.events.has(id));
  if (need.length) (await pool.querySync(S.relays, { ids: need }, { maxWait: 5000 })).forEach(e => R.events.set(e.id, e));
  els.forEach(el => { const e = R.events.get(el.dataset.snip); el.textContent = e ? e.content.slice(0, 240) : ''; });
}
function notificationsView(v) {
  bar({ title: 'Activity', nav: 'notifications' });
  if (!S.pubkey) { v.innerHTML = emptyState('notifications', 'No account', 'Sign in to see replies, likes, boosts and zaps.', `<button class="btn filled sl" data-go="#/login">Sign in</button>`); return; }
  const [list, sentinel] = feedShell(v);
  const f = mountFeed(list, { kinds: [1, 6, 7, 9735], '#p': [S.pubkey] }, { sentinel, render: notifHTML, after: fillSnips });
  R.currentFeed = f; cleanups.push(() => { f.close(); R.currentFeed = null; });
}

async function threadView(v, arg) {
  bar({ title: 'Post', back: true });
  const id = decodeId(arg);
  v.innerHTML = spinner();
  const ev = id && (R.events.get(id) || await pool.get(S.relays, { ids: [id] }, { maxWait: 6000 }));
  if (!v.isConnected) return;
  if (!ev) { v.innerHTML = emptyState('search_off', 'Post not found', 'None of your relays have this post.'); return; }
  v.innerHTML = `<div id="anc"></div>${noteHTML(ev, { focus: true })}<div class="section-title">Replies</div><div class="list"></div>`;
  loadStatsIn(v);
  const parentId = ev.tags.some(t => t[0] === 'e') && replyTarget(ev);
  if (parentId) {
    const p = R.events.get(parentId) || await pool.get(S.relays, { ids: [parentId] }, { maxWait: 5000 });
    if (p && v.isConnected) { $('#anc', v).innerHTML = noteHTML(p, { ancestor: true }); loadStatsIn(v); }
  }
  const list = $('.list', v), seen = new Set();
  const sub = pool.subscribeMany(S.relays, [{ kinds: [1], '#e': [ev.id] }], {
    onevent(e) {
      if (seen.has(e.id) || replyTarget(e) !== ev.id) return; seen.add(e.id);
      const html = noteHTML(e), after = $$('.note', list).find(n => (R.events.get(n.dataset.id)?.created_at || 0) > e.created_at);
      after ? after.insertAdjacentHTML('beforebegin', html) : list.insertAdjacentHTML('beforeend', html);
      clearTimeout(sub._t); sub._t = setTimeout(() => loadStatsIn(list), 300);
    },
    oneose() { if (!seen.size) list.innerHTML = `<div class="end">No replies yet</div>`; },
  });
  R.onPosted = e => { if (replyTarget(e) === ev.id && !seen.has(e.id)) { seen.add(e.id); $('.end', list)?.remove(); list.insertAdjacentHTML('beforeend', noteHTML(e)); } };
  cleanups.push(() => { sub.close(); R.onPosted = null; });
}

function profHeadHTML(pk) {
  const p = profile(pk), me = pk === S.pubkey, following = R.contacts?.includes(pk);
  const banner = p.banner && safeUrl(p.banner), web = p.website && safeUrl(p.website.startsWith('http') ? p.website : 'https://' + p.website);
  return `<div class="banner" style="${banner ? `background-image:url('${esc(cssUrl(banner))}')` : ''}"></div>
  <div class="prof"><div class="prof-top"><span class="av big" data-pk="${pk}">${avInner(pk)}</span>
    <div class="prof-actions">${me
      ? `<button class="btn outlined sl" data-p="edit"><span class="ms">edit</span>Edit profile</button>`
      : `${S.pubkey ? `<button class="icon-btn outl sl" data-p="dm" aria-label="Message"><span class="ms">mail</span></button>` : ''}${(p.lud16 || p.lud06) ? `<button class="icon-btn outl sl" data-p="zap" aria-label="Zap"><span class="ms">bolt</span></button>` : ''}
         <button class="btn ${following ? 'tonal' : 'filled'} sl" data-p="follow">${following ? '<span class="ms">check</span>Following' : 'Follow'}</button>`}</div></div>
    <h2>${esc(name(pk))}</h2>
    ${p.nip05 ? `<div class="nip05"><span class="ms s">verified</span>${esc(String(p.nip05).replace(/^_@/, ''))}</div>` : ''}
    ${p.about ? `<div class="about">${renderText(p.about)}</div>` : ''}
    <div class="chips">
      <button class="chip sl" data-p="copy"><span class="ms">key</span><span class="t">${shortNpub(pk)}</span></button>
      ${p.lud16 ? `<span class="chip"><span class="ms">bolt</span><span class="t">${esc(p.lud16)}</span></span>` : ''}
      ${web ? `<a class="chip sl" href="${esc(web)}" target="_blank" rel="noopener"><span class="ms">link</span><span class="t">${esc(web.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span></a>` : ''}
    </div></div>`;
}
async function profileView(v, arg) {
  const pk = decodePk(arg);
  if (!pk) { bar({ title: 'Profile', back: true }); v.innerHTML = emptyState('person_off', 'Profile not found'); return; }
  bar({ title: name(pk), back: true });
  v.innerHTML = `<div class="head">${profHeadHTML(pk)}</div><div class="section-title">Posts</div><div class="list"></div><div class="sentinel">${spinner()}</div>`;
  const render = () => { if (!v.isConnected) return; $('.head', v).innerHTML = profHeadHTML(pk); $('#bar-title').textContent = name(pk); };
  freshProfile(pk).then(render);
  if (S.pubkey && R.contacts == null) loadContacts().then(render);
  R.onContacts = render;
  v.addEventListener('click', async e => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const a = b.dataset.p;
    if (a === 'copy') copy(npub(pk), 'npub copied');
    if (a === 'edit') editProfile();
    if (a === 'zap') openZap(pk);
    if (a === 'dm') location.hash = '#/dm/' + pk;
    if (a === 'follow') toggleFollow(pk);
  });
  const f = mountFeed($('.list', v), { kinds: [1, 6], authors: [pk] }, { sentinel: $('.sentinel', v) });
  cleanups.push(() => { f.close(); R.onContacts = null; });
}
async function toggleFollow(pk) {
  if (!canSign()) return needLogin();
  snack('Updating follows…');
  await loadContacts();
  const base = R.contactsEv;
  if (!base) {
    const ok = await dialog({ title: 'Start a new follow list?', body: '<p>Your relays don’t have a follow list for this account. If you follow people from another app, add its relays first so you don’t overwrite that list.</p>', actions: [{ label: 'Cancel', value: false }, { label: 'Start new list', value: true, style: 'filled' }] });
    if (!ok) return;
  }
  const tags = (base?.tags || []).slice(), has = tags.some(t => t[0] === 'p' && t[1] === pk);
  const next = has ? tags.filter(t => !(t[0] === 'p' && t[1] === pk)) : [...tags, ['p', pk]];
  signThen({ kind: 3, content: base?.content || '', tags: next }, { purpose: 'contacts', msg: has ? `Unfollowed ${name(pk)}` : `Following ${name(pk)}` });
}
async function editProfile() {
  if (!canSign()) return needLogin();
  const fresh = await freshProfile(S.pubkey);
  const base = fresh ? safeJSON(fresh.content, {}) : {};
  const F = [['display_name', 'Display name'], ['name', 'Username'], ['about', 'About', 1], ['picture', 'Profile picture URL'], ['banner', 'Banner image URL'], ['website', 'Website'], ['nip05', 'Nostr address (NIP-05)'], ['lud16', 'Lightning address']];
  const el = overlay(`<div class="full" role="dialog"><div class="fs-bar"><button class="icon-btn sl" data-x aria-label="Close"><span class="ms">close</span></button><h2>Edit profile</h2><button class="btn filled sl" data-save>Save</button></div>
    <div class="fs-body">${F.map(([k, l, ml]) => `<label class="tf">${ml ? `<textarea name="${k}" placeholder=" ">${esc(base[k] || '')}</textarea>` : `<input name="${k}" placeholder=" " value="${esc(base[k] || '')}">`}<span>${l}</span></label>`).join('')}</div></div>`);
  $('[data-x]', el).onclick = () => closeOverlay(el);
  $('[data-save]', el).onclick = async () => {
    const out = { ...base };
    F.forEach(([k]) => { const val = $(`[name=${k}]`, el).value.trim(); if (val) out[k] = val; else delete out[k]; });
    delete out._t;
    await closeOverlay(el);
    signThen({ kind: 0, content: JSON.stringify(out) }, { purpose: 'profile', msg: 'Profile saved' });
  };
}

async function walletView(v) {
  bar({ title: 'Wallet', nav: 'wallet' });
  if (!S.nwc) {
    v.innerHTML = `<div class="empty"><span class="ms">account_balance_wallet</span><h3>Connect a Lightning wallet</h3>
      <p>Nostr Wallet Connect lets you zap in one tap. Copy a connection string from Alby Hub, Primal, Coinos, Rizful or any NWC wallet and paste it here.</p></div>
      <div style="padding:0 16px"><label class="tf"><textarea id="nwcuri" rows="3" placeholder=" " spellcheck="false" autocapitalize="off"></textarea><span>nostr+walletconnect://…</span></label>
      <small style="display:block;color:var(--on-surface-variant);margin:0 4px 16px">Set a spending budget on the wallet side. The connection secret stays on this device.</small>
      <div style="display:flex;gap:8px"><button class="btn tonal sl" id="paste"><span class="ms">content_paste</span>Paste</button><button class="btn filled sl" id="conn" style="flex:1">Connect wallet</button></div></div>`;
    $('#paste', v).onclick = async () => { try { $('#nwcuri', v).value = await navigator.clipboard.readText(); } catch { snack('Clipboard access was blocked'); } };
    $('#conn', v).onclick = async () => {
      try {
        const nwc = parseNwc($('#nwcuri', v).value);
        S.nwc = nwc; save();
        snack('Checking connection…');
        try { await nwcRequest('get_balance', {}, 20000); } catch (e) { if (!/not.*(implemented|supported)|restricted|unauthor/i.test(e.message)) throw e; }
        snack('Wallet connected'); route();
      } catch (e) { S.nwc = null; save(); snack(e.message, 5000); }
    };
    return;
  }
  v.innerHTML = `<div class="balance"><div class="lbl">Balance</div><div class="amt" id="bal">—<small>sats</small></div>
      <div class="row"><button class="btn filled sl" id="send"><span class="ms">north_east</span>Send</button><button class="btn filled sl" id="recv"><span class="ms">south_west</span>Receive</button></div></div>
    <div class="section-title">Zaps</div>
    <button class="li sl" id="defamt"><span class="ms">bolt</span><span class="txt"><span class="sup">Default zap amount</span><span class="sub">${fmtSats(S.zapAmount)} sats</span></span></button>
    <div class="section-title">Connection</div>
    <div class="li"><span class="ms">hub</span><span class="txt"><span class="sup">Wallet relay</span><span class="sub">${esc(S.nwc.relays.join(', '))}</span></span></div>
    ${S.nwc.lud16 ? `<div class="li"><span class="ms">alternate_email</span><span class="txt"><span class="sup">Lightning address</span><span class="sub">${esc(S.nwc.lud16)}</span></span></div>` : ''}
    <button class="li sl" id="disc"><span class="ms">link_off</span><span class="txt"><span class="sup">Disconnect wallet</span><span class="sub">Removes the connection from this device</span></span></button>`;
  const loadBal = async () => {
    try { const r = await nwcRequest('get_balance', {}, 20000); if (v.isConnected) $('#bal', v).innerHTML = `${Math.floor(r.balance / 1000).toLocaleString()}<small>sats</small>`; }
    catch (e) { if (v.isConnected) $('#bal', v).innerHTML = `<small>${esc(/implement|support|restricted/i.test(e.message) ? 'Balance hidden by wallet' : 'Couldn’t load balance')}</small>`; }
  };
  loadBal();
  $('#send', v).onclick = async () => {
    const pr = await dialog({ title: 'Pay invoice', body: `<label class="tf"><textarea id="pr" placeholder=" " spellcheck="false" autocapitalize="off"></textarea><span>Lightning invoice</span></label>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Continue', style: 'filled', value: el => $('#pr', el).value.trim().replace(/^lightning:/i, '') || undefined }] });
    if (!pr) return;
    const sats = bolt11Sats(pr);
    if (!sats) return snack('That isn’t a Lightning invoice with an amount');
    const ok = await dialog({ title: `Pay ${sats.toLocaleString()} sats?`, body: `<div class="inv">${esc(pr)}</div>`, actions: [{ label: 'Cancel', value: false }, { label: 'Pay', value: true, style: 'filled' }] });
    if (!ok) return;
    try { snack('Paying…', 60000); await nwcRequest('pay_invoice', { invoice: pr }); snack(`Paid ${sats.toLocaleString()} sats`); loadBal(); } catch (e) { snack(e.message, 5000); }
  };
  $('#recv', v).onclick = async () => {
    const r = await dialog({ title: 'Receive', body: `<label class="tf"><input id="ra" type="number" inputmode="numeric" placeholder=" "><span>Amount in sats</span></label><label class="tf"><input id="rd" placeholder=" "><span>Description (optional)</span></label>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Create invoice', style: 'filled', value: el => { const a = Math.floor(+$('#ra', el).value); return a > 0 ? { a, d: $('#rd', el).value } : undefined; } }] });
    if (!r) return;
    try {
      snack('Creating invoice…');
      const res = await nwcRequest('make_invoice', { amount: r.a * 1000, description: r.d || 'Lumen' });
      const qr = await qrSvg('lightning:' + res.invoice.toUpperCase());
      $('#snackbar').classList.remove('show');
      const act = await dialog({ title: `Invoice for ${r.a.toLocaleString()} sats`, body: `${qr ? `<div class="qr">${qr}</div>` : ''}<div class="inv">${esc(res.invoice)}</div>`, actions: [{ label: 'Close', value: null }, { label: 'Share', value: 'share' }, { label: 'Copy', value: 'copy', style: 'filled' }] });
      if (act === 'copy') copy(res.invoice, 'Invoice copied');
      if (act === 'share') navigator.share ? navigator.share({ text: 'lightning:' + res.invoice }).catch(() => {}) : copy(res.invoice, 'Invoice copied');
    } catch (e) { snack(e.message, 5000); }
  };
  $('#defamt', v).onclick = async () => {
    const a = await dialog({ title: 'Default zap amount', body: `<label class="tf"><input id="za" type="number" inputmode="numeric" placeholder=" " value="${S.zapAmount}"><span>Sats</span></label>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', style: 'filled', value: el => { const n = Math.floor(+$('#za', el).value); return n > 0 ? n : undefined; } }] });
    if (a) { S.zapAmount = a; save(); route(); }
  };
  $('#disc', v).onclick = async () => {
    if (await dialog({ title: 'Disconnect wallet?', body: '<p>You can reconnect any time with a new connection string.</p>', actions: [{ label: 'Cancel', value: false }, { label: 'Disconnect', value: true, style: 'filled' }] })) { S.nwc = null; save(); route(); }
  };
}

let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
function settingsView(v) {
  bar({ title: 'Settings', back: true });
  const signerLabel = { nsec: 'Private key on this device', nip07: 'Browser extension', amber: 'Amber quick sign-in', bunker: 'Remote signer (NIP-46)', readonly: 'Read-only' }[S.signer] || 'Guest';
  const accentOK = accentHue() != null;
  v.innerHTML = `
    <div class="section-title">Account</div>
    ${S.pubkey ? `<button class="li sl" data-go="#/p/${S.pubkey}"><span class="av" data-pk="${S.pubkey}">${avInner(S.pubkey)}</span><span class="txt"><span class="sup nm" data-pk="${S.pubkey}">${esc(name(S.pubkey))}</span><span class="sub">${signerLabel}</span></span></button>
      <button class="li sl" id="cp"><span class="ms">key</span><span class="txt"><span class="sup">Copy public key</span><span class="sub">${shortNpub(S.pubkey)}</span></span></button>
      ${canSign() ? `<button class="li sl" id="ed"><span class="ms">edit</span><span class="txt"><span class="sup">Edit profile</span></span></button>` : ''}
      ${S.signer === 'amber' || S.signer === 'nip07' ? `<button class="li sl" id="rs"><span class="ms">phonelink_lock</span><span class="txt"><span class="sup">Connect remote signer</span><span class="sub">Needed for private messages</span></span></button>` : ''}
      ${S.signer === 'nsec' ? `<button class="li sl" id="bk"><span class="ms">lock</span><span class="txt"><span class="sup">Back up private key</span><span class="sub">Show your nsec</span></span></button>` : ''}
      <button class="li sl" id="lo"><span class="ms">logout</span><span class="txt"><span class="sup">Sign out</span></span></button>`
      : `<button class="li sl" data-go="#/login"><span class="ms">login</span><span class="txt"><span class="sup">Sign in</span><span class="sub">You’re browsing as a guest</span></span></button>`}
    <div class="section-title">Appearance</div>
    <div class="seg" id="mode">${[['system', 'brightness_auto', 'System'], ['light', 'light_mode', 'Light'], ['dark', 'dark_mode', 'Dark']].map(([k, i, l]) => `<button class="${S.mode === k ? 'sel' : ''}" data-m="${k}"><span class="ms">${S.mode === k ? 'check' : i}</span>${l}</button>`).join('')}</div>
    <div class="swatches" id="sw">
      ${accentOK ? `<button class="sw${S.accent ? ' sel' : ''}" data-accent aria-label="Device accent color" style="background:AccentColor"><span class="ms">check</span></button>` : ''}
      ${SWATCHES.map(h => { const t = tokens(h, isDark()); return `<button class="sw${!S.accent && S.hue === h ? ' sel' : ''}" data-h="${h}" aria-label="Color ${h}"><i><b style="background:${t.primary}"></b><b style="background:${t['secondary-container']}"></b><b style="background:${t['tertiary-container']}"></b></i><span class="ms">check</span></button>`; }).join('')}
      <label class="sw${!S.accent && !SWATCHES.includes(S.hue) ? ' sel' : ''}" style="background:conic-gradient(from 0deg,oklch(.7 .15 0),oklch(.7 .15 90),oklch(.7 .15 180),oklch(.7 .15 270),oklch(.7 .15 360))" aria-label="Custom color"><span class="ms">${!S.accent && !SWATCHES.includes(S.hue) ? 'check' : 'palette'}</span><input type="color" id="cust"></label>
    </div>
    <div class="section-title">Relays</div>
    <div id="relays">${S.relays.map((r, i) => `<div class="relay-row"><span class="dot" data-r="${esc(r)}"></span><span class="u">${esc(r)}</span><button class="icon-btn sl" data-rm="${i}" aria-label="Remove relay"><span class="ms">remove_circle_outline</span></button></div>`).join('')}</div>
    <div class="add-row"><label class="tf"><input id="nr" placeholder=" " autocapitalize="off" spellcheck="false"><span>Add relay (wss://…)</span></label><button class="btn tonal sl" id="add">Add</button></div>
    <button class="li sl" id="rst"><span class="ms">restart_alt</span><span class="txt"><span class="sup">Reset to default relays</span></span></button>
    <div class="section-title">Media</div>
    <button class="li sl" id="msrv"><span class="ms">cloud_upload</span><span class="txt"><span class="sup">Upload server</span><span class="sub">${esc(mediaServer().label)}</span></span></button>
    <div class="section-title">App</div>
    ${installEvt ? `<button class="li sl" id="inst"><span class="ms">install_mobile</span><span class="txt"><span class="sup">Install Lumen</span><span class="sub">Add to your home screen</span></span></button>` : ''}
    <div class="li"><span class="ms">info</span><span class="txt"><span class="sup">Lumen 1.0</span><span class="sub">A Material You client for Nostr</span></span></div>`;
  const status = pool.listConnectionStatus?.();
  if (status) $$('.dot[data-r]', v).forEach(d => d.classList.toggle('ok', !!(status.get(d.dataset.r) ?? status.get(d.dataset.r + '/'))));
  $('#mode', v).onclick = e => { const b = e.target.closest('[data-m]'); if (b) { S.mode = b.dataset.m; save(); applyTheme(); route(); } };
  $('#sw', v).onclick = e => {
    const b = e.target.closest('[data-h],[data-accent]'); if (!b) return;
    if (b.dataset.accent !== undefined) S.accent = true; else { S.accent = false; S.hue = +b.dataset.h; }
    save(); applyTheme(); route();
  };
  $('#cust', v).onchange = e => { S.accent = false; S.hue = hexHue(e.target.value); save(); applyTheme(); route(); };
  $('#relays', v).onclick = e => { const b = e.target.closest('[data-rm]'); if (!b) return; if (S.relays.length <= 1) return snack('Keep at least one relay'); S.relays = S.relays.filter((_, i) => i !== +b.dataset.rm); save(); route(); };
  $('#add', v).onclick = () => {
    let u = $('#nr', v).value.trim(); if (!u) return;
    if (!/^wss?:\/\//.test(u)) u = 'wss://' + u;
    try { u = new URL(u).href.replace(/\/$/, ''); } catch { return snack('That isn’t a valid relay address'); }
    if (!S.relays.includes(u)) S.relays = [...S.relays, u]; save(); route();
  };
  $('#rst', v).onclick = () => { S.relays = DEFAULT_RELAYS; save(); route(); };
  $('#msrv', v).onclick = async () => {
    const pick = await menuSheet([...MEDIA_SERVERS.map(m => ({ icon: m.type === 'blossom' ? 'local_florist' : 'cloud', label: m.label, sub: m.url, value: m })),
      { icon: 'add', label: 'Custom server…', value: 'custom' }], 'Upload server');
    if (!pick) return;
    if (pick !== 'custom') { S.media = pick; save(); return route(); }
    const url = await dialog({ title: 'Custom server', body: `<label class="tf"><input id="mu" placeholder=" " autocapitalize="off" spellcheck="false"><span>https://…</span></label>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Next', style: 'filled', value: el => safeUrl($('#mu', el).value.trim()) || undefined }] });
    if (!url) return;
    const type = await menuSheet([{ icon: 'local_florist', label: 'Blossom', value: 'blossom' }, { icon: 'cloud', label: 'NIP-96', value: 'nip96' }], 'Server type');
    if (!type) return;
    S.media = { url: url.replace(/\/$/, ''), type, label: new URL(url).host }; save(); route();
  };
  $('#inst', v) && ($('#inst', v).onclick = async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; route(); });
  if (!S.pubkey) return;
  $('#cp', v).onclick = () => copy(npub(S.pubkey), 'npub copied');
  $('#ed', v) && ($('#ed', v).onclick = editProfile);
  $('#rs', v) && ($('#rs', v).onclick = openRemoteSigner);
  $('#bk', v) && ($('#bk', v).onclick = async () => {
    const ok = await dialog({ title: 'Show private key?', body: '<p>Anyone with this key controls your account. Only reveal it somewhere private.</p>', actions: [{ label: 'Cancel', value: false }, { label: 'Show', value: true, style: 'filled' }] });
    if (!ok) return;
    const nsec = nip19.nsecEncode(unhex(S.nsec));
    if (await dialog({ title: 'Your private key', body: `<div class="key-box">${nsec}</div>`, actions: [{ label: 'Done', value: false }, { label: 'Copy', value: true, style: 'filled' }] })) copy(nsec, 'Private key copied');
  });
  $('#lo', v).onclick = async () => {
    const body = S.signer === 'nsec' ? '<p>Your private key will be removed from this device. Make sure you’ve backed it up.</p>' : '<p>Your wallet connection will also be removed from this device.</p>';
    if (!await dialog({ title: 'Sign out?', body, actions: [{ label: 'Cancel', value: false }, { label: 'Sign out', value: true, style: 'filled' }] })) return;
    Object.assign(S, { pubkey: null, signer: null, nsec: null, guest: false, nwc: null, bunker: null }); save();
    dmReset(); idb.clear().catch(() => {});
    Object.assign(R, { contacts: null, contactsEv: null }); R.liked.clear(); R.boosted.clear(); R.zapped.clear();
    location.hash = '#/login';
  };
}

function loginView(v) {
  document.body.className = 'bare'; updateBarColor();
  const android = /Android/i.test(navigator.userAgent);
  const amber = `<button class="btn ${android ? 'filled' : 'tonal'} big sl" data-l="amber"><span class="ms">shield_person</span>Sign in with Amber</button>`;
  const ext = `<button class="btn ${!android ? 'filled' : 'tonal'} big sl" data-l="ext"><span class="ms">extension</span>Use browser extension</button>`;
  v.innerHTML = `<div class="login"><div class="logo">${LOGO}</div><h1>Lumen</h1><p>Your corner of Nostr. Post, boost and zap with the people you follow.</p>
    <div class="login-btns">${android ? amber + ext : ext + amber}
      <button class="btn outlined big sl" data-l="remote"><span class="ms">phonelink_lock</span>Remote signer (NIP-46)</button>
      <button class="btn outlined big sl" data-l="key"><span class="ms">key</span>Use a key</button>
      <button class="btn outlined big sl" data-l="new"><span class="ms">person_add</span>Create account</button>
      <button class="btn text sl" data-l="guest" style="align-self:center;margin-top:4px">Browse without signing in</button></div>
    <p class="fine">Amber keeps your private key inside the Amber app on Android. Quick sign-in is simplest; connect Amber as a remote signer to also use private messages.</p></div>`;
  v.onclick = async e => {
    const b = e.target.closest('[data-l]'); if (!b) return;
    const l = b.dataset.l;
    if (l === 'amber') return amberGo('get_public_key', '', { purpose: 'login' });
    if (l === 'remote') return openRemoteSigner();
    if (l === 'ext') {
      if (!window.nostr) return snack('No Nostr extension found (for example Alby or nos2x)');
      try { const pk = await window.nostr.getPublicKey(); Object.assign(S, { pubkey: pk, signer: 'nip07', nsec: null, guest: false }); save(); location.hash = '#/home'; }
      catch { snack('The extension didn’t share a key'); }
    }
    if (l === 'key') {
      const r = await dialog({ title: 'Sign in with a key', body: `<p>Paste an nsec to sign on this device, or an npub to browse read-only.</p><label class="tf"><input id="k" type="password" placeholder=" " autocomplete="off" autocapitalize="off" spellcheck="false"><span>nsec1… or npub1…</span></label>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Sign in', style: 'filled', value: el => {
          const s = $('#k', el).value.trim();
          try { const d = nip19.decode(s); if (d.type === 'nsec') return { nsec: hex(d.data) }; if (d.type === 'npub') return { pk: d.data }; } catch {}
          snack('That key isn’t valid'); return undefined;
        } }] });
      if (!r) return;
      if (r.nsec) Object.assign(S, { pubkey: getPublicKey(unhex(r.nsec)), signer: 'nsec', nsec: r.nsec, guest: false });
      else Object.assign(S, { pubkey: r.pk, signer: 'readonly', nsec: null, guest: false });
      save(); location.hash = '#/home';
    }
    if (l === 'new') {
      const sk = generateSecretKey(), nsec = nip19.nsecEncode(sk);
      const r = await dialog({ title: 'Create your account', body: `<p>This is your private key. Save it in a password manager. It can’t be recovered.</p><div class="key-box">${nsec}</div>
          <button class="btn tonal sl" id="cpk" style="margin:4px 0 8px"><span class="ms">content_copy</span>Copy key</button>
          <label class="tf"><input id="nm" placeholder=" " maxlength="50"><span>Your name</span></label>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Create account', style: 'filled', value: el => ({ name: $('#nm', el).value.trim() }) }] });
      if (!r) return;
      Object.assign(S, { pubkey: getPublicKey(sk), signer: 'nsec', nsec: hex(sk), guest: false }); save();
      if (r.name) signThen({ kind: 0, content: JSON.stringify({ name: r.name, display_name: r.name }) }, { purpose: 'profile' });
      location.hash = '#/explore'; snack('Welcome to Nostr');
    }
    if (l === 'guest') { S.guest = true; save(); location.hash = '#/explore'; }
  };
}

/* ───────────────────────── IndexedDB (upload hand-off, message cache) ───────────────────────── */
const idb = (() => {
  let dbp;
  const open = () => dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('lumen', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode), req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)),
    set: (k, v) => tx('readwrite', s => s.put(v, k)),
    del: k => tx('readwrite', s => s.delete(k)),
    clear: () => tx('readwrite', s => s.clear()),
  };
})();

/* ───────────────────────── QR codes ───────────────────────── */
let QRgen;
async function qrSvg(text) {
  try {
    QRgen ??= (await import('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm')).default;
    const q = QRgen(0, 'L'); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch { return ''; }
}

/* ───────────────────────── NIP-44 + signer crypto ───────────────────────── */
const n44 = {
  key: (sk, pk) => (nip44.getConversationKey || nip44.v2.utils.getConversationKey)(sk, pk),
  enc: (t, k) => (nip44.encrypt || nip44.v2.encrypt)(t, k),
  dec: (c, k) => (nip44.decrypt || nip44.v2.decrypt)(c, k),
};
const canCrypt = () => !!S.pubkey && (S.signer === 'nsec' || S.signer === 'bunker' || (S.signer === 'nip07' && !!window.nostr?.nip44));
async function cryptOp(op, pk, text, quiet = false) {
  if (S.signer === 'nsec') {
    const sk = unhex(S.nsec);
    if (op === 'nip44_encrypt') return n44.enc(text, n44.key(sk, pk));
    if (op === 'nip44_decrypt') return n44.dec(text, n44.key(sk, pk));
    if (op === 'nip04_decrypt') return nip04.decrypt(S.nsec, pk, text);
  }
  if (S.signer === 'nip07') {
    const [ns, fn] = op.split('_'), api = window.nostr?.[ns];
    if (!api) throw new Error(`Your extension doesn’t support ${ns.toUpperCase()}`);
    return api[fn](pk, text);
  }
  if (S.signer === 'bunker') return bunkerRpc(op, [pk, text], { quiet });
  throw new Error('Messages need a signer that can decrypt');
}

/* ───────────────────────── NIP-46 remote signing (bunker:// and nostrconnect://) ───────────────────────── */
const NC_RELAYS = ['wss://relay.nsec.app', 'wss://relay.damus.io'];
const PERMS = ['sign_event:0', 'sign_event:1', 'sign_event:3', 'sign_event:6', 'sign_event:7', 'sign_event:13', 'sign_event:9734',
  'sign_event:10050', 'sign_event:24242', 'sign_event:27235', 'nip44_encrypt', 'nip44_decrypt', 'nip04_decrypt'].join(',');
const B = { sub: null, key: '', pending: new Map(), onConnect: null };
function bunkerListen(sk, relays) {
  const cpk = getPublicKey(sk), key = cpk + relays.join();
  if (B.sub && B.key === key) return;
  B.sub?.close(); B.key = key;
  B.sub = pool.subscribeMany(relays, [{ kinds: [24133], '#p': [cpk], since: now() - 10 }], {
    async onevent(e) {
      let msg;
      try {
        const txt = e.content.includes('?iv=') ? await nip04.decrypt(hex(sk), e.pubkey, e.content) : n44.dec(e.content, n44.key(sk, e.pubkey));
        msg = JSON.parse(txt);
      } catch { return; }
      if (B.onConnect?.(e.pubkey, msg)) return;
      const p = B.pending.get(msg.id); if (!p) return;
      if (msg.result === 'auth_url') { if (msg.error && safeUrl(msg.error)) window.open(msg.error, '_blank', 'noopener'); return; }
      B.pending.delete(msg.id); clearTimeout(p.t);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    },
  });
}
async function bunkerRpc(method, params, { conf = S.bunker, timeout = 120000, quiet = false } = {}) {
  if (!conf) throw new Error('No remote signer connected');
  const sk = unhex(conf.clientSk);
  bunkerListen(sk, conf.relays);
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const content = n44.enc(JSON.stringify({ id, method, params }), n44.key(sk, conf.remote));
  const ev = finalizeEvent({ kind: 24133, created_at: now(), tags: [['p', conf.remote]], content }, sk);
  const slow = quiet ? 0 : setTimeout(() => snack('Waiting for your signer. Approve the request there.', 10000), 1800);
  try {
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => { B.pending.delete(id); reject(new Error('Your signer didn’t respond')); }, timeout);
      B.pending.set(id, { resolve, reject, t });
      Promise.any(pool.publish(conf.relays, ev)).catch(() => { B.pending.delete(id); clearTimeout(t); reject(new Error('Couldn’t reach the signer relay')); });
    });
  } finally { clearTimeout(slow); }
}
function parseBunker(uri) {
  const m = uri.trim().match(/^bunker:\/\/([0-9a-f]{64})\??(.*)$/i);
  if (!m) throw new Error('That isn’t a bunker:// link');
  const q = new URLSearchParams(m[2]), relays = q.getAll('relay');
  if (!relays.length) throw new Error('The bunker link has no relay');
  return { remote: m[1].toLowerCase(), relays, secret: q.get('secret') || '' };
}
async function connectBunker(uri) {
  const b = parseBunker(uri), sk = generateSecretKey();
  const conf = { clientSk: hex(sk), remote: b.remote, relays: b.relays };
  snack('Connecting to your signer…', 30000);
  await bunkerRpc('connect', [b.remote, b.secret, PERMS], { conf, quiet: true });
  return { conf, pk: await bunkerRpc('get_public_key', [], { conf }) };
}
function finishBunker(conf, pk) {
  pk = decodePk(pk);
  if (!pk) throw new Error('Your signer returned an invalid key');
  if (S.pubkey !== pk) { Object.assign(R, { contacts: null, contactsEv: null }); dmReset(); }
  Object.assign(S, { pubkey: pk, signer: 'bunker', bunker: conf, nsec: null, guest: false }); save();
  snack('Signer connected');
  location.hash = '#/home';
}
function nostrConnectSession() {
  const sk = generateSecretKey(), secret = hex(generateSecretKey()).slice(0, 16), relays = NC_RELAYS;
  const uri = `nostrconnect://${getPublicKey(sk)}?${relays.map(r => 'relay=' + encodeURIComponent(r)).join('&')}&secret=${secret}&perms=${encodeURIComponent(PERMS)}&name=Lumen&url=${encodeURIComponent(location.origin)}`;
  const wait = new Promise(resolve => {
    B.onConnect = (from, msg) => {
      if (msg.result !== secret && msg.result !== 'ack') return false;
      B.onConnect = null; resolve(from); return true;
    };
  });
  bunkerListen(sk, relays);
  return { uri, sk, relays, wait };
}
async function openRemoteSigner() {
  const s = nostrConnectSession();
  let done = false;
  const cancel = () => { done = true; B.onConnect = null; };
  const el = overlay(`<div class="scrim sheet-s"><div class="sheet"><div class="handle"></div><h3>Connect a remote signer</h3>
    <p class="sheet-note">Use Amber, nsec.app or any NIP-46 signer. Your key stays in the signer, and private messages work.</p>
    <div class="qr" id="ncqr">${spinner()}</div>
    <div style="display:flex;gap:8px;margin:16px 0 8px"><a class="btn filled sl" style="flex:1" href="${esc(s.uri)}"><span class="ms">open_in_new</span>Open signer app</a>
      <button class="btn tonal sl" data-cp><span class="ms">content_copy</span>Copy</button></div>
    <div class="sheet-note"><svg class="spinner" viewBox="0 0 48 48" style="width:18px;height:18px"><circle cx="24" cy="24" r="18"/></svg>Waiting for you to approve in your signer</div>
    <div class="divider"></div>
    <label class="tf"><input id="bku" placeholder=" " autocapitalize="off" spellcheck="false"><span>Or paste a bunker:// link</span></label>
    <button class="btn tonal wide sl" data-bk>Connect with link</button></div></div>`);
  qrSvg(s.uri).then(svg => { const q = $('#ncqr', el); if (q) svg ? (q.innerHTML = svg) : q.remove(); });
  el._onPop = cancel;
  el.addEventListener('click', async e => {
    if (e.target === el) { cancel(); return closeOverlay(el); }
    if (e.target.closest('[data-cp]')) copy(s.uri, 'Connection link copied');
    if (e.target.closest('[data-bk]')) {
      const uri = $('#bku', el).value.trim(); if (!uri) return;
      cancel();
      try { const { conf, pk } = await connectBunker(uri); await closeOverlay(el); finishBunker(conf, pk); }
      catch (err) { snack(err.message, 5000); }
    }
  });
  const remote = await s.wait;
  if (done) return;
  try {
    const conf = { clientSk: hex(s.sk), remote, relays: s.relays };
    snack('Signer approved. Finishing up…', 20000);
    const pk = await bunkerRpc('get_public_key', [], { conf, quiet: true });
    await closeOverlay(el); finishBunker(conf, pk);
  } catch (e) { snack(e.message, 5000); }
}

/* ───────────────────────── media uploads (Blossom / NIP-96) ───────────────────────── */
const MEDIA_SERVERS = [
  { url: 'https://blossom.primal.net', type: 'blossom', label: 'Primal (Blossom)' },
  { url: 'https://nostr.build', type: 'nip96', label: 'nostr.build (NIP-96)' },
];
const mediaServer = () => S.media || MEDIA_SERVERS[0];
const b64 = str => { let bin = ''; for (const x of new TextEncoder().encode(str)) bin += String.fromCharCode(x); return btoa(bin); };
async function uploadMedia(file, resume) {
  if (file.size > 100e6) throw new Error('That file is too large (100 MB max)');
  const server = mediaServer();
  const sha = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())));
  let apiUrl = null, t;
  if (server.type === 'nip96') {
    const info = await (await fetch(server.url + '/.well-known/nostr/nip96.json')).json();
    apiUrl = info.api_url && new URL(info.api_url, server.url).href;
    if (!apiUrl) throw new Error('That server doesn’t support NIP-96 uploads');
    t = { kind: 27235, content: '', tags: [['u', apiUrl], ['method', 'POST']] };
  } else {
    t = { kind: 24242, content: `Upload ${file.name || 'file'}`, tags: [['t', 'upload'], ['x', sha], ['expiration', String(now() + 3600)]] };
  }
  const ctx = { purpose: 'upload', server, apiUrl, sha, ...resume };
  if (S.signer === 'amber') await idb.set('upload', file);   // survives the trip to Amber and back
  const auth = await signRaw(t, ctx);
  if (!auth) return null;
  return doUpload(server, file, auth, apiUrl, sha);
}
async function doUpload(server, file, auth, apiUrl, sha) {
  const Authorization = 'Nostr ' + b64(JSON.stringify(auth));
  if (server.type === 'blossom') {
    const r = await fetch(server.url + '/upload', { method: 'PUT', headers: { Authorization, 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!r.ok) throw new Error(r.headers.get('x-reason') || `Upload failed (${r.status})`);
    const j = await r.json();
    return { url: j.url, sha: j.sha256 || sha, type: j.type || file.type };
  }
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch(apiUrl, { method: 'POST', headers: { Authorization }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === 'error') throw new Error(j.message || `Upload failed (${r.status})`);
  const tags = j.nip94_event?.tags || [], g = k => tags.find(x => x[0] === k)?.[1];
  if (!g('url')) throw new Error('The server didn’t return a link');
  return { url: g('url'), sha: g('x') || sha, type: g('m') || file.type, dim: g('dim') };
}
async function resumeUpload(auth, ctx) {
  const file = await idb.get('upload').catch(() => null);
  idb.del('upload').catch(() => {});
  const fetchEv = async id => id ? R.events.get(id) || await pool.get(S.relays, { ids: [id] }, { maxWait: 5000 }) : null;
  const [reply, quote] = await Promise.all([fetchEv(ctx.replyId), fetchEv(ctx.quoteId)]);
  let media = ctx.media || [];
  if (!file) snack('The file didn’t make it back from Amber. Attach it again.', 5000);
  else {
    snack('Uploading…', 60000);
    try { media = [...media, await doUpload(ctx.server, file, auth, ctx.apiUrl, ctx.sha)]; snack('Upload complete'); }
    catch (e) { snack(e.message, 5000); }
  }
  openComposer(reply, { quote, text: ctx.text, media });
}

/* ───────────────────────── private messages (NIP-17, reads NIP-04) ───────────────────────── */
const DM = { started: false, msgs: new Map(), listeners: new Set(), relays: [], pending: 0, eose: false, subs: [] };
const dmRelayCache = new Map();
const convKey = pks => uniq(pks.filter(p => p !== S.pubkey && isHex64(p))).sort().join(',') || S.pubkey;
const rnow = () => now() - Math.floor(Math.random() * 172800);
let dmT;
const dmNotify = () => { clearTimeout(dmT); dmT = setTimeout(() => DM.listeners.forEach(f => f()), 80); };
function dmAdd(m) { const cur = DM.msgs.get(m.id); if (cur && !cur.sending) return; DM.msgs.set(m.id, m); dmNotify(); }
function dmReset() { DM.subs.forEach(s => s.close()); Object.assign(DM, { started: false, subs: [], pending: 0, eose: false }); DM.msgs.clear(); }
async function dmRelaysOf(pk) {
  if (dmRelayCache.has(pk)) return dmRelayCache.get(pk);
  const e = await pool.get(metaRelays(), { kinds: [10050], authors: [pk] }, { maxWait: 4000 });
  const rs = (e?.tags || []).filter(t => t[0] === 'relay' && /^wss?:\/\//.test(t[1] || '')).map(t => t[1]);
  dmRelayCache.set(pk, rs); return rs;
}
async function dmStart() {
  if (DM.started || !canCrypt()) return;
  DM.started = true;
  DM.relays = uniq([...S.relays, ...await dmRelaysOf(S.pubkey)]);
  const q = []; let active = 0;
  const pump = () => {
    while (active < 4 && q.length) {
      const job = q.shift(); active++;
      job().finally(() => { active--; DM.pending--; dmNotify(); pump(); });
    }
  };
  const enqueue = fn => { DM.pending++; q.push(fn); pump(); };
  let eoses = 0; const eose = () => { if (++eoses === 2) { DM.eose = true; dmNotify(); } };
  DM.subs.push(pool.subscribeMany(DM.relays, [{ kinds: [1059], '#p': [S.pubkey], limit: 500 }], { onevent: e => enqueue(() => unwrapGift(e)), oneose: eose }));
  DM.subs.push(pool.subscribeMany(S.relays, [{ kinds: [4], '#p': [S.pubkey], limit: 200 }, { kinds: [4], authors: [S.pubkey], limit: 200 }], { onevent: e => enqueue(() => openLegacy(e)), oneose: eose }));
  setTimeout(() => { if (!DM.eose) { DM.eose = true; dmNotify(); } }, 8000);
}
const transient = e => /respond|reach|signer/i.test(e?.message || '');
async function unwrapGift(w) {
  const k = 'dm:' + w.id, cached = await idb.get(k).catch(() => undefined);
  if (cached !== undefined) { if (cached) dmAdd(cached); return; }
  try {
    const seal = JSON.parse(await cryptOp('nip44_decrypt', w.pubkey, w.content, true));
    if (seal.kind !== 13 || !verifyEvent(seal)) throw new Error('bad seal');
    const rumor = JSON.parse(await cryptOp('nip44_decrypt', seal.pubkey, seal.content, true));
    if (rumor.pubkey !== seal.pubkey || rumor.kind !== 14) throw new Error('bad rumor');
    const pks = [rumor.pubkey, ...rumor.tags.filter(t => t[0] === 'p').map(t => t[1])];
    const m = { id: rumor.id || getEventHash(rumor), from: rumor.pubkey, conv: convKey(pks), content: String(rumor.content), created_at: rumor.created_at, nip: 17 };
    idb.set(k, m).catch(() => {}); dmAdd(m);
  } catch (e) { if (!transient(e)) idb.set(k, null).catch(() => {}); }
}
async function openLegacy(e) {
  const k = 'dm4:' + e.id, cached = await idb.get(k).catch(() => undefined);
  if (cached !== undefined) { if (cached) dmAdd(cached); return; }
  const other = e.pubkey === S.pubkey ? tag(e, 'p') : e.pubkey;
  if (!isHex64(other)) return;
  try {
    const m = { id: e.id, from: e.pubkey, conv: convKey([other]), content: await cryptOp('nip04_decrypt', other, e.content, true), created_at: e.created_at, nip: 4 };
    idb.set(k, m).catch(() => {}); dmAdd(m);
  } catch (err) { if (!transient(err)) idb.set(k, null).catch(() => {}); }
}
async function sendDM(conv, text) {
  const others = conv.split(',').filter(isHex64);
  const rumor = { kind: 14, pubkey: S.pubkey, created_at: now(), tags: others.map(p => ['p', p]), content: text };
  rumor.id = getEventHash(rumor);
  const m = { id: rumor.id, from: S.pubkey, conv, content: text, created_at: rumor.created_at, nip: 17, sending: true };
  dmAdd(m);
  try {
    for (const rp of uniq([...others, S.pubkey])) {
      const seal = await signRaw({ kind: 13, created_at: rnow(), tags: [], content: await cryptOp('nip44_encrypt', rp, JSON.stringify(rumor)) });
      const ek = generateSecretKey();
      const wrap = finalizeEvent({ kind: 1059, created_at: rnow(), tags: [['p', rp]], content: n44.enc(JSON.stringify(seal), n44.key(ek, rp)) }, ek);
      const inbox = rp === S.pubkey ? DM.relays : (await dmRelaysOf(rp));
      await Promise.any(pool.publish(inbox.length ? inbox : S.relays, wrap));
    }
    DM.msgs.set(m.id, { ...m, sending: false }); dmNotify();
  } catch (e) { DM.msgs.delete(m.id); dmNotify(); throw e; }
}
function noCryptState(v) {
  const why = S.signer === 'amber' ? 'Amber quick sign-in can only sign, not decrypt. Connect Amber as a remote signer to read and send messages.'
    : S.signer === 'nip07' ? 'Your browser extension doesn’t support NIP-44 encryption. Update it or connect a remote signer.'
    : 'This account is read-only. Sign in with a key or signer to use messages.';
  v.innerHTML = emptyState('lock', 'Messages need a signer that can decrypt', why,
    S.signer === 'amber' || S.signer === 'nip07' ? `<button class="btn filled sl" data-rs>Connect remote signer</button>` : `<button class="btn filled sl" data-go="#/login">Sign in</button>`);
  $('[data-rs]', v)?.addEventListener('click', openRemoteSigner);
}
async function newChat() {
  const q = await dialog({ title: 'New message', body: `<label class="tf"><input id="to" placeholder=" " autocapitalize="off" spellcheck="false"><span>npub or name@domain</span></label><p style="margin-top:12px">You can also tap the mail icon on anyone’s profile.</p>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Start chat', style: 'filled', value: el => $('#to', el).value.trim() || undefined }] });
  if (!q) return;
  const pk = await resolveUser(q);
  if (!pk) return snack('Couldn’t find that account. Check the npub or address.');
  location.hash = '#/dm/' + pk;
}
function messagesView(v) {
  bar({ title: 'Messages', nav: 'messages', fab: canCrypt() ? { icon: 'edit_square', label: 'New chat', fn: newChat } : null });
  if (!S.pubkey) { v.innerHTML = emptyState('forum', 'No account', 'Sign in to send and receive private messages.', `<button class="btn filled sl" data-go="#/login">Sign in</button>`); return; }
  if (!canCrypt()) return noCryptState(v);
  dmStart();
  v.innerHTML = `<div class="inbox-note"></div><div class="convs"></div>`;
  const render = () => {
    const last = new Map();
    for (const m of DM.msgs.values()) { const c = last.get(m.conv); if (!c || c.created_at < m.created_at) last.set(m.conv, m); }
    const list = [...last.values()].sort((a, b) => b.created_at - a.created_at), box = $('.convs', v);
    const more = DM.pending ? `<p class="end">Decrypting ${DM.pending} message${DM.pending > 1 ? 's' : ''}…</p>` : '';
    if (!list.length) {
      box.innerHTML = DM.pending || !DM.eose ? spinner() + more : emptyState('forum', 'No messages yet', 'Start a private conversation. Messages are end-to-end encrypted and hide who’s talking to whom.');
      return;
    }
    box.innerHTML = list.map(m => {
      const others = m.conv.split(','); others.forEach(want);
      return `<button class="li sl" data-go="#/dm/${m.conv}"><span class="av" data-pk="${others[0]}">${avInner(others[0])}</span>
        <span class="txt"><span class="sup">${others.map(p => `<span class="nm" data-pk="${p}">${esc(name(p))}</span>`).join(', ')}</span>
        <span class="sub">${m.from === S.pubkey ? 'You: ' : ''}${esc(m.content.slice(0, 100))}</span></span><span class="meta">${ago(m.created_at)}</span></button>`;
    }).join('') + more;
  };
  DM.listeners.add(render); cleanups.push(() => DM.listeners.delete(render)); render();
  dmRelaysOf(S.pubkey).then(rs => {
    if (rs.length || !v.isConnected) return;
    $('.inbox-note', v).innerHTML = `<div class="card"><div class="sup" style="font-size:16px;font-weight:500">Let people message you</div>
      <p style="color:var(--on-surface-variant);margin:6px 0 14px">Publish your inbox relays so other apps know where to deliver your messages.</p>
      <button class="btn tonal sl" data-inbox>Publish inbox relays</button></div>`;
  });
  v.addEventListener('click', e => {
    if (e.target.closest('[data-inbox]')) signThen({ kind: 10050, tags: S.relays.slice(0, 3).map(r => ['relay', r]) }, { purpose: 'inbox', msg: 'Inbox relays published' });
  });
}
function dmView(v, arg) {
  const pks = decodeURIComponent(arg).split(',').map(decodePk).filter(Boolean);
  if (!pks.length) { bar({ title: 'Chat', back: true }); v.innerHTML = emptyState('person_off', 'Chat not found'); return; }
  const conv = convKey(pks), others = conv.split(',');
  others.forEach(want);
  bar({ title: others.map(name).join(', '), back: true });
  if (!canCrypt()) return noCryptState(v);
  dmStart();
  document.body.classList.add('chat');
  v.innerHTML = `<div class="chat-list"></div>`;
  const cb = document.createElement('div'); cb.className = 'chat-bar';
  cb.innerHTML = `<div class="chat-in"><textarea rows="1" placeholder="Message" aria-label="Message"></textarea><button class="send sl" aria-label="Send" disabled><span class="ms fill">send</span></button></div>`;
  document.body.append(cb);
  const onProfile = setInterval(() => { $('#bar-title').textContent = others.map(name).join(', '); }, 1500);
  cleanups.push(() => { cb.remove(); document.body.classList.remove('chat'); clearInterval(onProfile); });
  const ta = $('textarea', cb), send = $('.send', cb), listEl = $('.chat-list', v);
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; send.disabled = !ta.value.trim(); };
  ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !/Android|iPhone|iPad/i.test(navigator.userAgent)) { e.preventDefault(); send.click(); } };
  send.onclick = async () => {
    const t = ta.value.trim(); if (!t) return;
    ta.value = ''; ta.oninput();
    try { await sendDM(conv, t); } catch (e) { ta.value = t; ta.oninput(); snack('Message not sent: ' + e.message, 5000); }
  };
  let first = true;
  const render = () => {
    const nearBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 160;
    const msgs = [...DM.msgs.values()].filter(m => m.conv === conv).sort((a, b) => a.created_at - b.created_at);
    if (!msgs.length) {
      listEl.innerHTML = DM.eose && !DM.pending ? emptyState('lock', 'Start the conversation', 'Messages are end-to-end encrypted. Only the people in this chat can read them.') : spinner();
      return;
    }
    let html = '', lastDay = '', prev = null;
    for (const m of msgs) {
      const d = new Date(m.created_at * 1000), day = d.toDateString();
      if (day !== lastDay) { html += `<div class="day">${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>`; lastDay = day; prev = null; }
      const me = m.from === S.pubkey, gap = !prev || prev.from !== m.from || m.created_at - prev.created_at > 300;
      if (gap && !me && others.length > 1) html += `<div class="bub-name nm" data-pk="${m.from}">${esc(name(m.from))}</div>`;
      html += `<div class="bub${me ? ' me' : ''}${gap ? ' gap' : ''}${m.sending ? ' sending' : ''}">${renderText(m.content)}
        <div class="t">${m.sending ? 'Sending…' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${m.nip === 4 ? ' · old format' : ''}</div></div>`;
      prev = m;
    }
    listEl.innerHTML = html;
    if (first || nearBottom) { scrollTo(0, document.documentElement.scrollHeight); first = false; }
  };
  DM.listeners.add(render); cleanups.push(() => DM.listeners.delete(render)); render();
}

/* ───────────────────────── search (NIP-50, hashtags, NIP-05) ───────────────────────── */
const SEARCH_RELAYS = ['wss://relay.nostr.band', 'wss://search.nos.today'];
async function resolveUser(q) {
  q = q.trim();
  const pk = decodePk(q); if (pk) return pk;
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(q)) {
    const [n, d] = q.split('@');
    try {
      const j = await (await fetch(`https://${d}/.well-known/nostr.json?name=${encodeURIComponent(n)}`)).json();
      const p = j.names?.[n] ?? j.names?.[n.toLowerCase()];
      if (isHex64(p)) return p;
    } catch {}
  }
  return null;
}
const personHTML = pk => {
  const p = profile(pk);
  const sub = p.nip05 ? String(p.nip05).replace(/^_@/, '') : (p.about || shortNpub(pk)).replace(/\s+/g, ' ').slice(0, 90);
  return `<button class="li sl" data-go="#/p/${pk}"><span class="av" data-pk="${pk}">${avInner(pk)}</span><span class="txt"><span class="sup nm" data-pk="${pk}">${esc(name(pk))}</span><span class="sub">${esc(sub)}</span></span></button>`;
};
async function searchView(v, arg) {
  bar({ title: '', back: true });
  const q = decodeURIComponent(arg || '').trim();
  $('#bar-title').innerHTML = `<input class="bar-search" id="sq" type="search" enterkeyhint="search" placeholder="Search people, posts, #tags" autocomplete="off" value="${esc(q)}">`;
  const input = $('#sq');
  input.onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); const nq = input.value.trim();
    if (nq && nq !== q) location.replace('#/search/' + encodeURIComponent(nq)); else input.blur();
  };
  if (!q) {
    v.innerHTML = emptyState('search', 'Search Nostr', 'Find people by name, posts by keyword, or topics with #hashtags. You can also paste an npub, a note link or a name@domain address.');
    setTimeout(() => input.focus(), 60); return;
  }
  const id = decodeId(q); if (id) return location.replace('#/n/' + id);
  if (decodePk(q)) return location.replace('#/p/' + decodePk(q));
  if (q.includes('@')) {
    v.innerHTML = spinner();
    const pk = await resolveUser(q);
    if (pk) return location.replace('#/p/' + pk);
    if (!v.isConnected) return;
  }
  const tagMode = /^#[\p{L}\p{N}_]+$/u.test(q);
  v.innerHTML = `${tagMode ? '' : `<div class="tabs" role="tablist"><button role="tab" data-t="people">People</button><button role="tab" data-t="posts">Posts</button></div>`}<div class="res"></div>`;
  let close = null, tab;
  const show = t => {
    tab = t; close?.(); close = null;
    $$('.tabs button', v).forEach(b => b.classList.toggle('sel', b.dataset.t === t));
    const res = $('.res', v);
    if (t === 'people') {
      res.innerHTML = spinner();
      pool.querySync(SEARCH_RELAYS, { kinds: [0], search: q, limit: 30 }, { maxWait: 6000 }).then(evs => {
        if (!v.isConnected || tab !== 'people') return;
        const best = new Map();
        evs.forEach(e => { if (!best.has(e.pubkey) || best.get(e.pubkey).created_at < e.created_at) best.set(e.pubkey, e); });
        best.forEach(e => setProfile(e));
        res.innerHTML = best.size ? [...best.keys()].map(personHTML).join('') : emptyState('person_search', 'No people found', 'Try a different spelling, or paste their npub.');
      });
    } else {
      res.innerHTML = `<div class="list"></div><div class="sentinel">${spinner()}</div>`;
      const filter = tagMode ? { kinds: [1], '#t': [q.slice(1).toLowerCase()] } : { kinds: [1], search: q };
      const f = mountFeed($('.list', res), filter, { sentinel: $('.sentinel', res), live: tagMode, relays: tagMode ? uniq([...S.relays, ...SEARCH_RELAYS]) : SEARCH_RELAYS });
      close = f.close;
    }
  };
  $('.tabs', v)?.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) show(b.dataset.t); });
  show(tagMode ? 'posts' : 'people');
  cleanups.push(() => close?.());
}

/* ───────────────────────── router ───────────────────────── */
function route() {
  cleanups.forEach(f => { try { f(); } catch {} }); cleanups = [];
  $('#overlay-root').replaceChildren();
  const h = location.hash || '#/home';
  if (!S.pubkey && !S.guest && h !== '#/login') return location.replace('#/login');
  const [, nm = 'home', arg = ''] = h.match(/^#\/([^/]*)\/?(.*)$/) || [];
  R.hops++;
  const v = document.createElement('div'); v.className = 'view';
  $('#main').replaceChildren(v); scrollTo(0, 0);
  $('#appbar').classList.remove('scrolled');
  switch (nm) {
    case 'login': return loginView(v);
    case 'explore': return exploreView(v);
    case 'notifications': return notificationsView(v);
    case 'wallet': return walletView(v);
    case 'messages': return messagesView(v);
    case 'dm': return dmView(v, arg);
    case 'search': return searchView(v, arg);
    case 'settings': return settingsView(v);
    case 'p': return profileView(v, decodeURIComponent(arg));
    case 'n': return threadView(v, decodeURIComponent(arg));
    case 'compose': location.replace('#/home'); return setTimeout(() => canSign() && openComposer(), 400);
    case 'open': {
      const s = decodeURIComponent(arg), pk = decodePk(s), id = decodeId(s);
      return location.replace(pk ? '#/p/' + pk : id ? '#/n/' + id : '#/home');
    }
    default: return homeView(v);
  }
}

/* ───────────────────────── global wiring ───────────────────────── */
document.addEventListener('pointerdown', e => {
  const t = e.target.closest('.sl'); if (!t) return;
  const r = t.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2.2;
  const s = document.createElement('span'); s.className = 'ripple-wave';
  s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
  t.append(s); setTimeout(() => s.remove(), 550);
});
document.addEventListener('click', e => {
  const cpk = e.target.closest('#cpk');
  if (cpk) return copy(cpk.closest('.body').querySelector('.key-box').textContent, 'Private key copied');
  const act = e.target.closest('[data-act]');
  if (act) { e.preventDefault(); return doAct(act.dataset.act, act.closest('[data-id]')?.dataset.id); }
  if (e.target.closest('a[href]')) return;
  const go = e.target.closest('[data-go]');
  if (go) { e.preventDefault(); location.hash = go.dataset.go; return; }
  const img = e.target.closest('img.media'); if (img) return lightbox(img.src);
  if (e.target.closest('button,video,input,textarea,label,.dialog,.sheet,.full')) return;
  const n = e.target.closest('.note[data-id]');
  if (n && !n.classList.contains('focus') && !getSelection().toString()) location.hash = '#/n/' + n.dataset.id;
});
$('#navbar').addEventListener('click', e => {
  const a = e.target.closest('a');
  if (a?.classList.contains('active')) { e.preventDefault(); scrollTo({ top: 0, behavior: 'smooth' }); R.currentFeed?.flushNew(); }
});
$('#fab').onclick = () => R.fab?.();
let lastY = 0;
addEventListener('scroll', () => {
  const y = scrollY, bar = $('#appbar'), was = bar.classList.contains('scrolled');
  bar.classList.toggle('scrolled', y > 4);
  $('#fab').classList.toggle('shrink', y > lastY && y > 80);
  lastY = y;
  if (was !== y > 4) updateBarColor();
}, { passive: true });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

applyTheme();
handleAmberReturn();
addEventListener('hashchange', route);
route();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
