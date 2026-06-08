// GraphQL module: on-the-fly machine translation of dynamic content, cached in
// `mt_cache` (translate-once via Gemini, then serve from DB). Used by the
// Farmer App to show data — not just UI labels — in the chosen language.

import crypto from 'node:crypto';
import { query } from '../../db/index.js';
import { assertAuth } from '../context.js';
import { translateBatch } from '../../services/translate/index.js';

export const translateTypeDefs = /* GraphQL */ `
  extend type Query {
    """Translate dynamic strings to a language (e.g. "hi"). Returns the input order; 'en' is a no-op."""
    translate(texts: [String!]!, to: String!): [String!]!
  }
`;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const CHUNK = 40;

export function translateResolvers() {
  return {
    Query: {
      translate: async (_p, { texts, to }, ctx) => {
        assertAuth(ctx);
        if (!to || to === 'en' || !texts.length) return texts;

        const uniq = [...new Set(texts.filter((t) => t && t.trim()))];
        const result = new Map(); // source text -> translated

        if (uniq.length) {
          // 1) Pull whatever is already cached.
          const hashes = uniq.map(sha);
          const cached = await query(
            'SELECT source_text, translated FROM mt_cache WHERE lang_code = $1 AND source_hash = ANY($2)',
            [to, hashes],
          );
          for (const r of cached.rows) result.set(r.source_text, r.translated);

          // 2) Translate the misses via Gemini (chunked) and persist them.
          const misses = uniq.filter((t) => !result.has(t));
          for (let i = 0; i < misses.length; i += CHUNK) {
            const chunk = misses.slice(i, i + CHUNK);
            const translated = await translateBatch(chunk, to);
            const rows = [];
            for (let j = 0; j < chunk.length; j++) {
              const src = chunk[j];
              const tr = translated[j] ?? src;
              result.set(src, tr);
              rows.push([sha(src), to, src, tr]);
            }
            if (rows.length) {
              const values = rows.map((_, k) => `($${k * 4 + 1},$${k * 4 + 2},$${k * 4 + 3},$${k * 4 + 4})`).join(',');
              await query(
                `INSERT INTO mt_cache (source_hash, lang_code, source_text, translated)
                 VALUES ${values} ON CONFLICT (source_hash, lang_code) DO NOTHING`,
                rows.flat(),
              );
            }
          }
        }

        // 3) Re-assemble aligned with the original input (preserve order & blanks).
        return texts.map((t) => (t && t.trim() ? result.get(t) ?? t : t));
      },
    },
  };
}
