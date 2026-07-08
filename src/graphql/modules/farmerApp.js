// GraphQL module: Farmer App backend (PRD §9).
// Farmer authentication (email/password + Google) and farmer-scoped data —
// the same `farmers` table used by the admin panel, so admin-created farmers and
// app self-signups are one and the same record.

import bcrypt from 'bcryptjs';
import { query } from '../../db/index.js';
import { assertAuth } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { getWeather, weatherConfigured } from '../../services/weather/index.js';
import { diagnoseCrop } from '../../services/ai/index.js';
import { getTrainingReferences } from './ai.js';
import { isAwsConfigured, getDownloadUrl } from '../../utils/aws.js';
import { env } from '../../config/env.js';
import { sendEmail } from '../../services/notify/email.js';

// Resolve a stored S3 key (or pass-through URL) to a viewable URL.
async function imgUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//.test(value) || value.startsWith('data:')) return value;
  if (env.aws.s3PublicBaseUrl) return `${env.aws.s3PublicBaseUrl.replace(/\/$/, '')}/${value}`;
  if (isAwsConfigured) { try { return await getDownloadUrl(value, 3600); } catch { return null; } }
  return null;
}

export const farmerAppTypeDefs = /* GraphQL */ `
  type FarmerProfile {
    id: ID!
    farmerCode: String!
    name: String!
    phone: String
    email: String
    village: String
    tehsil: String
    district: String
    state: String
    crops: [String!]!
    landSizeAcres: Float
    language: String
    pointsBalance: Int!
    photoUrl: String
    authProvider: String!
    deletionStatus: String   # null / REQUESTED / DELETED — set when a deletion has been requested
  }
  type FarmerAuthPayload { token: String!, farmer: FarmerProfile! }

  type AppLoyaltyTxn { id: ID!, points: Int!, type: String!, note: String, createdAt: DateTime! }
  type AppAdvisory { id: ID!, advisoryNo: String!, crop: String!, disease: String, type: String!, title: String!, body: String!, status: String!, products: [String!]!, createdAt: DateTime! }
  type AppComplaintEvent { type: String!, detail: String, at: DateTime! }
  type AppComplaint { id: ID!, ticketNo: String!, category: String!, description: String!, status: String!, priority: String, resolutionNote: String, createdAt: DateTime!, events: [AppComplaintEvent!]! }
  type AccountSummary { totalPurchased: Float!, totalPaid: Float!, balance: Float! }
  type AppOrder { id: ID!, orderNo: String!, billType: String!, status: String!, orderDate: String!, totalAmount: Float!, itemCount: Int! }
  type AppPurchaseLine { productName: String!, quantity: Float!, unitPrice: Float!, lineTotal: Float!, uom: String }
  type AppPurchase {
    id: ID!
    refNo: String!
    kind: String!          # ORDER / DIRECT
    date: String!
    status: String
    totalAmount: Float!
    amountPaid: Float!
    balanceDue: Float!
    items: [AppPurchaseLine!]!
  }
  type AppProduct { id: ID!, name: String!, category: String, technicalName: String, uom: String, packingSize: String, mrp: Float, imageUrl: String, recommendedDosage: String, applicationFrequency: String, targetCrops: [String!]!, targetDiseases: [String!]! }
  type AppNotification { id: ID!, title: String!, body: String!, campaignType: String, createdAt: DateTime! }
  type AppDiagnosis { id: ID!, sessionNo: String!, crop: String!, detectedDisease: String, pathogen: String, confidence: Float, severity: String, symptoms: String, recommendation: String, source: String, products: [String!]!, imageUrl: String, createdAt: DateTime! }

  input FarmerSignupInput { name: String!, email: String!, password: String!, phone: String, village: String, district: String, state: String, language: String }
  input FarmerProfileInput { name: String, phone: String, village: String, tehsil: String, district: String, state: String, crops: [String!], landSizeAcres: Float, language: String }
  input AppComplaintInput { category: String!, description: String! }

  extend type Query {
    meFarmer: FarmerProfile
    myLoyaltyTransactions(limit: Int = 50): [AppLoyaltyTxn!]!
    myAdvisories: [AppAdvisory!]!
    myComplaints: [AppComplaint!]!
    myOrders: [AppOrder!]!
    myPurchases: [AppPurchase!]!
    myDiagnoses: [AppDiagnosis!]!
    myNotifications(limit: Int = 50): [AppNotification!]!
    appProducts(search: String, limit: Int = 100): [AppProduct!]!
    appWeather(lat: Float, lng: Float): Weather!
    myAccountSummary: AccountSummary!
  }

  extend type Mutation {
    farmerSignup(input: FarmerSignupInput!): FarmerAuthPayload!
    farmerLogin(email: String!, password: String!): FarmerAuthPayload!
    farmerGoogleAuth(idToken: String!): FarmerAuthPayload!
    updateMyProfile(input: FarmerProfileInput!): FarmerProfile!
    changeMyPassword(oldPassword: String!, newPassword: String!): Boolean!
    registerMyDevice(fcmToken: String!): Boolean!
    setMyProfilePhoto(imageUrl: String!): FarmerProfile!
    raiseComplaint(input: AppComplaintInput!): AppComplaint!
    runMyDiagnosis(crop: String!, imageUrl: String): AppDiagnosis!
    markAdvisoryRead(id: ID!): Boolean!
    # Account deletion (Google Play compliance): flags the account for admin review.
    # Admin then anonymises (approve) or clears the flag (reject).
    requestMyAccountDeletion(reason: String): Boolean!
  }
`;

