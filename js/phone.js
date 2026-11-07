// Phone controller: a thin remote. Shows only what the person holding it needs.
import { PhoneNet, normaliseCode } from './net.js';
import { icon } from './icons.js';
import { CATEGORIES, CATEGORY_INFO } from './rules.js';
import { CATEGORY_PLAIN } from './deck.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ssGet = k => { try { return sessionStorage.getItem(k); } catch { return null; } };
const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } };

const params = new URLSearchParams(location.search);
let room = normaliseCode(params.get('room') || ssGet('spielchen.room') || '');
let net = null;
let status = 'idle';
let state = null;
let sig = '';
let timerEnds = null;
let confirmed = ssGet('spielchen.confirmed') || '';

// ---------- connection ----------
function connect(code) {
  room = normaliseCode(code);
  if (room.length !== 4) return render();
  ssSet('spielchen.room', room);
  if (net) return;
  net = new PhoneNet({
    code: room,
    onStatus: s => { status = s; renderBar(); if (!state) render(); },
    onMessage: msg => {
      if (!msg || msg.t !== 'state') return;
      if (msg.timerLeftMs != null) timerEnds = Date.now() + msg.timerLeftMs; else timerEnds = null;
      const next = JSON.stringify({ ...msg, timerLeftMs: undefined });
      state = msg;
      if (next !== sig) { sig = next; render(); }
    },
  });
  status = 'connecting';
  net.connect();
  render();
}

const send = msg => { if (navigator.vibrate) navigator.vibrate(15); return net && net.send(msg); };

// Keep the screen awake while playing (fewer dropped connections).
let lock = null;
async function keepAwake() { try { if ('wakeLock' in navigator && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch { /* not allowed */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); if (net && status !== 'connected') net.connect(); } });

// ---------- rendering ----------
function renderBar() {
  const cls = status === 'connected' ? 'ok' : status === 'reconnecting' || status === 'connecting' ? 'warn' : 'off';
  const label = status === 'connected' ? `Room ${room}` : status === 'reconnecting' ? 'Reconnecting…' : status === 'connecting' ? `Connecting to ${room}…` : room ? 'Offline' : 'Not connected';
  const onBoard = state && state.screen === 'board' && state.role === 'controller';
  $('#bar').innerHTML = `<span class="logo">spielchen</span><span class="status"><i class="dot ${cls}"></i>${label}</span>${onBoard ? `<button class="undo" data-act="undo">${icon('arrow-right', 'flip')} Undo</button>` : ''}`;
}

const tok = p => p ? `<span class="tok" style="--c:${p.color}">${p.emoji}</span>` : '';
const catVars = c => `cat-${c}`;

function passGate(holder, key) {
  if (!holder || confirmed === key) return null;
  return `<section class="pass" style="--c:${holder.color}">
    <div class="pass-label">Pass the phone to</div>
    <div class="pass-name">${tok(holder)} ${esc(holder.name)}</div>
    <button class="big-btn light" data-act="confirm" data-key="${esc(key)}">I'm ${esc(holder.name)}</button>
    <p class="muted">So the wrong person doesn't see the card.</p>
  </section>`;
}

function render() {
  renderBar();
  const app = $('#app');
  if (!room || room.length !== 4 || (status === 'offline' && !state)) {
    app.innerHTML = `<section class="center">
      <h1>Join the game</h1>
      <p class="muted">Type the 4-letter code on the TV.</p>
      <input id="code" class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(room)}" placeholder="ABCD">
      <button class="big-btn" data-act="join">Join</button>
      ${status === 'offline' ? '<p class="bad">Could not load the connection library. Check your internet.</p>' : ''}
    </section>`;
    return;
  }
  if (!state) {
    app.innerHTML = `<section class="center"><div class="spinner"></div><h2>Connecting to room ${esc(room)}…</h2><p class="muted">Keep the TV page open.</p>
      <button class="link" data-act="change">Use a different code</button></section>`;
    return;
  }
  app.innerHTML = viewHtml(state);
  tickTimer();
}

function positionsHtml(st) {
  if (!st.positions) return '';
  return `<ul class="positions">${st.positions.map(p => `<li class="${p.active ? 'active' : ''}"><span class="tok" style="--c:${p.color}">${p.emoji}</span><span>${esc(p.name)}</span><b>${p.pos}</b></li>`).join('')}</ul>`;
}

