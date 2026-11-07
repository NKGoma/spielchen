// Run: node tests/rules.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as R from '../js/rules.js';
import { validateCard, Deck, GAMES_BY_CATEGORY, MINI_GAMES, seenKey } from '../js/deck.js';
import { extractArray, cleanCards, generateDeck, userPrompt, systemPrompt } from '../js/generate.js';
import { candidates, commentFor } from '../js/commentary.js';
import { parseBrief, topicsFromText, briefPrompt, applyLocally, briefSummary } from '../js/brief.js';
import { friendlyError, LlmError } from '../js/llm.js';
import { HostNet } from '../js/net.js';

let passed = 0;
const pending = [];
const test = (name, fn) => {
  const fail = e => { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; };
  try {
    const r = fn();
    if (r && r.then) pending.push(r.then(() => { passed++; console.log('  ok  ' + name); }, fail));
    else { passed++; console.log('  ok  ' + name); }
  } catch (e) { fail(e); }
};

const players = n => Array.from({ length: n }, (_, k) => ({ id: 'p' + (k + 1), name: 'P' + (k + 1), color: '#fff', emoji: 'x' }));
const ffa = n => R.createGame({ players: players(n) });
const at = (s, pos, idx = s.turnIdx) => { const c = R.clone(s); c.tokens[idx].pos = pos; c.turnStart = pos; return c; };

console.log('board');
test('24 squares, specials at fixed spots', () => {
  assert.equal(R.BOARD.length, 24);
  const t = i => R.BOARD[i].type;
  assert.equal(t(0), 'start'); assert.equal(t(23), 'finale');
  assert.equal(t(4), 'pfand'); assert.equal(t(6), 'allplay'); assert.equal(t(15), 'allplay');
  assert.equal(t(9), 'db'); assert.equal(t(19), 'db'); assert.equal(t(11), 'wild'); assert.equal(t(20), 'wild');
  assert.equal(t(13), 'burgeramt');
});
test('colour squares cycle blue, pink, yellow, green', () => {
  const cats = R.BOARD.filter(s => s.type === 'colour').map(s => s.category);
  assert.equal(cats.length, 14);
  cats.forEach((c, k) => assert.equal(c, R.CATEGORIES[k % 4]));
});
test('snake layout: 3 rows, no overlaps', () => {
  const cells = new Set();
  for (let i = 0; i < 24; i++) {
    const { row, col, span } = R.squareLayout(i);
    assert.ok(row >= 0 && row < 3);
    for (let c = col; c < col + span; c++) { const key = row + ',' + c; assert.ok(!cells.has(key), 'overlap at ' + key); cells.add(key); }
  }
  assert.equal(R.squareLayout(0).span, 2); assert.equal(R.squareLayout(23).span, 2);
});

console.log('movement');
test('roll is 1–4', () => { for (let i = 0; i < 200; i++) { const d = R.rollDie(); assert.ok(d >= 1 && d <= 4); } });
test('move clamps at Finale', () => {
  const { to, square } = R.moveActive(at(ffa(3), 21), 4);
  assert.equal(to, 23); assert.equal(square.type, 'finale');
});
test('moveActive does not mutate input', () => {
  const s = ffa(3); R.moveActive(s, 3); assert.equal(s.tokens[0].pos, 0);
});

console.log('scoring');
test('success stays; hard +1', () => {
  let s = R.moveActive(ffa(3), 3).state;
  assert.equal(R.applyCardResult(s, { ok: true }).state.tokens[0].pos, 3);
  assert.equal(R.applyCardResult(s, { ok: true, hard: true }).state.tokens[0].pos, 4);
});
test('FFA first guesser +1', () => {
  const s = R.moveActive(ffa(3), 2).state;
  const r = R.applyCardResult(s, { ok: true, guesserId: 'p2' });
  assert.equal(r.state.tokens[1].pos, 1);
  assert.equal(r.state.tokens[0].pos, 2);
});
test('fail goes back to turn start', () => {
  const s = R.moveActive(at(ffa(3), 5), 2).state;
  assert.equal(R.applyCardResult(s, { ok: false }).state.tokens[0].pos, 5);
});
test('steal: active back, stealer +1, counted', () => {
  const s = R.moveActive(at(ffa(3), 5), 2).state;
  const r = R.applyCardResult(s, { ok: false, stealerId: 'p3' });
  assert.equal(r.state.tokens[0].pos, 5); assert.equal(r.state.tokens[2].pos, 1);
  assert.equal(r.state.stats.steals.p3, 1);
});
test('All Play winner +2 (team token in team mode)', () => {
  assert.equal(R.applyAllPlayResult(ffa(3), 'p2').state.tokens[1].pos, 2);
  const g = R.createGame({ players: players(4), teams: [['p1', 'p3'], ['p2', 'p4']] });
  assert.equal(R.applyAllPlayResult(g, 'p3').state.tokens[0].pos, 2);
  assert.equal(R.applyAllPlayResult(ffa(3), null).moves.length, 0);
});

