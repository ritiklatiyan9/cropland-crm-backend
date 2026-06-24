// GraphQL module: GST Utilities — GSTIN validator (mod-36 checksum + state code)
// and an HSN/SAC finder wired to the product catalog so codes stay consistent
// across invoicing, GSTR-1 HSN summary and reconciliation.

import { query } from '../../db/index.js';
import { assertAuth } from '../context.js';
import { num } from '../helpers.js';
import { validateGstin, GST_STATE_CODES } from '../../services/gst/stateCodes.js';

export const gstUtilsTypeDefs = /* GraphQL */ `
  type GstinValidation { gstin: String!, valid: Boolean!, reason: String!, stateCode: String, stateName: String, pan: String }
  type HsnLookupRow { hsnCode: String!, description: String, gstPercent: Float, productCount: Int! }
  type GstStateRow { code: String!, name: String! }

  extend type Query {
    validateGstin(gstin: String!): GstinValidation!
    hsnLookup(search: String): [HsnLookupRow!]!
    gstStateCodes: [GstStateRow!]!
  }
`;

export function gstUtilsResolvers() {
  return {
    Query: {
      validateGstin: (_p, { gstin }, ctx) => {
        assertAuth(ctx);
        const v = validateGstin(gstin);
        return { gstin: String(gstin || '').trim().toUpperCase(), valid: v.valid, reason: v.reason, stateCode: v.stateCode ?? null, stateName: v.stateName ?? null, pan: v.pan ?? null };
      },

      hsnLookup: async (_p, { search }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT hsn_code, MIN(name) desc, MAX(gst_percent) gst, COUNT(*)::int cnt
           FROM products
           WHERE hsn_code IS NOT NULL AND hsn_code <> ''
             AND ($1::text IS NULL OR hsn_code ILIKE '%'||$1||'%' OR name ILIKE '%'||$1||'%')
           GROUP BY hsn_code ORDER BY hsn_code LIMIT 200`,
          [search ?? null],
        );
        return rows.map((r) => ({ hsnCode: r.hsn_code, description: r.desc, gstPercent: num(r.gst), productCount: r.cnt }));
      },

      gstStateCodes: (_p, _a, ctx) => {
        assertAuth(ctx);
        return Object.entries(GST_STATE_CODES).map(([code, name]) => ({ code, name }));
      },
    },
  };
}
