// Deck: card schema validation, mini-game metadata, drawing.
// Pure apart from loadBackupDeck() (fetch). Generation/prefetch/dedupe arrive in Milestone 3.

export const GAMES_BY_CATEGORY = {
  act: ['charades', 'hum', 'scene', 'statue'],
  draw: ['pictionary', 'blind', 'oneline', 'wronghand'],
  words: ['taboo', 'threewords', 'accent', 'rhyme'],
  brains: ['quiz', 'oddoneout', 'closer'],
  allplay: ['drawoff', 'estimateoff', 'speedround'],
};

export const MINI_GAMES = {
  charades:    { name: 'Charades',      rule: 'Mime a film, series or book. No sounds.', seconds: 60 },
  hum:         { name: 'Hum It',        rule: 'Hum a song, no words.', seconds: 45 },
  scene:       { name: 'Scene',         rule: 'Act out a situation without words.', seconds: 60 },
  statue:      { name: 'Statue',        rule: 'Freeze into a famous pose or moment. The others guess.', seconds: 30 },
  pictionary:  { name: 'Pictionary',    rule: 'Draw it. No letters or numbers.', seconds: 60 },
  blind:       { name: 'Blind Artist',  rule: 'Draw it with your eyes closed.', seconds: 60 },
  oneline:     { name: 'One Line',      rule: 'Draw it without ever lifting the pen.', seconds: 45 },
  wronghand:   { name: 'Wrong Hand',    rule: 'Draw it with your non-dominant hand.', seconds: 60 },
  taboo:       { name: 'Taboo',         rule: 'Explain it without the 4 forbidden words.', seconds: 60 },
  threewords:  { name: 'Three Words',   rule: 'Exactly 3 words. Each guesser gets one guess.', seconds: 30 },
  accent:      { name: 'Accent',        rule: 'Explain it in the accent on the card.', seconds: 60 },
  rhyme:       { name: 'Rhyme Time',    rule: 'Say only words that rhyme with it.', seconds: 45 },
  quiz:        { name: 'Quiz',          rule: 'Read the question out loud. Answer out loud.', seconds: 20 },
  oddoneout:   { name: 'Odd One Out',   rule: 'Four items. Pick the one that doesn’t belong.', seconds: 20 },
  closer:      { name: 'Closer Wins',   rule: 'Estimate the number. Close enough counts.', seconds: 20 },
  drawoff:     { name: 'Draw-Off',      rule: 'Everyone draws it. Point at the best one — not your own.', seconds: 45 },
  estimateoff: { name: 'Estimate-Off',  rule: 'Everyone writes a number. Closest wins.', seconds: 30 },
  speedround:  { name: 'Speed Round',   rule: '3 quick questions. First to shout. Most correct wins.', seconds: 45 },
};

const DIFFS = ['easy', 'medium', 'hard'];
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
  constructor(cards, rng = Math.random) {
    this.rng = rng;
    this.all = {};
    this.piles = {};
    this.lastGame = {};
    for (const cat of Object.keys(GAMES_BY_CATEGORY)) {
      this.all[cat] = cards.filter(c => c.category === cat);
      this.piles[cat] = shuffle(this.all[cat], rng);
    }
  }

  /** Replace a category's cards (used later when fresh LLM cards arrive). */
  setCategory(cat, cards) {
    this.all[cat] = cards.slice();
    this.piles[cat] = shuffle(cards, this.rng);
  }

  remaining(cat) { return this.piles[cat].length; }

  /** opts.hard: prefer a Hard card (Finale). Falls back to medium, then anything. */
  draw(cat, opts = {}) {
    if (!this.piles[cat] || this.piles[cat].length === 0) this.piles[cat] = shuffle(this.all[cat] || [], this.rng);
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
        return card;
      }
    }
    if (!pile.some(notSame)) pile.push(...shuffle(this.all[cat] || [], this.rng)); // only repeats left: top up
    return tryPile([notSame, () => true]);
  }

  _take(cat, pile, idx) {
    const [card] = pile.splice(idx, 1);
    this.lastGame[cat] = card.game;
    return card;
  }
}
