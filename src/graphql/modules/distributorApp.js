// GraphQL module: Distributor App backend.
// Distributor authentication (Google sign-in only — gated to admin-created
// distributor emails) and distributor-scoped data: profile, products, weather,
// GST bills (invoices), AI crop-doctor diagnoses, and farmer coin redemption.
// Reuses the same `distributors` table the admin panel manages, so an
// admin-created distributor and an app login are one and the same record.

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { getWeather, weatherConfigured } from '../../services/weather/index.js';
import { diagnoseCrop } from '../../services/ai/index.js';
import { isAwsConfigured, getDownloadUrl } from '../../utils/aws.js';
import { env } from '../../config/env.js';

// Resolve a stored S3 key (or pass-through URL) to a viewable URL.
async function imgUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//.test(value) || value.startsWith('data:')) return value;
  if (env.aws.s3PublicBaseUrl) return `${env.aws.s3PublicBaseUrl.replace(/\/$/, '')}/${value}`;
  if (isAwsConfigured) { try { return await getDownloadUrl(value, 3600); } catch { return null; } }
  return null;
}

export const distributorAppTypeDefs = /* GraphQL */ `
  type DistributorProfile {
    id: ID!
    name: String!
    contactPerson: String
    phone: String
    email: String
    gstin: String
    dealerTier: String
    state: String
    district: String
    address: String
    creditLimit: Float!
    outstanding: Float!
    creditAvailable: Float!
    language: String
    photoUrl: String
    authProvider: String!
  }
  type DistributorAuthPayload { token: String!, distributor: DistributorProfile! }

  type DistInvoiceLine { productName: String!, quantity: Float!, unitPrice: Float!, lineTotal: Float!, uom: String }
  type DistInvoice {
    id: ID!
    invoiceNo: String!
    billType: String!          # GST (tax invoice) / NON_GST (bill of supply)
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
    status: String!
    items: [DistInvoiceLine!]!
  }
  type DistInvoiceStats { totalBilled: Float!, totalPaid: Float!, outstanding: Float!, count: Int! }

  # Farmer lookup before honoring a coin redemption (shows balance + name).
  type DistFarmerLookup { id: ID!, farmerCode: String!, name: String!, village: String, phone: String, pointsBalance: Int! }

  # A bill the distributor raised to a farmer/buyer (their own resale).
  type DistSaleLine { productName: String!, quantity: Float!, unitPrice: Float!, gstPercent: Float!, lineTotal: Float! }
  type DistSale {
    id: ID!
    billNo: String!
    buyerName: String!
    buyerPhone: String
    farmerCode: String
    billType: String!
    saleDate: String!
    subTotal: Float!
    taxTotal: Float!
    totalAmount: Float!
    amountPaid: Float!
    balanceDue: Float!
    paymentMethod: String
    notes: String
    items: [DistSaleLine!]!
    createdAt: DateTime!
    distributorId: ID       # populated for admin listings
    distributorName: String # populated for admin listings
  }
  type DistSaleStats { totalSold: Float!, totalPaid: Float!, outstanding: Float!, count: Int! }

  # A farmer this distributor deals with (registered by them or billed by them).
  type DistFarmer {
    id: ID!
    farmerCode: String!
    name: String!
    phone: String
    village: String
    district: String
    crops: [String!]!
    pointsBalance: Int!
    billCount: Int!
    totalBilled: Float!
    totalPaid: Float!
    balanceDue: Float!
    lastSaleDate: String
  }

  extend type AppProduct { gstPercent: Float }

  input DistSaleLineInput { productId: ID, productName: String, quantity: Float!, unitPrice: Float!, gstPercent: Float }
  input DistCreateSaleInput {
    farmerCode: String        # optional — bill an existing (admin-created) farmer
    buyerName: String         # required when no farmerCode (walk-in buyer)
    buyerPhone: String
    billType: String = "GST"  # GST / NON_GST
    amountPaid: Float = 0
    paymentMethod: String
    notes: String
    lines: [DistSaleLineInput!]!
  }

  extend type Query {
    meDistributor: DistributorProfile
    distProducts(search: String, limit: Int = 100): [AppProduct!]!
    distWeather(lat: Float, lng: Float): Weather!
    distInvoices: [DistInvoice!]!
    distInvoiceStats: DistInvoiceStats!
    distDiagnoses: [AppDiagnosis!]!
    distFarmerLookup(farmerCode: String!): DistFarmerLookup!
    distSales(search: String): [DistSale!]!
    distSaleStats: DistSaleStats!
    distFarmers: [DistFarmer!]!
    # Admin panel: bills created by distributors in the Distributor App.
    adminDistributorSales(distributorId: ID, billType: String, search: String, dateFrom: String, dateTo: String, limit: Int = 200): [DistSale!]!
  }

  extend type Mutation {
    distributorGoogleAuth(idToken: String!): DistributorAuthPayload!
    updateMyDistributorProfile(language: String): DistributorProfile!
    registerMyDistributorDevice(fcmToken: String!): Boolean!
    distRunDiagnosis(crop: String!, imageUrl: String): AppDiagnosis!
    distCreateSale(input: DistCreateSaleInput!): DistSale!
    # Collect the remaining balance (or part of it) on a bill the distributor raised.
    distRecordSalePayment(saleId: ID!, amount: Float!): DistSale!
  }
`;

