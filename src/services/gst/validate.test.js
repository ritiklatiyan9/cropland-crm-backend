// Tests for the GSTN payload validators (roadmap P0.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGstr1Payload, validateGstr3bPayload } from './validate.js';

const goodB2b = {
  gstin: '27AAACM1234F1ZY', fp: '062026', version: 'GST3.0.4', gt: 0, cur_gt: 100000,
  b2b: [{ ctin: '29AAACM5678G1Z4', inv: [{ inum: 'INV1', idt: '15-06-2026', val: 1180, pos: '29', rchrg: 'N', inv_typ: 'R',
    itms: [{ num: 1, itm_det: { rt: 18, txval: 1000, iamt: 180, camt: 0, samt: 0, csamt: 0 } }] }] }],
};

test('GSTR-1: a well-formed B2B payload is valid', () => {
  const r = validateGstr1Payload(goodB2b);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('GSTR-1: bad supplier GSTIN ⇒ error', () => {
  const r = validateGstr1Payload({ ...goodB2b, gstin: 'NOPE' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /GSTIN/.test(e)));
});

test('GSTR-1: bad period ⇒ error', () => {
  const r = validateGstr1Payload({ ...goodB2b, fp: '2026-06' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /fp/.test(e)));
});

test('GSTR-1: wrong date format ⇒ error', () => {
  const p = JSON.parse(JSON.stringify(goodB2b));
  p.b2b[0].inv[0].idt = '2026-06-15';
  const r = validateGstr1Payload(p);
  assert.ok(r.errors.some((e) => /dd-mm-yyyy/.test(e)));
});

test('GSTR-1: both IGST and CGST present ⇒ error', () => {
  const p = JSON.parse(JSON.stringify(goodB2b));
  p.b2b[0].inv[0].itms[0].itm_det = { rt: 18, txval: 1000, iamt: 90, camt: 45, samt: 45, csamt: 0 };
  const r = validateGstr1Payload(p);
  assert.ok(r.errors.some((e) => /both IGST/.test(e)));
});

test('GSTR-1: tax not matching txval×rate ⇒ warning', () => {
  const p = JSON.parse(JSON.stringify(goodB2b));
  p.b2b[0].inv[0].itms[0].itm_det.iamt = 999;
  const r = validateGstr1Payload(p);
  assert.ok(r.warnings.some((w) => /≠ taxable×rate/.test(w)));
});

test('GSTR-3B: net ITC = available − reversed passes', () => {
  const p = {
    gstin: '27AAACM1234F1ZY', ret_period: '062026',
    sup_details: { osup_det: { txval: 1000, iamt: 180, camt: 0, samt: 0, csamt: 0 } },
    itc_elg: { itc_avl: [{ iamt: 180, camt: 0, samt: 0 }], itc_rev: [{ iamt: 0, camt: 0, samt: 0 }], itc_net: { iamt: 180, camt: 0, samt: 0 } },
  };
  const r = validateGstr3bPayload(p);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('GSTR-3B: missing osup_det ⇒ error', () => {
  const r = validateGstr3bPayload({ gstin: '27AAACM1234F1ZY', ret_period: '062026', sup_details: {} });
  assert.ok(r.errors.some((e) => /osup_det/.test(e)));
});

test('GSTR-1: invoice number over 16 chars ⇒ error', () => {
  const p = JSON.parse(JSON.stringify(goodB2b));
  p.b2b[0].inv[0].inum = 'INV/2026/000000000123';
  const r = validateGstr1Payload(p);
  assert.ok(r.errors.some((e) => /max 16 chars/.test(e)));
});

test('GSTR-1: duplicate invoice number ⇒ error', () => {
  const p = JSON.parse(JSON.stringify(goodB2b));
  p.b2b[0].inv.push(JSON.parse(JSON.stringify(p.b2b[0].inv[0])));
  const r = validateGstr1Payload(p);
  assert.ok(r.errors.some((e) => /duplicate invoice number/.test(e)));
});

test('GSTR-1: recipient GSTIN = supplier GSTIN ⇒ self-invoice error', () => {
  const p = JSON.parse(JSON.stringify(goodB2b));
  p.b2b[0].ctin = p.gstin;
  const r = validateGstr1Payload(p);
  assert.ok(r.errors.some((e) => /self-invoice/.test(e)));
});

test('GSTR-1: IGST charged with POS = supplier state ⇒ warning', () => {
  const p = JSON.parse(JSON.stringify(goodB2b));
  p.b2b[0].inv[0].pos = '27'; // same as supplier GSTIN state
  const r = validateGstr1Payload(p);
  assert.ok(r.warnings.some((w) => /IGST charged but POS/.test(w)));
});

test('GSTR-1: invoice dated after the return period ⇒ error', () => {
  const p = JSON.parse(JSON.stringify(goodB2b));
  p.b2b[0].inv[0].idt = '15-07-2026'; // fp is 062026
  const r = validateGstr1Payload(p);
  assert.ok(r.errors.some((e) => /after the return period/.test(e)));
});

test('GSTR-1: malformed HSN ⇒ error, 4-digit HSN ⇒ warning', () => {
  const p = JSON.parse(JSON.stringify(goodB2b));
  p.hsn = { data: [
    { num: 1, hsn_sc: '31A5', uqc: 'KGS', qty: 1, rt: 18, txval: 500, iamt: 90, camt: 0, samt: 0, csamt: 0 },
    { num: 2, hsn_sc: '3105', uqc: 'KGS', qty: 1, rt: 18, txval: 500, iamt: 90, camt: 0, samt: 0, csamt: 0 },
  ] };
  const r = validateGstr1Payload(p);
  assert.ok(r.errors.some((e) => /must be 4, 6 or 8 numeric digits/.test(e)));
  assert.ok(r.warnings.some((w) => /4-digit code/.test(w)));
});

test('GSTR-1: HSN summary not tying to sections ⇒ warning', () => {
  const p = JSON.parse(JSON.stringify(goodB2b));
  p.hsn = { data: [{ num: 1, hsn_sc: '310510', uqc: 'KGS', qty: 1, rt: 18, txval: 400, iamt: 72, camt: 0, samt: 0, csamt: 0 }] };
  const r = validateGstr1Payload(p); // sections taxable = 1000, hsn = 400
  assert.ok(r.warnings.some((w) => /HSN summary taxable/.test(w)));
});

test('GSTR-1: CDNR note without pos ⇒ error', () => {
  const p = JSON.parse(JSON.stringify(goodB2b));
  p.cdnr = [{ ctin: '29AAACM5678G1Z4', nt: [{ ntty: 'C', nt_num: 'CN1', nt_dt: '15-06-2026', val: 118,
    itms: [{ num: 1, itm_det: { rt: 18, txval: 100, iamt: 18, camt: 0, samt: 0, csamt: 0 } }] }] }];
  const r = validateGstr1Payload(p);
  assert.ok(r.errors.some((e) => /CDNR CN1: pos/.test(e)));
});

test('GSTR-3B: negative 3.1(a) allowed as warning, negative elsewhere ⇒ error', () => {
  const p = {
    gstin: '27AAACM1234F1ZY', ret_period: '062026',
    sup_details: { osup_det: { txval: -500, iamt: -90 }, isup_rev: { txval: -10 } },
    itc_elg: { itc_avl: [{ iamt: 0 }], itc_rev: [{ iamt: 0 }], itc_net: { iamt: 0 } },
  };
  const r = validateGstr3bPayload(p);
  assert.ok(r.warnings.some((w) => /osup_det.txval is negative/.test(w)));
  assert.ok(r.errors.some((e) => /isup_rev.txval is negative/.test(e)));
});

test('GSTR-3B: net ITC mismatch ⇒ warning', () => {
  const p = {
    gstin: '27AAACM1234F1ZY', ret_period: '062026',
    sup_details: { osup_det: { txval: 1000, iamt: 180 } },
    itc_elg: { itc_avl: [{ iamt: 180 }], itc_rev: [{ iamt: 0 }], itc_net: { iamt: 50 } },
  };
  const r = validateGstr3bPayload(p);
  assert.ok(r.warnings.some((w) => /ITC net/.test(w)));
});
