// Pure GST calculation engine — no DB, no I/O, fully unit-testable (see calc.test.js).
// Centralises every piece of tax arithmetic + reconciliation logic the resolvers
// rely on, so the numbers are deterministic and covered by tests (roadmap P0.4/P0.5).

/** GST rounding: half-up to 2 decimals (the rule GSTN applies per line/section). */
export function roundGst(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

/** Sum an array of numbers with GST rounding. */
export function sumGst(arr) {
  return roundGst(arr.reduce((a, v) => a + Number(v || 0), 0));
}

/** Split tax on `taxable` at `rate`% into heads. Inter-state ⇒ IGST, else CGST+SGST. */
export function splitTax(taxable, rate, interstate) {
  const tax = roundGst((Number(taxable) * Number(rate)) / 100);
  if (interstate) return { igst: tax, cgst: 0, sgst: 0, cess: 0, tax };
  const half = roundGst(tax / 2);
  return { igst: 0, cgst: half, sgst: roundGst(tax - half), cess: 0, tax };
}

/** Empty tax accumulator. */
export const zeroAmt = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 });

/** Accumulate amount `b` into `acc` (mutates + returns acc). */
export function addAmt(acc, b) {
  acc.taxable += Number(b.taxable || 0);
  acc.igst += Number(b.igst || 0);
  acc.cgst += Number(b.cgst || 0);
  acc.sgst += Number(b.sgst || 0);
  acc.cess += Number(b.cess || 0);
  acc.total += Number(b.total || 0);
  return acc;
}

/** Round every head of an amount object. */
export const roundAmt = (a) => ({
  taxable: roundGst(a.taxable), igst: roundGst(a.igst), cgst: roundGst(a.cgst),
  sgst: roundGst(a.sgst), cess: roundGst(a.cess), total: roundGst(a.total),
});

// ── GSTR-1 bucketing ─────────────────────────────────────────
// B2CL = inter-state supply to an unregistered person above this value (₹1,00,000 w.e.f. 2024).
export const B2CL_THRESHOLD = 100000;

/** Decide the GSTR-1 section for an outward invoice. */
export function gstr1Bucket({ recipientGstin, interstate, invoiceValue }) {
  if (recipientGstin) return 'B2B';
  if (interstate && Number(invoiceValue) > B2CL_THRESHOLD) return 'B2CL';
  return 'B2CS';
}

/**
 * Credit/Debit-note tax. Prefers explicit captured tax; falls back to the linked
 * invoice's blended rate when the note only carries a total (legacy data).
 */
export function computeCdnTax({ amount, taxable, cgst, sgst, igst, rate, refInterstate, refTaxable, refTaxTotal }) {
  const value = Number(amount || 0);
  // 1. Fully captured tax → use as-is.
  if (taxable != null && (cgst != null || sgst != null || igst != null)) {
    const tx = Number(taxable);
    return { taxable: roundGst(tx), igst: roundGst(igst || 0), cgst: roundGst(cgst || 0), sgst: roundGst(sgst || 0), cess: 0, total: roundGst(value || tx + Number(igst || 0) + Number(cgst || 0) + Number(sgst || 0)), rate: Number(rate || 0), derived: false };
  }
  // 2. Rate captured → split.
  if (rate != null && Number(rate) > 0) {
    const tx = taxable != null ? Number(taxable) : roundGst(value / (1 + Number(rate) / 100));
    const s = splitTax(tx, rate, !!refInterstate);
    return { taxable: roundGst(tx), igst: s.igst, cgst: s.cgst, sgst: s.sgst, cess: 0, total: roundGst(value || tx + s.tax), rate: Number(rate), derived: false };
  }
  // 3. Derive a blended rate from the referenced invoice (legacy fallback).
  const blended = refTaxable > 0 ? roundGst((Number(refTaxTotal) / Number(refTaxable)) * 100) : 0;
  const tx = blended > 0 ? roundGst(value / (1 + blended / 100)) : value;
  const s = splitTax(tx, blended, !!refInterstate);
  return { taxable: roundGst(tx), igst: s.igst, cgst: s.cgst, sgst: s.sgst, cess: 0, total: roundGst(value), rate: blended, derived: true };
}

