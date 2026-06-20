// GraphQL module: Order-to-Cash (PRD §7).
// Orders → approval (credit check) → invoice (GST split + FIFO stock-out) →
// payments → returns. Invoice e-doc fields (IRN/EWB) are filled by the GST engine.

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { mapDistributor } from './distributors.js';
import { mapCompany } from './company.js';

export const orderTypeDefs = /* GraphQL */ `
  type OrderLine {
    id: ID!
    productId: ID!
    productName: String!
    hsnCode: String
    uom: String
    quantity: Float!
    unitPrice: Float!
    discountPct: Float!
    gstPercent: Float!
    lineTotal: Float!
    taxAmount: Float!
  }

  type Customer {
    type: String!
    id: ID
    name: String!
    gstin: String
    state: String
    address: String
    phone: String
  }

  # Transport & logistics block printed on both GST invoices and Non-GST bills.
  type OrderTransport {
    transportName: String
    transporterId: String
    vehicleNo: String
    driverName: String
    driverMobile: String
    lrNumber: String
    lrDate: String
    dispatchDate: String
    deliveryLocation: String
    deliveryAddress: String
    ewayBillNo: String
    numPackages: Int
    totalWeight: String
    freightCharges: Float
    freightType: String
    dispatchThrough: String
  }

  type Order {
    id: ID!
    orderNo: String!
    distributorId: ID
    distributor: Distributor
    customerType: String!
    customer: Customer
    customerName: String
    billType: String!
    status: String!
    orderDate: String!
    subTotal: Float!
    discountTotal: Float!
    taxTotal: Float!
    totalAmount: Float!
    notes: String
    deliveryAddress: String
    transport: OrderTransport
    itemCount: Int!
    lines: [OrderLine!]!
    invoice: Invoice
    createdAt: DateTime!
  }

  type Invoice {
    id: ID!
    invoiceNo: String!
    orderId: ID!
    order: Order
    distributor: Distributor
    customer: Customer
    customerName: String
    company: CompanySettings
    billType: String!
    invoiceDate: String!
    placeOfSupply: String
    isInterstate: Boolean!
    taxableValue: Float!
    cgst: Float!
    sgst: Float!
    igst: Float!
    totalAmount: Float!
    amountPaid: Float!
    balanceDue: Float!
    irn: String
    ewayBillNo: String
    transport: OrderTransport
    status: String!
    createdAt: DateTime!
  }

  type Payment {
    id: ID!
    amount: Float!
    method: String
    reference: String
    paidAt: DateTime!
  }

  type SalesStats {
    salesToday: Float!
    salesMtd: Float!
    ordersOpen: Int!
    outstandingTotal: Float!
  }

  type MonthlySales {
    label: String!
    total: Float!
  }

  type StatusCount {
    status: String!
    count: Int!
  }

  "All period-scoped dashboard metrics for the selected window (week / month / year to date)."
  type DashboardStats {
    sales: Float!
    ordersCount: Int!
    purchases: Float!
    salesReturnsValue: Float!
    purchaseReturnsValue: Float!
    newFarmers: Int!
    newDistributors: Int!
    aiSessions: Int!
    aiLeads: Int!
    aiConverted: Int!
    complaintsOpened: Int!
    ordersByStatus: [StatusCount!]!
    trend: [MonthlySales!]!
  }

  "A single sale/transaction row for the unified Sales register (distributor + farmer, GST + non-GST)."
  type SalesTxn {
    id: ID!
    orderNo: String!
    customerName: String!
    customerType: String!
    billType: String!
    status: String!
    orderDate: String!
    itemCount: Int!
    totalAmount: Float!
    amountPaid: Float!
    balanceDue: Float!
    invoiceId: ID
  }

  "Paginated slice of the Sales register plus the total row count for the active filters."
  type SalesPage {
    rows: [SalesTxn!]!
    total: Int!
  }

  "Aggregate KPIs over the full filtered Sales register (excludes cancelled from money totals)."
  type SalesAnalytics {
    totalSales: Float!
    txnCount: Int!
    gstSales: Float!
    nonGstSales: Float!
    distributorSales: Float!
    farmerSales: Float!
    collected: Float!
    outstanding: Float!
  }

  input OrderLineInput {
    productId: ID!
    quantity: Float!
    unitPrice: Float
    discountPct: Float = 0
  }

  input OrderTransportInput {
    transportName: String
    transporterId: String
    vehicleNo: String
    driverName: String
    driverMobile: String
    lrNumber: String
    lrDate: String
    dispatchDate: String
    deliveryLocation: String
    deliveryAddress: String
    ewayBillNo: String
    numPackages: Int
    totalWeight: String
    freightCharges: Float
    freightType: String
    dispatchThrough: String
  }

  input CreateOrderInput {
    distributorId: ID
    customerType: String   # DISTRIBUTOR (default) or FARMER
    customerId: ID
    farmerRef: String      # FARMER-CODE to credit loyalty coins (₹100 spent = 1 coin)
    billType: String
    orderDate: String
    notes: String
    deliveryAddress: String
    transport: OrderTransportInput
    discountAmount: Float = 0   # bill-level discount in ₹ (UI offers % or ₹; resolved to ₹ here)
    lines: [OrderLineInput!]!
  }

  input PaymentInput {
    invoiceId: ID!
    amount: Float!
    method: String
    reference: String
  }

  extend type Query {
    orders(status: String, distributorId: ID, billType: String, search: String, dateFrom: String, dateTo: String, limit: Int = 50, offset: Int = 0): [Order!]!
    order(id: ID!): Order
    invoices(distributorId: ID, limit: Int = 50, offset: Int = 0): [Invoice!]!
    invoice(id: ID!): Invoice
    salesStats: SalesStats!
    salesTrend(months: Int = 6, period: String = "MONTHLY"): [MonthlySales!]!
    orderStatusCounts: [StatusCount!]!
    dashboardStats(period: String = "MONTHLY"): DashboardStats!
    salesTransactions(search: String, billType: String, customerType: String, status: String, dateFrom: String, dateTo: String, limit: Int = 10, offset: Int = 0): SalesPage!
    salesAnalytics(search: String, billType: String, customerType: String, status: String, dateFrom: String, dateTo: String): SalesAnalytics!
  }

  extend type Mutation {
    createOrder(input: CreateOrderInput!): Order!
    updateOrderTransport(orderId: ID!, input: OrderTransportInput!): Order!
    approveOrder(id: ID!): Order!
    generateInvoice(orderId: ID!): Invoice!
    recordPayment(input: PaymentInput!): Payment!
    updateOrderStatus(id: ID!, status: String!): Order!
    cancelOrder(id: ID!): Order!
  }
`;

