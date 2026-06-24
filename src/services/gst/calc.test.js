// Unit tests for the pure GST calc engine (roadmap P0.4). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roundGst, splitTax, gstr1Bucket, B2CL_THRESHOLD, computeCdnTax,
  normDocNo, matchKey, similarity, classifyPair, netLiability, interest88B, lateFee, within,
} from './calc.js';

test('roundGst: half-up to 2 decimals', () => {
  assert.equal(roundGst(1.005), 1.01);
  assert.equal(roundGst(2.344), 2.34);
  assert.equal(roundGst(1000 * 0.18), 180);
});

test('splitTax: intra-state splits into equal CGST/SGST', () => {
  const s = splitTax(1000, 18, false);
  assert.deepEqual(s, { igst: 0, cgst: 90, sgst: 90, cess: 0, tax: 180 });
});

test('splitTax: inter-state is all IGST', () => {
  const s = splitTax(1000, 18, true);
  assert.deepEqual(s, { igst: 180, cgst: 0, sgst: 0, cess: 0, tax: 180 });
});

test('splitTax: odd tax cents balance so cgst+sgst = total tax', () => {
  const s = splitTax(105, 5, false); // tax = 5.25
  assert.equal(s.cgst + s.sgst, 5.25);
});

test('gstr1Bucket: B2B when recipient has GSTIN', () => {
  assert.equal(gstr1Bucket({ recipientGstin: '27ABCDE1234F1Z5', interstate: true, invoiceValue: 5000 }), 'B2B');
});

test('gstr1Bucket: B2CL boundary at threshold', () => {
  assert.equal(gstr1Bucket({ recipientGstin: null, interstate: true, invoiceValue: B2CL_THRESHOLD }), 'B2CS'); // not > threshold
  assert.equal(gstr1Bucket({ recipientGstin: null, interstate: true, invoiceValue: B2CL_THRESHOLD + 1 }), 'B2CL');
  assert.equal(gstr1Bucket({ recipientGstin: null, interstate: false, invoiceValue: 999999 }), 'B2CS'); // intra never B2CL
});

test('computeCdnTax: uses captured tax when present (exact, not derived)', () => {
  const r = computeCdnTax({ amount: 1180, taxable: 1000, cgst: 90, sgst: 90, igst: 0 });
  assert.equal(r.derived, false);
  assert.equal(r.taxable, 1000);
  assert.equal(r.cgst + r.sgst, 180);
});

test('computeCdnTax: derives blended rate from referenced invoice (legacy)', () => {
  const r = computeCdnTax({ amount: 1180, refInterstate: false, refTaxable: 1000, refTaxTotal: 180 });
  assert.equal(r.derived, true);
  assert.equal(r.rate, 18);
  assert.ok(within(r.taxable, 1000, 1));
});

test('normDocNo + matchKey: normalise case/punctuation/leading zeros', () => {
  assert.equal(normDocNo('inv/00123'), 'INV00123'); // strips punctuation/case
  assert.equal(normDocNo('00123'), '123');          // fully-numeric ⇒ leading zeros dropped
  assert.equal(matchKey('27abcde1234f1z5', 'Inv-001'), '27ABCDE1234F1Z5|INV001');
});

test('similarity: identical = 1, near = high', () => {
  assert.equal(similarity('INV123', 'INV123'), 1);
  assert.ok(similarity('INV123', 'INV124') > 0.7);
});

test('classifyPair: exact key + equal amounts ⇒ MATCHED', () => {
  const p = { docNo: 'INV1', taxable: 1000, igst: 180, cgst: 0, sgst: 0, total: 1180 };
  const b = { docNo: 'INV1', taxable: 1000, igst: 180, cgst: 0, sgst: 0, total: 1180 };
  const r = classifyPair(p, b, { exact: true });
  assert.equal(r.status, 'MATCHED');
});

test('classifyPair: exact key + tax differs ⇒ MISMATCH with reason', () => {
  const p = { docNo: 'INV1', taxable: 1000, igst: 200, total: 1200 };
  const b = { docNo: 'INV1', taxable: 1000, igst: 180, total: 1180 };
  const r = classifyPair(p, b, { exact: true });
  assert.equal(r.status, 'MISMATCH');
  assert.ok(r.reasons.join(' ').toLowerCase().includes('tax'));
});

test('classifyPair: non-exact near doc + equal amount ⇒ PROBABLE', () => {
  const p = { docNo: 'INV124', taxable: 1000, igst: 180, total: 1180 };
  const b = { docNo: 'INV123', taxable: 1000, igst: 180, total: 1180 };
  const r = classifyPair(p, b, { exact: false });
  assert.equal(r.status, 'PROBABLE');
  assert.ok(r.score > 0.5);
});

test('netLiability: floors each head at zero', () => {
  const n = netLiability({ igst: 100, cgst: 50, sgst: 50 }, { igst: 120, cgst: 30, sgst: 0 });
  assert.deepEqual(n, { igst: 0, cgst: 20, sgst: 50 });
});

test('interest88B: 18% p.a. pro-rata', () => {
  const i = interest88B({ cgst: 1000, sgst: 1000 }, 30); // ~ 1000*18%*30/365 each
  assert.ok(within(i.cgst, 14.79, 0.1));
  assert.equal(i.total, roundGst(i.igst + i.cgst + i.sgst));
});

test('lateFee: 50/day normal, 20/day nil, capped', () => {
  assert.equal(lateFee(10), 500);
  assert.equal(lateFee(10, true), 200);
  assert.equal(lateFee(1000), 5000); // cap
});
