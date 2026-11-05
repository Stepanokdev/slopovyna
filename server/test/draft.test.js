'use strict';
// The browser's draft logic (public/draft.js), exercised with an in-memory store.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/draft.js');

const mem = () => { const m = new Map(); return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => (v == null ? m.delete(k) : m.set(k, v)), m }; };
const labels = { 'u:2': 'Марта', 'a:9': 'Codex · Марта' };
const lbl = id => labels[id] || null;
let n = 0; const newKey = () => `key-${++n}-abcdefgh`;

test('a picked mention survives a reload with its draft', () => {
  const s = mem();
  D.save(s, 'room1', '@Марта перевір', ['u:2']);
  const back = D.load(s, 'room1');
  assert.equal(back.text, '@Марта перевір');
  assert.deepEqual(D.liveMentions(back.text, back.mentions, lbl), ['u:2']);
});

test('a mention whose @label was deleted from the text is not sent', () => {
  assert.deepEqual(D.liveMentions('перевір, будь ласка', ['u:2'], lbl), []);
  assert.deepEqual(D.liveMentions('@Codex · Марта і @Марта', ['a:9', 'u:2', 'u:404'], lbl), ['a:9', 'u:2']);
});

test('drafts saved as plain strings by the older client still load', () => {
  const s = mem(); s.set('slop.draft.old', 'просто текст');
  assert.deepEqual(D.load(s, 'old'), { text: 'просто текст', mentions: [] });
});

test('retrying the same text reuses the key; new text gets a new one', () => {
  const s = mem();
  const a = D.attempt(s, 'r', 'привіт', newKey);
  assert.equal(D.attempt(s, 'r', 'привіт', newKey), a);
  assert.notEqual(D.attempt(s, 'r', 'привіт!', newKey), a);
});

test('text typed while the message was being sent is kept, with its mention', () => {
  const s = mem();
  // sent "перше", and while waiting the person appended a second line mentioning Марта
  const left = D.afterSend(s, 'r', 'перше', 'перше\n@Марта а ще друге', ['u:2'], lbl);
  assert.deepEqual(left, { text: '@Марта а ще друге', mentions: ['u:2'] });
  assert.deepEqual(D.load(s, 'r'), left);
  assert.equal(s.get('slop.attempt.r'), null);
});

test('an unchanged box is cleared after the send; an edited one is kept whole', () => {
  const s = mem();
  assert.deepEqual(D.afterSend(s, 'r', 'текст ', 'текст', [], lbl), { text: '', mentions: [] });
  assert.equal(s.get('slop.draft.r'), null);
  const edited = D.afterSend(s, 'r', 'текст', 'інший текст', [], lbl);
  assert.equal(edited.text, 'інший текст');
});
