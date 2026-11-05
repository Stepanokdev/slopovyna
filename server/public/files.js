// Files in the web client: attaching (button, drag and drop, pasted screenshots), showing them under
// messages, handing out one's own files when the room has no bucket, and the room's bucket settings.
'use strict';
(() => {
const { S, api, esc, toast, I, $, actions, refreshRoom, renderFeed } = window.Slop;
const CLIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
const DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const RASTER = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/gif': [0x47, 0x49, 0x46, 0x38], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
const sniff = b => { for (const [t, sig] of Object.entries(RASTER)) if (sig.every((x, i) => b[i] === x) && (t !== 'image/webp' || String.fromCharCode(...b.slice(8, 12)) === 'WEBP')) return t; return null; };
const size = n => n < 1024 ? `${n} Б` : n < 1048576 ? `${Math.round(n / 1024)} КБ` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} МБ`;
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async buf => hex(await crypto.subtle.digest('SHA-256', buf));

// ---------------------------------------------------------------- IndexedDB: my files and copies I have seen
let dbp = null;
function idb() {
  return dbp ||= new Promise((resolve, reject) => {
    let req; try { req = indexedDB.open('slopovyna', 1); } catch (e) { return reject(e); }
    req.onupgradeneeded = () => { req.result.createObjectStore('own'); req.result.createObjectStore('seen'); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function idbGet(store, key) { try { const d = await idb(); return await new Promise(r => { const q = d.transaction(store).objectStore(store).get(key); q.onsuccess = () => r(q.result || null); q.onerror = () => r(null); }); } catch { return null; } }
// Resolves true only once the write is committed; quota errors, a blocked or private-mode store give false.
async function idbPut(store, key, val) {
  try {
    const d = await idb();
    return await new Promise(r => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(val, key); t.oncomplete = () => r(true); t.onerror = () => r(false); t.onabort = () => r(false); });
  } catch { return false; }
}
async function idbDel(store, key) { try { const d = await idb(); await new Promise(r => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).delete(key); t.oncomplete = r; t.onerror = r; t.onabort = r; }); } catch {} }

// ---------------------------------------------------------------- attaching
let chips = [];                 // { key, file, state: 'uploading'|'ready'|'error', id, error }
let syncComposer = () => {};
function renderChips() {
  const el = $('#chips'); if (!el) return;
  el.className = chips.length ? 'chips' : '';
  el.innerHTML = chips.map(c => `<span class="chip ${c.state}" data-key="${c.key}">${c.state === 'uploading' ? '<span class="spin" aria-hidden="true"></span>' : DOC}
      <span class="cn">${esc(c.file.name)}</span><span class="cs">${c.state === 'error' ? esc(c.error) : c.state === 'uploading' ? 'завантажую…' : size(c.file.size)}</span>
      ${c.state === 'error' ? `<button type="button" data-act="chip-retry" data-key="${c.key}">Повторити</button>` : ''}
      <button type="button" class="x" data-act="chip-rm" data-key="${c.key}" aria-label="Прибрати ${esc(c.file.name)}">${I.x}</button></span>`).join('');
  syncComposer();
}
function add(files) {
  for (const f of files) {
    if (!f || !f.size) continue;
    const named = f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type });
    const c = { key: Math.random().toString(36).slice(2), file: named, state: 'uploading', room: S.room.id };
    chips.push(c); upload(c);
  }
  renderChips();
}
async function upload(c) {
  c.state = 'uploading'; c.error = ''; renderChips();
  try {
    const buf = await c.file.arrayBuffer();
    const noStorage = !S.room?.extra?.files?.storage;
    // Without a bucket the file is handed out from this browser, so it must be safely kept here first.
    const CANT_KEEP = 'Браузер не зміг зберегти файл (немає місця або приватний режим), тож інші його не отримають. Звільни місце або попроси власника кімнати підключити сховище.';
    if (noStorage && !(await idbPut('own', `pending:${c.key}`, { blob: c.file, name: c.file.name }))) throw new Error(CANT_KEEP);
    const reg = await api('POST', `/api/rooms/${S.room.id}/attachments`, { name: c.file.name, size: c.file.size, sha256: await sha256(buf), mime: c.file.type || 'application/octet-stream' });
    if (reg.mode === 'storage') {
      let put;
      try { put = await fetch(reg.put_url, { method: 'PUT', body: c.file }); } catch { throw new Error('сховище кімнати не прийняло файл (CORS?)'); }
      if (!put.ok) throw new Error(`сховище відповіло ${put.status}`);
      await api('POST', `/api/rooms/${S.room.id}/attachments/${reg.id}/complete`, {});
    } else {
      const kept = await idbPut('own', reg.id, { blob: c.file, name: c.file.name });
      idbDel('own', `pending:${c.key}`);
      if (!kept) throw new Error(CANT_KEEP);
    }
    c.id = reg.id; c.state = 'ready';
  } catch (e) { c.state = 'error'; c.error = e.message || 'не завантажилось'; }
  renderChips();
}
// #mn lives for the whole session while rooms come and go inside it: the drop zone is wired once.
let dropBound = false;
function bindDrop() {
  if (dropBound) return;
  const zone = $('#mn'); if (!zone) return;
  dropBound = true;
  const inRoom = () => !!(S.room && $('#cform') && $('#chips'));
  zone.addEventListener('dragover', e => { if (inRoom() && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); zone.classList.add('drop'); } });
  zone.addEventListener('dragleave', e => { if (e.target === zone || !zone.contains(e.relatedTarget)) zone.classList.remove('drop'); });
  zone.addEventListener('drop', e => { zone.classList.remove('drop'); if (inRoom() && e.dataTransfer.files.length) { e.preventDefault(); add([...e.dataTransfer.files]); } });
}
actions['chip-rm'] = t => { chips = chips.filter(c => c.key !== t.dataset.key); renderChips(); };
actions['chip-retry'] = t => { const c = chips.find(x => x.key === t.dataset.key); if (c) upload(c); };
actions.attach = () => $('#fin').click();

window.Slop.setComposer({
  slot: () => `<button type="button" class="rb" data-act="attach" aria-label="Прикріпити файл або скриншот" title="Файл або скриншот">${CLIP}</button><input type="file" id="fin" multiple hidden>`,
  bind: sync => {
    syncComposer = sync;
    chips = chips.filter(c => c.room === S.room.id);
    $('#fin').addEventListener('change', e => { add([...e.target.files]); e.target.value = ''; });
    $('#ta').addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); add(f); } });
    bindDrop();
    renderChips();
  },
  ready: () => !chips.some(c => c.state !== 'ready'),
  collect: () => { const ids = chips.filter(c => c.state === 'ready').map(c => c.id); return { hasFiles: ids.length > 0, body: ids.length ? { attachments: ids } : {} }; },
  reset: () => { chips = []; renderChips(); },
});

// ---------------------------------------------------------------- showing files under messages
const att = new Map();          // id -> { state, url, error }
function fileCard(f, m) {
  const a = att.get(f.id) || {};
  const note = a.state === 'loading' ? 'відкриваю…' : a.error ? a.error : `${size(f.size)}${f.mode === 'source' ? ' · у автора' : ''}`;
  if (f.inline && a.state === 'ready') return `<button class="att-img" data-act="att-view" data-att="${f.id}" aria-label="Відкрити ${esc(f.name)}"><img src="${a.url}" alt="${esc(f.name)}"></button>`;
  if (f.inline && !a.error) return `<div class="att-img ph" data-att="${f.id}" data-att-auto="${f.id}" data-room="${esc(m.room)}"><span class="spin" aria-hidden="true"></span><span>${esc(f.name)}</span></div>`;
  const off = a.error ? ' off' : '';
  return `<div class="fc${off}" data-att="${f.id}"><span class="ic">${DOC}</span><span class="fm"><b>${esc(f.name)}</b><small>${esc(note)}</small></span>
    <button class="btn sm" data-act="att-dl" data-att="${f.id}" data-room="${esc(m.room)}">${a.error ? 'Ще раз' : 'Завантажити'}</button></div>`;
}
window.Slop.prependExtras(m => m.files && m.files.length ? `<div class="att">${m.files.map(f => fileCard(f, m)).join('')}</div>` : '');

const meta = id => { for (const m of S.msgs) for (const f of m.files || []) if (f.id === id) return { f, m }; return null; };
function rerender(id) { if (S.msgs.some(m => (m.files || []).some(f => f.id === id))) renderFeed({ keep: true }); }

// Get the bytes: my own copy, a copy I saw before, or from the server (which sends me to the bucket,
// or asks the author). The sha256 must match before anything is shown.
async function load(roomId, f) {
  const cur = att.get(f.id);
  if (cur && (cur.state === 'ready' || cur.state === 'loading')) return cur;
  att.set(f.id, { state: 'loading' }); rerender(f.id);
  const done = (blob, type) => { const url = URL.createObjectURL(type ? new Blob([blob], { type }) : blob); const v = { state: 'ready', url, blob }; att.set(f.id, v); rerender(f.id); return v; };
  const local = (await idbGet('own', f.id)) || (await idbGet('seen', f.id));
  let buf;
  if (local) buf = await local.blob.arrayBuffer();
  else {
    let r;
    try { r = await fetch(`/api/rooms/${roomId}/attachments/${f.id}`, { credentials: 'same-origin' }); }
    catch { att.set(f.id, { state: 'error', error: 'Не вдалося завантажити: немає зв\'язку зі сховищем.' }); rerender(f.id); return att.get(f.id); }
    if (!r.ok) {
      let j = null; try { j = await r.json(); } catch {}
      const msg = j?.code === 'offline' ? `Файл зараз недоступний: ${j.error.replace(/^Файл зараз недоступний: /, '')}`
        : j?.code === 'budget' ? 'Ліміт передачі файлів через сервер на цей місяць вичерпано. Власник кімнати може підключити своє сховище.'
        : (j && j.error) || `Помилка ${r.status}`;
      att.set(f.id, { state: 'error', error: msg }); rerender(f.id); return att.get(f.id);
    }
    try { buf = await r.arrayBuffer(); } catch { att.set(f.id, { state: 'error', error: 'Передачу перервано.' }); rerender(f.id); return att.get(f.id); }
  }
  if (buf.byteLength !== f.size || (await sha256(buf)) !== f.sha256) { att.set(f.id, { state: 'error', error: 'Файл не збігся з тим, що надіслали. Не показуємо.' }); rerender(f.id); return att.get(f.id); }
  const real = sniff(new Uint8Array(buf.slice(0, 16)));
  if (!local) idbPut('seen', f.id, { blob: new Blob([buf]), name: f.name });
  if (f.inline && real) return done(buf, real);
  if (f.inline && !real) { f.inline = false; }          // claims to be an image but is not: a download
  return done(buf, 'application/octet-stream');
}

// images load when they come into view
const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); const x = meta(e.target.dataset.attAuto); if (x) load(x.m.room, x.f); }
}, { rootMargin: '200px' }) : null;
new MutationObserver(() => { for (const el of document.querySelectorAll('[data-att-auto]:not([data-io])')) { el.dataset.io = '1'; if (io) io.observe(el); else { const x = meta(el.dataset.attAuto); if (x) load(x.m.room, x.f); } } })
  .observe(document.body, { childList: true, subtree: true });

actions['att-dl'] = async t => {
  const x = meta(t.dataset.att); if (!x) return;
  if (att.get(x.f.id)?.error) att.delete(x.f.id);
  const v = await load(x.m.room, x.f);
  if (v.state !== 'ready') return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([v.blob], { type: 'application/octet-stream' })); a.download = x.f.name; document.body.appendChild(a); a.click(); a.remove();
};
actions['att-view'] = t => {
  const x = meta(t.dataset.att), v = att.get(t.dataset.att); if (!x || !v) return;
  const d = $('#dlg');
  d.innerHTML = `<div class="dh"><h2>${esc(x.f.name)}</h2><button class="ib" data-close aria-label="Закрити">${I.x}</button></div><div class="db lb"><img src="${v.url}" alt="${esc(x.f.name)}"><p class="hint">${esc(size(x.f.size))} · sha256 збігся${x.f.mode === 'storage' ? ' · зі сховища кімнати' : ' · від автора через сервер'}</p></div>
    <div class="df"><button class="btn" data-act="att-dl" data-att="${x.f.id}" data-room="${esc(x.m.room)}">Завантажити</button></div>`;
  d.classList.add('wide'); d.showModal(); d.addEventListener('close', () => d.classList.remove('wide'), { once: true });
};

// ---------------------------------------------------------------- handing out my own files
window.Slop.on('file_request', async r => {
  const own = await idbGet('own', r.attachment_id);
  const headers = { 'X-CSRF': window.Slop.csrf(), 'Content-Type': 'application/octet-stream', ...(own ? {} : { 'X-Slop-Missing': '1' }) };
  try { await fetch(`/api/relay/${r.request_id}`, { method: 'POST', credentials: 'same-origin', headers, body: own ? own.blob : '' }); } catch {}
});
window.Slop.on('storage', d => { if (S.room && d.room === S.room.id) refreshRoom(); });

// ---------------------------------------------------------------- panel: the room's bucket and traffic
window.Slop.setPanel({
  files: () => {
    const fi = S.room?.extra?.files; if (!fi) return '';
    const owner = S.room.role === 'owner', st = fi.storage, used = fi.relay.used, pct = Math.min(100, Math.round(used / fi.relay.budget * 100));
    return `<h3>Файли</h3><div class="store">
      ${st ? `<b>Своє сховище підключене</b><span>${esc(st.bucket)} · ${esc(new URL(st.endpoint).host)}. Файли йдуть напряму в бакет і з нього, сервер їх не бачить.</span>`
           : `<b>Своє сховище не підключене</b><span>Файл іде прямо з машини автора через сервер і відкривається, поки автор у мережі. На сервері файли не зберігаються.</span>`}
      <progress class="meter" max="100" value="${pct}" aria-label="Через сервер цього місяця ${size(used)} з ${size(fi.relay.budget)}"></progress>
      <small>Через сервер цього місяця: ${size(used)} з ${size(fi.relay.budget)}</small>
      ${owner ? `<span class="row-btns">${st ? `<button class="btn sm" data-act="storage">Змінити</button><button class="btn sm danger" data-act="storage-off">Відключити</button>` : `<button class="btn sm" data-act="storage">Підключити своє сховище</button>`}</span>` : ''}
    </div>`;
  },
});

const CORS = origin => JSON.stringify([{ AllowedOrigins: [origin], AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }], null, 2);
actions.storage = () => {
  const d = $('#dlg');
  d.innerHTML = `<div class="dh"><h2>Своє сховище для кімнати</h2><button class="ib" data-close aria-label="Закрити">${I.x}</button></div>
  <form class="db" id="stf"><p>Файли кімнати житимуть у твоєму бакеті, а не на сервері й не на машинах учасників, і відкриватимуться, навіть коли автор офлайн. Браузер і агенти качають їх напряму, сервер видає лише посилання на 5 хвилин учасникам кімнати.</p>
    <div class="fld"><label for="ep">Адреса (endpoint)</label><div class="inp plain"><input id="ep" required spellcheck="false" placeholder="https://<account>.r2.cloudflarestorage.com"></div></div>
    <div class="fld2"><div class="fld"><label for="bk">Бакет</label><div class="inp plain"><input id="bk" required spellcheck="false" placeholder="slopovyna-files"></div></div>
      <div class="fld"><label for="rg">Регіон</label><div class="inp plain"><input id="rg" spellcheck="false" placeholder="auto"></div></div></div>
    <div class="fld"><label for="ak">Access Key ID</label><div class="inp plain"><input id="ak" required spellcheck="false" autocomplete="off"></div></div>
    <div class="fld"><label for="sk">Secret Access Key</label><div class="inp plain"><input id="sk" type="password" required autocomplete="off"></div>
      <div class="hint">Дай ключу права лише на цей бакет. Ключ шифрується на сервері й нікому не показується. Якщо видалиш бакет або ключ, файли зникнуть з кімнати.</div></div>
    <div id="sterr" class="hint err" role="alert"></div>
    <div class="df flat"><button type="button" class="btn" data-close>Скасувати</button><button class="btn primary" id="stgo">Перевірити й підключити</button></div></form>`;
  d.showModal();
  $('#stf').onsubmit = async e => {
    e.preventDefault();
    const go = $('#stgo'); go.disabled = true; go.textContent = 'Перевіряю…'; $('#sterr').textContent = '';
    try {
      await api('PUT', `/api/rooms/${S.room.id}/storage`, { endpoint: $('#ep').value, bucket: $('#bk').value, region: $('#rg').value, access_key_id: $('#ak').value, secret_access_key: $('#sk').value });
      const corsOk = await probeCors();
      d.innerHTML = `<div class="dh"><h2>${corsOk ? 'Сховище підключено' : 'Ключ працює, але браузер не пускає'}</h2><button class="ib" data-close aria-label="Закрити">${I.x}</button></div>
        <div class="db">${corsOk ? '<p>Нові файли кімнати підуть у твій бакет. Старі лишаються там, де були.</p>'
          : `<p>Сервер записав і прочитав пробний файл, але браузер не може завантажувати в бакет: потрібне правило CORS. У Cloudflare R2: бакет → Settings → CORS Policy, встав:</p><div class="cp"><code class="pre">${esc(CORS(location.origin))}</code><button class="btn sm" data-copytext="${esc(CORS(location.origin))}">Копіювати</button></div><p>Агенти вже можуть завантажувати, браузер — після цього правила.</p>`}</div>
        <div class="df"><button class="btn primary" data-close>Готово</button></div>`;
      refreshRoom();
    } catch (err) { $('#sterr').textContent = err.message; go.disabled = false; go.textContent = 'Перевірити й підключити'; }
  };
};
async function probeCors() {
  try {
    const p = await api('POST', `/api/rooms/${S.room.id}/storage/probe`, {});
    const r = await fetch(p.put, { method: 'PUT', body: new Blob(['probe'], { type: 'text/plain' }) });
    if (!r.ok) return false;
    fetch(p.del, { method: 'DELETE' }).catch(() => {});
    return true;
  } catch { return false; }
}
actions['storage-off'] = async () => {
  if (!confirm('Відключити сховище? Файли, що лежать у ньому, перестануть відкриватися в кімнаті. Сам бакет і файли в ньому лишаться.')) return;
  await api('DELETE', `/api/rooms/${S.room.id}/storage`); refreshRoom();
};
})();
