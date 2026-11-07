// Spielchen rules — pure functions only (no DOM, no timers, no randomness unless an rng is passed).
// Every function that "changes" state returns a fresh copy; inputs are never mutated.

export const START = 0;
export const FINALE = 23;
export const BOARD_SIZE = 24;
export const CATEGORIES = ['act', 'draw', 'words', 'brains'];

export const CATEGORY_INFO = {
  act:     { key: 'act',     verb: 'Act',      name: 'Quentin Tarantin-Show', icon: 'drama' },
  draw:    { key: 'draw',    verb: 'Draw',     name: 'Albrecht Doodler',      icon: 'pencil' },
  words:   { key: 'words',   verb: 'Words',    name: 'Goethe Talking',        icon: 'message-circle' },
  brains:  { key: 'brains',  verb: 'Brains',   name: 'Angela Merk-All',       icon: 'lightbulb' },
  allplay: { key: 'allplay', verb: 'All Play', name: 'Alle zusammen',         icon: 'users' },
};

export const SPECIALS = {
  4:  { type: 'pfand',     label: 'Pfand',         icon: 'bottle',      effect: '+2 squares',          tvLine: 'Bottle returned. 25 cents richer.' },
  6:  { type: 'allplay',   label: 'All Play',      icon: 'users',       effect: 'Everyone plays',      tvLine: 'Alle zusammen!' },
  9:  { type: 'db',        label: 'Deutsche Bahn', icon: 'train-front', effect: 'Back 3',              tvLine: 'Your train is cancelled. Ersatzverkehr.' },
  11: { type: 'wild',      label: 'Wild',          icon: 'shuffle',     effect: 'You pick',            tvLine: 'Your choice.' },
  13: { type: 'burgeramt', label: 'Bürgeramt',     icon: 'stamp',       effect: 'Skip next turn',      tvLine: 'No Termin? Come back next turn.' },
  15: { type: 'allplay',   label: 'All Play',      icon: 'users',       effect: 'Everyone plays',      tvLine: 'Alle zusammen!' },
  19: { type: 'db',        label: 'Deutsche Bahn', icon: 'train-front', effect: 'Back 3',              tvLine: 'Your train is cancelled. Ersatzverkehr.' },
  20: { type: 'wild',      label: 'Wild',          icon: 'shuffle',     effect: 'You pick',            tvLine: 'Your choice.' },
  23: { type: 'finale',    label: 'Finale',        icon: 'trophy',      effect: 'Hard card, others pick', tvLine: 'Final challenge.' },
};

function buildBoard() {
  const squares = [];
  let c = 0;
  for (let i = 0; i < BOARD_SIZE; i++) {
    if (i === START) {
      squares.push({ i, type: 'start', label: 'Start', icon: 'flag' });
    } else if (SPECIALS[i]) {
      squares.push({ i, ...SPECIALS[i] });
    } else {
      const category = CATEGORIES[c % 4];
      c++;
      squares.push({ i, type: 'colour', category, label: CATEGORY_INFO[category].verb, icon: CATEGORY_INFO[category].icon });
    }
  }
  return squares;
}

export const BOARD = buildBoard();

/** Snake layout on a 10-column grid: 3 rows, Start and Finale double-width. */
export function squareLayout(i) {
  if (i === START) return { row: 0, col: 0, span: 2 };
  if (i <= 7) return { row: 0, col: i + 1, span: 1 };        // 1..7  → cols 2..8
  if (i <= 15) return { row: 1, col: 8 - (i - 8), span: 1 }; // 8..15 → cols 8..1
  if (i <= 22) return { row: 2, col: i - 15, span: 1 };      // 16..22 → cols 1..7
  return { row: 2, col: 8, span: 2 };                        // Finale → cols 8..9
}

// ---------- helpers ----------

export function clone(x) { return JSON.parse(JSON.stringify(x)); }

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function rollDie(rng = Math.random) { return 1 + Math.floor(rng() * 4); }