const round2 = (n) => Math.round(n * 100) / 100;

const mapSale = (r) => r && {
  id: r.id, billNo: r.bill_no, buyerName: r.buyer_name, buyerPhone: r.buyer_phone, farmerCode: r.farmer_code ?? null,
  billType: r.bill_type ?? 'GST', saleDate: isoDate(r.sale_date), subTotal: num(r.sub_total) ?? 0, taxTotal: num(r.tax_total) ?? 0,
  totalAmount: num(r.total_amount) ?? 0, amountPaid: num(r.amount_paid) ?? 0,
  balanceDue: round2((num(r.total_amount) ?? 0) - (num(r.amount_paid) ?? 0)),
  paymentMethod: r.payment_method, notes: r.notes, createdAt: r.created_at,
  distributorId: r.distributor_id ?? null, distributorName: r.distributor_name ?? null,
};

const mapProfile = (r) => r && {
  id: r.id, name: r.name, contactPerson: r.contact_person, phone: r.phone, email: r.email,
  gstin: r.gstin, dealerTier: r.dealer_tier, state: r.state, district: r.district, address: r.address,
  creditLimit: num(r.credit_limit) ?? 0, outstanding: num(r.outstanding) ?? 0,
  creditAvailable: (num(r.credit_limit) ?? 0) - (num(r.outstanding) ?? 0),
  language: r.language, photoKey: r.photo_url, authProvider: r.auth_provider ?? 'ADMIN',
};

// Resolve the authenticated distributor's id from a DISTRIBUTOR-kind JWT.
function distributorId(ctx) {
  const u = assertAuth(ctx);
  if (u.kind !== 'DISTRIBUTOR') throw httpError('Distributor authentication required', 403);
  return u.sub;
}

async function productNames(ids) {
  if (!ids?.length) return [];
  const { rows } = await query('SELECT name FROM products WHERE id = ANY($1)', [ids]);
  return rows.map((r) => r.name);
}

// Best-effort product match for a diagnosis: trained class → catalog targets → recent.
async function matchProducts(crop, disease) {
  const trained = (await query(
    `SELECT product_ids FROM ai_training_classes WHERE is_active AND crop ILIKE $1 AND disease ILIKE '%'||$2||'%' LIMIT 1`,
    [crop, disease ?? ''],
  )).rows[0];
  if (trained?.product_ids?.length) return trained.product_ids;
  const tgt = (await query(
    `SELECT id FROM products WHERE is_active AND (
       EXISTS (SELECT 1 FROM unnest(target_crops) tc WHERE tc ILIKE $1)
       OR EXISTS (SELECT 1 FROM unnest(target_diseases) td WHERE $2 ILIKE '%'||td||'%' OR td ILIKE '%'||$2||'%')
     ) LIMIT 3`,
    [crop, disease ?? ''],
  )).rows;
  if (tgt.length) return tgt.map((r) => r.id);
  return (await query('SELECT id FROM products WHERE is_active ORDER BY created_at DESC LIMIT 3')).rows.map((r) => r.id);
}

