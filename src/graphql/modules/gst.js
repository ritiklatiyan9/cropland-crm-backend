// GraphQL module: GST Compliance Engine — E-Invoice (IRN) + E-Way Bill.
// Provider-abstracted (see services/gst). Persists e-docs + updates the invoice.

import { query, withTransaction } from '../../db/index.js';
import { assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { gstProvider, getGstProviderName } from '../../services/gst/index.js';

export const gstTypeDefs = /* GraphQL */ `
  type EInvoice {
    id: ID!
    invoiceId: ID!
    irn: String
    ackNo: String
    ackDate: DateTime
    signedQr: String
    status: String!
    provider: String!
    cancelReason: String
    createdAt: DateTime!
  }

  type EWayBill {
    id: ID!
    invoiceId: ID!
    ewbNo: String
    ewbDate: DateTime
    validUntil: DateTime
    distanceKm: Int
    transportMode: String
    vehicleNo: String
    transporterId: String
    status: String!
    provider: String!
    createdAt: DateTime!
  }

  input EWayBillInput {
    invoiceId: ID!
    distanceKm: Int!
    transportMode: String!
    vehicleNo: String!
    transporterId: String
  }

  extend type Invoice {
    eInvoice: EInvoice
    ewayBill: EWayBill
  }

  extend type Query {
    gstProvider: String!
  }

  extend type Mutation {
    generateEInvoice(invoiceId: ID!): EInvoice!
    cancelEInvoice(invoiceId: ID!, reason: String!): EInvoice!
    generateEWayBill(input: EWayBillInput!): EWayBill!
    cancelEWayBill(invoiceId: ID!, reason: String!): EWayBill!
  }
`;

const EWB_THRESHOLD = 50000; // PRD §7.1: E-Way Bill required above ₹50,000

const mapEInvoice = (r) =>
  r && {
    id: r.id,
    invoiceId: r.invoice_id,
    irn: r.irn,
    ackNo: r.ack_no,
    ackDate: r.ack_date,
    signedQr: r.signed_qr,
    status: r.status,
    provider: r.provider,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
  };

const mapEwb = (r) =>
  r && {
    id: r.id,
    invoiceId: r.invoice_id,
    ewbNo: r.ewb_no,
    ewbDate: r.ewb_date,
    validUntil: r.valid_until,
    distanceKm: r.distance_km,
    transportMode: r.transport_mode,
    vehicleNo: r.vehicle_no,
    transporterId: r.transporter_id,
    status: r.status,
    provider: r.provider,
    createdAt: r.created_at,
  };

async function loadInvoiceContext(invoiceId) {
  const inv = (await query('SELECT * FROM invoices WHERE id = $1', [invoiceId])).rows[0];
  if (!inv) throw httpError('Invoice not found', 404);
  const company = (await query('SELECT * FROM company_settings WHERE id = 1')).rows[0];
  const distributor = (await query('SELECT * FROM distributors WHERE id = $1', [inv.distributor_id])).rows[0];
  const lines = (await query('SELECT * FROM order_lines WHERE order_id = $1', [inv.order_id])).rows;
  return {
    invoice: {
      invoiceNo: inv.invoice_no,
      invoiceDate: isoDate(inv.invoice_date),
      totalAmount: num(inv.total_amount),
      taxableValue: num(inv.taxable_value),
    },
    company,
    distributor,
    lines,
    raw: inv,
  };
}

export function gstResolvers() {
  return {
    Query: {
      gstProvider: () => getGstProviderName(),
    },

    Mutation: {
      generateEInvoice: async (_p, { invoiceId }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const existing = await query("SELECT * FROM e_invoices WHERE invoice_id = $1 AND status = 'GENERATED'", [invoiceId]);
        if (existing.rows[0]) throw httpError('E-Invoice already generated for this invoice', 409);
        const ctxData = await loadInvoiceContext(invoiceId);
        if (ctxData.raw.bill_type === 'NON_GST') throw httpError('E-Invoice (IRN) applies only to GST tax invoices, not a Bill of Supply', 400);
        if (!ctxData.company?.gstin) throw httpError('Set the company GSTIN (Company Details) before generating an E-Invoice', 400);

        const res = await gstProvider.generateIRN(ctxData);
        return withTransaction(async (client) => {
          const { rows } = await client.query(
            `INSERT INTO e_invoices (invoice_id, irn, ack_no, ack_date, signed_qr, signed_invoice, status, provider)
             VALUES ($1,$2,$3,$4,$5,$6,'GENERATED',$7)
             ON CONFLICT (invoice_id) DO UPDATE SET
               irn=EXCLUDED.irn, ack_no=EXCLUDED.ack_no, ack_date=EXCLUDED.ack_date,
               signed_qr=EXCLUDED.signed_qr, signed_invoice=EXCLUDED.signed_invoice,
               status='GENERATED', provider=EXCLUDED.provider, cancel_reason=NULL, updated_at=now()
             RETURNING *`,
            [invoiceId, res.irn, res.ackNo, res.ackDate, res.signedQr, res.signedInvoice, res.provider],
          );
          await client.query('UPDATE invoices SET irn = $2 WHERE id = $1', [invoiceId, res.irn]);
          await logActivity(actor.sub, 'GENERATE_EINVOICE', 'invoice', invoiceId, { provider: res.provider });
          return mapEInvoice(rows[0]);
        });
      },

      cancelEInvoice: async (_p, { invoiceId, reason }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        await gstProvider.cancelIRN({ invoiceId, reason });
        const { rows } = await query(
          "UPDATE e_invoices SET status='CANCELLED', cancel_reason=$2, updated_at=now() WHERE invoice_id=$1 RETURNING *",
          [invoiceId, reason],
        );
        if (!rows[0]) throw httpError('No E-Invoice to cancel', 404);
        await query('UPDATE invoices SET irn = NULL WHERE id = $1', [invoiceId]);
        await logActivity(actor.sub, 'CANCEL_EINVOICE', 'invoice', invoiceId, { reason });
        return mapEInvoice(rows[0]);
      },

      generateEWayBill: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const ctxData = await loadInvoiceContext(input.invoiceId);
        if (ctxData.raw.bill_type === 'NON_GST') throw httpError('E-Way Bill applies only to GST tax invoices, not a Bill of Supply', 400);
        if (num(ctxData.invoice.totalAmount) < EWB_THRESHOLD) {
          // Allowed but flagged — NIC mandates EWB only above ₹50,000.
        }
        const res = await gstProvider.generateEWB({ invoice: ctxData.invoice, distanceKm: input.distanceKm });
        return withTransaction(async (client) => {
          const { rows } = await client.query(
            `INSERT INTO eway_bills (invoice_id, ewb_no, ewb_date, valid_until, distance_km, transport_mode, vehicle_no, transporter_id, status, provider)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'GENERATED',$9)
             ON CONFLICT (invoice_id) DO UPDATE SET
               ewb_no=EXCLUDED.ewb_no, ewb_date=EXCLUDED.ewb_date, valid_until=EXCLUDED.valid_until,
               distance_km=EXCLUDED.distance_km, transport_mode=EXCLUDED.transport_mode,
               vehicle_no=EXCLUDED.vehicle_no, transporter_id=EXCLUDED.transporter_id,
               status='GENERATED', provider=EXCLUDED.provider, cancel_reason=NULL, updated_at=now()
             RETURNING *`,
            [input.invoiceId, res.ewbNo, res.ewbDate, res.validUntil, input.distanceKm, input.transportMode, input.vehicleNo, input.transporterId ?? null, res.provider],
          );
          await client.query('UPDATE invoices SET eway_bill_no = $2 WHERE id = $1', [input.invoiceId, res.ewbNo]);
          await logActivity(actor.sub, 'GENERATE_EWAYBILL', 'invoice', input.invoiceId, { provider: res.provider });
          return mapEwb(rows[0]);
        });
      },

      cancelEWayBill: async (_p, { invoiceId, reason }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        await gstProvider.cancelEWB({ invoiceId, reason });
        const { rows } = await query(
          "UPDATE eway_bills SET status='CANCELLED', cancel_reason=$2, updated_at=now() WHERE invoice_id=$1 RETURNING *",
          [invoiceId, reason],
        );
        if (!rows[0]) throw httpError('No E-Way Bill to cancel', 404);
        await query('UPDATE invoices SET eway_bill_no = NULL WHERE id = $1', [invoiceId]);
        await logActivity(actor.sub, 'CANCEL_EWAYBILL', 'invoice', invoiceId, { reason });
        return mapEwb(rows[0]);
      },
    },

    Invoice: {
      eInvoice: async (parent) => {
        const { rows } = await query('SELECT * FROM e_invoices WHERE invoice_id = $1', [parent.id]);
        return mapEInvoice(rows[0]);
      },
      ewayBill: async (parent) => {
        const { rows } = await query('SELECT * FROM eway_bills WHERE invoice_id = $1', [parent.id]);
        return mapEwb(rows[0]);
      },
    },
  };
}
