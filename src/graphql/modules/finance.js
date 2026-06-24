// GraphQL module: Finance — distributor ledger, credit/debit notes, payment reminders.

import { query } from '../../db/index.js';
import { assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { dispatch } from '../../services/notify/index.js';
import { splitTax, roundGst } from '../../services/gst/calc.js';

export const financeTypeDefs = /* GraphQL */ `
  type LedgerEntry {
    date: String!
    type: String!        # INVOICE / PAYMENT / CREDIT_NOTE / DEBIT_NOTE
    ref: String!
    particulars: String
    debit: Float!
    credit: Float!
    balance: Float!
  }

  type DistributorLedger {
    distributorId: ID!
    distributorName: String!
    openingBalance: Float!
    closingBalance: Float!
    entries: [LedgerEntry!]!
  }

  type CreditDebitNote {
    id: ID!
    noteNo: String!
    distributorId: ID!
    distributorName: String
    noteType: String!
    amount: Float!
    taxableValue: Float
    gstRate: Float
    cgst: Float!
    sgst: Float!
    igst: Float!
    reason: String
    noteReason: String
    refInvoiceNo: String
    createdAt: DateTime!
  }

  type OverdueInvoice {
    invoiceNo: String!
    distributorName: String!
    customerType: String!
    invoiceDate: String!
    balance: Float!
    ageDays: Int!
  }

  type ReminderResult { sent: Int!, status: String!, note: String }

  input CreditDebitNoteInput {
    distributorId: ID!
    noteType: String!     # CREDIT / DEBIT
    amount: Float!
    taxableValue: Float    # optional — when given, tax is split exactly (not derived)
    gstRate: Float
    isInterstate: Boolean
    noteReason: String     # 01 Sales Return / 02 Post-sale discount / 03 Deficiency / 04 Correction / 05 Other
    reason: String
    refInvoiceId: ID
  }

  extend type Query {
    distributorLedger(distributorId: ID!): DistributorLedger!
    farmerLedger(farmerId: ID!): DistributorLedger!
    creditDebitNotes(distributorId: ID): [CreditDebitNote!]!
    overdueInvoices(distributorId: ID): [OverdueInvoice!]!
  }

  extend type Mutation {
    createCreditDebitNote(input: CreditDebitNoteInput!): CreditDebitNote!
    sendPaymentReminder(distributorId: ID!): ReminderResult!
  }
`;

function fy(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const mapNote = (r) => ({
  id: r.id,
  noteNo: r.note_no,
  distributorId: r.distributor_id,
  distributorName: r.dname ?? null,
  noteType: r.note_type,
  amount: num(r.amount),
  taxableValue: num(r.taxable_value),
  gstRate: num(r.gst_rate),
  cgst: num(r.cgst) ?? 0,
  sgst: num(r.sgst) ?? 0,
  igst: num(r.igst) ?? 0,
  reason: r.reason,
  noteReason: r.note_reason ?? null,
  refInvoiceNo: r.ref_invoice_no ?? null,
  createdAt: r.created_at,
});

export function financeResolvers() {
  return {
    Query: {
      distributorLedger: async (_p, { distributorId }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const d = await query('SELECT name FROM distributors WHERE id = $1', [distributorId]);
        if (!d.rows[0]) throw httpError('Distributor not found', 404);

        const invoices = await query(
          'SELECT invoice_no, invoice_date AS dt, total_amount FROM invoices WHERE distributor_id = $1 AND status <> $2',
          [distributorId, 'CANCELLED'],
        );
        const payments = await query('SELECT amount, paid_at AS dt, reference FROM payments WHERE distributor_id = $1', [distributorId]);
        const notes = await query('SELECT note_no, note_type, amount, created_at AS dt FROM credit_debit_notes WHERE distributor_id = $1', [distributorId]);

        const entries = [];
        for (const r of invoices.rows)
          entries.push({ date: isoDate(r.dt), sort: new Date(r.dt).getTime(), type: 'INVOICE', ref: r.invoice_no, particulars: 'Sales invoice', debit: num(r.total_amount), credit: 0 });
        for (const r of payments.rows)
          entries.push({ date: isoDate(r.dt), sort: new Date(r.dt).getTime(), type: 'PAYMENT', ref: r.reference || 'Payment', particulars: 'Payment received', debit: 0, credit: num(r.amount) });
        for (const r of notes.rows)
          entries.push({
            date: isoDate(r.dt), sort: new Date(r.dt).getTime(),
            type: r.note_type === 'CREDIT' ? 'CREDIT_NOTE' : 'DEBIT_NOTE', ref: r.note_no,
            particulars: r.note_type === 'CREDIT' ? 'Credit note' : 'Debit note',
            debit: r.note_type === 'DEBIT' ? num(r.amount) : 0,
            credit: r.note_type === 'CREDIT' ? num(r.amount) : 0,
          });

        entries.sort((a, b) => a.sort - b.sort);
        let bal = 0;
        for (const e of entries) {
          bal = Math.round((bal + e.debit - e.credit) * 100) / 100;
          e.balance = bal;
          delete e.sort;
        }
        return {
          distributorId,
          distributorName: d.rows[0].name,
          openingBalance: 0,
          closingBalance: bal,
          entries,
        };
      },

      // Farmer ledger mirrors the distributor one but draws on farmer-scoped
      // invoices/payments. Farmers have no credit/debit notes (those are
      // distributor-only by schema), so the ledger is invoices + payments.
      farmerLedger: async (_p, { farmerId }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const f = await query('SELECT name FROM farmers WHERE id = $1', [farmerId]);
        if (!f.rows[0]) throw httpError('Farmer not found', 404);

        const invoices = await query(
          'SELECT invoice_no, invoice_date AS dt, total_amount FROM invoices WHERE farmer_id = $1 AND status <> $2',
          [farmerId, 'CANCELLED'],
        );
        const payments = await query('SELECT amount, paid_at AS dt, reference FROM payments WHERE farmer_id = $1', [farmerId]);

        const entries = [];
        for (const r of invoices.rows)
          entries.push({ date: isoDate(r.dt), sort: new Date(r.dt).getTime(), type: 'INVOICE', ref: r.invoice_no, particulars: 'Sales invoice', debit: num(r.total_amount), credit: 0 });
        for (const r of payments.rows)
          entries.push({ date: isoDate(r.dt), sort: new Date(r.dt).getTime(), type: 'PAYMENT', ref: r.reference || 'Payment', particulars: 'Payment received', debit: 0, credit: num(r.amount) });

        entries.sort((a, b) => a.sort - b.sort);
        let bal = 0;
        for (const e of entries) {
          bal = Math.round((bal + e.debit - e.credit) * 100) / 100;
          e.balance = bal;
          delete e.sort;
        }
        return {
          distributorId: farmerId,
          distributorName: f.rows[0].name,
          openingBalance: 0,
          closingBalance: bal,
          entries,
        };
      },

      creditDebitNotes: async (_p, { distributorId }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT n.*, d.name dname, i.invoice_no ref_invoice_no
           FROM credit_debit_notes n JOIN distributors d ON d.id = n.distributor_id
           LEFT JOIN invoices i ON i.id = n.ref_invoice_id
           WHERE ($1::uuid IS NULL OR n.distributor_id = $1)
           ORDER BY n.created_at DESC LIMIT 200`,
          [distributorId ?? null],
        );
        return rows.map(mapNote);
      },

      overdueInvoices: async (_p, { distributorId }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT i.invoice_no, COALESCE(d.name, f.name) dname,
                  COALESCE(i.customer_type, 'DISTRIBUTOR') customer_type,
                  i.invoice_date, (i.total_amount - i.amount_paid) bal,
                  (CURRENT_DATE - i.invoice_date) age
           FROM invoices i
           LEFT JOIN distributors d ON d.id = i.distributor_id
           LEFT JOIN farmers f ON f.id = i.farmer_id
           WHERE i.total_amount > i.amount_paid AND i.status <> 'CANCELLED' AND (CURRENT_DATE - i.invoice_date) > 30
             AND ($1::uuid IS NULL OR i.distributor_id = $1)
           ORDER BY age DESC`,
          [distributorId ?? null],
        );
        return rows.map((r) => ({
          invoiceNo: r.invoice_no, distributorName: r.dname ?? '—', customerType: r.customer_type,
          invoiceDate: isoDate(r.invoice_date), balance: num(r.bal), ageDays: Number(r.age),
        }));
      },
    },

    Mutation: {
      createCreditDebitNote: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const type = input.noteType === 'CREDIT' ? 'CREDIT' : 'DEBIT';
        if (input.amount <= 0) throw httpError('Amount must be positive', 400);
        const seq = (await query("SELECT nextval('note_seq') AS n")).rows[0].n;
        const noteNo = `${type === 'CREDIT' ? 'CN' : 'DN'}-${fy()}-${String(seq).padStart(5, '0')}`;

        // Tax capture: if taxable + rate given, split exactly; else derive interstate from the linked invoice.
        let interstate = input.isInterstate ?? false;
        if (input.refInvoiceId) {
          const ri = (await query('SELECT is_interstate FROM invoices WHERE id = $1', [input.refInvoiceId])).rows[0];
          if (ri && input.isInterstate == null) interstate = !!ri.is_interstate;
        }
        let taxable = null, rate = null, cgst = 0, sgst = 0, igst = 0;
        if (input.taxableValue != null && input.gstRate != null) {
          taxable = roundGst(input.taxableValue);
          rate = input.gstRate;
          const s = splitTax(taxable, rate, interstate);
          cgst = s.cgst; sgst = s.sgst; igst = s.igst;
        }
        const { rows } = await query(
          `INSERT INTO credit_debit_notes (note_no, distributor_id, note_type, amount, taxable_value, gst_rate, cgst, sgst, igst, is_interstate, note_reason, reason, ref_invoice_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [noteNo, input.distributorId, type, input.amount, taxable, rate, cgst, sgst, igst, interstate, input.noteReason ?? null, input.reason ?? null, input.refInvoiceId ?? null, actor.sub],
        );
        // CREDIT note reduces outstanding; DEBIT note increases it.
        const delta = type === 'CREDIT' ? -input.amount : input.amount;
        await query('UPDATE distributors SET outstanding = GREATEST(outstanding + $2, 0) WHERE id = $1', [input.distributorId, delta]);
        await logActivity(actor.sub, 'CREATE_NOTE', 'credit_debit_note', rows[0].id, { type, amount: input.amount });
        return mapNote(rows[0]);
      },

      sendPaymentReminder: async (_p, { distributorId }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const d = await query('SELECT name, email, outstanding FROM distributors WHERE id = $1', [distributorId]);
        if (!d.rows[0]) throw httpError('Distributor not found', 404);
        const dist = d.rows[0];
        if (!dist.email) return { sent: 0, status: 'SKIPPED', note: 'No email on file for this distributor' };
        if (num(dist.outstanding) <= 0) return { sent: 0, status: 'SKIPPED', note: 'No outstanding balance' };

        const title = 'Payment reminder';
        const body = `Dear ${dist.name},\n\nOur records show an outstanding balance of ₹${num(dist.outstanding)}. Kindly arrange payment at the earliest.\n\nThank you.`;
        const { results, sent, status } = await dispatch({ channels: ['EMAIL'], title, body, emails: [dist.email] });
        await logActivity(actor.sub, 'PAYMENT_REMINDER', 'distributor', distributorId, { sent });
        return { sent, status, note: results?.[0]?.note ?? null };
      },
    },
  };
}
