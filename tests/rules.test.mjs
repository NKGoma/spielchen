// Run: node tests/rules.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as R from '../js/rules.js';
import { validateCard, Deck, GAMES_BY_CATEGORY } from '../js/deck.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
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
  assert.equal(st.length, 3); assert.equal(st[0].value, 'P2');
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

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