export function clampPos(p) { return Math.max(START, Math.min(FINALE, p)); }

export function teamsAllowed(n) { return n === 4 || n === 6; }

/** Random pairs of player ids. */
export function makeTeams(playerIds, rng = Math.random) {
  const s = shuffle(playerIds, rng);
  const teams = [];
  for (let i = 0; i < s.length; i += 2) teams.push([s[i], s[i + 1]]);
  return teams;
}

const TEAM_NAMES = ['Team Brezel', 'Team Späti', 'Team Pfand'];

// ---------- game ----------

/**
 * players: [{id, name, color, emoji}]
 * teams: array of [playerId, playerId] or null for free-for-all
 */
export function createGame({ players, teams = null }) {
  const teamMode = !!teams && teamsAllowed(players.length);
  const byId = Object.fromEntries(players.map(p => [p.id, p]));
  const tokens = teamMode
    ? teams.map((pair, k) => ({
        id: 't' + k,
        name: TEAM_NAMES[k] || 'Team ' + (k + 1),
        color: byId[pair[0]].color,
        emoji: byId[pair[0]].emoji,
        memberIds: pair.slice(),
        pos: START,
        skipNext: false,
      }))
    : players.map(p => ({ id: 't' + p.id, name: p.name, color: p.color, emoji: p.emoji, memberIds: [p.id], pos: START, skipNext: false }));
  return {
    players: clone(players),
    teamMode,
    tokens,
    turnIdx: 0,
    memberTurn: tokens.map(() => 0),
    turnStart: START,
    turnCount: 0,
    lastOrders: null,          // turns left once Last Orders is called
    lastOrdersPending: false,  // true when called mid-turn (that turn doesn't count)
    winnerId: null,            // token id of a Finale winner
    stats: { dbVictims: {}, steals: {}, fastest: null, streak: {}, bestStreak: null },
  };
}

export function activeToken(s) { return s.tokens[s.turnIdx]; }

export function activePlayerId(s) {
  const t = activeToken(s);
  return t.memberIds[s.memberTurn[s.turnIdx] % t.memberIds.length];
}

export function playerById(s, pid) { return s.players.find(p => p.id === pid); }

export function tokenOfPlayer(s, pid) { return s.tokens.find(t => t.memberIds.includes(pid)); }

/** Players who may be picked as guesser (FFA) / stealer (teams): everyone outside the active token. */
export function otherPlayers(s) {
  const t = activeToken(s);
  return s.players.filter(p => !t.memberIds.includes(p.id));
}

/** In team mode, the teammate who guesses. */
export function teammateId(s) {
  const t = activeToken(s);
  const me = activePlayerId(s);
  return t.memberIds.find(id => id !== me) || null;
}

function setPos(s, tokenId, pos, moves) {
  const t = s.tokens.find(x => x.id === tokenId);
  const from = t.pos;
  t.pos = clampPos(pos);
  if (t.pos !== from) moves.push({ tokenId, from, to: t.pos });
}

/**
 * Start of a turn: handles a pending Bürgeramt skip.
 * Returns { state, skipped }. If skipped, the turn has already been ended.
 */
export function beginTurn(state) {
  const s = clone(state);
  const t = activeToken(s);
  s.turnStart = t.pos;
  if (t.skipNext) {
    t.skipNext = false;
    return { state: endTurn(s), skipped: true, skippedTokenId: t.id };
  }
  return { state: s, skipped: false };
}

/** Does the active token start on the Finale (reached via a bonus move)? Then it plays the Finale without rolling. */
export function needsFinaleWithoutRoll(s) { return activeToken(s).pos === FINALE && !s.winnerId; }

/** Roll result applied: token moves forward. Returns { state, from, to, square }. */
export function moveActive(state, die) {
  const s = clone(state);
  const t = activeToken(s);
  s.turnStart = t.pos;
  const from = t.pos;
  t.pos = clampPos(t.pos + die);
  return { state: s, from, to: t.pos, square: BOARD[t.pos] };
}