export function distributorAppResolvers(app) {
  // Mobile apps need long-lived tokens; 30-day expiry replaces the default 15-min window.
  const sign = (d) => app.jwt.sign({ sub: d.id, kind: 'DISTRIBUTOR', role: 'DISTRIBUTOR' }, { expiresIn: '30d' });
  const authPayload = (d) => ({ token: sign(d), distributor: mapProfile(d) });

  return {
    Query: {
      meDistributor: async (_p, _a, ctx) => {
        const id = distributorId(ctx);
        const { rows } = await query('SELECT * FROM distributors WHERE id = $1', [id]);
        return mapProfile(rows[0]);
      },

      distProducts: async (_p, { search, limit }, ctx) => {
        distributorId(ctx);
        const { rows } = await query(
          `SELECT * FROM products WHERE is_active AND ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR technical_name ILIKE '%'||$1||'%')
           ORDER BY name LIMIT $2`,
          [search ?? null, limit],
        );
        return rows.map((r) => ({
          id: r.id, name: r.name, category: r.category, technicalName: r.technical_name, uom: r.uom, packingSize: r.packing_size,
          mrp: num(r.mrp), imageKey: r.image_key, recommendedDosage: r.recommended_dosage, applicationFrequency: r.application_frequency,
          targetCrops: r.target_crops ?? [], targetDiseases: r.target_diseases ?? [], gstPercent: num(r.gst_percent),
        }));
      },

      distWeather: async (_p, { lat, lng }, ctx) => {
        const id = distributorId(ctx);
        const d = (await query('SELECT district, state, gps_lat, gps_lng, language FROM distributors WHERE id = $1', [id])).rows[0];
        if (!d) throw httpError('Distributor not found', 404);
        // Prefer the device's live coordinates (and remember them); else stored GPS; else region name.
        let la = lat, ln = lng;
        if (la != null && ln != null) {
          await query('UPDATE distributors SET gps_lat=$2, gps_lng=$3 WHERE id=$1', [id, la, ln]);
        } else {
          la = num(d.gps_lat); ln = num(d.gps_lng);
        }
        const lang = d.language === 'hi' ? 'hi' : undefined;
        const w = la != null && ln != null
          ? await getWeather({ lat: la, lon: ln, lang })
          : await getWeather({ city: [d.district, d.state].filter(Boolean).join(', ') || 'India', lang });
        return { ...w, configured: weatherConfigured };
      },

      // GST bills raised TO this distributor (admin Order-to-Cash invoices), with
      // line items, tax split (CGST/SGST/IGST) and e-doc references.
      distInvoices: async (_p, _a, ctx) => {
        const id = distributorId(ctx);
        const round2 = (n) => Math.round(n * 100) / 100;
        const { rows } = await query(
          'SELECT * FROM invoices WHERE distributor_id = $1 ORDER BY created_at DESC',
          [id],
        );
        return Promise.all(rows.map(async (inv) => {
          const lines = (await query('SELECT product_name, quantity, unit_price, line_total, uom FROM order_lines WHERE order_id = $1', [inv.order_id])).rows;
          const total = num(inv.total_amount) ?? 0, paid = num(inv.amount_paid) ?? 0;
          return {
            id: inv.id, invoiceNo: inv.invoice_no, billType: inv.bill_type ?? 'GST', invoiceDate: isoDate(inv.invoice_date),
            placeOfSupply: inv.place_of_supply, isInterstate: inv.is_interstate ?? false,
            taxableValue: num(inv.taxable_value) ?? 0, cgst: num(inv.cgst) ?? 0, sgst: num(inv.sgst) ?? 0, igst: num(inv.igst) ?? 0,
            totalAmount: total, amountPaid: paid, balanceDue: round2(total - paid),
            irn: inv.irn, ewayBillNo: inv.eway_bill_no, status: inv.status ?? 'ISSUED',
            items: lines.map((l) => ({ productName: l.product_name, quantity: num(l.quantity), unitPrice: num(l.unit_price), lineTotal: num(l.line_total), uom: l.uom ?? null })),
          };
        }));
      },

      distInvoiceStats: async (_p, _a, ctx) => {
        const id = distributorId(ctx);
        const { rows } = await query(
          `SELECT COALESCE(SUM(total_amount),0) total_billed, COALESCE(SUM(amount_paid),0) total_paid, COUNT(*)::int count
           FROM invoices WHERE distributor_id = $1`,
          [id],
        );
        const billed = num(rows[0].total_billed) ?? 0, paid = num(rows[0].total_paid) ?? 0;
        return { totalBilled: billed, totalPaid: paid, outstanding: Math.round((billed - paid) * 100) / 100, count: rows[0].count };
      },

      distDiagnoses: async (_p, _a, ctx) => {
        const id = distributorId(ctx);
        const { rows } = await query('SELECT * FROM crop_diagnoses WHERE distributor_id = $1 ORDER BY created_at DESC LIMIT 50', [id]);
        return Promise.all(rows.map(async (r) => ({
          id: r.id, sessionNo: r.session_no, crop: r.crop, detectedDisease: r.detected_disease, pathogen: r.pathogen,
          confidence: num(r.confidence), severity: r.severity, symptoms: r.symptoms, recommendation: r.recommendation,
          source: r.source, products: await productNames(r.product_ids), imageUrl: r.image_url, createdAt: r.created_at,
        })));
      },

      distFarmerLookup: async (_p, { farmerCode }, ctx) => {
        distributorId(ctx);
        const { rows } = await query('SELECT id, farmer_code, name, village, phone, points_balance FROM farmers WHERE farmer_code = $1', [farmerCode.trim()]);
        const f = rows[0];
        if (!f) throw httpError('No farmer with that reference code', 404);
        return { id: f.id, farmerCode: f.farmer_code, name: f.name, village: f.village, phone: f.phone, pointsBalance: f.points_balance ?? 0 };
      },

      // Bills the distributor has raised to farmers/buyers, newest first (optional search).
      distSales: async (_p, { search }, ctx) => {
        const id = distributorId(ctx);
        const { rows } = await query(
          `SELECT s.*, f.farmer_code FROM distributor_sales s LEFT JOIN farmers f ON f.id = s.farmer_id
           WHERE s.distributor_id = $1
             AND ($2::text IS NULL OR s.bill_no ILIKE '%'||$2||'%' OR s.buyer_name ILIKE '%'||$2||'%' OR s.buyer_phone ILIKE '%'||$2||'%')
           ORDER BY s.created_at DESC`,
          [id, search && search.trim() ? search.trim() : null],
        );
        return rows.map(mapSale);
      },

      distSaleStats: async (_p, _a, ctx) => {
        const id = distributorId(ctx);
        const { rows } = await query(
          `SELECT COALESCE(SUM(total_amount),0) total_sold, COALESCE(SUM(amount_paid),0) total_paid, COUNT(*)::int count
           FROM distributor_sales WHERE distributor_id = $1`,
          [id],
        );
        const sold = num(rows[0].total_sold) ?? 0, paid = num(rows[0].total_paid) ?? 0;
        return { totalSold: sold, totalPaid: paid, outstanding: Math.round((sold - paid) * 100) / 100, count: rows[0].count };
      },

      // Farmers this distributor deals with — registered by them or billed by them —
      // with a per-farmer billing summary for the app's "Farmers" tab.
      distFarmers: async (_p, _a, ctx) => {
        const id = distributorId(ctx);
        const { rows } = await query(
          `SELECT f.id, f.farmer_code, f.name, f.phone, f.village, f.district, f.crops, f.points_balance,
                  COALESCE(s.bill_count,0)::int bill_count, COALESCE(s.total_billed,0) total_billed,
                  COALESCE(s.total_paid,0) total_paid, s.last_sale_date
           FROM farmers f
           LEFT JOIN (
             SELECT farmer_id, COUNT(*) bill_count, SUM(total_amount) total_billed, SUM(amount_paid) total_paid, MAX(sale_date) last_sale_date
             FROM distributor_sales WHERE distributor_id = $1 AND farmer_id IS NOT NULL GROUP BY farmer_id
           ) s ON s.farmer_id = f.id
           WHERE f.registered_by = $1 OR s.farmer_id IS NOT NULL
           ORDER BY (s.last_sale_date IS NULL), s.last_sale_date DESC NULLS LAST, f.name`,
          [id],
        );
        return rows.map((r) => {
          const billed = num(r.total_billed) ?? 0, paid = num(r.total_paid) ?? 0;
          return {
            id: r.id, farmerCode: r.farmer_code, name: r.name, phone: r.phone, village: r.village, district: r.district,
            crops: r.crops ?? [], pointsBalance: r.points_balance ?? 0, billCount: r.bill_count,
            totalBilled: billed, totalPaid: paid, balanceDue: round2(billed - paid),
            lastSaleDate: r.last_sale_date ? isoDate(r.last_sale_date) : null,
          };
        });
      },

      // Admin: all distributor-app bills (optionally filtered by distributor / bill type / search / date).
      adminDistributorSales: async (_p, { distributorId: did, billType, search, dateFrom, dateTo, limit }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT s.*, f.farmer_code, d.name distributor_name
           FROM distributor_sales s
           LEFT JOIN farmers f ON f.id = s.farmer_id
           JOIN distributors d ON d.id = s.distributor_id
           WHERE ($1::uuid IS NULL OR s.distributor_id = $1)
             AND ($2::text IS NULL OR s.bill_no ILIKE '%'||$2||'%' OR s.buyer_name ILIKE '%'||$2||'%' OR d.name ILIKE '%'||$2||'%')
             AND ($3::text IS NULL OR s.bill_type = $3)
             AND ($4::date IS NULL OR s.sale_date >= $4::date)
             AND ($5::date IS NULL OR s.sale_date <= $5::date)
           ORDER BY s.created_at DESC LIMIT $6`,
          [did ?? null, search && search.trim() ? search.trim() : null, billType ?? null, dateFrom ?? null, dateTo ?? null, limit],
        );
        return rows.map(mapSale);
      },
    },

    Mutation: {
      // Google sign-in gated to admin-created distributors: the Google email must
      // already exist on an ACTIVE distributor row. No self-signup — anyone else is rejected.
      distributorGoogleAuth: async (_p, { idToken }, _ctx) => {
        const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
        if (!res.ok) throw httpError('Invalid Google token', 401);
        const info = await res.json();
        const wantAud = process.env.GOOGLE_CLIENT_ID;
        if (wantAud && info.aud !== wantAud) throw httpError('Google token audience mismatch', 401);
        const email = (info.email || '').toLowerCase();
        if (!email) throw httpError('Google account has no email', 400);

        const d = (await query('SELECT * FROM distributors WHERE lower(email) = $1', [email])).rows[0];
        if (!d) throw httpError('No distributor account is registered for this Google email. Please contact the administrator.', 403);
        if (!d.is_active) throw httpError('This distributor account is inactive. Please contact the administrator.', 403);

        const { rows } = await query(
          "UPDATE distributors SET google_id = COALESCE(google_id,$2), auth_provider = CASE WHEN auth_provider='ADMIN' THEN 'GOOGLE' ELSE auth_provider END, photo_url = COALESCE(photo_url,$3), updated_at = now() WHERE id = $1 RETURNING *",
          [d.id, info.sub, info.picture ?? null],
        );
        await logActivity(null, 'DISTRIBUTOR_LOGIN', 'distributor', d.id, { via: 'GOOGLE' });
        return authPayload(rows[0]);
      },

      updateMyDistributorProfile: async (_p, { language }, ctx) => {
        const id = distributorId(ctx);
        const { rows } = await query(
          'UPDATE distributors SET language = COALESCE($2, language), updated_at = now() WHERE id = $1 RETURNING *',
          [id, language ?? null],
        );
        return mapProfile(rows[0]);
      },

      registerMyDistributorDevice: async (_p, { fcmToken }, ctx) => {
        const id = distributorId(ctx);
        await query('UPDATE distributors SET fcm_token = $2 WHERE id = $1', [id, fcmToken]);
        return true;
      },

      distRunDiagnosis: async (_p, { crop, imageUrl }, ctx) => {
        const id = distributorId(ctx);
        const lang = (await query('SELECT language FROM distributors WHERE id=$1', [id])).rows[0]?.language;
        // Few-shot grounding from Train AI Doctor (reuse trained reference photos for this crop).
        const refs = (await query(
          `SELECT s.image_url AS "imageUrl", s.caption, c.disease, c.pathogen
           FROM ai_training_samples s JOIN ai_training_classes c ON c.id = s.class_id
           WHERE c.is_active AND c.crop ILIKE $1 ORDER BY c.created_at DESC LIMIT 6`,
          [crop],
        )).rows;
        const dg = await diagnoseCrop({ crop, imageUrl, references: refs, lang });
        const productIds = await matchProducts(crop, dg.disease);
        const sessionNo = `CD-${String((await query("SELECT nextval('diag_seq') n")).rows[0].n).padStart(5, '0')}`;
        const { rows } = await query(
          `INSERT INTO crop_diagnoses (session_no, distributor_id, crop, image_url, detected_disease, pathogen, confidence, severity, symptoms, recommendation, product_ids, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [sessionNo, id, crop, imageUrl ?? null, dg.disease, dg.pathogen, dg.confidence, dg.severity, dg.symptoms, dg.recommendation, productIds, dg.source],
        );
        await logActivity(null, 'CROP_DIAGNOSIS', 'crop_diagnosis', rows[0].id, { crop, via: 'distributor-app' });
        const r = rows[0];
        return {
          id: r.id, sessionNo: r.session_no, crop: r.crop, detectedDisease: r.detected_disease, pathogen: r.pathogen,
          confidence: num(r.confidence), severity: r.severity, symptoms: r.symptoms, recommendation: r.recommendation,
          source: r.source, products: await productNames(productIds), imageUrl: r.image_url, createdAt: r.created_at,
        };
      },

      // The distributor raises a GST bill (or bill of supply) to a farmer/buyer.
      // GST per line comes from the product's gst_percent; NON_GST zeroes tax.
      distCreateSale: async (_p, { input }, ctx) => {
        const id = distributorId(ctx);
        if (!input.lines?.length) throw httpError('A bill needs at least one item', 400);
        const billType = input.billType === 'NON_GST' ? 'NON_GST' : 'GST';

        // Resolve the buyer: a known farmer (by code) or a walk-in name/phone.
        let farmerId = null, buyerName = (input.buyerName ?? '').trim(), buyerPhone = (input.buyerPhone ?? '').trim() || null;
        if (input.farmerCode && input.farmerCode.trim()) {
          const f = (await query('SELECT id, name, phone FROM farmers WHERE farmer_code = $1', [input.farmerCode.trim()])).rows[0];
          if (!f) throw httpError('No farmer with that reference code', 404);
          farmerId = f.id; buyerName = f.name; buyerPhone = f.phone ?? buyerPhone;
        }
        if (!buyerName) throw httpError('Enter the buyer name (or a valid farmer code)', 400);

        // Price each line; pull GST% from the product unless the client overrode it.
        let subTotal = 0, taxTotal = 0;
        const prepared = [];
        for (const l of input.lines) {
          if (!(l.quantity > 0)) throw httpError('Each item needs a quantity greater than 0', 400);
          if (num(l.unitPrice) < 0) throw httpError('Unit price cannot be negative', 400);
          if (l.gstPercent != null && (num(l.gstPercent) < 0 || num(l.gstPercent) > 100)) throw httpError('GST % must be between 0 and 100', 400);
          let name = (l.productName ?? '').trim();
          let gst = l.gstPercent != null ? num(l.gstPercent) : 0;
          if (l.productId) {
            const p = (await query('SELECT name, gst_percent FROM products WHERE id = $1', [l.productId])).rows[0];
            if (p) { name = name || p.name; if (l.gstPercent == null) gst = num(p.gst_percent) ?? 0; }
          }
          if (!name) throw httpError('Each item needs a product', 400);
          const lineTotal = round2(l.quantity * l.unitPrice);
          subTotal += lineTotal;
          if (billType === 'GST') taxTotal += round2(lineTotal * gst / 100);
          prepared.push({ productId: l.productId ?? null, name, quantity: l.quantity, unitPrice: l.unitPrice, gst: billType === 'GST' ? gst : 0, lineTotal });
        }
        subTotal = round2(subTotal); taxTotal = round2(taxTotal);
        const total = round2(subTotal + taxTotal);
        const paid = Math.min(round2(input.amountPaid ?? 0), total);

        return withTransaction(async (client) => {
          const billNo = `DSB-${String((await client.query("SELECT nextval('dist_sale_seq') n")).rows[0].n).padStart(5, '0')}`;
          const sale = (await client.query(
            `INSERT INTO distributor_sales (bill_no, distributor_id, farmer_id, buyer_name, buyer_phone, bill_type, sub_total, tax_total, total_amount, amount_paid, payment_method, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [billNo, id, farmerId, buyerName, buyerPhone, billType, subTotal, taxTotal, total, paid, input.paymentMethod ?? null, input.notes ?? null],
          )).rows[0];
          for (const p of prepared) {
            await client.query(
              `INSERT INTO distributor_sale_lines (sale_id, product_id, product_name, quantity, unit_price, gst_percent, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [sale.id, p.productId, p.name, p.quantity, p.unitPrice, p.gst, p.lineTotal],
            );
          }
          await logActivity(null, 'DIST_CREATE_SALE', 'distributor_sale', sale.id, { billNo, via: 'distributor-app' });
          const code = farmerId ? (await client.query('SELECT farmer_code FROM farmers WHERE id=$1', [farmerId])).rows[0]?.farmer_code : null;
          return mapSale({ ...sale, farmer_code: code });
        });
      },

      // Collect the remaining balance (or a partial payment) on a distributor's bill.
      distRecordSalePayment: async (_p, { saleId, amount }, ctx) => {
        const id = distributorId(ctx);
        if (!(amount > 0)) throw httpError('Enter an amount greater than 0', 400);
        return withTransaction(async (client) => {
          // Lock the row so two concurrent collections can't both read the old paid amount.
          const s = (await client.query('SELECT * FROM distributor_sales WHERE id = $1 AND distributor_id = $2 FOR UPDATE', [saleId, id])).rows[0];
          if (!s) throw httpError('Bill not found', 404);
          const total = num(s.total_amount) ?? 0, already = num(s.amount_paid) ?? 0;
          const balance = round2(total - already);
          if (balance <= 0) throw httpError('This bill is already fully paid', 400);
          if (round2(amount) > balance + 0.01) throw httpError(`Payment ₹${amount} exceeds the balance due ₹${balance}`, 400);
          const newPaid = round2(already + amount);
          // Plain UPDATE — the previous `UPDATE ... FROM (farmer subquery)` silently
          // updated ZERO rows for walk-in bills (farmer_id NULL ⇒ empty join relation).
          await client.query('UPDATE distributor_sales SET amount_paid = $2 WHERE id = $1', [saleId, newPaid]);
          const out = (await client.query(
            'SELECT s.*, f.farmer_code FROM distributor_sales s LEFT JOIN farmers f ON f.id = s.farmer_id WHERE s.id = $1',
            [saleId],
          )).rows[0];
          await logActivity(null, 'DIST_SALE_PAYMENT', 'distributor_sale', saleId, { amount, newPaid, via: 'distributor-app' });
          return mapSale(out);
        });
      },
    },

    DistributorProfile: { photoUrl: (parent) => imgUrl(parent.photoKey) },
    DistSale: {
      items: async (parent) => {
        const { rows } = await query('SELECT product_name, quantity, unit_price, gst_percent, line_total FROM distributor_sale_lines WHERE sale_id = $1 ORDER BY product_name', [parent.id]);
        return rows.map((l) => ({ productName: l.product_name, quantity: num(l.quantity), unitPrice: num(l.unit_price), gstPercent: num(l.gst_percent), lineTotal: num(l.line_total) }));
      },
    },
    AppProduct: { gstPercent: (parent) => parent.gstPercent ?? null },
  };
}
