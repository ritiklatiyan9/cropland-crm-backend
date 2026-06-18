// Unit tests for the financial-report period engine (pure, no DB/env needed).
// Run: node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriod } from './period.js';

test('explicit from+to is treated as CUSTOM and passed through verbatim', () => {
  const p = resolvePeriod('YEARLY', '2024-01-05', '2024-02-10');
  assert.deepEqual(p, { reportType: 'CUSTOM', from: '2024-01-05', to: '2024-02-10' });
});

test('MONTHLY spans the full calendar month of the reference (toDate)', () => {
  const p = resolvePeriod('MONTHLY', null, '2024-02-15'); // leap February
  assert.equal(p.from, '2024-02-01');
  assert.equal(p.to, '2024-02-29');
});

test('YEARLY uses the Indian financial year (Apr 1 – Mar 31)', () => {
  // A date in Jan belongs to the FY that started the previous April.
  const jan = resolvePeriod('YEARLY', null, '2024-01-10');
  assert.deepEqual([jan.from, jan.to], ['2023-04-01', '2024-03-31']);
  // A date in May belongs to the FY starting that April.
  const may = resolvePeriod('YEARLY', null, '2024-05-10');
  assert.deepEqual([may.from, may.to], ['2024-04-01', '2025-03-31']);
});

test('QUARTERLY maps to the correct Indian-FY quarter', () => {
  assert.deepEqual(pick(resolvePeriod('QUARTERLY', null, '2024-05-15')), ['2024-04-01', '2024-06-30']); // Q1
  assert.deepEqual(pick(resolvePeriod('QUARTERLY', null, '2024-08-15')), ['2024-07-01', '2024-09-30']); // Q2
  assert.deepEqual(pick(resolvePeriod('QUARTERLY', null, '2024-11-15')), ['2024-10-01', '2024-12-31']); // Q3
  assert.deepEqual(pick(resolvePeriod('QUARTERLY', null, '2024-02-15')), ['2024-01-01', '2024-03-31']); // Q4
});

test('WEEKLY returns a Monday→Sunday range containing the reference date', () => {
  const p = resolvePeriod('WEEKLY', null, '2024-06-19'); // a Wednesday
  assert.equal(p.from, '2024-06-17'); // Monday
  assert.equal(p.to, '2024-06-23'); // Sunday
  assert.equal(new Date(p.from + 'T00:00:00Z').getUTCDay(), 1);
  assert.equal(new Date(p.to + 'T00:00:00Z').getUTCDay(), 0);
});

test('CUSTOM with no dates falls back to the current Indian financial year', () => {
  const p = resolvePeriod('CUSTOM', null, null);
  assert.equal(p.reportType, 'YEARLY');
  assert.match(p.from, /-04-01$/);
  assert.match(p.to, /-03-31$/);
});

function pick(p) {
  return [p.from, p.to];
}
