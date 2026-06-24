// GraphQL module: Distributor / Dealer Master (PRD §7.2, §8).
// Buyer master for Order-to-Cash; GSTIN/state feed the GST + E-Way Bill engine.

import { query } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num } from '../helpers.js';

export const distributorTypeDefs = /* GraphQL */ `
  type Distributor {
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
    branchId: ID
    branch: Branch
    creditLimit: Float!
    outstanding: Float!
    creditAvailable: Float!
    gpsLat: Float
    gpsLng: Float
    udyamNo: String
    msmeType: String
    msmeRegistered: Boolean!
    msmeRegDate: String
    isActive: Boolean!
    createdAt: DateTime!
  }

  type DistributorStats {
    total: Int!
    active: Int!
    totalOutstanding: Float!
  }

  input DistributorInput {
    name: String!
    contactPerson: String
    phone: String
    email: String
    gstin: String
    dealerTier: String
    state: String
    district: String
    address: String
    branchId: ID
    creditLimit: Float = 0
    gpsLat: Float
    gpsLng: Float
    udyamNo: String
    msmeType: String
    msmeRegistered: Boolean
    msmeRegDate: String
  }

  extend type Query {
    distributors(search: String, activeOnly: Boolean, limit: Int = 100, offset: Int = 0): [Distributor!]!
    distributor(id: ID!): Distributor
    distributorStats: DistributorStats!
  }

  extend type Mutation {
    createDistributor(input: DistributorInput!): Distributor!
    updateDistributor(id: ID!, input: DistributorInput!): Distributor!
    setDistributorActive(id: ID!, isActive: Boolean!): Distributor!
    deleteDistributor(id: ID!): Boolean!
  }
`;

export const mapDistributor = (r) =>
  r && {
    id: r.id,
    name: r.name,
    contactPerson: r.contact_person,
    phone: r.phone,
    email: r.email,
    gstin: r.gstin,
    dealerTier: r.dealer_tier,
    state: r.state,
    district: r.district,
    address: r.address,
    branchId: r.branch_id,
    creditLimit: num(r.credit_limit) ?? 0,
    outstanding: num(r.outstanding) ?? 0,
    creditAvailable: (num(r.credit_limit) ?? 0) - (num(r.outstanding) ?? 0),
    gpsLat: num(r.gps_lat),
    gpsLng: num(r.gps_lng),
    udyamNo: r.udyam_no,
    msmeType: r.msme_type,
    msmeRegistered: r.msme_registered ?? false,
    msmeRegDate: r.msme_reg_date ? String(r.msme_reg_date).slice(0, 10) : null,
    isActive: r.is_active,
    createdAt: r.created_at,
  };

const vals = (i) => [
  i.name,
  i.contactPerson ?? null,
  i.phone ?? null,
  i.email ?? null,
  i.gstin ?? null,
  i.dealerTier ?? null,
  i.state ?? null,
  i.district ?? null,
  i.address ?? null,
  i.branchId ?? null,
  i.creditLimit ?? 0,
  i.gpsLat ?? null,
  i.gpsLng ?? null,
  i.udyamNo ?? null,
  i.msmeType ?? null,
  i.msmeRegistered ?? false,
  i.msmeRegDate ?? null,
];

export function distributorResolvers() {
  return {
    Query: {
      distributors: async (_p, { search, activeOnly, limit, offset }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM distributors
           WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR gstin ILIKE '%' || $1 || '%' OR phone ILIKE '%' || $1 || '%')
             AND ($2::bool IS NULL OR is_active = $2)
           ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
          [search ?? null, activeOnly ?? null, limit, offset],
        );
        return rows.map(mapDistributor);
      },
      distributor: async (_p, { id }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query('SELECT * FROM distributors WHERE id = $1', [id]);
        return mapDistributor(rows[0]);
      },
      distributorStats: async (_p, _a, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE is_active)::int AS active,
                  COALESCE(SUM(outstanding),0) AS total_outstanding
           FROM distributors`,
        );
        return {
          total: rows[0].total,
          active: rows[0].active,
          totalOutstanding: num(rows[0].total_outstanding) ?? 0,
        };
      },
    },
    Mutation: {
      createDistributor: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `INSERT INTO distributors
             (name, contact_person, phone, email, gstin, dealer_tier, state, district, address, branch_id, credit_limit, gps_lat, gps_lng, udyam_no, msme_type, msme_registered, msme_reg_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
          vals(input),
        );
        await logActivity(actor.sub, 'CREATE_DISTRIBUTOR', 'distributor', rows[0].id);
        return mapDistributor(rows[0]);
      },
      updateDistributor: async (_p, { id, input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `UPDATE distributors SET
             name=$2, contact_person=$3, phone=$4, email=$5, gstin=$6, dealer_tier=$7,
             state=$8, district=$9, address=$10, branch_id=$11, credit_limit=$12, gps_lat=$13, gps_lng=$14,
             udyam_no=$15, msme_type=$16, msme_registered=$17, msme_reg_date=$18, updated_at=now()
           WHERE id=$1 RETURNING *`,
          [id, ...vals(input)],
        );
        if (!rows[0]) throw httpError('Distributor not found', 404);
        await logActivity(actor.sub, 'UPDATE_DISTRIBUTOR', 'distributor', id);
        return mapDistributor(rows[0]);
      },
      setDistributorActive: async (_p, { id, isActive }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          'UPDATE distributors SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *',
          [id, isActive],
        );
        if (!rows[0]) throw httpError('Distributor not found', 404);
        await logActivity(actor.sub, 'TOGGLE_DISTRIBUTOR', 'distributor', id);
        return mapDistributor(rows[0]);
      },
      deleteDistributor: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rowCount } = await query('DELETE FROM distributors WHERE id = $1', [id]);
        if (!rowCount) throw httpError('Distributor not found', 404);
        await logActivity(actor.sub, 'DELETE_DISTRIBUTOR', 'distributor', id);
        return true;
      },
    },
    Distributor: {
      branch: async (parent) => {
        if (!parent.branchId) return null;
        const { rows } = await query('SELECT * FROM branches WHERE id = $1', [parent.branchId]);
        const { mapBranch } = await import('./users.js');
        return mapBranch(rows[0]);
      },
    },
  };
}
