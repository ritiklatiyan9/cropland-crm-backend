// GSTN payload validators — bake the GST Returns Offline Tool's checks into the
// app so a generated GSTR-1 / GSTR-3B JSON can be confirmed BEFORE upload
// (roadmap P0.1). Pure, dependency-free, unit-tested (validate.test.js).

import { validateGstin } from './stateCodes.js';

// GST rates allowed on the portal (incl. cess-relevant + special rates).
const VALID_RATES = new Set([0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28]);
const DMY_RE = /^\d{2}-\d{2}-\d{4}$/;
// GSTN document-number rule: max 16 chars — alphanumeric plus "/" and "-".
const DOC_NO_RE = /^[A-Za-z0-9/-]{1,16}$/;
// HSN (goods) is 4/6/8 numeric digits; SAC (services) is 6.
const HSN_RE = /^(\d{4}|\d{6}|\d{8})$/;
// GSTN Unit Quantity Codes commonly accepted by the offline tool.
const VALID_UQC = new Set([
  'BAG', 'BAL', 'BDL', 'BKL', 'BOU', 'BOX', 'BTL', 'BUN', 'CAN', 'CBM', 'CCM', 'CMS',
  'CTN', 'DOZ', 'DRM', 'GGK', 'GMS', 'GRS', 'GYD', 'KGS', 'KLR', 'KME', 'LTR', 'MLS',
  'MLT', 'MTR', 'MTS', 'NOS', 'OTH', 'PAC', 'PCS', 'PRS', 'QTL', 'ROL', 'SET', 'SQF',
  'SQM', 'SQY', 'TBS', 'TGM', 'THD', 'TON', 'TUB', 'UGS', 'UNT', 'YDS',
]);
const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v || 0);

/** fp 'MMYYYY' → sortable 'yyyymm'. */
const fpKey = (fp) => (/^\d{6}$/.test(String(fp || '')) ? `${String(fp).slice(2)}${String(fp).slice(0, 2)}` : null);
/** idt 'dd-mm-yyyy' → sortable 'yyyymm'. */
const idtKey = (idt) => (DMY_RE.test(String(idt || '')) ? `${String(idt).slice(6)}${String(idt).slice(3, 5)}` : null);

function checkDocNo(no, ctx, errors) {
  if (!no) { errors.push(`${ctx}: missing document number`); return; }
  if (!DOC_NO_RE.test(String(no))) errors.push(`${ctx}: document no "${no}" invalid (max 16 chars, alphanumeric / -)`);
}