/**
 * Apply an instant special square (pfand, db, burgeramt) to the active token.
 * Returns { state, moves }. These end the turn (the caller calls endTurn).
 * Bonus moves never trigger further specials.
 */
export function applySpecial(state, type) {
  const s = clone(state);
  const t = activeToken(s);
  const moves = [];
  if (type === 'pfand') setPos(s, t.id, t.pos + 2, moves);
  else if (type === 'db') {
    setPos(s, t.id, t.pos - 3, moves);
    const pid = activePlayerId(s);
    s.stats.dbVictims[pid] = (s.stats.dbVictims[pid] || 0) + 1;
  } else if (type === 'burgeramt') t.skipNext = true;
  return { state: s, moves };
}

/**
 * Resolve a colour/wild/finale card.
 * result: { ok, hard, finale, guesserId (FFA only), stealerId (teams only, on fail), elapsedMs }
 * Returns { state, moves, won }.
 */
export function applyCardResult(state, { ok, hard = false, finale = false, guesserId = null, stealerId = null, elapsedMs = null }) {
  const s = clone(state);
  const t = activeToken(s);
  const moves = [];
  let won = false;
  s.stats.streak[t.id] = ok ? (s.stats.streak[t.id] || 0) + 1 : 0;
  if (ok && (!s.stats.bestStreak || s.stats.streak[t.id] > s.stats.bestStreak.n)) s.stats.bestStreak = { tokenId: t.id, n: s.stats.streak[t.id] };
  if (ok) {
    if (finale) {
      s.winnerId = t.id;
      won = true;
    } else if (hard) {
      setPos(s, t.id, t.pos + 1, moves);
    }
    if (!s.teamMode && guesserId) {
      const g = tokenOfPlayer(s, guesserId);
      if (g && g.id !== t.id && !won) setPos(s, g.id, g.pos + 1, moves);
    }
    if (elapsedMs != null) {
      const who = s.teamMode ? (teammateId(s) || activePlayerId(s)) : (guesserId || activePlayerId(s));
      if (!s.stats.fastest || elapsedMs < s.stats.fastest.ms) s.stats.fastest = { playerId: who, ms: elapsedMs };
    }
  } else {
    if (finale) setPos(s, t.id, t.pos - 3, moves);
    else setPos(s, t.id, s.turnStart, moves);
    if (stealerId) {
      const st = tokenOfPlayer(s, stealerId);
      if (st && st.id !== t.id) {
        setPos(s, st.id, st.pos + 1, moves);
        s.stats.steals[stealerId] = (s.stats.steals[stealerId] || 0) + 1;
      }
    }
  }
  return { state: s, moves, won };
}

/**
 * All Play: each winner's token (their team's in team mode) moves +2, once per token.
 * winners: a player id, an array of player ids (ties), or null/[] for nobody.
 */
export function applyAllPlayResult(state, winners) {
  const s = clone(state);
  const moves = [];
  const ids = Array.isArray(winners) ? winners : (winners ? [winners] : []);
  const done = new Set();
  for (const pid of ids) {
    const t = tokenOfPlayer(s, pid);
    if (t && !done.has(t.id)) { done.add(t.id); setPos(s, t.id, t.pos + 2, moves); }
  }
  return { state: s, moves };
}

/**
 * Brains quizmaster: holds the answer and judges, so it is never the active player or their teammate.
 * Free-for-all: the previous player (to the right). Teams: a member of the next team, rotating.
 */
export function quizmasterId(s) {
  const n = s.tokens.length;
  if (!s.teamMode) {
    const prev = s.tokens[(s.turnIdx - 1 + n) % n];
    return prev.memberIds[0];
  }
  const other = s.tokens[(s.turnIdx + 1) % n];
  return other.memberIds[Math.floor(s.turnCount / n) % other.memberIds.length];
}

