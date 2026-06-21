// Financial Statements — Balance Sheet & Trading/Profit-&-Loss mapping engine.
//
// Derives the statement from LIVE commerce data (sales, purchases, stock, GST,
// debtors, creditors) and overlays the manual `financial_ledger_entries` for the
// accounts the transactional schema does not track (expenses, capital, fixed
// assets, bank/cash, opening balances). No figure is hardcoded.
//
// GST filtering (the "GST-only" requirement):
//   • Sales      → invoices.bill_type = 'GST'   (NON_GST bills of supply excluded)
//   • Purchases  → purchase_invoices.tax_value > 0  (the table has no bill_type
//                  column, so a non-zero tax value is the GST proxy)
//   • Manual     → financial_ledger_entries.is_gst = true
// All three are gated by the single `gstOnly` flag (default true).
//
// The service returns plain JSON; the GraphQL module and the REST route are thin
// shells over `buildFinancials`.

import { query } from '../../db/index.js';
import { resolvePeriod } from './period.js';

export { resolvePeriod };

const num = (v) => (v == null ? 0 : Number(v));
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

/** Group manual ledger rows by section, returning {section: [{label, amount, meta}]}. */
function bySection(rows) {
  const out = {};
  for (const r of rows) (out[r.section] ??= []).push(r);
  return out;
}
const sumAmt = (arr) => r2((arr ?? []).reduce((s, r) => s + num(r.amount), 0));
const toLines = (arr) => (arr ?? []).map((r) => ({ label: r.label, amount: r2(num(r.amount)) }));

/**
 * Build the full financial statement set for a period.
 * @returns {{meta:object, profitLoss:object, balanceSheet:object}}
 */
