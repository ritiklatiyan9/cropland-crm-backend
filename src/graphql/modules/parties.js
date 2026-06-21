// GraphQL module: Parties — unified counterparties (distributors + farmers + vendors).
// Sell any product to anyone (direct party sale) and view a consolidated LEDGER
// that aggregates from the existing modules (invoices, payments, credit/debit
// notes, purchase bills, vendor payments, returns) + direct sales.

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';

export const partyTypeDefs = /* GraphQL */ `
  type Party {
    id: ID!
    partyType: String!          # DISTRIBUTOR / FARMER / VENDOR
    name: String!
    phone: String
    email: String
    gstin: String
    location: String
    balance: Float!
    balanceKind: String!        # RECEIVABLE (they owe us) / PAYABLE (we owe them)
    isActive: Boolean!
  }

  type PartyLedgerEntry {
    date: String!
    type: String!               # INVOICE / PAYMENT / CREDIT NOTE / DIRECT SALE / PURCHASE BILL / ...
    refNo: String
    description: String
    debit: Float!
    credit: Float!
    balance: Float!             # running balance after this entry
  }

  type PartyLedger {
    partyId: ID!
    partyType: String!
    name: String!
    balanceKind: String!
    currentBalance: Float!
    totalBilled: Float!         # total sold to / purchased from the party
    totalPaid: Float!
    totalReturns: Float!
    entryCount: Int!
    entries: [PartyLedgerEntry!]!
  }

  type PartiesStats { total: Int!, distributors: Int!, farmers: Int!, vendors: Int!, receivable: Float!, payable: Float! }

  # Filter-independent header KPIs for the Outstanding view — computed over the FULL
  # receivables set (every distributor/farmer with a positive balance) so the tiles,
  # split bar, tab counts and progress-bar scale stay stable while paging or searching.
  type OutstandingSummary {
    partiesWithDues: Int!
    distributorCount: Int!
    farmerCount: Int!
    distributorDue: Float!
    farmerDue: Float!
    maxBalance: Float!
  }

  # One page of outstanding receivables + pagination meta + the summary above.
  type OutstandingPage {
    data: [Party!]!
    currentPage: Int!
    totalPages: Int!
    totalRecords: Int!
    limit: Int!
    hasNextPage: Boolean!
    hasPrevPage: Boolean!
    summary: OutstandingSummary!
  }

  type PartySaleLine { id: ID!, productId: ID!, productName: String!, batchNumber: String, quantity: Float!, unitPrice: Float!, gstPercent: Float!, lineTotal: Float! }
  type PartySale {
    id: ID!
    saleNo: String!
    partyType: String!
    partyName: String
    warehouseName: String
    saleDate: String!
    subTotal: Float!
    taxTotal: Float!
    totalAmount: Float!
    amountPaid: Float!
    balanceDue: Float!
    paymentMethod: String
    notes: String
    itemCount: Int!
    lines: [PartySaleLine!]!
    createdAt: DateTime!
  }

  input PartySaleLineInput { productId: ID!, batchNumber: String, quantity: Float!, unitPrice: Float! }
  input CreatePartySaleInput {
    partyType: String!          # DISTRIBUTOR / FARMER
    partyId: ID!
    warehouseId: ID!
    amountPaid: Float = 0
    paymentMethod: String
    notes: String
    lines: [PartySaleLineInput!]!
  }

  extend type Query {
    parties(search: String, type: String, limit: Int = 200): [Party!]!
    "Server-side paginated Outstanding (receivables) list. type = DISTRIBUTOR | FARMER | null (all)."
    outstandingReceivables(page: Int = 1, limit: Int = 20, type: String, search: String): OutstandingPage!
    partyLedger(partyType: String!, partyId: ID!): PartyLedger!
    partiesStats: PartiesStats!
    partySales(limit: Int = 100): [PartySale!]!
    partySale(id: ID!): PartySale
  }

  extend type Mutation {
    createPartySale(input: CreatePartySaleInput!): PartySale!
  }
`;

