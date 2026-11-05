// Agents in the web client: connecting one (code → request → approval), their status in the panel,
// and the delivery state under messages that mention them.
'use strict';
(() => {
const { S, api, esc, avatar, labelOf, toast, copy, I, $, actions, refreshRoom, renderFeed, timeFmt } = window.Slop;
const BOT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01"/></svg>';
const NO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="m6.5 17.5 11-11"/></svg>';
const ago = t => { if (!t) return 'ще не підключався'; const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'щойно' : m < 60 ? `${m} хв тому` : m < 1440 ? `${Math.round(m / 60)} год тому` : `${Math.round(m / 1440)} дн тому`; };
const agentsOf = () => (S.room?.extra?.agents || []);

// ---------------------------------------------------------------- panel
window.Slop.setPanel({
  agents: () => {
    const list = agentsOf(), pend = S.room?.extra?.pairings || [];
    const row = a => {
      const mine = a.owner_uid === S.me.uid, canKick = mine || S.room.role === 'owner';
      return `<div class="row">${avatar(a)}<span class="nmw"><b>${esc(labelOf(a))}</b><small class="${a.listening ? 'on' : ''}">${a.listening ? '● слухає пінги' : `○ не в мережі · ${esc(ago(a.last_seen))}`}</small></span>
        ${canKick ? `<button class="btn sm danger" data-act="agent-off" data-aid="${esc(a.aid)}" data-name="${esc(labelOf(a))}">Відключити</button>` : ''}</div>`;
    };
    return `<h3>Агенти</h3>${list.length ? list.map(row).join('') : '<p class="n">Агентів ще немає. Підключи свого: один рядок, і він тут.</p>'}
      ${pend.map(p => `<div class="row pend"><span class="av ag" aria-hidden="true">?</span><span class="nmw"><b>${esc(p.model)} просить зайти</b><small>${esc(p.client.host || 'невідомий комп\'ютер')} · цифри ${esc(p.match)}</small></span><button class="btn sm primary" data-act="pairing" data-pid="${esc(p.id)}">Переглянути</button></div>`).join('')}`;
  },
  actions: () => `<button class="btn primary" data-act="connect">${BOT}Підключити свого агента</button>`,
  notes: () => `<p class="n">Агент, який не в мережі, пінг не загубить: побачить його першим, щойно підключиться. Розбудити агента сервіс не може.</p>
    <p class="n">Агенти не можуть запрошувати людей, підключати інших агентів чи відключати когось. Це роблять лише люди.</p>`,
});

// ---------------------------------------------------------------- delivery under messages
const STATE = { queued: a => a.listening ? 'чекає доставки' : 'побачить, коли підключиться', received: (a, d) => `отримав${d.at ? ' ' + timeFmt.format(d.at) : ''}`, replied: () => 'відповів', read: () => 'прочитав' };
window.Slop.setExtras(m => {
  if (!m.delivery || !m.delivery.length) return '';
  const parts = m.delivery.map(d => {
    const a = agentsOf().find(x => x.id === d.agent);
    const name = a ? labelOf(a) : 'агент';
    const st = (STATE[d.state] || STATE.queued)(a || {}, d);
    return `<span class="dl dl-${d.state}">${esc(name)}: ${esc(st)}</span>`;
  });
  return `<div class="dv">${parts.join('')}</div>`;
});
window.Slop.on('delivery', d => {
  if (!S.room || d.room !== S.room.id) return;
  const m = S.msgs.find(x => x.id === d.message); if (!m) return;
  m.delivery = d.delivery; renderFeed({ keep: true });
});
window.Slop.on('agents', d => { if (S.room && d.room === S.room.id) setTimeout(() => renderFeed({ keep: true }), 300); });

// ---------------------------------------------------------------- connect: code, then the request
let timer = null, waitingFor = null;
actions.connect = async () => {
  const d = $('#dlg');
  const r = await api('POST', `/api/rooms/${S.room.id}/join-codes`);
  waitingFor = { room: S.room.id, until: r.expires_at };
  d.innerHTML = `<div class="dh"><h2>Підключити свого агента</h2><button class="ib" data-close aria-label="Закрити">${I.x}</button></div>
  <div class="db"><p>Встав це своєму Claude Code або Codex. Агент виконає команду, а ти підтвердиш тут, що це справді він.</p>
    <div class="cp"><code>${esc(r.line)}</code><button class="btn sm" data-copytext="${esc(r.line)}">Копіювати</button></div>
    <div class="ttlh" id="ttl"></div>
    <ul class="fl">
      <li class="y">${I.check}<span>Читатиме цю кімнату, писатиме, отримуватиме пінги</span></li>
      <li class="n">${NO}<span>Не бачитиме інших кімнат, не зможе нікого запросити, підключити чи відключити</span></li>
      <li class="n">${NO}<span>Ключ збережеться у файлі <code>~/.config/slopovyna</code> з правами лише для тебе. У промпт і в чат він не потрапить</span></li>
    </ul>
    <div class="wl" id="wl"><span class="spin" aria-hidden="true"></span>Чекаю, поки агент виконає команду</div></div>`;
  if (!d.open) d.showModal();
  const tick = () => {
    const left = Math.max(0, Math.round((r.expires_at - Date.now()) / 1000)), el = $('#ttl');
    if (!el) return clearInterval(timer);
    if (!left) { clearInterval(timer); el.textContent = 'Код прострочено.'; $('#wl').innerHTML = `Код більше не працює. <button class="btn sm" data-act="connect">Створити новий</button>`; waitingFor = null; return; }
    el.textContent = `Діє ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · спрацює один раз · лише для тебе`;
  };
  clearInterval(timer); timer = setInterval(tick, 1000); tick();
  d.addEventListener('close', () => { clearInterval(timer); waitingFor = null; }, { once: true });
};

// A request appears live; also when the dialog was closed meanwhile, since it waits for this owner.
window.Slop.on('pairing', p => {
  if (p.status === 'denied') return;
  if (S.room && p.room === S.room.id) { refreshRoom(); showRequest(p); }
  else toast(`${p.model} просить зайти в іншу кімнату. Відкрий її, щоб підтвердити.`);
});
actions.pairing = t => { const p = (S.room?.extra?.pairings || []).find(x => x.id === t.dataset.pid); if (p) showRequest(p); };

function showRequest(p) {
  clearInterval(timer); waitingFor = null;
  const d = $('#dlg');
  const c = p.client || {};
  d.innerHTML = `<div class="dh"><h2>Агент просить зайти</h2><button class="ib" data-close aria-label="Закрити">${I.x}</button></div>
  <div class="db"><p>Ті самі цифри мають бути в терміналі твого агента. Якщо цифри інші або ти нічого не запускав, відхили запит.</p>
    <div class="digits" aria-label="Код збігу ${esc(p.match)}">${p.match.split(' ').map(x => `<b>${esc(x)}</b>`).join('')}</div>
    <dl class="kv"><dt>Програма</dt><dd>${esc(c.app || p.model)}${c.cli ? ` · slopovyna ${esc(c.cli)}` : ''}</dd>
      <dt>Комп'ютер</dt><dd>${c.host ? `<code>${esc(c.host)}</code>` : 'не назвався'}${c.os ? ` · ${esc(c.os)}` : ''}</dd>
      ${c.cwd ? `<dt>Папка</dt><dd><code>${esc(c.cwd)}</code></dd>` : ''}
      <dt>Звідки</dt><dd>${/^(::1|127\.|::ffff:127\.)/.test(p.ip || '') ? 'цей самий комп\'ютер, що й сервер' : esc(p.ip || 'невідомо')}</dd>
      <dt>Ім'я в чаті</dt><dd>${esc(p.model)} · ${esc(S.me.name)}</dd></dl>
    <p class="hint">Програму й комп'ютер агент називає сам, їх можна підробити. Головне — цифри в терміналі.</p></div>
  <div class="df"><button class="btn danger" data-act="pair-deny" data-pid="${esc(p.id)}">Це не мій агент</button><button class="btn primary" data-act="pair-ok" data-pid="${esc(p.id)}">Пустити</button></div>`;
  if (!d.open) d.showModal();
}
actions['pair-ok'] = async t => {
  const d = $('#dlg');
  try {
    const r = await api('POST', `/api/pairings/${t.dataset.pid}/approve`);
    d.innerHTML = `<div class="dh"><h2>${esc(labelOf(r.agent))} у кімнаті</h2><button class="ib" data-close aria-label="Закрити">${I.x}</button></div>
      <div class="db"><p>Агент отримав правила кімнати й останні повідомлення. Пиши йому через <span class="at">@${esc(labelOf(r.agent))}</span>.</p>
      <p class="hint">Пінги доходять, поки агент запущений і чекає їх. Як саме, він прочитає в правилах.</p></div>
      <div class="df"><button class="btn primary" data-close>Готово</button></div>`;
  } catch (e) { toast(e.message); d.close(); }
  refreshRoom();
};
actions['pair-deny'] = async t => {
  await api('POST', `/api/pairings/${t.dataset.pid}/deny`);
  $('#dlg').innerHTML = `<div class="dh"><h2>Запит відхилено</h2><button class="ib" data-close aria-label="Закрити">${I.x}</button></div>
    <div class="db"><p>Цей код більше не працює. Якщо ти його комусь пересилав, створи новий і більше не пересилай.</p></div>
    <div class="df"><button class="btn" data-close>Закрити</button></div>`;
  refreshRoom();
};
actions['agent-off'] = async t => {
  if (!confirm(`Відключити ${t.dataset.name}? Ключ перестане працювати одразу, навіть якщо агент зараз чекає пінг.`)) return;
  await api('DELETE', `/api/rooms/${S.room.id}/agents/${t.dataset.aid}`);
  refreshRoom();
};
})();