const mapLine = (r) => ({
  id: r.id,
  productId: r.product_id,
  productName: r.product_name,
  hsnCode: r.hsn_code,
  uom: r.uom,
  quantity: num(r.quantity),
  unitPrice: num(r.unit_price),
  discountPct: num(r.discount_pct),
  gstPercent: num(r.gst_percent),
  lineTotal: num(r.line_total),
  taxAmount: Math.round(num(r.line_total) * num(r.gst_percent)) / 100,
});

// Transport & logistics snapshot from an orders row (columns may be NULL on
// older orders — every field is nullable, so backward-compatible).
const mapTransport = (r) =>
  r && {
    transportName: r.transport_name ?? null,
    transporterId: r.transporter_id ?? null,
    vehicleNo: r.vehicle_no ?? null,
    driverName: r.driver_name ?? null,
    driverMobile: r.driver_mobile ?? null,
    lrNumber: r.lr_number ?? null,
    lrDate: r.lr_date ? isoDate(r.lr_date) : null,
    dispatchDate: r.dispatch_date ? isoDate(r.dispatch_date) : null,
    deliveryLocation: r.delivery_location ?? null,
    deliveryAddress: r.delivery_address ?? null,
    ewayBillNo: r.eway_bill_no ?? null,
    numPackages: r.num_packages ?? null,
    totalWeight: r.total_weight ?? null,
    freightCharges: r.freight_charges == null ? null : num(r.freight_charges),
    freightType: r.freight_type ?? null,
    dispatchThrough: r.dispatch_through ?? null,
  };

const mapOrder = (r) =>
  r && {
    id: r.id,
    orderNo: r.order_no,
    distributorId: r.distributor_id,
    customerType: r.customer_type ?? 'DISTRIBUTOR',
    farmerId: r.farmer_id ?? null,
    billType: r.bill_type ?? 'GST',
    status: r.status,
    orderDate: isoDate(r.order_date),
    subTotal: num(r.sub_total),
    discountTotal: num(r.discount_total),
    taxTotal: num(r.tax_total),
    totalAmount: num(r.total_amount),
    notes: r.notes,
    deliveryAddress: r.delivery_address,
    transport: mapTransport(r),
    createdAt: r.created_at,
  };

const mapInvoice = (r) =>
  r && {
    id: r.id,
    invoiceNo: r.invoice_no,
    orderId: r.order_id,
    distributorId: r.distributor_id,
    customerType: r.customer_type ?? 'DISTRIBUTOR',
    farmerId: r.farmer_id ?? null,
    billType: r.bill_type ?? 'GST',
    invoiceDate: isoDate(r.invoice_date),
    placeOfSupply: r.place_of_supply,
    isInterstate: r.is_interstate,
    taxableValue: num(r.taxable_value),
    cgst: num(r.cgst),
    sgst: num(r.sgst),
    igst: num(r.igst),
    totalAmount: num(r.total_amount),
    amountPaid: num(r.amount_paid),
    balanceDue: num(r.total_amount) - num(r.amount_paid),
    irn: r.irn,
    ewayBillNo: r.eway_bill_no,
    status: r.status,
    createdAt: r.created_at,
  };

const round2 = (n) => Math.round(n * 100) / 100;