console.log('specials');
test('Pfand +2 and does not chain into All Play', () => {
  const s = at(ffa(3), 4);
  const r = R.applySpecial(s, 'pfand');
  assert.equal(r.state.tokens[0].pos, 6);
  assert.equal(r.moves.length, 1);
});
test('Deutsche Bahn back 3, victim counted', () => {
  const r = R.applySpecial(at(ffa(3), 9), 'db');
  assert.equal(r.state.tokens[0].pos, 6); assert.equal(r.state.stats.dbVictims.p1, 1);
});
test('Bürgeramt skips the next turn exactly once', () => {
  let s = R.applySpecial(at(ffa(2), 13), 'burgeramt').state;
  s = R.endTurn(s);                          // p2's turn
  assert.equal(s.turnIdx, 1);
  s = R.endTurn(s);                          // back to p1, who must skip
  let r = R.beginTurn(s);
  assert.equal(r.skipped, true); assert.equal(r.state.turnIdx, 1);
  s = R.endTurn(r.state);
  r = R.beginTurn(s);
  assert.equal(r.skipped, false);
});
test('Finale: success wins, fail back 3', () => {
  const s = at(ffa(3), 23);
  const w = R.applyCardResult(s, { ok: true, finale: true });
  assert.equal(w.won, true); assert.equal(w.state.winnerId, s.tokens[0].id);
  assert.equal(R.decideWinner(w.state).winnerId, s.tokens[0].id);
  assert.equal(R.applyCardResult(s, { ok: false, finale: true }).state.tokens[0].pos, 20);
});
test('bonus move onto Finale means play the Finale next turn without rolling', () => {
  const s = R.applyCardResult(R.moveActive(at(ffa(3), 20), 2).state, { ok: true, hard: true }).state;
  assert.equal(s.tokens[0].pos, 23); assert.equal(s.winnerId, null);
  assert.equal(R.needsFinaleWithoutRoll(s), true);
});

console.log('teams & turn order');
test('FFA turn order is clockwise', () => {
  let s = ffa(3); const seen = [];
  for (let i = 0; i < 6; i++) { seen.push(R.activePlayerId(s)); s = R.endTurn(s); }
  assert.deepEqual(seen, ['p1', 'p2', 'p3', 'p1', 'p2', 'p3']);
});
test('teams alternate and members rotate', () => {
  let s = R.createGame({ players: players(4), teams: [['p1', 'p3'], ['p2', 'p4']] });
  assert.equal(s.tokens.length, 2);
  const seen = [];
  for (let i = 0; i < 4; i++) { seen.push(R.activePlayerId(s)); s = R.endTurn(s); }
  assert.deepEqual(seen, ['p1', 'p2', 'p3', 'p4']);
  assert.equal(R.teammateId(R.createGame({ players: players(4), teams: [['p1', 'p3'], ['p2', 'p4']] })), 'p3');
});
test('teams only for 4 or 6', () => {
  assert.equal(R.createGame({ players: players(3), teams: [['p1', 'p2']] }).teamMode, false);
  assert.equal(R.makeTeams(['a', 'b', 'c', 'd', 'e', 'f']).length, 3);
});
test('guesser on own team gets nothing', () => {
  const g = R.createGame({ players: players(4), teams: [['p1', 'p3'], ['p2', 'p4']] });
  const r = R.applyCardResult(R.moveActive(g, 2).state, { ok: true, guesserId: 'p3' });
  assert.equal(r.state.tokens[0].pos, 2);
});