export async function buildFinancials({ reportType, fromDate, toDate, gstOnly = true } = {}) {
  const period = resolvePeriod(reportType, fromDate, toDate);
  const { from, to } = period;
  const g = !!gstOnly;

  const [
    company,
    salesRow,
    salesRetRow,
    purchRow,
    purchRetRow,
    closingStockRow,
    openingManualRow,
    openingMoveRow,
    debtorRows,
    creditorRows,
    ledgerRows,
    salesListRows,
    purchListRows,
  ] = await Promise.all([
    query('SELECT * FROM company_settings WHERE id = 1'),
    query(
      `SELECT COALESCE(SUM(taxable_value),0) taxable, COALESCE(SUM(cgst+sgst+igst),0) gst
       FROM invoices
       WHERE status <> 'CANCELLED' AND invoice_date BETWEEN $1 AND $2 AND (NOT $3 OR bill_type = 'GST')`,
      [from, to, g],
    ),
    query(
      `SELECT COALESCE(SUM(sr.sub_total),0) sub, COALESCE(SUM(sr.tax_total),0) tax
       FROM sales_returns sr LEFT JOIN orders o ON o.id = sr.order_id
       WHERE sr.status = 'APPROVED' AND sr.return_date BETWEEN $1 AND $2
         AND (NOT $3 OR COALESCE(o.bill_type,'GST') = 'GST')`,
      [from, to, g],
    ),
    query(
      `SELECT COALESCE(SUM(taxable_value),0) taxable, COALESCE(SUM(tax_value),0) gst
       FROM purchase_invoices
       WHERE invoice_date BETWEEN $1 AND $2 AND (NOT $3 OR tax_value > 0)`,
      [from, to, g],
    ),
    query(
      `SELECT COALESCE(SUM(sub_total),0) sub, COALESCE(SUM(tax_total),0) tax
       FROM purchase_returns WHERE status = 'APPROVED' AND return_date BETWEEN $1 AND $2`,
      [from, to],
    ),
    // Closing stock = current on-hand quantity × unit cost (standard_cost, else distributor_price).
    query(
      `SELECT COALESCE(SUM(sl.quantity * COALESCE(NULLIF(p.standard_cost,0), p.distributor_price, 0)),0) val
       FROM stock_levels sl JOIN products p ON p.id = sl.product_id`,
    ),
    // Opening stock — manual OPENING_STOCK entry as of period start (preferred).
    query(
      `SELECT COALESCE(SUM(amount),0) val FROM financial_ledger_entries
       WHERE section = 'OPENING_STOCK' AND entry_date <= $1`,
      [from],
    ),
    // Opening stock fallback — valuation of net stock movements before the period.
    query(
      `SELECT COALESCE(SUM(q.qty * COALESCE(NULLIF(p.standard_cost,0), p.distributor_price, 0)),0) val
       FROM (SELECT product_id, SUM(quantity) qty FROM stock_movements WHERE created_at::date < $1 GROUP BY product_id) q
       JOIN products p ON p.id = q.product_id WHERE q.qty > 0`,
      [from],
    ),
    // Receivables / advances by customer, as on period end (point-in-time).
    query(
      `SELECT COALESCE(d.name, f.name, 'Unknown') name, SUM(i.total_amount - i.amount_paid) bal
       FROM invoices i
       LEFT JOIN distributors d ON d.id = i.distributor_id
       LEFT JOIN farmers f ON f.id = i.farmer_id
       WHERE i.status <> 'CANCELLED' AND i.invoice_date <= $1 AND (NOT $2 OR i.bill_type = 'GST')
       GROUP BY COALESCE(d.name, f.name, 'Unknown')`,
      [to, g],
    ),
    // Payables by vendor, as on period end.
    query(
      `SELECT v.name, SUM(pi.total_amount - pi.amount_paid) bal
       FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id
       WHERE pi.invoice_date <= $1 AND (NOT $2 OR pi.tax_value > 0)
       GROUP BY v.name HAVING SUM(pi.total_amount - pi.amount_paid) > 0 ORDER BY bal DESC`,
      [to, g],
    ),
    // Manual adjustments up to period end (PL/TRADING rows are date-filtered in JS).
    query(
      `SELECT id, entry_date, statement, section, label, amount, meta, is_gst
       FROM financial_ledger_entries
       WHERE entry_date <= $1 AND (NOT $2 OR is_gst = true) ORDER BY section, label`,
      [to, g],
    ),
    // All sales transactions in the period — same source as the Trading "By Sales" figure.
    query(
      `SELECT i.invoice_no AS ref, i.invoice_date AS dt, COALESCE(d.name, f.name, 'Unknown') AS party,
              i.taxable_value AS taxable, i.total_amount AS total
       FROM invoices i
       LEFT JOIN distributors d ON d.id = i.distributor_id
       LEFT JOIN farmers f ON f.id = i.farmer_id
       WHERE i.status <> 'CANCELLED' AND i.invoice_date BETWEEN $1 AND $2 AND (NOT $3 OR i.bill_type = 'GST')
       ORDER BY i.invoice_date, i.invoice_no`,
      [from, to, g],
    ),
    // All purchase transactions in the period — same source as the Trading "Purchases" figure.
    query(
      `SELECT COALESCE(pi.bill_no, pi.internal_no) AS ref, pi.invoice_date AS dt, v.name AS party,
              pi.taxable_value AS taxable, pi.total_amount AS total
       FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id
       WHERE pi.invoice_date BETWEEN $1 AND $2 AND (NOT $3 OR pi.tax_value > 0)
       ORDER BY pi.invoice_date, pi.internal_no`,
      [from, to, g],
    ),
  ]);

  // ── Derived commerce figures ────────────────────────────────
  const salesNet = r2(num(salesRow.rows[0].taxable) - num(salesRetRow.rows[0].sub));
  const purchasesNet = r2(num(purchRow.rows[0].taxable) - num(purchRetRow.rows[0].sub));
  const closingStock = r2(num(closingStockRow.rows[0].val));
  const openingStock = r2(num(openingManualRow.rows[0].val) || num(openingMoveRow.rows[0].val));
  const outputGst = r2(num(salesRow.rows[0].gst) - num(salesRetRow.rows[0].tax));
  const inputGst = r2(num(purchRow.rows[0].gst) - num(purchRetRow.rows[0].tax));
  const netGst = r2(outputGst - inputGst); // > 0 ⇒ payable, < 0 ⇒ receivable

  // Itemised transaction schedules (surfaced on the Balance Sheet as annexures).
  const isoDay = (d) => (d == null ? null : typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
  const toTxns = (rows) => rows.map((r) => ({ date: isoDay(r.dt), refNo: r.ref ?? null, party: r.party, taxable: r2(num(r.taxable)), total: r2(num(r.total)) }));
  const salesTxns = toTxns(salesListRows.rows);
  const purchaseTxns = toTxns(purchListRows.rows);

  const debtors = debtorRows.rows.filter((r) => num(r.bal) > 0).map((r) => ({ name: r.name, amount: r2(num(r.bal)) })).sort((a, b) => b.amount - a.amount);
  const advances = debtorRows.rows.filter((r) => num(r.bal) < 0).map((r) => ({ name: r.name, amount: r2(-num(r.bal)) })).sort((a, b) => b.amount - a.amount);
  const creditors = creditorRows.rows.map((r) => ({ name: r.name, amount: r2(num(r.bal)) }));
  const debtorsTotal = sumAmt(debtors);
  const advancesTotal = sumAmt(advances);
  const creditorsTotal = sumAmt(creditors);

  // ── Manual ledger, split by statement scope ─────────────────
  const periodRows = ledgerRows.rows.filter((r) => r.entry_date >= from && r.entry_date <= to);
  const plMan = bySection(periodRows.filter((r) => r.statement === 'PL' || r.statement === 'TRADING'));
  const bsMan = bySection(ledgerRows.rows.filter((r) => r.statement === 'BS'));
  const noteEntry = ledgerRows.rows.find((r) => r.section === 'NOTE');

  const directExp = toLines(plMan.DIRECT_EXPENSE);
  const indirectExp = toLines(plMan.INDIRECT_EXPENSE);
  const otherIncome = toLines(plMan.OTHER_INCOME);
  const directExpTotal = sumAmt(plMan.DIRECT_EXPENSE);
  const indirectExpTotal = sumAmt(plMan.INDIRECT_EXPENSE);
  const otherIncomeTotal = sumAmt(plMan.OTHER_INCOME);

  // ── Trading account ─────────────────────────────────────────
  const creditBase = r2(salesNet + closingStock);
  const debitBase = r2(openingStock + purchasesNet + directExpTotal);
  const grossProfit = r2(creditBase - debitBase); // ≥0 profit, <0 loss

  const tradingDebit = [
    { label: 'To Opening Stock', amount: openingStock },
    { label: 'To Purchases', amount: purchasesNet },
    ...directExp.map((l) => ({ label: `To ${l.label}`, amount: l.amount })),
  ];
  const tradingCredit = [
    { label: 'By Sales', amount: salesNet },
    { label: 'By Closing Stock', amount: closingStock },
  ];
  if (grossProfit >= 0) tradingDebit.push({ label: 'To Gross Profit c/d', amount: grossProfit });
  else tradingCredit.push({ label: 'By Gross Loss c/d', amount: r2(-grossProfit) });
  const tradingTotal = grossProfit >= 0 ? creditBase : debitBase;

  // ── Profit & Loss account ───────────────────────────────────
  const plCredit = [];
  const plDebit = [];
  if (grossProfit >= 0) plCredit.push({ label: 'By Gross Profit b/d', amount: grossProfit });
  else plDebit.push({ label: 'To Gross Loss b/d', amount: r2(-grossProfit) });
  for (const l of otherIncome) plCredit.push({ label: `By ${l.label}`, amount: l.amount });
  for (const l of indirectExp) plDebit.push({ label: `To ${l.label}`, amount: l.amount });

  const plCreditBase = r2((grossProfit >= 0 ? grossProfit : 0) + otherIncomeTotal);
  const plDebitBase = r2((grossProfit < 0 ? -grossProfit : 0) + indirectExpTotal);
  const netProfit = r2(plCreditBase - plDebitBase); // ≥0 profit, <0 loss
  if (netProfit >= 0) plDebit.push({ label: 'To Net Profit', amount: netProfit });
  else plCredit.push({ label: 'By Net Loss', amount: r2(-netProfit) });
  const plTotal = netProfit >= 0 ? plCreditBase : plDebitBase;

  // ── Balance Sheet — capital absorbs the net profit/loss ─────
  const capitalComponents = toLines(bsMan.CAPITAL);
  const capitalBase = sumAmt(bsMan.CAPITAL);
  const closingCapital = r2(capitalBase + netProfit);

  const fixedAssets = (bsMan.FIXED_ASSET ?? []).map((r) => {
    const meta = r.meta || {};
    const opening = num(meta.opening);
    const addition = num(meta.addition);
    const depreciation = num(meta.depreciation);
    // Closing prefers the explicit amount; otherwise opening + addition − depreciation.
    const closing = num(r.amount) || r2(opening + addition - depreciation);
    return { label: r.label, opening: r2(opening), addition: r2(addition), depreciation: r2(depreciation), closing: r2(closing) };
  });
  const fixedAssetsTotal = r2(fixedAssets.reduce((s, a) => s + a.closing, 0));

  // Build grouped liability + asset sections (each: {group, amount, lines[]}).
  const liabilities = [];
  liabilities.push({ group: 'Capital Account', amount: closingCapital, lines: [...capitalComponents, { label: 'Add: Net Profit / (Loss)', amount: netProfit }] });
  if ((bsMan.SECURED_LOAN ?? []).length) liabilities.push({ group: 'Secured Loans', amount: sumAmt(bsMan.SECURED_LOAN), lines: toLines(bsMan.SECURED_LOAN) });
  if ((bsMan.UNSECURED_LOAN ?? []).length) liabilities.push({ group: 'Unsecured Loans', amount: sumAmt(bsMan.UNSECURED_LOAN), lines: toLines(bsMan.UNSECURED_LOAN) });

  const currentLiab = [];
  if (creditorsTotal) currentLiab.push({ label: 'Sundry Creditors', amount: creditorsTotal });
  if (advancesTotal) currentLiab.push({ label: 'Advance from Customers', amount: advancesTotal });
  if (netGst > 0) currentLiab.push({ label: 'GST Payable', amount: netGst });
  for (const l of toLines(bsMan.CURRENT_LIABILITY)) currentLiab.push(l);
  for (const l of toLines(bsMan.PROVISION)) currentLiab.push(l);
  if (currentLiab.length) liabilities.push({ group: 'Current Liabilities & Provisions', amount: r2(currentLiab.reduce((s, l) => s + l.amount, 0)), lines: currentLiab });
  if ((bsMan.OTHER_LIABILITY ?? []).length) liabilities.push({ group: 'Other Liabilities', amount: sumAmt(bsMan.OTHER_LIABILITY), lines: toLines(bsMan.OTHER_LIABILITY) });

  const assets = [];
  if (fixedAssetsTotal || fixedAssets.length) assets.push({ group: 'Fixed Assets', amount: fixedAssetsTotal, lines: fixedAssets.map((a) => ({ label: a.label, amount: a.closing })) });

  const currentAssets = [];
  if (closingStock) currentAssets.push({ label: 'Closing Stock', amount: closingStock });
  if (debtorsTotal) currentAssets.push({ label: 'Sundry Debtors', amount: debtorsTotal });
  for (const l of toLines(bsMan.CASH)) currentAssets.push(l);
  for (const l of toLines(bsMan.BANK)) currentAssets.push(l);
  for (const l of toLines(bsMan.LOAN_ADVANCE)) currentAssets.push(l);
  if (netGst < 0) currentAssets.push({ label: 'GST Receivable', amount: r2(-netGst) });
  for (const l of toLines(bsMan.OTHER_ASSET)) currentAssets.push(l);
  if (currentAssets.length) assets.push({ group: 'Current Assets, Loans & Advances', amount: r2(currentAssets.reduce((s, l) => s + l.amount, 0)), lines: currentAssets });

  const liabilitiesTotal = r2(liabilities.reduce((s, x) => s + x.amount, 0));
  const assetsTotal = r2(assets.reduce((s, x) => s + x.amount, 0));
  const difference = r2(assetsTotal - liabilitiesTotal);

  const c = company.rows[0] || {};
  const meta = {
    company: {
      legalName: c.legal_name ?? null,
      tradeName: c.trade_name ?? null,
      address: [c.address_line1, c.address_line2, c.city, c.state, c.pincode].filter(Boolean).join(', ') || null,
      gstin: c.gstin ?? null,
      pan: c.pan ?? null,
    },
    reportType: period.reportType,
    from,
    to,
    gstOnly: g,
    stockBasis: 'Closing stock = current on-hand quantity × unit cost (standard cost, else distributor price).',
    generatedAt: new Date().toISOString(),
    notes: noteEntry?.meta ?? null,
  };

  return {
    meta,
    profitLoss: {
      meta,
      trading: { debit: tradingDebit, credit: tradingCredit, total: tradingTotal },
      pl: { debit: plDebit, credit: plCredit, total: plTotal },
      grossProfit,
      netProfit,
    },
    balanceSheet: {
      meta,
      liabilities,
      assets,
      liabilitiesTotal,
      assetsTotal,
      netProfit,
      schedules: {
        debtors,
        creditors,
        advances,
        fixedAssets,
        capital: { lines: capitalComponents, netProfit, closing: closingCapital },
        stock: { opening: openingStock, closing: closingStock },
        sales: salesTxns,
        purchases: purchaseTxns,
      },
      validation: {
        assetsTotal,
        liabilitiesTotal,
        difference,
        balanced: Math.abs(difference) < 0.01,
      },
    },
  };
}

/** Convenience wrapper returning just the Profit & Loss slice (+meta). */
export async function buildProfitLoss(opts) {
  const f = await buildFinancials(opts);
  return f.profitLoss;
}

/** Convenience wrapper returning just the Balance Sheet slice (+meta). */
export async function buildBalanceSheet(opts) {
  const f = await buildFinancials(opts);
  return f.balanceSheet;
}