function checkItem(itm, ctx, errors, warnings, opts = {}) {
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
  // POS ↔ tax-head consistency: IGST for inter-state (POS ≠ supplier state), CGST/SGST for intra.
  const { pos, supplierState } = opts;
  if (pos && supplierState) {
    if (num(d.iamt) > 0 && pos === supplierState) warnings.push(`${ctx}: IGST charged but POS ${pos} is the supplier's own state (intra-state ⇒ CGST/SGST)`);
    if ((num(d.camt) > 0 || num(d.samt) > 0) && pos !== supplierState) warnings.push(`${ctx}: CGST/SGST charged but POS ${pos} differs from supplier state ${supplierState} (inter-state ⇒ IGST)`);
  }
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

  const supplierState = String(p.gstin || '').slice(0, 2) || null;
  const period = fpKey(p.fp);
  const seenInum = new Set();
  const secTotals = { sections: 0, hsn: 0 }; // taxable cross-foot: B2B+B2CL+B2CS vs HSN Table 12

  const checkDate = (dmy, ctx) => {
    if (!DMY_RE.test(dmy || '')) { errors.push(`${ctx}: date must be dd-mm-yyyy`); return; }
    const k = idtKey(dmy);
    if (period && k && k > period) errors.push(`${ctx}: document date ${dmy} is after the return period`);
  };

  for (const party of p.b2b || []) {
    if (!validateGstin(party.ctin).valid) errors.push(`B2B: invalid recipient GSTIN ${party.ctin}`);
    if (party.ctin && p.gstin && String(party.ctin).toUpperCase() === String(p.gstin).toUpperCase()) {
      errors.push(`B2B: recipient GSTIN ${party.ctin} is the supplier's own GSTIN (self-invoice)`);
    }
    for (const inv of party.inv || []) {
      checkDocNo(inv.inum, 'B2B', errors);
      if (inv.inum) {
        if (seenInum.has(inv.inum)) errors.push(`B2B ${inv.inum}: duplicate invoice number in the return`);
        seenInum.add(inv.inum);
      }
      checkDate(inv.idt, `B2B ${inv.inum}`);
      if (!(num(inv.val) > 0)) warnings.push(`B2B ${inv.inum}: invoice value not positive`);
      if (!String(inv.pos || '').match(/^\d{2}$/)) errors.push(`B2B ${inv.inum}: pos must be a 2-digit state code`);
      if (!['Y', 'N'].includes(inv.rchrg)) warnings.push(`B2B ${inv.inum}: rchrg should be Y/N`);
      for (const it of inv.itms || []) {
        checkItem(it, `B2B ${inv.inum}`, errors, warnings, { pos: inv.pos, supplierState });
        secTotals.sections += num((it.itm_det || it).txval);
      }
    }
  }
  for (const party of p.b2cl || []) {
    if (!String(party.pos || '').match(/^\d{2}$/)) errors.push('B2CL: pos must be a 2-digit state code');
    if (party.pos && party.pos === supplierState) errors.push(`B2CL: POS ${party.pos} cannot be the supplier's own state (B2CL is inter-state only)`);
    for (const inv of party.inv || []) {
      checkDocNo(inv.inum, 'B2CL', errors);
      checkDate(inv.idt, `B2CL ${inv.inum}`);
      if (!(num(inv.val) > 100000)) warnings.push(`B2CL ${inv.inum}: value should exceed ₹1,00,000`);
      for (const it of inv.itms || []) {
        checkItem(it, `B2CL ${inv.inum}`, errors, warnings, { pos: party.pos, supplierState });
        secTotals.sections += num((it.itm_det || it).txval);
      }
    }
  }
  for (const row of p.b2cs || []) {
    if (!['INTER', 'INTRA'].includes(row.sply_ty)) errors.push('B2CS: sply_ty must be INTER/INTRA');
    if (!String(row.pos || '').match(/^\d{2}$/)) errors.push('B2CS: pos must be a 2-digit state code');
    if (row.sply_ty === 'INTER' && row.pos === supplierState) warnings.push(`B2CS: INTER supply with POS ${row.pos} = supplier state`);
    if (row.sply_ty === 'INTRA' && supplierState && row.pos && row.pos !== supplierState) warnings.push(`B2CS: INTRA supply with POS ${row.pos} ≠ supplier state ${supplierState}`);
    checkItem(row, `B2CS ${row.pos}@${row.rt}`, errors, warnings, { pos: row.pos, supplierState });
    secTotals.sections += num(row.txval);
  }
  for (const party of p.cdnr || []) {
    if (!validateGstin(party.ctin).valid) errors.push(`CDNR: invalid GSTIN ${party.ctin}`);
    for (const nt of party.nt || []) {
      if (!['C', 'D'].includes(nt.ntty)) errors.push(`CDNR ${nt.nt_num}: ntty must be C/D`);
      checkDocNo(nt.nt_num, 'CDNR', errors);
      checkDate(nt.nt_dt, `CDNR ${nt.nt_num}`);
      if (!String(nt.pos || '').match(/^\d{2}$/)) errors.push(`CDNR ${nt.nt_num}: pos must be a 2-digit state code`);
      for (const it of nt.itms || []) checkItem(it, `CDNR ${nt.nt_num}`, errors, warnings, { pos: nt.pos, supplierState });
    }
  }
  for (const h of (p.hsn && p.hsn.data) || []) {
    if (!h.hsn_sc) warnings.push('HSN: a row is missing the HSN/SAC code');
    else if (!HSN_RE.test(String(h.hsn_sc))) errors.push(`HSN: code "${h.hsn_sc}" must be 4, 6 or 8 numeric digits`);
    else if (String(h.hsn_sc).length === 4) warnings.push(`HSN ${h.hsn_sc}: 4-digit code — 6 digits are mandatory when AATO exceeds ₹5 crore`);
    if (h.uqc && !VALID_UQC.has(String(h.uqc).toUpperCase())) warnings.push(`HSN ${h.hsn_sc || ''}: UQC "${h.uqc}" is not a standard GSTN unit code`);
    if (num(h.txval) < 0) errors.push('HSN: negative taxable value');
    secTotals.hsn += num(h.txval);
  }
  // Table 12 (HSN) should cross-foot with the outward sections (B2B+B2CL+B2CS).
  if (((p.hsn && p.hsn.data) || []).length && Math.abs(r2(secTotals.sections) - r2(secTotals.hsn)) > 1) {
    warnings.push(`HSN summary taxable ₹${r2(secTotals.hsn)} ≠ B2B+B2CL+B2CS taxable ₹${r2(secTotals.sections)}`);
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
  // Negative values are allowed only in 3.1(a) (credit notes may exceed supplies
  // since the July-2022 3B changes); everywhere else they are rejected.
  for (const [k, v] of Object.entries(sd)) {
    for (const head of ['txval', 'iamt', 'camt', 'samt', 'csamt']) {
      if (v && num(v[head]) < 0) {
        if (k === 'osup_det') warnings.push(`sup_details.osup_det.${head} is negative (credit notes exceed outward supplies this period)`);
        else errors.push(`sup_details.${k}.${head} is negative`);
      }
    }
  }
  const itc = p.itc_elg || {};
  // Net ITC must equal available − reversed (within ₹1) per head.
  const sumBy = (arr, h) => (arr || []).reduce((a, x) => a + num(x[h]), 0);
  for (const h of ['iamt', 'camt', 'samt']) {
    const net = itc.itc_net ? num(itc.itc_net[h]) : 0;
    const expected = r2(sumBy(itc.itc_avl, h) - sumBy(itc.itc_rev, h));
    if (Math.abs(net - expected) > 1) warnings.push(`ITC net ${h} ${net} ≠ available − reversed ${expected}`);
    if (net < 0) errors.push(`ITC net ${h} is negative`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function validatePayload(returnType, payload) {
  return String(returnType).toUpperCase() === 'GSTR1'
    ? validateGstr1Payload(payload)
    : validateGstr3bPayload(payload);
}
