// Commentary: a short line for the TV after something happens. Pure apart from the rng.
// commentFor(event, before, after, rng) → string | null
//   event: { type: 'card', ok, stealerId, guesserId, finale }
//        | { type: 'special', square }     (pfand, db, burgeramt)
//        | { type: 'allplay', winners }

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
let lastLine = null;

const LINES = {
  streak3: ['{a} is on fire. Three in a row.', '{a}: three for three. Someone stop them.', 'Hat-trick for {a}.'],
  streak4: ['{a} has done it {n} times running. Unreal.', '{n} in a row for {a}. Wahnsinn.'],
  lead: ['{a} takes the lead.', 'New leader: {a}.', '{a} storms to the front.'],
  leadLost: ['{b} loses the lead. Tragisch.', 'And {b} is no longer in front.'],
  db2: ['{a}’s train is cancelled. Again.', 'Deutsche Bahn has a favourite passenger: {a}.', '{a} should really take the bike.'],
  db1: ['Ersatzverkehr for {a}. Enjoy the bus.', '{a} is stuck on the platform. Danke, Deutsche Bahn.', 'Signal failure near {a}. Of course.'],
  steal: ['Daylight robbery by {s}.', '{s} swoops in and steals it.', 'Stolen! {s} says danke.'],
  near: ['{a} can smell the Finale.', '{a} is two steps from glory.', 'Careful, everyone: {a} is close.'],
  comeback: ['Comeback! {a} is out of last place.', 'From last to not-last. Well played, {a}.'],
  failHard: ['That one was Hard. No shame, {a}.', 'Ouch. Back you go, {a}.'],
  burgeramt: ['{a} is waiting for a Termin. Could be a while.'],
  pfand: ['{a} cashes in the Pfand. Big money.'],
  allplay: ['{w} wins the All Play. Alle zusammen, one winner.', 'The table has spoken: {w}.'],
  allplayNone: ['Nobody wins that one. Democracy is hard.'],
};

const nameOf = (s, tokenId) => (s.tokens.find(t => t.id === tokenId) || {}).name || '?';
const playerName = (s, pid) => (s.players.find(p => p.id === pid) || {}).name || '?';

function leader(s) {
  const max = Math.max(...s.tokens.map(t => t.pos));
  if (max === 0) return null;
  const lead = s.tokens.filter(t => t.pos === max);
  return lead.length === 1 ? lead[0].id : null;
}

function lastId(s) {
  const min = Math.min(...s.tokens.map(t => t.pos));
  const last = s.tokens.filter(t => t.pos === min);
  return last.length === 1 ? last[0].id : null;
}

function fill(tpl, vars) { return tpl.replace(/\{(\w)\}/g, (_, k) => vars[k] ?? ''); }

/** Return candidate lines (most interesting first) without choosing one. Exported for tests. */
export function candidates(event, before, after) {
  const out = [];
  const t = before.tokens[before.turnIdx];
  const a = t.name;
  const tAfter = after.tokens.find(x => x.id === t.id);
  const vars = { a };
  const add = (key, extra = {}) => out.push({ key, vars: { ...vars, ...extra } });

  if (event.type === 'card') {
    if (event.stealerId) add('steal', { s: playerName(after, event.stealerId) });
    const n = (after.stats.streak || {})[t.id] || 0;
    if (event.ok && n >= 4) add('streak4', { n: String(n) });
    else if (event.ok && n === 3) add('streak3');
    if (!event.ok && !event.stealerId && before.tokens.length > 1) add('failHard');
  } else if (event.type === 'special') {
    const pid = before.tokens[before.turnIdx].memberIds[before.memberTurn[before.turnIdx] % t.memberIds.length];
    if (event.square === 'db') add(((after.stats.dbVictims || {})[pid] || 0) >= 2 ? 'db2' : 'db1');
    if (event.square === 'burgeramt') add('burgeramt');
    if (event.square === 'pfand') add('pfand');
  } else if (event.type === 'allplay') {
    const ws = (event.winners || []).map(pid => playerName(after, pid));
    if (ws.length) out.push({ key: 'allplay', vars: { w: ws.join(' & ') } });
    else add('allplayNone');
  }

  // Compare with the board at the start of the turn, so the move itself can change the lead.
  const start = { ...before, tokens: before.tokens.map((x, k) => k === before.turnIdx ? { ...x, pos: before.turnStart } : x) };
  const lb = leader(start), la = leader(after);
  if (la && la !== lb) out.push({ key: 'lead', vars: { a: nameOf(after, la) } });
  else if (lb && !la && before.tokens.length > 2) out.push({ key: 'leadLost', vars: { b: nameOf(before, lb) } });

  if (tAfter && tAfter.pos >= 20 && t.pos < 20) add('near');
  const lastB = lastId(before);
  if (lastB === t.id && lastId(after) !== t.id && before.tokens.length > 2 && tAfter.pos > t.pos) add('comeback');
  return out;
}

export function commentFor(event, before, after, rng = Math.random) {
  const cands = candidates(event, before, after);
  // Skip the routine "fail" line most of the time: commentary should feel earned.
  const usable = cands.filter(c => c.key !== 'failHard' || rng() < 0.25);
  for (const c of usable) {
    const opts = LINES[c.key].map(l => fill(l, c.vars)).filter(l => l !== lastLine);
    if (opts.length) { lastLine = pick(opts, rng); return lastLine; }
  }
  return null;
}
