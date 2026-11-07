// Deck: card schema validation, mini-game metadata, drawing.
// Pure apart from loadBackupDeck() (fetch). Generation/prefetch/dedupe arrive in Milestone 3.

export const GAMES_BY_CATEGORY = {
  act: ['charades', 'hum', 'scene', 'statue'],
  draw: ['pictionary', 'blind', 'oneline', 'wronghand'],
  words: ['taboo', 'threewords', 'accent', 'rhyme'],
  brains: ['quiz', 'oddoneout', 'closer'],
  allplay: ['drawoff', 'estimateoff', 'speedround'],
};

// `rule` is the short rule. `tv(name, card)` is what the TV says to the whole room:
// who does what, and what everyone guesses. It never contains the secret.
export const MINI_GAMES = {
  charades:    { name: 'Charades',     seconds: 60, rule: 'Mime it. No sounds.', tv: n => `${n} mimes a film, series or book. No sounds. Guess the title.` },
  hum:         { name: 'Hum It',       seconds: 45, rule: 'Hum it. No words.', tv: n => `${n} hums a song, no words. Guess the song.` },
  scene:       { name: 'Scene',        seconds: 60, rule: 'Act it out. No words.', tv: n => `${n} acts out a situation without words. Guess what’s going on.` },
  statue:      { name: 'Statue',       seconds: 30, rule: 'Freeze in a famous pose.', tv: n => `${n} freezes into a famous pose. Guess who or what it is.` },
  pictionary:  { name: 'Pictionary',   seconds: 60, rule: 'Draw it. No letters or numbers.', tv: n => `${n} draws something. No letters or numbers. Guess what it is.` },
  blind:       { name: 'Blind Artist', seconds: 60, rule: 'Draw it with your eyes closed.', tv: n => `${n} draws with their eyes closed. Guess what it is.` },
  oneline:     { name: 'One Line',     seconds: 45, rule: 'Never lift the pen.', tv: n => `${n} draws without lifting the pen. Guess what it is.` },
  wronghand:   { name: 'Wrong Hand',   seconds: 60, rule: 'Use your other hand.', tv: n => `${n} draws with their wrong hand. Guess what it is.` },
  taboo:       { name: 'Taboo',        seconds: 60, rule: 'Describe it without the 4 banned words.', tv: n => `${n} describes a secret word but can’t say 4 banned words. Guess the word.` },
  threewords:  { name: 'Three Words',  seconds: 30, rule: 'Exactly 3 words of clues.', tv: n => `${n} gives exactly 3 words as clues. One guess each.` },
  accent:      { name: 'Accent',       seconds: 60, rule: 'Describe it in an accent.', tv: (n, c) => `${n} describes a secret word in a ${c && c.accent ? c.accent : 'secret'} accent. Guess the word.` },
  rhyme:       { name: 'Rhyme Time',   seconds: 45, rule: 'Only say words that rhyme with it.', tv: n => `${n} only says words that rhyme with the secret word. Guess it.` },
  quiz:        { name: 'Quiz',         seconds: 20, rule: 'Answer the question.', tv: n => `Question for ${n}. Answer out loud.` },
  oddoneout:   { name: 'Odd One Out',  seconds: 20, rule: 'Spot the one that doesn’t belong.', tv: n => `Question for ${n}. Which one doesn’t belong?` },
  closer:      { name: 'Closer Wins',  seconds: 20, rule: 'Guess the number.', tv: (n, c) => `Question for ${n}. Guess the number${c && c.tolerance != null ? ` — within ±${c.tolerance} counts` : ''}.` },
  drawoff:     { name: 'Draw-Off',     seconds: 45, rule: 'Everyone draws it.', tv: () => 'Everyone draws this. Then point at the best one — not your own.' },
  estimateoff: { name: 'Estimate-Off', seconds: 30, rule: 'Everyone writes a number.', tv: () => 'Everyone secretly writes down a number. Closest wins.' },
  speedround:  { name: 'Speed Round',  seconds: 45, rule: '3 quick questions.', tv: () => '3 quick questions, one at a time. First to shout the right answer scores.' },
};

/** Plain-English summary per category; the pun names are decoration. */
export const CATEGORY_PLAIN = {
  act: 'act it out, they guess',
  draw: 'draw it, they guess',
  words: 'describe it, they guess',
  brains: 'answer a question',
  allplay: 'everyone plays at once',
};

const DIFFS = ['easy', 'medium', 'hard'];

