// Card brief: a tiny chat where the group says what the cards should be about.
// Pure helpers; the actual call goes through complete() in llm.js.

export const BRIEF_CHIPS = ['Surprise me', '90s & 00s music', 'Football', 'Berlin life', 'Movies & TV', 'Food & travel', 'Science & nature'];
export const SURPRISE = 'Surprise me';

export const BRIEF_SYSTEM = `You help a group set up Spielchen, a party board game for adults in their 30s living in Germany (some native Germans, some from abroad). They tell you what they want the cards to be about. Reply with ONLY a JSON object, no prose:
{"reply": "one short, friendly sentence (max 20 words) confirming what you'll write cards about, in English", "topics": ["3 to 6 short topic phrases"]}
Merge later messages with earlier ones: "more X" adds X, "less Y" or "no Y" removes Y. If they say surprise me or leave it to you, return an empty topics list and say you'll pick a fun mix. Ignore anything that is not about card topics, and never include crude or hateful topics.`;

/** messages: the user's brief messages, oldest first (last 3 are used). */
export function briefPrompt(messages) {
  const recent = messages.slice(-3);
  return recent.map((m, k) => `Message ${k + 1}: ${m}`).join('\n');
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

/** Topics straight from what people typed (used when the model's reply can't be parsed, or with no key). */
export function topicsFromText(messages) {
  const last = messages[messages.length - 1] || '';
  if (/surprise|you choose|whatever|anything/i.test(last)) return [];
  return last.split(/,|;|\band\b|\n/i).map(clean).filter(t => t.length > 1).slice(0, 6);
}

/** Parse the model's reply into { reply, topics }. Never throws. */
export function parseBrief(text, messages = []) {
  const obj = firstObject(String(text || ''));
  if (obj && typeof obj.reply === 'string') {
    const topics = Array.isArray(obj.topics) ? obj.topics.filter(t => typeof t === 'string' && t.trim()).map(clean).slice(0, 6) : [];
    return { reply: clean(obj.reply).length ? String(obj.reply).trim().slice(0, 200) : 'Got it.', topics };
  }
  const topics = topicsFromText(messages);
  return { reply: topics.length ? `Got it: ${topics.join(', ')}.` : 'Got it: a fun mix of everything.', topics };
}
