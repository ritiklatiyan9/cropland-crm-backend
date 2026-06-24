// ─────────────────────────────────────────────────────────────────────────────
// AGING / OUTSTANDINGS ENGINE  (Tally-style "Group Outstandings")
//
// What an Aging Report is (the accounting definition this implements):
//   An Accounts-Receivable (or -Payable) *Aging Report* — a.k.a. an aged-trial-
//   balance / aging schedule — categorises every unpaid bill by how long it has
//   been outstanding ("as on" a chosen date), grouped into time buckets
//   (typically < 30, 30–60, 60–90, > 90 days). It is the standard tool for:
//     • spotting slow-paying / delinquent parties and prioritising collections,
//     • estimating doubtful debts / provisioning, and
//     • managing working-capital / cash-flow and credit limits.
//   Tally exposes the same idea as the "Group Outstandings" statement: one row
//   per ledger (party) under a group (Sundry Debtors / Sundry Creditors), with a
//   "Pending Bills" total, the aged buckets, and an "On Account" column for
//   receipts/credits not allocated to any specific bill. The Debit column = the
//   party owes us (receivable); Credit = we owe them / they have an advance.
//
// This engine derives everything from the live commerce tables (no snapshot):
//   RECEIVABLE  ← invoices, party_sales, credit/debit notes, on-account payments
//   PAYABLE     ← purchase_invoices, vendor_payments, purchase_returns
// so the report is always in sync with Orders, Finance, Parties, Procurement and
// the GST modules. It mirrors the bill-level open balances those modules maintain
// (invoice.amount_paid, purchase_invoice.amount_paid, distributor/vendor running
// outstanding, ref'd credit/debit notes).
//
// Each open bill is reduced to a *signed* amount in OUR books (+ = Debit / Dr,
// − = Credit / Cr), aged by its document date, then summed per party per bucket.
// A bucket's net sign decides whether it lands in that bucket's Debit or Credit
// cell, so the column totals always tie to "Pending Bills" (Pending Dr = Σ Debit
// cells incl. On-Account; Pending Cr = Σ Credit cells).
// ─────────────────────────────────────────────────────────────────────────────

import { query } from '../../db/index.js';

const MS_PER_DAY = 86_400_000;

const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const n = (v) => (v == null ? 0 : Number(v));

/** Strip a DB date/timestamp to a midnight-UTC Date (date-only, no tz drift). */
function dateOnly(d) {
  if (!d) return null;
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return new Date(`${s}T00:00:00.000Z`);
}

/** Whole-day age between a bill date and the "as on" date (never negative). */
function ageDays(billDate, asOn) {
  const a = dateOnly(billDate);
  if (!a) return 0;
  return Math.max(0, Math.floor((asOn.getTime() - a.getTime()) / MS_PER_DAY));
}

/** Indian financial-year start (1 April) for a given date — used for the header period. */
function fyStart(d) {
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 3 ? y : y - 1; // Apr = month 3
  return new Date(`${startYear}-04-01T00:00:00.000Z`);
}

/** Tally-style date label, e.g. 1-Apr-26. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function tallyDate(d) {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(-2)}`;
}

/**
 * Build bucket boundaries + labels from an ascending list of day cut-offs.
 * [30,60,90] → buckets: ≤30, 30–60, 60–90, >90 (4 cells), matching the GrpBills format.
 */
export function makeBuckets(bounds = [30, 60, 90]) {
  const b = [...bounds].filter((x) => Number.isFinite(x) && x > 0).sort((a, z) => a - z);
  const labels = [];
  for (let i = 0; i < b.length; i++) {
    if (i === 0) labels.push(`(< ${b[i]} days )`);
    else labels.push(`${b[i - 1]} to ${b[i]} days`);
  }
  labels.push(`(> ${b[b.length - 1]} days )`);
  return { bounds: b, labels };
}

/** Bucket index for an age in days given ascending bounds (last index = oldest). */
function bucketIndex(age, bounds) {
  for (let i = 0; i < bounds.length; i++) if (age <= bounds[i]) return i;
  return bounds.length;
}

/** Split a signed net into a Debit/Credit cell ( + = Dr, − = Cr ). */
function split(net) {
  const v = round2(net);
  if (v > 0) return { debit: v, credit: 0 };
  if (v < 0) return { debit: 0, credit: -v };
  return { debit: 0, credit: 0 };
}

// ── Party accumulator ─────────────────────────────────────────────────────────

function newParty(partyType, id, name, location) {
  return { partyType, id: String(id), name: name || '—', location: location || null, items: [] };
}