/** Key used to remember cards across games (by prompt, so regenerated cards dedupe too). */
export const seenKey = c => String(c.prompt || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isStr = x => typeof x === 'string' && x.trim().length > 0;
const isNum = x => typeof x === 'number' && isFinite(x);

/** Returns true when the card matches the schema and its game's required fields. */
export function validateCard(c) {
  if (!c || typeof c !== 'object') return false;
  const games = GAMES_BY_CATEGORY[c.category];
  if (!games || !games.includes(c.game)) return false;
  if (!isStr(c.id) || !isStr(c.prompt)) return false;
  if (!DIFFS.includes(c.difficulty)) return false;
  if (c.tone !== 'clean' && c.tone !== 'cheeky') return false;
  if (typeof c.german !== 'boolean') return false;
  if (c.german && !isStr(c.hint_en)) return false;
  switch (c.game) {
    case 'taboo':
      if (!Array.isArray(c.forbidden) || c.forbidden.length !== 4 || !c.forbidden.every(isStr)) return false;
      break;
    case 'accent':
      if (!isStr(c.accent)) return false;
      break;
    case 'oddoneout':
      if (!Array.isArray(c.options) || c.options.length !== 4 || !c.options.every(isStr)) return false;
      if (!isStr(c.answer) || !c.options.includes(c.answer)) return false;
      break;
    case 'hum':
    case 'quiz':
      if (!isStr(c.answer)) return false;
      break;
    case 'closer':
    case 'estimateoff':
      if (!(isStr(c.answer) || isNum(c.answer)) || !isNum(c.tolerance)) return false;
      break;
    case 'speedround':
      if (!Array.isArray(c.questions) || c.questions.length !== 3) return false;
      if (!c.questions.every(q => q && isStr(q.q) && isStr(q.a))) return false;
      break;
  }
  return true;
}

export async function loadBackupDeck(url = 'data/backup-deck.json') {
  const res = await fetch(url);
  const cards = await res.json();
  return cards.filter(validateCard);
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A per-game deck. Each category is a shuffled pile; drawing avoids serving the
 * same mini-game twice in a row within a category. Piles refill when empty.
 */
export class Deck {
  /** seen: keys (seenKey) of recently used cards (e.g. from earlier games); those go to the bottom of each pile. */
  constructor(cards, rng = Math.random, seen = []) {
    this.rng = rng;
    this.seen = new Set(seen);
    this.used = [];
    this.all = {};
    this.piles = {};
    this.lastGame = {};
    for (const cat of Object.keys(GAMES_BY_CATEGORY)) {
      this.all[cat] = cards.filter(c => c.category === cat);
      this.piles[cat] = this._fresh(cat);
    }
  }

  /** Shuffled pile with unseen cards first. */
  _fresh(cat) {
    const all = shuffle(this.all[cat] || [], this.rng);
    return [...all.filter(c => !this.seen.has(seenKey(c))), ...all.filter(c => this.seen.has(seenKey(c)))];
  }

  /** Replace a category's cards (used later when fresh LLM cards arrive). */
  setCategory(cat, cards) {
    this.all[cat] = cards.slice();
    this.piles[cat] = shuffle(cards, this.rng);
  }

  remaining(cat) { return this.piles[cat].length; }

  /** opts.hard: prefer a Hard card (Finale). Falls back to medium, then anything. */
  draw(cat, opts = {}) {
    if (!this.piles[cat] || this.piles[cat].length === 0) { this.all[cat].forEach(c => this.seen.add(seenKey(c))); this.piles[cat] = this._fresh(cat); }
    const pile = this.piles[cat];
    if (!pile.length) return null;
    const notSame = c => c.game !== this.lastGame[cat];
    const tryPile = preds => {
      for (const p of preds) {
        const idx = pile.findIndex(p);
        if (idx >= 0) return this._take(cat, pile, idx);
      }
      return null;
    };
    if (opts.hard) {
      const hard = c => c.difficulty === 'hard';
      const got = tryPile([c => hard(c) && notSame(c), hard]);
      if (got) return got;
      // Every hard card was used already: reuse one from the full set.
      const fromAll = (this.all[cat] || []).filter(hard);
      if (fromAll.length) {
        const card = fromAll[Math.floor(this.rng() * fromAll.length)];
        this.lastGame[cat] = card.game;
        this.used.push(seenKey(card));
        return card;
      }
    }
    if (!pile.some(notSame)) pile.push(...shuffle(this.all[cat] || [], this.rng)); // only repeats left: top up
    return tryPile([notSame, () => true]);
  }

  _take(cat, pile, idx) {
    const [card] = pile.splice(idx, 1);
    this.lastGame[cat] = card.game;
    this.used.push(seenKey(card));
    return card;
  }
}