// Resolve an order/invoice customer (distributor or farmer) into a generic shape.
async function resolveCustomer(customerType, distributorId, farmerId) {
  if (customerType === 'FARMER' && farmerId) {
    const f = (await query('SELECT id, name, phone, village, district FROM farmers WHERE id = $1', [farmerId])).rows[0];
    return f && { type: 'FARMER', id: f.id, name: f.name, gstin: null, state: null, address: [f.village, f.district].filter(Boolean).join(', ') || null, phone: f.phone };
  }
  if (!distributorId) return null;
  const d = (await query('SELECT * FROM distributors WHERE id = $1', [distributorId])).rows[0];
  return d && { type: 'DISTRIBUTOR', id: d.id, name: d.name, gstin: d.gstin, state: d.state, address: d.address, phone: d.phone };
}

function financialYear(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getFullYear();
  const m = d.getMonth(); // 0=Jan
  const start = m >= 3 ? y : y - 1; // FY starts in April
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// date_trunc unit for the week/month/year-to-date window used by the KPI cards.
const PERIOD_UNIT = { WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
const periodUnit = (period) => PERIOD_UNIT[String(period || 'MONTHLY').toUpperCase()] ?? 'month';

// Time-series buckets for the Sales Trend chart (last N weeks / months / years).
async function salesTrendRows(period, months) {
  const PERIODS = {
    WEEKLY: { unit: 'week', count: 12, fmt: 'DD Mon' },
    MONTHLY: { unit: 'month', count: months ?? 6, fmt: 'Mon' },
    YEARLY: { unit: 'year', count: 5, fmt: 'YYYY' },
  };
  const cfg = PERIODS[String(period || 'MONTHLY').toUpperCase()] ?? PERIODS.MONTHLY;
  const { rows } = await query(
    `WITH buckets AS (
       SELECT date_trunc($2, CURRENT_DATE) - (n || ' ' || $2)::interval AS m
       FROM generate_series($1 - 1, 0, -1) AS n
     )
     SELECT to_char(buckets.m, $3) AS label,
            COALESCE(SUM(o.total_amount), 0) AS total
     FROM buckets
     LEFT JOIN orders o
       ON date_trunc($2, o.order_date) = buckets.m AND o.status <> 'CANCELLED'
     GROUP BY buckets.m ORDER BY buckets.m`,
    [cfg.count, cfg.unit, cfg.fmt],
  );
  return rows.map((r) => ({ label: r.label.trim(), total: num(r.total) }));
}

// Shared WHERE builder for the Sales register (used by both the paginated list
// and the analytics aggregate so they always describe the same set of rows).
// Assumes the query aliases orders o, distributors d, farmers f.
function buildSalesFilter(a = {}) {
  const params = [];
  const cond = [];
  if (a.search) {
    params.push(a.search);
    const p = `$${params.length}`;
    cond.push(`(o.order_no ILIKE '%' || ${p} || '%' OR d.name ILIKE '%' || ${p} || '%' OR f.name ILIKE '%' || ${p} || '%')`);
  }
  if (a.billType && a.billType !== 'ALL') { params.push(a.billType); cond.push(`o.bill_type = $${params.length}`); }
  if (a.customerType && a.customerType !== 'ALL') { params.push(a.customerType); cond.push(`COALESCE(o.customer_type, 'DISTRIBUTOR') = $${params.length}`); }
  if (a.status && a.status !== 'ALL') { params.push(a.status); cond.push(`o.status = $${params.length}::order_status`); }
  if (a.dateFrom) { params.push(a.dateFrom); cond.push(`o.order_date >= $${params.length}::date`); }
  if (a.dateTo) { params.push(a.dateTo); cond.push(`o.order_date <= $${params.length}::date`); }
  return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', params };
}

export function orderResolvers() {
  return {
    Query: {
      orders: async (_p, { status, distributorId, billType, search, dateFrom, dateTo, limit, offset }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT o.* FROM orders o
           LEFT JOIN distributors d ON d.id = o.distributor_id
           LEFT JOIN farmers f ON f.id = o.farmer_id
           WHERE ($1::text IS NULL OR o.status = $1::order_status)
             AND ($2::uuid IS NULL OR o.distributor_id = $2)
             AND ($3::text IS NULL OR o.order_no ILIKE '%' || $3 || '%' OR d.name ILIKE '%' || $3 || '%' OR f.name ILIKE '%' || $3 || '%')
             AND ($4::date IS NULL OR o.order_date >= $4::date)
             AND ($5::date IS NULL OR o.order_date <= $5::date)
             AND ($6::text IS NULL OR o.bill_type = $6)
           ORDER BY o.created_at DESC LIMIT $7 OFFSET $8`,
          [status ?? null, distributorId ?? null, search ?? null, dateFrom ?? null, dateTo ?? null, billType ?? null, limit, offset],
        );
        return rows.map(mapOrder);
      },
      order: async (_p, { id }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query('SELECT * FROM orders WHERE id = $1', [id]);
        return mapOrder(rows[0]);
      },
      invoices: async (_p, { distributorId, limit, offset }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM invoices
           WHERE ($1::uuid IS NULL OR distributor_id = $1)
           ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [distributorId ?? null, limit, offset],
        );
        return rows.map(mapInvoice);
      },
      invoice: async (_p, { id }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query('SELECT * FROM invoices WHERE id = $1', [id]);
        return mapInvoice(rows[0]);
      },
      salesStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT
             COALESCE((SELECT SUM(total_amount) FROM orders WHERE status <> 'CANCELLED' AND order_date = CURRENT_DATE),0) AS sales_today,
             COALESCE((SELECT SUM(total_amount) FROM orders WHERE status <> 'CANCELLED' AND date_trunc('month', order_date) = date_trunc('month', CURRENT_DATE)),0) AS sales_mtd,
             (SELECT COUNT(*) FROM orders WHERE status IN ('PLACED','APPROVED','INVOICED','DISPATCHED'))::int AS orders_open,
             COALESCE((SELECT SUM(outstanding) FROM distributors),0) AS outstanding_total`,
        );
        return {
          salesToday: num(rows[0].sales_today),
          salesMtd: num(rows[0].sales_mtd),
          ordersOpen: rows[0].orders_open,
          outstandingTotal: num(rows[0].outstanding_total),
        };
      },
      salesTrend: async (_p, { months, period }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        return salesTrendRows(period, months);
      },
      orderStatusCounts: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query('SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status ORDER BY status');
        return rows.map((r) => ({ status: r.status, count: r.count }));
      },
      // Every period-scoped dashboard metric in one round-trip. The window is the
      // selected unit "to date" (this week / this month / this year), so the cards
      // update together the moment the filter changes.
      dashboardStats: async (_p, { period }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const unit = periodUnit(period);
        const [agg, statusRows, trend] = await Promise.all([
          query(
            `WITH win AS (SELECT date_trunc($1, CURRENT_DATE)::date AS start)
             SELECT
               COALESCE((SELECT SUM(total_amount) FROM orders, win WHERE status <> 'CANCELLED' AND order_date >= win.start), 0) AS sales,
               (SELECT COUNT(*) FROM orders, win WHERE status <> 'CANCELLED' AND order_date >= win.start)::int AS orders_count,
               COALESCE((SELECT SUM(total_amount) FROM purchase_invoices, win WHERE invoice_date >= win.start), 0) AS purchases,
               COALESCE((SELECT SUM(total_amount) FROM sales_returns, win WHERE status = 'APPROVED' AND return_date >= win.start), 0) AS sales_returns_value,
               COALESCE((SELECT SUM(total_amount) FROM purchase_returns, win WHERE status = 'APPROVED' AND return_date >= win.start), 0) AS purchase_returns_value,
               (SELECT COUNT(*) FROM farmers, win WHERE created_at >= win.start)::int AS new_farmers,
               (SELECT COUNT(*) FROM distributors, win WHERE created_at >= win.start)::int AS new_distributors,
               (SELECT COUNT(*) FROM crop_diagnoses, win WHERE created_at >= win.start)::int AS ai_sessions,
               (SELECT COUNT(*) FROM crm_leads, win WHERE created_at >= win.start)::int AS ai_leads,
               (SELECT COUNT(*) FROM crm_leads, win WHERE status = 'CONVERTED' AND created_at >= win.start)::int AS ai_converted,
               (SELECT COUNT(*) FROM complaints, win WHERE created_at >= win.start)::int AS complaints_opened`,
            [unit],
          ),
          query(
            `SELECT status, COUNT(*)::int AS count FROM orders
             WHERE order_date >= date_trunc($1, CURRENT_DATE) GROUP BY status ORDER BY status`,
            [unit],
          ),
          salesTrendRows(period),
        ]);
        const r = agg.rows[0];
        return {
          sales: num(r.sales),
          ordersCount: r.orders_count,
          purchases: num(r.purchases),
          salesReturnsValue: num(r.sales_returns_value),
          purchaseReturnsValue: num(r.purchase_returns_value),
          newFarmers: r.new_farmers,
          newDistributors: r.new_distributors,
          aiSessions: r.ai_sessions,
          aiLeads: r.ai_leads,
          aiConverted: r.ai_converted,
          complaintsOpened: r.complaints_opened,
          ordersByStatus: statusRows.rows.map((s) => ({ status: s.status, count: s.count })),
          trend,
        };
      },
      // Unified, paginated Sales register across distributor + farmer customers and
      // GST + non-GST bills. COUNT(*) OVER() returns the full filtered total in the
      // same round-trip so the UI can paginate without a second count query.
      salesTransactions: async (_p, args, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { where, params } = buildSalesFilter(args);
        // Cap is high enough to back a full "print register" export, not just a page.
        const limit = Math.min(Math.max(args.limit ?? 10, 1), 2000);
        const offset = Math.max(args.offset ?? 0, 0);
        const { rows } = await query(
          `SELECT o.id, o.order_no, COALESCE(o.customer_type, 'DISTRIBUTOR') AS customer_type,
                  o.bill_type, o.status, o.order_date, o.total_amount,
                  COALESCE(d.name, f.name, '—') AS customer_name,
                  COALESCE(i.amount_paid, 0) AS amount_paid,
                  i.id AS invoice_id,
                  (SELECT COUNT(*) FROM order_lines ol WHERE ol.order_id = o.id)::int AS item_count,
                  COUNT(*) OVER()::int AS total_count
           FROM orders o
           LEFT JOIN distributors d ON d.id = o.distributor_id
           LEFT JOIN farmers f ON f.id = o.farmer_id
           LEFT JOIN invoices i ON i.order_id = o.id
           ${where}
           ORDER BY o.order_date DESC, o.created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset],
        );
        return {
          total: rows[0] ? rows[0].total_count : 0,
          rows: rows.map((r) => ({
            id: r.id,
            orderNo: r.order_no,
            customerName: r.customer_name,
            customerType: r.customer_type,
            billType: r.bill_type,
            status: r.status,
            orderDate: isoDate(r.order_date),
            itemCount: r.item_count,
            totalAmount: num(r.total_amount),
            amountPaid: num(r.amount_paid),
            balanceDue: round2(num(r.total_amount) - num(r.amount_paid)),
            invoiceId: r.invoice_id ?? null,
          })),
        };
      },
      // Aggregate KPIs over the whole filtered register (money figures exclude cancelled).
      salesAnalytics: async (_p, args, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { where, params } = buildSalesFilter(args);
        const w = where ? `${where} AND o.status <> 'CANCELLED'` : `WHERE o.status <> 'CANCELLED'`;
        const { rows } = await query(
          `SELECT
             COALESCE(SUM(o.total_amount), 0) AS total_sales,
             COUNT(*)::int AS txn_count,
             COALESCE(SUM(o.total_amount) FILTER (WHERE o.bill_type = 'GST'), 0) AS gst_sales,
             COALESCE(SUM(o.total_amount) FILTER (WHERE o.bill_type = 'NON_GST'), 0) AS non_gst_sales,
             COALESCE(SUM(o.total_amount) FILTER (WHERE COALESCE(o.customer_type, 'DISTRIBUTOR') = 'DISTRIBUTOR'), 0) AS distributor_sales,
             COALESCE(SUM(o.total_amount) FILTER (WHERE o.customer_type = 'FARMER'), 0) AS farmer_sales,
             COALESCE(SUM(COALESCE(i.amount_paid, 0)), 0) AS collected,
             COALESCE(SUM(o.total_amount - COALESCE(i.amount_paid, 0)), 0) AS outstanding
           FROM orders o
           LEFT JOIN distributors d ON d.id = o.distributor_id
           LEFT JOIN farmers f ON f.id = o.farmer_id
           LEFT JOIN invoices i ON i.order_id = o.id
           ${w}`,
          params,
        );
        const r = rows[0];
        return {
          totalSales: num(r.total_sales),
          txnCount: r.txn_count,
          gstSales: num(r.gst_sales),
          nonGstSales: num(r.non_gst_sales),
          distributorSales: num(r.distributor_sales),
          farmerSales: num(r.farmer_sales),
          collected: num(r.collected),
          outstanding: num(r.outstanding),
        };
      },
    },

    Mutation: {
      createOrder: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        if (!input.lines?.length) throw httpError('Order must have at least one line', 400);
        const billType = input.billType === 'NON_GST' ? 'NON_GST' : 'GST';
        const customerType = input.customerType === 'FARMER' ? 'FARMER' : 'DISTRIBUTOR';
        const customerId = input.customerId ?? input.distributorId;
        if (!customerId) throw httpError('A customer (distributor or farmer) is required', 400);
        return withTransaction(async (client) => {
          const table = customerType === 'FARMER' ? 'farmers' : 'distributors';
          if (!(await client.query(`SELECT id FROM ${table} WHERE id = $1`, [customerId])).rows[0]) throw httpError(`${customerType === 'FARMER' ? 'Farmer' : 'Distributor'} not found`, 404);
          const distributorId = customerType === 'DISTRIBUTOR' ? customerId : null;
          const farmerId = customerType === 'FARMER' ? customerId : null;

          // Snapshot product data + compute line totals. Non-GST orders carry no tax.
          // Farmers (B2C) are billed at MRP/dealer price; distributors at the distributor price.
          let subTotal = 0;
          const lines = [];
          for (const l of input.lines) {
            const pr = await client.query('SELECT * FROM products WHERE id = $1', [l.productId]);
            const p = pr.rows[0];
            if (!p) throw httpError('Product not found', 404);
            const defaultPrice = customerType === 'FARMER'
              ? num(p.mrp ?? p.dealer_price ?? p.distributor_price ?? 0)
              : num(p.distributor_price ?? p.dealer_price ?? p.mrp ?? 0);
            const unitPrice = l.unitPrice ?? defaultPrice;
            const disc = l.discountPct ?? 0;
            const lineTotal = round2(l.quantity * unitPrice * (1 - disc / 100));
            const gst = billType === 'GST' ? num(p.gst_percent ?? 0) : 0;
            subTotal += lineTotal;
            lines.push({ p, l, unitPrice, disc, lineTotal, gst });
          }
          subTotal = round2(subTotal);
          // Bill-level discount (₹). Clamp to [0, subTotal]; spread proportionally so
          // per-line GST stays correct (tax is charged on the post-discount value).
          const discountTotal = round2(Math.min(Math.max(num(input.discountAmount) || 0, 0), subTotal));
          const factor = subTotal > 0 ? (subTotal - discountTotal) / subTotal : 1;
          let taxTotal = 0;
          for (const ln of lines) taxTotal += round2((ln.lineTotal * factor * ln.gst) / 100);
          taxTotal = round2(taxTotal);
          const total = round2(subTotal - discountTotal + taxTotal);

          const orderNo = `ORD-${financialYear(input.orderDate)}-${String(
            (await client.query("SELECT nextval('order_seq') AS n")).rows[0].n,
          ).padStart(5, '0')}`;

          // Transport & logistics (optional) — delivery address falls back to the legacy top-level field.
          const t = input.transport ?? {};
          const deliveryAddress = t.deliveryAddress ?? input.deliveryAddress ?? null;
          const ord = await client.query(
            `INSERT INTO orders (
               order_no, distributor_id, farmer_id, customer_type, farmer_ref, bill_type, status, order_date,
               sub_total, discount_total, tax_total, total_amount, notes, delivery_address, created_by,
               transport_name, transporter_id, vehicle_no, driver_name, driver_mobile, lr_number, lr_date,
               dispatch_date, delivery_location, eway_bill_no, num_packages, total_weight, freight_charges,
               freight_type, dispatch_through)
             VALUES ($1,$2,$3,$4,$5,$6,'PLACED',COALESCE($7,CURRENT_DATE),$8,$9,$10,$11,$12,$13,$14,
               $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING *`,
            [orderNo, distributorId, farmerId, customerType, input.farmerRef?.trim() || null, billType, input.orderDate ?? null, subTotal, discountTotal, taxTotal, total, input.notes ?? null, deliveryAddress, actor.sub,
             t.transportName ?? null, t.transporterId ?? null, t.vehicleNo ?? null, t.driverName ?? null, t.driverMobile ?? null, t.lrNumber ?? null, t.lrDate ?? null, t.dispatchDate ?? null, t.deliveryLocation ?? null, t.ewayBillNo ?? null, t.numPackages ?? null, t.totalWeight ?? null, t.freightCharges ?? null, t.freightType ?? null, t.dispatchThrough ?? null],
          );
          const orderId = ord.rows[0].id;

          // Loyalty referral: credit the referenced farmer with coins (₹100 = 1 coin).
          if (input.farmerRef?.trim()) {
            const fr = await client.query('SELECT id FROM farmers WHERE farmer_code = $1', [input.farmerRef.trim()]);
            if (fr.rows[0]) {
              const coins = Math.floor(total / 100);
              if (coins > 0) {
                await client.query('UPDATE farmers SET points_balance = points_balance + $2 WHERE id = $1', [fr.rows[0].id, coins]);
                await client.query(
                  "INSERT INTO loyalty_transactions (farmer_id, points, type, note, ref_order_id, created_by) VALUES ($1,$2,'EARN',$3,$4,$5)",
                  [fr.rows[0].id, coins, `Order ${orderNo}`, orderId, actor.sub],
                );
              }
            }
          }

          for (const { p, l, unitPrice, disc, lineTotal, gst } of lines) {
            await client.query(
              `INSERT INTO order_lines (order_id, product_id, product_name, hsn_code, uom, quantity, unit_price, discount_pct, gst_percent, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [orderId, p.id, p.name, p.hsn_code, p.uom, l.quantity, unitPrice, disc, gst, lineTotal],
            );
          }
          await logActivity(actor.sub, 'CREATE_ORDER', 'order', orderId, { orderNo });
          return mapOrder(ord.rows[0]);
        });
      },

      // Add or edit the transport & logistics block on an existing order. Used by
      // the order workspace (e.g. when filling dispatch details). Does not touch totals.
      updateOrderTransport: async (_p, { orderId, input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const t = input ?? {};
        const { rows } = await query(
          `UPDATE orders SET
             transport_name=$2, transporter_id=$3, vehicle_no=$4, driver_name=$5, driver_mobile=$6,
             lr_number=$7, lr_date=$8, dispatch_date=$9, delivery_location=$10,
             delivery_address=COALESCE($11, delivery_address), eway_bill_no=$12,
             num_packages=$13, total_weight=$14, freight_charges=$15, freight_type=$16,
             dispatch_through=$17, updated_at=now()
           WHERE id=$1 RETURNING *`,
          [orderId, t.transportName ?? null, t.transporterId ?? null, t.vehicleNo ?? null, t.driverName ?? null,
           t.driverMobile ?? null, t.lrNumber ?? null, t.lrDate ?? null, t.dispatchDate ?? null, t.deliveryLocation ?? null,
           t.deliveryAddress ?? null, t.ewayBillNo ?? null, t.numPackages ?? null, t.totalWeight ?? null,
           t.freightCharges ?? null, t.freightType ?? null, t.dispatchThrough ?? null],
        );
        if (!rows[0]) throw httpError('Order not found', 404);
        await logActivity(actor.sub, 'UPDATE_ORDER_TRANSPORT', 'order', orderId);
        return mapOrder(rows[0]);
      },

      approveOrder: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const ord = await query('SELECT * FROM orders WHERE id = $1', [id]);
        if (!ord.rows[0]) throw httpError('Order not found', 404);
        if (ord.rows[0].status !== 'PLACED') throw httpError('Only PLACED orders can be approved', 400);
        // Credit-limit check applies to distributors only; farmers are billed B2C (no credit line).
        if (ord.rows[0].customer_type !== 'FARMER' && ord.rows[0].distributor_id) {
          const dist = await query('SELECT * FROM distributors WHERE id = $1', [ord.rows[0].distributor_id]);
          const limit = num(dist.rows[0].credit_limit);
          const exposure = num(dist.rows[0].outstanding) + num(ord.rows[0].total_amount);
          if (limit > 0 && exposure > limit) {
            throw httpError(`Credit limit exceeded: exposure ₹${exposure} > limit ₹${limit}`, 400);
          }
        }
        const { rows } = await query(
          "UPDATE orders SET status='APPROVED', approved_by=$2, updated_at=now() WHERE id=$1 RETURNING *",
          [id, actor.sub],
        );
        await logActivity(actor.sub, 'APPROVE_ORDER', 'order', id);
        return mapOrder(rows[0]);
      },

      generateInvoice: async (_p, { orderId }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        return withTransaction(async (client) => {
          const ord = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
          const order = ord.rows[0];
          if (!order) throw httpError('Order not found', 404);
          if (!['APPROVED'].includes(order.status)) throw httpError('Order must be APPROVED to invoice', 400);
          // Bill type is fixed at order creation — the invoice inherits it.
          const type = order.bill_type === 'NON_GST' ? 'NON_GST' : 'GST';

          const existing = await client.query('SELECT id FROM invoices WHERE order_id = $1', [orderId]);
          if (existing.rows[0]) throw httpError('Invoice already exists for this order', 409);

          const company = (await client.query('SELECT * FROM company_settings WHERE id = 1')).rows[0];
          const isFarmer = order.customer_type === 'FARMER';
          const dist = order.distributor_id ? (await client.query('SELECT * FROM distributors WHERE id = $1', [order.distributor_id])).rows[0] : null;
          const buyerState = isFarmer ? (company?.state ?? null) : (dist?.state ?? null); // farmers billed B2C, treated intra-state
          const lines = (await client.query('SELECT * FROM order_lines WHERE order_id = $1', [orderId])).rows;

          // FIFO stock-out per product (negative-stock prevention).
          for (const ln of lines) {
            let need = num(ln.quantity);
            const stock = await client.query(
              `SELECT sl.* FROM stock_levels sl JOIN batches b ON b.id = sl.batch_id
               WHERE sl.product_id = $1 AND sl.quantity > 0
               ORDER BY b.expiry_date ASC NULLS LAST FOR UPDATE`,
              [ln.product_id],
            );
            const totalAvail = stock.rows.reduce((s, r) => s + num(r.quantity), 0);
            if (totalAvail < need) {
              throw httpError(`Insufficient stock for ${ln.product_name} (need ${need}, have ${totalAvail})`, 400);
            }
            for (const sl of stock.rows) {
              if (need <= 0) break;
              const take = Math.min(num(sl.quantity), need);
              await client.query('UPDATE stock_levels SET quantity = quantity - $2, updated_at = now() WHERE id = $1', [sl.id, take]);
              await client.query(
                `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, ref_id, created_by)
                 VALUES ($1,$2,$3,'OUT',$4,'Dispatch (invoice)','invoice',$5,$6)`,
                [sl.warehouse_id, ln.product_id, sl.batch_id, -take, orderId, actor.sub],
              );
              need -= take;
            }
          }

          // Taxable value is net of any bill-level discount recorded on the order.
          const taxable = round2(num(order.sub_total) - num(order.discount_total));
          let cgst = 0;
          let sgst = 0;
          let igst = 0;
          let total = taxable; // NON_GST: bill of supply, no tax charged
          let interstate = false;

          if (type === 'GST') {
            // GST split: intra-state -> CGST+SGST, inter-state -> IGST.
            interstate = Boolean(company?.state && buyerState && company.state.trim().toLowerCase() !== buyerState.trim().toLowerCase());
            const tax = num(order.tax_total);
            cgst = interstate ? 0 : round2(tax / 2);
            sgst = interstate ? 0 : round2(tax - cgst);
            igst = interstate ? tax : 0;
            total = num(order.total_amount);
          }

          const seq = (await client.query("SELECT nextval('invoice_seq') AS n")).rows[0].n;
          // Bills of supply carry a distinct series prefix.
          const prefix = type === 'NON_GST' ? 'BOS' : company?.invoice_prefix || 'INV';
          const invoiceNo = `${prefix}-${financialYear()}-${String(seq).padStart(5, '0')}`;

          const inv = await client.query(
            `INSERT INTO invoices
               (invoice_no, order_id, distributor_id, farmer_id, customer_type, bill_type, place_of_supply, is_interstate,
                taxable_value, cgst, sgst, igst, total_amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
            [invoiceNo, orderId, order.distributor_id, order.farmer_id, order.customer_type, type, buyerState, interstate, taxable, cgst, sgst, igst, total],
          );

          await client.query("UPDATE orders SET status='INVOICED', updated_at=now() WHERE id=$1", [orderId]);
          // Only distributors carry a running outstanding; farmer balances derive from their invoices/payments.
          if (!isFarmer && order.distributor_id) await client.query('UPDATE distributors SET outstanding = outstanding + $2 WHERE id = $1', [order.distributor_id, total]);
          await logActivity(actor.sub, 'GENERATE_INVOICE', 'invoice', inv.rows[0].id, { invoiceNo, billType: type });
          return mapInvoice(inv.rows[0]);
        });
      },

      recordPayment: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        if (input.amount <= 0) throw httpError('Amount must be positive', 400);
        return withTransaction(async (client) => {
          const inv = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [input.invoiceId]);
          if (!inv.rows[0]) throw httpError('Invoice not found', 404);
          await client.query('UPDATE invoices SET amount_paid = amount_paid + $2 WHERE id = $1', [input.invoiceId, input.amount]);
          if (inv.rows[0].distributor_id) await client.query('UPDATE distributors SET outstanding = GREATEST(outstanding - $2, 0) WHERE id = $1', [inv.rows[0].distributor_id, input.amount]);
          const pay = await client.query(
            `INSERT INTO payments (invoice_id, distributor_id, farmer_id, amount, method, reference, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [input.invoiceId, inv.rows[0].distributor_id, inv.rows[0].farmer_id, input.amount, input.method ?? null, input.reference ?? null, actor.sub],
          );
          await logActivity(actor.sub, 'RECORD_PAYMENT', 'payment', pay.rows[0].id);
          const r = pay.rows[0];
          return { id: r.id, amount: num(r.amount), method: r.method, reference: r.reference, paidAt: r.paid_at };
        });
      },

      updateOrderStatus: async (_p, { id, status }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const allowed = ['DISPATCHED', 'DELIVERED'];
        if (!allowed.includes(status)) throw httpError('Status must be DISPATCHED or DELIVERED', 400);
        const { rows } = await query(
          'UPDATE orders SET status = $2::order_status, updated_at = now() WHERE id = $1 RETURNING *',
          [id, status],
        );
        if (!rows[0]) throw httpError('Order not found', 404);
        await logActivity(actor.sub, 'ORDER_STATUS', 'order', id, { status });
        return mapOrder(rows[0]);
      },

      cancelOrder: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const ord = await query('SELECT status FROM orders WHERE id = $1', [id]);
        if (!ord.rows[0]) throw httpError('Order not found', 404);
        if (['INVOICED', 'DISPATCHED', 'DELIVERED'].includes(ord.rows[0].status))
          throw httpError('Cannot cancel an invoiced/dispatched order', 400);
        const { rows } = await query("UPDATE orders SET status='CANCELLED', updated_at=now() WHERE id=$1 RETURNING *", [id]);
        await logActivity(actor.sub, 'CANCEL_ORDER', 'order', id);
        return mapOrder(rows[0]);
      },
    },

    Order: {
      itemCount: async (parent) => {
        const { rows } = await query('SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id = $1', [parent.id]);
        return rows[0].n;
      },
      lines: async (parent) => {
        const { rows } = await query('SELECT * FROM order_lines WHERE order_id = $1 ORDER BY created_at', [parent.id]);
        return rows.map(mapLine);
      },
      distributor: async (parent) => {
        if (!parent.distributorId) return null;
        const { rows } = await query('SELECT * FROM distributors WHERE id = $1', [parent.distributorId]);
        return mapDistributor(rows[0]);
      },
      customer: (parent) => resolveCustomer(parent.customerType, parent.distributorId, parent.farmerId),
      customerName: async (parent) => (await resolveCustomer(parent.customerType, parent.distributorId, parent.farmerId))?.name ?? null,
      invoice: async (parent) => {
        const { rows } = await query('SELECT * FROM invoices WHERE order_id = $1', [parent.id]);
        return mapInvoice(rows[0]);
      },
    },

    Invoice: {
      order: async (parent) => {
        const { rows } = await query('SELECT * FROM orders WHERE id = $1', [parent.orderId]);
        return mapOrder(rows[0]);
      },
      // Transport block is inherited from the invoice's parent order.
      transport: async (parent) => {
        const { rows } = await query('SELECT * FROM orders WHERE id = $1', [parent.orderId]);
        return rows[0] ? mapTransport(rows[0]) : null;
      },
      distributor: async (parent) => {
        if (!parent.distributorId) return null;
        const { rows } = await query('SELECT * FROM distributors WHERE id = $1', [parent.distributorId]);
        return mapDistributor(rows[0]);
      },
      customer: (parent) => resolveCustomer(parent.customerType, parent.distributorId, parent.farmerId),
      customerName: async (parent) => (await resolveCustomer(parent.customerType, parent.distributorId, parent.farmerId))?.name ?? null,
      company: async () => {
        const { rows } = await query('SELECT * FROM company_settings WHERE id = 1');
        return mapCompany(rows[0]);
      },
    },
  };
}