/**
 * Pure core: reduce a list of signed open items into the aging shape.
 * item = { date, amount (signed +Dr/−Cr), onAccount: bool }
 * Returns { buckets:[{debit,credit}], onAccountDebit, onAccountCredit,
 *           pendingDebit, pendingCredit, oldestDays }.
 * Exported for unit testing — `buildAgingReport` wraps it with DB-sourced items.
 */
export function ageItems(items, asOn, bounds = [30, 60, 90]) {
  const asOnDate = asOn instanceof Date ? asOn : new Date(`${String(asOn).slice(0, 10)}T00:00:00.000Z`);
  const bucketNet = new Array(bounds.length + 1).fill(0);
  let onAccountNet = 0;
  let oldestDays = 0;
  for (const it of items) {
    if (Math.abs(it.amount) < 0.005) continue;
    if (it.onAccount) {
      onAccountNet += it.amount;
    } else {
      const age = ageDays(it.date, asOnDate);
      bucketNet[bucketIndex(age, bounds)] += it.amount;
      if (age > oldestDays) oldestDays = age;
    }
  }
  const buckets = bucketNet.map(split);
  const onAccount = split(onAccountNet);
  const pendingDebit = round2(buckets.reduce((s, c) => s + c.debit, 0) + onAccount.debit);
  const pendingCredit = round2(buckets.reduce((s, c) => s + c.credit, 0) + onAccount.credit);
  return {
    buckets,
    onAccountDebit: onAccount.debit,
    onAccountCredit: onAccount.credit,
    pendingDebit,
    pendingCredit,
    oldestDays,
  };
}

/** Reduce a party accumulator into the aging row shape. */
function ageParty(party, asOn, bounds) {
  const aged = ageItems(party.items, asOn, bounds);
  return {
    partyId: party.id,
    partyType: party.partyType,
    name: party.name,
    location: party.location,
    ...aged,
  };
}

// ── Data gathering ──────────────────────────────────────────────────────────

/** RECEIVABLE: distributors + farmers → signed open items per party. */
async function gatherReceivable(asOnIso, { branchId } = {}) {
  const parties = new Map(); // key -> party
  const key = (t, id) => `${t}:${id}`;
  const ensure = (t, id, name, loc) => {
    const k = key(t, id);
    if (!parties.has(k)) parties.set(k, newParty(t, id, name, loc));
    return parties.get(k);
  };

  const [dists, farms, invoices, sales, notes, onAcct] = await Promise.all([
    query(
      `SELECT id, name, COALESCE(NULLIF(district,''), state) loc FROM distributors
       WHERE ($1::uuid IS NULL OR branch_id = $1)`,
      [branchId ?? null],
    ),
    query("SELECT id, name, COALESCE(NULLIF(village,''), district) loc FROM farmers"),
    query(
      `SELECT id, distributor_id, farmer_id, COALESCE(customer_type,'DISTRIBUTOR') ctype,
              invoice_date, total_amount, amount_paid
       FROM invoices WHERE status <> 'CANCELLED' AND invoice_date <= $1`,
      [asOnIso],
    ),
    query(
      `SELECT distributor_id, farmer_id, party_type, sale_date, total_amount, amount_paid
       FROM party_sales WHERE sale_date <= $1`,
      [asOnIso],
    ),
    query(
      `SELECT distributor_id, note_type, amount, ref_invoice_id, created_at
       FROM credit_debit_notes WHERE created_at::date <= $1`,
      [asOnIso],
    ),
    query(
      `SELECT distributor_id, farmer_id, amount, paid_at
       FROM payments WHERE invoice_id IS NULL AND paid_at::date <= $1`,
      [asOnIso],
    ),
  ]);

  const distName = new Map(dists.rows.map((r) => [r.id, r]));
  const farmName = new Map(farms.rows.map((r) => [r.id, r]));
  const allowDist = (id) => distName.has(id); // honour the branch filter

  // Fold ref'd credit/debit notes into their invoice's open balance (bill-wise),
  // and route un-referenced notes to On-Account (Tally treats them as unallocated).
  const refAdj = new Map(); // invoiceId -> signed adjustment (Dr+/Cr−)
  for (const r of notes.rows) {
    if (!allowDist(r.distributor_id)) continue;
    const signed = r.note_type === 'CREDIT' ? -n(r.amount) : n(r.amount);
    if (r.ref_invoice_id) {
      refAdj.set(r.ref_invoice_id, (refAdj.get(r.ref_invoice_id) ?? 0) + signed);
    } else {
      const d = distName.get(r.distributor_id);
      const p = ensure('DISTRIBUTOR', r.distributor_id, d?.name, d?.loc);
      // Un-ref credit note → On-Account credit; un-ref debit note → aged debit bill.
      p.items.push({ date: r.created_at, amount: signed, onAccount: r.note_type === 'CREDIT' });
    }
  }

  for (const r of invoices.rows) {
    const isFarmer = r.ctype === 'FARMER' && r.farmer_id;
    const pid = isFarmer ? r.farmer_id : r.distributor_id;
    if (!pid) continue;
    if (!isFarmer && !allowDist(pid)) continue; // outside branch filter
    const meta = isFarmer ? farmName.get(pid) : distName.get(pid);
    const p = ensure(isFarmer ? 'FARMER' : 'DISTRIBUTOR', pid, meta?.name, meta?.loc);
    const open = n(r.total_amount) - n(r.amount_paid) + (refAdj.get(r.id) ?? 0);
    p.items.push({ date: r.invoice_date, amount: open, onAccount: false });
  }

  for (const r of sales.rows) {
    const isFarmer = r.party_type === 'FARMER' && r.farmer_id;
    const pid = isFarmer ? r.farmer_id : r.distributor_id;
    if (!pid) continue;
    if (!isFarmer && !allowDist(pid)) continue;
    const meta = isFarmer ? farmName.get(pid) : distName.get(pid);
    const p = ensure(isFarmer ? 'FARMER' : 'DISTRIBUTOR', pid, meta?.name, meta?.loc);
    p.items.push({ date: r.sale_date, amount: n(r.total_amount) - n(r.amount_paid), onAccount: false });
  }

  for (const r of onAcct.rows) {
    const isFarmer = !r.distributor_id && r.farmer_id;
    const pid = isFarmer ? r.farmer_id : r.distributor_id;
    if (!pid) continue;
    if (!isFarmer && !allowDist(pid)) continue;
    const meta = isFarmer ? farmName.get(pid) : distName.get(pid);
    const p = ensure(isFarmer ? 'FARMER' : 'DISTRIBUTOR', pid, meta?.name, meta?.loc);
    p.items.push({ date: r.paid_at, amount: -n(r.amount), onAccount: true }); // receipt → Cr
  }

  return parties;
}

