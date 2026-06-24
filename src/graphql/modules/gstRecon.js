// GraphQL module: GST Reconciliation + Invoice Management System (IMS) + Challans.
// Ingests portal JSON exports (GSTR-2A / GSTR-2B / GSTR-1 / Challan ledger),
// parses counterparty documents, and matches them line-by-line against books
// (purchase_invoices / invoices). IMS lets the recipient Accept / Reject / keep
// Pending each inward document (which flows to GSTR-2B / ITC).

import { query, withTransaction } from '../../db/index.js';
import { assertRole } from '../context.js';
import { num, isoDate, logActivity } from '../helpers.js';
import { normGstin as normG, normDocNo, matchKey, classifyPair } from '../../services/gst/calc.js';

export const gstReconTypeDefs = /* GraphQL */ `
  type GstReconImport { id: ID!, source: String!, period: String!, gstin: String, fileName: String, lineCount: Int!, createdAt: DateTime! }

  type GstReconRow {
    id: ID
    status: String!            # MATCHED / MISMATCH / PROBABLE / PORTAL_ONLY / BOOKS_ONLY
    source: String!
    ctin: String
    supplierName: String
    docType: String!
    docNo: String
    docDate: String
    portalTaxable: Float
    portalTax: Float
    portalTotal: Float
    bookTaxable: Float
    bookTax: Float
    bookTotal: Float
    bookInvoiceId: ID
    bookInvoiceNo: String
    diffTotal: Float
    itcEligible: Boolean
    imsAction: String
    matchScore: Float
    matchReason: String
    note: String
    itcAction: String
    manualMatch: Boolean
  }

  type GstReconSummary {
    source: String!
    period: String!
    matched: Int!
    mismatch: Int!
    probable: Int!
    portalOnly: Int!
    booksOnly: Int!
    portalTaxTotal: Float!
    bookTaxTotal: Float!
    matchedTaxTotal: Float!
    inImportCount: Int!
  }

  type GstReconResult { summary: GstReconSummary!, rows: [GstReconRow!]! }

  type ImsRow {
    id: ID!, ctin: String, supplierName: String, docType: String!, docNo: String, docDate: String,
    taxable: Float!, tax: Float!, total: Float!, itcEligible: Boolean, imsAction: String!, matchStatus: String!
  }
  type ImsSummary { total: Int!, accepted: Int!, rejected: Int!, pending: Int!, noAction: Int!, acceptedTax: Float! }
  type ImsInbox { summary: ImsSummary!, rows: [ImsRow!]! }

  type GstChallan {
    id: ID!, cpin: String, challanNo: String, period: String, paidDate: String,
    igst: Float!, cgst: Float!, sgst: Float!, cess: Float!, fees: Float!, interest: Float!, amount: Float!, mode: String, status: String!, createdAt: DateTime!
  }
  type ChallanReconRow { head: String!, liability: Float!, paid: Float!, balance: Float! }
  type ChallanRecon { period: String!, rows: [ChallanReconRow!]!, totalLiability: Float!, totalPaid: Float!, totalBalance: Float! }

  input GstChallanInput {
    cpin: String, challanNo: String, period: String!, paidDate: String,
    igst: Float, cgst: Float, sgst: Float, cess: Float, fees: Float, interest: Float, mode: String
  }

  extend type Query {
    gstReconImports(source: String, period: String): [GstReconImport!]!
    gstReconResult(source: String!, period: String!): GstReconResult!
    imsInbox(period: String!): ImsInbox!
    gstChallans(period: String): [GstChallan!]!
    challanReconciliation(period: String!): ChallanRecon!
  }

  extend type Mutation {
    importGstPortalJson(source: String!, period: String!, fileName: String, json: JSON!): GstReconImport!
    deleteGstReconImport(id: ID!): Boolean!
    setImsAction(docId: ID!, action: String!): ImsRow!
    bulkSetImsAction(period: String!, action: String!, onlyMatched: Boolean): Int!
    recordGstChallan(input: GstChallanInput!): GstChallan!
    deleteGstChallan(id: ID!): Boolean!
    setReconMatch(docId: ID!, bookInvoiceId: ID): GstReconRow!
    setReconNote(docId: ID!, note: String): Boolean!
    setReconItcAction(docId: ID!, action: String!): Boolean!
  }
`;

