// GraphQL module: Aging / Group Outstandings report.
// Read-only — wraps the aging engine (services/finance/aging.js), which derives
// bill-wise aged balances live from invoices / party_sales / credit-debit notes /
// payments (receivable) and purchase_invoices / vendor_payments / purchase_returns
// (payable). The shape mirrors the Tally "Group Outstandings" statement so the
// frontend can render and export it in the exact GrpBills format.

import { assertRole } from '../context.js';
import { buildAgingReport } from '../../services/finance/aging.js';

export const agingTypeDefs = /* GraphQL */ `
  type AgingCell { debit: Float!, credit: Float! }

  type AgingPartyRow {
    partyId: ID!
    partyType: String!          # DISTRIBUTOR | FARMER | VENDOR
    name: String!
    location: String
    pendingDebit: Float!        # "Pending Bills" — total receivable (Dr)
    pendingCredit: Float!       # "Pending Bills" — total credit/advance (Cr)
    buckets: [AgingCell!]!      # one per aging bucket, in header order
    onAccountDebit: Float!
    onAccountCredit: Float!
    oldestDays: Int!            # age of the oldest open bill (collections triage)
  }

  type AgingGrandTotal {
    pendingDebit: Float!
    pendingCredit: Float!
    buckets: [AgingCell!]!
    onAccountDebit: Float!
    onAccountCredit: Float!
  }

  type AgingCompany {
    name: String           # display name (trade name, else legal name) — from company_settings
    legalName: String
    tradeName: String
    address: String
    contact: String
    email: String
    website: String
    gstin: String
    pan: String
  }

  type AgingMeta {
    company: AgingCompany!
    title: String!
    reportType: String!
    groupName: String!
    periodLabel: String!        # e.g. "1-Apr-26 to 24-Jun-26"
    fromDate: String!
    asOn: String!
    buckets: [String!]!         # bucket column labels
    bucketBounds: [Int!]!
    generatedAt: String!
    basis: String!
  }

  type AgingSummary {
    partyCount: Int!
    totalDebit: Float!
    totalCredit: Float!
    onAccountDebit: Float!
    onAccountCredit: Float!
    overdueDebit: Float!        # net beyond the last bucket (e.g. > 90 days)
    bucketDebit: [Float!]!
    bucketCredit: [Float!]!
  }

  type AgingReport {
    meta: AgingMeta!
    rows: [AgingPartyRow!]!
    grandTotal: AgingGrandTotal!
    summary: AgingSummary!
  }

  extend type Query {
    """
    Aging / Group Outstandings report ("as on" a date), bucketed by bill age.
    reportType: RECEIVABLE (default) | PAYABLE. buckets: ascending day cut-offs
    (default [30,60,90] → < 30 / 30–60 / 60–90 / > 90).
    """
    agingReport(
      asOn: String
      fromDate: String
      reportType: String = "RECEIVABLE"
      buckets: [Int!]
      partyType: String
      branchId: ID
      search: String
    ): AgingReport!
  }
`;

export function agingResolvers() {
  return {
    Query: {
      agingReport: async (_p, args, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        return buildAgingReport({
          asOn: args.asOn ?? null,
          fromDate: args.fromDate ?? null,
          reportType: args.reportType ?? 'RECEIVABLE',
          buckets: Array.isArray(args.buckets) && args.buckets.length ? args.buckets : undefined,
          partyType: args.partyType ?? null,
          branchId: args.branchId ?? null,
          search: args.search ?? null,
        });
      },
    },
  };
}