console.log('ending');
test('Last orders: every player gets one more turn; mid-turn call does not count', () => {
  let s = R.callLastOrders(ffa(3), false);
  assert.equal(s.lastOrders, 3);
  for (let i = 0; i < 3; i++) { assert.equal(R.isOver(s, false), false); s = R.endTurn(s); }
  assert.equal(R.isOver(s, false), true);
  let m = R.callLastOrders(ffa(3), true);
  m = R.endTurn(m); assert.equal(m.lastOrders, 3);
});
test('time up: furthest wins; tie → sudden death', () => {
  const s = at(at(ffa(3), 10, 0), 7, 1);
  assert.equal(R.decideWinner(s).winnerId, s.tokens[0].id);
  const t = at(at(ffa(3), 10, 0), 10, 1);
  assert.deepEqual(R.decideWinner(t).suddenDeath, [t.tokens[0].id, t.tokens[1].id]);
});
test('auto-stats', () => {
  const s = R.applyCardResult(R.moveActive(ffa(3), 2).state, { ok: true, guesserId: 'p2', elapsedMs: 4200 }).state;
  const st = R.autoStats(s);
  assert.equal(st.length, 4); assert.equal(st[0].value, 'P2');
});

console.log('deck');
const cards = JSON.parse(readFileSync(new URL('../data/backup-deck.json', import.meta.url)));
test('backup deck: 96 valid cards, 20/20/20/20/16', () => {
  assert.equal(cards.length, 96);
  const bad = cards.filter(c => !validateCard(c));
  assert.deepEqual(bad.map(c => c.id), []);
  const count = cat => cards.filter(c => c.category === cat).length;
  assert.deepEqual(['act', 'draw', 'words', 'brains', 'allplay'].map(count), [20, 20, 20, 20, 16]);
  assert.equal(new Set(cards.map(c => c.id)).size, 96);
});
test('backup deck: every mini-game present, mix roughly right', () => {
  for (const [cat, games] of Object.entries(GAMES_BY_CATEGORY)) for (const g of games) assert.ok(cards.some(c => c.category === cat && c.game === g), g);
  const share = f => cards.filter(f).length / cards.length;
  assert.ok(Math.abs(share(c => c.german) - 0.25) < 0.06);
  assert.ok(Math.abs(share(c => c.difficulty === 'hard') - 0.2) < 0.05);
});
test('validateCard rejects wrong game/category and missing fields', () => {
  const ok = { id: 'x', category: 'words', game: 'taboo', prompt: 'P', forbidden: ['a', 'b', 'c', 'd'], difficulty: 'easy', tone: 'clean', german: false, hint_en: null };
  assert.ok(validateCard(ok));
  assert.ok(!validateCard({ ...ok, category: 'act' }));
  assert.ok(!validateCard({ ...ok, forbidden: ['a'] }));
  assert.ok(!validateCard({ ...ok, german: true }));
});
test('Deck never serves the same mini-game twice in a row', () => {
  const d = new Deck(cards);
  for (const cat of Object.keys(GAMES_BY_CATEGORY)) {
    let last = null;
    for (let i = 0; i < 40; i++) { const c = d.draw(cat); assert.ok(c); assert.notEqual(c.game, last); last = c.game; }
  }
});
test('Deck hard draw returns hard cards', () => {
  const d = new Deck(cards);
  for (let i = 0; i < 10; i++) assert.equal(d.draw('act', { hard: true }).difficulty, 'hard');
});