const guard = (ctx) => assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
const guardWrite = (ctx) => assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const normNo = normDocNo;          // from services/gst/calc.js
const normGstin = normG;
// Tolerances for a clean match: ₹2 absolute OR 1% of value.
const TOL_ABS = 2;
const TOL_PCT = 1;

/** dd-mm-yyyy (or yyyy-mm-dd) → ISO yyyy-mm-dd. */
function toIso(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function periodRange(period) {
  const p = String(period);
  if (!/^\d{6}$/.test(p)) throw Object.assign(new Error('Period must be MMYYYY'), { statusCode: 400 });
  const mm = Number(p.slice(0, 2));
  const yyyy = Number(p.slice(2));
  const last = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  return { from: `${yyyy}-${String(mm).padStart(2, '0')}-01`, to: `${yyyy}-${String(mm).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
}

/** Sum item-level GST when an invoice node omits header totals. */
function sumItems(itms) {
  const acc = { txval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const raw of itms || []) {
    const it = raw.itm_det || raw;
    acc.txval += num(it.txval) || 0;
    acc.igst += num(it.iamt ?? it.igst) || 0;
    acc.cgst += num(it.camt ?? it.cgst) || 0;
    acc.sgst += num(it.samt ?? it.sgst) || 0;
    acc.cess += num(it.csamt ?? it.cess) || 0;
  }
  return acc;
}

function pushDoc(out, { ctin, tradeName, docType, docNo, docDate, val, agg, itcEligible }) {
  const taxable = round2(agg.txval);
  const igst = round2(agg.igst), cgst = round2(agg.cgst), sgst = round2(agg.sgst), cess = round2(agg.cess);
  out.push({
    ctin: normGstin(ctin), tradeName: tradeName ?? null, docType, docNo: docNo ?? null, docDate: toIso(docDate),
    taxable, igst, cgst, sgst, cess, total: round2(val != null ? num(val) : taxable + igst + cgst + sgst + cess),
    itcEligible: itcEligible == null ? null : itcEligible,
  });
}

/** Parse GSTR-2A / GSTR-2B / GSTR-1 JSON into a flat list of counterparty docs. */
function parsePortalJson(source, json) {
  const out = [];
  // GSTR-2B nests under data.docdata; 2A/GSTR-1 expose sections at the root.
  const root = json?.data?.docdata || json?.data || json || {};
  const b2b = root.b2b || json.b2b || [];
  for (const party of b2b) {
    const ctin = party.ctin || party.gstin;
    const trd = party.trdnm || party.trade_name;
    for (const inv of party.inv || []) {
      const itms = inv.itms || [];
      const headerHasTotals = inv.txval != null || inv.val != null;
      const agg = (inv.txval != null)
        ? { txval: num(inv.txval) || 0, igst: num(inv.igst) || 0, cgst: num(inv.cgst) || 0, sgst: num(inv.sgst) || 0, cess: num(inv.cess) || 0 }
        : sumItems(itms);
      const itcRaw = inv.itcavl ?? inv.itc_avl;
      pushDoc(out, {
        ctin, tradeName: trd, docType: 'INV', docNo: inv.inum || inv.inv_no, docDate: inv.idt || inv.dt || inv.inv_dt,
        val: inv.val, agg, itcEligible: itcRaw == null ? null : String(itcRaw).toUpperCase() === 'Y',
      });
      void headerHasTotals;
    }
  }
  // Credit/Debit notes.
  const cdnr = root.cdnr || json.cdnr || [];
  for (const party of cdnr) {
    const ctin = party.ctin || party.gstin;
    const trd = party.trdnm || party.trade_name;
    for (const nt of party.nt || party.inv || []) {
      const itms = nt.itms || [];
      const agg = (nt.txval != null)
        ? { txval: num(nt.txval) || 0, igst: num(nt.igst) || 0, cgst: num(nt.cgst) || 0, sgst: num(nt.sgst) || 0, cess: num(nt.cess) || 0 }
        : sumItems(itms);
      pushDoc(out, {
        ctin, tradeName: trd, docType: (nt.ntty || nt.note_type) === 'D' ? 'DN' : 'CN',
        docNo: nt.nt_num || nt.ntnum || nt.note_no, docDate: nt.nt_dt || nt.ntdt || nt.note_dt, val: nt.val, agg,
      });
    }
  }
  return out;
}

/** Parse a challan/cash-ledger JSON into challan rows (best effort across shapes). */
function parseChallans(json, period) {
  const list = json?.challans || json?.data?.challans || (Array.isArray(json) ? json : []) || [];
  return list.map((c) => ({
    cpin: c.cpin || c.CPIN || null,
    challanNo: c.cin || c.CIN || c.challan_no || null,
    period: c.ret_period || c.period || period,
    paidDate: toIso(c.dt || c.paid_date || c.date),
    igst: num(c.igst) || 0, cgst: num(c.cgst) || 0, sgst: num(c.sgst) || 0, cess: num(c.cess) || 0,
    fees: num(c.fees) || 0, interest: num(c.interest) || 0,
    amount: num(c.amount ?? c.total) || (num(c.igst) || 0) + (num(c.cgst) || 0) + (num(c.sgst) || 0) + (num(c.cess) || 0),
    mode: c.mode || c.pymt_mode || null,
  }));
}

const mapImport = (r) => ({ id: r.id, source: r.source, period: r.period, gstin: r.gstin, fileName: r.file_name, lineCount: r.line_count, createdAt: r.created_at });
const mapChallan = (r) => ({
  id: r.id, cpin: r.cpin, challanNo: r.challan_no, period: r.period, paidDate: isoDate(r.paid_date),
  igst: num(r.igst), cgst: num(r.cgst), sgst: num(r.sgst), cess: num(r.cess), fees: num(r.fees), interest: num(r.interest),
  amount: num(r.amount), mode: r.mode, status: r.status, createdAt: r.created_at,
});

/** A previous month + this month + next month window for cross-period matching. */
function widePeriodRange(period) {
  const { from } = periodRange(period);
  const [y, m] = from.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 2, 1)); // previous month
  const end = new Date(Date.UTC(y, m + 1, 0));   // last day of next month
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** Normalise a book row into the shape calc.classifyPair expects. */
const bookDoc = (b) => ({
  id: b.id, gstin: b.gstin, docNo: b.bill_no, docDate: isoDate(b.invoice_date),
  taxable: num(b.taxable_value) || 0, igst: num(b.igst) || 0, cgst: num(b.cgst) || 0, sgst: num(b.sgst) || 0, cess: 0,
  total: num(b.total_amount) || 0, period: b.invoice_date ? isoDate(b.invoice_date).slice(0, 7) : null,
});

/**
 * Smart match imported docs against books (roadmap P2.1):
 *  1. exact GSTIN+docNo key (within ±1 month → cross-period) ⇒ MATCHED / MISMATCH
 *  2. else best probable candidate (same GSTIN, similar doc no / equal amount) ⇒ PROBABLE
 *  3. else PORTAL_ONLY
 * Carries over prior manual matches / notes / ITC actions from the last import of
 * the same source+period so re-uploading a corrected file keeps analyst decisions.
 */
async function matchImport(client, importId, source, period) {
  const { from, to } = widePeriodRange(period);
  const isInward = source === 'GSTR2A' || source === 'GSTR2B';
  const books = isInward
    ? (await client.query(
        `SELECT pi.id, pi.bill_no, pi.invoice_date, pi.taxable_value, pi.igst, pi.cgst, pi.sgst, pi.total_amount, v.gstin
         FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id
         WHERE pi.invoice_date >= $1 AND pi.invoice_date <= $2 AND v.gstin IS NOT NULL`, [from, to])).rows
    : (await client.query(
        `SELECT i.id, i.invoice_no bill_no, i.invoice_date, i.taxable_value, i.igst, i.cgst, i.sgst, i.total_amount, d.gstin
         FROM invoices i JOIN distributors d ON d.id = i.distributor_id
         WHERE i.bill_type='GST' AND i.status<>'CANCELLED' AND i.invoice_date >= $1 AND i.invoice_date <= $2 AND d.gstin IS NOT NULL`, [from, to])).rows;

  const byKey = new Map();
  const byGstin = new Map();
  for (const raw of books) {
    const b = bookDoc(raw);
    byKey.set(matchKey(b.gstin, b.docNo), b);
    const g = normGstin(b.gstin);
    if (!byGstin.has(g)) byGstin.set(g, []);
    byGstin.get(g).push(b);
  }

  // Carry-over of analyst decisions from the prior import of same source+period.
  const prior = (await client.query(
    `SELECT d.ctin, d.doc_no, d.manual_match, d.matched_purchase_id, d.note, d.itc_action, d.ims_action
     FROM gst_recon_docs d JOIN gst_recon_imports im ON im.id = d.import_id
     WHERE im.source=$1 AND im.period=$2 AND d.import_id <> $3`, [source, period, importId])).rows;
  const priorByKey = new Map();
  for (const p of prior) priorByKey.set(matchKey(p.ctin, p.doc_no), p);

  const { rows: docs } = await client.query('SELECT * FROM gst_recon_docs WHERE import_id=$1', [importId]);
  for (const d of docs) {
    const portal = { docNo: d.doc_no, docDate: isoDate(d.doc_date), taxable: num(d.taxable) || 0, igst: num(d.igst) || 0, cgst: num(d.cgst) || 0, sgst: num(d.sgst) || 0, cess: num(d.cess) || 0, total: num(d.total) || 0 };
    const carry = priorByKey.get(matchKey(d.ctin, d.doc_no));

    let status = 'PORTAL_ONLY', matchedId = null, score = null, reason = 'No book match';
    const exact = byKey.get(matchKey(d.ctin, d.doc_no));
    if (carry && carry.manual_match && carry.matched_purchase_id) {
      // Respect a prior manual link.
      status = 'MATCHED'; matchedId = carry.matched_purchase_id; score = 1; reason = 'Manual match (carried over)';
    } else if (exact) {
      const c = classifyPair(portal, exact, { tolAbs: TOL_ABS, tolPct: TOL_PCT, exact: true });
      status = c.status; score = c.score; reason = c.reasons.join('; ');
      matchedId = isInward ? exact.id : null;
    } else {
      // Probable: best candidate among same-GSTIN books.
      const cands = byGstin.get(normGstin(d.ctin)) || [];
      let best = null;
      for (const b of cands) {
        const c = classifyPair(portal, b, { tolAbs: TOL_ABS, tolPct: TOL_PCT, exact: false });
        if (c.status === 'PROBABLE' && (!best || c.score > best.score)) best = { ...c, book: b };
      }
      if (best) { status = 'PROBABLE'; score = best.score; reason = best.reasons.join('; '); matchedId = isInward ? best.book.id : null; }
      else { score = 0; }
      // surface doc-similarity hint even when not probable
      if (status === 'PORTAL_ONLY' && cands.length) reason = 'Supplier found, no matching document';
    }

    await client.query(
      `UPDATE gst_recon_docs SET match_status=$2, matched_purchase_id=$3, match_score=$4, match_reason=$5,
        manual_match=$6, note=COALESCE($7, note), itc_action=COALESCE($8, itc_action), ims_action=COALESCE(ims_action, $9)
       WHERE id=$1`,
      [d.id, status, matchedId, score, reason,
        carry?.manual_match ?? false, carry?.note ?? null, carry?.itc_action ?? null, carry?.ims_action ?? null],
    );
  }
}

export function gstReconResolvers() {
  return {
    Query: {
      gstReconImports: async (_p, { source, period }, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT * FROM gst_recon_imports
           WHERE ($1::text IS NULL OR source=$1) AND ($2::text IS NULL OR period=$2)
           ORDER BY created_at DESC`,
          [source ?? null, period ?? null],
        );
        return rows.map(mapImport);
      },

      gstReconResult: async (_p, { source, period }, ctx) => {
        guard(ctx);
        const isInward = source === 'GSTR2A' || source === 'GSTR2B';
        const { from, to } = periodRange(period);

        // Portal side: docs from the latest import for this source+period.
        const imp = (await query('SELECT id FROM gst_recon_imports WHERE source=$1 AND period=$2 ORDER BY created_at DESC LIMIT 1', [source, period])).rows[0];
        const portalDocs = imp ? (await query('SELECT * FROM gst_recon_docs WHERE import_id=$1 ORDER BY ctin, doc_no', [imp.id])).rows : [];

        const matchedBookIds = new Set(portalDocs.filter((d) => d.matched_purchase_id).map((d) => d.matched_purchase_id));
        const bookByKey = new Map();

        // Books side for BOOKS_ONLY detection.
        const books = isInward
          ? (await query(
              `SELECT pi.id, pi.bill_no, pi.taxable_value, pi.tax_value, pi.total_amount, v.gstin, v.name vname
               FROM purchase_invoices pi JOIN vendors v ON v.id=pi.vendor_id
               WHERE pi.invoice_date>=$1 AND pi.invoice_date<=$2`,
              [from, to],
            )).rows
          : (await query(
              `SELECT i.id, i.invoice_no bill_no, i.taxable_value, (i.cgst+i.sgst+i.igst) tax_value, i.total_amount, d.gstin, d.name vname
               FROM invoices i JOIN distributors d ON d.id=i.distributor_id
               WHERE i.bill_type='GST' AND i.status<>'CANCELLED' AND i.invoice_date>=$1 AND i.invoice_date<=$2 AND d.gstin IS NOT NULL`,
              [from, to],
            )).rows;
        for (const b of books) bookByKey.set(`${normGstin(b.gstin)}|${normNo(b.bill_no)}`, b);

        // Books indexed by id (matched docs link via matched_purchase_id, incl. cross-period).
        const bookById = new Map(books.map((b) => [b.id, b]));
        const rows = [];
        let portalTaxTotal = 0, matchedTaxTotal = 0;
        const counts = { MATCHED: 0, MISMATCH: 0, PROBABLE: 0, PORTAL_ONLY: 0, BOOKS_ONLY: 0 };

        for (const d of portalDocs) {
          const portalTax = round2(num(d.igst) + num(d.cgst) + num(d.sgst) + num(d.cess));
          portalTaxTotal += portalTax;
          const b = (d.matched_purchase_id && bookById.get(d.matched_purchase_id)) || bookByKey.get(`${normGstin(d.ctin)}|${normNo(d.doc_no)}`);
          const status = d.match_status || 'PORTAL_ONLY';
          counts[status] = (counts[status] || 0) + 1;
          if (status === 'MATCHED') matchedTaxTotal += portalTax;
          rows.push({
            id: d.id, status, source, ctin: d.ctin, supplierName: d.trade_name || (b ? b.vname : null),
            docType: d.doc_type, docNo: d.doc_no, docDate: isoDate(d.doc_date),
            portalTaxable: num(d.taxable), portalTax, portalTotal: num(d.total),
            bookTaxable: b ? num(b.taxable_value) : null, bookTax: b ? num(b.tax_value) : null, bookTotal: b ? num(b.total_amount) : null,
            bookInvoiceId: b ? b.id : null, bookInvoiceNo: b ? b.bill_no : null,
            diffTotal: b ? round2(num(d.total) - num(b.total_amount)) : null,
            itcEligible: d.itc_eligible, imsAction: d.ims_action || null,
            matchScore: num(d.match_score), matchReason: d.match_reason || null, note: d.note || null,
            itcAction: d.itc_action || null, manualMatch: !!d.manual_match,
          });
        }

        // Books-only: book docs not matched (by key or by id) to any portal doc.
        const portalKeys = new Set(portalDocs.map((d) => `${normGstin(d.ctin)}|${normNo(d.doc_no)}`));
        let bookTaxTotal = 0;
        for (const b of books) {
          bookTaxTotal += num(b.tax_value) || 0;
          const key = `${normGstin(b.gstin)}|${normNo(b.bill_no)}`;
          if (!portalKeys.has(key) && !matchedBookIds.has(b.id)) {
            counts.BOOKS_ONLY += 1;
            rows.push({
              id: null, status: 'BOOKS_ONLY', source, ctin: b.gstin, supplierName: b.vname, docType: 'INV', docNo: b.bill_no, docDate: null,
              portalTaxable: null, portalTax: null, portalTotal: null,
              bookTaxable: num(b.taxable_value), bookTax: num(b.tax_value), bookTotal: num(b.total_amount),
              bookInvoiceId: b.id, bookInvoiceNo: b.bill_no, diffTotal: null, itcEligible: null, imsAction: null,
              matchScore: null, matchReason: null, note: null, itcAction: null, manualMatch: false,
            });
          }
        }

        return {
          summary: {
            source, period, matched: counts.MATCHED, mismatch: counts.MISMATCH, probable: counts.PROBABLE, portalOnly: counts.PORTAL_ONLY, booksOnly: counts.BOOKS_ONLY,
            portalTaxTotal: round2(portalTaxTotal), bookTaxTotal: round2(bookTaxTotal), matchedTaxTotal: round2(matchedTaxTotal), inImportCount: portalDocs.length,
          },
          rows,
        };
      },

      imsInbox: async (_p, { period }, ctx) => {
        guard(ctx);
        const { rows: docs } = await query(
          `SELECT * FROM gst_recon_docs WHERE source IN ('GSTR2A','GSTR2B') AND period=$1 ORDER BY ctin, doc_no`,
          [period],
        );
        const s = { total: docs.length, accepted: 0, rejected: 0, pending: 0, noAction: 0, acceptedTax: 0 };
        const rows = docs.map((d) => {
          const tax = round2(num(d.igst) + num(d.cgst) + num(d.sgst) + num(d.cess));
          const action = d.ims_action || 'NO_ACTION';
          if (action === 'ACCEPTED') { s.accepted += 1; s.acceptedTax += tax; }
          else if (action === 'REJECTED') s.rejected += 1;
          else if (action === 'PENDING') s.pending += 1;
          else s.noAction += 1;
          return {
            id: d.id, ctin: d.ctin, supplierName: d.trade_name, docType: d.doc_type, docNo: d.doc_no, docDate: isoDate(d.doc_date),
            taxable: num(d.taxable), tax, total: num(d.total), itcEligible: d.itc_eligible, imsAction: action, matchStatus: d.match_status,
          };
        });
        s.acceptedTax = round2(s.acceptedTax);
        return { summary: s, rows };
      },

      gstChallans: async (_p, { period }, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT * FROM gst_challans WHERE ($1::text IS NULL OR period=$1) ORDER BY created_at DESC`,
          [period ?? null],
        );
        return rows.map(mapChallan);
      },

      challanReconciliation: async (_p, { period }, ctx) => {
        guard(ctx);
        const { from, to } = periodRange(period);
        // Liability = net output tax for the period (output − ITC from 2B/books), per head.
        const out = (await query(
          `SELECT COALESCE(SUM(igst),0) igst, COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst
           FROM invoices WHERE bill_type='GST' AND status<>'CANCELLED' AND invoice_date>=$1 AND invoice_date<=$2`,
          [from, to],
        )).rows[0];
        const imp2b = (await query("SELECT id FROM gst_recon_imports WHERE source='GSTR2B' AND period=$1 ORDER BY created_at DESC LIMIT 1", [period])).rows[0];
        let itc = { igst: 0, cgst: 0, sgst: 0 };
        if (imp2b) {
          const s = (await query(
            `SELECT COALESCE(SUM(igst),0) igst, COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst FROM gst_recon_docs
             WHERE import_id=$1 AND COALESCE(itc_eligible,true) AND COALESCE(ims_action,'')<>'REJECTED'`,
            [imp2b.id],
          )).rows[0];
          itc = { igst: num(s.igst), cgst: num(s.cgst), sgst: num(s.sgst) };
        }
        const paid = (await query(
          `SELECT COALESCE(SUM(igst),0) igst, COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst FROM gst_challans WHERE period=$1`,
          [period],
        )).rows[0];
        const heads = [
          ['IGST', Math.max(0, num(out.igst) - itc.igst), num(paid.igst)],
          ['CGST', Math.max(0, num(out.cgst) - itc.cgst), num(paid.cgst)],
          ['SGST/UTGST', Math.max(0, num(out.sgst) - itc.sgst), num(paid.sgst)],
        ];
        const rows = heads.map(([head, liability, p]) => ({ head, liability: round2(liability), paid: round2(p), balance: round2(liability - p) }));
        return {
          period, rows,
          totalLiability: round2(rows.reduce((a, r) => a + r.liability, 0)),
          totalPaid: round2(rows.reduce((a, r) => a + r.paid, 0)),
          totalBalance: round2(rows.reduce((a, r) => a + r.balance, 0)),
        };
      },
    },

    Mutation: {
      importGstPortalJson: async (_p, { source, period, fileName, json }, ctx) => {
        const actor = guardWrite(ctx);
        const src = source.toUpperCase();
        const gstin = json?.gstin || json?.data?.gstin || null;

        if (src === 'CHALLAN') {
          const challans = parseChallans(json, period);
          return withTransaction(async (client) => {
            const imp = (await client.query(
              `INSERT INTO gst_recon_imports (source, period, gstin, file_name, raw, line_count, uploaded_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
              [src, period, gstin, fileName ?? null, JSON.stringify(json), challans.length, actor.sub],
            )).rows[0];
            for (const c of challans) {
              await client.query(
                `INSERT INTO gst_challans (cpin, challan_no, period, paid_date, igst, cgst, sgst, cess, fees, interest, amount, mode, import_id, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                [c.cpin, c.challanNo, c.period, c.paidDate, c.igst, c.cgst, c.sgst, c.cess, c.fees, c.interest, c.amount, c.mode, imp.id, actor.sub],
              );
            }
            await logActivity(actor.sub, 'IMPORT_GST_CHALLAN', 'gst_recon_import', imp.id, { period, count: challans.length });
            return mapImport(imp);
          });
        }

        const docs = parsePortalJson(src, json);
        return withTransaction(async (client) => {
          const imp = (await client.query(
            `INSERT INTO gst_recon_imports (source, period, gstin, file_name, raw, line_count, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [src, period, gstin, fileName ?? null, JSON.stringify(json), docs.length, actor.sub],
          )).rows[0];
          for (const d of docs) {
            await client.query(
              `INSERT INTO gst_recon_docs (import_id, source, period, ctin, trade_name, doc_type, doc_no, doc_date, taxable, igst, cgst, sgst, cess, total, itc_eligible)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
              [imp.id, src, period, d.ctin, d.tradeName, d.docType, d.docNo, d.docDate, d.taxable, d.igst, d.cgst, d.sgst, d.cess, d.total, d.itcEligible],
            );
          }
          await matchImport(client, imp.id, src, period);
          await logActivity(actor.sub, 'IMPORT_GST_PORTAL', 'gst_recon_import', imp.id, { source: src, period, count: docs.length });
          return mapImport(imp);
        });
      },

      deleteGstReconImport: async (_p, { id }, ctx) => {
        const actor = guardWrite(ctx);
        await query('DELETE FROM gst_recon_imports WHERE id=$1', [id]);
        await logActivity(actor.sub, 'DELETE_GST_IMPORT', 'gst_recon_import', id);
        return true;
      },

      setImsAction: async (_p, { docId, action }, ctx) => {
        const actor = guardWrite(ctx);
        const act = action.toUpperCase();
        if (!['ACCEPTED', 'REJECTED', 'PENDING', 'NO_ACTION'].includes(act)) throw Object.assign(new Error('Invalid IMS action'), { statusCode: 400 });
        const { rows } = await query(
          `UPDATE gst_recon_docs SET ims_action=$2, ims_acted_by=$3, ims_acted_at=now() WHERE id=$1 RETURNING *`,
          [docId, act === 'NO_ACTION' ? null : act, actor.sub],
        );
        if (!rows[0]) throw Object.assign(new Error('Document not found'), { statusCode: 404 });
        const d = rows[0];
        const tax = round2(num(d.igst) + num(d.cgst) + num(d.sgst) + num(d.cess));
        return { id: d.id, ctin: d.ctin, supplierName: d.trade_name, docType: d.doc_type, docNo: d.doc_no, docDate: isoDate(d.doc_date), taxable: num(d.taxable), tax, total: num(d.total), itcEligible: d.itc_eligible, imsAction: d.ims_action || 'NO_ACTION', matchStatus: d.match_status };
      },

      bulkSetImsAction: async (_p, { period, action, onlyMatched }, ctx) => {
        const actor = guardWrite(ctx);
        const act = action.toUpperCase();
        if (!['ACCEPTED', 'REJECTED', 'PENDING', 'NO_ACTION'].includes(act)) throw Object.assign(new Error('Invalid IMS action'), { statusCode: 400 });
        const { rowCount } = await query(
          `UPDATE gst_recon_docs SET ims_action=$2, ims_acted_by=$3, ims_acted_at=now()
           WHERE source IN ('GSTR2A','GSTR2B') AND period=$1 AND ($4::bool IS NOT TRUE OR match_status='MATCHED')`,
          [period, act === 'NO_ACTION' ? null : act, actor.sub, onlyMatched ?? false],
        );
        await logActivity(actor.sub, 'BULK_IMS_ACTION', 'gst_recon', null, { period, action: act, count: rowCount });
        return rowCount;
      },

      recordGstChallan: async (_p, { input }, ctx) => {
        const actor = guardWrite(ctx);
        const amount = round2((num(input.igst) || 0) + (num(input.cgst) || 0) + (num(input.sgst) || 0) + (num(input.cess) || 0) + (num(input.fees) || 0) + (num(input.interest) || 0));
        const { rows } = await query(
          `INSERT INTO gst_challans (cpin, challan_no, period, paid_date, igst, cgst, sgst, cess, fees, interest, amount, mode, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [input.cpin ?? null, input.challanNo ?? null, input.period, input.paidDate ?? null, num(input.igst) || 0, num(input.cgst) || 0, num(input.sgst) || 0, num(input.cess) || 0, num(input.fees) || 0, num(input.interest) || 0, amount, input.mode ?? null, actor.sub],
        );
        await logActivity(actor.sub, 'RECORD_GST_CHALLAN', 'gst_challan', rows[0].id, { period: input.period, amount });
        return mapChallan(rows[0]);
      },

      deleteGstChallan: async (_p, { id }, ctx) => {
        const actor = guardWrite(ctx);
        await query('DELETE FROM gst_challans WHERE id=$1', [id]);
        await logActivity(actor.sub, 'DELETE_GST_CHALLAN', 'gst_challan', id);
        return true;
      },

      // Manually link a portal doc to a book invoice (or clear it). Survives re-imports.
      setReconMatch: async (_p, { docId, bookInvoiceId }, ctx) => {
        const actor = guardWrite(ctx);
        const link = bookInvoiceId || null;
        const { rows } = await query(
          `UPDATE gst_recon_docs SET matched_purchase_id=$2, manual_match=$3, match_status=$4,
             match_score=$5, match_reason=$6 WHERE id=$1 RETURNING *`,
          [docId, link, !!link, link ? 'MATCHED' : 'PORTAL_ONLY', link ? 1 : 0, link ? 'Manual match' : 'Unlinked'],
        );
        if (!rows[0]) throw Object.assign(new Error('Document not found'), { statusCode: 404 });
        await logActivity(actor.sub, 'RECON_MANUAL_MATCH', 'gst_recon_doc', docId, { bookInvoiceId: link });
        const d = rows[0];
        const tax = round2(num(d.igst) + num(d.cgst) + num(d.sgst) + num(d.cess));
        return {
          id: d.id, status: d.match_status, source: d.source, ctin: d.ctin, supplierName: d.trade_name,
          docType: d.doc_type, docNo: d.doc_no, docDate: isoDate(d.doc_date),
          portalTaxable: num(d.taxable), portalTax: tax, portalTotal: num(d.total),
          bookTaxable: null, bookTax: null, bookTotal: null, bookInvoiceId: link, bookInvoiceNo: null, diffTotal: null,
          itcEligible: d.itc_eligible, imsAction: d.ims_action || null, matchScore: num(d.match_score),
          matchReason: d.match_reason, note: d.note, itcAction: d.itc_action, manualMatch: !!d.manual_match,
        };
      },

      setReconNote: async (_p, { docId, note }, ctx) => {
        guardWrite(ctx);
        await query('UPDATE gst_recon_docs SET note=$2 WHERE id=$1', [docId, note ?? null]);
        return true;
      },

      setReconItcAction: async (_p, { docId, action }, ctx) => {
        guardWrite(ctx);
        const a = action.toUpperCase();
        if (!['CLAIM', 'DEFER', 'INELIGIBLE', 'BLOCKED'].includes(a)) throw Object.assign(new Error('Invalid ITC action'), { statusCode: 400 });
        await query('UPDATE gst_recon_docs SET itc_action=$2 WHERE id=$1', [docId, a]);
        return true;
      },
    },
  };
}
