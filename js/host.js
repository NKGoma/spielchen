// Spielchen TV / host: state machine, rendering, keyboard (hot-seat) controls.
import * as R from './rules.js';
import { Deck, MINI_GAMES, CATEGORY_PLAIN, loadBackupDeck } from './deck.js';
import { sfx } from './sfx.js';
import { icon } from './icons.js';
import { dieHtml, tumble, momentHtml, confetti, reduceMotion } from './fx.js';
import { commentFor } from './commentary.js';
import { HostNet, makeRoomCode } from './net.js';
import { generateDeck, GEN_CATEGORIES } from './generate.js';
import { getKey, setKey, testKey, complete, friendlyError, MODELS, DEFAULT_MODEL } from './llm.js';
import { BRIEF_CHIPS, BRIEF_SYSTEM, SURPRISE, briefPrompt, parseBrief, topicsFromText } from './brief.js';

// ---------- utilities ----------
const $ = sel => document.querySelector(sel);
const wait = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const TOKEN_COLORS = ['#FF8A3D', '#A78BFA', '#22D3EE', '#F87171', '#A3E635', '#F4F1EA'];
const EMOJIS = ['🦊', '🐙', '🦉', '🐸', '🦄', '🐻', '🥨', '🍺', '🚲', '🌭', '🎸', '🐝'];
const PENALTIES = [
  'Announce the next game like a Tagesschau newsreader.',
  'Fetch everyone a drink, narrating it like a nature documentary.',
  'Give a 20-second victory speech for the winner, in your most dramatic voice.',
  'Explain the rules of Pfand to the group as if it were a TED talk.',
  'Sing the first line of any song as a Deutsche Bahn station announcement.',
  'Do a slow-motion replay of your worst moment of the game.',
  'Compliment every player in the style of a Eurovision jury: “Douze points for…”.',
];

// ---------- board geometry (1920×1080 stage) ----------
const SQ = 120, PITCH = 168, ROWP = 228, LEFT = 144, TOP = 262;
function squareRect(i) {
  const { row, col, span } = R.squareLayout(i);
  return { x: LEFT + col * PITCH, y: TOP + row * ROWP, w: span === 2 ? PITCH + SQ : SQ, h: SQ };
}

// ---------- store ----------
const defaultPlayers = () => [0, 1, 2].map(k => ({ id: 'p' + (k + 1), name: '', color: TOKEN_COLORS[k], emoji: EMOJIS[k] }));

const store = {
  screen: 'setup',            // setup | howto | board | winner
  settings: Object.assign({ lengthMin: 30, sound: true, model: DEFAULT_MODEL, cheeky: 50, german: 25 }, lsGet('spielchen.settings', {})),
  settingsOpen: false,
  hotseat: true,
  setup: { players: lsGet('spielchen.players', null) || defaultPlayers(), teamMode: true, teams: null },
  backupCards: [],
  game: null,
  deck: null,
  phase: 'idle',
  busy: false,
  ctx: null,                  // current card / moment context
  die: null,
  displayPos: {},
  clock: null,                // { startedAt, lengthMs, lastOrdersAt }
  timeUp: false,
  undo: [],
  debugBuf: null,
  revealTimer: null,
  timer: null,
  result: null,
  seenGames: new Set(),
  ovKey: null,
  ticker: [],
  net: null,
  netStatus: 'offline',
  room: null,
  gen: null,                  // { id, cards: {category: [...]}, running, failed: Set }
  deckGenId: null,
  prefetching: false,
  keyMsg: '',
  brief: Object.assign({ messages: [], topics: [], chat: [] }, lsGet('spielchen.brief', {})),
  briefBusy: false,
  hadPhone: false,
  phoneLostAt: 0,
};
const saveBrief = () => lsSet('spielchen.brief', { messages: store.brief.messages.slice(-3), topics: store.brief.topics, chat: store.brief.chat.slice(-6) });
const topicsKey = () => JSON.stringify(store.brief.topics || []);
const phoneMode = () => !!store.net && store.net.connected && !store.hotseat;

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
  if (store.screen === 'setup') {
    // Keep typing focus across re-renders (e.g. when the phone connects mid-typing).
    const f = document.activeElement;
    const k = f && f.classList && f.classList.contains('name') ? f.dataset.k : null;
    const pos = k != null ? f.selectionStart : 0;
    const bOld = $('#brief-tv');
    const bFocus = bOld && f === bOld;
    const bVal = bOld ? bOld.value : '';
    app.innerHTML = renderSetup();
    const bNew = $('#brief-tv');
    if (bNew) { bNew.value = bVal; if (bFocus) bNew.focus(); }
    if (k != null) { const el = app.querySelector(`.name[data-k="${k}"]`); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* ignore */ } } }
  }
  else if (store.screen === 'howto') app.innerHTML = renderHowTo();
  else if (store.screen === 'winner') { if (!app.querySelector('.winner')) app.innerHTML = renderWinner(); }
  else if (store.screen === 'board') {
    if (!app.querySelector('.board-screen')) app.innerHTML = renderBoardShell();
    renderBoardDynamic();
  }
  renderTopbar();
  renderOverlay();
  renderSettings();
  pushPhone();
}

function logoHtml(size = '') {
  return `<div class="logo ${size}" aria-label="spielchen">sp<span class="i-wrap">ı<span class="i-dot"></span></span>elchen</div>`;
}

function renderTopbar() {
  const g = store.game;
  const onBoard = store.screen === 'board' && store.clock;
  const lo = g && onBoard && g.lastOrders != null;
  $('#topbar').innerHTML = `
    <div class="tb-left">${onBoard ? logoHtml('small') : ''}</div>
    <div class="tb-right">
      ${freshPill()}
      ${phonePill()}
      ${onBoard ? `<div class="clock-pill ${lo ? 'lo' : ''}">
        ${lo ? `<span class="lo-tag">Last orders · ${g.lastOrders} turn${g.lastOrders === 1 ? '' : 's'}</span>` : ''}
        <span class="clock" id="clock">${fmtClock()}</span><span class="clock-bar"><i id="clock-fill" style="width:${clockFrac() * 100}%"></i></span></div>` : ''}
      <button class="gear" data-act="settings" aria-label="Settings">${icon('settings')}</button>
    </div>`;
}

function freshPill() {
  if (!getKey()) return `<span class="pill" title="Add an API key in Settings for fresh AI cards">${icon('layers')} Backup deck</span>`;
  const g = store.gen;
  const n = g ? GEN_CATEGORIES.filter(c => g.cards[c]).length : 0;
  const cls = g && g.running ? 'warn' : g && g.error && n < 5 ? 'bad' : n === 5 ? 'good' : '';
  const label = g && g.error && !g.running && n === 0 ? 'Fresh cards failed' : `Fresh cards ${n}/5`;
  return `<span class="pill fresh ${cls}" title="${esc(g && g.error ? g.error : 'Fresh cards from Claude')}">${icon('layers')} ${label}${g && g.running ? '<i class="spin-dot"></i>' : ''}</span>`;
}

function phonePill() {
  if (!store.net) return `<span class="pill on">${icon('laptop')} Hot-seat <kbd>H</kbd></span>`;
  if (store.hotseat) return `<span class="pill on">${icon('laptop')} Hot-seat <kbd>H</kbd></span><span class="pill">${icon('smartphone')} Room <b>${esc(store.room || '')}</b></span>`;
  const st = store.netStatus;
  const cls = st === 'connected' ? 'ok' : st === 'reconnecting' || st === 'starting' ? 'warn' : 'off';
  const label = st === 'connected' ? 'Phone' : st === 'reconnecting' ? 'Phone lost' : st === 'starting' ? 'Opening' : st === 'waiting' ? 'No phone' : 'Offline';
  return `<span class="pill on"><i class="dot ${cls}"></i>${icon('smartphone')} ${label} · Room <b>${esc(store.room || '')}</b></span>`;
}

function phoneUrl() {
  const u = new URL('phone.html', location.href);
  u.search = '';
  u.searchParams.set('room', store.room || '');
  const peer = new URLSearchParams(location.search).get('peer');
  if (peer) u.searchParams.set('peer', peer);
  return u.toString();
}

function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '';
  try { const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 8, margin: 2, scalable: true }); } catch { return ''; }
}

function clockFrac() {
  if (!store.clock) return 1;
  return Math.max(0, 1 - (Date.now() - store.clock.startedAt) / store.clock.lengthMs);
}