/** PAYABLE: vendors → signed open items (purchase bills = Cr we owe). */
async function gatherPayable(asOnIso) {
  const parties = new Map();
  const ensure = (id, name, loc) => {
    const k = `VENDOR:${id}`;
    if (!parties.has(k)) parties.set(k, newParty('VENDOR', id, name, loc));
    return parties.get(k);
  };

  const [vendors, bills, pays, rets] = await Promise.all([
    query("SELECT id, name, COALESCE(NULLIF(city,''), state) loc FROM vendors"),
    query(
      `SELECT vendor_id, invoice_date, total_amount, amount_paid
       FROM purchase_invoices WHERE invoice_date <= $1`,
      [asOnIso],
    ),
    query(
      `SELECT vendor_id, amount, paid_at
       FROM vendor_payments WHERE purchase_invoice_id IS NULL AND paid_at::date <= $1`,
      [asOnIso],
    ),
    query(
      `SELECT vendor_id, total_amount, approved_at
       FROM purchase_returns WHERE status = 'APPROVED' AND approved_at::date <= $1`,
      [asOnIso],
    ),
  ]);
  const vName = new Map(vendors.rows.map((r) => [r.id, r]));

  for (const r of bills.rows) {
    const v = vName.get(r.vendor_id);
    const p = ensure(r.vendor_id, v?.name, v?.loc);
    // We owe the vendor → Credit (negative signed) in our books.
    p.items.push({ date: r.invoice_date, amount: -(n(r.total_amount) - n(r.amount_paid)), onAccount: false });
  }
  for (const r of pays.rows) {
    const v = vName.get(r.vendor_id);
    const p = ensure(r.vendor_id, v?.name, v?.loc);
    // On-account advance paid to vendor → Debit (we are owed back / unadjusted).
    p.items.push({ date: r.paid_at, amount: n(r.amount), onAccount: true });
  }
  for (const r of rets.rows) {
    const v = vName.get(r.vendor_id);
    const p = ensure(r.vendor_id, v?.name, v?.loc);
    // Goods returned to vendor (debit note) reduces what we owe → Debit.
    p.items.push({ date: r.approved_at, amount: n(r.total_amount), onAccount: false });
  }

  return parties;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the full aging / group-outstandings read model.
 *
 * @param {object}  opts
 * @param {string}  [opts.asOn]        - "as on" date (yyyy-mm-dd). Default: today.
 * @param {string}  [opts.fromDate]    - period-start label only. Default: FY start of asOn.
 * @param {string}  [opts.reportType]  - 'RECEIVABLE' (default) | 'PAYABLE'.
 * @param {number[]}[opts.buckets]     - ascending day cut-offs. Default [30,60,90].
 * @param {string}  [opts.partyType]   - 'DISTRIBUTOR' | 'FARMER' filter (receivable only).
 * @param {string}  [opts.branchId]    - distributor branch filter (receivable only).
 * @param {string}  [opts.search]      - case-insensitive party-name filter.
 */
export async function buildAgingReport(opts = {}) {
  const reportType = opts.reportType === 'PAYABLE' ? 'PAYABLE' : 'RECEIVABLE';
  const asOn = opts.asOn ? new Date(`${String(opts.asOn).slice(0, 10)}T00:00:00.000Z`) : new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const asOnIso = asOn.toISOString().slice(0, 10);
  const from = opts.fromDate ? new Date(`${String(opts.fromDate).slice(0, 10)}T00:00:00.000Z`) : fyStart(asOn);
  const { bounds, labels } = makeBuckets(opts.buckets);

  const company = (await query('SELECT * FROM company_settings WHERE id = 1')).rows[0] || {};

  const parties = reportType === 'PAYABLE'
    ? await gatherPayable(asOnIso)
    : await gatherReceivable(asOnIso, { branchId: opts.branchId });

  // Age each party, drop nil balances, apply party-type / search filters, sort A→Z.
  const search = (opts.search || '').trim().toLowerCase();
  let rows = [];
  for (const party of parties.values()) {
    if (reportType === 'RECEIVABLE' && opts.partyType && party.partyType !== opts.partyType) continue;
    if (search && !party.name.toLowerCase().includes(search)) continue;
    const aged = ageParty(party, asOn, bounds);
    if (aged.pendingDebit === 0 && aged.pendingCredit === 0) continue;
    rows.push(aged);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  // Grand total = column-wise sum (always ties to Pending Bills by construction).
  const grandTotal = {
    pendingDebit: 0,
    pendingCredit: 0,
    buckets: labels.map(() => ({ debit: 0, credit: 0 })),
    onAccountDebit: 0,
    onAccountCredit: 0,
  };
  for (const r of rows) {
    grandTotal.pendingDebit = round2(grandTotal.pendingDebit + r.pendingDebit);
    grandTotal.pendingCredit = round2(grandTotal.pendingCredit + r.pendingCredit);
    grandTotal.onAccountDebit = round2(grandTotal.onAccountDebit + r.onAccountDebit);
    grandTotal.onAccountCredit = round2(grandTotal.onAccountCredit + r.onAccountCredit);
    r.buckets.forEach((c, i) => {
      grandTotal.buckets[i].debit = round2(grandTotal.buckets[i].debit + c.debit);
      grandTotal.buckets[i].credit = round2(grandTotal.buckets[i].credit + c.credit);
    });
  }

  // Site / seller identity — entirely from company_settings (the same DB row the
  // Company page edits and invoices/receipts print from). No hardcoded fallbacks.
  const address = [company.address_line1, company.address_line2, company.city, company.state, company.pincode]
    .filter(Boolean).join(', ') || null;

  return {
    meta: {
      company: {
        name: company.trade_name || company.legal_name || null, // display name (DB-driven)
        legalName: company.legal_name || null,
        tradeName: company.trade_name || null,
        address,
        contact: company.phone || null,
        email: company.email || null,
        website: company.website || null,
        gstin: company.gstin || null,
        pan: company.pan || null,
      },
      title: reportType === 'PAYABLE' ? 'Group Payables (Outstandings)' : 'Group Outstandings',
      reportType,
      groupName: reportType === 'PAYABLE' ? 'Sundry Creditors' : 'Sundry Debtors',
      periodLabel: `${tallyDate(from)} to ${tallyDate(asOn)}`,
      fromDate: from.toISOString().slice(0, 10),
      asOn: asOnIso,
      buckets: labels,
      bucketBounds: bounds,
      generatedAt: new Date().toISOString(),
      basis: 'Bill-wise aging on document date, "as on" the report date. Debit = receivable; Credit = advance/credit balance. On-Account = receipts/credits not allocated to a specific bill.',
    },
    rows,
    grandTotal,
    summary: {
      partyCount: rows.length,
      totalDebit: grandTotal.pendingDebit,
      totalCredit: grandTotal.pendingCredit,
      onAccountDebit: grandTotal.onAccountDebit,
      onAccountCredit: grandTotal.onAccountCredit,
      // Net overdue beyond the last bucket boundary (e.g. > 90 days), debit side.
      overdueDebit: grandTotal.buckets[grandTotal.buckets.length - 1]?.debit ?? 0,
      bucketDebit: grandTotal.buckets.map((c) => c.debit),
      bucketCredit: grandTotal.buckets.map((c) => c.credit),
    },
  };
}
