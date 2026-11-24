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
  state.dirty = true; LS.set('lists', state.lists); status('● не сохранено');
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 1500);
}
async function save() {
  if (!cfg.repo || !cfg.token) { status('нет репо — только локально'); return; }
  try {
    status('сохраняю…');
    await store('lists.json', { version: 1, updated: new Date().toISOString(), lists: state.lists }, 'Обновлены списки');
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
    if (lists && !state.dirty) { state.lists = lists.lists || []; LS.set('lists', state.lists); }
    status(lib ? '✓' : 'нет library.json — запусти steam-sync на ПК');
  } catch (e) { status('⚠ ' + e.message); }
  render();
}
function setLibrary(lib) {
  state.games.clear();
  for (const g of lib?.games || []) state.games.set(g.appid, g);
  // игры из списков, которых нет в библиотеке (ещё не синкнули) — заглушки
  for (const l of state.lists) for (const id of l.items || []) if (!state.games.has(id)) state.games.set(id, { appid: id, name: `App ${id}`, stub: true });
  const cnt = {};
  for (const g of state.games.values()) for (const t of [...(g.genres || []), ...(g.tags || [])]) cnt[t] = (cnt[t] || 0) + 1;
  state.topTags = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 40).map(e => e[0]);
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
  const item = (id, name, n, editable) => {
    const d = document.createElement('div');
    d.className = 'it' + (state.view === id ? ' on' : ''); d.dataset.id = id;
    d.innerHTML = `<span class="nm"></span>${editable ? '<button class="ed" data-e="up" title="Выше">▲</button><button class="ed" data-e="ren" title="Переименовать">✎</button><button class="ed" data-e="del" title="Удалить">✕</button>' : ''}<span class="n">${n}</span>`;
    d.querySelector('.nm').textContent = name;
    side.append(d);
  };
  item('all', 'Вся библиотека', state.games.size);
  item('none', 'Без списка', [...state.games.keys()].filter(i => !inAny.has(i)).length);
  side.append(document.createElement('hr'));
  state.lists.forEach((l, i) => item(l.id, isSmart(l) ? `⚡ ${l.name}` : `${i + 1}. ${l.name}`, isSmart(l) ? smartIds(l).length : l.items.length, true));
  const add = document.createElement('button'); add.className = 'add'; add.textContent = '+ Новый список'; add.dataset.e = 'add';
  side.append(add);
  const sadd = document.createElement('button'); sadd.className = 'add'; sadd.textContent = '⚡ Умный список из поиска'; sadd.dataset.e = 'smart';
  side.append(sadd);

  const tb = $('#tagbar'); tb.innerHTML = '';
  for (const t of state.topTags || []) {
    const s = document.createElement('span'); s.textContent = t; if (state.tags.has(t)) s.className = 'on';
    s.onclick = () => { state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t); render(); };
    tb.append(s);
  }

  const ids = visible(); state.visible = ids;
  for (const id of [...state.sel]) if (!ids.includes(id)) state.sel.delete(id);
  const box = $('#list'); box.innerHTML = '';
  if (!ids.length) box.innerHTML = `<div class="empty">${state.games.size ? 'Пусто' : 'Библиотека пуста. Настрой репо (⚙) и запусти steam-sync на ПК.'}</div>`;
  const frag = document.createDocumentFragment();
  for (const id of ids.slice(0, 3000)) {
    const g = state.games.get(id), p = achPct(g);
    const d = document.createElement('div');
    d.className = 'g' + (state.sel.has(id) ? ' sel' : ''); d.dataset.id = id; d.draggable = true;
    const where = manual().filter(l => l.items.includes(id)).map(l => l.name);
    d.innerHTML = `<img loading="lazy" alt="" src="${CDN}/${id}/capsule_184x69.jpg" data-alt="${g.img || ''}" onerror="imgFail(this, ${id})">
      <div class="t"><div class="nm"></div><div class="meta"></div>${p !== null ? `<div class="bar"><i style="width:${p}%"></i></div>` : ''}</div>
      <div class="num">${g.hours ? g.hours.toFixed(1) + ' ч' : '—'}${g.ach && g.ach[1] ? `<br>${g.ach[0]}/${g.ach[1]}` : ''}</div>
      <a class="play" href="steam://run/${id}" title="Запустить в Steam">▶</a>`;
    d.querySelector('.nm').textContent = g.name;
    d.querySelector('.meta').textContent = [state.view === 'all' && where.length ? '📁 ' + where.join(', ') : '', (g.genres || []).slice(0, 3).join(', ')].filter(Boolean).join(' · ');
    frag.append(d);
  }
  box.append(frag);
  $('#selbar').hidden = !state.sel.size;
  $('#selCount').textContent = `Выбрано: ${state.sel.size}`;
  const inList = !!curList(), ordered = inList && $('#sort').value === 'order';
  $('#selbar [data-act=remove]').hidden = !inList;
  $('#selbar [data-act=top]').hidden = $('#selbar [data-act=bottom]').hidden = !ordered;
  LS.set('view', state.view);
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
  state.view = it.dataset.id; state.sel.clear(); $('#side').classList.remove('open');
  if (!curList() && $('#sort').value === 'order') $('#sort').value = 'name';
  if (curList()) $('#sort').value = 'order';
  render();
});
$('#list').addEventListener('click', e => {
  if (e.target.closest('a')) return;
  const g = e.target.closest('.g'); if (!g) return;
  const id = +g.dataset.id;
  if (e.shiftKey && state.lastClick != null) {
    const v = state.visible, a = v.indexOf(state.lastClick), b = v.indexOf(id);
    for (const x of v.slice(Math.min(a, b), Math.max(a, b) + 1)) state.sel.add(x);
  } else state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id);
  state.lastClick = id; render();
});
$('#selbar').addEventListener('click', e => {
  const a = e.target.dataset.act, ids = state.visible.filter(i => state.sel.has(i));
  if (a === 'move') pickList(`Переместить ${ids.length} → `, t => moveTo(t, ids, false));
  if (a === 'copy') pickList(`Копировать ${ids.length} → `, t => moveTo(t, ids, true));
  if (a === 'remove') removeFrom(ids);
  if (a === 'top') reorder(ids, curList().items.find(i => !state.sel.has(i)) ?? null);
  if (a === 'bottom') reorder(ids, null);
  if (a === 'all') { state.visible.forEach(i => state.sel.add(i)); render(); }
  if (a === 'none') { state.sel.clear(); render(); }
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

$('#q').addEventListener('input', () => render());
$('#sort').addEventListener('change', () => render());
$('#helpBtn').onclick = () => $('#help').showModal();
$('#menuBtn').onclick = () => $('#side').classList.toggle('open');
$('#settingsBtn').onclick = () => { $('#sRepo').value = cfg.repo; $('#sToken').value = cfg.token; $('#settings').showModal(); };
$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  cfg.repo = $('#sRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  cfg.token = $('#sToken').value.trim(); LS.set('cfg', cfg); pull();
});
$('#reload').onclick = () => { $('#settings').close(); pull(); };
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

pull();
if (!cfg.repo && !LS.get('helped', false)) { LS.set('helped', true); $('#help').showModal(); }
