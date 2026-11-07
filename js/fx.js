// Visual effects: 3D die, special-square moments, confetti. DOM only, no game logic.
import { icon, TRAIN_SVG } from './icons.js';
import { CATEGORIES, CATEGORY_INFO } from './rules.js';

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 3D die (faces 1–4 around the sides) ----------
const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9] };
const face = (n, cls) => `<div class="face ${cls}">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => `<i class="${PIPS[n].includes(k) ? 'pip' : ''}"></i>`).join('')}</div>`;
// Rotation of the cube that brings each value's face to the front.
const SHOW = { 1: [0, 0], 2: [0, -90], 3: [0, 180], 4: [0, 90] };
let spins = 0;

export function dieHtml() {
  return `<div class="die3d"><div class="cube" id="cube">
    ${face(1, 'f-front')}${face(2, 'f-right')}${face(3, 'f-back')}${face(4, 'f-left')}${face(2, 'f-top')}${face(3, 'f-bottom')}
  </div></div>`;
}

/** Tumble the cube in the DOM and land on `value`. Resolves after the tumble. */
export function tumble(value, ms = 600) {
  const cube = document.getElementById('cube');
  const [x, y] = SHOW[value];
  if (!cube) return Promise.resolve();
  if (reduceMotion()) { cube.style.transition = 'none'; cube.style.transform = `rotateX(${x}deg) rotateY(${y}deg)`; return Promise.resolve(); }
  spins += 2;
  cube.style.transition = `transform ${ms}ms cubic-bezier(.2,.7,.25,1)`;
  // Force the start pose first so the transition always runs.
  void cube.offsetWidth;
  cube.style.transform = `rotateX(${spins * 360 + x}deg) rotateY(${spins * 360 + y + 30}deg) rotateZ(${spins * 180}deg)`;
  return new Promise(r => setTimeout(() => { cube.style.transition = 'transform 160ms ease-out'; cube.style.transform = `rotateX(${spins * 360 + x}deg) rotateY(${spins * 360 + y}deg) rotateZ(${spins * 180}deg)`; setTimeout(r, 160); }, ms));
}

// ---------- special-square moments ----------
function flap(text) {
  return `<div class="flap">${[...text].map((ch, i) => `<span style="animation-delay:${i * 55}ms">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`).join('')}</div>`;
}

export function momentHtml(square, { skippedName } = {}) {
  switch (square.type) {
    case 'db':
      return `<div class="moment m-db">
        <div class="db-board"><div class="db-row"><span class="db-time">21:07</span><span class="db-dest">ICE 1234 · Berlin Hbf</span></div>${flap('ZUG FÄLLT AUS')}</div>
        <div class="m-line">${esc(square.tvLine)}</div>
        <div class="m-effect alert">${icon('arrow-right', 'flip-x')} Back 3 squares</div>
        <div class="train-run">${TRAIN_SVG}</div>
      </div>`;
    case 'pfand':
      return `<div class="moment m-pfand">
        <div class="bottle-drop">${icon('bottle', 'm-ic')}</div>
        <div class="coin">+25 ct</div>
        <div class="m-title">Pfand</div>
        <div class="m-line">${esc(square.tvLine)}</div>
        <div class="m-effect">+2 squares</div>
      </div>`;
    case 'burgeramt':
      return `<div class="moment m-amt">
        <div class="form"><div class="form-head">Bürgeramt · Antrag auf Weiterspielen</div>
          <div class="form-line"></div><div class="form-line short"></div><div class="form-line"></div><div class="form-line short"></div>
          <div class="stamp">ABGELEHNT</div></div>
        <div class="m-line">${esc(skippedName ? `${skippedName} skips this turn. No Termin.` : square.tvLine)}</div>
        <div class="m-effect">${skippedName ? 'Turn skipped' : 'Skip your next turn'}</div>
      </div>`;
    case 'wild': {
      const strip = [...CATEGORIES, ...CATEGORIES, ...CATEGORIES, ...CATEGORIES].map(c => `<div class="reel-tile cat-${c}">${icon(CATEGORY_INFO[c].icon)}<span>${CATEGORY_INFO[c].verb}</span></div>`).join('');
      return `<div class="moment m-wild">
        <div class="m-title">Wild</div>
        <div class="reel"><div class="reel-strip">${strip}</div></div>
        <div class="m-line">${esc(square.tvLine)}</div>
      </div>`;
    }
    case 'allplay':
      return `<div class="moment m-all">
        <div class="four">${CATEGORIES.map(c => `<span class="cat-${c}">${icon(CATEGORY_INFO[c].icon)}</span>`).join('')}</div>
        <div class="m-title">${esc(square.tvLine)}</div>
        <div class="m-line">Everyone plays the next card at once.</div>
      </div>`;
    default:
      return `<div class="moment m-plain">${icon(square.icon, 'm-ic')}<div class="m-title">${esc(square.label)}</div><div class="m-line">${esc(square.tvLine || '')}</div></div>`;
  }
}

// ---------- confetti (canvas) ----------
export function confetti(colors, { count = 90, burst = false } = {}) {
  if (reduceMotion()) return;
  const stage = document.getElementById('stage');
  const cv = document.createElement('canvas');
  cv.width = 1920; cv.height = 1080; cv.className = 'confetti-canvas';
  stage.appendChild(cv);
  const ctx = cv.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const cols = (colors && colors.length ? colors : ['--act', '--draw', '--words', '--brains']).map(c => c.startsWith('--') ? css.getPropertyValue(c).trim() : c);
  const parts = Array.from({ length: count }, () => burst
    ? { x: 960, y: 620, vx: (Math.random() - 0.5) * 34, vy: -12 - Math.random() * 18, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, w: 12 + Math.random() * 10, h: 8 + Math.random() * 8, c: cols[Math.floor(Math.random() * cols.length)] }
    : { x: Math.random() * 1920, y: -40 - Math.random() * 400, vx: (Math.random() - 0.5) * 4, vy: 4 + Math.random() * 5, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, w: 12 + Math.random() * 10, h: 8 + Math.random() * 8, c: cols[Math.floor(Math.random() * cols.length)] });
  const t0 = performance.now();
  const step = now => {
    ctx.clearRect(0, 0, 1920, 1080);
    for (const p of parts) {
      p.vy += burst ? 0.6 : 0.08; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2))); ctx.restore();
    }
    if (now - t0 < 3200) requestAnimationFrame(step); else cv.remove();
  };
  requestAnimationFrame(step);
}
