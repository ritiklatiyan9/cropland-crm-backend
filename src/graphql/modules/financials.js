// GraphQL module: Financial Statements — Balance Sheet & Trading/Profit-&-Loss.
// Read models are produced by the mapping engine (services/finance/financials.js);
// mutations manage the manual adjustments ledger (financial_ledger_entries).

import { query } from '../../db/index.js';
import { assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { buildProfitLoss, buildBalanceSheet } from '../../services/finance/financials.js';

export const financialsTypeDefs = /* GraphQL */ `
  type TLine { label: String!, amount: Float! }
  type BsGroup { group: String!, amount: Float!, lines: [TLine!]! }
  type NamedAmount { name: String!, amount: Float! }
  type FixedAssetRow { label: String!, opening: Float!, addition: Float!, depreciation: Float!, closing: Float! }
  type CapitalSchedule { lines: [TLine!]!, netProfit: Float!, closing: Float! }
  type CompanyMeta { legalName: String, tradeName: String, address: String, gstin: String, pan: String }
  type StatementMeta {
    company: CompanyMeta!
    reportType: String!
    from: String!
    to: String!
    gstOnly: Boolean!
    stockBasis: String!
    generatedAt: String!
    notes: JSON
  }

  type TAccount { debit: [TLine!]!, credit: [TLine!]!, total: Float! }
  type ProfitLossReport {
    meta: StatementMeta!
    trading: TAccount!
    pl: TAccount!
    grossProfit: Float!
    netProfit: Float!
  }

  type BalanceValidation { assetsTotal: Float!, liabilitiesTotal: Float!, difference: Float!, balanced: Boolean! }
  type Schedules {
    debtors: [NamedAmount!]!
    creditors: [NamedAmount!]!
    advances: [NamedAmount!]!
    fixedAssets: [FixedAssetRow!]!
    capital: CapitalSchedule!
  }
  type BalanceSheetReport {
    meta: StatementMeta!
    liabilities: [BsGroup!]!
    assets: [BsGroup!]!
    liabilitiesTotal: Float!
    assetsTotal: Float!
    netProfit: Float!
    schedules: Schedules!
    validation: BalanceValidation!
  }

  type FinancialLedgerEntry {
    id: ID!
    entryDate: String!
    statement: String!
    section: String!
    label: String!
    amount: Float!
    meta: JSON
    isGst: Boolean!
    notes: String
  }

  input LedgerEntryInput {
    id: ID
    entryDate: String
    statement: String!     # TRADING | PL | BS
    section: String!       # DIRECT_EXPENSE | INDIRECT_EXPENSE | OTHER_INCOME | CAPITAL | ...
    label: String!
    amount: Float!
    meta: JSON
    isGst: Boolean
    notes: String
  }

  extend type Query {
    profitLoss(reportType: String, fromDate: String, toDate: String, gstOnly: Boolean = true): ProfitLossReport!
    balanceSheet(reportType: String, fromDate: String, toDate: String, gstOnly: Boolean = true): BalanceSheetReport!
    ledgerEntries(statement: String, section: String): [FinancialLedgerEntry!]!
  }

  extend type Mutation {
    upsertLedgerEntry(input: LedgerEntryInput!): FinancialLedgerEntry!
    deleteLedgerEntry(id: ID!): Boolean!
  }
`;

const VALID_STATEMENTS = new Set(['TRADING', 'PL', 'BS']);
const VALID_SECTIONS = new Set([
  'DIRECT_EXPENSE', 'INDIRECT_EXPENSE', 'OTHER_INCOME', 'CAPITAL', 'UNSECURED_LOAN',
  'CURRENT_LIABILITY', 'PROVISION', 'FIXED_ASSET', 'BANK', 'CASH', 'LOAN_ADVANCE',
  'OTHER_ASSET', 'OTHER_LIABILITY', 'OPENING_STOCK', 'NOTE',
]);

const mapEntry = (r) => ({
  id: r.id,
  entryDate: isoDate(r.entry_date),
  statement: r.statement,
  section: r.section,
  label: r.label,
  amount: num(r.amount),
  meta: r.meta ?? {},
  isGst: r.is_gst,
  notes: r.notes ?? null,
});

const guardRead = (ctx) => assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
const guardWrite = (ctx) => assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');

export function financialsResolvers() {
  return {
    Query: {
      profitLoss: async (_p, { reportType, fromDate, toDate, gstOnly }, ctx) => {
        guardRead(ctx);
        return buildProfitLoss({ reportType, fromDate, toDate, gstOnly: gstOnly ?? true });
      },
      balanceSheet: async (_p, { reportType, fromDate, toDate, gstOnly }, ctx) => {
        guardRead(ctx);
        return buildBalanceSheet({ reportType, fromDate, toDate, gstOnly: gstOnly ?? true });
      },
      ledgerEntries: async (_p, { statement, section }, ctx) => {
        guardRead(ctx);
        const { rows } = await query(
          `SELECT * FROM financial_ledger_entries
           WHERE ($1::text IS NULL OR statement = $1) AND ($2::text IS NULL OR section = $2)
           ORDER BY entry_date DESC, section, label`,
          [statement ?? null, section ?? null],
        );
        return rows.map(mapEntry);
      },
    },

    Mutation: {
      upsertLedgerEntry: async (_p, { input }, ctx) => {
        const actor = guardWrite(ctx);
        const statement = String(input.statement).toUpperCase();
        const section = String(input.section).toUpperCase();
        if (!VALID_STATEMENTS.has(statement)) throw httpError(`Invalid statement: ${statement}`, 400);
        if (!VALID_SECTIONS.has(section)) throw httpError(`Invalid section: ${section}`, 400);
        if (!input.label?.trim()) throw httpError('Label is required', 400);

        const meta = JSON.stringify(input.meta ?? {});
        const isGst = input.isGst ?? true;
        if (input.id) {
          const { rows } = await query(
            `UPDATE financial_ledger_entries
             SET entry_date = COALESCE($2::date, entry_date), statement = $3, section = $4,
                 label = $5, amount = $6, meta = $7::jsonb, is_gst = $8, notes = $9, updated_at = now()
             WHERE id = $1 RETURNING *`,
            [input.id, input.entryDate ?? null, statement, section, input.label.trim(), input.amount ?? 0, meta, isGst, input.notes ?? null],
          );
          if (!rows[0]) throw httpError('Ledger entry not found', 404);
          await logActivity(actor.sub, 'UPDATE_LEDGER_ENTRY', 'financial_ledger_entry', rows[0].id, { section });
          return mapEntry(rows[0]);
        }
        const { rows } = await query(
          `INSERT INTO financial_ledger_entries (entry_date, statement, section, label, amount, meta, is_gst, notes, created_by)
           VALUES (COALESCE($1::date, CURRENT_DATE), $2, $3, $4, $5, $6::jsonb, $7, $8, $9) RETURNING *`,
          [input.entryDate ?? null, statement, section, input.label.trim(), input.amount ?? 0, meta, isGst, input.notes ?? null, actor.sub],
        );
        await logActivity(actor.sub, 'CREATE_LEDGER_ENTRY', 'financial_ledger_entry', rows[0].id, { section });
        return mapEntry(rows[0]);
      },

      deleteLedgerEntry: async (_p, { id }, ctx) => {
        const actor = guardWrite(ctx);
        const { rowCount } = await query('DELETE FROM financial_ledger_entries WHERE id = $1', [id]);
        if (!rowCount) throw httpError('Ledger entry not found', 404);
        await logActivity(actor.sub, 'DELETE_LEDGER_ENTRY', 'financial_ledger_entry', id, {});
        return true;
      },
    },
  };
}
