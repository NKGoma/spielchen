// Spielchen TV / host: state machine, rendering, keyboard (hot-seat) controls.
import * as R from './rules.js';
import { Deck, MINI_GAMES, loadBackupDeck } from './deck.js';
import { sfx } from './sfx.js';

// ---------- utilities ----------
const $ = sel => document.querySelector(sel);
const wait = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const icon = (name, cls = '') => `<i data-lucide="${name}" class="ic ${cls}"></i>`;
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

function drawIcons() {
  if (window.lucide && window.lucide.createIcons) {
    try { window.lucide.createIcons({ attrs: { 'stroke-width': 2 } }); } catch { /* ignore */ }
  }
}

const TOKEN_COLORS = ['#FF8A3D', '#A78BFA', '#22D3EE', '#F87171', '#A3E635', '#F4F1EA'];
const EMOJIS = ['🦊', '🐙', '🦉', '🐸', '🦄', '🐻', '🥨', '🍺', '🚲', '🌭', '🎸', '🐝'];
const PENALTIES = [
  'Announce the next game like a Tagesschau newsreader.',
  'Fetch everyone a drink, narrating it like a nature documentary.',
  'Give a 20-second victory speech for the winner, in your most dramatic voice.',
  'Explain the rules of Pfand to the group as if it were a TED talk.',
  'Sing the first line of any song as a Deutsche Bahn station announcement.',
  'Do a slow-motion replay of your worst moment of the game.',
];

// ---------- board geometry (1920×1080 stage) ----------
const SQ = 120, PITCH = 168, ROWP = 232, LEFT = 144, TOP = 236;
function squareRect(i) {
  const { row, col, span } = R.squareLayout(i);
  return { x: LEFT + col * PITCH, y: TOP + row * ROWP, w: span === 2 ? PITCH + SQ : SQ, h: SQ };
}

// ---------- store ----------
const defaultPlayers = () => [0, 1, 2].map(k => ({ id: 'p' + (k + 1), name: '', color: TOKEN_COLORS[k], emoji: EMOJIS[k] }));

const store = {
  screen: 'setup',            // setup | howto | board | winner
  settings: Object.assign({ lengthMin: 30, sound: true }, lsGet('spielchen.settings', {})),
  settingsOpen: false,
  hotseat: true,
  setup: { players: lsGet('spielchen.players', null) || defaultPlayers(), teamMode: true, teams: null },
  backupCards: [],
  game: null,
  deck: null,
  phase: 'idle',
  busy: false,
  card: null,
  ctx: null,                  // current card context
  die: null,
  rolling: false,
  displayPos: {},
  clock: null,                // { startedAt, lengthMs, lastOrdersAt }
  timeUp: false,
  lastOrdersBanner: false,
  undo: [],
  debugBuf: null,
  revealTimer: null,
  timer: null,                // { endsAt, seconds, startedAt, lastTick }
  result: null,               // winner screen data
  seenGames: new Set(),
  toast: null,
};

sfx.setMuted(!store.settings.sound);

function saveSettings() { lsSet('spielchen.settings', store.settings); sfx.setMuted(!store.settings.sound); }

// ---------- names ----------
const P = pid => store.game ? R.playerById(store.game, pid) : store.setup.players.find(p => p.id === pid);
const pname = pid => (P(pid) || {}).name || '?';
const activePid = () => R.activePlayerId(store.game);
const activeTok = () => R.activeToken(store.game);

// ---------- rendering ----------
function render() {
  const app = $('#screen');
  if (store.screen === 'setup') app.innerHTML = renderSetup();
  else if (store.screen === 'howto') app.innerHTML = renderHowTo();
  else if (store.screen === 'winner') app.innerHTML = renderWinner();
  else if (store.screen === 'board') {
    if (!app.querySelector('.board-screen')) app.innerHTML = renderBoardShell();
    renderBoardDynamic();
  }
  renderTopbar();
  renderOverlay();
  renderSettings();
  drawIcons();
}

function logoHtml(size = '') {
  return `<div class="logo ${size}" aria-label="spielchen">sp<span class="i-wrap">ı<span class="i-dot"></span></span>elchen</div>`;
}

function renderTopbar() {
  const bar = $('#topbar');
  const g = store.game;
  const showClock = store.screen === 'board' && store.clock;
  bar.innerHTML = `
    <div class="tb-left">${store.screen === 'board' ? logoHtml('small') : ''}</div>
    <div class="tb-right">
      <span class="pill" title="Fresh cards arrive in Milestone 3">${icon('layers')} cards: backup deck</span>
      <span class="pill ${store.hotseat ? 'on' : ''}">${icon('laptop')} Hot-seat ${store.hotseat ? 'on' : 'off'} <kbd>H</kbd></span>
      ${g && store.screen === 'board' && g.lastOrders != null ? `<span class="pill alert">Last orders · ${g.lastOrders} turn${g.lastOrders === 1 ? '' : 's'} left</span>` : ''}
      ${showClock ? `<span class="clock" id="clock">${fmtClock()}</span>` : ''}
      <button class="gear" data-act="settings" aria-label="Settings">${icon('settings')}</button>
    </div>`;
}

