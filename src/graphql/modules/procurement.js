// GraphQL module: Procurement / Purchase.
// Vendors + Purchase Orders -> Goods Receipt (real stock inflow) -> vendor bill -> payment.

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { splitTax, roundGst } from '../../services/gst/calc.js';
import { resolveStateCode } from '../../services/gst/stateCodes.js';

export const procurementTypeDefs = /* GraphQL */ `
  type Vendor {
    id: ID!
    name: String!
    contactPerson: String
    phone: String
    email: String
    gstin: String
    address: String
    city: String
    state: String
    outstanding: Float!
    udyamNo: String
    msmeType: String
    msmeRegistered: Boolean!
    msmeRegDate: String
    paymentTermsDays: Int!
    isActive: Boolean!
    createdAt: DateTime!
  }

  type POLine {
    id: ID!
    productId: ID!
    productName: String!
    hsnCode: String
    uom: String
    quantity: Float!
    receivedQty: Float!
    unitCost: Float!
    gstPercent: Float!
    lineTotal: Float!
  }

  type PurchaseOrder {
    id: ID!
    poNo: String!
    vendorId: ID!
    vendorName: String
    status: String!
    orderDate: String!
    expectedDate: String
    subTotal: Float!
    taxTotal: Float!
    totalAmount: Float!
    notes: String
    itemCount: Int!
    lines: [POLine!]!
    hasBill: Boolean!
    createdAt: DateTime!
  }

  type PurchaseInvoice {
    id: ID!
    billNo: String!
    internalNo: String!
    vendorName: String
    invoiceDate: String!
    totalAmount: Float!
    amountPaid: Float!
    balanceDue: Float!
    createdAt: DateTime!
  }

  type PurchaseStats { vendors: Int!, openPos: Int!, purchasesMtd: Float!, vendorOutstanding: Float! }

  input VendorInput {
    name: String!
    contactPerson: String
    phone: String
    email: String
    gstin: String
    address: String
    city: String
    state: String
    udyamNo: String
    msmeType: String
    msmeRegistered: Boolean
    msmeRegDate: String
    paymentTermsDays: Int
  }
  input POLineInput { productId: ID!, quantity: Float!, unitCost: Float! }
  input CreatePOInput { vendorId: ID!, orderDate: String, expectedDate: String, notes: String, lines: [POLineInput!]! }
  input ReceiveLineInput { poLineId: ID!, batchNumber: String!, manufacturingDate: String, expiryDate: String, quantity: Float! }
  input ReceivePOInput { poId: ID!, warehouseId: ID!, lines: [ReceiveLineInput!]! }
  input VendorPaymentInput { vendorId: ID!, purchaseInvoiceId: ID, amount: Float!, method: String, reference: String }

  extend type Query {
    vendors(search: String, activeOnly: Boolean, limit: Int = 100): [Vendor!]!
    vendor(id: ID!): Vendor
    purchaseOrders(status: String, vendorId: ID, search: String, limit: Int = 100): [PurchaseOrder!]!
    purchaseOrder(id: ID!): PurchaseOrder
    purchaseInvoices(vendorId: ID, limit: Int = 100): [PurchaseInvoice!]!
    purchaseStats: PurchaseStats!
  }

  extend type Mutation {
    createVendor(input: VendorInput!): Vendor!
    updateVendor(id: ID!, input: VendorInput!): Vendor!
    setVendorActive(id: ID!, isActive: Boolean!): Vendor!
    deleteVendor(id: ID!): Boolean!

    createPurchaseOrder(input: CreatePOInput!): PurchaseOrder!
    approvePurchaseOrder(id: ID!): PurchaseOrder!
    cancelPurchaseOrder(id: ID!): PurchaseOrder!
    receivePurchaseOrder(input: ReceivePOInput!): PurchaseOrder!
    recordPurchaseBill(poId: ID!, billNo: String!, invoiceDate: String, isRcm: Boolean, itcEligibility: String): PurchaseInvoice!
    recordVendorPayment(input: VendorPaymentInput!): Boolean!
  }
`;