const genCode = () => `FRM${Math.floor(100000 + Math.random() * 900000)}`;

const mapFarmer = (r) => r && {
  id: r.id, farmerCode: r.farmer_code, name: r.name, phone: r.phone, email: r.email,
  village: r.village, tehsil: r.tehsil, district: r.district, state: r.state,
  crops: r.crops ?? [], landSizeAcres: num(r.land_size_acres), language: r.language,
  pointsBalance: r.points_balance ?? 0, photoKey: r.photo_url, authProvider: r.auth_provider ?? 'ADMIN',
  deletionStatus: r.deletion_status ?? null,
};

// Resolve the authenticated farmer's id from a FARMER-kind JWT.
function farmerId(ctx) {
  const u = assertAuth(ctx);
  if (u.kind !== 'FARMER') throw httpError('Farmer authentication required', 403);
  return u.sub;
}

async function productNames(ids) {
  if (!ids?.length) return [];
  const { rows } = await query('SELECT name FROM products WHERE id = ANY($1)', [ids]);
  return rows.map((r) => r.name);
}

// Best-effort product match for an app diagnosis: trained class → catalog targets → recent.
async function matchProductsForApp(crop, disease) {
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

export function farmerAppResolvers(app) {
  // Mobile apps need long-lived tokens; 30-day expiry replaces the default 15-min access window.
  const sign = (farmer) => app.jwt.sign({ sub: farmer.id, kind: 'FARMER', role: 'FARMER' }, { expiresIn: '30d' });
  const authPayload = (farmer) => ({ token: sign(farmer), farmer: mapFarmer(farmer) });

  return {
    Query: {
      meFarmer: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query('SELECT * FROM farmers WHERE id = $1', [id]);
        return mapFarmer(rows[0]);
      },
      myLoyaltyTransactions: async (_p, { limit }, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query('SELECT * FROM loyalty_transactions WHERE farmer_id = $1 ORDER BY created_at DESC LIMIT $2', [id, limit]);
        return rows.map((r) => ({ id: r.id, points: r.points, type: r.type, note: r.note, createdAt: r.created_at }));
      },
      myAdvisories: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        // Farmer-specific advisories + broadcast advisories (no specific farmer).
        const { rows } = await query("SELECT * FROM advisories WHERE (farmer_id = $1 OR farmer_id IS NULL) AND status IN ('SENT','READ') ORDER BY created_at DESC", [id]);
        return Promise.all(rows.map(async (r) => ({
          id: r.id, advisoryNo: r.advisory_no, crop: r.crop, disease: r.disease, type: r.type, title: r.title,
          body: r.body, status: r.status, products: await productNames(r.product_ids), createdAt: r.created_at,
        })));
      },
      myComplaints: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query('SELECT * FROM complaints WHERE farmer_id = $1 ORDER BY created_at DESC', [id]);
        return rows.map((r) => ({ id: r.id, ticketNo: r.ticket_no, category: r.category, description: r.description, status: r.status, priority: r.priority, resolutionNote: r.resolution_note, createdAt: r.created_at }));
      },
      myAccountSummary: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query(
          `SELECT COALESCE((SELECT SUM(total_amount) FROM invoices WHERE farmer_id=$1),0)
                    + COALESCE((SELECT SUM(total_amount) FROM party_sales WHERE farmer_id=$1),0) total_purchased,
                  COALESCE((SELECT SUM(amount_paid) FROM invoices WHERE farmer_id=$1),0)
                    + COALESCE((SELECT SUM(amount_paid) FROM party_sales WHERE farmer_id=$1),0) total_paid`,
          [id],
        );
        const tp = num(rows[0].total_purchased) ?? 0, paid = num(rows[0].total_paid) ?? 0;
        return { totalPurchased: tp, totalPaid: paid, balance: Math.round((tp - paid) * 100) / 100 };
      },
      myOrders: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query(
          `SELECT o.id, o.order_no, o.bill_type, o.status, o.order_date, o.total_amount,
                  (SELECT COUNT(*)::int FROM order_lines ol WHERE ol.order_id = o.id) item_count
           FROM orders o WHERE o.farmer_id = $1 ORDER BY o.created_at DESC`,
          [id],
        );
        return rows.map((r) => ({ id: r.id, orderNo: r.order_no, billType: r.bill_type ?? 'GST', status: r.status, orderDate: isoDate(r.order_date), totalAmount: num(r.total_amount), itemCount: r.item_count }));
      },
      // Unified purchase history: GST/Non-GST orders + direct sales, each with its
      // product line items and payment status. Powers the Purchases screen and the
      // per-product transaction sheet in the farmer app.
      myPurchases: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const round2 = (n) => Math.round(n * 100) / 100;
        const mapLine = (l) => ({ productName: l.product_name, quantity: num(l.quantity), unitPrice: num(l.unit_price), lineTotal: num(l.line_total), uom: l.uom ?? null });
        const out = [];

        const orders = (await query(
          `SELECT o.id, o.order_no, o.order_date, o.status, o.total_amount,
                  COALESCE((SELECT SUM(amount_paid) FROM invoices i WHERE i.order_id = o.id), 0) paid
           FROM orders o WHERE o.farmer_id = $1 ORDER BY o.created_at DESC`,
          [id],
        )).rows;
        for (const o of orders) {
          const lines = (await query('SELECT product_name, quantity, unit_price, line_total, uom FROM order_lines WHERE order_id = $1', [o.id])).rows;
          const total = num(o.total_amount), paid = num(o.paid);
          out.push({ id: o.id, refNo: o.order_no, kind: 'ORDER', date: isoDate(o.order_date), status: o.status, totalAmount: total, amountPaid: paid, balanceDue: round2(total - paid), items: lines.map(mapLine) });
        }

        const sales = (await query(
          'SELECT id, sale_no, sale_date, total_amount, amount_paid FROM party_sales WHERE farmer_id = $1 ORDER BY created_at DESC',
          [id],
        )).rows;
        for (const s of sales) {
          const lines = (await query('SELECT product_name, quantity, unit_price, line_total FROM party_sale_lines WHERE sale_id = $1', [s.id])).rows;
          const total = num(s.total_amount), paid = num(s.amount_paid);
          out.push({ id: s.id, refNo: s.sale_no, kind: 'DIRECT', date: isoDate(s.sale_date), status: paid >= total ? 'PAID' : (paid > 0 ? 'PARTIAL' : 'DUE'), totalAmount: total, amountPaid: paid, balanceDue: round2(total - paid), items: lines.map(mapLine) });
        }

        out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        return out;
      },
      myDiagnoses: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query('SELECT * FROM crop_diagnoses WHERE farmer_id = $1 ORDER BY created_at DESC LIMIT 50', [id]);
        return Promise.all(rows.map(async (r) => ({
          id: r.id, sessionNo: r.session_no, crop: r.crop, detectedDisease: r.detected_disease, pathogen: r.pathogen,
          confidence: num(r.confidence), severity: r.severity, symptoms: r.symptoms, recommendation: r.recommendation,
          source: r.source, products: await productNames(r.product_ids), imageUrl: r.image_url, createdAt: r.created_at,
        })));
      },
      myNotifications: async (_p, { limit }, ctx) => {
        const id = farmerId(ctx);
        // Unified feed: admin notifications + the farmer's advisories (so the bell
        // shows advisories too), newest first.
        const { rows } = await query(
          `SELECT id, title, body, campaign_type, created_at FROM (
             SELECT id, title, body, campaign_type, created_at FROM notifications
               WHERE status = 'SENT' AND (target_farmer_id = $1 OR audience IN ('FARMERS','ALL'))
             UNION ALL
             SELECT id, title, body, 'ADVISORY' AS campaign_type, created_at FROM advisories
               WHERE status IN ('SENT','READ') AND (farmer_id = $1 OR farmer_id IS NULL)
           ) feed
           ORDER BY created_at DESC LIMIT $2`,
          [id, limit],
        );
        return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, campaignType: r.campaign_type, createdAt: r.created_at }));
      },
      appProducts: async (_p, { search, limit }, ctx) => {
        farmerId(ctx);
        const { rows } = await query(
          `SELECT * FROM products WHERE is_active AND ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR technical_name ILIKE '%'||$1||'%')
           ORDER BY name LIMIT $2`,
          [search ?? null, limit],
        );
        return rows.map((r) => ({
          id: r.id, name: r.name, category: r.category, technicalName: r.technical_name, uom: r.uom, packingSize: r.packing_size,
          mrp: num(r.mrp), imageKey: r.image_key, recommendedDosage: r.recommended_dosage, applicationFrequency: r.application_frequency,
          targetCrops: r.target_crops ?? [], targetDiseases: r.target_diseases ?? [],
        }));
      },
      appWeather: async (_p, { lat, lng }, ctx) => {
        const id = farmerId(ctx);
        const f = (await query('SELECT village, district, state, gps_lat, gps_lng, language FROM farmers WHERE id = $1', [id])).rows[0];
        if (!f) throw httpError('Farmer not found', 404);
        // Prefer the device's live coordinates (and remember them); else stored GPS; else region name.
        let la = lat, ln = lng;
        if (la != null && ln != null) {
          await query('UPDATE farmers SET gps_lat=$2, gps_lng=$3 WHERE id=$1', [id, la, ln]);
        } else {
          la = num(f.gps_lat); ln = num(f.gps_lng);
        }
        const lang = f.language === 'hi' ? 'hi' : undefined; // localize OWM descriptions
        const w = la != null && ln != null
          ? await getWeather({ lat: la, lon: ln, lang })
          : await getWeather({ city: [f.village, f.district, f.state].filter(Boolean).join(', ') || 'India', lang });
        return { ...w, configured: weatherConfigured };
      },
    },

    Mutation: {
      farmerSignup: async (_p, { input }, _ctx) => {
        const email = input.email.trim().toLowerCase();
        if (!email || !input.password) throw httpError('Email and password are required', 400);
        if (input.password.length < 6) throw httpError('Password must be at least 6 characters', 400);
        const existing = await query('SELECT id FROM farmers WHERE lower(email) = $1', [email]);
        if (existing.rows[0]) throw httpError('An account with this email already exists', 409);
        const hash = await bcrypt.hash(input.password, 10);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            const { rows } = await query(
              `INSERT INTO farmers (farmer_code, name, email, phone, village, district, state, language, password_hash, auth_provider)
               VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'en'),$9,'EMAIL') RETURNING *`,
              [genCode(), input.name.trim(), email, input.phone ?? null, input.village ?? null, input.district ?? null, input.state ?? null, input.language ?? null, hash],
            );
            await logActivity(null, 'FARMER_SIGNUP', 'farmer', rows[0].id, { via: 'EMAIL' });
            return authPayload(rows[0]);
          } catch (err) {
            if (err.code === '23505' && /farmer_code/.test(err.detail ?? '') && attempt < 4) continue;
            throw err;
          }
        }
        throw httpError('Could not create account', 500);
      },

      farmerLogin: async (_p, { email, password }, _ctx) => {
        const { rows } = await query('SELECT * FROM farmers WHERE lower(email) = $1', [email.trim().toLowerCase()]);
        const f = rows[0];
        if (!f || !f.password_hash || !(await bcrypt.compare(password, f.password_hash))) {
          throw httpError('Invalid email or password', 401);
        }
        return authPayload(f);
      },

      farmerGoogleAuth: async (_p, { idToken }, _ctx) => {
        // Verify the Google ID token server-side.
        const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
        if (!res.ok) throw httpError('Invalid Google token', 401);
        const info = await res.json();
        const wantAud = process.env.GOOGLE_CLIENT_ID;
        if (wantAud && info.aud !== wantAud) throw httpError('Google token audience mismatch', 401);
        const email = (info.email || '').toLowerCase();
        if (!email) throw httpError('Google account has no email', 400);

        const existing = (await query('SELECT * FROM farmers WHERE lower(email) = $1', [email])).rows[0];
        if (existing) {
          // Link Google to an existing (possibly admin-created) farmer.
          const { rows } = await query(
            "UPDATE farmers SET google_id = COALESCE(google_id,$2), auth_provider = CASE WHEN auth_provider='ADMIN' THEN 'GOOGLE' ELSE auth_provider END, photo_url = COALESCE(photo_url,$3) WHERE id = $1 RETURNING *",
            [existing.id, info.sub, info.picture ?? null],
          );
          return authPayload(rows[0]);
        }
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            const { rows } = await query(
              `INSERT INTO farmers (farmer_code, name, email, google_id, photo_url, language, auth_provider)
               VALUES ($1,$2,$3,$4,$5,'en','GOOGLE') RETURNING *`,
              [genCode(), info.name || email.split('@')[0], email, info.sub, info.picture ?? null],
            );
            await logActivity(null, 'FARMER_SIGNUP', 'farmer', rows[0].id, { via: 'GOOGLE' });
            return authPayload(rows[0]);
          } catch (err) {
            if (err.code === '23505' && /farmer_code/.test(err.detail ?? '') && attempt < 4) continue;
            throw err;
          }
        }
        throw httpError('Could not create account', 500);
      },

      updateMyProfile: async (_p, { input }, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query(
          `UPDATE farmers SET
             name = COALESCE($2,name), phone = COALESCE($3,phone), village = COALESCE($4,village),
             tehsil = COALESCE($5,tehsil), district = COALESCE($6,district), state = COALESCE($7,state),
             crops = COALESCE($8,crops), land_size_acres = COALESCE($9,land_size_acres), language = COALESCE($10,language),
             updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, input.name ?? null, input.phone ?? null, input.village ?? null, input.tehsil ?? null, input.district ?? null, input.state ?? null, input.crops ?? null, input.landSizeAcres ?? null, input.language ?? null],
        );
        return mapFarmer(rows[0]);
      },

      changeMyPassword: async (_p, { oldPassword, newPassword }, ctx) => {
        const id = farmerId(ctx);
        const f = (await query('SELECT password_hash FROM farmers WHERE id = $1', [id])).rows[0];
        if (f.password_hash && !(await bcrypt.compare(oldPassword, f.password_hash))) throw httpError('Current password is incorrect', 400);
        if (newPassword.length < 6) throw httpError('Password must be at least 6 characters', 400);
        await query("UPDATE farmers SET password_hash = $2, auth_provider = CASE WHEN auth_provider='ADMIN' THEN 'EMAIL' ELSE auth_provider END WHERE id = $1", [id, await bcrypt.hash(newPassword, 10)]);
        return true;
      },

      registerMyDevice: async (_p, { fcmToken }, ctx) => {
        const id = farmerId(ctx);
        await query('UPDATE farmers SET fcm_token = $2 WHERE id = $1', [id, fcmToken]);
        return true;
      },

      setMyProfilePhoto: async (_p, { imageUrl }, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query('UPDATE farmers SET photo_url = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, imageUrl]);
        await logActivity(null, 'SET_FARMER_PHOTO', 'farmer', id, { via: 'farmer-app' });
        return mapFarmer(rows[0]);
      },

      raiseComplaint: async (_p, { input }, ctx) => {
        const id = farmerId(ctx);
        const ticketNo = `CMP-${String((await query("SELECT nextval('complaint_seq') n")).rows[0].n).padStart(5, '0')}`;
        const { rows } = await query(
          `INSERT INTO complaints (ticket_no, farmer_id, category, description, status, priority)
           VALUES ($1,$2,$3,$4,'OPEN','MEDIUM') RETURNING *`,
          [ticketNo, id, input.category, input.description],
        );
        await logActivity(null, 'RAISE_COMPLAINT', 'complaint', rows[0].id, { ticketNo, via: 'farmer-app' });
        const r = rows[0];
        return { id: r.id, ticketNo: r.ticket_no, category: r.category, description: r.description, status: r.status, priority: r.priority, resolutionNote: r.resolution_note, createdAt: r.created_at };
      },

      runMyDiagnosis: async (_p, { crop, imageUrl }, ctx) => {
        const id = farmerId(ctx);
        const lang = (await query('SELECT language FROM farmers WHERE id=$1', [id])).rows[0]?.language;
        // Full RAG grounding: Pinecone → in-memory cosine → recent fallback (same as admin).
        const { references } = await getTrainingReferences(crop, imageUrl);
        const d = await diagnoseCrop({ crop, imageUrl, references, lang });
        const productIds = await matchProductsForApp(crop, d.disease);
        const sessionNo = `CD-${String((await query("SELECT nextval('diag_seq') n")).rows[0].n).padStart(5, '0')}`;
        const { rows } = await query(
          `INSERT INTO crop_diagnoses (session_no, farmer_id, crop, image_url, detected_disease, pathogen, confidence, severity, symptoms, recommendation, product_ids, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [sessionNo, id, crop, imageUrl ?? null, d.disease, d.pathogen, d.confidence, d.severity, d.symptoms, d.recommendation, productIds, d.source],
        );
        await logActivity(null, 'CROP_DIAGNOSIS', 'crop_diagnosis', rows[0].id, { crop, via: 'farmer-app' });
        const r = rows[0];
        return {
          id: r.id, sessionNo: r.session_no, crop: r.crop, detectedDisease: r.detected_disease, pathogen: r.pathogen,
          confidence: num(r.confidence), severity: r.severity, symptoms: r.symptoms, recommendation: r.recommendation,
          source: r.source, products: await productNames(productIds), imageUrl: r.image_url, createdAt: r.created_at,
        };
      },

      markAdvisoryRead: async (_p, { id }, ctx) => {
        const fid = farmerId(ctx);
        // Farmer-specific advisories: mark as READ. Broadcast (farmer_id IS NULL) stay SENT — shared record, not personal.
        await query("UPDATE advisories SET status='READ' WHERE id=$1 AND farmer_id=$2 AND status='SENT'", [id, fid]);
        return true;
      },

      // Flag the account for deletion. Idempotent: re-requesting keeps the original
      // timestamp. An admin reviews the request in the panel and anonymises (approve)
      // or clears it (reject). Already-deleted accounts cannot re-request.
      requestMyAccountDeletion: async (_p, { reason }, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query(
          `UPDATE farmers SET
             deletion_status = 'REQUESTED',
             deletion_requested_at = COALESCE(deletion_requested_at, now()),
             deletion_reason = $2,
             updated_at = now()
           WHERE id = $1 AND COALESCE(deletion_status,'') <> 'DELETED'
           RETURNING farmer_code, name, email, phone`,
          [id, reason?.trim() || null],
        );
        if (!rows[0]) throw httpError('Account not found', 404);
        await logActivity(null, 'REQUEST_ACCOUNT_DELETION', 'farmer', id, { via: 'farmer-app', reason: reason?.trim() || null });
        // Best-effort: notify the admin inbox so the request is actioned within 30 days.
        try {
          const to = process.env.ACCOUNT_DELETION_NOTIFY_EMAIL || process.env.SMTP_USER;
          if (to) {
            const f = rows[0];
            await sendEmail(
              [to],
              `Account deletion request — ${f.name} (${f.farmer_code})`,
              `A farmer has requested account deletion from the app.\n\n`
                + `Name: ${f.name}\nFarmer code: ${f.farmer_code}\n`
                + `Email: ${f.email || '—'}\nPhone: ${f.phone || '—'}\n`
                + `Reason: ${reason?.trim() || '—'}\n\n`
                + `Review and action it in the Admin panel → Farmers → "Account deletion requests".`,
            );
          }
        } catch { /* notification is best-effort; never block the request */ }
        return true;
      },
    },

    FarmerProfile: { photoUrl: (parent) => imgUrl(parent.photoKey) },
    AppProduct: { imageUrl: (parent) => imgUrl(parent.imageKey) },
    AppComplaint: {
      events: async (parent) => {
        const { rows } = await query('SELECT event_type, detail, created_at FROM complaint_events WHERE complaint_id=$1 ORDER BY created_at', [parent.id]);
        return rows.map((r) => ({ type: r.event_type, detail: r.detail, at: r.created_at }));
      },
    },
  };
}
