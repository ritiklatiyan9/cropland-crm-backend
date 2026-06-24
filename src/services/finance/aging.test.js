// Unit tests for the pure aging core (services/finance/aging.js).
// Verifies bucket labels, bill-wise aging, On-Account handling, Debit/Credit
// splitting, and the "Pending = Σ buckets + On-Account" invariant — reproducing
// rows from the reference GrpBills "Group Outstandings" export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBuckets, ageItems } from './aging.js';

const AS_ON = '2026-06-24';
// Dates chosen to land squarely in each default bucket relative to AS_ON:
const D_0_30 = '2026-06-01';  // 23 days  → (< 30)
const D_30_60 = '2026-05-01'; // 54 days  → 30 to 60
const D_60_90 = '2026-04-10'; // 75 days  → 60 to 90
const D_90 = '2026-03-01';    // 115 days → (> 90)

test('makeBuckets default labels match the GrpBills format exactly', () => {
  const { labels, bounds } = makeBuckets();
  assert.deepEqual(bounds, [30, 60, 90]);
  assert.deepEqual(labels, ['(< 30 days )', '30 to 60 days', '60 to 90 days', '(> 90 days )']);
});

test('makeBuckets supports custom ascending cut-offs', () => {
  const { labels } = makeBuckets([15, 45]);
  assert.deepEqual(labels, ['(< 15 days )', '15 to 45 days', '(> 45 days )']);
});

test('ADITYA TRADERS — debit bills in 60-90 and >90 buckets', () => {
  // GrpBills: Pending 98639 Dr = 70647 (60-90) + 27992 (>90)
  const r = ageItems(
    [
      { date: D_60_90, amount: 70647, onAccount: false },
      { date: D_90, amount: 27992, onAccount: false },
    ],
    AS_ON,
  );
  assert.equal(r.pendingDebit, 98639);
  assert.equal(r.pendingCredit, 0);
  assert.deepEqual(r.buckets.map((c) => c.debit), [0, 0, 70647, 27992]);
  assert.equal(r.onAccountDebit, 0);
  assert.equal(r.oldestDays > 90, true);
});

test('AYUSH KHAD BHANDAR — unallocated credit lands in On-Account, not a bucket', () => {
  // GrpBills: Pending 2065 Cr, On Account 2065 Cr, all buckets empty.
  const r = ageItems([{ date: D_0_30, amount: -2065, onAccount: true }], AS_ON);
  assert.equal(r.pendingCredit, 2065);
  assert.equal(r.pendingDebit, 0);
  assert.equal(r.onAccountCredit, 2065);
  assert.deepEqual(r.buckets.map((c) => c.credit), [0, 0, 0, 0]);
});

test('SANSKAR PESTISIDE — bill-wise credit aged into < 30', () => {
  // GrpBills: Pending 75 Cr, (< 30) Cr 75, On Account 0.
  const r = ageItems([{ date: D_0_30, amount: -75, onAccount: false }], AS_ON);
  assert.equal(r.pendingCredit, 75);
  assert.equal(r.buckets[0].credit, 75);
  assert.equal(r.onAccountCredit, 0);
});

test('Pending = Σ bucket cells + On-Account (Dr & Cr) for a mixed party', () => {
  const r = ageItems(
    [
      { date: D_30_60, amount: 100000, onAccount: false }, // Dr bucket 1
      { date: D_90, amount: 50000, onAccount: false },     // Dr bucket 3
      { date: D_0_30, amount: -4000, onAccount: false },   // Cr bucket 0 (bill-wise)
      { date: D_0_30, amount: -1000, onAccount: true },    // Cr on-account
    ],
    AS_ON,
  );
  const sumDebit = r.buckets.reduce((s, c) => s + c.debit, 0) + r.onAccountDebit;
  const sumCredit = r.buckets.reduce((s, c) => s + c.credit, 0) + r.onAccountCredit;
  assert.equal(r.pendingDebit, sumDebit);
  assert.equal(r.pendingCredit, sumCredit);
  assert.equal(r.pendingDebit, 150000);
  assert.equal(r.pendingCredit, 5000);
});

test('within-bucket debits and credits net before splitting', () => {
  // Two same-bucket items net to a debit.
  const r = ageItems(
    [
      { date: D_60_90, amount: 5000, onAccount: false },
      { date: D_60_90, amount: -2000, onAccount: false },
    ],
    AS_ON,
  );
  assert.equal(r.buckets[2].debit, 3000);
  assert.equal(r.buckets[2].credit, 0);
  assert.equal(r.pendingDebit, 3000);
});

test('bucket boundary is inclusive of the upper edge (age 30 → < 30 bucket)', () => {
  // 2026-05-25 is exactly 30 days before 2026-06-24.
  const r = ageItems([{ date: '2026-05-25', amount: 1000, onAccount: false }], AS_ON);
  assert.equal(r.buckets[0].debit, 1000);
  assert.equal(r.buckets[1].debit, 0);
});