console.log('quizmaster, streaks, commentary');
test('quizmaster is never the active player or a teammate', () => {
  let s = ffa(3);
  for (let i = 0; i < 6; i++) { const q = R.quizmasterId(s); assert.notEqual(q, R.activePlayerId(s)); s = R.endTurn(s); }
  assert.equal(R.quizmasterId(ffa(3)), 'p3');        // previous player (to the right)
  let t = R.createGame({ players: players(6), teams: [['p1', 'p4'], ['p2', 'p5'], ['p3', 'p6']] });
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const q = R.quizmasterId(t);
    assert.ok(!R.activeToken(t).memberIds.includes(q));
    seen.add(q); t = R.endTurn(t);
  }
  assert.ok(seen.size >= 4, 'quizmaster rotates');
});
test('streaks count successes and reset on a fail', () => {
  let s = ffa(2);
  const turn = ok => { s = R.applyCardResult(R.moveActive(s, 1).state, { ok }).state; s = R.endTurn(R.endTurn(s)); };
  turn(true); turn(true); turn(true);
  assert.equal(s.stats.streak[s.tokens[0].id], 3);
  assert.equal(s.stats.bestStreak.n, 3);
  turn(false);
  assert.equal(s.stats.streak[s.tokens[0].id], 0);
  assert.equal(R.autoStats(s)[3].detail, '3 in a row');
});
test('leaderId: unique leader or null', () => {
  assert.equal(R.leaderId(ffa(3)), null);
  assert.equal(R.leaderId(at(ffa(3), 5)), ffa(3).tokens[0].id);
  assert.equal(R.leaderId(at(at(ffa(3), 5, 0), 5, 1)), null);
});
test('All Play: tied winners each +2, teammates only once', () => {
  const r = R.applyAllPlayResult(ffa(3), ['p1', 'p2']);
  assert.deepEqual(r.state.tokens.map(t => t.pos), [2, 2, 0]);
  const g = R.createGame({ players: players(4), teams: [['p1', 'p3'], ['p2', 'p4']] });
  assert.equal(R.applyAllPlayResult(g, ['p1', 'p3']).state.tokens[0].pos, 2);
});
test('commentary: streak, lead change, steal, second DB', () => {
  let s = ffa(3);
  s.stats.streak = { [s.tokens[0].id]: 2 };
  const before = R.moveActive(s, 2).state;
  const after = R.applyCardResult(before, { ok: true }).state;
  const keys = candidates({ type: 'card', ok: true }, before, after).map(c => c.key);
  assert.ok(keys.includes('streak3')); assert.ok(keys.includes('lead'));
  const st = R.applyCardResult(before, { ok: false, stealerId: 'p2' }).state;
  assert.equal(candidates({ type: 'card', ok: false, stealerId: 'p2' }, before, st)[0].key, 'steal');
  let d = at(ffa(3), 9); d.stats.dbVictims = { p1: 1 };
  const d2 = R.applySpecial(d, 'db').state;
  assert.ok(candidates({ type: 'special', square: 'db' }, d, d2).some(c => c.key === 'db2'));
  assert.equal(typeof commentFor({ type: 'card', ok: true }, before, after), 'string');
});
test('TV lines name the player and never contain the secret', () => {
  for (const c of cards) {
    const line = MINI_GAMES[c.game].tv('Lena', c);
    assert.ok(line.length > 10);
    if (c.category !== 'allplay') assert.ok(line.includes('Lena'), c.game);
    if (c.category !== 'brains' && c.category !== 'allplay') assert.ok(!line.toLowerCase().includes(c.prompt.toLowerCase()), c.id);
    if (c.answer && c.category !== 'allplay') assert.ok(!line.includes(String(c.answer)), c.id);
  }
});
test('Deck serves unseen cards first', () => {
  const seen = cards.filter(c => c.category === 'act').slice(0, 10).map(seenKey);
  const d = new Deck(cards, Math.random, seen);
  const first = Array.from({ length: 5 }, () => seenKey(d.draw('act')));
  assert.ok(first.every(k => !seen.includes(k)), first.join(','));
});
test('no "what does this German word mean" questions', () => {
  const qs = cards.flatMap(c => [c.prompt, ...(c.questions || []).map(q => q.q)]);
  assert.ok(!qs.some(q => /literally mean|what is a “|what does .* mean/i.test(q)));
  const share = cards.filter(c => c.tone === 'cheeky').length / cards.length;
  assert.ok(share > 0.24 && share < 0.36, 'cheeky share ' + share);
});