/** The single token in the lead, or null when tied (or nobody has moved). */
export function leaderId(s) {
  const max = Math.max(...s.tokens.map(t => t.pos));
  if (max === 0) return null;
  const lead = s.tokens.filter(t => t.pos === max);
  return lead.length === 1 ? lead[0].id : null;
}

/** Pass the turn clockwise. In team mode teams alternate and members rotate. */
export function endTurn(state) {
  const s = clone(state);
  s.memberTurn[s.turnIdx] += 1;
  s.turnIdx = (s.turnIdx + 1) % s.tokens.length;
  s.turnCount += 1;
  if (s.lastOrdersPending) s.lastOrdersPending = false;
  else if (s.lastOrders != null) s.lastOrders = Math.max(0, s.lastOrders - 1);
  s.turnStart = activeToken(s).pos;
  return s;
}

/** Call Last Orders: every player gets exactly one more turn. midTurn = a turn is in progress (it won't count). */
export function callLastOrders(state, midTurn) {
  if (state.lastOrders != null) return state;
  const s = clone(state);
  s.lastOrders = s.players.length;
  s.lastOrdersPending = !!midTurn;
  return s;
}

export function lastOrdersAtMs(lengthMs) { return Math.round(lengthMs * 5 / 6); }

/** Tokens sorted furthest first (Finale winner always first). */
export function ranking(s) {
  return s.tokens.slice().sort((a, b) => {
    if (a.id === s.winnerId) return -1;
    if (b.id === s.winnerId) return 1;
    return b.pos - a.pos;
  });
}

/** Tokens tied for the lead (only relevant when there's no Finale winner). */
export function leaders(s) {
  const max = Math.max(...s.tokens.map(t => t.pos));
  return s.tokens.filter(t => t.pos === max);
}

/** Should the game end now (checked between turns)? */
export function isOver(s, timeUp) {
  return !!s.winnerId || s.lastOrders === 0 || !!timeUp;
}

/** Decide the winner when the game is over. Returns { winnerId } or { suddenDeath: [tokenIds] }. */
export function decideWinner(s) {
  if (s.winnerId) return { winnerId: s.winnerId };
  const lead = leaders(s);
  if (lead.length === 1) return { winnerId: lead[0].id };
  return { suddenDeath: lead.map(t => t.id) };
}

/** Pick the 3 auto-stats for the winner screen. */
export function autoStats(s) {
  const name = pid => (playerById(s, pid) || {}).name || '?';
  const top = obj => {
    const e = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    return e.length ? { playerId: e[0][0], n: e[0][1] } : null;
  };
  const out = [];
  if (s.stats.fastest) out.push({ label: 'Fastest guess', value: name(s.stats.fastest.playerId), detail: (s.stats.fastest.ms / 1000).toFixed(1) + ' s' });
  else out.push({ label: 'Fastest guess', value: '—', detail: 'nobody guessed anything' });
  const st = top(s.stats.steals);
  out.push(st ? { label: 'Most steals', value: name(st.playerId), detail: st.n + (st.n === 1 ? ' steal' : ' steals') } : { label: 'Most steals', value: '—', detail: 'honest bunch' });
  const db = top(s.stats.dbVictims);
  out.push(db ? { label: 'Most Deutsche Bahn victims', value: name(db.playerId), detail: db.n + (db.n === 1 ? ' cancelled train' : ' cancelled trains') } : { label: 'Most Deutsche Bahn victims', value: '—', detail: 'the trains ran on time?!' });
  const bs = s.stats.bestStreak;
  const bt = bs && s.tokens.find(t => t.id === bs.tokenId);
  out.push(bs && bs.n >= 2 ? { label: 'Longest streak', value: bt.name, detail: bs.n + ' in a row' } : { label: 'Longest streak', value: '—', detail: 'nobody got on a roll' });
  return out;
}
