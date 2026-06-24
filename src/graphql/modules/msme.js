// GraphQL module: MSME / Udyam compliance.
//  • MSME Form-1 (MCA half-yearly return) Annexure — supplier-wise dues to
//    registered Micro & Small enterprises remaining unpaid beyond 45 days
//    (the MSMED Act, 2006 appointed-day cap).
//  • Party MSME register + updates (Udyam no., enterprise type, agreed terms).

import { query } from '../../db/index.js';
import { assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';

// MSMED Act §15: payment is due by the agreed date, capped at 45 days from
// acceptance. Dues unpaid beyond this are reportable in MSME Form-1.
const MSMED_CAP_DAYS = 45;

export const msmeTypeDefs = /* GraphQL */ `
  type MsmeAnnexureRow {
    vendorId: ID!
    supplierName: String!
    udyamNo: String
    pan: String
    msmeType: String
    invoiceNo: String!
    invoiceDate: String!
    appointedDate: String!
    amountDue: Float!
    overdueDays: Int!
  }

  type MsmeForm1 {
    asOn: String!
    fromHalf: String!
    totalSuppliers: Int!
    totalEntries: Int!
    totalAmountDue: Float!
    rows: [MsmeAnnexureRow!]!
  }

  type MsmePartyRow {
    partyType: String!
    id: ID!
    name: String!
    gstin: String
    udyamNo: String
    msmeType: String
    msmeRegistered: Boolean!
    msmeRegDate: String
    paymentTermsDays: Int
    outstanding: Float!
  }

  type MsmeSummary {
    registeredSuppliers: Int!
    micro: Int!
    small: Int!
    medium: Int!
    overdueEntries: Int!
    overdueAmount: Float!
  }

  input MsmeDetailsInput {
    udyamNo: String
    msmeType: String
    msmeRegistered: Boolean!
    msmeRegDate: String
    paymentTermsDays: Int
  }

  extend type Query {
    msmeForm1(asOn: String): MsmeForm1!
    msmeParties(registeredOnly: Boolean, search: String): [MsmePartyRow!]!
    msmeSummary: MsmeSummary!
  }

  extend type Mutation {
    updateMsmeDetails(partyType: String!, id: ID!, input: MsmeDetailsInput!): MsmePartyRow!
  }
`;

const guard = (ctx) => assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const panFromGstin = (g) => (g && g.length >= 12 ? g.slice(2, 12) : null);

/** "Apr 2026 – Sep 2026" style half-year label containing `date`. */
function halfYearLabel(d) {
  const dt = new Date(d);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  return m >= 4 && m <= 9 ? `Apr ${y} – Sep ${y}` : (m >= 10 ? `Oct ${y} – Mar ${y + 1}` : `Oct ${y - 1} – Mar ${y}`);
}

export function msmeResolvers() {
  return {
    Query: {
      msmeForm1: async (_p, { asOn }, ctx) => {
        guard(ctx);
        const onDate = asOn || isoDate(new Date());
        // Outstanding bills to registered Micro/Small suppliers, past the appointed day.
        const { rows } = await query(
          `SELECT pi.id, COALESCE(NULLIF(pi.bill_no,''), pi.internal_no) bill_no, pi.invoice_date,
                  (pi.total_amount - pi.amount_paid) amount_due,
                  (pi.invoice_date + (LEAST(COALESCE(v.payment_terms_days,45), $2) || ' days')::interval)::date appointed_date,
                  v.id v_id, v.name v_name, v.gstin, v.udyam_no, v.msme_type
           FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id
           WHERE v.msme_registered = TRUE AND v.msme_type IN ('MICRO','SMALL')
             AND (pi.total_amount - pi.amount_paid) > 0
             AND (pi.invoice_date + (LEAST(COALESCE(v.payment_terms_days,45), $2) || ' days')::interval)::date < $1::date
           ORDER BY v.name, pi.invoice_date`,
          [onDate, MSMED_CAP_DAYS],
        );
        const annex = rows.map((r) => ({
          vendorId: r.v_id, supplierName: r.v_name, udyamNo: r.udyam_no, pan: panFromGstin(r.gstin), msmeType: r.msme_type,
          invoiceNo: r.bill_no, invoiceDate: isoDate(r.invoice_date), appointedDate: isoDate(r.appointed_date),
          amountDue: round2(num(r.amount_due)),
          overdueDays: Math.max(0, Math.floor((new Date(onDate) - new Date(r.appointed_date)) / 86400000)),
        }));
        return {
          asOn: onDate,
          fromHalf: halfYearLabel(onDate),
          totalSuppliers: new Set(annex.map((a) => a.vendorId)).size,
          totalEntries: annex.length,
          totalAmountDue: round2(annex.reduce((a, r) => a + r.amountDue, 0)),
          rows: annex,
        };
      },

      msmeParties: async (_p, { registeredOnly, search }, ctx) => {
        guard(ctx);
        const reg = registeredOnly ? 'AND msme_registered = TRUE' : '';
        const { rows: vendors } = await query(
          `SELECT id, name, gstin, udyam_no, msme_type, msme_registered, msme_reg_date, payment_terms_days, outstanding
           FROM vendors WHERE ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR udyam_no ILIKE '%'||$1||'%') ${reg}
           ORDER BY msme_registered DESC, name`,
          [search ?? null],
        );
        const { rows: dists } = await query(
          `SELECT id, name, gstin, udyam_no, msme_type, msme_registered, msme_reg_date, outstanding
           FROM distributors WHERE ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR udyam_no ILIKE '%'||$1||'%') ${reg}
           ORDER BY msme_registered DESC, name`,
          [search ?? null],
        );
        return [
          ...vendors.map((r) => ({
            partyType: 'VENDOR', id: r.id, name: r.name, gstin: r.gstin, udyamNo: r.udyam_no, msmeType: r.msme_type,
            msmeRegistered: r.msme_registered ?? false, msmeRegDate: r.msme_reg_date ? String(r.msme_reg_date).slice(0, 10) : null,
            paymentTermsDays: r.payment_terms_days ?? 45, outstanding: num(r.outstanding) ?? 0,
          })),
          ...dists.map((r) => ({
            partyType: 'DISTRIBUTOR', id: r.id, name: r.name, gstin: r.gstin, udyamNo: r.udyam_no, msmeType: r.msme_type,
            msmeRegistered: r.msme_registered ?? false, msmeRegDate: r.msme_reg_date ? String(r.msme_reg_date).slice(0, 10) : null,
            paymentTermsDays: null, outstanding: num(r.outstanding) ?? 0,
          })),
        ];
      },

      msmeSummary: async (_p, _a, ctx) => {
        guard(ctx);
        const s = (await query(
          `SELECT COUNT(*) FILTER (WHERE msme_registered)::int registered,
                  COUNT(*) FILTER (WHERE msme_type='MICRO')::int micro,
                  COUNT(*) FILTER (WHERE msme_type='SMALL')::int small,
                  COUNT(*) FILTER (WHERE msme_type='MEDIUM')::int medium
           FROM vendors`,
        )).rows[0];
        const od = (await query(
          `SELECT COUNT(*)::int entries, COALESCE(SUM(pi.total_amount - pi.amount_paid),0) amt
           FROM purchase_invoices pi JOIN vendors v ON v.id=pi.vendor_id
           WHERE v.msme_registered AND v.msme_type IN ('MICRO','SMALL')
             AND (pi.total_amount - pi.amount_paid) > 0
             AND (pi.invoice_date + (LEAST(COALESCE(v.payment_terms_days,45), $1) || ' days')::interval)::date < CURRENT_DATE`,
          [MSMED_CAP_DAYS],
        )).rows[0];
        return {
          registeredSuppliers: s.registered, micro: s.micro, small: s.small, medium: s.medium,
          overdueEntries: od.entries, overdueAmount: round2(num(od.amt)),
        };
      },
    },

    Mutation: {
      updateMsmeDetails: async (_p, { partyType, id, input }, ctx) => {
        const actor = guard(ctx);
        const type = partyType.toUpperCase();
        if (input.msmeType && !['MICRO', 'SMALL', 'MEDIUM', 'NA'].includes(input.msmeType.toUpperCase())) {
          throw httpError('msmeType must be MICRO, SMALL, MEDIUM or NA', 400);
        }
        const mt = input.msmeType ? input.msmeType.toUpperCase() : null;
        if (type === 'VENDOR') {
          const { rows } = await query(
            `UPDATE vendors SET udyam_no=$2, msme_type=$3, msme_registered=$4, msme_reg_date=$5, payment_terms_days=COALESCE($6, payment_terms_days), updated_at=now()
             WHERE id=$1 RETURNING id, name, gstin, udyam_no, msme_type, msme_registered, msme_reg_date, payment_terms_days, outstanding`,
            [id, input.udyamNo ?? null, mt, input.msmeRegistered, input.msmeRegDate ?? null, input.paymentTermsDays ?? null],
          );
          if (!rows[0]) throw httpError('Vendor not found', 404);
          await logActivity(actor.sub, 'UPDATE_MSME', 'vendor', id, { msmeType: mt });
          const r = rows[0];
          return { partyType: 'VENDOR', id: r.id, name: r.name, gstin: r.gstin, udyamNo: r.udyam_no, msmeType: r.msme_type, msmeRegistered: r.msme_registered, msmeRegDate: r.msme_reg_date ? String(r.msme_reg_date).slice(0, 10) : null, paymentTermsDays: r.payment_terms_days, outstanding: num(r.outstanding) ?? 0 };
        }
        if (type === 'DISTRIBUTOR') {
          const { rows } = await query(
            `UPDATE distributors SET udyam_no=$2, msme_type=$3, msme_registered=$4, msme_reg_date=$5, updated_at=now()
             WHERE id=$1 RETURNING id, name, gstin, udyam_no, msme_type, msme_registered, msme_reg_date, outstanding`,
            [id, input.udyamNo ?? null, mt, input.msmeRegistered, input.msmeRegDate ?? null],
          );
          if (!rows[0]) throw httpError('Distributor not found', 404);
          await logActivity(actor.sub, 'UPDATE_MSME', 'distributor', id, { msmeType: mt });
          const r = rows[0];
          return { partyType: 'DISTRIBUTOR', id: r.id, name: r.name, gstin: r.gstin, udyamNo: r.udyam_no, msmeType: r.msme_type, msmeRegistered: r.msme_registered, msmeRegDate: r.msme_reg_date ? String(r.msme_reg_date).slice(0, 10) : null, paymentTermsDays: null, outstanding: num(r.outstanding) ?? 0 };
        }
        throw httpError('partyType must be VENDOR or DISTRIBUTOR', 400);
      },
    },
  };
}