function fmtClock() {
  if (!store.clock) return '';
  const left = Math.max(0, store.clock.lengthMs - (Date.now() - store.clock.startedAt));
  const s = Math.ceil(left / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function validTeams(t, ps) { return t && t.flat().length === ps.length && ps.every(p => t.flat().includes(p.id)); }

function renderSetup() {
  const ps = store.setup.players;
  const n = ps.length;
  const teamsOk = R.teamsAllowed(n);
  const teamMode = teamsOk && store.setup.teamMode;
  if (teamMode && !validTeams(store.setup.teams, ps)) store.setup.teams = R.makeTeams(ps.map(p => p.id));
  const rows = ps.map((p, k) => `
    <div class="prow">
      <button class="tok-btn" style="--c:${p.color}" data-act="color" data-k="${k}" aria-label="Change colour"><span>${p.emoji}</span></button>
      <input class="name" data-k="${k}" maxlength="14" placeholder="Player ${k + 1}" value="${esc(p.name)}" autocomplete="off" spellcheck="false">
      <button class="icon-btn" data-act="emoji" data-k="${k}" aria-label="Change emoji">${icon('smile')}</button>
      ${n > 2 ? `<button class="icon-btn" data-act="remove" data-k="${k}" aria-label="Remove player">${icon('x')}</button>` : '<span class="icon-gap"></span>'}
    </div>`).join('');
  const teamsHtml = teamMode ? `<div class="teams">${store.setup.teams.map((pair, t) => `
      <div class="team"><span class="team-name">Team ${t + 1}</span>${pair.map(id => {
        const p = ps.find(x => x.id === id);
        return `<span class="chip"><span class="chip-tok" style="--c:${p.color}">${p.emoji}</span>${esc(p.name || 'Player ' + (ps.indexOf(p) + 1))}</span>`;
      }).join('')}</div>`).join('')}
      <button class="btn ghost small-btn" data-act="reshuffle">${icon('shuffle')} Reshuffle</button></div>` : '';
  const tiles = R.CATEGORIES.map(c => `<div class="mini-tile cat-${c}">${icon(R.CATEGORY_INFO[c].icon)}<span>${R.CATEGORY_INFO[c].verb}</span></div>`).join('');
  return `
  <div class="setup">
    <div class="setup-left">
      ${logoHtml('big')}
      <p class="tagline">Roll. Land on a colour. Do the challenge.</p>
      <div class="players">${rows}</div>
      <div class="setup-actions">
        ${n < 6 ? `<button class="btn ghost" data-act="add">${icon('user-plus')} Add player</button>` : ''}
        ${teamsOk ? `<label class="toggle"><input type="checkbox" data-act="teams" ${store.setup.teamMode ? 'checked' : ''}><span class="sw"></span> Teams of 2</label>` : '<span class="muted small">Teams of 2 work with 4 or 6 players.</span>'}
      </div>
      ${teamsHtml}
    </div>
    <div class="setup-right">
      ${joinCard(tiles)}
      <div class="brief-panel" id="brief-panel">${briefPanelInner()}</div>
      <button class="btn primary huge" data-act="start">Start ${icon('arrow-right')}</button>
      <p class="muted small">${store.settings.lengthMin === 2 ? '2 min test game' : store.settings.lengthMin + '-minute game'} · <kbd>Enter</kbd> to start</p>
    </div>
  </div>`;
}

function joinCard(tiles) {
  const st = store.netStatus;
  if (!store.room || st === 'offline') {
    return `<div class="join-card">
      <div class="mini-tiles">${tiles}</div>
      <div class="join-title">${icon('laptop')} Hot-seat mode</div>
      <p>The phone remote couldn't start here, so everything runs on this laptop: <kbd>Space</kbd> <kbd>Y</kbd> <kbd>N</kbd> and <kbd>1</kbd>–<kbd>6</kbd>.</p>
    </div>`;
  }
  const qr = qrSvg(phoneUrl());
  const cls = st === 'connected' ? 'ok' : st === 'waiting' ? 'idle' : 'warn';
  const label = st === 'connected' ? 'Phone connected' : st === 'waiting' ? 'Scan with one phone' : st === 'reconnecting' ? 'Reconnecting…' : 'Opening room…';
  return `<div class="join-card qr-card">
    <div class="qr">${qr || `<div class="qr-fallback">${icon('smartphone')}</div>`}</div>
    <div class="join-info">
      <div class="join-label"><i class="dot ${cls}"></i>${label}</div>
      <div class="room-code">${store.room}</div>
      <div class="join-url">or open <b>phone.html</b> and type the code</div>
      <div class="join-hot">No phone? Press <kbd>H</kbd> for hot-seat.</div>
    </div>
  </div>`;
}

function renderHowTo() {
  const tiles = R.CATEGORIES.map(c => {
    const info = R.CATEGORY_INFO[c];
    return `<div class="tile cat-${c}">${icon(info.icon, 'tile-ic')}<div class="tile-verb">${info.verb}</div><div class="tile-plain">${CATEGORY_PLAIN[c]}</div><div class="tile-name">${info.name}</div></div>`;
  }).join('');
  return `
  <div class="howto">
    <div class="howto-kicker">How to play</div>
    <p class="howto-line">Roll. Land on a colour. Do the challenge.<br><span class="muted">Get it guessed: stay. Fail: go back.</span></p>
    <div class="tiles">${tiles}</div>
    <p class="muted howto-foot">First to clear the ${icon('trophy')} Finale wins, or whoever is furthest when the clock runs out.</p>
    <button class="btn primary" data-act="skip-howto">Let's go <kbd>Space</kbd></button>
    <div class="howto-bar"><span id="howto-fill"></span></div>
  </div>`;
}

const SPECIAL_ACCENT = { pfand: 'var(--brains)', allplay: 'var(--text)', db: 'var(--alert)', wild: 'var(--words)', burgeramt: 'var(--muted)' };

function renderBoardShell() {
  const squares = R.BOARD.map(sq => {
    const r = squareRect(sq.i);
    const style = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
    if (sq.type === 'colour') {
      return `<div class="sq colour cat-${sq.category}" style="${style}"><span class="sq-num">${sq.i}</span>${icon(sq.icon, 'sq-ic')}<span class="sq-label">${esc(sq.label)}</span></div>`;
    }
    if (sq.type === 'start') return `<div class="sq sp-start" style="${style}"><span class="sq-big">Start</span>${icon('arrow-right', 'sq-ic')}</div>`;
    if (sq.type === 'finale') return `<div class="sq sp-finale" style="${style}"><span class="checks"></span>${icon('trophy', 'sq-ic')}<span class="sq-big">Finale</span></div>`;
    const wild = sq.type === 'wild' ? `<span class="wild-dots">${R.CATEGORIES.map(c => `<i class="cat-${c}"></i>`).join('')}</span>` : '';
    return `<div class="sq special sp-${sq.type}" style="${style};--acc:${SPECIAL_ACCENT[sq.type]}"><span class="sq-num">${sq.i}</span>${icon(sq.icon, 'sq-ic')}<span class="sq-label">${esc(sq.type === 'db' ? 'Bahn' : sq.label)}</span>${wild}</div>`;
  }).join('');
  const pts = R.BOARD.map(sq => { const r = squareRect(sq.i); return `${r.x + r.w / 2},${r.y + r.h / 2}`; }).join(' ');
  return `
  <div class="board-screen">
    <svg class="path" width="1920" height="1080" aria-hidden="true">
      <defs><pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="2" fill="#1C2028"/></pattern></defs>
      <rect width="1920" height="1080" fill="url(#dots)"/>
      <polyline class="road" points="${pts}"/>
      <polyline class="road-dash" points="${pts}"/>
    </svg>
    <div class="squares">${squares}</div>
    <div id="tokens"></div>
    <div class="nowup" id="banner"></div>
    <div class="dock" id="dock"></div>
    <div class="ticker" id="ticker"></div>
    <div class="rejoin" id="rejoin"></div>
  </div>`;
}

function renderRejoin() {
  const el = $('#rejoin');
  if (!el) return;
  const lost = store.net && store.hadPhone && !store.hotseat && store.netStatus !== 'connected' && store.phoneLostAt && Date.now() - store.phoneLostAt > 5000;
  if (!lost) { if (el.classList.contains('show')) { el.className = 'rejoin'; el.innerHTML = ''; } return; }
  if (el.classList.contains('show')) return;
  el.innerHTML = `<div class="rj-qr">${qrSvg(phoneUrl())}</div><div class="rj-text"><b>Phone gone? Scan, or type</b><span class="rj-code">${esc(store.room)}</span><span class="muted">or press <kbd>H</kbd> to play on the laptop</span></div>`;
  el.className = 'rejoin show';
}

function renderBoardDynamic() {
  renderRejoin();
  renderTokens();
  const g = store.game;
  const banner = $('#banner');
  if (banner && g) {
    let html = '';
    const ph = store.phase;
    if (ph === 'pass' || ph === 'rolling' || ph === 'moving') {
      const t = activeTok();
      const p = P(activePid());
      const mate = g.teamMode ? R.teammateId(g) : null;
      const sub = [mate ? `${esc(pname(mate))} guesses` : 'Everyone else guesses', g.teamMode ? esc(t.name) : null].filter(Boolean).join(' · ');
      const right = ph === 'pass'
        ? `<div class="nowup-key"><kbd>Space</kbd> ${R.needsFinaleWithoutRoll(g) ? 'Play the Finale' : 'Roll'}</div>`
        : `<div class="nowup-die">${dieHtml()}</div>`;
      html = `<div class="nowup-tok" style="--c:${p.color}">${p.emoji}</div>
        <div class="nowup-text"><div class="nowup-label">Now up</div><div class="nowup-name">${esc(p.name)}</div><div class="nowup-sub">${sub}</div></div>${right}`;
    }
    // Keep the die element alive during the roll so its animation isn't reset.
    if (!(ph === 'moving' && banner.querySelector('#cube'))) banner.innerHTML = html;
    banner.classList.toggle('show', !!html);
  }
  const dock = $('#dock');
  if (dock && g) {
    const lead = R.leaderId(g);
    dock.innerHTML = g.tokens.map((t, k) => {
      const active = k === g.turnIdx;
      const streak = (g.stats.streak || {})[t.id] || 0;
      const members = g.teamMode ? `<span class="pc-sub">${t.memberIds.map(pname).map(esc).join(' + ')}</span>` : '';
      return `<div class="pcard ${active ? 'active' : ''}" style="--c:${t.color}">
        <span class="pc-tok">${t.emoji}${lead === t.id ? `<span class="pc-crown">${icon('crown')}</span>` : ''}</span>
        <span class="pc-name">${esc(t.name)}${members}</span>
        <span class="pc-badges">${streak >= 2 ? `<span class="pc-fire">${icon('flame')}${streak}</span>` : ''}${t.skipNext ? `<span class="pc-skip">${icon('stamp')}</span>` : ''}</span>
        <span class="pc-pos">${t.pos}<small>/23</small></span>
        <span class="pc-bar"><i style="width:${(t.pos / R.FINALE) * 100}%"></i></span>
      </div>`;
    }).join('');
  }
}

function renderTokens() {
  const layer = $('#tokens');
  if (!layer || !store.game) return;
  const toks = store.game.tokens;
  const groups = {};
  toks.forEach(t => { const p = store.displayPos[t.id] ?? t.pos; (groups[p] = groups[p] || []).push(t.id); });
  const activeId = store.game.tokens[store.game.turnIdx].id;
  for (const t of toks) {
    let el = layer.querySelector(`[data-id="${t.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'token';
      el.dataset.id = t.id;
      el.style.setProperty('--c', t.color);
      el.innerHTML = `<span class="tok-shadow"></span><span class="tok-body"><span>${t.emoji}</span></span>`;
      layer.appendChild(el);
    }
    const pos = store.displayPos[t.id] ?? t.pos;
    const grp = groups[pos];
    const k = grp.indexOf(t.id);
    const r = squareRect(pos);
    const offs = [[0, 0], [30, 10], [-30, 10], [30, -22], [-30, -22], [0, 26]];
    const [ox, oy] = grp.length > 1 ? offs[k] : [0, 0];
    el.style.transform = `translate(${r.x + r.w / 2 - 32 + ox}px, ${r.y - 34 + oy}px)`;
    el.style.zIndex = t.id === activeId ? 5 : 2 + k;
    el.classList.toggle('active', t.id === activeId && store.phase === 'pass');
  }
}

function diffDots(d) {
  const n = { easy: 1, medium: 2, hard: 3 }[d] || 1;
  return `<span class="diff">${[1, 2, 3].map(k => `<i class="${k <= n ? 'on' : ''}"></i>`).join('')}${d[0].toUpperCase() + d.slice(1)}</span>`;
}

function chipPicker(pids, { nobody = false, label = 'Nobody' } = {}) {
  const all = store.game.players;
  return `<div class="pick-chips">${pids.map(pid => {
    const p = P(pid); const num = all.findIndex(x => x.id === pid) + 1;
    return `<button class="pick-chip" data-act="pick-player" data-pid="${pid}"><kbd>${num}</kbd><span class="chip-tok" style="--c:${p.color}">${p.emoji}</span>${esc(p.name)}</button>`;
  }).join('')}${nobody ? `<button class="pick-chip nobody" data-act="pick-player" data-pid=""><kbd>0</kbd>${label}</button>` : ''}</div>`;
}

function timerRing(seconds, cls = '') {
  return `<div class="ring-wrap ${cls}"><svg class="ring" viewBox="0 0 200 200"><circle class="ring-bg" cx="100" cy="100" r="88"/><circle class="ring-fg" id="ring-fg" cx="100" cy="100" r="88"/></svg><div class="ring-num" id="ring-num">${seconds}</div></div>`;
}

function renderOverlay() {
  const ov = $('#overlay');
  const { html, key } = overlayHtml();
  $('#stage').classList.toggle('ov-open', !!html);
  if (!html) { ov.innerHTML = ''; ov.className = ''; store.ovKey = null; return; }
  ov.className = 'show';
  ov.innerHTML = html;
  const first = key !== store.ovKey;
  store.ovKey = key;
  const root = ov.firstElementChild;
  if (root && first) root.classList.add('enter');
  updateTimerUi();
}

function overlayHtml() {
  const ph = store.phase;
  const g = store.game;
  const none = { html: '', key: null };
  if (store.screen !== 'board' || !g) return none;
  const ctx = store.ctx;
  if (ph === 'special' || ph === 'skipped') {
    return { key: 'sp-' + g.turnCount + ph, html: `<div class="ov ov-moment sp-${ctx.square.type}">${momentHtml(ctx.square, { skippedName: ph === 'skipped' ? pname(ctx.pid) : null })}</div>` };
  }
  if (ph === 'pick') {
    const tiles = R.CATEGORIES.map((c, k) => {
      const info = R.CATEGORY_INFO[c];
      return `<button class="tile cat-${c}" data-act="pick-cat" data-cat="${c}"><kbd>${k + 1}</kbd>${icon(info.icon, 'tile-ic')}<div class="tile-verb">${info.verb}</div><div class="tile-plain">${CATEGORY_PLAIN[c]}</div></button>`;
    }).join('');
    const name = esc(pname(activePid()));
    const head = ctx.finale
      ? `<div class="kicker">${icon('trophy')} Final challenge</div><h2>Everyone else: pick ${name}'s category</h2><p class="muted">It's a Hard card. Get it right and ${name} wins the game.</p>`
      : `<div class="kicker">${icon('shuffle')} Wild</div><h2>${name}, pick a category</h2><p class="muted">Press 1–4.</p>`;
    return { key: 'pick-' + g.turnCount, html: `<div class="ov ov-pick ${ctx.finale ? 'finale' : ''}"><div class="ov-inner">${head}<div class="tiles">${tiles}</div></div></div>` };
  }
  if (ph === 'reveal') return { key: 'rv-' + ctx.card.id + (ctx.peeks || 0), html: revealHtml() };
  if (ctx && ctx.allplay && ph.startsWith('ap-')) return { key: 'ap-' + ctx.card.id, html: allPlayHtml() };
  if (ctx && ctx.card && ['card-hidden', 'card-ready', 'running', 'timeup', 'guesser', 'steal'].includes(ph)) return { key: 'card-' + ctx.card.id + (ctx.sudden ? 's' : ''), html: cardHtml() };
  return none;
}

function whoLine(card) {
  const g = store.game;
  if (store.ctx.sudden) return `${icon('users')} Tied players race to shout`;
  if (card.category === 'brains') return `${icon('eye')} Quizmaster: <b>${esc(pname(store.ctx.quizmaster))}</b>`;
  if (g.teamMode) return `${icon('users')} <b>${esc(pname(R.teammateId(g)))}</b> guesses`;
  return `${icon('users')} Everyone else races to guess`;
}

function questionHtml(card) {
  let h = `<div class="question">${esc(card.prompt)}</div>`;
  if (card.options) h += `<div class="options">${card.options.map((o, k) => `<span><b>${'ABCD'[k]}</b>${esc(o)}</span>`).join('')}</div>`;
  return h;
}

function cardHtml() {
  const { card, finale, sudden, quizmaster } = store.ctx;
  const ph = store.phase;
  const g = store.game;
  const mg = MINI_GAMES[card.game];
  const info = R.CATEGORY_INFO[card.category];
  const brains = card.category === 'brains';
  const name = esc(pname(activePid()));
  const tvLine = sudden ? 'First tied player to shout the right answer wins the game.' : esc(mg.tv(pname(activePid()), card));
  const showQuestion = brains && ph !== 'card-hidden';
  const isNew = !store.seenGames.has(card.game) && !sudden;
  let action = '';
  if (ph === 'card-hidden') {
    if (sudden) action = `<div class="look-away">${icon('eye-off')} Sudden death: ${esc(sudden.names)}</div><div class="hint-line">Someone who isn't tied is quizmaster: <kbd>Space</kbd> to peek at the answer (6 s).</div>`;
    else if (brains && phoneMode()) action = `<div class="look-away">${icon('smartphone')} Pass the phone to ${esc(pname(quizmaster))}</div><div class="hint-line">${esc(pname(quizmaster))} has the answer. Tap Start, then read the question out loud.</div>`;
    else if (phoneMode()) action = `<div class="look-away">${icon('smartphone')} ${name}, check the phone</div><div class="hint-line">Hold to peek at the card, then tap Start.</div>`;
    else if (brains) action = `<div class="look-away">${icon('eye-off')} Everyone except ${esc(pname(quizmaster))}, look away</div><div class="hint-line">${esc(pname(quizmaster))} is quizmaster: <kbd>Space</kbd> to peek at the answer (6 s).</div>`;
    else action = `<div class="look-away">${icon('eye-off')} Everyone except ${name}, look away</div><div class="hint-line">${name}: <kbd>Space</kbd> to peek at the card (6 s).</div>`;
  } else if (ph === 'card-ready' && phoneMode()) {
    action = `<div class="hint-line">Tap Start on the phone when ready</div>`;
  } else if (ph === 'card-ready') {
    action = `<div class="hint-line"><kbd>Space</kbd> start the ${mg.seconds} s timer${brains ? ' and read the question out' : ''} · <kbd>P</kbd> peek again</div>`;
  } else if (ph === 'running' || ph === 'timeup') {
    const judge = brains && !sudden ? `${esc(pname(quizmaster))} judges: ` : '';
    action = `${timerRing(mg.seconds, brains ? 'small' : '')}<div class="hint-line">${ph === 'timeup' ? '<b>Time!</b> ' : ''}${judge}<kbd>Y</kbd> ${brains ? 'Correct' : 'Got it'} · <kbd>N</kbd> ${brains ? 'Wrong' : 'Failed'}</div>`;
  } else if (ph === 'guesser') {
    const pids = sudden ? sudden.pids : R.otherPlayers(g).map(p => p.id);
    action = `<div class="big-line">${sudden ? 'Who shouted it first?' : 'Who guessed it first?'}</div>${chipPicker(pids)}<div class="hint-line"><kbd>Esc</kbd> back</div>`;
  } else if (ph === 'steal') {
    const q = brains ? `Wrong! ${g.teamMode ? 'The other team gets one guess.' : 'Anyone else can shout it.'}` : 'The other team gets one guess.';
    action = `<div class="big-line">${q}</div>${chipPicker(stealOptions(), { nobody: true })}${brains ? `<div class="hint-line">${esc(pname(quizmaster))} picks who stole it, or <kbd>0</kbd> nobody</div>` : ''}`;
  }
  return `<div class="ov ov-cat cat-${card.category} ${store.ctx.washed ? '' : 'wash'} ${brains ? 'is-brains' : ''}">
    <div class="watermark">${icon(info.icon)}</div>
    <div class="ov-inner">
      <div class="cat-head"><span class="cat-pill">${icon(info.icon)} ${info.verb}</span><span class="cat-plain">${CATEGORY_PLAIN[card.category]}</span><span class="cat-pun">${info.name}</span></div>
      ${finale ? `<div class="finale-tag">${icon('trophy')} Final challenge · win it to win the game</div>` : ''}
      <div class="game-name">${isNew ? '<span class="new-tag">New</span>' : ''}${esc(mg.name)}</div>
      ${showQuestion ? questionHtml(card) : `<div class="tv-line">${tvLine}</div>`}
      <div class="meta">${diffDots(card.difficulty)}<span class="sep"></span><span>${whoLine(card)}</span><span class="sep"></span><span>${icon('timer')} ${mg.seconds} s</span></div>
      <div class="ov-action">${action}</div>
    </div>
  </div>`;
}

/** The ONLY place a secret is rendered on the TV (hot-seat privacy step). */
function revealHtml() {
  const { card, sudden, quizmaster } = store.ctx;
  const mg = MINI_GAMES[card.game];
  const info = R.CATEGORY_INFO[card.category];
  const brains = card.category === 'brains';
  let body = '';
  if (brains) {
    body = `<div class="pk-label">Answer</div><div class="pk-main" id="secret">${esc(card.answer)}</div>
      ${card.tolerance != null ? `<div class="pk-row">Counts if within ± ${esc(card.tolerance)}</div>` : ''}
      <div class="pk-row muted">Question: ${esc(card.prompt)}</div>`;
  } else {
    body = `<div class="pk-label">${card.game === 'hum' ? 'Hum this song' : card.category === 'draw' ? 'Draw this' : card.category === 'act' ? 'Act this' : 'Your word'}</div>
      <div class="pk-main" id="secret">${esc(card.prompt)}</div>
      ${card.game === 'hum' && card.answer ? `<div class="pk-row">by ${esc(card.answer)}</div>` : ''}
      ${card.accent ? `<div class="pk-row">Accent: <b>${esc(card.accent)}</b></div>` : ''}
      ${card.forbidden ? `<div class="pk-label">Don't say</div><div class="pk-chips">${card.forbidden.map(w => `<span>${esc(w)}</span>`).join('')}</div>` : ''}`;
  }
  if (card.hint_en) body += `<div class="pk-hint">${icon('lightbulb')} ${esc(card.hint_en)}</div>`;
  const who = sudden ? 'Quizmaster only' : brains ? `${esc(pname(quizmaster))} only` : `${esc(pname(activePid()))} only`;
  return `<div class="ov ov-reveal"><div class="ov-inner">
    <div class="rv-who">${icon('eye')} ${who}</div>
    <div class="peek-card cat-${card.category}">
      <div class="pk-head">${icon(info.icon)} ${esc(mg.name)} ${diffDots(card.difficulty)}</div>
      <div class="pk-body">${body}</div>
    </div>
    <div class="rv-bar"><span id="rv-fill"></span></div>
    <div class="hint-line"><kbd>Space</kbd> hide now</div>
  </div></div>`;
}

function allPlayHtml() {
  const { card, sr } = store.ctx;
  const ph = store.phase;
  const mg = MINI_GAMES[card.game];
  const g = store.game;
  let body = '';
  let action = '';
  if (card.game === 'speedround' && sr && (ph === 'ap-q' || ph === 'ap-a')) {
    const q = card.questions[sr.i];
    const tally = g.players.filter(p => sr.score[p.id]).map(p => `<span class="tally"><span class="chip-tok" style="--c:${p.color}">${p.emoji}</span>${sr.score[p.id]}</span>`).join('');
    body = `<div class="sr-count">Question ${sr.i + 1} of 3</div><div class="question">${esc(q.q)}</div>
      ${ph === 'ap-a' ? `<div class="sr-answer">${icon('check')} ${esc(q.a)}</div>` : ''}<div class="tallies">${tally}</div>`;
    action = ph === 'ap-q'
      ? `<div class="hint-line">Everyone shout! <kbd>Space</kbd> reveal the answer</div>`
      : `<div class="big-line small">Who shouted it first?</div>${chipPicker(g.players.map(p => p.id), { nobody: true })}`;
  } else {
    body = `<div class="ap-prompt">${esc(card.prompt)}</div>`;
    if (card.game === 'estimateoff' && ph === 'ap-pick') body += `<div class="sr-answer">${icon('check')} Answer: ${esc(card.answer)}</div>`;
    if (card.hint_en) body += `<div class="ap-hint">${icon('lightbulb')} ${esc(card.hint_en)}</div>`;
    if (ph === 'ap-ready') action = `<div class="hint-line"><kbd>Space</kbd> ${card.game === 'speedround' ? 'first question' : `start the ${mg.seconds} s timer`}</div>`;
    else if (ph === 'ap-running') action = `${timerRing(mg.seconds, 'small')}<div class="hint-line"><kbd>Space</kbd> stop early</div>`;
    else if (ph === 'ap-pick') action = `<div class="big-line small">${card.game === 'estimateoff' ? 'Who was closest?' : 'Who drew the best one?'} +2${g.teamMode ? ' for their team' : ''}</div>${chipPicker(g.players.map(p => p.id), { nobody: true })}`;
  }
  return `<div class="ov ov-allplay">
    <div class="stripe">${R.CATEGORIES.map(c => `<i class="cat-${c}"></i>`).join('')}</div>
    <div class="ov-inner">
      <div class="cat-head"><span class="cat-pill light">${icon('users')} All Play</span><span class="cat-plain">${CATEGORY_PLAIN.allplay}</span></div>
      <div class="game-name">${esc(mg.name)}</div>
      <div class="tv-line">${esc(mg.tv())}</div>
      ${body}
      <div class="ov-action">${action}</div>
    </div>
  </div>`;
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
    return `<div class="pod place-${place}" style="--c:${t.color}"><div class="pod-tok">${t.emoji}${place === 1 ? `<span class="pod-crown">${icon('crown')}</span>` : ''}</div><div class="pod-name">${esc(t.name)}</div>${members}<div class="pod-block"><span>${place}</span></div></div>`;
  }).join('');
  const stats = res.stats.map((s, k) => `<div class="stat" style="animation-delay:${1.4 + k * 0.15}s"><div class="stat-label">${esc(s.label)}</div><div class="stat-value">${esc(s.value)}</div><div class="stat-detail">${esc(s.detail)}</div></div>`).join('');
  return `
  <div class="winner">
    <div class="win-kicker">${esc(res.reason)}</div>
    <h1>${esc(rank[0].name)} win${g.teamMode ? '' : 's'}!</h1>
    <div class="podium">${podium}</div>
    <div class="stats">${stats}</div>
    <div class="ticket"><div class="ticket-head">${icon('receipt')} Strafzettel · ${esc(res.last.name)}</div><div class="ticket-text">${esc(res.penalty)}</div></div>
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
  const hasKey = !!getKey();
  el.className = 'show';
  el.innerHTML = `<div class="settings-card">
    <h2>Settings</h2>
    <label class="field col"><span>Anthropic API key <span class="muted small">(stays in this browser only)</span></span>
      <span class="key-row"><input id="set-key" type="password" autocomplete="off" spellcheck="false" placeholder="${hasKey ? 'Saved. Paste a new key to replace it' : 'sk-ant-…'}">
      <button class="btn ghost small-btn" data-act="test-key">Test key</button>${hasKey ? `<button class="btn ghost small-btn" data-act="forget-key">Forget</button>` : ''}</span>
      <span class="key-msg" id="key-msg">${esc(store.keyMsg)}</span></label>
    <label class="field"><span>Model</span>
      <select id="set-model">${MODELS.map(m => `<option value="${m.id}" ${s.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
    <label class="field"><span>Game length</span>
      <select id="set-length">${[20, 30, 40, 2].map(m => `<option value="${m}" ${s.lengthMin === m ? 'selected' : ''}>${m === 2 ? '2 min (test)' : m + ' min'}</option>`).join('')}</select></label>
    <label class="field"><span>Clean ↔ cheeky</span><input type="range" id="set-cheeky" min="0" max="100" step="10" value="${s.cheeky}"></label>
    <label class="field"><span>German flavour <b id="german-val">${s.german}%</b></span><input type="range" id="set-german" min="0" max="50" step="5" value="${s.german}"></label>
    <label class="toggle"><input type="checkbox" id="set-sound" ${s.sound ? 'checked' : ''}><span class="sw"></span> Sound <kbd>M</kbd></label>
    <div class="win-actions"><button class="btn ghost" data-act="close-settings">Cancel</button><button class="btn primary" data-act="save-settings">Save</button></div>
  </div>`;
}

// ---------- fresh decks ----------
const genSettings = () => ({ germanPct: store.settings.german, cleanPct: 100 - Math.round(store.settings.cheeky * 0.6), topics: store.brief.topics || [] });

/** Generate a deck in the background. target 'current' feeds the live game; 'next' is saved for Rematch. */
async function runGeneration(target = 'current', { force = false } = {}) {
  const key = getKey();
  if (!key || !store.backupCards.length) return;
  if (target === 'current' && store.gen && store.gen.running && !force) return;
  const gen = { id: Date.now() + Math.random(), cards: {}, running: true, status: {}, error: null, topics: topicsKey() };
  GEN_CATEGORIES.forEach(c => { gen.status[c] = 'pending'; });
  if (target === 'current') {
    store.gen = gen;
    // A game is already running: swap fresh cards into it as they land.
    if (store.deck && (store.screen === 'board' || store.screen === 'howto')) { store.deckGenId = gen.id; gen.used = true; }
  } else store.prefetching = true;
  renderGenStatus();
  await generateDeck({
    key, model: store.settings.model, settings: genSettings(),
    seenList: lsGet('spielchen.seen', []), backupCards: store.backupCards,
    onCategory: (cat, cards, fresh, err) => {
      if (target === 'current' && store.gen !== gen) return;       // a newer brief replaced this run
      if (cards) {
        gen.cards[cat] = cards;
        gen.status[cat] = 'ready';
        if (target === 'current' && store.deck && store.deckGenId === gen.id) store.deck.setCategory(cat, cards);
      } else {
        gen.status[cat] = 'failed';
        if (!gen.error) {
          gen.error = err ? friendlyError(err) : 'The model sent no usable cards';
          if (target === 'current') say(`Fresh cards: ${gen.error}. Playing with the backup deck.`, 'bad');
        }
      }
      if (target === 'current') renderGenStatus();
    },
  });
  gen.running = false;
  if (target === 'next') {
    store.prefetching = false;
    if (Object.keys(gen.cards).length) lsSet('spielchen.nextDeck', { cards: gen.cards, savedAt: Date.now(), topics: gen.topics });
  }
  if (target === 'current' && store.gen === gen) renderGenStatus();
}

/** Status line for the chat panel / phone, e.g. "Writing cards… 3/5". */
function genStatusText() {
  if (!getKey()) return '';
  const g = store.gen;
  if (!g) return '';
  const n = GEN_CATEGORIES.filter(c => g.status && g.status[c] === 'ready' || g.cards[c]).length;
  if (g.running) return `Writing cards… ${n}/5 ready`;
  if (g.error && n === 0) return `Couldn't make cards: ${g.error}`;
  if (g.error) return `${n}/5 fresh · the rest from the backup deck (${g.error})`;
  const total = GEN_CATEGORIES.reduce((a, c) => a + ((g.cards[c] || []).length), 0);
  return `${total} fresh cards ready`;
}

function renderGenStatus() {
  renderTopbar();
  const el = $('#brief-status');
  if (el) el.textContent = genStatusText();
  pushPhone();
}

// ---------- card brief chat ----------
async function sendBrief(text) {
  text = String(text || '').trim().slice(0, 160);
  if (!text || store.briefBusy) return;
  const b = store.brief;
  const surprise = text === SURPRISE || /^surprise/i.test(text);
  b.messages = surprise ? [] : [...b.messages, text].slice(-3);
  b.chat = [...b.chat, { from: 'me', text }].slice(-6);
  store.briefBusy = true;
  renderBriefPanel();
  let reply, topics;
  if (surprise) {
    topics = [];
    reply = 'Surprise it is: a fun mix of film, music, travel, food and general knowledge.';
  } else if (!getKey()) {
    topics = topicsFromText(b.messages);
    reply = `Saved: ${topics.join(', ') || 'a fun mix'}. Add an API key in Settings and I'll write the cards.`;
  } else {
    try {
      const out = await complete({ key: getKey(), model: DEFAULT_MODEL, system: BRIEF_SYSTEM, user: briefPrompt(b.messages), maxTokens: 600, timeoutMs: 15000 });
      ({ reply, topics } = parseBrief(out, b.messages));
    } catch (e) {
      topics = topicsFromText(b.messages);
      reply = `(${friendlyError(e)}) I'll go with: ${topics.join(', ') || 'a fun mix'}.`;
    }
  }
  b.topics = topics;
  b.chat = [...b.chat, { from: 'claude', text: reply }].slice(-6);
  store.briefBusy = false;
  saveBrief();
  try { localStorage.removeItem('spielchen.nextDeck'); } catch { /* stale: made for the old brief */ }
  renderBriefPanel();
  if (getKey()) runGeneration('current', { force: true });
}

function briefPanelInner() {
  const b = store.brief;
  const chat = b.chat.slice(-3).map(m => `<div class="bubble ${m.from}">${m.from === 'claude' ? icon('mic') : ''}<span>${esc(m.text)}</span></div>`).join('');
  const intro = !b.chat.length ? `<div class="bubble claude">${icon('mic')}<span>${getKey() ? 'Tell me what you’re into, or tap a topic. I’ll write the deck around it.' : 'Add an API key in Settings and I’ll write cards around your topics.'}</span></div>` : '';
  return `<div class="brief-head">${icon('message-circle')} What should the cards be about?</div>
    <div class="brief-chat">${intro}${chat}${store.briefBusy ? '<div class="bubble claude typing"><i></i><i></i><i></i></div>' : ''}</div>
    <div class="brief-chips">${BRIEF_CHIPS.map(c => `<button class="bchip" data-act="brief-chip" data-text="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div class="brief-row"><input id="brief-tv" maxlength="160" placeholder="e.g. 90s music, football, less politics" autocomplete="off" spellcheck="false"><button class="btn primary small-btn" data-act="brief-send">Send</button></div>
    <div class="brief-status" id="brief-status">${esc(genStatusText())}</div>`;
}

function renderBriefPanel() {
  const el = $('#brief-panel');
  if (el) {
    const input = $('#brief-tv');
    const keep = input && document.activeElement === input;
    el.innerHTML = briefPanelInner();
    if (keep) $('#brief-tv').focus();
  }
  pushPhone();
}

/** Pick the cards for a new game: a prefetched deck if there is one, else whatever is ready (backup for the rest). */
function deckForNewGame() {
  const next = lsGet('spielchen.nextDeck', null);
  if (next && next.cards && Object.keys(next.cards).length && (next.topics || '[]') === topicsKey()) {
    try { localStorage.removeItem('spielchen.nextDeck'); } catch { /* ignore */ }
    store.gen = { id: Date.now() + Math.random(), cards: next.cards, running: false };
  } else if (!store.gen || store.gen.used) {
    store.gen = null;
    runGeneration('current');   // never blocks: categories swap in as they land
  }
  const gen = store.gen;
  if (gen) gen.used = true;
  store.deckGenId = gen ? gen.id : null;
  const cards = [];
  for (const cat of GEN_CATEGORIES) {
    const fresh = gen && gen.cards[cat];
    cards.push(...(fresh || store.backupCards.filter(c => c.category === cat)));
  }
  return cards;
}

// ---------- phone protocol ----------
const pub = p => p ? { id: p.id, name: p.name, color: p.color, emoji: p.emoji } : null;

function phoneState(role) {
  const g = store.game;
  const players = (g ? g.players : store.setup.players.map((p, k) => ({ ...p, name: (p.name || '').trim() || `Player ${k + 1}` }))).map(pub);
  const base = { t: 'state', role, screen: store.screen, phase: store.phase, players, view: 'lobby',
    brief: store.screen === 'setup' ? { hasKey: !!getKey(), chat: store.brief.chat.slice(-2), status: store.briefBusy ? 'Claude is thinking…' : genStatusText(), chips: BRIEF_CHIPS } : null };
  if (store.screen === 'winner' && store.result) {
    return { ...base, view: role === 'controller' ? 'winner' : 'spectator', winner: store.result.ranking[0].name, positions: store.result.ranking.map(t => ({ name: t.name, emoji: t.emoji, color: t.color, pos: t.pos })) };
  }
  if (!g || store.screen !== 'board') return base;
  const active = P(activePid());
  base.active = pub(active);
  base.positions = g.tokens.map((t, k) => ({ name: t.name, emoji: t.emoji, color: t.color, pos: t.pos, active: k === g.turnIdx }));
  if (role !== 'controller') return { ...base, view: 'spectator' };
  const ph = store.phase;
  const ctx = store.ctx || {};
  const turnKey = g.turnCount;
  const timerLeftMs = store.timer ? Math.max(0, store.timer.endsAt - Date.now()) : null;
  const cardInfo = card => {
    const mg = MINI_GAMES[card.game];
    return { ...card, gameName: mg.name, seconds: mg.seconds, tv: mg.tv(pname(activePid()), card), verb: R.CATEGORY_INFO[card.category].verb, quizmaster: ctx.quizmaster || null, sudden: !!ctx.sudden };
  };
  const holderFor = () => ctx.sudden ? null : (ctx.card && ctx.card.category === 'brains' ? pub(P(ctx.quizmaster)) : pub(active));
  const chips = pids => pids.map(pid => pub(P(pid)));
  switch (ph) {
    case 'pass': return { ...base, view: 'roll', holder: pub(active), holderKey: `${turnKey}:${active.id}`, finaleNext: R.needsFinaleWithoutRoll(g) };
    case 'pick': return { ...base, view: 'pick', finale: !!ctx.finale, holder: ctx.finale ? null : pub(active), holderKey: `${turnKey}:${active.id}` };
    case 'card-hidden': case 'card-ready': case 'reveal': {
      const h = holderFor();
      return { ...base, view: 'card', card: cardInfo(ctx.card), holder: h, holderKey: `${turnKey}:${h ? h.id : 'any'}` };
    }
    case 'running': case 'timeup': {
      const h = holderFor();
      return { ...base, view: 'running', card: cardInfo(ctx.card), holder: h, holderKey: `${turnKey}:${h ? h.id : 'any'}`, timerLeftMs, timeUp: ph === 'timeup' };
    }
    case 'guesser': {
      const pids = ctx.sudden ? ctx.sudden.pids : R.otherPlayers(g).map(p => p.id);
      return { ...base, view: 'chips', title: ctx.sudden ? 'Who shouted it first?' : 'Who guessed it first?', choices: chips(pids), nobody: false, back: true };
    }
    case 'steal': return { ...base, view: 'chips', title: 'Did someone steal it?', choices: chips(stealOptions()), nobody: true, back: true };
    case 'ap-ready': return { ...base, view: 'button', title: MINI_GAMES[ctx.card.game].name, text: ctx.card.prompt, label: ctx.sr ? 'First question' : 'Start the timer' };
    case 'ap-running': return { ...base, view: 'button', title: MINI_GAMES[ctx.card.game].name, text: ctx.card.prompt, label: 'Stop early', timerLeftMs };
    case 'ap-q': return { ...base, view: 'button', title: `Question ${ctx.sr.i + 1} of 3`, text: ctx.card.questions[ctx.sr.i].q, answer: ctx.card.questions[ctx.sr.i].a, label: 'Reveal the answer' };
    case 'ap-a': return { ...base, view: 'chips', title: 'Who shouted it first?', choices: chips(g.players.map(p => p.id)), nobody: true };
    case 'ap-pick': return { ...base, view: 'chips', title: ctx.card.game === 'estimateoff' ? `Who was closest? (${ctx.card.answer})` : 'Who drew the best one?', choices: chips(g.players.map(p => p.id)), nobody: true };
    default: return { ...base, view: 'watch' };
  }
}

function pushPhone() { if (store.net) store.net.broadcast(phoneState); }

/** Messages from the controller phone. */
function handleAction(msg) {
  const ph = store.phase;
  if (msg.t === 'rematch' && store.screen === 'winner') return startGame({ rematch: true });
  if (msg.t === 'newgame' && store.screen === 'winner') return newGame();
  if (msg.t === 'startgame' && store.screen === 'setup') return startGame();
  if (msg.t === 'brief' && store.screen === 'setup') return sendBrief(msg.text);
  if (msg.t === 'skip' && store.screen === 'howto') return leaveHowTo();
  if (store.screen !== 'board' || store.busy) return;
  switch (msg.t) {
    case 'roll': if (ph === 'pass') doRoll(); break;
    case 'start':
      if (ph === 'card-hidden' || ph === 'card-ready') startRound();
      else if (ph === 'reveal') { hideReveal(); startRound(); }
      else if (ph === 'ap-ready' || ph === 'ap-running' || ph === 'ap-q') handleKey({ key: ' ', target: {}, preventDefault() {} });
      break;
    case 'result': if (ph === 'running' || ph === 'timeup') { if (msg.ok) onGotIt(); else onFailed(); } break;
    case 'player':
      if (['guesser', 'steal', 'ap-pick', 'ap-a'].includes(ph)) { if (msg.pid || ph !== 'guesser') pickPlayer(msg.pid || ''); }
      break;
    case 'back': if (ph === 'guesser' || ph === 'steal') setPhase('timeup'); break;
    case 'pick': if (ph === 'pick' && R.CATEGORIES.includes(msg.category)) pickCategory(msg.category); break;
    case 'undo': if (ph === 'pass') undo(); else if (ph === 'guesser' || ph === 'steal') setPhase('timeup'); break;
  }
}

function startNet() {
  store.net = new HostNet({
    onAction: handleAction,
    onStatus: st => {
      store.netStatus = st;
      store.room = store.net.code;
      try { sessionStorage.setItem('spielchen.tvroom', store.room); } catch { /* ignore */ }
      if (st === 'connected') { store.hadPhone = true; store.phoneLostAt = 0; }
      else if (!store.phoneLostAt) store.phoneLostAt = Date.now();
      if (store.screen === 'setup') render(); else renderTopbar();
    },
    onController: on => {
      if (on && store.hotseat) { store.hotseat = false; render(); }
      pushPhone();
    },
  });
  let saved = null;
  try { saved = sessionStorage.getItem('spielchen.tvroom'); } catch { /* ignore */ }
  const ok = store.net.start(saved || makeRoomCode(), { resume: !!saved });
  store.room = store.net.code;
  if (!ok) store.net = null;
}

// ---------- ticker (results + commentary) ----------
let tickerBusy = false;
function say(line, kind = 'info') {
  if (!line) return;
  store.ticker.push({ line, kind });
  while (store.ticker.length > 2) store.ticker.shift();   // never show stale news
  if (!tickerBusy) nextTicker();
}
async function nextTicker() {
  const item = store.ticker.shift();
  const el = $('#ticker');
  if (!item || !el) { tickerBusy = false; return; }
  tickerBusy = true;
  el.innerHTML = `${icon(item.kind === 'comment' ? 'mic' : item.kind === 'good' ? 'check' : 'arrow-right')}<span>${esc(item.line)}</span>`;
  el.className = `ticker show ${item.kind}`;
  await wait(2600);
  el.className = 'ticker';
  await wait(300);
  nextTicker();
}

// ---------- timers & clock ----------
function updateTimerUi() {
  const fg = $('#ring-fg');
  const num = $('#ring-num');
  if (!fg || !num) return;
  const C = 2 * Math.PI * 88;
  fg.style.strokeDasharray = `${C}`;
  if (store.timer) {
    const left = Math.max(0, store.timer.endsAt - Date.now());
    fg.style.strokeDashoffset = `${C * (1 - left / (store.timer.seconds * 1000))}`;
    num.textContent = Math.ceil(left / 1000);
    num.parentElement.classList.toggle('low', left <= 5000);
  } else {
    fg.style.strokeDashoffset = ['timeup', 'ap-pick'].includes(store.phase) ? `${C}` : '0';
    if (store.phase === 'timeup') { num.textContent = '0'; num.parentElement.classList.add('low'); }
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
    if (left <= 0) { store.timer = null; sfx.buzzer(); t.onDone && t.onDone(); }
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
  renderRejoin();
  const fill = $('#clock-fill');
  if (fill) fill.style.width = `${clockFrac() * 100}%`;
  const elapsed = Date.now() - store.clock.startedAt;
  if (!store.prefetched && elapsed >= store.prefetchAt && getKey()) { store.prefetched = true; runGeneration('next'); }
  if (elapsed >= store.clock.lastOrdersAt && store.game.lastOrders == null) {
    store.game = R.callLastOrders(store.game, store.phase !== 'pass');
    showLastOrders();
  }
  if (elapsed >= store.clock.lengthMs && !store.timeUp) {
    store.timeUp = true;
    if (store.phase === 'pass' && !store.busy) beginTurnFlow();
  }
}

async function showLastOrders() {
  const b = $('#lastorders');
  b.innerHTML = `<div class="lo-big">Last orders</div><div class="lo-sub">Everyone gets exactly one more turn · ${store.game.lastOrders} turns left</div>`;
  b.className = 'show';
  sfx.chime();
  renderTopbar();
  await wait(4000);
  b.className = '';
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
      hop(m.tokenId);
      sfx.hop();
      await wait(190);
    }
    squash(m.tokenId);
  }
  syncDisplay();
}

function retrigger(el, cls) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
const tokBody = id => document.querySelector(`.token[data-id="${id}"] .tok-body`);
function hop(id) { if (!reduceMotion()) retrigger(tokBody(id), 'hop'); }
function squash(id) { if (!reduceMotion()) retrigger(tokBody(id), 'squash'); }
function jumpAll() { if (!reduceMotion()) document.querySelectorAll('.tok-body').forEach((el, k) => setTimeout(() => retrigger(el, 'jump'), k * 90)); }

function syncDisplay() {
  if (!store.game) return;
  store.game.tokens.forEach(t => { store.displayPos[t.id] = t.pos; });
  renderTokens();
}

function shakeStage(kind) {
  if (reduceMotion()) return;
  const s = $('#stage');
  s.classList.remove('wobble', 'shake', 'flash'); void s.offsetWidth; s.classList.add(kind);
  setTimeout(() => s.classList.remove(kind), 700);
}

// ---------- game flow ----------
function setPhase(ph) { store.phase = ph; render(); }

function startGame({ rematch = false } = {}) {
  const ps = store.setup.players.map((p, k) => ({ ...p, name: (p.name || '').trim() || `Player ${k + 1}` }));
  store.setup.players.forEach((p, k) => { p.name = ps[k].name; });
  lsSet('spielchen.players', store.setup.players);
  const teamMode = R.teamsAllowed(ps.length) && store.setup.teamMode;
  if (teamMode && !validTeams(store.setup.teams, ps)) store.setup.teams = R.makeTeams(ps.map(p => p.id));
  saveSeen();
  const lengthMs = store.settings.lengthMin * 60000;
  store.game = R.createGame({ players: ps, teams: teamMode ? store.setup.teams : null });
  store.deck = new Deck(deckForNewGame(), Math.random, lsGet('spielchen.seen', []));
  store.prefetchAt = Math.min(10 * 60000, Math.round(lengthMs / 2));
  store.prefetched = false;
  store.displayPos = {};
  store.undo = [];
  store.timeUp = false;
  store.ctx = null;
  store.result = null;
  store.seenGames = new Set();
  store.ticker = [];
  store.clock = { startedAt: Date.now(), lengthMs, lastOrdersAt: R.lastOrdersAtMs(lengthMs) };
  sfx.unlock();
  $('#screen').innerHTML = '';
  store.phase = 'idle';
  if (rematch) {
    store.screen = 'board';
    render();
    beginTurnFlow();
  } else {
    store.screen = 'howto';
    render();
    runHowTo();
  }
}

/** Remember used cards across games so a rematch serves new ones first (last 400 ids). */
function saveSeen() {
  if (!store.deck) return;
  const prev = lsGet('spielchen.seen', []);
  const merged = [...prev.filter(id => !store.deck.used.includes(id)), ...store.deck.used].slice(-400);
  lsSet('spielchen.seen', merged);
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
    const pid = R.activePlayerId(g);
    store.game = r.state;
    store.busy = true;
    store.ctx = { square: R.BOARD[13], pid };
    setPhase('skipped');
    setTimeout(() => sfx.stamp(), 450);
    await wait(2800);
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
  const die = R.rollDie();
  store.die = die;
  setPhase('rolling');
  sfx.roll();
  await tumble(die, 600);
  store.phase = 'moving';
  const { state, from, to, square } = R.moveActive(store.game, die);
  store.game = state;
  renderBoardDynamic();
  await wait(200);
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
  else if (square.type === 'pfand') setTimeout(() => sfx.pfand(), 500);
  else if (square.type === 'burgeramt') setTimeout(() => sfx.stamp(), 450);
  else if (square.type === 'allplay') { sfx.fanfare(); jumpAll(); }
  else sfx.roll();
  if (square.type === 'pfand' || square.type === 'db' || square.type === 'burgeramt') {
    await wait(2300);
    const before = store.game;
    const { state, moves } = R.applySpecial(store.game, square.type);
    store.game = state;
    store.phase = 'resolving';
    render();
    await animateMoves(moves);
    say(commentFor({ type: 'special', square: square.type }, before, state), 'comment');
    await wait(600);
    store.busy = false;
    return endTurnFlow();
  }
  await wait(2600);
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
  const quizmaster = category === 'brains' && !sudden ? R.quizmasterId(store.game) : null;
  store.ctx = { card, finale, sudden, quizmaster, hard: finale || card.difficulty === 'hard', washed: false, peeks: 0 };
  setPhase('card-hidden');
  store.ctx.washed = true;
}

function reveal() {
  store.ctx.peeks = (store.ctx.peeks || 0) + 1;
  setPhase('reveal');
  const id = setTimeout(hideReveal, 6000);
  store.revealTimer = { endsAt: Date.now() + 6000, id };
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

const isBrains = () => store.ctx && store.ctx.card && store.ctx.card.category === 'brains';

/** Who may steal: everyone outside the active token, except the quizmaster (they know the answer). */
function stealOptions() {
  return R.otherPlayers(store.game).map(p => p.id).filter(id => id !== store.ctx.quizmaster);
}

function onGotIt() {
  stopTimer();
  store.ctx.elapsedMs = Date.now() - (store.ctx.startedAt || Date.now());
  if (store.ctx.sudden) return setPhase('guesser');
  if (store.game.teamMode || isBrains()) return resolveCard({ ok: true });
  setPhase('guesser');
}

function onFailed() {
  stopTimer();
  if (store.ctx.sudden) { sfx.fail(); return startCard('brains', { sudden: store.ctx.sudden }); }
  if (store.game.teamMode || isBrains()) return setPhase('steal');
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
    if (pid && !stealOptions().includes(pid)) return;
    return resolveCard({ ok: false, stealerId: pid || null });
  }
  if (ph === 'ap-pick') {
    if (pid && !g.players.some(p => p.id === pid)) return;
    return resolveAllPlay(pid ? [pid] : []);
  }
  if (ph === 'ap-a') {
    if (pid && !g.players.some(p => p.id === pid)) return;
    return nextSpeedQuestion(pid || null);
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
  store.seenGames.add(ctx.card.game);
  const before = store.game;
  const { state, moves, won } = R.applyCardResult(store.game, {
    ok, hard: ctx.hard, finale: ctx.finale, guesserId, stealerId, elapsedMs: ok ? ctx.elapsedMs : null,
  });
  store.game = state;
  store.phase = 'resolving';
  render();
  const who = pname(activePid());
  if (ok) { sfx.success(); confetti([`--${ctx.card.category}`], { burst: true, count: 70 }); }
  else { sfx.fail(); shakeStage('flash'); }
  if (won) say('Finale cleared!', 'good');
  else if (ok) say([`${who} stays`, ctx.hard ? '+1 for a Hard card' : null, guesserId ? `${pname(guesserId)} +1 for guessing` : null].filter(Boolean).join(' · '), 'good');
  else say([`${who} goes back`, stealerId ? `${pname(stealerId)} steals it: +1` : null].filter(Boolean).join(' · '), 'bad');
  await animateMoves(moves);
  if (!won) say(commentFor({ type: 'card', ok, guesserId, stealerId, finale: ctx.finale }, before, state), 'comment');
  await wait(500);
  store.busy = false;
  if (won) return winByToken(R.activeToken(store.game).id, 'Cleared the Finale.');
  endTurnFlow();
}

function startAllPlay() {
  const card = store.deck.draw('allplay');
  store.ctx = { card, allplay: true, sr: card.game === 'speedround' ? { i: 0, score: {} } : null };
  setPhase('ap-ready');
}

function nextSpeedQuestion(pid) {
  const sr = store.ctx.sr;
  if (pid) { sr.score[pid] = (sr.score[pid] || 0) + 1; sfx.success(); }
  sr.i += 1;
  if (sr.i < store.ctx.card.questions.length) return setPhase('ap-q');
  const best = Math.max(0, ...Object.values(sr.score));
  const winners = best > 0 ? Object.keys(sr.score).filter(id => sr.score[id] === best) : [];
  resolveAllPlay(winners);
}

async function resolveAllPlay(winners) {
  pushUndo(store.ctx.sr ? 'ap-q' : 'ap-pick');
  if (store.ctx.sr) store.undo[store.undo.length - 1].ctx = { ...store.ctx, sr: { i: 0, score: {} } };
  store.busy = true;
  const before = store.game;
  const { state, moves } = R.applyAllPlayResult(store.game, winners);
  store.game = state;
  store.phase = 'resolving';
  render();
  if (winners.length) { sfx.success(); confetti(null, { burst: true, count: 90 }); say(`${winners.map(pname).join(' & ')} +2`, 'good'); }
  await animateMoves(moves);
  say(commentFor({ type: 'allplay', winners }, before, state), 'comment');
  await wait(500);
  store.busy = false;
  endTurnFlow();
}

function endTurnFlow() {
  store.game = R.endTurn(store.game);
  store.ctx = null;
  beginTurnFlow();
}

function undo() {
  const snap = store.undo.pop();
  if (!snap) return say('Nothing to undo');
  stopTimer();
  store.game = snap.game;
  store.ctx = snap.ctx;
  syncDisplay();
  setPhase(snap.phase);
  say('Undone. Pick the result again.');
}

function finishGame() {
  const d = R.decideWinner(store.game);
  if (d.suddenDeath) {
    const toks = store.game.tokens.filter(t => d.suddenDeath.includes(t.id));
    const pids = toks.flatMap(t => t.memberIds);
    say('It’s a tie! Sudden death.', 'comment');
    return startCard('brains', { sudden: { tokenIds: d.suddenDeath, pids, names: toks.map(t => t.name).join(' vs ') } });
  }
  const reason = store.game.winnerId ? 'Cleared the Finale' : (store.timeUp ? 'Time’s up · furthest token wins' : 'Last orders are in · furthest token wins');
  winByToken(d.winnerId, reason);
}

function winByToken(tokenId, reason) {
  const g = store.game;
  if (!g.winnerId) g.winnerId = tokenId;
  stopTimer();
  saveSeen();
  const ranking = R.ranking(g);
  store.result = {
    ranking,
    reason: reason.replace(/\.$/, ''),
    stats: R.autoStats(g),
    last: ranking[ranking.length - 1],
    penalty: PENALTIES[Math.floor(Math.random() * PENALTIES.length)],
  };
  store.ctx = null;
  store.ticker = [];
  store.phase = 'over';
  store.screen = 'winner';
  $('#screen').innerHTML = '';
  render();
  sfx.fanfare();
  setTimeout(() => confetti(null, { count: 160 }), 900);
}

function debugJump(n) {
  if (!(n >= 1 && n <= R.FINALE) || store.phase !== 'pass' || store.busy) return;
  const g = R.clone(store.game);
  const t = R.activeToken(g);
  g.turnStart = t.pos;
  t.pos = n;
  store.game = g;
  syncDisplay();
  say(`Debug: jumped to ${n}`);
  land(R.BOARD[n]);
}

// ---------- input ----------
function handleKey(e) {
  if (store.settingsOpen) { if (e.key === 'Escape') { store.settingsOpen = false; render(); } return; }
  const inInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (store.screen === 'setup') {
    if (k === 'Enter' && e.target && e.target.id === 'brief-tv') { e.preventDefault(); const v = e.target.value; e.target.value = ''; sendBrief(v); return; }
    if (k === 'Enter') { e.preventDefault(); startGame(); }
    else if (!inInput && k === 'h') { store.hotseat = !store.hotseat; render(); }
    else if (!inInput && k === 'f') toggleFullscreen();
    return;
  }
  if (inInput) return;

  if (k === 'f') { toggleFullscreen(); return; }
  if (k === 'm') { store.settings.sound = !store.settings.sound; saveSettings(); say(store.settings.sound ? 'Sound on' : 'Muted'); return; }
  if (k === 'h') { store.hotseat = !store.hotseat; say(store.hotseat ? 'Hot-seat mode: cards show on the TV' : (store.net && store.net.connected ? 'Phone mode: cards show on the phone' : 'No phone connected yet: scan the QR code')); render(); return; }

  if (store.screen === 'howto') { if (k === ' ' || k === 'Enter') { e.preventDefault(); leaveHowTo(); } return; }
  if (store.screen === 'winner') {
    if (k === 'r') startGame({ rematch: true });
    else if (k === 'n') newGame();
    return;
  }
  if (store.screen !== 'board') return;

  // Debug jump: D, then digits, then Enter.
  if (store.debugBuf != null) {
    if (/^[0-9]$/.test(k)) { store.debugBuf += k; return; }
    if (k === 'Enter') { const n = parseInt(store.debugBuf, 10); store.debugBuf = null; debugJump(n); return; }
    store.debugBuf = null;
  }
  if (k === 'd' && store.phase === 'pass') { store.debugBuf = ''; return; }

  if (store.busy) return;
  const ph = store.phase;
  if (k === ' ') e.preventDefault();

  if (k === 'u') { if (ph === 'guesser' || ph === 'steal') setPhase('timeup'); else if (ph === 'pass') undo(); return; }

  switch (ph) {
    case 'pass': if (k === ' ') doRoll(); break;
    case 'pick': if (/^[1-4]$/.test(k)) pickCategory(R.CATEGORIES[+k - 1]); break;
    case 'card-hidden': if (k === ' ') { if (phoneMode()) startRound(); else reveal(); } break;
    case 'reveal': if (k === ' ') hideReveal(); break;
    case 'card-ready': if (k === ' ') startRound(); else if (k === 'p' && !phoneMode()) reveal(); break;
    case 'running': case 'timeup': if (k === 'y') onGotIt(); else if (k === 'n') onFailed(); break;
    case 'guesser': case 'steal': case 'ap-pick': case 'ap-a':
      if (/^[0-6]$/.test(k)) {
        if (k === '0') { if (ph !== 'guesser') pickPlayer(''); }
        else { const p = store.game.players[+k - 1]; if (p) pickPlayer(p.id); }
      } else if (k === 'Escape' && (ph === 'guesser' || ph === 'steal')) setPhase('timeup');
      break;
    case 'ap-ready':
      if (k === ' ') {
        if (store.ctx.sr) setPhase('ap-q');
        else { startTimer(MINI_GAMES[store.ctx.card.game].seconds, () => { if (store.phase === 'ap-running') setPhase('ap-pick'); }); setPhase('ap-running'); }
      }
      break;
    case 'ap-running': if (k === ' ') { stopTimer(); setPhase('ap-pick'); } break;
    case 'ap-q': if (k === ' ') setPhase('ap-a'); break;
  }
}

function pickCategory(cat) {
  if (store.phase !== 'pick') return;
  startCard(cat, { finale: !!store.ctx.finale });
}

function newGame() {
  saveSeen();
  store.screen = 'setup';
  store.game = null;
  store.clock = null;
  store.phase = 'idle';
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
    case 'save-settings': {
      const newKey = $('#set-key').value.trim();
      const hadKey = !!getKey();
      if (newKey) setKey(newKey);
      store.settings.lengthMin = +$('#set-length').value;
      store.settings.sound = $('#set-sound').checked;
      store.settings.model = $('#set-model').value;
      store.settings.cheeky = +$('#set-cheeky').value;
      store.settings.german = +$('#set-german').value;
      saveSettings();
      store.settingsOpen = false;
      store.keyMsg = '';
      render();
      if (newKey) {
        store.brief.chat = [...store.brief.chat, { from: 'claude', text: 'Checking your key…' }].slice(-6);
        renderBriefPanel();
        testKey(newKey, store.settings.model).then(r => {
          store.brief.chat = [...store.brief.chat.filter(m => m.text !== 'Checking your key…'), { from: 'claude', text: r.ok ? 'Key works. Writing your fresh cards now.' : `That key didn't work: ${r.message}.` }].slice(-6);
          saveBrief();
          renderBriefPanel();
          if (!r.ok) { say(`API key: ${r.message}`, 'bad'); store.gen = { id: 0, cards: {}, running: false, status: {}, error: r.message }; renderGenStatus(); return; }
          say(store.screen === 'board' ? 'Key works: fresh cards will swap into this game.' : 'Key works: writing fresh cards.', 'good');
          try { localStorage.removeItem('spielchen.nextDeck'); } catch { /* ignore */ }
          runGeneration('current', { force: true });
        });
      }
      break;
    }
    case 'close-settings': store.settingsOpen = false; store.keyMsg = ''; render(); break;
    case 'forget-key': setKey(''); store.keyMsg = 'Key removed from this browser.'; store.gen = null; render(); break;
    case 'test-key': {
      const k = $('#set-key').value.trim() || getKey();
      const msgEl = $('#key-msg');
      if (!k) { msgEl.textContent = 'Paste a key first.'; break; }
      msgEl.textContent = 'Testing…';
      testKey(k, $('#set-model').value).then(r => { store.keyMsg = (r.ok ? '✓ ' : '✗ ') + r.message; const el = $('#key-msg'); if (el) { el.textContent = store.keyMsg; el.className = 'key-msg ' + (r.ok ? 'ok' : 'bad'); } });
      break;
    }
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
    case 'brief-chip': sendBrief(btn.dataset.text); break;
    case 'brief-send': { const i = $('#brief-tv'); if (i) { const v = i.value; i.value = ''; sendBrief(v); } break; }
    case 'skip-howto': leaveHowTo(); break;
    case 'pick-cat': pickCategory(btn.dataset.cat); break;
    case 'pick-player': if (!store.busy) pickPlayer(btn.dataset.pid); break;
    case 'rematch': startGame({ rematch: true }); break;
    case 'newgame': newGame(); break;
  }
}

function handleInput(e) {
  if (e.target.classList.contains('name')) store.setup.players[+e.target.dataset.k].name = e.target.value;
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
  document.addEventListener('keydown', handleKey);
  document.addEventListener('click', handleClick);
  document.addEventListener('input', handleInput);
  document.addEventListener('input', e => { if (e.target.id === 'set-german') { const v = $('#german-val'); if (v) v.textContent = e.target.value + '%'; } });
  try {
    store.backupCards = await loadBackupDeck();
  } catch (err) {
    console.error('Could not load backup deck', err);
  }
  startNet();
  const next = lsGet('spielchen.nextDeck', null);
  if (!(next && next.cards) && getKey()) runGeneration('current');   // start early: usually ready before names are typed
  render();
  setInterval(clockTick, 250);
  setInterval(pushPhone, 2000);   // heartbeat + timer sync
  requestAnimationFrame(frame);
  // Exposed for tests and debugging (never contains the API key).
  window.__spielchen = { store, R, render };
}

boot();