const round2 = (n) => Math.round(n * 100) / 100;
function fy(d) {
  const dt = d ? new Date(d) : new Date();
  const start = dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const mapVendor = (r) =>
  r && {
    id: r.id, name: r.name, contactPerson: r.contact_person, phone: r.phone, email: r.email,
    gstin: r.gstin, address: r.address, city: r.city, state: r.state,
    outstanding: num(r.outstanding) ?? 0,
    udyamNo: r.udyam_no, msmeType: r.msme_type, msmeRegistered: r.msme_registered ?? false,
    msmeRegDate: r.msme_reg_date ? String(r.msme_reg_date).slice(0, 10) : null,
    paymentTermsDays: r.payment_terms_days ?? 45,
    isActive: r.is_active, createdAt: r.created_at,
  };
const mapPO = (r) =>
  r && {
    id: r.id, poNo: r.po_no, vendorId: r.vendor_id, vendorName: r.vendor_name ?? null,
    status: r.status, orderDate: isoDate(r.order_date), expectedDate: isoDate(r.expected_date),
    subTotal: num(r.sub_total), taxTotal: num(r.tax_total), totalAmount: num(r.total_amount),
    notes: r.notes, createdAt: r.created_at,
  };
const mapPInv = (r) =>
  r && {
    id: r.id, billNo: r.bill_no, internalNo: r.internal_no, vendorName: r.vendor_name ?? null,
    invoiceDate: isoDate(r.invoice_date), totalAmount: num(r.total_amount),
    amountPaid: num(r.amount_paid), balanceDue: num(r.total_amount) - num(r.amount_paid), createdAt: r.created_at,
  };
const vVals = (i) => [i.name, i.contactPerson ?? null, i.phone ?? null, i.email ?? null, i.gstin ?? null, i.address ?? null, i.city ?? null, i.state ?? null, i.udyamNo ?? null, i.msmeType ?? null, i.msmeRegistered ?? false, i.msmeRegDate ?? null, i.paymentTermsDays ?? 45];

export function procurementResolvers() {
  return {
    Query: {
      vendors: async (_p, { search, activeOnly, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM vendors
           WHERE ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR gstin ILIKE '%'||$1||'%')
             AND ($2::bool IS NULL OR is_active = $2)
           ORDER BY created_at DESC LIMIT $3`,
          [search ?? null, activeOnly ?? null, limit],
        );
        return rows.map(mapVendor);
      },
      vendor: async (_p, { id }, ctx) => { assertAuth(ctx); const { rows } = await query('SELECT * FROM vendors WHERE id=$1', [id]); return mapVendor(rows[0]); },
      purchaseOrders: async (_p, { status, vendorId, search, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT po.*, v.name vendor_name FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id
           WHERE ($1::text IS NULL OR po.status = $1)
             AND ($2::uuid IS NULL OR po.vendor_id = $2)
             AND ($3::text IS NULL OR po.po_no ILIKE '%'||$3||'%' OR v.name ILIKE '%'||$3||'%')
           ORDER BY po.created_at DESC LIMIT $4`,
          [status ?? null, vendorId ?? null, search ?? null, limit],
        );
        return rows.map(mapPO);
      },
      purchaseOrder: async (_p, { id }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query('SELECT po.*, v.name vendor_name FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id WHERE po.id=$1', [id]);
        return mapPO(rows[0]);
      },
      purchaseInvoices: async (_p, { vendorId, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT pi.*, v.name vendor_name FROM purchase_invoices pi JOIN vendors v ON v.id=pi.vendor_id
           WHERE ($1::uuid IS NULL OR pi.vendor_id = $1) ORDER BY pi.created_at DESC LIMIT $2`,
          [vendorId ?? null, limit],
        );
        return rows.map(mapPInv);
      },
      purchaseStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          `SELECT (SELECT COUNT(*) FROM vendors WHERE is_active)::int vendors,
                  (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('DRAFT','APPROVED','PARTIAL'))::int open_pos,
                  COALESCE((SELECT SUM(total_amount) FROM purchase_invoices WHERE date_trunc('month',invoice_date)=date_trunc('month',CURRENT_DATE)),0) purchases_mtd,
                  COALESCE((SELECT SUM(outstanding) FROM vendors),0) vendor_outstanding`,
        );
        const r = rows[0];
        return { vendors: r.vendors, openPos: r.open_pos, purchasesMtd: num(r.purchases_mtd), vendorOutstanding: num(r.vendor_outstanding) };
      },
    },

    Mutation: {
      createVendor: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          `INSERT INTO vendors (name, contact_person, phone, email, gstin, address, city, state, udyam_no, msme_type, msme_registered, msme_reg_date, payment_terms_days)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, vVals(input));
        await logActivity(a.sub, 'CREATE_VENDOR', 'vendor', rows[0].id);
        return mapVendor(rows[0]);
      },
      updateVendor: async (_p, { id, input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          `UPDATE vendors SET name=$2, contact_person=$3, phone=$4, email=$5, gstin=$6, address=$7, city=$8, state=$9,
             udyam_no=$10, msme_type=$11, msme_registered=$12, msme_reg_date=$13, payment_terms_days=$14, updated_at=now() WHERE id=$1 RETURNING *`,
          [id, ...vVals(input)]);
        if (!rows[0]) throw httpError('Vendor not found', 404);
        await logActivity(a.sub, 'UPDATE_VENDOR', 'vendor', id);
        return mapVendor(rows[0]);
      },
      setVendorActive: async (_p, { id, isActive }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query('UPDATE vendors SET is_active=$2, updated_at=now() WHERE id=$1 RETURNING *', [id, isActive]);
        if (!rows[0]) throw httpError('Vendor not found', 404);
        await logActivity(a.sub, 'TOGGLE_VENDOR', 'vendor', id);
        return mapVendor(rows[0]);
      },
      deleteVendor: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rowCount } = await query('DELETE FROM vendors WHERE id=$1', [id]);
        if (!rowCount) throw httpError('Vendor not found', 404);
        await logActivity(a.sub, 'DELETE_VENDOR', 'vendor', id);
        return true;
      },

      createPurchaseOrder: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        if (!input.lines?.length) throw httpError('PO must have at least one line', 400);
        return withTransaction(async (client) => {
          const v = await client.query('SELECT id FROM vendors WHERE id=$1', [input.vendorId]);
          if (!v.rows[0]) throw httpError('Vendor not found', 404);
          let subTotal = 0, taxTotal = 0;
          const lines = [];
          for (const l of input.lines) {
            const pr = await client.query('SELECT * FROM products WHERE id=$1', [l.productId]);
            const p = pr.rows[0];
            if (!p) throw httpError('Product not found', 404);
            const lineTotal = round2(l.quantity * l.unitCost);
            const gst = num(p.gst_percent ?? 0);
            subTotal += lineTotal; taxTotal += round2(lineTotal * gst / 100);
            lines.push({ p, l, lineTotal, gst });
          }
          subTotal = round2(subTotal); taxTotal = round2(taxTotal);
          const total = round2(subTotal + taxTotal);
          const poNo = `PO-${fy(input.orderDate)}-${String((await client.query("SELECT nextval('po_seq') n")).rows[0].n).padStart(5, '0')}`;
          const po = await client.query(
            `INSERT INTO purchase_orders (po_no, vendor_id, status, order_date, expected_date, sub_total, tax_total, total_amount, notes, created_by)
             VALUES ($1,$2,'DRAFT',COALESCE($3,CURRENT_DATE),$4,$5,$6,$7,$8,$9) RETURNING *`,
            [poNo, input.vendorId, input.orderDate ?? null, input.expectedDate ?? null, subTotal, taxTotal, total, input.notes ?? null, a.sub]);
          for (const { p, l, lineTotal, gst } of lines) {
            await client.query(
              `INSERT INTO purchase_order_lines (po_id, product_id, product_name, hsn_code, uom, quantity, unit_cost, gst_percent, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [po.rows[0].id, p.id, p.name, p.hsn_code, p.uom, l.quantity, l.unitCost, gst, lineTotal]);
          }
          await logActivity(a.sub, 'CREATE_PO', 'purchase_order', po.rows[0].id, { poNo });
          const full = await client.query('SELECT po.*, v.name vendor_name FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id WHERE po.id=$1', [po.rows[0].id]);
          return mapPO(full.rows[0]);
        });
      },

      approvePurchaseOrder: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query("UPDATE purchase_orders SET status='APPROVED', updated_at=now() WHERE id=$1 AND status='DRAFT' RETURNING *", [id]);
        if (!rows[0]) throw httpError('Only DRAFT purchase orders can be approved', 400);
        await logActivity(a.sub, 'APPROVE_PO', 'purchase_order', id);
        const full = await query('SELECT po.*, v.name vendor_name FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id WHERE po.id=$1', [id]);
        return mapPO(full.rows[0]);
      },
      cancelPurchaseOrder: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const cur = await query('SELECT status FROM purchase_orders WHERE id=$1', [id]);
        if (!cur.rows[0]) throw httpError('PO not found', 404);
        if (['RECEIVED', 'PARTIAL'].includes(cur.rows[0].status)) throw httpError('Cannot cancel a (partially) received PO', 400);
        const { rows } = await query("UPDATE purchase_orders SET status='CANCELLED', updated_at=now() WHERE id=$1 RETURNING *", [id]);
        await logActivity(a.sub, 'CANCEL_PO', 'purchase_order', id);
        const full = await query('SELECT po.*, v.name vendor_name FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id WHERE po.id=$1', [id]);
        return mapPO(full.rows[0]);
      },

      receivePurchaseOrder: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        return withTransaction(async (client) => {
          const po = (await client.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [input.poId])).rows[0];
          if (!po) throw httpError('PO not found', 404);
          if (!['APPROVED', 'PARTIAL'].includes(po.status)) throw httpError('PO must be APPROVED to receive', 400);
          const wh = (await client.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouseId])).rows[0];
          if (!wh) throw httpError('Warehouse not found', 404);

          const grnNo = `GRN-${String((await client.query("SELECT nextval('grn_seq') n")).rows[0].n).padStart(6, '0')}`;
          const grn = await client.query(
            `INSERT INTO goods_receipts (grn_no, po_id, vendor_id, warehouse_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [grnNo, po.id, po.vendor_id, input.warehouseId, a.sub]);

          for (const rl of input.lines) {
            if (rl.quantity <= 0) continue;
            const line = (await client.query('SELECT * FROM purchase_order_lines WHERE id=$1 AND po_id=$2 FOR UPDATE', [rl.poLineId, po.id])).rows[0];
            if (!line) throw httpError('PO line not found', 404);
            // create/find batch, add stock, log movement IN
            const batch = await client.query(
              `INSERT INTO batches (product_id, batch_number, manufacturing_date, expiry_date)
               VALUES ($1,$2,$3,$4) ON CONFLICT (product_id, batch_number) DO UPDATE SET
                 manufacturing_date=COALESCE(EXCLUDED.manufacturing_date, batches.manufacturing_date),
                 expiry_date=COALESCE(EXCLUDED.expiry_date, batches.expiry_date) RETURNING id`,
              [line.product_id, rl.batchNumber, rl.manufacturingDate ?? null, rl.expiryDate ?? null]);
            await client.query(
              `INSERT INTO stock_levels (warehouse_id, product_id, batch_id, quantity)
               VALUES ($1,$2,$3,$4) ON CONFLICT (warehouse_id, product_id, batch_id) DO UPDATE SET
                 quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at=now()`,
              [input.warehouseId, line.product_id, batch.rows[0].id, rl.quantity]);
            await client.query(
              `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, ref_id, created_by)
               VALUES ($1,$2,$3,'IN',$4,'Goods receipt (GRN)','grn',$5,$6)`,
              [input.warehouseId, line.product_id, batch.rows[0].id, rl.quantity, grn.rows[0].id, a.sub]);
            await client.query('UPDATE purchase_order_lines SET received_qty = received_qty + $2 WHERE id=$1', [line.id, rl.quantity]);
          }

          // recompute PO status
          const lines = (await client.query('SELECT quantity, received_qty FROM purchase_order_lines WHERE po_id=$1', [po.id])).rows;
          const allDone = lines.every((l) => num(l.received_qty) >= num(l.quantity));
          const newStatus = allDone ? 'RECEIVED' : 'PARTIAL';
          await client.query('UPDATE purchase_orders SET status=$2, updated_at=now() WHERE id=$1', [po.id, newStatus]);
          await logActivity(a.sub, 'RECEIVE_PO', 'purchase_order', po.id, { grnNo, status: newStatus });
          const full = await client.query('SELECT po.*, v.name vendor_name FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id WHERE po.id=$1', [po.id]);
          return mapPO(full.rows[0]);
        });
      },

      recordPurchaseBill: async (_p, { poId, billNo, invoiceDate, isRcm, itcEligibility }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        return withTransaction(async (client) => {
          const po = (await client.query('SELECT * FROM purchase_orders WHERE id=$1', [poId])).rows[0];
          if (!po) throw httpError('PO not found', 404);
          const exists = await client.query('SELECT id FROM purchase_invoices WHERE po_id=$1', [poId]);
          if (exists.rows[0]) throw httpError('A bill already exists for this PO', 409);
          const internalNo = `PINV-${fy(invoiceDate)}-${String((await client.query("SELECT nextval('pbill_seq') n")).rows[0].n).padStart(5, '0')}`;

          // Derive inter/intra from company vs vendor state, then split the PO tax into heads (books-based ITC).
          const company = (await client.query('SELECT gstin, state FROM company_settings WHERE id = 1')).rows[0] || {};
          const vendor = (await client.query('SELECT gstin, state FROM vendors WHERE id = $1', [po.vendor_id])).rows[0] || {};
          const coState = resolveStateCode({ gstin: company.gstin, stateName: company.state });
          const vState = resolveStateCode({ gstin: vendor.gstin, stateName: vendor.state });
          const interstate = !!coState && !!vState && coState !== vState;
          const s = splitTax(num(po.sub_total) || 0, num(po.sub_total) > 0 ? roundGst((num(po.tax_total) / num(po.sub_total)) * 100) : 0, interstate);
          const elig = ['ELIGIBLE', 'INELIGIBLE', 'PARTIAL'].includes(String(itcEligibility || '').toUpperCase()) ? itcEligibility.toUpperCase() : 'ELIGIBLE';

          const inv = await client.query(
            `INSERT INTO purchase_invoices (bill_no, internal_no, po_id, vendor_id, invoice_date, taxable_value, tax_value, igst, cgst, sgst, is_interstate, is_rcm, itc_eligibility, total_amount, created_by)
             VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [billNo, internalNo, poId, po.vendor_id, invoiceDate ?? null, num(po.sub_total), num(po.tax_total), s.igst, s.cgst, s.sgst, interstate, !!isRcm, elig, num(po.total_amount), a.sub]);
          await client.query('UPDATE vendors SET outstanding = outstanding + $2 WHERE id=$1', [po.vendor_id, num(po.total_amount)]);
          await logActivity(a.sub, 'RECORD_PURCHASE_BILL', 'purchase_invoice', inv.rows[0].id, { billNo });
          const full = await client.query('SELECT pi.*, v.name vendor_name FROM purchase_invoices pi JOIN vendors v ON v.id=pi.vendor_id WHERE pi.id=$1', [inv.rows[0].id]);
          return mapPInv(full.rows[0]);
        });
      },

      recordVendorPayment: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        if (input.amount <= 0) throw httpError('Amount must be positive', 400);
        return withTransaction(async (client) => {
          const v = await client.query('SELECT id FROM vendors WHERE id=$1', [input.vendorId]);
          if (!v.rows[0]) throw httpError('Vendor not found', 404);
          await client.query(
            `INSERT INTO vendor_payments (vendor_id, purchase_invoice_id, amount, method, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
            [input.vendorId, input.purchaseInvoiceId ?? null, input.amount, input.method ?? null, input.reference ?? null, a.sub]);
          if (input.purchaseInvoiceId) await client.query('UPDATE purchase_invoices SET amount_paid = amount_paid + $2 WHERE id=$1', [input.purchaseInvoiceId, input.amount]);
          await client.query('UPDATE vendors SET outstanding = GREATEST(outstanding - $2, 0) WHERE id=$1', [input.vendorId, input.amount]);
          await logActivity(a.sub, 'VENDOR_PAYMENT', 'vendor', input.vendorId, { amount: input.amount });
          return true;
        });
      },
    },

    PurchaseOrder: {
      itemCount: async (parent) => (await query('SELECT COUNT(*)::int n FROM purchase_order_lines WHERE po_id=$1', [parent.id])).rows[0].n,
      lines: async (parent) => {
        const { rows } = await query('SELECT * FROM purchase_order_lines WHERE po_id=$1 ORDER BY product_name', [parent.id]);
        return rows.map((r) => ({
          id: r.id, productId: r.product_id, productName: r.product_name, hsnCode: r.hsn_code, uom: r.uom,
          quantity: num(r.quantity), receivedQty: num(r.received_qty), unitCost: num(r.unit_cost),
          gstPercent: num(r.gst_percent), lineTotal: num(r.line_total),
        }));
      },
      hasBill: async (parent) => Boolean((await query('SELECT 1 FROM purchase_invoices WHERE po_id=$1', [parent.id])).rows[0]),
    },
  };
}
