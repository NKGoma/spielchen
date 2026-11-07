// Card brief: a tiny chat where the group says what the cards should be about.
// Pure helpers; the actual call goes through complete() in llm.js.

export const BRIEF_CHIPS = ['Surprise me', '90s & 00s music', 'Football', 'Berlin life', 'Movies & TV', 'Food & travel', 'Science & nature'];
export const SURPRISE = 'Surprise me';

export const BRIEF_SYSTEM = `You help a group set up Spielchen, a party board game for adults in their 30s living in Germany. They tell you what the cards should be about. You get the CURRENT brief and their NEW message. Reply with ONLY a JSON object, no prose:
{"reply": "one short, friendly sentence (max 20 words) saying exactly what the cards will be about", "topics": ["1 to 6 short topic phrases"], "only": true}

How to update the brief:
- "only X", "just X", "nothing but X", "all about X", "X only": REPLACE the topics with X and set "only": true (every card will be about X).
- "more X", "also X", "add X": keep the current topics and add X. Keep "only" as it was.
- "less X", "no X", "without X": remove X. Keep "only" as it was.
- A new message that just names topics (e.g. "music and film"): REPLACE the topics with those and set "only": true.
- "mix it", "and other stuff too", "mostly X": set "only": false (about half the cards on the topics, the rest varied).
- "surprise me", "you choose": empty topics, "only": false.
Your reply must name the topics you return and nothing else - do not mention topics that are not in the list. Never include crude or hateful topics.`;

const ONLY_RE = /\b(only|just|nothing but|all about|exclusively|purely)\b|\bonly\s*$/i;
const MIX_RE = /\b(mix|mixed|mostly|other stuff|other things|as well as general|plus general)\b/i;
const MIX_WORDS = /\b(mix(ed)? it( up)?|mixed|mix|mostly|with other (stuff|things)|other (stuff|things)|too|as well|general( knowledge)?)\b/gi;
const ADD_RE = /^\s*(more|also|add|plus|and)\b/i;
const REMOVE_RE = /^\s*(less|no|without|not|drop|remove)\b/i;

/** The request text: current brief + the new message. */
export function briefPrompt(current, message) {
  const topics = (current && current.topics) || [];
  return `CURRENT topics: ${topics.length ? topics.join('; ') : '(none: a general mix)'}
CURRENT mode: ${current && current.only ? 'only these topics' : 'mixed with general cards'}
NEW message: ${message}`;
}

function firstObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

const clean = s => String(s).replace(/\s+/g, ' ').trim().slice(0, 60);
const STRIP = /\b(only|just|nothing but|all about|exclusively|purely|please|the game|cards?|questions?|should be|about|i want|we want|make it|more|also|add|plus|less|no|without)\b/gi;

/** Topics straight from one message (used when the model's reply can't be parsed, or there is no key). */
export function topicsFromText(message) {
  const m = String(message || '');
  if (/surprise|you choose|whatever|anything/i.test(m)) return [];
  return m.replace(MIX_WORDS, ' ').replace(STRIP, ' ').split(/,|;|\band\b|\n|\//i).map(clean).filter(t => t.length > 1 && !/^(it|with|stuff|things|too|as well)$/i.test(t)).slice(0, 6);
}

/** Apply one message to the brief locally (no model). Returns { topics, only }. */
export function applyLocally(current, message) {
  const cur = { topics: (current && current.topics) || [], only: !!(current && current.only) };
  const m = String(message || '');
  if (/surprise|you choose|whatever|anything/i.test(m)) return { topics: [], only: false };
  const named = topicsFromText(m);
  const lower = t => t.toLowerCase();
  if (REMOVE_RE.test(m)) return { topics: cur.topics.filter(t => !named.some(n => lower(t).includes(lower(n)) || lower(n).includes(lower(t)))), only: cur.only };
  if (ADD_RE.test(m)) return { topics: [...cur.topics, ...named.filter(n => !cur.topics.map(lower).includes(lower(n)))].slice(0, 6), only: cur.only };
  if (MIX_RE.test(m)) return { topics: named.length ? named : cur.topics, only: false };
  return { topics: named, only: true };
}

/**
 * Parse the model's reply into { reply, topics, only }. Never throws.
 * The user's own words win on the "only" question: "only music" always means only music.
 */
export function parseBrief(text, current, message) {
  const obj = firstObject(String(text || ''));
  const local = applyLocally(current, message);
  let topics, only, reply;
  if (obj && Array.isArray(obj.topics)) {
    topics = obj.topics.filter(t => typeof t === 'string' && t.trim()).map(clean).slice(0, 6);
    only = typeof obj.only === 'boolean' ? obj.only : local.only;
    reply = typeof obj.reply === 'string' && obj.reply.trim() ? String(obj.reply).trim().slice(0, 200) : '';
  } else {
    ({ topics, only } = local);
  }
  if (ONLY_RE.test(message || '')) { only = true; if (local.topics.length) topics = local.topics; }
  if (MIX_RE.test(message || '')) only = false;
  if (!topics.length) only = false;
  const list = topics.join(', ');
  // The reply must match what we'll actually do, so build the scope part ourselves.
  const scope = !topics.length ? 'a fun mix of everything' : only ? `only ${list}` : `${list}, mixed with general knowledge`;
  const low = (reply || '').toLowerCase();
  const word = t => t.toLowerCase().split(' ')[0];
  const dropped = ((current && current.topics) || []).filter(t => !topics.some(n => n.toLowerCase() === t.toLowerCase()));
  const mentionsDropped = dropped.some(t => low.includes(word(t)));
  const missesNew = !topics.every(t => low.includes(word(t)));
  const saysMix = !only && topics.length && !/mix|general|other/.test(low);
  const saysOnlyWrongly = only && /mix|general knowledge|other stuff/.test(low);
  if (!reply || mentionsDropped || missesNew || saysMix || saysOnlyWrongly) reply = `Got it: ${scope}.`;
  return { reply, topics, only };
}

/** One line describing the current brief, for the panel. */
export function briefSummary(brief) {
  const t = (brief && brief.topics) || [];
  if (!t.length) return 'Topics: a fun mix (you can change it)';
  return brief.only ? `Every card: ${t.join(', ')}` : `Topics: ${t.join(', ')} + general knowledge`;
}
