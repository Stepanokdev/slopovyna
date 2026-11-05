// Agents in the web client: connecting one (code → request → approval), their status in the panel,
// and the delivery state under messages that mention them.
'use strict';
(() => {
const { S, api, esc, avatar, labelOf, toast, copy, I, $, actions, refreshRoom, renderFeed, T } = window.Slop;
const BOT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01"/></svg>';
const NO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="m6.5 17.5 11-11"/></svg>';
const ago = t => { if (!t) return T('a.never'); const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? T('a.now') : m < 60 ? T('a.min', { n: m }) : m < 1440 ? T('a.hour', { n: Math.round(m / 60) }) : T('a.day', { n: Math.round(m / 1440) }); };
const agentsOf = () => (S.room?.extra?.agents || []);

// ---------------------------------------------------------------- panel
window.Slop.setPanel({
  agents: () => {
    const list = agentsOf(), pend = S.room?.extra?.pairings || [];
    const row = a => {
      const mine = a.owner_uid === S.me.uid, canKick = mine || S.room.role === 'owner';
      return `<div class="row">${avatar(a)}<span class="nmw"><b>${esc(labelOf(a))}</b><small class="${a.listening ? 'on' : ''}">${a.listening ? T('a.listening') : T('a.offline', { ago: esc(ago(a.last_seen)) })}</small></span>
        ${canKick ? `<button class="btn sm danger" data-act="agent-off" data-aid="${esc(a.aid)}" data-name="${esc(labelOf(a))}">${T('a.off')}</button>` : ''}</div>`;
    };
    return `<h3>${T('a.agents')}</h3>${list.length ? list.map(row).join('') : `<p class="n">${T('a.none')}</p>`}
      ${pend.map(p => `<div class="row pend"><span class="av ag" aria-hidden="true">?</span><span class="nmw"><b>${esc(T('a.asks', { model: p.model }))}</b><small>${esc(p.client.host || T('a.unknownHost'))} · ${esc(T('a.digits', { match: p.match }))}</small></span><button class="btn sm primary" data-act="pairing" data-pid="${esc(p.id)}">${T('a.view')}</button></div>`).join('')}`;
  },
  actions: () => `<button class="btn primary" data-act="connect">${BOT}${T('a.connect')}</button>`,
  notes: () => `<p class="n">${T('a.note1')}</p>
    <p class="n">${T('a.note2')}</p>`,
});

// ---------------------------------------------------------------- delivery under messages
const STATE = { queued: a => T(a.listening ? 'a.d.queuedOn' : 'a.d.queuedOff'), received: (a, d) => `${T('a.d.received')}${d.at ? ' ' + window.Slop.fmt().timeFmt.format(d.at) : ''}`, replied: () => T('a.d.replied'), read: () => T('a.d.read') };
window.Slop.setExtras(m => {
  if (!m.delivery || !m.delivery.length) return '';
  const parts = m.delivery.map(d => {
    const a = agentsOf().find(x => x.id === d.agent);
    const name = a ? labelOf(a) : (d.name || T('g.agent'));
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
  d.innerHTML = `<div class="dh"><h2>${T('a.cTitle')}</h2><button class="ib" data-close aria-label="${T('g.close')}">${I.x}</button></div>
  <div class="db"><p>${T('a.cLead')}</p>
    <div class="cp"><code>${esc(r.line)}</code><button class="btn sm" data-copytext="${esc(r.line)}">${T('g.copy')}</button></div>
    <div class="ttlh" id="ttl"></div>
    <ul class="fl">
      <li class="y">${I.check}<span>${T('a.can')}</span></li>
      <li class="n">${NO}<span>${T('a.cannot')}</span></li>
      <li class="n">${NO}<span>${T('a.key')}</span></li>
    </ul>
    <div class="wl" id="wl"><span class="spin" aria-hidden="true"></span>${T('a.waiting')}</div></div>`;
  if (!d.open) d.showModal();
  const tick = () => {
    const left = Math.max(0, Math.round((r.expires_at - Date.now()) / 1000)), el = $('#ttl');
    if (!el) return clearInterval(timer);
    if (!left) { clearInterval(timer); el.textContent = T('a.expired'); $('#wl').innerHTML = `${T('a.expiredMore')} <button class="btn sm" data-act="connect">${T('a.newCode')}</button>`; waitingFor = null; return; }
    el.textContent = T('a.ttl', { left: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
  };
  clearInterval(timer); timer = setInterval(tick, 1000); tick();
  d.addEventListener('close', () => { clearInterval(timer); waitingFor = null; }, { once: true });
};

// A request appears live; also when the dialog was closed meanwhile, since it waits for this owner.
window.Slop.on('pairing', p => {
  if (p.status === 'denied') return;
  if (S.room && p.room === S.room.id) { refreshRoom(); showRequest(p); }
  else toast(T('a.otherRoom', { model: p.model }));
});
actions.pairing = t => { const p = (S.room?.extra?.pairings || []).find(x => x.id === t.dataset.pid); if (p) showRequest(p); };

function showRequest(p) {
  clearInterval(timer); waitingFor = null;
  const d = $('#dlg');
  const c = p.client || {};
  d.innerHTML = `<div class="dh"><h2>${T('a.rTitle')}</h2><button class="ib" data-close aria-label="${T('g.close')}">${I.x}</button></div>
  <div class="db"><p>${T('a.rLead')}</p>
    <div class="digits" aria-label="${esc(T('a.match', { match: p.match }))}">${p.match.split(' ').map(x => `<b>${esc(x)}</b>`).join('')}</div>
    <dl class="kv"><dt>${T('a.app')}</dt><dd>${esc(c.app || p.model)}${c.cli ? ` · slopovyna ${esc(c.cli)}` : ''}</dd>
      <dt>${T('a.host')}</dt><dd>${c.host ? `<code>${esc(c.host)}</code>` : T('a.noHost')}${c.os ? ` · ${esc(c.os)}` : ''}</dd>
      ${c.cwd ? `<dt>${T('a.folder')}</dt><dd><code>${esc(c.cwd)}</code></dd>` : ''}
      <dt>${T('a.from')}</dt><dd>${/^(::1|127\.|::ffff:127\.)/.test(p.ip || '') ? T('a.sameMachine') : esc(p.ip || T('a.unknown'))}</dd>
      <dt>${T('a.chatName')}</dt><dd>${esc(p.model)} · ${esc(S.me.name)}</dd></dl>
    <p class="hint">${T('a.spoof')}</p></div>
  <div class="df"><button class="btn danger" data-act="pair-deny" data-pid="${esc(p.id)}">${T('a.deny')}</button><button class="btn primary" data-act="pair-ok" data-pid="${esc(p.id)}">${T('a.allow')}</button></div>`;
  if (!d.open) d.showModal();
}
actions['pair-ok'] = async t => {
  const d = $('#dlg');
  try {
    const r = await api('POST', `/api/pairings/${t.dataset.pid}/approve`);
    d.innerHTML = `<div class="dh"><h2>${esc(T('a.inTitle', { name: labelOf(r.agent) }))}</h2><button class="ib" data-close aria-label="${T('g.close')}">${I.x}</button></div>
      <div class="db"><p>${T('a.inLead', { name: esc(labelOf(r.agent)) })}</p>
      <p class="hint">${T('a.inHint')}</p></div>
      <div class="df"><button class="btn primary" data-close>${T('g.done')}</button></div>`;
  } catch (e) { toast(e.message); d.close(); }
  refreshRoom();
};
actions['pair-deny'] = async t => {
  await api('POST', `/api/pairings/${t.dataset.pid}/deny`);
  $('#dlg').innerHTML = `<div class="dh"><h2>${T('a.deniedTitle')}</h2><button class="ib" data-close aria-label="${T('g.close')}">${I.x}</button></div>
    <div class="db"><p>${T('a.deniedText')}</p></div>
    <div class="df"><button class="btn" data-close>${T('g.close')}</button></div>`;
  refreshRoom();
};
actions['agent-off'] = async t => {
  if (!confirm(T('a.offQ', { name: t.dataset.name }))) return;
  await api('DELETE', `/api/rooms/${S.room.id}/agents/${t.dataset.aid}`);
  refreshRoom();
};
})();
