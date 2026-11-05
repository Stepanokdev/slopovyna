// Drafts of the message box, one per room. A draft is the text and the people picked from the @-list
// (their ids, so a mention stays a mention after a reload), plus the idempotency key of the attempt
// that is being sent. Plain functions over a key-value store: the browser passes localStorage, tests
// pass a Map.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SlopDraft = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const dKey = key => `slop.draft.${key}`;
  const aKey = key => `slop.attempt.${key}`;
  const get = (store, k) => { try { return store.get(k); } catch { return null; } };
  const set = (store, k, v) => { try { store.set(k, v); } catch {} };

  function load(store, key) {
    const raw = get(store, dKey(key));
    if (!raw) return { text: '', mentions: [] };
    try {
      const v = JSON.parse(raw);
      if (v && typeof v.text === 'string') return { text: v.text, mentions: Array.isArray(v.mentions) ? v.mentions.map(String) : [] };
    } catch {}
    return { text: String(raw), mentions: [] };            // drafts saved before mentions were kept
  }
  function save(store, key, text, mentions) {
    if (!text) return set(store, dKey(key), null);
    set(store, dKey(key), JSON.stringify({ text, mentions: [...new Set(mentions || [])] }));
  }

  // The mention ids whose "@label" is still in the text; labelOf(id) returns null for someone gone.
  function liveMentions(text, mentions, labelOf) {
    return [...new Set(mentions || [])].filter(id => { const l = labelOf(id); return l && text.includes('@' + l); });
  }

  // One key per unsent text. The same text again (a retry, also after a reload) reuses the key, so a
  // send whose answer was lost cannot land twice; a different text gets a new key.
  function attempt(store, key, text, newKey) {
    let a = null;
    try { a = JSON.parse(get(store, aKey(key)) || 'null'); } catch {}
    if (!a || a.text !== text) { a = { text, idem: newKey() }; set(store, aKey(key), JSON.stringify(a)); }
    return a.idem;
  }

  // After the server confirmed `sent`, what stays in the box. Whatever was typed while it was being
  // sent is kept: if the box still starts with what was sent, only the rest remains; if it was edited
  // some other way, all of it remains. The attempt key is dropped either way, it has been used.
  function afterSend(store, key, sentRaw, current, mentions, labelOf) {
    set(store, aKey(key), null);
    let rest;
    if (current === sentRaw || current.trim() === sentRaw.trim()) rest = '';
    else if (current.startsWith(sentRaw)) rest = current.slice(sentRaw.length).replace(/^\s+/, '');
    else rest = current;
    const keep = rest ? liveMentions(rest, mentions, labelOf) : [];
    save(store, key, rest, keep);
    return { text: rest, mentions: keep };
  }

  return { load, save, liveMentions, attempt, afterSend };
});
