// GraphQL module: Returns Management (PRD §7.3).
// Sales returns -> goods back into stock + credit note (reduces distributor outstanding).
// Purchase returns -> goods out of stock + debit note (reduces vendor payable).

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';

export const returnsTypeDefs = /* GraphQL */ `
  type SalesReturnLine {
    id: ID!
    productId: ID!
    productName: String!
    batchNumber: String
    quantity: Float!
    unitPrice: Float!
    gstPercent: Float!
    lineTotal: Float!
  }
  type SalesReturn {
    id: ID!
    returnNo: String!
    orderId: ID
    orderNo: String
    distributorId: ID!
    distributorName: String
    warehouseId: ID
    warehouseName: String
    status: String!
    returnDate: String!
    reason: String
    subTotal: Float!
    taxTotal: Float!
    totalAmount: Float!
    creditNoteNo: String
    notes: String
    itemCount: Int!
    lines: [SalesReturnLine!]!
    createdAt: DateTime!
    approvedAt: DateTime
  }

  type PurchaseReturnLine {
    id: ID!
    productId: ID!
    productName: String!
    batchNumber: String
    quantity: Float!
    unitCost: Float!
    gstPercent: Float!
    lineTotal: Float!
  }
  type PurchaseReturn {
    id: ID!
    returnNo: String!
    poId: ID
    poNo: String
    vendorId: ID!
    vendorName: String
    warehouseId: ID
    warehouseName: String
    status: String!
    returnDate: String!
    reason: String
    subTotal: Float!
    taxTotal: Float!
    totalAmount: Float!
    debitNoteNo: String
    notes: String
    itemCount: Int!
    lines: [PurchaseReturnLine!]!
    createdAt: DateTime!
    approvedAt: DateTime
  }

  type ReturnsStats {
    salesReturns: Int!
    purchaseReturns: Int!
    pendingSales: Int!
    pendingPurchase: Int!
    creditIssued: Float!
    debitIssued: Float!
  }

  input SalesReturnLineInput { productId: ID!, batchNumber: String, quantity: Float!, unitPrice: Float! }
  input CreateSalesReturnInput { distributorId: ID!, orderId: ID, warehouseId: ID!, reason: String, notes: String, lines: [SalesReturnLineInput!]! }
  input PurchaseReturnLineInput { productId: ID!, batchNumber: String, quantity: Float!, unitCost: Float! }
  input CreatePurchaseReturnInput { vendorId: ID!, poId: ID, warehouseId: ID!, reason: String, notes: String, lines: [PurchaseReturnLineInput!]! }

  extend type Query {
    salesReturns(status: String, search: String, limit: Int = 100): [SalesReturn!]!
    salesReturn(id: ID!): SalesReturn
    purchaseReturns(status: String, search: String, limit: Int = 100): [PurchaseReturn!]!
    purchaseReturn(id: ID!): PurchaseReturn
    returnsStats: ReturnsStats!
  }

  extend type Mutation {
    createSalesReturn(input: CreateSalesReturnInput!): SalesReturn!
    approveSalesReturn(id: ID!): SalesReturn!
    cancelSalesReturn(id: ID!): SalesReturn!
    createPurchaseReturn(input: CreatePurchaseReturnInput!): PurchaseReturn!
    approvePurchaseReturn(id: ID!): PurchaseReturn!
    cancelPurchaseReturn(id: ID!): PurchaseReturn!
  }
`;