const round2 = (n) => Math.round(n * 100) / 100;
function fy(d) {
  const dt = d ? new Date(d) : new Date();
  const start = dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const mapSale = (r) => r && {
  id: r.id, saleNo: r.sale_no, partyType: r.party_type, partyName: r.party_name ?? null, warehouseName: r.warehouse_name ?? null,
  saleDate: isoDate(r.sale_date), subTotal: num(r.sub_total), taxTotal: num(r.tax_total), totalAmount: num(r.total_amount),
  amountPaid: num(r.amount_paid), balanceDue: round2(num(r.total_amount) - num(r.amount_paid)), paymentMethod: r.payment_method,
  notes: r.notes, createdAt: r.created_at,
};
const SALE_SELECT = `SELECT s.*, w.name warehouse_name, COALESCE(d.name, f.name) party_name
  FROM party_sales s LEFT JOIN warehouses w ON w.id = s.warehouse_id
  LEFT JOIN distributors d ON d.id = s.distributor_id LEFT JOIN farmers f ON f.id = s.farmer_id`;

export function partyResolvers() {
  return {
    Query: {
      parties: async (_p, { search, type, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM (
             SELECT d.id::text id, 'DISTRIBUTOR' party_type, d.name, d.phone, d.email, d.gstin, d.state location,
               d.outstanding + COALESCE((SELECT SUM(total_amount-amount_paid) FROM party_sales WHERE distributor_id=d.id),0) balance,
               'RECEIVABLE' balance_kind, d.is_active
             FROM distributors d
             UNION ALL
             SELECT v.id::text, 'VENDOR', v.name, v.phone, v.email, v.gstin, COALESCE(v.city, v.state),
               v.outstanding, 'PAYABLE', v.is_active FROM vendors v
             UNION ALL
             SELECT f.id::text, 'FARMER', f.name, f.phone, f.email, NULL, COALESCE(f.village, f.district),
               COALESCE((SELECT SUM(total_amount-amount_paid) FROM party_sales WHERE farmer_id=f.id),0)
                 + COALESCE((SELECT SUM(total_amount-amount_paid) FROM invoices WHERE farmer_id=f.id),0), 'RECEIVABLE', true
             FROM farmers f
           ) p
           WHERE ($1::text IS NULL OR p.party_type = $1)
             AND ($2::text IS NULL OR p.name ILIKE '%'||$2||'%' OR p.phone ILIKE '%'||$2||'%' OR p.gstin ILIKE '%'||$2||'%')
           ORDER BY p.name LIMIT $3`,
          [type ?? null, search ?? null, limit],
        );
        return rows.map((r) => ({
          id: r.id, partyType: r.party_type, name: r.name, phone: r.phone, email: r.email, gstin: r.gstin,
          location: r.location, balance: num(r.balance) ?? 0, balanceKind: r.balance_kind, isActive: r.is_active ?? true,
        }));
      },

      partiesStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT (SELECT COUNT(*) FROM distributors)::int distributors,
                  (SELECT COUNT(*) FROM vendors)::int vendors,
                  (SELECT COUNT(*) FROM farmers)::int farmers,
                  COALESCE((SELECT SUM(outstanding) FROM distributors),0)
                    + COALESCE((SELECT SUM(total_amount-amount_paid) FROM party_sales),0)
                    + COALESCE((SELECT SUM(total_amount-amount_paid) FROM invoices WHERE customer_type='FARMER'),0) receivable,
                  COALESCE((SELECT SUM(outstanding) FROM vendors),0) payable`,
        );
        const r = rows[0];
        return { total: r.distributors + r.vendors + r.farmers, distributors: r.distributors, farmers: r.farmers, vendors: r.vendors, receivable: num(r.receivable), payable: num(r.payable) };
      },

      // Server-side paginated Outstanding view. Receivables = distributors + farmers
      // with a positive balance (vendors are PAYABLE, so excluded — also a perf win vs.
      // the full `parties` union). Returns the requested page slice (largest dues first),
      // pagination meta, and a filter-independent `summary` so the header tiles / split
      // bar / tab counts stay stable across pages and searches. The expensive per-party
      // balance subqueries run once: the `positive` CTE is materialised and reused for
      // counting, the summary, and the page slice — a single round-trip to the DB.
      outstandingReceivables: async (_p, args, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const type = ['DISTRIBUTOR', 'FARMER'].includes(args.type) ? args.type : null;
        const search = args.search?.trim() || null;
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
        const page = Math.max(args.page ?? 1, 1);
        const offset = (page - 1) * limit;

        const { rows } = await query(
          `WITH recv AS (
             SELECT d.id::text AS id, 'DISTRIBUTOR' AS party_type, d.name, d.phone, d.email, d.gstin, d.state AS location,
               d.outstanding + COALESCE((SELECT SUM(total_amount-amount_paid) FROM party_sales WHERE distributor_id=d.id),0) AS balance
             FROM distributors d
             UNION ALL
             SELECT f.id::text, 'FARMER', f.name, f.phone, f.email, NULL, COALESCE(f.village, f.district),
               COALESCE((SELECT SUM(total_amount-amount_paid) FROM party_sales WHERE farmer_id=f.id),0)
                 + COALESCE((SELECT SUM(total_amount-amount_paid) FROM invoices WHERE farmer_id=f.id),0)
             FROM farmers f
           ),
           positive AS (SELECT * FROM recv WHERE balance > 0),
           filtered AS (
             SELECT * FROM positive
             WHERE ($1::text IS NULL OR party_type = $1)
               AND ($2::text IS NULL OR name ILIKE '%'||$2||'%' OR phone ILIKE '%'||$2||'%')
           ),
           page_rows AS (SELECT * FROM filtered ORDER BY balance DESC, name LIMIT $3 OFFSET $4)
           SELECT
             (SELECT COUNT(*) FROM filtered)::int AS total_records,
             (SELECT row_to_json(s) FROM (
                SELECT COUNT(*)::int AS parties_with_dues,
                       COUNT(*) FILTER (WHERE party_type='DISTRIBUTOR')::int AS distributor_count,
                       COUNT(*) FILTER (WHERE party_type='FARMER')::int AS farmer_count,
                       COALESCE(SUM(balance) FILTER (WHERE party_type='DISTRIBUTOR'),0) AS distributor_due,
                       COALESCE(SUM(balance) FILTER (WHERE party_type='FARMER'),0) AS farmer_due,
                       COALESCE(MAX(balance),0) AS max_balance
                FROM positive
              ) s) AS summary,
             COALESCE((SELECT json_agg(p) FROM page_rows p), '[]'::json) AS data`,
          [type, search, limit, offset],
        );

        const r = rows[0];
        const sm = r.summary;
        const totalRecords = r.total_records;
        const totalPages = Math.max(1, Math.ceil(totalRecords / limit));
        return {
          data: (r.data ?? []).map((p) => ({
            id: p.id, partyType: p.party_type, name: p.name, phone: p.phone, email: p.email, gstin: p.gstin,
            location: p.location, balance: num(p.balance) ?? 0, balanceKind: 'RECEIVABLE', isActive: true,
          })),
          currentPage: page,
          totalPages,
          totalRecords,
          limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
          summary: {
            partiesWithDues: sm.parties_with_dues,
            distributorCount: sm.distributor_count,
            farmerCount: sm.farmer_count,
            distributorDue: num(sm.distributor_due),
            farmerDue: num(sm.farmer_due),
            maxBalance: num(sm.max_balance),
          },
        };
      },

      partyLedger: async (_p, { partyType, partyId }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const raw = []; // { date, type, refNo, description, debit, credit }
        let name = '';
        let balanceKind = 'RECEIVABLE';

        if (partyType === 'DISTRIBUTOR') {
          const d = (await query('SELECT name FROM distributors WHERE id=$1', [partyId])).rows[0];
          if (!d) throw httpError('Distributor not found', 404);
          name = d.name;
          (await query('SELECT invoice_no, invoice_date, total_amount FROM invoices WHERE distributor_id=$1', [partyId])).rows
            .forEach((r) => raw.push({ date: r.invoice_date, type: 'INVOICE', refNo: r.invoice_no, description: 'Tax invoice', debit: num(r.total_amount), credit: 0 }));
          (await query('SELECT amount, method, reference, paid_at FROM payments WHERE distributor_id=$1', [partyId])).rows
            .forEach((r) => raw.push({ date: r.paid_at, type: 'PAYMENT', refNo: r.reference || r.method, description: `Payment received${r.method ? ` (${r.method})` : ''}`, debit: 0, credit: num(r.amount) }));
          (await query('SELECT note_no, note_type, amount, reason, created_at FROM credit_debit_notes WHERE distributor_id=$1', [partyId])).rows
            .forEach((r) => raw.push({ date: r.created_at, type: r.note_type === 'CREDIT' ? 'CREDIT NOTE' : 'DEBIT NOTE', refNo: r.note_no, description: r.reason || (r.note_type === 'CREDIT' ? 'Credit note' : 'Debit note'), debit: r.note_type === 'CREDIT' ? 0 : num(r.amount), credit: r.note_type === 'CREDIT' ? num(r.amount) : 0 }));
          pushSales(raw, await query(`${SALE_SELECT} WHERE s.distributor_id=$1`, [partyId]));
        } else if (partyType === 'FARMER') {
          const f = (await query('SELECT name FROM farmers WHERE id=$1', [partyId])).rows[0];
          if (!f) throw httpError('Farmer not found', 404);
          name = f.name;
          (await query('SELECT invoice_no, invoice_date, total_amount FROM invoices WHERE farmer_id=$1', [partyId])).rows
            .forEach((r) => raw.push({ date: r.invoice_date, type: 'INVOICE', refNo: r.invoice_no, description: 'Tax invoice', debit: num(r.total_amount), credit: 0 }));
          (await query('SELECT amount, method, reference, paid_at FROM payments WHERE farmer_id=$1', [partyId])).rows
            .forEach((r) => raw.push({ date: r.paid_at, type: 'PAYMENT', refNo: r.reference || r.method, description: `Payment received${r.method ? ` (${r.method})` : ''}`, debit: 0, credit: num(r.amount) }));
          pushSales(raw, await query(`${SALE_SELECT} WHERE s.farmer_id=$1`, [partyId]));
        } else if (partyType === 'VENDOR') {
          balanceKind = 'PAYABLE';
          const v = (await query('SELECT name FROM vendors WHERE id=$1', [partyId])).rows[0];
          if (!v) throw httpError('Vendor not found', 404);
          name = v.name;
          (await query('SELECT internal_no, bill_no, invoice_date, total_amount FROM purchase_invoices WHERE vendor_id=$1', [partyId])).rows
            .forEach((r) => raw.push({ date: r.invoice_date, type: 'PURCHASE BILL', refNo: r.bill_no || r.internal_no, description: 'Vendor bill', debit: 0, credit: num(r.total_amount) }));
          (await query('SELECT amount, method, reference, paid_at FROM vendor_payments WHERE vendor_id=$1', [partyId])).rows
            .forEach((r) => raw.push({ date: r.paid_at, type: 'PAYMENT', refNo: r.reference || r.method, description: `Paid to vendor${r.method ? ` (${r.method})` : ''}`, debit: num(r.amount), credit: 0 }));
          (await query("SELECT return_no, debit_note_no, total_amount, approved_at FROM purchase_returns WHERE vendor_id=$1 AND status='APPROVED'", [partyId])).rows
            .forEach((r) => raw.push({ date: r.approved_at, type: 'PURCHASE RETURN', refNo: r.debit_note_no || r.return_no, description: 'Goods returned to vendor', debit: num(r.total_amount), credit: 0 }));
        } else {
          throw httpError('Invalid party type', 400);
        }

        raw.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        let bal = 0;
        const entries = raw.map((e) => {
          bal += balanceKind === 'PAYABLE' ? e.credit - e.debit : e.debit - e.credit;
          return { date: isoDate(e.date), type: e.type, refNo: e.refNo ?? null, description: e.description ?? null, debit: round2(e.debit), credit: round2(e.credit), balance: round2(bal) };
        });

        const sum = (pred, field) => round2(raw.filter(pred).reduce((s, e) => s + e[field], 0));
        const isReturn = (e) => e.type.includes('RETURN') || e.type === 'CREDIT NOTE';
        const isPayment = (e) => e.type === 'PAYMENT';
        return {
          partyId, partyType, name, balanceKind, currentBalance: round2(bal),
          totalBilled: balanceKind === 'PAYABLE' ? sum((e) => e.type === 'PURCHASE BILL', 'credit') : sum((e) => e.type === 'INVOICE' || e.type === 'DIRECT SALE', 'debit'),
          totalPaid: balanceKind === 'PAYABLE' ? sum(isPayment, 'debit') : sum((e) => isPayment(e) || e.type === 'SALE PAYMENT', 'credit'),
          totalReturns: sum(isReturn, balanceKind === 'PAYABLE' ? 'debit' : 'credit'),
          entryCount: entries.length, entries,
        };
      },

      partySales: async (_p, { limit }, ctx) => { assertAuth(ctx); const { rows } = await query(`${SALE_SELECT} ORDER BY s.created_at DESC LIMIT $1`, [limit]); return rows.map(mapSale); },
      partySale: async (_p, { id }, ctx) => { assertAuth(ctx); const { rows } = await query(`${SALE_SELECT} WHERE s.id=$1`, [id]); return mapSale(rows[0]); },
    },

    Mutation: {
      createPartySale: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        if (!input.lines?.length) throw httpError('A sale needs at least one line', 400);
        if (!['DISTRIBUTOR', 'FARMER'].includes(input.partyType)) throw httpError('partyType must be DISTRIBUTOR or FARMER', 400);
        return withTransaction(async (client) => {
          const table = input.partyType === 'DISTRIBUTOR' ? 'distributors' : 'farmers';
          if (!(await client.query(`SELECT id FROM ${table} WHERE id=$1`, [input.partyId])).rows[0]) throw httpError('Party not found', 404);
          if (!(await client.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouseId])).rows[0]) throw httpError('Warehouse not found', 404);

          let subTotal = 0, taxTotal = 0;
          const prepared = [];
          for (const l of input.lines) {
            const p = (await client.query('SELECT name, gst_percent FROM products WHERE id=$1', [l.productId])).rows[0];
            if (!p) throw httpError('Product not found', 404);
            const lineTotal = round2(l.quantity * l.unitPrice);
            const gst = num(p.gst_percent ?? 0);
            subTotal += lineTotal; taxTotal += round2(lineTotal * gst / 100);
            prepared.push({ l, name: p.name, gst, lineTotal });
          }
          subTotal = round2(subTotal); taxTotal = round2(taxTotal);
          const total = round2(subTotal + taxTotal);
          const paid = Math.min(round2(input.amountPaid ?? 0), total);

          // FIFO stock-out per line (prefer named batch, else by expiry) with negative-stock prevention.
          const saleNo = `PS-${fy()}-${String((await client.query("SELECT nextval('psale_seq') n")).rows[0].n).padStart(5, '0')}`;
          const sale = (await client.query(
            `INSERT INTO party_sales (sale_no, party_type, distributor_id, farmer_id, warehouse_id, sub_total, tax_total, total_amount, amount_paid, payment_method, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [saleNo, input.partyType, input.partyType === 'DISTRIBUTOR' ? input.partyId : null, input.partyType === 'FARMER' ? input.partyId : null,
              input.warehouseId, subTotal, taxTotal, total, paid, input.paymentMethod ?? null, input.notes ?? null, a.sub],
          )).rows[0];

          for (const { l, name, gst, lineTotal } of prepared) {
            let remaining = l.quantity;
            const stock = (await client.query(
              `SELECT sl.*, b.batch_number FROM stock_levels sl JOIN batches b ON b.id = sl.batch_id
               WHERE sl.product_id=$1 AND sl.warehouse_id=$2 AND sl.quantity>0
               ORDER BY (b.batch_number = $3) DESC, b.expiry_date ASC NULLS LAST FOR UPDATE`,
              [l.productId, input.warehouseId, l.batchNumber ?? ''],
            )).rows;
            const avail = stock.reduce((s, r) => s + num(r.quantity), 0);
            if (avail < remaining) throw httpError(`Insufficient stock for ${name}: need ${remaining}, have ${avail}`, 400);
            for (const sl of stock) {
              if (remaining <= 0) break;
              const take = Math.min(num(sl.quantity), remaining);
              await client.query('UPDATE stock_levels SET quantity = quantity - $2, updated_at=now() WHERE id=$1', [sl.id, take]);
              await client.query(
                `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, ref_id, created_by)
                 VALUES ($1,$2,$3,'OUT',$4,'Direct party sale','party_sale',$5,$6)`,
                [input.warehouseId, l.productId, sl.batch_id, -take, sale.id, a.sub],
              );
              remaining -= take;
            }
            await client.query(
              `INSERT INTO party_sale_lines (sale_id, product_id, product_name, batch_number, quantity, unit_price, gst_percent, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [sale.id, l.productId, name, l.batchNumber ?? null, l.quantity, l.unitPrice, gst, lineTotal],
            );
          }
          // Auto-generate a CRM lead when a farmer buys — a fresh upsell/follow-up
          // opportunity. Skip if the farmer already has an open lead, so the
          // pipeline doesn't flood with one lead per purchase.
          if (input.partyType === 'FARMER') {
            const hasOpen = (await client.query(
              "SELECT 1 FROM crm_leads WHERE farmer_id=$1 AND status IN ('NEW','CONTACTED') LIMIT 1",
              [input.partyId],
            )).rows[0];
            if (!hasOpen) {
              const crops = (await client.query('SELECT crops FROM farmers WHERE id=$1', [input.partyId])).rows[0]?.crops ?? [];
              const leadNo = `LEAD-${String((await client.query("SELECT nextval('lead_seq') n")).rows[0].n).padStart(5, '0')}`;
              await client.query(
                `INSERT INTO crm_leads (lead_no, farmer_id, crop, disease, product_ids, prior_purchase, notes)
                 VALUES ($1,$2,$3,NULL,$4,TRUE,$5)`,
                [leadNo, input.partyId, crops[0] ?? null, prepared.map((p) => p.l.productId), `Auto-created from direct sale ${saleNo}`],
              );
            }
          }
          await logActivity(a.sub, 'CREATE_PARTY_SALE', 'party_sale', sale.id, { saleNo, party: input.partyType });
          return mapSale((await client.query(`${SALE_SELECT} WHERE s.id=$1`, [sale.id])).rows[0]);
        });
      },
    },

    PartySale: {
      itemCount: async (parent) => (await query('SELECT COUNT(*)::int n FROM party_sale_lines WHERE sale_id=$1', [parent.id])).rows[0].n,
      lines: async (parent) => {
        const { rows } = await query('SELECT * FROM party_sale_lines WHERE sale_id=$1 ORDER BY product_name', [parent.id]);
        return rows.map((r) => ({ id: r.id, productId: r.product_id, productName: r.product_name, batchNumber: r.batch_number, quantity: num(r.quantity), unitPrice: num(r.unit_price), gstPercent: num(r.gst_percent), lineTotal: num(r.line_total) }));
      },
    },
  };
}

// Push a party_sales result set into the ledger as a DIRECT SALE (debit) + optional SALE PAYMENT (credit).
function pushSales(raw, res) {
  for (const r of res.rows) {
    raw.push({ date: r.sale_date, type: 'DIRECT SALE', refNo: r.sale_no, description: 'Direct sale', debit: num(r.total_amount), credit: 0 });
    if (num(r.amount_paid) > 0) raw.push({ date: r.sale_date, type: 'SALE PAYMENT', refNo: r.sale_no, description: `Paid at sale${r.payment_method ? ` (${r.payment_method})` : ''}`, debit: 0, credit: num(r.amount_paid) });
  }
}