// ── Reconciliation matching ──────────────────────────────────
export const normGstin = (s) => String(s ?? '').toUpperCase().trim();
/** Normalise a doc number for matching: upper, strip non-alnum, drop leading zeros. */
export const normDocNo = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=\d)/, '');
export const matchKey = (gstin, docNo) => `${normGstin(gstin)}|${normDocNo(docNo)}`;

/** Levenshtein edit distance. */
export function levenshtein(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j += 1) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i += 1) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m];
}

/** 0..1 string similarity (1 = identical). */
export function similarity(a, b) {
  a = normDocNo(a); b = normDocNo(b);
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length) || 1;
  return 1 - levenshtein(a, b) / max;
}

export const taxOf = (d) => roundGst(Number(d.igst || 0) + Number(d.cgst || 0) + Number(d.sgst || 0) + Number(d.cess || 0));

/** Within absolute (₹) OR percent tolerance. */
export function within(a, b, tolAbs = 2, tolPct = 1) {
  const diff = Math.abs(Number(a) - Number(b));
  if (diff <= tolAbs) return true;
  const base = Math.max(Math.abs(Number(a)), Math.abs(Number(b)), 1);
  return (diff / base) * 100 <= tolPct;
}

/**
 * Classify a portal doc against a candidate book doc.
 * Returns { status: MATCHED|MISMATCH, score: 0..1, reasons: string[] }.
 * `exact` = matched on GSTIN+docNo key; otherwise it's a probable candidate.
 */
export function classifyPair(portal, book, opts = {}) {
  const { tolAbs = 2, tolPct = 1, exact = true } = opts;
  const reasons = [];
  const pTax = taxOf(portal), bTax = taxOf(book);
  const taxOk = within(pTax, bTax, tolAbs, tolPct);
  const valOk = within(portal.total, book.total, tolAbs, tolPct);
  const taxableOk = within(portal.taxable, book.taxable, tolAbs, tolPct);
  if (!taxOk) reasons.push(`Tax differs ₹${roundGst(pTax - bTax)}`);
  if (!taxableOk) reasons.push(`Taxable differs ₹${roundGst(Number(portal.taxable) - Number(book.taxable))}`);
  if (!valOk) reasons.push(`Value differs ₹${roundGst(Number(portal.total) - Number(book.total))}`);
  if (portal.docDate && book.docDate && portal.docDate !== book.docDate) reasons.push('Date differs');

  // Score: docno similarity + amount closeness.
  const docSim = similarity(portal.docNo, book.docNo);
  const amtSim = 1 - Math.min(1, Math.abs(pTax - bTax) / Math.max(pTax, bTax, 1));
  const score = roundGst(0.5 * docSim + 0.5 * amtSim);

  if (exact) {
    return { status: taxOk && valOk ? 'MATCHED' : 'MISMATCH', score: 1, reasons: reasons.length ? reasons : ['Exact match'] };
  }
  // Probable: only when amounts line up closely and doc nos are similar.
  const isProbable = (taxOk || valOk) && docSim >= 0.6;
  return { status: isProbable ? 'PROBABLE' : 'PORTAL_ONLY', score, reasons: isProbable ? ['Probable: ' + reasons.filter(Boolean).slice(0, 2).join(', ') || 'near match'] : ['No book match'] };
}

/** Net per-head liability after ITC (floored at 0). */
export function netLiability(output, itc) {
  const f = (o, c) => Math.max(0, roundGst(Number(o || 0) - Number(c || 0)));
  return { igst: f(output.igst, itc.igst), cgst: f(output.cgst, itc.cgst), sgst: f(output.sgst, itc.sgst) };
}

/**
 * Interest u/s 50 (Rule 88B): 18% p.a. on net cash tax paid late, per head.
 * `days` = days past the due date. Returns rounded interest per head + total.
 */
export function interest88B({ igst = 0, cgst = 0, sgst = 0 }, days) {
  const d = Math.max(0, Number(days || 0));
  const r = (amt) => roundGst((Number(amt || 0) * 18 * d) / (100 * 365));
  const i = { igst: r(igst), cgst: r(cgst), sgst: r(sgst) };
  return { ...i, total: roundGst(i.igst + i.cgst + i.sgst) };
}

/** Late fee: ₹50/day (₹20/day for nil), capped, per the period. */
export function lateFee(days, isNil = false, cap = 5000) {
  const d = Math.max(0, Number(days || 0));
  return Math.min(cap, d * (isNil ? 20 : 50));
}