function secretHtml(card) {
  if (card.category === 'brains') {
    return `<div class="sec-label">Answer</div><div class="sec-main">${esc(card.answer)}</div>
      ${card.tolerance != null ? `<div class="sec-row">Counts if within ± ${esc(card.tolerance)}</div>` : ''}
      ${card.hint_en ? `<div class="sec-hint">${esc(card.hint_en)}</div>` : ''}`;
  }
  return `<div class="sec-label">${card.game === 'hum' ? 'Hum this' : card.category === 'draw' ? 'Draw this' : card.category === 'act' ? 'Act this' : 'Your word'}</div>
    <div class="sec-main">${esc(card.prompt)}</div>
    ${card.game === 'hum' && card.answer ? `<div class="sec-row">by ${esc(card.answer)}</div>` : ''}
    ${card.accent ? `<div class="sec-row">Accent: <b>${esc(card.accent)}</b></div>` : ''}
    ${card.forbidden ? `<div class="sec-label">Don't say</div><div class="sec-chips">${card.forbidden.map(w => `<span>${esc(w)}</span>`).join('')}</div>` : ''}
    ${card.hint_en ? `<div class="sec-hint">${esc(card.hint_en)}</div>` : ''}`;
}

function cardHead(card) {
  const info = CATEGORY_INFO[card.category];
  const dots = { easy: 1, medium: 2, hard: 3 }[card.difficulty] || 1;
  return `<div class="card-head">${icon(info.icon)}<span>${esc(card.gameName)}</span><span class="diff">${[1, 2, 3].map(k => `<i class="${k <= dots ? 'on' : ''}"></i>`).join('')}</span></div>`;
}

function peekZone(card) {
  const brains = card.category === 'brains';
  return `<div class="peek" data-peek>
    <div class="peek-cover">${icon('eye')}<span>Hold to peek${brains ? ' at the answer' : ''}</span></div>
    <div class="peek-secret">${secretHtml(card)}</div>
  </div>`;
}

function viewHtml(st) {
  if (st.role === 'spectator') {
    return `<section class="center"><h2>${st.active ? `${tok(st.active)} ${esc(st.active.name)} is playing` : 'Watching'}</h2>
      <p class="muted">Another phone is the remote right now.</p>
      <button class="big-btn ghost" data-act="claim">Use this phone as the remote</button>${positionsHtml(st)}</section>`;
  }
  switch (st.view) {
    case 'lobby':
      return `<section class="center"><div class="check">${icon('check')}</div><h1>Connected</h1>
        <p class="muted">Players on the TV:</p>
        <ul class="positions">${st.players.map(p => `<li>${tok(p)}<span>${esc(p.name)}</span></li>`).join('')}</ul>
        ${st.screen === 'howto' ? `<button class="big-btn" data-act="skip">Let's go</button>` : `<button class="big-btn" data-act="startgame">Start the game</button>`}</section>`;
    case 'watch':
      return `<section class="center watch">${icon('laptop', 'watch-ic')}<h2>Watch the TV</h2>${positionsHtml(st)}</section>`;
    case 'roll': {
      const gate = passGate(st.holder, st.holderKey);
      if (gate) return gate;
      return `<section class="center"><div class="who">${tok(st.holder)} ${esc(st.holder.name)}'s turn</div>
        <button class="roll-btn" data-act="roll">${st.finaleNext ? 'Play the Finale' : 'Roll'}</button></section>`;
    }
    case 'pick': {
      if (!st.finale) { const gate = passGate(st.holder, st.holderKey); if (gate) return gate; }
      return `<section class="pick"><h2>${st.finale ? `Everyone else: pick ${esc(st.active.name)}'s Finale category` : 'Pick a category'}</h2>
        <div class="tiles">${CATEGORIES.map(c => `<button class="tile ${catVars(c)}" data-act="pick" data-cat="${c}">${icon(CATEGORY_INFO[c].icon)}<b>${CATEGORY_INFO[c].verb}</b><span>${CATEGORY_PLAIN[c]}</span></button>`).join('')}</div></section>`;
    }
    case 'card': {
      const c = st.card;
      if (c.sudden) {
        if (confirmed !== st.holderKey) return `<section class="pass"><div class="pass-label">Sudden death</div><div class="pass-name">Give the phone to someone who isn't tied</div><button class="big-btn light" data-act="confirm" data-key="${esc(st.holderKey)}">I'm not tied</button></section>`;
      } else { const gate = passGate(st.holder, st.holderKey); if (gate) return gate; }
      const brains = c.category === 'brains';
      return `<section class="card ${catVars(c.category)}">
        ${cardHead(c)}
        <p class="tv-line">${brains ? `You're the quizmaster. Read this out loud to ${esc(st.active.name)}:` : esc(c.tv)}</p>
        ${brains ? `<div class="question">${esc(c.prompt)}</div>${c.options ? `<ol class="options" type="A">${c.options.map(o => `<li>${esc(o)}</li>`).join('')}</ol>` : ''}` : ''}
        ${peekZone(c)}
        <button class="big-btn" data-act="start">Start the ${c.seconds} s timer</button>
      </section>`;
    }
    case 'running': {
      const c = st.card;
      const brains = c.category === 'brains';
      return `<section class="card running ${catVars(c.category)}">
        ${cardHead(c)}
        <div class="countdown ${st.timeUp ? 'done' : ''}" id="countdown">${st.timeUp ? 'Time!' : ''}</div>
        ${peekZone(c)}
        <div class="result-btns">
          <button class="big-btn good" data-act="result" data-ok="1">${brains ? 'Correct' : 'Got it'}</button>
          <button class="big-btn bad" data-act="result" data-ok="0">${brains ? 'Wrong' : 'Failed'}</button>
        </div>
      </section>`;
    }
    case 'chips':
      return `<section class="chips-view"><h2>${esc(st.title)}</h2>
        <div class="chips">${st.choices.map(p => `<button class="chip" style="--c:${p.color}" data-act="player" data-pid="${p.id}">${tok(p)}<span>${esc(p.name)}</span></button>`).join('')}
        ${st.nobody ? `<button class="chip nobody" data-act="player" data-pid="">Nobody</button>` : ''}</div>
        ${st.back ? `<button class="link" data-act="back">Back</button>` : ''}</section>`;
    case 'button':
      return `<section class="center allplay"><div class="stripe">${CATEGORIES.map(c => `<i class="${catVars(c)}"></i>`).join('')}</div>
        <div class="ap-title">${esc(st.title)}</div><div class="question">${esc(st.text)}</div>
        <div class="countdown" id="countdown"></div>
        <button class="big-btn" data-act="start">${esc(st.label)}</button></section>`;
    case 'winner':
      return `<section class="center"><div class="trophy">${icon('trophy')}</div><h1>${esc(st.winner)} wins!</h1>${positionsHtml(st)}
        <button class="big-btn" data-act="rematch">Rematch</button><button class="big-btn ghost" data-act="newgame">New game</button></section>`;
    default:
      return `<section class="center"><h2>Watch the TV</h2></section>`;
  }
}

function tickTimer() {
  const el = $('#countdown');
  if (!el) return;
  if (timerEnds != null) {
    const left = Math.max(0, timerEnds - Date.now());
    el.textContent = Math.ceil(left / 1000);
    el.classList.toggle('low', left <= 5000);
  }
}
setInterval(tickTimer, 200);

// ---------- input ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  keepAwake();
  const act = b.dataset.act;
  switch (act) {
    case 'join': connect($('#code').value); break;
    case 'change': room = ''; ssSet('spielchen.room', ''); location.search = ''; break;
    case 'confirm': confirmed = b.dataset.key; ssSet('spielchen.confirmed', confirmed); render(); break;
    case 'roll': send({ t: 'roll' }); break;
    case 'start': send({ t: 'start' }); break;
    case 'result': send({ t: 'result', ok: b.dataset.ok === '1' }); break;
    case 'player': send({ t: 'player', pid: b.dataset.pid || null }); break;
    case 'pick': send({ t: 'pick', category: b.dataset.cat }); break;
    case 'back': send({ t: 'back' }); break;
    case 'undo': if (confirm('Undo the last result?')) send({ t: 'undo' }); break;
    case 'claim': send({ t: 'claim' }); break;
    case 'startgame': send({ t: 'startgame' }); break;
    case 'skip': send({ t: 'skip' }); break;
    case 'rematch': send({ t: 'rematch' }); break;
    case 'newgame': send({ t: 'newgame' }); break;
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'code') connect(e.target.value); });

// Hold to peek: the secret is visible only while pressed.
const peekOn = e => { const z = e.target.closest('[data-peek]'); if (z) { z.classList.add('open'); e.preventDefault(); } };
const peekOff = () => document.querySelectorAll('[data-peek].open').forEach(z => z.classList.remove('open'));
document.addEventListener('pointerdown', peekOn);
['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, peekOff, true));
window.addEventListener('blur', peekOff);
document.addEventListener('contextmenu', e => { if (e.target.closest('[data-peek]')) e.preventDefault(); });

if (room.length === 4) connect(room); else render();
