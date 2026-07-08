// GraphQL module: Farmer Registry + Loyalty Engine (PRD §4.4, §8.4-8.5, §9.6).

import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { sendEmail } from '../../services/notify/email.js';

export const loyaltyTypeDefs = /* GraphQL */ `
  type Farmer {
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
    hasDevice: Boolean!
    createdAt: DateTime!
    deletionStatus: String        # null / REQUESTED / DELETED
    deletionRequestedAt: DateTime
    deletionReason: String
  }

  type LoyaltyRule {
    id: ID!
    name: String!
    ruleType: String!
    config: JSON
    validFrom: String
    validTo: String
    isActive: Boolean!
    createdAt: DateTime!
  }

  type LoyaltyTransaction {
    id: ID!
    farmerId: ID!
    points: Int!
    type: String!
    note: String
    createdAt: DateTime!
  }

  type FarmerStats {
    total: Int!
    pointsIssued: Int!
    pointsRedeemed: Int!
    activeBalance: Int!
    pendingDeletions: Int!
  }

  type EmailResult { sent: Int!, status: String!, note: String }

  input FarmerInput {
    name: String!
    phone: String!
    email: String
    village: String
    tehsil: String
    district: String
    state: String
    crops: [String!]
    landSizeAcres: Float
    language: String
    registeredBy: ID
    password: String   # optional — set login credentials so the farmer can use the app (requires email)
  }

  input LoyaltyRuleInput {
    name: String!
    ruleType: String!
    config: JSON
    validFrom: String
    validTo: String
  }

  extend type Query {
    farmers(search: String, limit: Int = 50, offset: Int = 0): [Farmer!]!
    farmer(id: ID!): Farmer
    farmerByCode(farmerCode: String!): Farmer
    farmerStats: FarmerStats!
    accountDeletionRequests: [Farmer!]!   # farmers who requested deletion from the app
    loyaltyRules(activeOnly: Boolean): [LoyaltyRule!]!
    loyaltyTransactions(farmerId: ID!, limit: Int = 50): [LoyaltyTransaction!]!
  }

  extend type Mutation {
    registerFarmer(input: FarmerInput!): Farmer!
    updateFarmer(id: ID!, input: FarmerInput!): Farmer!
    deleteFarmer(id: ID!): Boolean!
    # Account-deletion request workflow (Google Play compliance):
    approveAccountDeletion(id: ID!): Boolean!   # anonymise PII, keep financial history
    rejectAccountDeletion(id: ID!): Boolean!    # clear the deletion flag
    registerFarmerDevice(farmerCode: String!, fcmToken: String!): Boolean!
    sendFarmerEmail(farmerId: ID!, subject: String!, body: String!): EmailResult!

    creditLoyaltyPoints(farmerCode: String!, points: Int!, note: String): LoyaltyTransaction!
    redeemLoyaltyPoints(farmerCode: String!, points: Int!, note: String): LoyaltyTransaction!

    createLoyaltyRule(input: LoyaltyRuleInput!): LoyaltyRule!
    updateLoyaltyRule(id: ID!, input: LoyaltyRuleInput!): LoyaltyRule!
    setLoyaltyRuleActive(id: ID!, isActive: Boolean!): LoyaltyRule!
    deleteLoyaltyRule(id: ID!): Boolean!
  }
`;

const mapFarmer = (r) =>
  r && {
    id: r.id,
    farmerCode: r.farmer_code,
    name: r.name,
    phone: r.phone,
    email: r.email,
    village: r.village,
    tehsil: r.tehsil,
    district: r.district,
    state: r.state,
    crops: r.crops ?? [],
    landSizeAcres: num(r.land_size_acres),
    language: r.language,
    pointsBalance: r.points_balance ?? 0,
    hasDevice: Boolean(r.fcm_token),
    createdAt: r.created_at,
    deletionStatus: r.deletion_status ?? null,
    deletionRequestedAt: r.deletion_requested_at ?? null,
    deletionReason: r.deletion_reason ?? null,
  };

const mapRule = (r) =>
  r && {
    id: r.id,
    name: r.name,
    ruleType: r.rule_type,
    config: r.config,
    validFrom: isoDate(r.valid_from),
    validTo: isoDate(r.valid_to),
    isActive: r.is_active,
    createdAt: r.created_at,
  };