function fmtClock() {
  if (!store.clock) return '';
  const left = Math.max(0, store.clock.lengthMs - (Date.now() - store.clock.startedAt));
  const s = Math.ceil(left / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderSetup() {
  const ps = store.setup.players;
  const n = ps.length;
  const teamsOk = R.teamsAllowed(n);
  const teamMode = teamsOk && store.setup.teamMode;
  if (teamMode && (!store.setup.teams || store.setup.teams.flat().length !== n || !store.setup.teams.flat().every(id => ps.some(p => p.id === id)))) {
    store.setup.teams = R.makeTeams(ps.map(p => p.id));
  }
  const rows = ps.map((p, k) => `
    <div class="prow">
      <button class="tok-btn" style="--c:${p.color}" data-act="color" data-k="${k}" aria-label="Change colour">${p.emoji}</button>
      <button class="emoji-btn" data-act="emoji" data-k="${k}" aria-label="Change emoji">${icon('smile-plus')}</button>
      <input class="name" data-k="${k}" maxlength="14" placeholder="Player ${k + 1}" value="${esc(p.name)}" autocomplete="off" spellcheck="false">
      ${n > 2 ? `<button class="x-btn" data-act="remove" data-k="${k}" aria-label="Remove player">${icon('x')}</button>` : '<span class="x-gap"></span>'}
    </div>`).join('');
  const teamsHtml = teamMode ? `<div class="teams">${store.setup.teams.map((pair, t) => `
      <div class="team"><span class="team-name">Team ${t + 1}</span>${pair.map(id => {
        const p = ps.find(x => x.id === id);
        return `<span class="chip" style="--c:${p.color}"><span class="chip-tok">${p.emoji}</span>${esc(p.name || 'Player ' + (ps.indexOf(p) + 1))}</span>`;
      }).join('')}</div>`).join('')}
      <button class="btn ghost" data-act="reshuffle">${icon('shuffle')} Reshuffle teams</button></div>` : '';
  return `
  <div class="setup">
    <div class="setup-left">
      ${logoHtml('big')}
      <p class="tagline">Roll. Land on a colour. Do the challenge. 30 minutes, tops.</p>
      <div class="players">${rows}</div>
      <div class="setup-actions">
        ${n < 6 ? `<button class="btn ghost" data-act="add">${icon('user-plus')} Add player</button>` : ''}
        ${teamsOk ? `<label class="toggle"><input type="checkbox" data-act="teams" ${store.setup.teamMode ? 'checked' : ''}><span class="sw"></span> Teams of 2</label>` : '<span class="muted small">Teams are available with 4 or 6 players.</span>'}
      </div>
      ${teamsHtml}
    </div>
    <div class="setup-right">
      <div class="qr-placeholder">
        <div class="qr-box">${icon('smartphone', 'big-ic')}</div>
        <p>Phone remote arrives in Milestone 2.</p>
        <p class="muted">For now: hot-seat on this laptop. Space, Y, N and 1–6 do everything.</p>
      </div>
      <button class="btn primary huge" data-act="start">Start <kbd>Enter</kbd></button>
      <p class="muted small">Game length: ${store.settings.lengthMin === 2 ? '2 min (test)' : store.settings.lengthMin + ' min'} · change it in Settings ${icon('settings')}</p>
    </div>
  </div>`;
}

function renderHowTo() {
  const tiles = R.CATEGORIES.map(c => {
    const info = R.CATEGORY_INFO[c];
    return `<div class="tile cat-${c}">${icon(info.icon, 'tile-ic')}<div class="tile-verb">${info.verb}</div><div class="tile-name">${info.name}</div></div>`;
  }).join('');
  return `
  <div class="howto">
    <h1>How to play</h1>
    <p class="howto-line">Roll. Land on a colour. Do the challenge.<br>Get it guessed, stay. Fail, go back.</p>
    <div class="tiles">${tiles}</div>
    <p class="muted">First to clear the Finale wins — or whoever's furthest when the clock runs out.</p>
    <button class="btn primary" data-act="skip-howto">Let's go <kbd>Space</kbd></button>
    <div class="howto-bar"><span id="howto-fill"></span></div>
  </div>`;
}

function renderBoardShell() {
  const squares = R.BOARD.map(sq => {
    const r = squareRect(sq.i);
    const cls = sq.type === 'colour' ? `sq colour cat-${sq.category}` : `sq special sp-${sq.type}`;
    return `<div class="${cls}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px">
      <span class="sq-num">${sq.i}</span>${icon(sq.icon, 'sq-ic')}<span class="sq-label">${esc(sq.label)}</span></div>`;
  }).join('');
  const pts = R.BOARD.map(sq => { const r = squareRect(sq.i); return `${r.x + r.w / 2},${r.y + r.h / 2}`; }).join(' ');
  return `
  <div class="board-screen">
    <svg class="path" width="1920" height="1080" aria-hidden="true"><polyline points="${pts}" /></svg>
    <div class="squares">${squares}</div>
    <div id="tokens"></div>
    <div class="turn-banner" id="banner"></div>
    <div class="chips" id="chips"></div>
  </div>`;
}

function renderBoardDynamic() {
  renderTokens();
  const g = store.game;
  const banner = $('#banner');
  if (banner) {
    let html = '';
    if (g && store.phase === 'pass') {
      const t = activeTok();
      const p = P(activePid());
      const mate = g.teamMode ? R.teammateId(g) : null;
      html = `<span class="banner-tok" style="--c:${p.color}">${p.emoji}</span>
        <span><b>${esc(p.name)}'s turn</b>${mate ? ` · ${esc(pname(mate))} guesses` : ''}${g.teamMode ? ` <span class="muted">(${esc(t.name)})</span>` : ''}</span>
        <span class="banner-key">${R.needsFinaleWithoutRoll(g) ? 'Space for the Finale' : 'Space to roll'}</span>`;
    } else if (g && (store.phase === 'rolling' || store.phase === 'moving') ) {
      html = `<span class="die ${store.rolling ? 'tumble' : ''}" id="die">${store.die ?? ''}</span><span><b>${esc(pname(activePid()))}</b> ${store.rolling ? 'rolls…' : 'rolled ' + store.die}</span>`;
    }
    banner.innerHTML = html;
    banner.classList.toggle('show', !!html);
  }
  const chips = $('#chips');
  if (chips && g) {
    chips.innerHTML = g.tokens.map((t, k) => {
      const active = k === g.turnIdx;
      const members = g.teamMode ? `<span class="chip-sub">${t.memberIds.map(pname).map(esc).join(' + ')}</span>` : '';
      return `<div class="pchip ${active ? 'active' : ''}" style="--c:${t.color}">
        <span class="chip-tok">${t.emoji}</span><span class="chip-name">${esc(t.name)}${members}</span>
        <span class="chip-pos">${t.pos === R.FINALE ? '🏁' : t.pos}</span>${t.skipNext ? `<span class="chip-skip">${icon('stamp')}</span>` : ''}</div>`;
    }).join('');
  }
}

function renderTokens() {
  const layer = $('#tokens');
  if (!layer || !store.game) return;
  const toks = store.game.tokens;
  const groups = {};
  toks.forEach(t => { const p = store.displayPos[t.id] ?? t.pos; (groups[p] = groups[p] || []).push(t.id); });
  for (const t of toks) {
    let el = layer.querySelector(`[data-id="${t.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'token';
      el.dataset.id = t.id;
      el.style.setProperty('--c', t.color);
      el.innerHTML = `<span>${t.emoji}</span>`;
      layer.appendChild(el);
    }
    const pos = store.displayPos[t.id] ?? t.pos;
    const grp = groups[pos];
    const k = grp.indexOf(t.id);
    const r = squareRect(pos);
    const offs = [[0, 0], [26, 18], [-26, 18], [26, -18], [-26, -18], [0, 30]];
    const [ox, oy] = grp.length > 1 ? offs[k] : [0, 0];
    const x = r.x + r.w / 2 - 28 + ox;
    const y = r.y - 30 + oy;
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.classList.toggle('active', store.game.tokens[store.game.turnIdx].id === t.id);
  }
}

function catTag(cat) {
  const info = R.CATEGORY_INFO[cat];
  return `<div class="cat-tag">${icon(info.icon)} <span>${info.verb}</span> <span class="cat-name">· ${info.name}</span></div>`;
}

function diffDots(d) {
  const n = { easy: 1, medium: 2, hard: 3 }[d] || 1;
  return `<div class="diff">${[1, 2, 3].map(k => `<span class="dot ${k <= n ? 'on' : ''}"></span>`).join('')}<span>${d[0].toUpperCase() + d.slice(1)}</span></div>`;
}

function chipPicker(pids, { nobody = false } = {}) {
  const all = store.game.players;
  return `<div class="pick-chips">${pids.map(pid => {
    const p = P(pid); const num = all.findIndex(x => x.id === pid) + 1;
    return `<button class="pick-chip" style="--c:${p.color}" data-act="pick-player" data-pid="${pid}"><kbd>${num}</kbd><span class="chip-tok">${p.emoji}</span>${esc(p.name)}</button>`;
  }).join('')}${nobody ? `<button class="pick-chip nobody" data-act="pick-player" data-pid=""><kbd>0</kbd>Nobody</button>` : ''}</div>`;
}

function timerRing(seconds) {
  return `<div class="ring-wrap"><svg class="ring" viewBox="0 0 200 200"><circle class="ring-bg" cx="100" cy="100" r="88"/><circle class="ring-fg" id="ring-fg" cx="100" cy="100" r="88"/></svg><div class="ring-num" id="ring-num">${seconds}</div></div>`;
}

function renderOverlay() {
  const ov = $('#overlay');
  const html = overlayHtml();
  if (!html) { ov.innerHTML = ''; ov.className = ''; return; }
  ov.className = 'show';
  ov.innerHTML = html;
  if (store.ctx && !store.ctx.washed && ov.querySelector('.ov-cat')) {
    ov.querySelector('.ov-cat').classList.add('wash');
    store.ctx.washed = true;
  }
  updateTimerUi();
}

function overlayHtml() {
  const ph = store.phase;
  const g = store.game;
  if (store.screen !== 'board' || !g) return '';
  const ctx = store.ctx;
  if (ph === 'special' || ph === 'skipped') {
    const sq = ctx.square;
    return `<div class="ov ov-special sp-${sq.type}"><div class="ov-inner">
      ${icon(sq.icon, 'special-ic')}<div class="special-label">${esc(sq.label)}</div>
      <div class="special-line">${esc(ph === 'skipped' ? `${pname(ctx.pid)} skips this turn. No Termin.` : sq.tvLine)}</div>
      <div class="special-effect muted">${esc(sq.effect)}</div></div></div>`;
  }
  if (ph === 'pick') {
    const tiles = R.CATEGORIES.map((c, k) => {
      const info = R.CATEGORY_INFO[c];
      return `<button class="tile cat-${c}" data-act="pick-cat" data-cat="${c}"><kbd>${k + 1}</kbd>${icon(info.icon, 'tile-ic')}<div class="tile-verb">${info.verb}</div><div class="tile-name">${info.name}</div></button>`;
    }).join('');
    const title = ctx.finale
      ? `Final challenge for ${esc(pname(activePid()))}!`
      : `${esc(pname(activePid()))}, your choice.`;
    const sub = ctx.finale ? 'Everyone else picks the category. The card will be Hard. Clear it and win.' : 'Pick a category.';
    return `<div class="ov ov-pick"><div class="ov-inner"><h2>${title}</h2><p class="muted">${sub}</p><div class="tiles">${tiles}</div></div></div>`;
  }
  if (ph === 'reveal') return revealHtml();
  if (ctx && ctx.allplay && ph.startsWith('ap-')) return allPlayHtml();
  if (ctx && ctx.card && ['card-hidden', 'card-ready', 'running', 'timeup', 'guesser', 'steal'].includes(ph)) return cardHtml();
  return '';
}

function cardHtml() {
  const { card, finale, sudden } = store.ctx;
  const ph = store.phase;
  const g = store.game;
  const mg = MINI_GAMES[card.game];
  const brains = card.category === 'brains';
  const name = esc(pname(activePid()));
  let action = '';
  if (ph === 'card-hidden') {
    action = sudden
      ? `<div class="big-line">Sudden death: ${esc(sudden.names)}</div><div class="hint-line">Tied players look away. Someone else is the reader: press <kbd>Space</kbd> to peek (6 s).</div>`
      : `<div class="big-line">Everyone except ${name}, look away</div><div class="hint-line">${name}: press <kbd>Space</kbd> to peek at the card (6 s).</div>`;
  } else if (ph === 'card-ready') {
    action = `<div class="hint-line"><kbd>Space</kbd> start the ${mg.seconds} s timer · <kbd>P</kbd> peek again</div>`;
  } else if (ph === 'running' || ph === 'timeup') {
    action = `${timerRing(mg.seconds)}<div class="hint-line">${ph === 'timeup' ? '<b>Time!</b> ' : ''}<kbd>Y</kbd> ${brains ? 'Correct' : 'Got it'} · <kbd>N</kbd> ${brains ? 'Wrong' : 'Failed'}</div>`;
  } else if (ph === 'guesser') {
    const pids = sudden ? sudden.pids : R.otherPlayers(g).map(p => p.id);
    action = `<div class="big-line">${sudden ? 'Who shouted it first?' : 'Who guessed first?'}</div>${chipPicker(pids)}<div class="hint-line"><kbd>Esc</kbd> back</div>`;
  } else if (ph === 'steal') {
    action = `<div class="big-line">Another team gets one guess. Did they steal it?</div>${chipPicker(R.otherPlayers(g).map(p => p.id), { nobody: true })}`;
  }
  return `<div class="ov ov-cat cat-${card.category}"><div class="ov-inner">
    ${catTag(card.category)}
    ${finale ? '<div class="finale-tag">Final challenge</div>' : ''}
    <div class="game-name">${esc(mg.name)}</div>
    <div class="game-rule">${esc(mg.rule)}</div>
    ${diffDots(card.difficulty)}
    <div class="ov-action">${action}</div>
  </div></div>`;
}

/** The ONLY place a secret card is rendered on the TV (hot-seat privacy step). */
function revealHtml() {
  const c = store.ctx.card;
  const mg = MINI_GAMES[c.game];
  const rows = [];
  if (c.accent) rows.push(`<div class="rv-row"><span class="rv-k">Accent</span>${esc(c.accent)}</div>`);
  if (c.forbidden) rows.push(`<div class="rv-row"><span class="rv-k">Forbidden</span>${c.forbidden.map(esc).join(' · ')}</div>`);
  if (c.options) rows.push(`<div class="rv-row"><span class="rv-k">Options</span>${c.options.map(esc).join(' · ')}</div>`);
  if (c.answer != null) rows.push(`<div class="rv-row"><span class="rv-k">${c.game === 'hum' ? 'Artist' : 'Answer'}</span>${esc(c.answer)}${c.tolerance != null ? ` <span class="muted">(± ${esc(c.tolerance)} counts)</span>` : ''}</div>`);
  if (c.hint_en) rows.push(`<div class="rv-row hint"><span class="rv-k">For non-Germans</span>${esc(c.hint_en)}</div>`);
  const who = store.ctx.sudden ? 'Reader only' : `${esc(pname(activePid()))} only`;
  return `<div class="ov ov-reveal cat-${c.category}"><div class="ov-inner">
    <div class="rv-who">${icon('eye')} ${who} · ${esc(mg.name)}</div>
    <div class="rv-prompt" id="secret">${esc(c.prompt)}</div>
    ${rows.join('')}
    <div class="rv-bar"><span id="rv-fill"></span></div>
    <div class="hint-line"><kbd>Space</kbd> hide now</div>
  </div></div>`;
}

function allPlayHtml() {
  const { card } = store.ctx;
  const ph = store.phase;
  const mg = MINI_GAMES[card.game];
  const g = store.game;
  let body = `<div class="ap-prompt">${esc(card.prompt)}</div>`;
  if (card.game === 'speedround') {
    body += `<ol class="ap-qs">${card.questions.map(q => `<li>${esc(q.q)}${ph === 'ap-pick' ? ` <span class="ap-a">${esc(q.a)}</span>` : ''}</li>`).join('')}</ol>`;
  }
  if (card.game === 'estimateoff' && ph === 'ap-pick') body += `<div class="ap-answer">Answer: <b>${esc(card.answer)}</b></div>`;
  if (card.hint_en) body += `<div class="ap-hint muted">${esc(card.hint_en)}</div>`;
  let action = '';
  if (ph === 'ap-ready') action = `<div class="hint-line"><kbd>Space</kbd> start the ${mg.seconds} s timer</div>`;
  else if (ph === 'ap-running') action = `${timerRing(mg.seconds)}<div class="hint-line"><kbd>Space</kbd> stop early</div>`;
  else if (ph === 'ap-pick') action = `<div class="big-line">Who won? +2 squares${g.teamMode ? ' for their team' : ''}</div>${chipPicker(g.players.map(p => p.id), { nobody: true })}`;
  return `<div class="ov ov-allplay"><div class="ov-inner">
    <div class="cat-tag">${icon('users')} <span>All Play</span> <span class="cat-name">· Alle zusammen!</span></div>
    <div class="game-name">${esc(mg.name)}</div>
    <div class="game-rule">${esc(mg.rule)}</div>
    ${body}
    <div class="ov-action">${action}</div>
  </div></div>`;
}

function renderWinner() {
  const res = store.result;
  if (!res) return '';
  const g = store.game;
  const rank = res.ranking;
  const order = [rank[1], rank[0], rank[2]].filter(Boolean);
  const podium = order.map(t => {
    const place = rank.indexOf(t) + 1;
    const members = g.teamMode ? `<div class="pod-sub">${t.memberIds.map(pname).map(esc).join(' + ')}</div>` : '';
    return `<div class="pod place-${place}" style="--c:${t.color}"><div class="pod-tok">${t.emoji}</div><div class="pod-name">${esc(t.name)}</div>${members}<div class="pod-block">${place}</div></div>`;
  }).join('');
  const stats = res.stats.map(s => `<div class="stat"><div class="stat-label">${esc(s.label)}</div><div class="stat-value">${esc(s.value)}</div><div class="stat-detail muted">${esc(s.detail)}</div></div>`).join('');
  return `
  <div class="winner">
    <div class="confetti" id="confetti"></div>
    <h1>${esc(rank[0].name)} win${g.teamMode ? '' : 's'}!</h1>
    <p class="muted">${esc(res.reason)}</p>
    <div class="podium">${podium}</div>
    <div class="stats">${stats}</div>
    <div class="penalty"><div class="pen-label">${icon('gavel')} Penalty for ${esc(res.last.name)}</div><div class="pen-text">${esc(res.penalty)}</div></div>
    <div class="win-actions">
      <button class="btn primary" data-act="rematch">Rematch <kbd>R</kbd></button>
      <button class="btn ghost" data-act="newgame">New game <kbd>N</kbd></button>
    </div>
  </div>`;
}

function renderSettings() {
  const el = $('#settings');
  if (!store.settingsOpen) { el.className = ''; el.innerHTML = ''; return; }
  const s = store.settings;
  el.className = 'show';
  el.innerHTML = `<div class="settings-card">
    <h2>Settings</h2>
    <label class="field"><span>Game length</span>
      <select id="set-length">${[20, 30, 40, 2].map(m => `<option value="${m}" ${s.lengthMin === m ? 'selected' : ''}>${m === 2 ? '2 min (test)' : m + ' min'}</option>`).join('')}</select></label>
    <label class="toggle"><input type="checkbox" id="set-sound" ${s.sound ? 'checked' : ''}><span class="sw"></span> Sound <kbd>M</kbd></label>
    <p class="muted small">API key, model, cheekiness and German-flavour sliders arrive with fresh decks (Milestone 3).</p>
    <div class="win-actions"><button class="btn primary" data-act="save-settings">Save</button></div>
  </div>`;
}

// ---------- timers & clock ----------
function updateTimerUi() {
  const fg = $('#ring-fg');
  const num = $('#ring-num');
  if (store.timer && fg && num) {
    const left = Math.max(0, store.timer.endsAt - Date.now());
    const frac = left / (store.timer.seconds * 1000);
    const C = 2 * Math.PI * 88;
    fg.style.strokeDasharray = `${C}`;
    fg.style.strokeDashoffset = `${C * (1 - frac)}`;
    num.textContent = Math.ceil(left / 1000);
    num.classList.toggle('low', left <= 5000);
  } else if (!store.timer && fg && num) {
    const C = 2 * Math.PI * 88;
    fg.style.strokeDasharray = `${C}`;
    fg.style.strokeDashoffset = store.phase === 'timeup' ? `${C}` : '0';
    if (store.phase === 'timeup') num.textContent = '0';
  }
}

function startTimer(seconds, onDone) {
  store.timer = { seconds, startedAt: Date.now(), endsAt: Date.now() + seconds * 1000, lastTick: null, onDone };
}

function stopTimer() { store.timer = null; }

function frame() {
  const t = store.timer;
  if (t) {
    const left = t.endsAt - Date.now();
    const sec = Math.ceil(left / 1000);
    if (left > 0 && sec <= 5 && sec !== t.lastTick) { t.lastTick = sec; sfx.tick(); }
    if (left <= 0) {
      store.timer = null;
      sfx.buzzer();
      t.onDone && t.onDone();
    }
    updateTimerUi();
  }
  if (store.phase === 'reveal' && store.revealTimer) {
    const fill = $('#rv-fill');
    if (fill) fill.style.width = `${Math.max(0, 100 * (store.revealTimer.endsAt - Date.now()) / 6000)}%`;
  }
  requestAnimationFrame(frame);
}

function clockTick() {
  if (store.screen !== 'board' || !store.clock || !store.game) return;
  const el = $('#clock');
  if (el) el.textContent = fmtClock();
  const elapsed = Date.now() - store.clock.startedAt;
  if (elapsed >= store.clock.lastOrdersAt && store.game.lastOrders == null) {
    store.game = R.callLastOrders(store.game, store.phase !== 'pass');
    showLastOrders();
  }
  if (elapsed >= store.clock.lengthMs && !store.timeUp) {
    store.timeUp = true;
    if (el) el.classList.add('done');
    if (store.phase === 'pass' && !store.busy) beginTurnFlow();
  }
}

async function showLastOrders() {
  const b = $('#lastorders');
  b.innerHTML = `<div class="lo-big">LAST ORDERS</div><div class="lo-sub">Everyone gets exactly one more turn · ${store.game.lastOrders} turns left</div>`;
  b.className = 'show';
  sfx.chime();
  renderTopbar(); drawIcons();
  await wait(4000);
  b.className = '';
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show';
  clearTimeout(store.toast);
  store.toast = setTimeout(() => { t.className = ''; }, 2500);
}

// ---------- animation helpers ----------
async function animateMoves(moves) {
  for (const m of moves) {
    if (reduceMotion()) {
      store.displayPos[m.tokenId] = m.to;
      renderTokens();
      await wait(250);
      continue;
    }
    const dir = Math.sign(m.to - m.from);
    for (let p = m.from + dir; dir > 0 ? p <= m.to : p >= m.to; p += dir) {
      store.displayPos[m.tokenId] = p;
      renderTokens();
      sfx.hop();
      await wait(180);
    }
    squash(m.tokenId);
  }
  syncDisplay();
}

function squash(tokenId) {
  const el = document.querySelector(`.token[data-id="${tokenId}"]`);
  if (!el || reduceMotion()) return;
  el.classList.remove('squash'); void el.offsetWidth; el.classList.add('squash');
}

function syncDisplay() {
  if (!store.game) return;
  store.game.tokens.forEach(t => { store.displayPos[t.id] = t.pos; });
  renderTokens();
}

function shakeStage(kind) {
  if (reduceMotion()) return;
  const s = $('#stage');
  s.classList.remove('wobble', 'shake'); void s.offsetWidth; s.classList.add(kind);
  setTimeout(() => s.classList.remove(kind), 700);
}

function confetti(color, count = 60, el = $('#fx')) {
  if (!el) return;
  const colors = color ? [color] : ['var(--act)', 'var(--draw)', 'var(--words)', 'var(--brains)'];
  for (let i = 0; i < count; i++) {
    const c = document.createElement('i');
    c.className = 'conf';
    c.style.left = `${Math.random() * 100}%`;
    c.style.background = colors[i % colors.length];
    c.style.animationDelay = `${Math.random() * 0.4}s`;
    c.style.setProperty('--dx', `${(Math.random() - 0.5) * 300}px`);
    c.style.setProperty('--rot', `${Math.random() * 720}deg`);
    el.appendChild(c);
    setTimeout(() => c.remove(), 2600);
  }
}

// ---------- game flow ----------
function setPhase(ph) { store.phase = ph; render(); }

function startGame({ rematch = false } = {}) {
  const ps = store.setup.players.map((p, k) => ({ ...p, name: (p.name || '').trim() || `Player ${k + 1}` }));
  store.setup.players.forEach((p, k) => { p.name = ps[k].name; });
  lsSet('spielchen.players', store.setup.players);
  const teamMode = R.teamsAllowed(ps.length) && store.setup.teamMode;
  const valid = t => t && t.flat().length === ps.length && ps.every(p => t.flat().includes(p.id));
  if (teamMode && !valid(store.setup.teams)) store.setup.teams = R.makeTeams(ps.map(p => p.id));
  store.game = R.createGame({ players: ps, teams: teamMode ? store.setup.teams : null });
  store.deck = new Deck(store.backupCards);
  store.displayPos = {};
  store.undo = [];
  store.timeUp = false;
  store.ctx = null;
  store.card = null;
  store.result = null;
  store.seenGames = new Set();
  const lengthMs = store.settings.lengthMin * 60000;
  store.clock = { startedAt: Date.now(), lengthMs, lastOrdersAt: R.lastOrdersAtMs(lengthMs) };
  sfx.unlock();
  if (rematch) {
    store.screen = 'board';
    store.phase = 'idle';
    render();
    beginTurnFlow();
  } else {
    store.screen = 'howto';
    store.phase = 'idle';
    render();
    runHowTo();
  }
}

let howtoTimer = null;
function runHowTo() {
  const fill = $('#howto-fill');
  if (fill) requestAnimationFrame(() => { fill.style.transition = 'width 8s linear'; fill.style.width = '100%'; });
  clearTimeout(howtoTimer);
  howtoTimer = setTimeout(leaveHowTo, 8000);
}

function leaveHowTo() {
  if (store.screen !== 'howto') return;
  clearTimeout(howtoTimer);
  store.clock.startedAt = Date.now();   // the clock starts when the board appears
  store.screen = 'board';
  render();
  beginTurnFlow();
}

async function beginTurnFlow() {
  const g = store.game;
  if (R.isOver(g, store.timeUp)) return finishGame();
  const r = R.beginTurn(g);
  if (r.skipped) {
    const t = g.tokens.find(x => x.id === r.skippedTokenId);
    const pid = R.activePlayerId(g);
    store.game = r.state;
    store.busy = true;
    store.ctx = { square: R.BOARD[13], pid: pid || t.memberIds[0] };
    setPhase('skipped');
    sfx.stamp();
    await wait(2500);
    store.busy = false;
    store.ctx = null;
    return beginTurnFlow();
  }
  store.game = r.state;
  store.ctx = null;
  syncDisplay();
  setPhase('pass');
}

async function doRoll() {
  store.undo = [];   // once the next player rolls, the last result is final
  if (R.needsFinaleWithoutRoll(store.game)) return startPick(true);
  store.busy = true;
  store.rolling = true;
  store.die = 1;
  setPhase('rolling');
  sfx.roll();
  const die = R.rollDie();
  const spin = setInterval(() => { const el = $('#die'); if (el) el.textContent = 1 + Math.floor(Math.random() * 4); }, 90);
  await wait(reduceMotion() ? 200 : 600);
  clearInterval(spin);
  store.rolling = false;
  store.die = die;
  setPhase('moving');
  const { state, from, to, square } = R.moveActive(store.game, die);
  store.game = state;
  await animateMoves([{ tokenId: activeTok().id, from, to }]);
  await wait(250);
  await land(square);
}

async function land(square) {
  store.busy = true;
  if (square.type === 'colour') { store.busy = false; return startCard(square.category); }
  if (square.type === 'finale') { store.busy = false; return startPick(true); }
  store.ctx = { square };
  setPhase('special');
  if (square.type === 'db') { sfx.chime(); shakeStage('wobble'); }
  else if (square.type === 'pfand') sfx.pfand();
  else if (square.type === 'burgeramt') sfx.stamp();
  else sfx.success();
  if (square.type === 'pfand' || square.type === 'db' || square.type === 'burgeramt') {
    await wait(1200);
    const { state, moves } = R.applySpecial(store.game, square.type);
    store.game = state;
    await animateMoves(moves);
    await wait(moves.length ? 900 : 1300);
    store.busy = false;
    return endTurnFlow();
  }
  await wait(2500);
  store.busy = false;
  if (square.type === 'allplay') return startAllPlay();
  if (square.type === 'wild') return startPick(false);
}

function startPick(finale) {
  store.ctx = { finale };
  setPhase('pick');
}

function startCard(category, { finale = false, sudden = null } = {}) {
  const card = store.deck.draw(category, { hard: finale });
  store.card = card;
  store.ctx = { card, finale, sudden, hard: finale || card.difficulty === 'hard', washed: false };
  setPhase('card-hidden');
}

function reveal() {
  store.phase = 'reveal';
  render();
  const endsAt = Date.now() + 6000;
  const id = setTimeout(hideReveal, 6000);
  store.revealTimer = { endsAt, id };
}

function hideReveal() {
  if (store.revealTimer) clearTimeout(store.revealTimer.id);
  store.revealTimer = null;
  if (store.phase !== 'reveal') return;
  setPhase('card-ready');   // the secret element is removed from the DOM here
}

function startRound() {
  const mg = MINI_GAMES[store.ctx.card.game];
  store.ctx.startedAt = Date.now();
  startTimer(mg.seconds, () => { if (store.phase === 'running') setPhase('timeup'); });
  setPhase('running');
}

function onGotIt() {
  stopTimer();
  store.ctx.elapsedMs = Date.now() - (store.ctx.startedAt || Date.now());
  if (store.ctx.sudden) return setPhase('guesser');
  if (store.game.teamMode) return resolveCard({ ok: true });
  setPhase('guesser');
}

function onFailed() {
  stopTimer();
  if (store.ctx.sudden) { sfx.fail(); return startCard('brains', { sudden: store.ctx.sudden }); }
  if (store.game.teamMode) return setPhase('steal');
  resolveCard({ ok: false });
}

function pickPlayer(pid) {
  const ph = store.phase;
  const g = store.game;
  if (ph === 'guesser') {
    const allowed = store.ctx.sudden ? store.ctx.sudden.pids : R.otherPlayers(g).map(p => p.id);
    if (!allowed.includes(pid)) return;
    if (store.ctx.sudden) return winByToken(R.tokenOfPlayer(g, pid).id, 'Won the sudden-death question.');
    return resolveCard({ ok: true, guesserId: pid });
  }
  if (ph === 'steal') {
    if (pid && !R.otherPlayers(g).some(p => p.id === pid)) return;
    return resolveCard({ ok: false, stealerId: pid || null });
  }
  if (ph === 'ap-pick') {
    if (pid && !g.players.some(p => p.id === pid)) return;
    return resolveAllPlay(pid || null);
  }
}

function pushUndo(returnPhase) {
  store.undo.push({ game: R.clone(store.game), ctx: { ...store.ctx, washed: true }, phase: returnPhase });
  if (store.undo.length > 10) store.undo.shift();
}

async function resolveCard({ ok, guesserId = null, stealerId = null }) {
  const ctx = store.ctx;
  pushUndo('timeup');
  store.busy = true;
  const { state, moves, won } = R.applyCardResult(store.game, {
    ok, hard: ctx.hard, finale: ctx.finale, guesserId, stealerId, elapsedMs: ok ? ctx.elapsedMs : null,
  });
  store.game = state;
  store.phase = 'resolving';
  render();
  if (ok) { sfx.success(); confetti(`var(--${ctx.card.category})`); }
  else { sfx.fail(); shakeStage('shake'); }
  if (won) toast('Finale cleared!');
  else if (stealerId) toast(`${pname(stealerId)} stole it! +1`);
  else if (guesserId) toast(`${pname(guesserId)} guessed it! +1`);
  else if (ok && ctx.hard && !won) toast('Hard card: +1 extra square');
  await animateMoves(moves);
  await wait(500);
  store.busy = false;
  if (won) return winByToken(R.activeToken(store.game).id, 'Cleared the Finale.');
  endTurnFlow();
}

function startAllPlay() {
  const card = store.deck.draw('allplay');
  store.card = card;
  store.ctx = { card, allplay: true, washed: false };
  setPhase('ap-ready');
}

async function resolveAllPlay(pid) {
  pushUndo('ap-pick');
  store.busy = true;
  const { state, moves } = R.applyAllPlayResult(store.game, pid);
  store.game = state;
  store.phase = 'resolving';
  render();
  if (pid) { sfx.success(); confetti(null); toast(`${pname(pid)} wins the All Play! +2`); }
  await animateMoves(moves);
  await wait(500);
  store.busy = false;
  endTurnFlow();
}

function endTurnFlow() {
  store.game = R.endTurn(store.game);
  store.ctx = null;
  store.card = null;
  beginTurnFlow();
}

function undo() {
  const snap = store.undo.pop();
  if (!snap) return toast('Nothing to undo');
  stopTimer();
  store.game = snap.game;
  store.ctx = snap.ctx;
  store.card = snap.ctx.card;
  syncDisplay();
  setPhase(snap.phase);
  toast('Undone. Pick the result again.');
}

function finishGame() {
  const d = R.decideWinner(store.game);
  if (d.suddenDeath) {
    const toks = store.game.tokens.filter(t => d.suddenDeath.includes(t.id));
    const pids = toks.flatMap(t => t.memberIds);
    toast('It’s a tie! Sudden death.');
    return startCard('brains', { sudden: { tokenIds: d.suddenDeath, pids, names: toks.map(t => t.name).join(' vs ') } });
  }
  const reason = store.game.winnerId ? 'Cleared the Finale.' : (store.timeUp ? 'Time’s up — furthest token wins.' : 'Last orders are in — furthest token wins.');
  winByToken(d.winnerId, reason);
}

function winByToken(tokenId, reason) {
  const g = store.game;
  if (!g.winnerId) g.winnerId = tokenId;
  stopTimer();
  const ranking = R.ranking(g);
  const last = ranking[ranking.length - 1];
  store.result = {
    ranking,
    reason,
    stats: R.autoStats(g),
    last,
    penalty: PENALTIES[Math.floor(Math.random() * PENALTIES.length)],
  };
  store.ctx = null;
  $('#toast').className = '';
  store.phase = 'over';
  store.screen = 'winner';
  render();
  sfx.fanfare();
  confetti(null, 140, $('#confetti'));
}

function debugJump(n) {
  if (!(n >= 1 && n <= R.FINALE) || store.phase !== 'pass' || store.busy) return;
  const g = R.clone(store.game);
  const t = R.activeToken(g);
  g.turnStart = t.pos;
  t.pos = n;
  store.game = g;
  syncDisplay();
  toast(`Debug: jumped to ${n}`);
  land(R.BOARD[n]);
}

// ---------- input ----------
function handleKey(e) {
  if (store.settingsOpen) { if (e.key === 'Escape') { store.settingsOpen = false; render(); } return; }
  const inInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (store.screen === 'setup') {
    if (k === 'Enter') { e.preventDefault(); startGame(); }
    return;
  }
  if (inInput) return;

  if (k === 'f') { toggleFullscreen(); return; }
  if (k === 'm') { store.settings.sound = !store.settings.sound; saveSettings(); toast(store.settings.sound ? 'Sound on' : 'Muted'); return; }
  if (k === 'h') { store.hotseat = !store.hotseat; toast(store.hotseat ? 'Hot-seat mode on' : 'Hot-seat off — the phone remote arrives in Milestone 2, so keys still work'); renderTopbar(); drawIcons(); return; }

  if (store.screen === 'howto') { if (k === ' ' || k === 'Enter') { e.preventDefault(); leaveHowTo(); } return; }
  if (store.screen === 'winner') {
    if (k === 'r') startGame({ rematch: true });
    else if (k === 'n') newGame();
    return;
  }
  if (store.screen !== 'board') return;

  // Debug jump: D, then digits, then Enter.
  if (store.debugBuf != null) {
    if (/^[0-9]$/.test(k)) { store.debugBuf += k; toast(`Debug jump to ${store.debugBuf}…`); return; }
    if (k === 'Enter') { const n = parseInt(store.debugBuf, 10); store.debugBuf = null; debugJump(n); return; }
    store.debugBuf = null;
  }
  if (k === 'd' && store.phase === 'pass') { store.debugBuf = ''; toast('Debug: type a square number, then Enter'); return; }

  if (store.busy) return;
  const ph = store.phase;
  if (k === ' ') e.preventDefault();

  if (k === 'u') { if (ph === 'guesser' || ph === 'steal') setPhase('timeup'); else if (ph === 'pass') undo(); return; }

  switch (ph) {
    case 'pass': if (k === ' ') doRoll(); break;
    case 'pick': if (/^[1-4]$/.test(k)) pickCategory(R.CATEGORIES[+k - 1]); break;
    case 'card-hidden': if (k === ' ') reveal(); break;
    case 'reveal': if (k === ' ') hideReveal(); break;
    case 'card-ready': if (k === ' ') startRound(); else if (k === 'p') reveal(); break;
    case 'running': case 'timeup': if (k === 'y') onGotIt(); else if (k === 'n') onFailed(); break;
    case 'guesser': case 'steal': case 'ap-pick':
      if (/^[0-6]$/.test(k)) {
        if (k === '0') { if (ph !== 'guesser') pickPlayer(''); }
        else { const p = store.game.players[+k - 1]; if (p) pickPlayer(p.id); }
      } else if (k === 'Escape' && ph !== 'ap-pick') setPhase('timeup');
      break;
    case 'ap-ready': if (k === ' ') { startTimer(MINI_GAMES[store.ctx.card.game].seconds, () => { if (store.phase === 'ap-running') setPhase('ap-pick'); }); setPhase('ap-running'); } break;
    case 'ap-running': if (k === ' ') { stopTimer(); setPhase('ap-pick'); } break;
  }
}

function pickCategory(cat) {
  if (store.phase !== 'pick') return;
  startCard(cat, { finale: !!store.ctx.finale });
}

function newGame() {
  store.screen = 'setup';
  store.game = null;
  store.clock = null;
  store.phase = 'idle';
  store.setup.teams = null;
  render();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
}

function handleClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const k = +btn.dataset.k;
  const ps = store.setup.players;
  switch (act) {
    case 'settings': store.settingsOpen = !store.settingsOpen; render(); break;
    case 'save-settings':
      store.settings.lengthMin = +$('#set-length').value;
      store.settings.sound = $('#set-sound').checked;
      saveSettings();
      store.settingsOpen = false;
      render();
      break;
    case 'color': {
      const used = ps.map(p => p.color);
      let idx = TOKEN_COLORS.indexOf(ps[k].color);
      for (let n = 0; n < TOKEN_COLORS.length; n++) { idx = (idx + 1) % TOKEN_COLORS.length; if (!used.includes(TOKEN_COLORS[idx])) break; }
      ps[k].color = TOKEN_COLORS[idx];
      render(); break;
    }
    case 'emoji': ps[k].emoji = EMOJIS[(EMOJIS.indexOf(ps[k].emoji) + 1) % EMOJIS.length]; render(); break;
    case 'remove': ps.splice(k, 1); store.setup.teams = null; render(); break;
    case 'add': {
      if (ps.length >= 6) break;
      const ids = ps.map(p => p.id);
      let n = 1; while (ids.includes('p' + n)) n++;
      const color = TOKEN_COLORS.find(c => !ps.some(p => p.color === c));
      const emoji = EMOJIS.find(em => !ps.some(p => p.emoji === em));
      ps.push({ id: 'p' + n, name: '', color, emoji });
      store.setup.teams = null;
      render();
      const inputs = document.querySelectorAll('.name'); inputs[inputs.length - 1]?.focus();
      break;
    }
    case 'teams': store.setup.teamMode = btn.checked; render(); break;
    case 'reshuffle': store.setup.teams = R.makeTeams(ps.map(p => p.id)); render(); break;
    case 'start': startGame(); break;
    case 'skip-howto': leaveHowTo(); break;
    case 'pick-cat': pickCategory(btn.dataset.cat); break;
    case 'pick-player': if (!store.busy) pickPlayer(btn.dataset.pid); break;
    case 'rematch': startGame({ rematch: true }); break;
    case 'newgame': newGame(); break;
  }
}

function handleInput(e) {
  if (e.target.classList.contains('name')) {
    const k = +e.target.dataset.k;
    store.setup.players[k].name = e.target.value;
    // Update team chips without re-rendering (keeps focus).
  }
}

// ---------- stage scaling ----------
function fitStage() {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  const stage = $('#stage');
  stage.style.setProperty('--s', s);
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;
}

// ---------- logo dot rotation ----------
let dotIdx = 0;
setInterval(() => {
  dotIdx = (dotIdx + 1) % 4;
  document.documentElement.style.setProperty('--logo-dot', `var(--${R.CATEGORIES[dotIdx]})`);
}, 1500);

// ---------- boot ----------
async function boot() {
  fitStage();
  window.addEventListener('resize', fitStage);
  window.addEventListener('load', drawIcons);
  document.addEventListener('keydown', handleKey);
  document.addEventListener('click', handleClick);
  document.addEventListener('input', handleInput);
  try {
    store.backupCards = await loadBackupDeck();
  } catch (err) {
    console.error('Could not load backup deck', err);
    toast('Could not load the backup deck');
  }
  render();
  setInterval(clockTick, 250);
  requestAnimationFrame(frame);
  // Exposed for tests and debugging (never contains the API key).
  window.__spielchen = { store, R, render };
}

boot();
