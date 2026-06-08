// Machine-translation service — translates dynamic content via Google Gemini.
// Used by the `translate` GraphQL query, which caches results in `mt_cache` so
// each phrase is sent to Gemini only once (translate-once, then serve-from-DB).

import { env } from '../../config/env.js';

const KEY = env.ai?.geminiApiKey || process.env.GEMINI_API_KEY || '';
const MODEL = env.ai?.geminiModel || 'gemini-2.5-flash';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

export const translateConfigured = Boolean(KEY);

const LANG_NAMES = {
  hi: 'Hindi', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati', bn: 'Bengali',
  ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam', or: 'Odia',
};

function extractJsonArray(text) {
  if (!text) return null;
  // Strip ```json fences and grab the outermost [ ... ].
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return null;
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(arr) ? arr.map((s) => String(s)) : null;
  } catch {
    return null;
  }
}

/**
 * Translate an array of strings into the target language via Gemini.
 * Returns an array aligned with the input; on any failure the originals are
 * returned so the UI degrades gracefully (English).
 */
export async function translateBatch(texts, lang) {
  const langName = LANG_NAMES[lang];
  if (!translateConfigured || !langName || !texts.length) return texts;

  const prompt =
    `Translate each string in the following JSON array from English to ${langName} (use the native script).\n` +
    `Rules:\n` +
    `- Return ONLY a JSON array of strings, same length and order as the input.\n` +
    `- Keep numbers, dates, units, currency symbols, product/brand names and codes unchanged.\n` +
    `- Translate naturally for an agriculture / farming app audience.\n` +
    `Input:\n${JSON.stringify(texts)}`;

  try {
    const res = await fetch(`${GEMINI}/${MODEL}:generateContent?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) return texts;
    const data = await res.json();
    const out = extractJsonArray(data?.candidates?.[0]?.content?.parts?.[0]?.text);
    if (!out || out.length !== texts.length) return texts;
    return out;
  } catch {
    return texts;
  }
}