const mapTxn = (r) => ({
  id: r.id,
  farmerId: r.farmer_id,
  points: r.points,
  type: r.type,
  note: r.note,
  createdAt: r.created_at,
});

function genFarmerCode() {
  return `FRM${Math.floor(100000 + Math.random() * 900000)}`;
}

const farmerValues = (i) => [
  i.name,
  i.phone,
  i.village ?? null,
  i.tehsil ?? null,
  i.district ?? null,
  i.state ?? null,
  i.crops ?? [],
  i.landSizeAcres ?? null,
  i.language ?? 'en',
  i.email ?? null,
];

export function loyaltyResolvers() {
  return {
    Query: {
      farmers: async (_p, { search, limit, offset }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM farmers
           WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR farmer_code ILIKE '%' || $1 || '%' OR phone ILIKE '%' || $1 || '%')
           ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [search ?? null, limit, offset],
        );
        return rows.map(mapFarmer);
      },
      farmer: async (_p, { id }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query('SELECT * FROM farmers WHERE id = $1', [id]);
        return mapFarmer(rows[0]);
      },
      farmerByCode: async (_p, { farmerCode }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query('SELECT * FROM farmers WHERE farmer_code = $1', [farmerCode]);
        return mapFarmer(rows[0]);
      },
      farmerStats: async (_p, _a, ctx) => {
        assertAuth(ctx);
        const t = await query(
          `SELECT COUNT(*)::int AS total,
                  COALESCE(SUM(points_balance),0)::int AS bal,
                  COUNT(*) FILTER (WHERE deletion_status = 'REQUESTED')::int AS pending_deletions
           FROM farmers`,
        );
        const p = await query(
          `SELECT COALESCE(SUM(points) FILTER (WHERE points > 0),0)::int AS issued,
                  COALESCE(-SUM(points) FILTER (WHERE points < 0),0)::int AS redeemed
           FROM loyalty_transactions`,
        );
        return {
          total: t.rows[0].total,
          activeBalance: t.rows[0].bal,
          pointsIssued: p.rows[0].issued,
          pointsRedeemed: p.rows[0].redeemed,
          pendingDeletions: t.rows[0].pending_deletions,
        };
      },
      accountDeletionRequests: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          "SELECT * FROM farmers WHERE deletion_status = 'REQUESTED' ORDER BY deletion_requested_at ASC",
        );
        return rows.map(mapFarmer);
      },
      loyaltyRules: async (_p, { activeOnly }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM loyalty_rules WHERE ($1::bool IS NULL OR is_active = $1) ORDER BY created_at DESC`,
          [activeOnly ?? null],
        );
        return rows.map(mapRule);
      },
      loyaltyTransactions: async (_p, { farmerId, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          'SELECT * FROM loyalty_transactions WHERE farmer_id = $1 ORDER BY created_at DESC LIMIT $2',
          [farmerId, limit],
        );
        return rows.map(mapTxn);
      },
    },

    Mutation: {
      registerFarmer: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES', 'DISTRIBUTOR');
        // Optional login credentials — lets the farmer sign in to the Farmer App.
        if (input.password && !input.email) throw httpError('Email is required to set a password', 400);
        if (input.password && input.password.length < 6) throw httpError('Password must be at least 6 characters', 400);
        if (input.email) {
          const dup = await query('SELECT 1 FROM farmers WHERE lower(email) = lower($1)', [input.email]);
          if (dup.rows[0]) throw httpError('A farmer with this email already exists', 409);
        }
        const passwordHash = input.password ? await bcrypt.hash(input.password, 10) : null;
        const provider = input.password ? 'EMAIL' : 'ADMIN';
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            const { rows } = await query(
              `INSERT INTO farmers
                 (farmer_code, name, phone, village, tehsil, district, state, crops, land_size_acres, language, email, registered_by, password_hash, auth_provider)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
              [genFarmerCode(), ...farmerValues(input), input.registeredBy ?? null, passwordHash, provider],
            );
            await logActivity(actor.sub, 'REGISTER_FARMER', 'farmer', rows[0].id, { code: rows[0].farmer_code, login: Boolean(input.password) });
            return mapFarmer(rows[0]);
          } catch (err) {
            if (err.code === '23505' && /farmer_code/.test(err.detail ?? '') && attempt < 4) continue; // FARMER-CODE collision → retry
            if (err.code === '23505') throw httpError('A farmer with this email already exists', 409);
            throw err;
          }
        }
        throw httpError('Could not allocate a unique FARMER-CODE', 500);
      },
      updateFarmer: async (_p, { id, input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `UPDATE farmers SET name=$2, phone=$3, village=$4, tehsil=$5, district=$6, state=$7,
             crops=$8, land_size_acres=$9, language=$10, email=$11, updated_at=now() WHERE id=$1 RETURNING *`,
          [id, ...farmerValues(input)],
        );
        if (!rows[0]) throw httpError('Farmer not found', 404);
        // Optionally (re)set login credentials.
        if (input.password) {
          if (input.password.length < 6) throw httpError('Password must be at least 6 characters', 400);
          if (!rows[0].email) throw httpError('Farmer needs an email before setting a password', 400);
          await query(
            "UPDATE farmers SET password_hash=$2, auth_provider=CASE WHEN auth_provider='ADMIN' THEN 'EMAIL' ELSE auth_provider END WHERE id=$1",
            [id, await bcrypt.hash(input.password, 10)],
          );
        }
        await logActivity(actor.sub, 'UPDATE_FARMER', 'farmer', id, { passwordSet: Boolean(input.password) });
        return mapFarmer(rows[0]);
      },
      deleteFarmer: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rowCount } = await query('DELETE FROM farmers WHERE id = $1', [id]);
        if (!rowCount) throw httpError('Farmer not found', 404);
        await logActivity(actor.sub, 'DELETE_FARMER', 'farmer', id);
        return true;
      },

      // Approve an app-initiated deletion request by ANONYMISING the record:
      // strip all personal data + login credentials but keep the row so the
      // legally-required financial history (invoices, sales, loyalty) stays intact.
      approveAccountDeletion: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query('SELECT deletion_status FROM farmers WHERE id = $1', [id]);
        if (!rows[0]) throw httpError('Farmer not found', 404);
        await query(
          `UPDATE farmers SET
             name = 'Deleted Farmer', email = NULL, phone = NULL,
             village = NULL, tehsil = NULL, district = NULL, state = NULL,
             crops = '{}', land_size_acres = NULL, gps_lat = NULL, gps_lng = NULL,
             password_hash = NULL, google_id = NULL, photo_url = NULL, fcm_token = NULL,
             auth_provider = 'DELETED',
             deletion_status = 'DELETED',
             deletion_requested_at = COALESCE(deletion_requested_at, now()),
             updated_at = now()
           WHERE id = $1`,
          [id],
        );
        await logActivity(actor.sub, 'APPROVE_ACCOUNT_DELETION', 'farmer', id);
        return true;
      },
      // Reject / dismiss a deletion request — clears the flag, account stays active.
      rejectAccountDeletion: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rowCount } = await query(
          "UPDATE farmers SET deletion_status = NULL, deletion_requested_at = NULL, deletion_reason = NULL, updated_at = now() WHERE id = $1 AND deletion_status = 'REQUESTED'",
          [id],
        );
        if (!rowCount) throw httpError('No pending deletion request for this farmer', 404);
        await logActivity(actor.sub, 'REJECT_ACCOUNT_DELETION', 'farmer', id);
        return true;
      },
      registerFarmerDevice: async (_p, { farmerCode, fcmToken }, ctx) => {
        assertAuth(ctx);
        const { rowCount } = await query('UPDATE farmers SET fcm_token = $2 WHERE farmer_code = $1', [farmerCode, fcmToken]);
        if (!rowCount) throw httpError('Farmer not found', 404);
        return true;
      },
      sendFarmerEmail: async (_p, { farmerId, subject, body }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query('SELECT name, email, language FROM farmers WHERE id = $1', [farmerId]);
        if (!rows[0]) throw httpError('Farmer not found', 404);
        if (!rows[0].email) return { sent: 0, status: 'SKIPPED', note: 'No email on file for this farmer' };
        // Greeting + sign-off in the farmer's preferred language (Hindi supported).
        const greet = { en: 'Dear', hi: 'प्रिय', mr: 'प्रिय', pa: 'ਪਿਆਰੇ' }[rows[0].language] ?? 'Dear';
        const signoff = rows[0].language === 'hi' ? 'सादर,\nक्रॉपलैंड एग्रीटेक इंडिया' : 'Regards,\nCropland Agritech India';
        const text = `${greet} ${rows[0].name},\n\n${body}\n\n${signoff}`;
        const res = await sendEmail([rows[0].email], subject, text);
        await logActivity(actor.sub, 'SEND_FARMER_EMAIL', 'farmer', farmerId, { subject });
        return { sent: res.sent ?? 0, status: res.skipped ? 'SKIPPED' : res.sent > 0 ? 'SENT' : 'FAILED', note: res.note ?? null };
      },

      creditLoyaltyPoints: async (_p, { farmerCode, points, note }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES', 'DISTRIBUTOR');
        if (points <= 0) throw httpError('Points must be positive', 400);
        return withTransaction(async (client) => {
          const f = await client.query('SELECT * FROM farmers WHERE farmer_code = $1 FOR UPDATE', [farmerCode]);
          if (!f.rows[0]) throw httpError('Farmer not found', 404);
          await client.query('UPDATE farmers SET points_balance = points_balance + $2 WHERE id = $1', [f.rows[0].id, points]);
          const tx = await client.query(
            `INSERT INTO loyalty_transactions (farmer_id, points, type, note, created_by)
             VALUES ($1,$2,'EARN',$3,$4) RETURNING *`,
            [f.rows[0].id, points, note ?? null, actor.sub],
          );
          await logActivity(actor.sub, 'CREDIT_POINTS', 'farmer', f.rows[0].id, { points });
          return mapTxn(tx.rows[0]);
        });
      },
      redeemLoyaltyPoints: async (_p, { farmerCode, points, note }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES', 'DISTRIBUTOR');
        if (points <= 0) throw httpError('Points must be positive', 400);
        return withTransaction(async (client) => {
          const f = await client.query('SELECT * FROM farmers WHERE farmer_code = $1 FOR UPDATE', [farmerCode]);
          if (!f.rows[0]) throw httpError('Farmer not found', 404);
          if (f.rows[0].points_balance < points) throw httpError('Insufficient points balance', 400);
          await client.query('UPDATE farmers SET points_balance = points_balance - $2 WHERE id = $1', [f.rows[0].id, points]);
          const tx = await client.query(
            `INSERT INTO loyalty_transactions (farmer_id, points, type, note, created_by)
             VALUES ($1,$2,'REDEEM',$3,$4) RETURNING *`,
            [f.rows[0].id, -points, note ?? null, actor.sub],
          );
          await logActivity(actor.sub, 'REDEEM_POINTS', 'farmer', f.rows[0].id, { points });
          return mapTxn(tx.rows[0]);
        });
      },

      createLoyaltyRule: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `INSERT INTO loyalty_rules (name, rule_type, config, valid_from, valid_to)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [input.name, input.ruleType, JSON.stringify(input.config ?? {}), input.validFrom ?? null, input.validTo ?? null],
        );
        await logActivity(actor.sub, 'CREATE_LOYALTY_RULE', 'loyalty_rule', rows[0].id);
        return mapRule(rows[0]);
      },
      updateLoyaltyRule: async (_p, { id, input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `UPDATE loyalty_rules SET name=$2, rule_type=$3, config=$4, valid_from=$5, valid_to=$6, updated_at=now()
           WHERE id=$1 RETURNING *`,
          [id, input.name, input.ruleType, JSON.stringify(input.config ?? {}), input.validFrom ?? null, input.validTo ?? null],
        );
        if (!rows[0]) throw httpError('Rule not found', 404);
        await logActivity(actor.sub, 'UPDATE_LOYALTY_RULE', 'loyalty_rule', id);
        return mapRule(rows[0]);
      },
      setLoyaltyRuleActive: async (_p, { id, isActive }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query('UPDATE loyalty_rules SET is_active=$2, updated_at=now() WHERE id=$1 RETURNING *', [id, isActive]);
        if (!rows[0]) throw httpError('Rule not found', 404);
        return mapRule(rows[0]);
      },
      deleteLoyaltyRule: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rowCount } = await query('DELETE FROM loyalty_rules WHERE id = $1', [id]);
        if (!rowCount) throw httpError('Rule not found', 404);
        await logActivity(actor.sub, 'DELETE_LOYALTY_RULE', 'loyalty_rule', id);
        return true;
      },
    },
  };
}