const round2 = (n) => Math.round(n * 100) / 100;
function fy(d) {
  const dt = d ? new Date(d) : new Date();
  const start = dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const SR_SELECT = `SELECT sr.*, d.name distributor_name, o.order_no, w.name warehouse_name
  FROM sales_returns sr JOIN distributors d ON d.id = sr.distributor_id
  LEFT JOIN orders o ON o.id = sr.order_id LEFT JOIN warehouses w ON w.id = sr.warehouse_id`;
const PR_SELECT = `SELECT pr.*, v.name vendor_name, po.po_no, w.name warehouse_name
  FROM purchase_returns pr JOIN vendors v ON v.id = pr.vendor_id
  LEFT JOIN purchase_orders po ON po.id = pr.po_id LEFT JOIN warehouses w ON w.id = pr.warehouse_id`;

const mapSR = (r) => r && {
  id: r.id, returnNo: r.return_no, orderId: r.order_id, orderNo: r.order_no ?? null,
  distributorId: r.distributor_id, distributorName: r.distributor_name ?? null,
  warehouseId: r.warehouse_id, warehouseName: r.warehouse_name ?? null, status: r.status,
  returnDate: isoDate(r.return_date), reason: r.reason, subTotal: num(r.sub_total), taxTotal: num(r.tax_total),
  totalAmount: num(r.total_amount), creditNoteNo: r.credit_note_no, notes: r.notes, createdAt: r.created_at, approvedAt: r.approved_at,
};
const mapPR = (r) => r && {
  id: r.id, returnNo: r.return_no, poId: r.po_id, poNo: r.po_no ?? null,
  vendorId: r.vendor_id, vendorName: r.vendor_name ?? null,
  warehouseId: r.warehouse_id, warehouseName: r.warehouse_name ?? null, status: r.status,
  returnDate: isoDate(r.return_date), reason: r.reason, subTotal: num(r.sub_total), taxTotal: num(r.tax_total),
  totalAmount: num(r.total_amount), debitNoteNo: r.debit_note_no, notes: r.notes, createdAt: r.created_at, approvedAt: r.approved_at,
};

export function returnsResolvers() {
  return {
    Query: {
      salesReturns: async (_p, { status, search, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `${SR_SELECT} WHERE ($1::text IS NULL OR sr.status=$1)
             AND ($2::text IS NULL OR sr.return_no ILIKE '%'||$2||'%' OR d.name ILIKE '%'||$2||'%')
           ORDER BY sr.created_at DESC LIMIT $3`,
          [status ?? null, search ?? null, limit],
        );
        return rows.map(mapSR);
      },
      salesReturn: async (_p, { id }, ctx) => { assertAuth(ctx); const { rows } = await query(`${SR_SELECT} WHERE sr.id=$1`, [id]); return mapSR(rows[0]); },
      purchaseReturns: async (_p, { status, search, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `${PR_SELECT} WHERE ($1::text IS NULL OR pr.status=$1)
             AND ($2::text IS NULL OR pr.return_no ILIKE '%'||$2||'%' OR v.name ILIKE '%'||$2||'%')
           ORDER BY pr.created_at DESC LIMIT $3`,
          [status ?? null, search ?? null, limit],
        );
        return rows.map(mapPR);
      },
      purchaseReturn: async (_p, { id }, ctx) => { assertAuth(ctx); const { rows } = await query(`${PR_SELECT} WHERE pr.id=$1`, [id]); return mapPR(rows[0]); },
      returnsStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          `SELECT (SELECT COUNT(*) FROM sales_returns)::int sales_returns,
                  (SELECT COUNT(*) FROM purchase_returns)::int purchase_returns,
                  (SELECT COUNT(*) FROM sales_returns WHERE status='DRAFT')::int pending_sales,
                  (SELECT COUNT(*) FROM purchase_returns WHERE status='DRAFT')::int pending_purchase,
                  COALESCE((SELECT SUM(total_amount) FROM sales_returns WHERE status='APPROVED'),0) credit_issued,
                  COALESCE((SELECT SUM(total_amount) FROM purchase_returns WHERE status='APPROVED'),0) debit_issued`,
        );
        const r = rows[0];
        return {
          salesReturns: r.sales_returns, purchaseReturns: r.purchase_returns,
          pendingSales: r.pending_sales, pendingPurchase: r.pending_purchase,
          creditIssued: num(r.credit_issued), debitIssued: num(r.debit_issued),
        };
      },
    },

    Mutation: {
      createSalesReturn: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        if (!input.lines?.length) throw httpError('A return needs at least one line', 400);
        return withTransaction(async (client) => {
          if (!(await client.query('SELECT id FROM distributors WHERE id=$1', [input.distributorId])).rows[0]) throw httpError('Distributor not found', 404);
          if (!(await client.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouseId])).rows[0]) throw httpError('Warehouse not found', 404);
          let subTotal = 0, taxTotal = 0;
          const prepared = [];
          for (const l of input.lines) {
            const p = (await client.query('SELECT name, gst_percent FROM products WHERE id=$1', [l.productId])).rows[0];
            if (!p) throw httpError('Product not found', 404);
            if (!(num(l.quantity) > 0)) throw httpError(`${p.name}: quantity must be positive`, 400);
            if (num(l.unitPrice) < 0) throw httpError(`${p.name}: unit price cannot be negative`, 400);
            const lineTotal = round2(l.quantity * l.unitPrice);
            const gst = num(p.gst_percent ?? 0);
            subTotal += lineTotal; taxTotal += round2(lineTotal * gst / 100);
            prepared.push({ l, name: p.name, gst, lineTotal });
          }
          subTotal = round2(subTotal); taxTotal = round2(taxTotal);
          const returnNo = `SRN-${fy()}-${String((await client.query("SELECT nextval('srn_seq') n")).rows[0].n).padStart(5, '0')}`;
          const sr = (await client.query(
            `INSERT INTO sales_returns (return_no, order_id, distributor_id, warehouse_id, reason, notes, sub_total, tax_total, total_amount, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [returnNo, input.orderId ?? null, input.distributorId, input.warehouseId, input.reason ?? null, input.notes ?? null, subTotal, taxTotal, round2(subTotal + taxTotal), a.sub],
          )).rows[0];
          for (const { l, name, gst, lineTotal } of prepared) {
            await client.query(
              `INSERT INTO sales_return_lines (return_id, product_id, product_name, batch_number, quantity, unit_price, gst_percent, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [sr.id, l.productId, name, l.batchNumber ?? null, l.quantity, l.unitPrice, gst, lineTotal],
            );
          }
          await logActivity(a.sub, 'CREATE_SALES_RETURN', 'sales_return', sr.id, { returnNo });
          return mapSR((await client.query(`${SR_SELECT} WHERE sr.id=$1`, [sr.id])).rows[0]);
        });
      },

      approveSalesReturn: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        return withTransaction(async (client) => {
          const sr = (await client.query('SELECT * FROM sales_returns WHERE id=$1 FOR UPDATE', [id])).rows[0];
          if (!sr) throw httpError('Sales return not found', 404);
          if (sr.status !== 'DRAFT') throw httpError('Only DRAFT returns can be approved', 400);
          const lines = (await client.query('SELECT * FROM sales_return_lines WHERE return_id=$1', [id])).rows;

          // Goods back into stock.
          for (const ln of lines) {
            const batchNo = ln.batch_number || `RET-${sr.return_no}`;
            const batch = (await client.query(
              `INSERT INTO batches (product_id, batch_number) VALUES ($1,$2)
               ON CONFLICT (product_id, batch_number) DO UPDATE SET batch_number=EXCLUDED.batch_number RETURNING id`,
              [ln.product_id, batchNo],
            )).rows[0];
            await client.query(
              `INSERT INTO stock_levels (warehouse_id, product_id, batch_id, quantity)
               VALUES ($1,$2,$3,$4) ON CONFLICT (warehouse_id, product_id, batch_id) DO UPDATE SET
                 quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at=now()`,
              [sr.warehouse_id, ln.product_id, batch.id, ln.quantity],
            );
            await client.query(
              `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, ref_id, created_by)
               VALUES ($1,$2,$3,'IN',$4,'Sales return','sales_return',$5,$6)`,
              [sr.warehouse_id, ln.product_id, batch.id, num(ln.quantity), sr.id, a.sub],
            );
          }

          // Credit note -> reduces distributor outstanding. Capture the full GST
          // breakup (taxable/rate/heads + linked invoice) so GSTR-1 CDNR reports
          // the note correctly instead of deriving a blended rate.
          const refInv = sr.order_id
            ? (await client.query('SELECT id, is_interstate FROM invoices WHERE order_id=$1', [sr.order_id])).rows[0]
            : null;
          const interstate = !!refInv?.is_interstate;
          const taxable = num(sr.sub_total);
          const tax = num(sr.tax_total);
          const cgst = interstate ? 0 : round2(tax / 2);
          const sgst = interstate ? 0 : round2(tax - cgst);
          const igst = interstate ? tax : 0;
          const blendedRate = taxable > 0 ? round2((tax / taxable) * 100) : 0;
          const noteNo = `CN-${fy()}-${String((await client.query("SELECT nextval('note_seq') n")).rows[0].n).padStart(5, '0')}`;
          await client.query(
            `INSERT INTO credit_debit_notes (note_no, distributor_id, note_type, amount, reason, ref_invoice_id,
               taxable_value, gst_rate, cgst, sgst, igst, is_interstate, note_reason, created_by)
             VALUES ($1,$2,'CREDIT',$3,$4,$5,$6,$7,$8,$9,$10,$11,'01',$12)`,
            [noteNo, sr.distributor_id, num(sr.total_amount), `Sales return ${sr.return_no}`, refInv?.id ?? null,
              taxable, blendedRate, cgst, sgst, igst, interstate, a.sub],
          );
          await client.query('UPDATE distributors SET outstanding = GREATEST(outstanding - $2, 0) WHERE id=$1', [sr.distributor_id, num(sr.total_amount)]);
          await client.query("UPDATE sales_returns SET status='APPROVED', credit_note_no=$2, approved_at=now() WHERE id=$1", [id, noteNo]);
          await logActivity(a.sub, 'APPROVE_SALES_RETURN', 'sales_return', id, { noteNo });
          return mapSR((await client.query(`${SR_SELECT} WHERE sr.id=$1`, [id])).rows[0]);
        });
      },

      cancelSalesReturn: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const cur = await query('SELECT status FROM sales_returns WHERE id=$1', [id]);
        if (!cur.rows[0]) throw httpError('Sales return not found', 404);
        if (cur.rows[0].status !== 'DRAFT') throw httpError('Only DRAFT returns can be cancelled', 400);
        await query("UPDATE sales_returns SET status='CANCELLED' WHERE id=$1", [id]);
        await logActivity(a.sub, 'CANCEL_SALES_RETURN', 'sales_return', id);
        return mapSR((await query(`${SR_SELECT} WHERE sr.id=$1`, [id])).rows[0]);
      },

      createPurchaseReturn: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        if (!input.lines?.length) throw httpError('A return needs at least one line', 400);
        return withTransaction(async (client) => {
          if (!(await client.query('SELECT id FROM vendors WHERE id=$1', [input.vendorId])).rows[0]) throw httpError('Vendor not found', 404);
          if (!(await client.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouseId])).rows[0]) throw httpError('Warehouse not found', 404);
          let subTotal = 0, taxTotal = 0;
          const prepared = [];
          for (const l of input.lines) {
            const p = (await client.query('SELECT name, gst_percent FROM products WHERE id=$1', [l.productId])).rows[0];
            if (!p) throw httpError('Product not found', 404);
            if (!(num(l.quantity) > 0)) throw httpError(`${p.name}: quantity must be positive`, 400);
            if (num(l.unitCost) < 0) throw httpError(`${p.name}: unit cost cannot be negative`, 400);
            const lineTotal = round2(l.quantity * l.unitCost);
            const gst = num(p.gst_percent ?? 0);
            subTotal += lineTotal; taxTotal += round2(lineTotal * gst / 100);
            prepared.push({ l, name: p.name, gst, lineTotal });
          }
          subTotal = round2(subTotal); taxTotal = round2(taxTotal);
          const returnNo = `PRN-${fy()}-${String((await client.query("SELECT nextval('prn_seq') n")).rows[0].n).padStart(5, '0')}`;
          const pr = (await client.query(
            `INSERT INTO purchase_returns (return_no, po_id, vendor_id, warehouse_id, reason, notes, sub_total, tax_total, total_amount, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [returnNo, input.poId ?? null, input.vendorId, input.warehouseId, input.reason ?? null, input.notes ?? null, subTotal, taxTotal, round2(subTotal + taxTotal), a.sub],
          )).rows[0];
          for (const { l, name, gst, lineTotal } of prepared) {
            await client.query(
              `INSERT INTO purchase_return_lines (return_id, product_id, product_name, batch_number, quantity, unit_cost, gst_percent, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [pr.id, l.productId, name, l.batchNumber ?? null, l.quantity, l.unitCost, gst, lineTotal],
            );
          }
          await logActivity(a.sub, 'CREATE_PURCHASE_RETURN', 'purchase_return', pr.id, { returnNo });
          return mapPR((await client.query(`${PR_SELECT} WHERE pr.id=$1`, [pr.id])).rows[0]);
        });
      },

      approvePurchaseReturn: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        return withTransaction(async (client) => {
          const pr = (await client.query('SELECT * FROM purchase_returns WHERE id=$1 FOR UPDATE', [id])).rows[0];
          if (!pr) throw httpError('Purchase return not found', 404);
          if (pr.status !== 'DRAFT') throw httpError('Only DRAFT returns can be approved', 400);
          const lines = (await client.query('SELECT * FROM purchase_return_lines WHERE return_id=$1', [id])).rows;

          // Goods out of stock (prefer the named batch, else FIFO by expiry).
          for (const ln of lines) {
            let remaining = num(ln.quantity);
            const stock = (await client.query(
              `SELECT sl.*, b.batch_number FROM stock_levels sl JOIN batches b ON b.id = sl.batch_id
               WHERE sl.product_id=$1 AND sl.warehouse_id=$2 AND sl.quantity>0
               ORDER BY (b.batch_number = $3) DESC, b.expiry_date ASC NULLS LAST FOR UPDATE`,
              [ln.product_id, pr.warehouse_id, ln.batch_number ?? ''],
            )).rows;
            const avail = stock.reduce((s, r) => s + num(r.quantity), 0);
            if (avail < remaining) throw httpError(`Insufficient stock to return ${ln.product_name}: need ${remaining}, have ${avail}`, 400);
            for (const sl of stock) {
              if (remaining <= 0) break;
              const take = Math.min(num(sl.quantity), remaining);
              await client.query('UPDATE stock_levels SET quantity = quantity - $2, updated_at=now() WHERE id=$1', [sl.id, take]);
              await client.query(
                `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, ref_id, created_by)
                 VALUES ($1,$2,$3,'OUT',$4,'Purchase return','purchase_return',$5,$6)`,
                [pr.warehouse_id, ln.product_id, sl.batch_id, -take, pr.id, a.sub],
              );
              remaining -= take;
            }
          }

          // Debit note -> reduces vendor payable. Numbered from note_seq — drawing
          // from prn_seq would punch holes in the purchase-return number series.
          const noteNo = `DN-${fy()}-${String((await client.query("SELECT nextval('note_seq') n")).rows[0].n).padStart(5, '0')}`;
          await client.query('UPDATE vendors SET outstanding = GREATEST(outstanding - $2, 0) WHERE id=$1', [pr.vendor_id, num(pr.total_amount)]);
          await client.query("UPDATE purchase_returns SET status='APPROVED', debit_note_no=$2, approved_at=now() WHERE id=$1", [id, noteNo]);
          await logActivity(a.sub, 'APPROVE_PURCHASE_RETURN', 'purchase_return', id, { noteNo });
          return mapPR((await client.query(`${PR_SELECT} WHERE pr.id=$1`, [id])).rows[0]);
        });
      },

      cancelPurchaseReturn: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const cur = await query('SELECT status FROM purchase_returns WHERE id=$1', [id]);
        if (!cur.rows[0]) throw httpError('Purchase return not found', 404);
        if (cur.rows[0].status !== 'DRAFT') throw httpError('Only DRAFT returns can be cancelled', 400);
        await query("UPDATE purchase_returns SET status='CANCELLED' WHERE id=$1", [id]);
        await logActivity(a.sub, 'CANCEL_PURCHASE_RETURN', 'purchase_return', id);
        return mapPR((await query(`${PR_SELECT} WHERE pr.id=$1`, [id])).rows[0]);
      },
    },

    SalesReturn: {
      itemCount: async (parent) => (await query('SELECT COUNT(*)::int n FROM sales_return_lines WHERE return_id=$1', [parent.id])).rows[0].n,
      lines: async (parent) => {
        const { rows } = await query('SELECT * FROM sales_return_lines WHERE return_id=$1 ORDER BY product_name', [parent.id]);
        return rows.map((r) => ({ id: r.id, productId: r.product_id, productName: r.product_name, batchNumber: r.batch_number, quantity: num(r.quantity), unitPrice: num(r.unit_price), gstPercent: num(r.gst_percent), lineTotal: num(r.line_total) }));
      },
    },
    PurchaseReturn: {
      itemCount: async (parent) => (await query('SELECT COUNT(*)::int n FROM purchase_return_lines WHERE return_id=$1', [parent.id])).rows[0].n,
      lines: async (parent) => {
        const { rows } = await query('SELECT * FROM purchase_return_lines WHERE return_id=$1 ORDER BY product_name', [parent.id]);
        return rows.map((r) => ({ id: r.id, productId: r.product_id, productName: r.product_name, batchNumber: r.batch_number, quantity: num(r.quantity), unitCost: num(r.unit_cost), gstPercent: num(r.gst_percent), lineTotal: num(r.line_total) }));
      },
    },
  };
}