console.log('generation (mocked model)');
test('extractArray finds the first JSON array through prose and fences', () => {
  assert.deepEqual(extractArray('Sure!\n```json\n[{"a":"x]"},{"b":[1,2]}]\n``` done [9]'), [{ a: 'x]' }, { b: [1, 2] }]);
  assert.equal(extractArray('no array here'), null);
  assert.equal(extractArray('[{"broken": }]'), null);
});
test('cleanCards drops invalid, wrong-category and already-seen cards', () => {
  const raw = [
    { game: 'taboo', prompt: 'Pizza', forbidden: ['a', 'b', 'c', 'd'], difficulty: 'easy', tone: 'clean', german: false, hint_en: null },
    { game: 'taboo', prompt: 'Short', forbidden: ['a'], difficulty: 'easy', tone: 'clean', german: false },
    { game: 'charades', prompt: 'Wrong category', difficulty: 'easy', tone: 'clean', german: false },
    { game: 'rhyme', prompt: 'Seen before', difficulty: 'easy', tone: 'clean', german: false },
    { game: 'rhyme', prompt: 'pizza', difficulty: 'easy', tone: 'clean', german: false },
  ];
  const out = cleanCards(raw, 'words', new Set(['seen before']));
  assert.deepEqual(out.map(c => c.prompt), ['Pizza']);
  assert.ok(out[0].id.startsWith('gen-words-'));
});
test('closer tolerance given as a string is normalised', () => {
  const out = cleanCards([{ game: 'closer', prompt: 'Q?', answer: 42, tolerance: '5', difficulty: 'easy', tone: 'clean', german: false }], 'brains');
  assert.equal(out[0].tolerance, 5); assert.equal(out[0].answer, '42');
});
test('prompts carry the avoid list, counts and the no-translation rule', () => {
  const u = userPrompt({ category: 'brains', avoid: ['old one'], examples: [] });
  assert.ok(u.includes('AVOID: old one')); assert.ok(u.includes('quiz: 6')); assert.ok(u.includes('Count: 14'));
  assert.ok(/Never ask what a German word means/.test(systemPrompt({ germanPct: 30, cleanPct: 60 })));
  assert.ok(systemPrompt({ germanPct: 30, cleanPct: 60 }).includes('about 30% German-life'));
});
test('generateDeck: parallel calls, one failure falls back, short replies topped up', async () => {
  const good = cat => JSON.stringify(cards.filter(c => c.category === cat).map(c => ({ ...c, prompt: c.prompt + ' (new)' })));
  const calls = [];
  const call = async ({ user }) => {
    const cat = /Category: (\w+)/.exec(user)[1];
    calls.push(cat);
    if (cat === 'draw') throw new Error('boom');
    if (cat === 'act') return '[' + JSON.stringify({ game: 'scene', prompt: 'Only one', difficulty: 'easy', tone: 'clean', german: false, hint_en: null }) + ']';
    return good(cat);
  };
  const landed = [];
  const res = await generateDeck({ key: 'k', model: 'm', settings: {}, backupCards: cards, call, onCategory: (c, list, fresh) => landed.push([c, fresh]) });
  assert.equal(calls.length, 5);
  assert.equal(res.draw, undefined);
  assert.equal(res.act.length >= 6, true);
  assert.equal(res.act[0].prompt, 'Only one');
  assert.equal(res.brains.length, 20);
  assert.deepEqual(landed.find(l => l[0] === 'draw'), ['draw', 0]);
});

