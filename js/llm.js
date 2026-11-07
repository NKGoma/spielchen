// Anthropic Messages API, called straight from the browser (static site, no backend).
// The key lives only in this browser's localStorage and is never logged or sent to the phone.

export const MODELS = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fast)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (better cards)' },
];
export const DEFAULT_MODEL = 'claude-haiku-5-5';
const KEY = 'spielchen.key';

export function getKey() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
export function setKey(k) { try { if (k) localStorage.setItem(KEY, k.trim()); else localStorage.removeItem(KEY); } catch { /* private mode */ } }

export class LlmError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) { super(message); this.status = status; this.retryable = retryable; }
}

async function post(body, { key, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch { /* ignore */ }
      throw new LlmError(msg, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
    }
    return await res.json();
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw new LlmError(e.name === 'AbortError' ? 'Timed out' : 'Network error', { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One text completion. Retries once on a network error, timeout, 429 or 5xx.
 * Thinking stays on (adaptive) at low effort for speed; we read only the text blocks.
 */
export async function complete({ key, model = DEFAULT_MODEL, system, user, maxTokens = 8000, timeoutMs = 25000 }) {
  if (!key) throw new LlmError('No API key');
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'low' },
  };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await post(body, { key, timeoutMs });
      if (data.stop_reason === 'refusal') throw new LlmError('The model declined this request');
      return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    } catch (e) {
      lastErr = e;
      if (!(e instanceof LlmError) || !e.retryable) throw e;
    }
  }
  throw lastErr;
}

/** "Test key": a tiny request. Resolves to { ok, message }. */
export async function testKey(key, model = DEFAULT_MODEL) {
  try {
    await post({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Say OK.' }], output_config: { effort: 'low' } }, { key, timeoutMs: 15000 });
    return { ok: true, message: 'Key works' };
  } catch (e) {
    const m = e.status === 401 ? 'That key was rejected (401)' : e.status === 403 ? 'Key not allowed (403)' : e.message;
    return { ok: false, message: m };
  }
}
