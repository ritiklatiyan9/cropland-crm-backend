// Period resolution for financial reports — pure, dependency-free (unit-testable
// without a DB or env). Presets use the Indian financial year (Apr 1 – Mar 31).

const pad = (n) => String(n).padStart(2, '0');
const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
/** Last calendar day of month `m` (1-12) in year `y`. */
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** A UTC-midnight Date for the period reference: `toDate` if given, else today. */
function refDate(toDate) {
  if (toDate) {
    const [y, m, d] = toDate.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}

/**
 * Resolve a report type + optional explicit dates into a concrete {reportType, from, to}.
 * Explicit from+to always win (treated as CUSTOM). Otherwise the preset is computed
 * around the reference date (toDate, else today).
 * @param {string} [reportType] WEEKLY | MONTHLY | QUARTERLY | YEARLY | CUSTOM
 * @param {string} [fromDate] YYYY-MM-DD
 * @param {string} [toDate]   YYYY-MM-DD
 */
export function resolvePeriod(reportType, fromDate, toDate) {
  const type = (reportType || 'CUSTOM').toUpperCase();
  if (fromDate && toDate) return { reportType: 'CUSTOM', from: fromDate, to: toDate };

  const ref = refDate(toDate);
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth() + 1;

  if (type === 'WEEKLY') {
    const dow = (ref.getUTCDay() + 6) % 7; // 0 = Monday
    const mon = new Date(ref);
    mon.setUTCDate(ref.getUTCDate() - dow);
    const sun = new Date(mon);
    sun.setUTCDate(mon.getUTCDate() + 6);
    return { reportType: type, from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) };
  }
  if (type === 'MONTHLY') {
    return { reportType: type, from: fmt(y, m, 1), to: fmt(y, m, lastDay(y, m)) };
  }
  if (type === 'QUARTERLY') {
    let qStart;
    if (m >= 4 && m <= 6) qStart = 4;
    else if (m >= 7 && m <= 9) qStart = 7;
    else if (m >= 10 && m <= 12) qStart = 10;
    else qStart = 1; // Jan–Mar
    const qEnd = qStart + 2;
    return { reportType: type, from: fmt(y, qStart, 1), to: fmt(y, qEnd, lastDay(y, qEnd)) };
  }
  // YEARLY (and CUSTOM with no dates) → Indian financial year containing the ref.
  const fyStart = m >= 4 ? y : y - 1;
  return { reportType: type === 'CUSTOM' ? 'YEARLY' : type, from: fmt(fyStart, 4, 1), to: fmt(fyStart + 1, 3, 31) };
}