console.log('card brief, errors, room code');
test('brief: "only music" after other topics means only music', () => {
  const cur = { topics: ['football', 'Berlin life'], only: false };
  // No model / unparseable reply: local rules.
  assert.deepEqual(parseBrief('', cur, 'only music'), { reply: 'Got it: only music.', topics: ['music'], only: true });
  // The model wrongly merges the old topics: the user's "only" still wins.
  const merged = parseBrief('{"reply":"Football, Berlin and music!","topics":["football","Berlin life","music"],"only":false}', cur, 'only music please');
  assert.deepEqual(merged.topics, ['music']); assert.equal(merged.only, true);
  assert.equal(merged.reply, 'Got it: only music.');
  // A clean model answer is kept.
  const good = parseBrief('{"reply":"Only 90s music it is.","topics":["90s music"],"only":true}', cur, 'just 90s music');
  assert.deepEqual(good.topics, ['90s music']); assert.equal(good.reply, 'Only 90s music it is.');
});
test('brief: add, remove, mix and surprise', () => {
  const cur = { topics: ['music'], only: true };
  assert.deepEqual(applyLocally(cur, 'more Eurovision'), { topics: ['music', 'Eurovision'], only: true });
  assert.deepEqual(applyLocally({ topics: ['music', 'football'], only: true }, 'no football'), { topics: ['music'], only: true });
  assert.equal(parseBrief('', cur, 'mostly music, mix it with other stuff').only, false);
  assert.deepEqual(applyLocally(cur, 'surprise me'), { topics: [], only: false });
  assert.ok(briefPrompt(cur, 'more film').includes('CURRENT topics: music'));
  assert.equal(briefSummary(cur), 'Every card: music');
});
test('only-topics: every call says EVERY card, and no off-topic backup top-up', async () => {
  const sys = systemPrompt({ topics: ['music'], only: true });
  assert.ok(/EVERY card in EVERY category must be clearly about them/.test(sys));
  assert.ok(!/about half/.test(sys));
  assert.ok(/about half/.test(systemPrompt({ topics: ['music'], only: false })));
  const users = [];
  // The model returns only 3 valid music cards per category: they must not be padded with backup cards.
  const call = async ({ user }) => {
    users.push(user);
    const cat = /Category: (\w+)/.exec(user)[1];
    return JSON.stringify(cards.filter(c => c.category === cat).slice(0, 3).map(c => ({ ...c, prompt: 'MUSIC ' + c.prompt })));
  };
  const res = await generateDeck({ key: 'k', settings: { topics: ['music'], only: true }, backupCards: cards, call });
  assert.ok(users.every(u => u.includes('(EVERY card must be about these): music')));
  for (const cat of Object.keys(res)) assert.ok(res[cat].every(c => c.prompt.startsWith('MUSIC')), cat);
});
test('generation prompt carries the topics; no topics falls back to a theme nudge', () => {
  const u = userPrompt({ category: 'act', topics: ['90s music', 'football'] });
  assert.ok(u.includes("The group's topics: 90s music; football")); assert.ok(!u.includes('Theme nudge'));
  assert.ok(userPrompt({ category: 'act' }).includes('Theme nudge'));
});
test('generateDeck passes topics through to every call', async () => {
  const seen = [];
  const call = async ({ user }) => { seen.push(user); return '[]'; };
  await generateDeck({ key: 'k', settings: { topics: ['Eurovision'] }, backupCards: cards, call });
  assert.equal(seen.length, 5); assert.ok(seen.every(u => u.includes('Eurovision')));
});
test('friendly API errors', () => {
  assert.match(friendlyError(new LlmError('invalid x-api-key', { status: 401 })), /Key rejected/);
  assert.match(friendlyError(new LlmError('x', { status: 429 })), /Rate limit/);
  assert.match(friendlyError(new LlmError('Your credit balance is too low', { status: 400 })), /credit/);
  assert.match(friendlyError(new LlmError('model: not found', { status: 400 })), /Model not available/);
  assert.match(friendlyError(new LlmError('Network error', { retryable: true })), /reach the API/);
});

// Fake PeerJS to check the host keeps its room code when the server drops it.
class FakePeer {
  static all = [];
  static takenOnce = new Set();
  constructor(id) { this.id = id; this.handlers = {}; this.destroyed = false; this.disconnected = false; FakePeer.all.push(this);
    setTimeout(() => { if (FakePeer.takenOnce.has(id)) { FakePeer.takenOnce.delete(id); this.emit('error', { type: 'unavailable-id' }); } else this.emit('open'); }, 0); }
  on(ev, fn) { this.handlers[ev] = fn; }
  emit(ev, a) { this.handlers[ev] && this.handlers[ev](a); }
  destroy() { this.destroyed = true; }
  reconnect() {}
}
const tick = ms => new Promise(r => setTimeout(r, ms));
test('HostNet: same room code after a server drop; new code only if the first open is refused', async () => {
  globalThis.window = { Peer: FakePeer };
  globalThis.location = { search: '' };
  const nets = [];
  try {
    const net = new HostNet({ onAction() {}, onStatus() {} });
    nets.push(net);
    net.start('ABCD');
    await tick(5);
    assert.equal(net.status, 'waiting');
    // Server drops us; on the retry the old session still holds the id.
    FakePeer.takenOnce.add('spielchen-ABCD');
    const p = net.peer; p.destroyed = true; p.emit('error', { type: 'socket-closed' });
    await tick(2200);       // retry after 2 s → unavailable-id
    await tick(4200);       // next retry after 4 s → open
    assert.equal(net.code, 'ABCD');
    assert.equal(net.status, 'waiting');
    assert.ok(FakePeer.all.every(x => x.id === 'spielchen-ABCD'), FakePeer.all.map(x => x.id).join(','));

    FakePeer.takenOnce.add('spielchen-WXYZ');
    const fresh = new HostNet({ onAction() {}, onStatus() {} });
    nets.push(fresh);
    fresh.start('WXYZ');
    await tick(20);
    assert.notEqual(fresh.code, 'WXYZ');
    assert.equal(fresh.status, 'waiting');
  } finally {
    nets.forEach(n => { clearInterval(n._watch); clearTimeout(n._restart); });
  }
});

await Promise.all(pending);
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
