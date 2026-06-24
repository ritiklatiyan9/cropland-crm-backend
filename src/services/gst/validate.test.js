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

test('GSTR-3B: net ITC mismatch ⇒ warning', () => {
  const p = {
    gstin: '27AAACM1234F1ZY', ret_period: '062026',
    sup_details: { osup_det: { txval: 1000, iamt: 180 } },
    itc_elg: { itc_avl: [{ iamt: 180 }], itc_rev: [{ iamt: 0 }], itc_net: { iamt: 50 } },
  };
  const r = validateGstr3bPayload(p);
  assert.ok(r.warnings.some((w) => /ITC net/.test(w)));
});
