// Fresh decks: 5 parallel LLM calls (one per category), validation, dedupe, top-up from the backup deck.
import { complete } from './llm.js';
import { validateCard, GAMES_BY_CATEGORY, seenKey } from './deck.js';
export { seenKey };

export const GEN_CATEGORIES = ['act', 'draw', 'words', 'brains', 'allplay'];

export const GAME_COUNTS = {
  act: { charades: 4, hum: 3, scene: 4, statue: 3 },
  draw: { pictionary: 4, blind: 3, oneline: 3, wronghand: 4 },
  words: { taboo: 4, threewords: 3, accent: 3, rhyme: 4 },
  brains: { quiz: 6, oddoneout: 4, closer: 4 },
  allplay: { drawoff: 3, estimateoff: 2, speedround: 3 },
};

const NUDGES = ['summer', 'nightlife', 'food', 'travel', 'office', '90s', 'sport', 'weather'];

export const SCHEMA = `{
  "id": "short unique id",
  "category": "act | draw | words | brains | allplay",
  "game": "charades | hum | scene | statue | pictionary | blind | oneline | wronghand | taboo | threewords | accent | rhyme | quiz | oddoneout | closer | drawoff | estimateoff | speedround",
  "prompt": "the word, title, situation or question",
  "forbidden": ["taboo only: exactly 4 words"],
  "accent": "accent only, e.g. Scottish",
  "options": ["oddoneout only: exactly 4; answer must be one of them"],
  "answer": "quiz, oddoneout, closer, estimateoff (number as string), hum (the artist)",
  "tolerance": "closer and estimateoff only: a number, e.g. 30",
  "questions": [{"q": "speedround only: exactly 3", "a": "short answer"}],
  "difficulty": "easy | medium | hard",
  "tone": "clean | cheeky",
  "german": true,
  "hint_en": "one line explaining the German reference, or null"
}`;

export function systemPrompt({ germanPct = 25, cleanPct = 70 } = {}) {
  return `You write cards for Spielchen, a fast party board game for 3-6 well-educated adults in their 30s who live in Germany and come from different countries. Some are native Germans, others moved here. They may have just met. The goal is laughter, not difficulty.

Rules:
- English only. German words are welcome as flavour; every German-specific card sets german:true and gives a one-line hint_en for non-Germans.
- Everything must be guessable by an international group: famous films, songs, people, places, and everyday life in Germany. No niche references.
- Mix: about ${germanPct}% German-life cards, the rest international (Europe-leaning, global pop culture).
- German cards must be fun for native Germans too: real trivia, funny everyday situations, culture. Never ask what a German word means or translate a German word - that is a giveaway for the Germans at the table.
- Brains cards are mostly general knowledge from around the world: geography, science, history, film, music, sport.
- Tone: about ${cleanPct}% clean and clever, the rest a bit cheeky. Never crude, sexual, or mean. No jokes that punch down at nationalities, religions or groups.
- Politics: light and non-partisan. Institutions, events and quirks are fine; no insults or claims about real people.
- Brains cards: only well-established facts you are certain of. If unsure, skip it. Answers must be short.
- Hum It cards: give song title in prompt and artist in answer. Never write lyrics.
- Difficulty mix: 40% easy, 40% medium, 20% hard.
- If the user prompt lists the group's topics, make about half the cards about those topics and keep the rest varied. Brains facts stay strictly factual.
- Do not use anything from the AVOID list.
- Output ONLY a JSON array of card objects matching the schema. No prose, no markdown.`;
}

export function userPrompt({ category, avoid = [], examples = [], topics = [], rng = Math.random }) {
  const counts = GAME_COUNTS[category];
  const count = Object.values(counts).reduce((a, b) => a + b, 0);
  const nudge = NUDGES[Math.floor(rng() * NUDGES.length)];
  return `Category: ${category}
Allowed games and how many of each: ${Object.entries(counts).map(([g, n]) => `${g}: ${n}`).join(', ')}
Count: ${count}
${topics.length ? `The group's topics: ${topics.join('; ')}` : `Theme nudge: ${nudge}`}
AVOID: ${avoid.length ? avoid.join(' | ') : '(nothing yet)'}
Schema: ${SCHEMA}
Two example cards: ${JSON.stringify(examples.slice(0, 2))}`;
}

/** Pull the first complete JSON array out of a reply (tolerates prose or code fences around it). */
export function extractArray(text) {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}


/** Normalise and validate generated cards for one category; drops invalid and already-seen ones. */
export function cleanCards(raw, category, seen = new Set()) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const keys = new Set();
  raw.forEach((c, k) => {
    if (!c || typeof c !== 'object') return;
    const card = { ...c, category, id: `gen-${category}-${Date.now().toString(36)}-${k}` };
    if (card.tolerance != null && typeof card.tolerance === 'string') card.tolerance = parseFloat(card.tolerance);
    if (typeof card.answer === 'number') card.answer = String(card.answer);
    if (card.german !== true) { card.german = false; if (!card.hint_en) card.hint_en = null; }
    if (!GAMES_BY_CATEGORY[category].includes(card.game)) return;
    if (!validateCard(card)) return;
    const key = seenKey(card);
    if (seen.has(key) || keys.has(key)) return;
    keys.add(key);
    out.push(card);
  });
  return out;
}

/**
 * Generate one category. Returns cards (at least `min`, topped up from backup when short).
 * fresh = how many of them came from the model.
 */
export async function generateCategory({ category, key, model, settings, seen, backupCards, avoid, rng = Math.random, call = complete }) {
  const backup = backupCards.filter(c => c.category === category);
  const text = await call({
    key, model,
    system: systemPrompt(settings),
    user: userPrompt({ category, avoid, examples: backup, topics: (settings && settings.topics) || [], rng }),
    maxTokens: 8000,
    timeoutMs: 25000,
  });
  const cards = cleanCards(extractArray(text), category, seen);
  const fresh = cards.length;
  if (cards.length < 6) cards.push(...backup.filter(c => !seen.has(seenKey(c))).slice(0, 6 - cards.length + 4));
  return { cards, fresh };
}

/**
 * Generate a whole deck with 5 parallel calls. onCategory(category, cards, fresh) fires as each one lands.
 * Never throws: a failed category simply stays on the backup deck.
 */
export async function generateDeck({ key, model, settings, seenList = [], backupCards, onCategory = () => {}, call }) {
  const seen = new Set(seenList);
  const avoid = seenList.slice(-60);
  const result = {};
  await Promise.all(GEN_CATEGORIES.map(async category => {
    try {
      const { cards, fresh } = await generateCategory({ category, key, model, settings, seen, backupCards, avoid, call });
      if (fresh > 0) { result[category] = cards; onCategory(category, cards, fresh); }
      else onCategory(category, null, 0);
    } catch (e) {
      onCategory(category, null, 0, e);
    }
  }));
  return result;
}
