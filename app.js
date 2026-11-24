'use strict';
/* Steam Lists — списки игр Steam с переносом, своим порядком и фильтрами.
   Данные: приватный репо пользователя (lists.json пишет приложение,
   library.json и steam-collections.json пишет скрипт tools/steam-sync.ps1).
   Настройки (репо, токен) только в localStorage этого браузера. */

const $ = s => document.querySelector(s);
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('sl.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem('sl.' + k, JSON.stringify(v)),
};
const cfg = LS.get('cfg', { repo: '', token: '' });

const state = {
  games: new Map(),          // appid -> game
  lists: LS.get('lists', []),// [{id,name,items:[appid],steamId?}]
  view: LS.get('view', 'all'),// 'all' | 'none' | list id
  sel: new Set(),
  lastClick: null,
  shas: {},
  dirty: false,
  tags: new Set(),           // активные теги-фильтры
  pins: LS.get('pins', {}),  // закреплённые ачивки: {appid: {apiname: {n,d,i}}}
};

/* ---------- GitHub storage ---------- */
const enc = s => { const b = new TextEncoder().encode(s); let r = ''; for (let i = 0; i < b.length; i += 0x8000) r += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(r); };
const dec = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), c => c.charCodeAt(0)));

async function gh(path, opt = {}) {
  const r = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, {
    ...opt, cache: 'no-store',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: opt.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', ...(opt.headers || {}) },
  });
  return r;
}
async function load(path) {
  const r = await gh(path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  const j = await r.json();
  state.shas[path] = j.sha;
  if (j.content) return JSON.parse(dec(j.content));
  const raw = await gh(path, { raw: true });          // файл > 1 МБ
  return raw.json();
}
async function store(path, obj, msg) {
  const body = { message: msg, content: enc(JSON.stringify(obj, null, 1)) };
  if (state.shas[path]) body.sha = state.shas[path];
  let r = await gh(path, { method: 'PUT', body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) {          // файл изменился на другом устройстве
    await load(path).catch(() => {}); if (state.shas[path]) body.sha = state.shas[path];
    r = await gh(path, { method: 'PUT', body: JSON.stringify(body) });
  }
  if (!r.ok) throw new Error(`save ${path}: ${r.status}`);
  state.shas[path] = (await r.json()).content.sha;
}

/* ---------- sync ---------- */
function status(t) { $('#status').textContent = t; }
let saveTimer;
function changed() {
  state.dirty = true; LS.set('lists', state.lists); LS.set('pins', state.pins); status('● не сохранено');
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 1500);
}
async function save() {
  if (!cfg.repo || !cfg.token) { status('нет репо — только локально'); return; }
  try {
    status('сохраняю…');
    await store('lists.json', { version: 1, updated: new Date().toISOString(), lists: state.lists, pins: state.pins }, 'Обновлены списки');
    state.dirty = false; status('✓ сохранено');
  } catch (e) { status('⚠ ' + e.message); }
}
async function pull() {
  setLibrary(LS.get('library', null));
  render();
  if (!cfg.repo || !cfg.token) { status('настрой репо ⚙'); return; }
  try {
    status('загружаю…');
    const [lib, lists] = await Promise.all([load('library.json'), load('lists.json')]);
    if (lib) { LS.set('library', lib); setLibrary(lib); }
    if (lists && !state.dirty) { state.lists = lists.lists || []; state.pins = lists.pins || {}; LS.set('lists', state.lists); LS.set('pins', state.pins); }
    status(lib ? '✓' : 'нет library.json — запусти steam-sync на ПК');
  } catch (e) { status('⚠ ' + e.message); render(); return; }
  render();
  // авто-⟳: если библиотека старше часа
  const L = LS.get('library', null);
  if (L?.updated && Date.now() - Date.parse(L.updated) > 3600e3) steamSync(true);
}
function setLibrary(lib) {
  state.games.clear();
  for (const g of lib?.games || []) state.games.set(g.appid, g);
  // игры из списков, которых нет в библиотеке (ещё не синкнули) — заглушки
  for (const l of state.lists) for (const id of l.items || []) if (!state.games.has(id)) state.games.set(id, { appid: id, name: `App ${id}`, stub: true });
  // жанры (рус., из магазина) и теги (англ., SteamSpy) отдельно; теги-дубли жанров убираем
  const gc = {}, tc = {};
  for (const g of state.games.values()) {
    for (const t of g.genres || []) gc[t] = (gc[t] || 0) + 1;
    for (const t of g.tags || []) if (!GENRE_EN.has(norm(t))) tc[t] = (tc[t] || 0) + 1;
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  state.topGenres = top(gc, 30); state.topTags = top(tc, 80);
  $('#libInfo').textContent = lib ? `Библиотека: ${lib.games.length} игр, обновлена ${new Date(lib.updated).toLocaleString()}` : 'Библиотека ещё не загружена.';
}

/* ---------- filter / sort ---------- */
function parseQuery(q) {
  const f = { text: [], tag: [], genre: [], cond: [] };
  for (const tok of q.match(/\w+:"[^"]+"|"[^"]+"|\S+/g) || []) {
    const t = tok.replace(/"/g, '');
    let m;
    if ((m = t.match(/^(tag|genre):(.+)$/i))) f[m[1].toLowerCase()].push(m[2].toLowerCase());
    else if ((m = t.match(/^(h|ach)([<>]=?|=)(\d+)$/i))) f.cond.push([m[1].toLowerCase(), m[2], +m[3]]);
    else if (/^played$/i.test(t)) f.cond.push(['h', '>', 0]);
    else if (/^new$/i.test(t)) f.cond.push(['h', '=', 0]);
    else f.text.push(t.toLowerCase());
  }
  return f;
}
const cmp = (a, op, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;
const achPct = g => g.ach && g.ach[1] ? Math.round(100 * g.ach[0] / g.ach[1]) : null;
const GENRE_EN = new Set(['action','adventure','indie','rpg','strategy','simulation','casual','sports','racing','massivelymultiplayer','earlyaccess','freetoplay','singleplayer','multiplayer']);
const norm = x => String(x).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function match(g, f, noChips) {
  const nm = (g.name || '').toLowerCase();
  if (f.text.some(t => !nm.includes(t))) return false;
  const tags = (g.tags || []).map(norm), gen = (g.genres || []).map(norm);
  if (f.tag.some(t => !tags.some(x => x.includes(norm(t))) && !gen.some(x => x.includes(norm(t))))) return false;
  if (f.genre.some(t => !gen.some(x => x.includes(norm(t))))) return false;
  if (!noChips) for (const t of state.tags) if (!tags.includes(norm(t)) && !gen.includes(norm(t))) return false;
  for (const [k, op, v] of f.cond) {
    const x = k === 'h' ? (g.hours || 0) : achPct(g);
    if (x === null || !cmp(x, op, v)) return false;
  }
  return true;
}
const isSmart = l => !!(l && l.query != null);
const manual = () => state.lists.filter(l => !isSmart(l));
function smartIds(l) { const f = parseQuery(l.query); return [...state.games.keys()].filter(id => match(state.games.get(id), f, true)); }
function currentIds() {
  const inAny = new Set(manual().flatMap(l => l.items));
  const sm = state.lists.find(l => l.id === state.view && isSmart(l));
  if (sm) return smartIds(sm);
  if (state.view === 'all') return [...state.games.keys()];
  if (state.view === 'none') return [...state.games.keys()].filter(id => !inAny.has(id));
  return curList()?.items.slice() || [];
}
const curList = () => state.lists.find(l => l.id === state.view && !isSmart(l));
function visible() {
  const f = parseQuery($('#q').value);
  let ids = currentIds().filter(id => state.games.has(id) && match(state.games.get(id), f));
  const s = $('#sort').value, G = id => state.games.get(id);
  const by = {
    name: (a, b) => (G(a).name || '').localeCompare(G(b).name || ''),
    hours: (a, b) => (G(b).hours || 0) - (G(a).hours || 0),
    last: (a, b) => (G(b).last || 0) - (G(a).last || 0),
    ach: (a, b) => (achPct(G(b)) ?? -1) - (achPct(G(a)) ?? -1),
  }[s === 'order' && !curList() ? 'name' : s];
  if (by) ids.sort(by);
  return ids;
}

/* ---------- render ---------- */
const CDN = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps';
// у новых игр картинки лежат по адресу с хэшем: capsule → header.jpg → адрес из магазина (g.img) → скрыть
function imgFail(el, id) {
  const st = +(el.dataset.st || 0); el.dataset.st = st + 1;
  if (st === 0) el.src = `${CDN}/${id}/header.jpg`;
  else if (st === 1 && el.dataset.alt) el.src = el.dataset.alt;
  else { el.onerror = null; el.style.visibility = 'hidden'; }
}
function render() {
  const inAny = new Set(manual().flatMap(l => l.items));
  const side = $('#side'); side.innerHTML = '';
  const item = (id, name, n, editable, icon) => {
    const d = document.createElement('div');
    d.className = 'it' + (state.view === id ? ' on' : ''); d.dataset.id = id;
    d.innerHTML = `<span class="ic">${icon}</span><span class="nm"></span><span class="n">${n}</span>${editable ? '<span class="eds"><button class="ed" data-e="up" title="Выше">▲</button><button class="ed" data-e="ren" title="Переименовать">✎</button><button class="ed" data-e="del" title="Удалить">✕</button></span>' : ''}`;
    d.querySelector('.nm').textContent = name;
    side.append(d);
  };
  const sec = t => { const h = document.createElement('div'); h.className = 'sec'; h.textContent = t; side.append(h); };
  sec('Библиотека');
  item('all', 'Вся библиотека', state.games.size, false, '🎮');
  item('none', 'Без списка', [...state.games.keys()].filter(i => !inAny.has(i)).length, false, '📥');
  item('goals', 'Цели', pinCount(), false, '🎯');
  sec('Мои списки');
  manual().forEach((l, i) => item(l.id, l.name, l.items.length, true, `<b>${i + 1}</b>`));
  const add = document.createElement('button'); add.className = 'add'; add.textContent = '+ Новый список'; add.dataset.e = 'add';
  side.append(add);
  sec('Умные списки');
  state.lists.filter(isSmart).forEach(l => item(l.id, l.name, smartIds(l).length, true, '⚡'));
  const sadd = document.createElement('button'); sadd.className = 'add'; sadd.textContent = '⚡ Из текущего поиска'; sadd.dataset.e = 'smart';
  side.append(sadd);

  const tb = $('#tagbar'); tb.innerHTML = ''; tb.classList.toggle('open', !!state.tagsOpen);
  const row = (label, items, cls) => {
    const r = document.createElement('div'); r.className = 'trow ' + cls;
    r.innerHTML = `<span class="lab">${label}</span><div class="chs"></div>`;
    const box = r.querySelector('.chs');
    // выбранные — первыми, чтобы были видны и в свёрнутом виде
    const sorted = [...items].sort((a, b) => state.tags.has(b[0]) - state.tags.has(a[0]));
    for (const [t, n] of sorted) {
      const s = document.createElement('span'); s.className = 'ch' + (state.tags.has(t) ? ' on' : '');
      s.innerHTML = `<i></i><small>${n}</small>`; s.querySelector('i').textContent = t;
      s.onclick = () => { state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t); render(); };
      box.append(s);
    }
    tb.append(r);
  };
  if (state.topGenres?.length) row('Жанры', state.topGenres, 'gen');
  if (state.topTags?.length) row('Теги', state.topTags, 'tag');
  if (state.topGenres?.length || state.topTags?.length) {
    const ctl = document.createElement('div'); ctl.className = 'tctl';
    ctl.innerHTML = `<button class="more">${state.tagsOpen ? 'Свернуть ▴' : 'Все жанры и теги ▾'}</button>${state.tags.size ? `<button class="clr">✕ Сбросить (${state.tags.size})</button>` : ''}`;
    ctl.querySelector('.more').onclick = () => { state.tagsOpen = !state.tagsOpen; render(); };
    if (state.tags.size) ctl.querySelector('.clr').onclick = () => { state.tags.clear(); render(); };
    tb.append(ctl);
  }

  $('#tagbar').hidden = state.view === 'goals';
  if (state.view === 'goals') { renderGoals(); LS.set('view', state.view); return; }
  const ids = visible(); state.visible = ids;
  for (const id of [...state.sel]) if (!ids.includes(id)) state.sel.delete(id);
  // шапка: название и сводка по тому, что сейчас видно
  const view = state.lists.find(l => l.id === state.view);
  const title = view ? (isSmart(view) ? '⚡ ' : '') + view.name : state.view === 'none' ? 'Без списка' : 'Вся библиотека';
  const G = ids.map(i => state.games.get(i));
  const hrs = G.reduce((a, g) => a + (g.hours || 0), 0);
  const withAch = G.filter(g => g.ach && g.ach[1]);
  const achAvg = withAch.length ? Math.round(withAch.reduce((a, g) => a + g.ach[0] / g.ach[1], 0) / withAch.length * 100) : null;
  const perfect = withAch.filter(g => g.ach[0] === g.ach[1]).length;
  const fresh = G.filter(g => !g.hours).length;
  $('#head').classList.toggle('hid', !!LS.get('headHidden', false));
  $('#head').innerHTML = `<h2></h2><button class="hx" title="Скрыть/показать сводку">${LS.get('headHidden', false) ? '▸' : '▾'}</button><div class="stats">
    <span><b>${ids.length}</b> игр</span><span><b>${Math.round(hrs).toLocaleString()}</b> ч наиграно</span>
    <span><b>${fresh}</b> не запускал</span>${achAvg !== null ? `<span>ачивки в среднем <b>${achAvg}%</b></span><span>🏆 <b>${perfect}</b> на 100%</span>` : ''}
    ${view && isSmart(view) ? `<span class="q">фильтр: <code></code></span>` : ''}</div>`;
  $('#head h2').textContent = title;
  $('#head .hx').onclick = () => { LS.set('headHidden', !LS.get('headHidden', false)); render(); };
  if (view && isSmart(view)) $('#head code').textContent = view.query;

  const box = $('#list'); box.innerHTML = '';
  if (!ids.length) box.innerHTML = `<div class="empty">${state.games.size ? '🕳 Здесь пусто. Перетащи сюда игры или поменяй фильтр.' : '🎮 Библиотека пуста.<br>Нажми ?, там по шагам: репо, токен, sync.cmd на ПК.'}</div>`;
  const frag = document.createDocumentFragment();
  const date = t => t ? new Date(t * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  for (const id of ids.slice(0, 3000)) {
    const g = state.games.get(id), p = achPct(g);
    const d = document.createElement('div');
    d.className = 'g' + (state.sel.has(id) ? ' sel' : '') + (p === 100 ? ' perfect' : ''); d.dataset.id = id; d.draggable = true;
    const where = manual().filter(l => l.items.includes(id) && l.id !== state.view).map(l => l.name);
    d.innerHTML = `<img loading="lazy" alt="" src="${CDN}/${id}/capsule_184x69.jpg" data-alt="${g.img || ''}" onerror="imgFail(this, ${id})">
      <div class="t"><div class="nm"></div><div class="meta"></div><div class="chips"></div></div>
      <div class="ach">${p !== null ? `<div class="lbl">${p === 100 ? '🏆 ' : ''}${g.ach[0]}/${g.ach[1]} · ${p}%</div><div class="bar"><i style="width:${p}%"></i></div>` : ''}</div>
      <div class="num"><b>${g.hours ? g.hours.toFixed(1) : '—'}</b>${g.hours ? ' ч' : ''}<small>${date(g.last)}</small></div>
      <button class="inf" title="Об игре и ачивки">ⓘ</button><a class="play" href="steam://run/${id}" title="Запустить в Steam">▶</a>`;
    d.querySelector('.nm').textContent = g.name;
    d.querySelector('.meta').textContent = (g.genres || []).slice(0, 3).join(' · ');
    const ch = d.querySelector('.chips');
    for (const w of where) { const c = document.createElement('span'); c.className = 'in'; c.textContent = '🗂 ' + w; ch.append(c); }
    for (const t of (g.tags || []).filter(t => !GENRE_EN.has(norm(t))).slice(0, 4)) { const c = document.createElement('span'); c.className = 'tg' + (state.tags.has(t) ? ' on' : ''); c.textContent = t; c.dataset.tag = t; ch.append(c); }
    frag.append(d);
  }
  box.append(frag);
  $('#selbar').hidden = !state.sel.size;
  $('#selCount').textContent = `✔ ${state.sel.size}`;
  if (!state.sel.size) setBg(null);
  const inList = !!curList(), ordered = inList && $('#sort').value === 'order';
  $('#selbar [data-act=remove]').hidden = !inList;
  $('#selbar [data-act=top]').hidden = $('#selbar [data-act=bottom]').hidden = !ordered;
  LS.set('view', state.view);
}

// выделение без перерисовки списка (ничего не прыгает)
// фон выбранной игры: плавная смена двух слоёв (hero из библиотеки Steam → фон страницы магазина → обложка)
let bgLayer = 0, bgFor = null;
const bgUrls = id => { const g = state.games.get(id) || {}; return [`${CDN}/${id}/library_hero.jpg`, `${CDN}/${id}/page_bg_generated_v6b.jpg`, g.img, `${CDN}/${id}/header.jpg`].filter(Boolean); };
// подгружаем фон заранее, пока курсор над игрой — к клику он уже в кэше браузера
let hoverT;
document.addEventListener('mouseover', e => {
  const g = e.target.closest && e.target.closest('.g'); if (!g) return;
  clearTimeout(hoverT); hoverT = setTimeout(() => { new Image().src = bgUrls(+g.dataset.id)[0]; }, 150);
});
function setBg(id) {
  if (id === bgFor) return; bgFor = id;
  const L = document.querySelectorAll('#bg i');
  if (id == null) { L.forEach(x => x.classList.remove('on')); return; }
  const urls = bgUrls(id);
  const tryUrl = k => {
    if (k >= urls.length || bgFor !== id) return;
    const im = new Image();
    im.onload = () => {
      if (bgFor !== id) return;
      const next = L[bgLayer ^ 1], cur = L[bgLayer];
      next.style.backgroundImage = `url("${urls[k]}")`; next.classList.toggle('blur', k >= 2);
      next.classList.add('on'); cur.classList.remove('on'); bgLayer ^= 1;
    };
    im.onerror = () => tryUrl(k + 1);
    im.src = urls[k];
  };
  tryUrl(0);
}
function updateSel() {
  for (const el of $('#list').children) if (el.dataset.id) el.classList.toggle('sel', state.sel.has(+el.dataset.id));
  setBg(state.sel.size ? (state.sel.has(state.lastClick) ? state.lastClick : [...state.sel].pop()) : null);
  $('#selbar').hidden = !state.sel.size;
  $('#selCount').textContent = `✔ ${state.sel.size}`;
}

/* ---------- list operations ---------- */
const uid = () => 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function moveTo(targetId, ids, copy) {
  const t = state.lists.find(l => l.id === targetId); if (!t || isSmart(t)) return;
  const src = curList();
  if (!copy) {   // перенос: из текущего списка, а из «Вся библиотека» — из всех остальных списков
    for (const l of src ? [src] : manual()) if (l !== t) l.items = l.items.filter(i => !ids.includes(i));
  }
  for (const id of ids) if (!t.items.includes(id)) t.items.push(id);
  state.sel.clear(); changed(); render();
}
function removeFrom(ids) { const l = curList(); if (!l) return; l.items = l.items.filter(i => !ids.includes(i)); state.sel.clear(); changed(); render(); }
function reorder(ids, beforeId) {   // вставить ids перед beforeId (null = в конец)
  const l = curList(); if (!l) return;
  const rest = l.items.filter(i => !ids.includes(i));
  const k = beforeId == null ? rest.length : Math.max(0, rest.indexOf(beforeId));
  const keep = l.items.filter(i => ids.includes(i));   // сохраняем их взаимный порядок
  rest.splice(k, 0, ...keep); l.items = rest; changed(); render();
}
function pickList(title, cb) {
  const dlg = $('#pick'); $('#pickTitle').textContent = title;
  const box = $('#pickList'); box.innerHTML = '';
  state.lists.forEach((l, i) => {
    if (l.id === state.view || isSmart(l)) return;
    const b = document.createElement('button'); b.type = 'button'; b.textContent = `${i + 1}. ${l.name}`;
    b.onclick = () => { dlg.close(); cb(l.id); }; box.append(b);
  });
  const nb = document.createElement('button'); nb.type = 'button'; nb.textContent = '+ Новый список…';
  nb.onclick = () => { dlg.close(); const id = newList(); if (id) cb(id); }; box.append(nb);
  dlg.showModal();
}
function currentQuery() {
  return [$('#q').value.trim(), ...[...state.tags].map(t => /\s/.test(t) ? `tag:"${t}"` : `tag:${t}`)].filter(Boolean).join(' ');
}
function newSmart() {
  let q = currentQuery();
  q = prompt('Фильтр умного списка (как в поиске). Примеры: tag:coop new · genre:RPG h>10 · ach<100 played', q);
  if (q == null || !q.trim()) return;
  const name = prompt('Название умного списка', q.trim()); if (!name) return;
  const l = { id: uid(), name: name.trim(), query: q.trim() };
  state.lists.push(l); state.view = l.id; $('#q').value = ''; state.tags.clear(); changed(); render();
}
function newList() {
  const name = prompt('Название списка'); if (!name) return null;
  const l = { id: uid(), name: name.trim(), items: [] }; state.lists.push(l); changed(); render(); return l.id;
}

/* ---------- events ---------- */
$('#side').addEventListener('click', e => {
  const it = e.target.closest('.it'), ed = e.target.dataset.e;
  if (ed === 'add') return newList();
  if (ed === 'smart') return newSmart();
  if (!it) return;
  const l = state.lists.find(x => x.id === it.dataset.id), i = state.lists.indexOf(l);
  if (ed === 'ren') {
    const n = prompt('Название', l.name); if (!n) return; l.name = n.trim();
    if (isSmart(l)) { const q = prompt('Фильтр (как в поиске: tag:coop new h<1 …)', l.query); if (q != null) l.query = q.trim(); }
    changed(); render(); return;
  }
  if (ed === 'del') { if (confirm(`Удалить список «${l.name}»? Игры останутся в библиотеке.`)) { state.lists.splice(i, 1); if (state.view === l.id) state.view = 'all'; changed(); render(); } return; }
  if (ed === 'up') { if (i > 0) { state.lists.splice(i - 1, 0, state.lists.splice(i, 1)[0]); changed(); render(); } return; }
  state.view = it.dataset.id; state.sel.clear(); $('#side').classList.remove('open'); $('#scroll').scrollTop = 0;
  if (!curList() && $('#sort').value === 'order') $('#sort').value = 'name';
  if (curList()) $('#sort').value = 'order';
  render();
});
$('#list').addEventListener('click', e => {
  if (e.target.closest('a')) return;
  const gi = e.target.closest('.g');
  if (gi && (e.target.closest('.inf') || e.target.closest('.ach'))) { openGame(+gi.dataset.id, !!e.target.closest('.ach')); return; }
  const gp = e.target.closest('[data-open]'); if (gp) { openGame(+gp.dataset.open, true); return; }
  const up = e.target.closest('[data-unpin]'); if (up) { const [a, k] = up.dataset.unpin.split('|'); togglePin(+a, k); render(); return; }
  const tg = e.target.dataset.tag;
  if (tg) { state.tags.has(tg) ? state.tags.delete(tg) : state.tags.add(tg); render(); return; }
  const g = e.target.closest('.g'); if (!g) return;
  const id = +g.dataset.id;
  if (e.shiftKey && state.lastClick != null) {
    const v = state.visible, a = v.indexOf(state.lastClick), b = v.indexOf(id);
    for (const x of v.slice(Math.min(a, b), Math.max(a, b) + 1)) state.sel.add(x);
  } else state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id);
  state.lastClick = id; updateSel();
});
$('#selbar').addEventListener('click', e => {
  const a = e.target.dataset.act, ids = state.visible.filter(i => state.sel.has(i));
  if (a === 'move') pickList(`Переместить ${ids.length} → `, t => moveTo(t, ids, false));
  if (a === 'copy') pickList(`Копировать ${ids.length} → `, t => moveTo(t, ids, true));
  if (a === 'remove') removeFrom(ids);
  if (a === 'top') reorder(ids, curList().items.find(i => !state.sel.has(i)) ?? null);
  if (a === 'bottom') reorder(ids, null);
  if (a === 'all') { state.visible.forEach(i => state.sel.add(i)); updateSel(); }
  if (a === 'none') { state.sel.clear(); updateSel(); }
});

// drag & drop (ПК): на список слева = перенос (Ctrl — копия), на игру в своём списке = порядок
let dragIds = null;
$('#list').addEventListener('dragstart', e => {
  const g = e.target.closest('.g'); if (!g) return;
  const id = +g.dataset.id;
  if (!state.sel.has(id)) { state.sel.clear(); state.sel.add(id); g.classList.add('sel'); }
  dragIds = state.visible.filter(i => state.sel.has(i));
  e.dataTransfer.setData('text/plain', dragIds.join(','));
  e.dataTransfer.effectAllowed = 'copyMove';
});
document.addEventListener('dragend', () => { dragIds = null; document.querySelectorAll('.drop,.before').forEach(x => x.classList.remove('drop', 'before')); });
$('#side').addEventListener('dragover', e => {
  const it = e.target.closest('.it'); if (!dragIds || !it || !manual().some(l => l.id === it.dataset.id)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
  document.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); it.classList.add('drop');
});
$('#side').addEventListener('drop', e => {
  const it = e.target.closest('.it'); if (!dragIds || !it) return;
  e.preventDefault(); moveTo(it.dataset.id, dragIds, e.ctrlKey);
});
$('#list').addEventListener('dragover', e => {
  if (!dragIds || !curList() || $('#sort').value !== 'order') return;
  const g = e.target.closest('.g'); e.preventDefault();
  document.querySelectorAll('.before').forEach(x => x.classList.remove('before'));
  if (g) g.classList.add('before');
});
$('#list').addEventListener('drop', e => {
  if (!dragIds || !curList() || $('#sort').value !== 'order') return;
  e.preventDefault(); const g = e.target.closest('.g');
  reorder(dragIds, g ? +g.dataset.id : null);
});

$('#list').addEventListener('dblclick', e => { const g = e.target.closest('.g'); if (g && !e.target.closest('a,button')) openGame(+g.dataset.id); });
$('#q').addEventListener('input', () => { if (state.view === 'goals') state.view = 'all'; render(); });
$('#sort').addEventListener('change', () => render());
$('#helpBtn').onclick = () => $('#help').showModal();
$('#menuBtn').onclick = () => $('#side').classList.toggle('open');
$('#settingsBtn').onclick = () => { $('#sRepo').value = cfg.repo; $('#sToken').value = cfg.token; $('#sWorker').value = cfg.worker || ''; $('#sAccess').value = cfg.access || ''; $('#genOut').textContent = ''; $('#settings').showModal(); };
$('#genAccess').onclick = () => { const a = [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, '0')).join(''); $('#sAccess').value = a; $('#sAccess').type = 'text'; $('#genOut').textContent = 'скопируй его в секрет ACCESS'; };
$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  cfg.repo = $('#sRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  cfg.token = $('#sToken').value.trim(); cfg.worker = $('#sWorker').value.trim().replace(/\/+$/, ''); cfg.access = $('#sAccess').value.trim();
  if (cfg.worker && !/^https:\/\//.test(cfg.worker)) cfg.worker = 'https://' + cfg.worker;
  $('#sAccess').type = 'password'; LS.set('cfg', cfg); pull();
});
$('#reload').onclick = () => { $('#settings').close(); pull(); };
$('#pcSync').onclick = () => { location.href = 'steamlists://sync'; };
$('#steamBtn').onclick = toSteam;
$('#syncBtn').onclick = () => steamSync();
$('#exportJson').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ lists: state.lists }, null, 1)], { type: 'application/json' }));
  a.download = `steam-lists-${new Date().toISOString().slice(0, 10)}.json`; a.click();
};
$('#importSteam').onclick = async () => {
  try {
    const sc = await load('steam-collections.json');
    if (!sc) return alert('Нет steam-collections.json. Запусти на ПК: steam-sync.ps1');
    let added = 0, upd = 0;
    for (const c of sc.collections) {
      const l = manual().find(x => x.steamId === c.id) || manual().find(x => x.name === c.name);
      if (l) { const before = l.items.length; for (const id of c.apps) if (!l.items.includes(id)) l.items.push(id); if (l.items.length > before) upd++; l.steamId = c.id; }
      else { state.lists.push({ id: uid(), name: c.name, steamId: c.id, items: c.apps.slice() }); added++; }
    }
    setLibrary(LS.get('library', null)); changed(); render();
    alert(`Импорт: новых списков ${added}, дополнено ${upd}.` + (sc.dynamic?.length ? `\nДинамические коллекции Steam пропущены: ${sc.dynamic.join(', ')}` : ''));
  } catch (e) { alert('Ошибка: ' + e.message); }
};
window.addEventListener('beforeunload', e => { if (state.dirty) { save(); e.preventDefault(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden && state.dirty) save(); else if (!document.hidden && !state.dirty) pull(); });

/* ---------- карточка игры и ачивки ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const unent = s => { const t = document.createElement('textarea'); t.innerHTML = s || ''; return t.value; };
const det = new Map();   // appid -> Promise(карточка | null)
function getDet(id) {
  if (!det.has(id)) det.set(id, cfg.repo && cfg.token ? load(`games/${id}.json`).catch(() => null) : Promise.resolve(null));
  return det.get(id);
}
const pinCount = () => Object.values(state.pins).reduce((a, o) => a + Object.keys(o).length, 0);
function togglePin(appid, a) {
  const o = state.pins[appid] || (state.pins[appid] = {});
  if (o[a.id || a]) delete o[a.id || a]; else o[a.id] = { n: a.n, d: a.d, i: a.i };
  if (!Object.keys(o).length) delete state.pins[appid];
  changed();
}
const fmtDate = t => t > 1 ? new Date(t * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const rareCls = p => p == null ? '' : p < 5 ? 'r1' : p < 20 ? 'r2' : '';
// прогресс ачивки (34/100): связь «счётчик → ачивка» из файлов Steam на ПК (prog), значения — stats
function achProg(d, a) {
  const pr = d?.prog?.[a.id]; if (!pr || a.t > 0) return null;
  const [stat, min, max] = pr; if (!(max > min)) return null;
  const cur = Math.max(min, Math.min(max, +(d.stats?.[stat] ?? min)));
  return { cur, max, pct: Math.round(100 * (cur - min) / (max - min)) };
}
const progHtml = pg => pg ? `<div class="apg"><div class="bar"><i style="width:${pg.pct}%"></i></div><small>${pg.cur.toLocaleString()} / ${pg.max.toLocaleString()}</small></div>` : '';
function achRow(appid, a, pinned, d) {
  const done = a.t > 0, hid = a.h && !done && !a.d;
  return `<div class="ar${done ? ' done' : ''}"><img loading="lazy" src="${esc(done ? a.i : (a.g || a.i))}" alt="">
    <div class="at"><b>${esc(a.n)}</b><span>${hid ? '<i>Скрытое достижение</i>' : esc(a.d)}</span>${progHtml(achProg(d, a))}</div>
    <div class="ap ${rareCls(a.p)}">${a.p != null ? a.p + '%' : ''}<small>${done ? '✓ ' + fmtDate(a.t) : ''}</small></div>
    <button class="pin${pinned ? ' on' : ''}" data-pin="${esc(a.id)}" title="${pinned ? 'Открепить' : 'Закрепить в «Цели»'}">📌</button></div>`;
}
let gameOpen = null;
async function openGame(id, toAch) {
  const g = state.games.get(id) || { appid: id, name: `App ${id}` };
  gameOpen = { id, filter: 'all', sort: 'steam' };
  const dlg = $('#game'); dlg.innerHTML = '<div class="gd"><div class="gload">Загружаю…</div></div>';
  if (!dlg.open) dlg.showModal();
  const d = await getDet(id); if (gameOpen?.id !== id) return;
  gameOpen.d = d; drawGame(g, d);
  if (toAch) dlg.querySelector('.achs')?.scrollIntoView({ block: 'start' });
}
function drawGame(g, d) {
  const arr = x => x == null ? [] : [].concat(x);
  const id = g.appid, inf = { ...(d?.info || {}) }, ach = arr(d?.ach), st = gameOpen;
  inf.dev = arr(inf.dev); inf.pub = arr(inf.pub); inf.shots = arr(inf.shots);
  const done = ach.filter(a => a.t > 0).length, p = ach.length ? Math.round(100 * done / ach.length) : null;
  const steamid = LS.get('library', {})?.steamid;
  const link = (u, t) => `<a href="${esc(u)}" target="_blank" rel="noopener">${t}</a>`;
  const by = [inf.dev?.join(', '), inf.pub?.length && inf.pub.join(', ') !== inf.dev?.join(', ') ? inf.pub.join(', ') : '', inf.release].filter(Boolean).map(esc).join(' · ');
  let list = ach.filter(a => st.filter === 'all' || (st.filter === 'todo' ? !(a.t > 0) : st.filter === 'done' ? a.t > 0 : state.pins[id]?.[a.id]));
  if (st.sort === 'rare') list = list.slice().sort((a, b) => (a.p ?? 101) - (b.p ?? 101));
  if (st.sort === 'common') list = list.slice().sort((a, b) => (b.p ?? -1) - (a.p ?? -1));
  if (st.sort === 'close') list = list.slice().sort((a, b) => (achProg(d, b)?.pct ?? (b.t > 0 ? -2 : -1)) - (achProg(d, a)?.pct ?? (a.t > 0 ? -2 : -1)));
  if (st.sort === 'date') list = list.slice().sort((a, b) => (b.t || 0) - (a.t || 0));
  const inLists = manual().map(l => `<span class="lt${l.items.includes(id) ? ' on' : ''}" data-lt="${esc(l.id)}">${esc(l.name)}</span>`).join('');
  $('#game').innerHTML = `<div class="gd">
    <div class="ghero"><img src="${CDN}/${id}/library_hero.jpg" onerror="this.onerror=null;this.src='${CDN}/${id}/header.jpg'" alt="">
      <div class="gtitle"><h3>${esc(d?.name || g.name)}</h3><div>${by}${inf.mc ? ` · <span class="mc">Metacritic ${inf.mc}</span>` : ''}</div></div>
      <button class="gx" data-x>✕</button></div>
    <div class="gbody">
      ${inf.desc ? `<p class="gdesc">${esc(unent(inf.desc))}</p>` : ''}
      <div class="gstats"><span><b>${g.hours ? g.hours.toFixed(1) : '0'}</b> ч</span>${g.last ? `<span>последний запуск <b>${fmtDate(g.last)}</b></span>` : '<span>не запускал</span>'}
        ${p !== null ? `<span>ачивки <b>${done}/${ach.length}</b> · ${p}%</span>` : ''}</div>
      ${p !== null ? `<div class="bar big"><i style="width:${p}%"></i></div>` : ''}
      <div class="glinks"><a class="primary" href="steam://run/${id}">▶ Играть</a>
        ${link(`https://store.steampowered.com/app/${id}`, 'Магазин')}
        ${link(steamid ? `https://steamcommunity.com/profiles/${steamid}/stats/${id}/achievements` : `https://steamcommunity.com/stats/${id}/achievements`, 'Ачивки в Steam')}
        ${link(`https://steamcommunity.com/app/${id}/guides`, 'Гайды')}
        ${link(`https://steamdb.info/app/${id}/`, 'SteamDB')}
        ${link(`https://www.pcgamingwiki.com/api/appid.php?appid=${id}`, 'PCGamingWiki')}
        ${link(`https://howlongtobeat.com/?q=${encodeURIComponent(g.name || '')}`, 'Сколько проходить')}
        ${inf.site ? link(inf.site, 'Сайт') : ''}</div>
      ${inLists ? `<div class="glists"><span class="lab">Списки</span>${inLists}</div>` : ''}
      ${inf.shots?.length ? `<div class="shots">${inf.shots.map(u => `<a href="${esc(u.replace('.600x338', ''))}" target="_blank"><img loading="lazy" src="${esc(u)}" alt=""></a>`).join('')}</div>` : ''}
      <div class="achs"><div class="ahead"><h4>Достижения ${ach.length ? `${done}/${ach.length}` : ''}</h4>
        ${ach.length ? `<span class="af">${[['all', 'Все'], ['todo', 'Не получены'], ['done', 'Получены'], ['pin', '📌']].map(([k, t]) => `<button data-f="${k}" class="${st.filter === k ? 'on' : ''}">${t}</button>`).join('')}</span>
        <select data-s>${[['steam', 'Порядок Steam'], ['close', 'Ближе к получению'], ['rare', 'Сначала редкие'], ['common', 'Сначала частые'], ['date', 'Недавно полученные']].map(([k, t]) => `<option value="${k}"${st.sort === k ? ' selected' : ''}>${t}</option>`).join('')}</select>` : ''}</div>
        ${!d ? `<p class="hint">Нет подробностей об игре. Запусти на ПК новый <code>sync.cmd</code> (ZIP в «?»), он соберёт описания и ачивки.</p>`
          : ach.length ? list.map(a => achRow(id, a, !!state.pins[id]?.[a.id], d)).join('') || '<p class="hint">Пусто.</p>' : '<p class="hint">У игры нет достижений.</p>'}
      </div>
    </div></div>`;
}
$('#game').addEventListener('click', e => {
  const dlg = $('#game'), st = gameOpen; if (!st) return;
  if (e.target === dlg || e.target.closest('[data-x]')) { dlg.close(); return; }
  const g = state.games.get(st.id) || { appid: st.id, name: `App ${st.id}` };
  const f = e.target.closest('[data-f]'); if (f) { st.filter = f.dataset.f; drawGame(g, st.d); return; }
  const pn = e.target.closest('[data-pin]');
  if (pn) { const a = [].concat(st.d.ach).find(x => x.id === pn.dataset.pin); togglePin(st.id, a); const on = !!state.pins[st.id]?.[a.id]; pn.classList.toggle('on', on); pn.title = on ? 'Открепить' : 'Закрепить в «Цели»'; render(); return; }
  const lt = e.target.closest('[data-lt]');
  if (lt) { const l = manual().find(x => x.id === lt.dataset.lt); if (!l) return; if (l.items.includes(st.id)) l.items = l.items.filter(i => i !== st.id); else l.items.push(st.id); lt.classList.toggle('on'); changed(); render(); }
});
$('#game').addEventListener('change', e => { if (e.target.matches('[data-s]')) { gameOpen.sort = e.target.value; drawGame(state.games.get(gameOpen.id) || { appid: gameOpen.id }, gameOpen.d); } });
$('#game').addEventListener('close', () => { gameOpen = null; });

// «Цели»: все закреплённые ачивки по играм; статус «получено» — из свежих карточек
function renderGoals() {
  const box = $('#list'); state.visible = []; state.sel.clear(); $('#selbar').hidden = true; setBg(null);
  const ids = Object.keys(state.pins).map(Number).sort((a, b) => (state.games.get(b)?.last || 0) - (state.games.get(a)?.last || 0));
  $('#head').innerHTML = `<h2>🎯 Цели</h2><div class="stats"><span><b>${pinCount()}</b> закреплено в <b>${ids.length}</b> играх</span></div>`;
  if (!ids.length) { box.innerHTML = '<div class="empty">📌 Здесь будут закреплённые ачивки.<br>Открой игру (ⓘ или двойной клик) и нажми 📌 у нужных.</div>'; return; }
  box.innerHTML = ids.map(id => {
    const g = state.games.get(id) || { name: `App ${id}` }, pins = state.pins[id];
    return `<div class="goal" data-gid="${id}"><div class="gh" data-open="${id}"><img src="${CDN}/${id}/capsule_184x69.jpg" onerror="this.style.visibility='hidden'" alt=""><b>${esc(g.name)}</b><span class="gp"></span></div>
      ${Object.entries(pins).map(([k, a]) => `<div class="ar" data-a="${esc(k)}"><img loading="lazy" src="${esc(a.i)}" alt=""><div class="at"><b>${esc(a.n)}</b><span>${esc(a.d)}</span></div><div class="ap"><small></small></div><button class="pin on" data-unpin="${id}|${esc(k)}" title="Открепить">📌</button></div>`).join('')}</div>`;
  }).join('');
  for (const id of ids) getDet(id).then(d => {
    const el = box.querySelector(`.goal[data-gid="${id}"]`); if (!el || !d?.ach) return; d.ach = [].concat(d.ach);
    const done = d.ach.filter(a => a.t > 0).length; el.querySelector('.gp').textContent = `${done}/${d.ach.length}`;
    for (const r of el.querySelectorAll('.ar')) {
      const a = d.ach.find(x => x.id === r.dataset.a); if (!a) continue;
      if (a.t > 0) { r.classList.add('done'); r.querySelector('small').textContent = '✓ получено ' + fmtDate(a.t); }
      else { const pg = achProg(d, a); if (pg) r.querySelector('.at').insertAdjacentHTML('beforeend', progHtml(pg)); }
      if (a.p != null) { const ap = r.querySelector('.ap'); ap.classList.add(...[rareCls(a.p)].filter(Boolean)); ap.prepend(a.p + '%'); }
    }
  });
}

/* ---------- ⟳ обновление из Steam прямо в браузере (через Worker) ---------- */
async function wk(path, params) {
  const r = await fetch(`${cfg.worker}${path}?${new URLSearchParams(params)}`, { headers: { 'X-Access': cfg.access } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Worker ${r.status}`);
  return j;
}
async function ghApi(path, method = 'GET', body) {
  const r = await fetch(`https://api.github.com/repos/${cfg.repo}${path ? '/' + path : ''}`, { method, cache: 'no-store',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' }, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub ${path.split('/')[0]}… ${r.status}`);
  return r.json();
}
// много файлов одним коммитом (как в steam-sync.ps1)
async function pushFiles(files, msg) {
  const br = (await ghApi('')).default_branch;
  for (let t = 0; ; t++) {
    try {
      const head = (await ghApi(`git/ref/heads/${br}`)).object.sha;
      const base = (await ghApi(`git/commits/${head}`)).tree.sha;
      const tree = await ghApi('git/trees', 'POST', { base_tree: base, tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })) });
      const c = await ghApi('git/commits', 'POST', { message: msg, tree: tree.sha, parents: [head] });
      await ghApi(`git/refs/heads/${br}`, 'PATCH', { sha: c.sha }); return;
    } catch (e) { if (t >= 2) throw e; await new Promise(r => setTimeout(r, 2000)); }
  }
}
let syncing = false;
async function steamSync(quiet) {
  if (syncing) return;
  if (quiet && (!cfg.repo || !cfg.token || !cfg.worker || !cfg.access || !LS.get('library', null)?.steamid)) return;
  if (!cfg.repo || !cfg.token) return alert('Сначала ⚙: репо и токен GitHub.');
  if (!cfg.worker || !cfg.access) { alert('Для ⟳ нужен Cloudflare Worker. Инструкция: «?» → «Обновление без ПК».'); $('#help').showModal(); return; }
  const old = LS.get('library', null);
  let steamid = old?.steamid;
  if (!steamid) { steamid = (prompt('SteamID64 (17 цифр, 7656…). Его видно в адресе профиля или на steamid.io') || '').trim(); if (!/^\d{17}$/.test(steamid)) return; }
  syncing = true; $('#syncBtn').classList.add('spin');
  try {
    status('Steam: библиотека…');
    const owned = (await wk('/owned', { steamid })).games;
    if (!owned.length) throw new Error('Steam вернул пустую библиотеку');
    const prev = new Map((old?.games || []).map(g => [g.appid, g]));
    const games = owned.map(o => { const p = prev.get(o.appid) || {}; return { appid: o.appid, name: o.name || p.name, hours: o.hours, last: o.last, genres: p.genres || [], tags: p.tags || [], img: p.img || null, ach: p.ach || null }; });
    // что обновлять: новые игры и те, в которые играл с прошлого раза
    const todo = games.filter(g => { const p = prev.get(g.appid); return !p || !(p.genres?.length || p.tags?.length) || p.last !== g.last; });
    // необработанные игры сохраняем со старыми данными, чтобы прерванный ⟳ потом продолжил с них
    const done = new Set(), todoIds = new Set(todo.map(g => g.appid));
    const lib = () => ({ version: 1, steamid, source: 'api', updated: new Date().toISOString(),
      games: games.map(g => !todoIds.has(g.appid) || done.has(g.appid) ? g : prev.get(g.appid)).filter(Boolean) });
    let files = {}, n = 0, errs = 0;
    let pend = [];
    const flush = async () => {
      if (!Object.keys(files).length && !pend.length) return;
      status(`отправляю… ${n}/${todo.length}`);
      if (Object.keys(files).length) await pushFiles(files, `⟳ карточки игр (${Object.keys(files).length})`);
      files = {}; pend.forEach(id => done.add(id)); pend = [];
      const L = lib(); await store('library.json', L, `⟳ библиотека (${n}/${todo.length})`); LS.set('library', L);
    };
    for (const g of todo) {
      n++; status(`Steam: ${n}/${todo.length} · ${g.name}`);
      const isNew = !prev.has(g.appid) || !(prev.get(g.appid).genres?.length || prev.get(g.appid).tags?.length);
      let d;
      try { d = await wk('/game', { appid: g.appid, steamid, played: g.hours > 0 ? 1 : '', tags: isNew ? 1 : '' }); }
      catch (e) { errs++; if (errs > 20) { await flush().catch(() => {}); throw e; } continue; }
      if (d.genres?.length) g.genres = d.genres;
      if (d.tags?.length) g.tags = d.tags;
      if (d.img && !g.img) g.img = d.img;
      if (g.hours > 0 && d.ach.length && (d.playerOk || !g.ach)) g.ach = [d.ach.filter(a => a.t > 0).length, d.ach.length];
      if (d.info || d.ach.length) {
        const od = await getDet(g.appid);   // связь «счётчик → ачивка» (prog) кладёт только PC-скрипт — сохраняем
        files[`games/${g.appid}.json`] = JSON.stringify({ appid: g.appid, name: d.name || g.name, info: d.info || od?.info || null, ach: d.ach, achLast: g.last,
          prog: od?.prog || null, stats: d.stats || od?.stats || null, updated: new Date().toISOString() });
        det.delete(g.appid);
      }
      pend.push(g.appid);
      if (pend.length >= 40) await flush();
      await new Promise(r => setTimeout(r, d.storeOk ? 900 : 5000));   // магазин Steam ограничивает частоту
    }
    await flush();
    if (!todo.length) { const L = lib(); await store('library.json', L, `⟳ библиотека (${games.length} игр)`); LS.set('library', L); }
    setLibrary(LS.get('library', null)); render();
    status(`✓ обновлено: ${todo.length} игр` + (errs ? `, ошибок ${errs}` : ''));
  } catch (e) { status('⚠ ' + e.message); if (!quiet) alert('Обновление прервано: ' + e.message + '\nУже обработанное сохранено, следующий ⟳ продолжит.'); }
  finally { syncing = false; $('#syncBtn').classList.remove('spin'); }
}

// «💾 В Steam»: сохранить в репо и запустить выгрузку на этом ПК через ссылку steamlists://
async function toSteam() {
  if (!confirm('Записать списки в коллекции Steam?\n\nОткроется окно на ПК: Steam закроется, списки запишутся, Steam запустится снова. Перед записью делается бэкап.')) return;
  clearTimeout(saveTimer); if (state.dirty) await save();
  if (state.dirty) { alert('Списки не сохранились в репо (см. статус справа сверху). Проверь сеть и попробуй ещё раз.'); return; }
  location.href = 'steamlists://export';
  status('если окно не открылось — один раз запусти новый sync.cmd');
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
pull();
if (!cfg.repo && !LS.get('helped', false)) { LS.set('helped', true); $('#help').showModal(); }
