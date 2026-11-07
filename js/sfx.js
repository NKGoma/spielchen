// Tiny synthesized sound effects (WebAudio). Real audio files can replace these in Milestone 4.
let ctx = null;
let muted = false;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur, { type = 'sine', vol = 0.18, delay = 0, slide = 0 } = {}) {
  if (muted) return;
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

export const sfx = {
  setMuted(m) { muted = !!m; },
  isMuted() { return muted; },
  unlock() { ac(); },
  roll() { for (let i = 0; i < 6; i++) tone(300 + Math.random() * 400, 0.05, { type: 'square', vol: 0.05, delay: i * 0.08 }); },
  hop() { tone(520, 0.06, { type: 'triangle', vol: 0.06 }); },
  tick() { tone(1000, 0.04, { type: 'square', vol: 0.06 }); },
  buzzer() { tone(140, 0.6, { type: 'sawtooth', vol: 0.15 }); },
  success() { tone(660, 0.12, { vol: 0.16 }); tone(990, 0.2, { vol: 0.16, delay: 0.1 }); },
  fail() { tone(300, 0.25, { type: 'triangle', vol: 0.18, slide: -150 }); },
  chime() { [659, 523, 392].forEach((f, i) => tone(f, 0.45, { vol: 0.16, delay: i * 0.32 })); },
  pfand() { tone(880, 0.08, { vol: 0.12 }); tone(1320, 0.15, { vol: 0.12, delay: 0.08 }); },
  stamp() { tone(90, 0.2, { type: 'square', vol: 0.2 }); },
  fanfare() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.25, { vol: 0.14, delay: i * 0.14 })); },
};
