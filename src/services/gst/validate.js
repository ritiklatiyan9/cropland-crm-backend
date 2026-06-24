// GSTN payload validators — bake the GST Returns Offline Tool's checks into the
// app so a generated GSTR-1 / GSTR-3B JSON can be confirmed BEFORE upload
// (roadmap P0.1). Pure, dependency-free, unit-tested (validate.test.js).

import { validateGstin } from './stateCodes.js';

// GST rates allowed on the portal (incl. cess-relevant + special rates).
const VALID_RATES = new Set([0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28]);
const DMY_RE = /^\d{2}-\d{2}-\d{4}$/;
const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v || 0);

function checkItem(itm, ctx, errors, warnings) {
  const d = itm.itm_det || itm;
  if (d.rt == null) errors.push(`${ctx}: missing rate (rt)`);
  else if (!VALID_RATES.has(Number(d.rt))) warnings.push(`${ctx}: unusual GST rate ${d.rt}%`);
  if (num(d.txval) < 0) errors.push(`${ctx}: negative taxable value`);
  // tax must reconcile to txval × rate (±₹1 tolerance).
  const expected = r2((num(d.txval) * num(d.rt)) / 100);
  const actual = r2(num(d.iamt) + num(d.camt) + num(d.samt));
  if (Math.abs(expected - actual) > 1) warnings.push(`${ctx}: tax ${actual} ≠ taxable×rate ${expected}`);
  // either IGST, or CGST+SGST — never both.
  if (num(d.iamt) > 0 && (num(d.camt) > 0 || num(d.samt) > 0)) errors.push(`${ctx}: both IGST and CGST/SGST present`);
}

/** Validate a GSTR-1 portal payload. Returns { valid, errors, warnings }. */
export function validateGstr1Payload(p = {}) {
  const errors = [];
  const warnings = [];
  if (!validateGstin(p.gstin).valid) errors.push('Invalid or missing supplier GSTIN');
  if (!/^\d{6}$/.test(String(p.fp || ''))) errors.push('fp (return period) must be MMYYYY');
  if (!p.version) warnings.push('version missing (expected e.g. GST3.0.4)');
  if (p.gt == null) warnings.push('gt (aggregate turnover of preceding FY) not set');
  if (p.cur_gt == null) warnings.push('cur_gt (turnover April → period) not set');

  for (const party of p.b2b || []) {
    if (!validateGstin(party.ctin).valid) errors.push(`B2B: invalid recipient GSTIN ${party.ctin}`);
    for (const inv of party.inv || []) {
      if (!inv.inum) errors.push('B2B: invoice missing number (inum)');
      if (!DMY_RE.test(inv.idt || '')) errors.push(`B2B ${inv.inum}: idt must be dd-mm-yyyy`);
      if (!(num(inv.val) > 0)) warnings.push(`B2B ${inv.inum}: invoice value not positive`);
      if (!String(inv.pos || '').match(/^\d{2}$/)) errors.push(`B2B ${inv.inum}: pos must be a 2-digit state code`);
      if (!['Y', 'N'].includes(inv.rchrg)) warnings.push(`B2B ${inv.inum}: rchrg should be Y/N`);
      for (const it of inv.itms || []) checkItem(it, `B2B ${inv.inum}`, errors, warnings);
    }
  }
  for (const party of p.b2cl || []) {
    if (!String(party.pos || '').match(/^\d{2}$/)) errors.push('B2CL: pos must be a 2-digit state code');
    for (const inv of party.inv || []) {
      if (!DMY_RE.test(inv.idt || '')) errors.push(`B2CL ${inv.inum}: idt must be dd-mm-yyyy`);
      if (!(num(inv.val) > 100000)) warnings.push(`B2CL ${inv.inum}: value should exceed ₹1,00,000`);
      for (const it of inv.itms || []) checkItem(it, `B2CL ${inv.inum}`, errors, warnings);
    }
  }
  for (const row of p.b2cs || []) {
    if (!['INTER', 'INTRA'].includes(row.sply_ty)) errors.push('B2CS: sply_ty must be INTER/INTRA');
    if (!String(row.pos || '').match(/^\d{2}$/)) errors.push('B2CS: pos must be a 2-digit state code');
    checkItem(row, `B2CS ${row.pos}@${row.rt}`, errors, warnings);
  }
  for (const party of p.cdnr || []) {
    if (!validateGstin(party.ctin).valid) errors.push(`CDNR: invalid GSTIN ${party.ctin}`);
    for (const nt of party.nt || []) {
      if (!['C', 'D'].includes(nt.ntty)) errors.push(`CDNR ${nt.nt_num}: ntty must be C/D`);
      if (!DMY_RE.test(nt.nt_dt || '')) errors.push(`CDNR ${nt.nt_num}: nt_dt must be dd-mm-yyyy`);
      for (const it of nt.itms || []) checkItem(it, `CDNR ${nt.nt_num}`, errors, warnings);
    }
  }
  for (const h of (p.hsn && p.hsn.data) || []) {
    if (!h.hsn_sc) warnings.push('HSN: a row is missing the HSN/SAC code');
    if (num(h.txval) < 0) errors.push('HSN: negative taxable value');
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** Validate a GSTR-3B portal payload. Returns { valid, errors, warnings }. */
export function validateGstr3bPayload(p = {}) {
  const errors = [];
  const warnings = [];
  if (!validateGstin(p.gstin).valid) errors.push('Invalid or missing supplier GSTIN');
  if (!/^\d{6}$/.test(String(p.ret_period || ''))) errors.push('ret_period must be MMYYYY');
  const sd = p.sup_details || {};
  if (!sd.osup_det) errors.push('sup_details.osup_det (3.1a) missing');
  // No negative values anywhere in supply details.
  for (const [k, v] of Object.entries(sd)) {
    for (const head of ['txval', 'iamt', 'camt', 'samt', 'csamt']) {
      if (v && num(v[head]) < 0) errors.push(`sup_details.${k}.${head} is negative`);
    }
  }
  const itc = p.itc_elg || {};
  // Net ITC must equal available − reversed (within ₹1) per head.
  const sumBy = (arr, h) => (arr || []).reduce((a, x) => a + num(x[h]), 0);
  for (const h of ['iamt', 'camt', 'samt']) {
    const net = itc.itc_net ? num(itc.itc_net[h]) : 0;
    const expected = r2(sumBy(itc.itc_avl, h) - sumBy(itc.itc_rev, h));
    if (Math.abs(net - expected) > 1) warnings.push(`ITC net ${h} ${net} ≠ available − reversed ${expected}`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function validatePayload(returnType, payload) {
  return String(returnType).toUpperCase() === 'GSTR1'
    ? validateGstr1Payload(payload)
    : validateGstr3bPayload(payload);
}
