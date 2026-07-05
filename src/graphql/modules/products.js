// GraphQL module: Product Master (PRD §4.2).
// Single source of truth for the catalog — drives pricing, inventory, ordering
// and (later) AI recommendations. HSN + GST% here feed the E-Invoice engine.

import { query } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num } from '../helpers.js';
import { isAwsConfigured, getDownloadUrl } from '../../utils/aws.js';
import { env } from '../../config/env.js';

export const productTypeDefs = /* GraphQL */ `
  enum ProductCategory {
    PESTICIDE
    FERTILIZER
    SEED
    HERBICIDE
    FUNGICIDE
    INSECTICIDE
    BIO_PRODUCT
    OTHER
  }

  type Product {
    id: ID!
    name: String!
    sku: String!
    category: ProductCategory!
    technicalName: String
    imageKey: String
    imageUrl: String
    uom: String
    packingSize: String
    hsnCode: String
    gstPercent: Float
    mrp: Float
    dealerPrice: Float
    distributorPrice: Float
    targetCrops: [String!]!
    targetDiseases: [String!]!
    seasonTags: [String!]!
    recommendedDosage: String
    applicationFrequency: String
    safetyInstructions: String
    hazardCategory: String
    shelfLifeMonths: Int
    storageConditions: String
    isActive: Boolean!
    createdAt: DateTime!
  }

  type ProductStats {
    total: Int!
    active: Int!
    byCategory: [CategoryCount!]!
  }
  type CategoryCount {
    category: ProductCategory!
    count: Int!
  }

  input ProductInput {
    name: String!
    sku: String!
    category: ProductCategory!
    technicalName: String
    imageKey: String
    uom: String
    packingSize: String
    hsnCode: String
    gstPercent: Float
    mrp: Float
    dealerPrice: Float
    distributorPrice: Float
    targetCrops: [String!]
    targetDiseases: [String!]
    seasonTags: [String!]
    recommendedDosage: String
    applicationFrequency: String
    safetyInstructions: String
    hazardCategory: String
    shelfLifeMonths: Int
    storageConditions: String
  }

  extend type Query {
    products(search: String, category: ProductCategory, activeOnly: Boolean = true, limit: Int = 50, offset: Int = 0): [Product!]!
    product(id: ID!): Product
    productStats: ProductStats!
  }

  extend type Mutation {
    createProduct(input: ProductInput!): Product!
    updateProduct(id: ID!, input: ProductInput!): Product!
    setProductActive(id: ID!, isActive: Boolean!): Product!
    deleteProduct(id: ID!): Boolean!
    # Edit just the base prices (used by the Pricing → Base Prices screen).
    updateProductPrices(id: ID!, mrp: Float, dealerPrice: Float, distributorPrice: Float): Product!
  }
`;

export const mapProduct = (r) =>
  r && {
    id: r.id,
    name: r.name,
    sku: r.sku,
    category: r.category,
    technicalName: r.technical_name,
    imageKey: r.image_key,
    uom: r.uom,
    packingSize: r.packing_size,
    hsnCode: r.hsn_code,
    gstPercent: num(r.gst_percent),
    mrp: num(r.mrp),
    dealerPrice: num(r.dealer_price),
    distributorPrice: num(r.distributor_price),
    targetCrops: r.target_crops ?? [],
    targetDiseases: r.target_diseases ?? [],
    seasonTags: r.season_tags ?? [],
    recommendedDosage: r.recommended_dosage,
    applicationFrequency: r.application_frequency,
    safetyInstructions: r.safety_instructions,
    hazardCategory: r.hazard_category,
    shelfLifeMonths: r.shelf_life_months,
    storageConditions: r.storage_conditions,
    isActive: r.is_active,
    createdAt: r.created_at,
  };

function inputValues(input) {
  return [
    input.name,
    input.sku,
    input.category,
    input.technicalName ?? null,
    input.imageKey ?? null,
    input.uom ?? null,
    input.packingSize ?? null,
    input.hsnCode ?? null,
    input.gstPercent ?? null,
    input.mrp ?? null,
    input.dealerPrice ?? null,
    input.distributorPrice ?? null,
    input.targetCrops ?? [],
    input.targetDiseases ?? [],
    input.seasonTags ?? [],
    input.recommendedDosage ?? null,
    input.applicationFrequency ?? null,
    input.safetyInstructions ?? null,
    input.hazardCategory ?? null,
    input.shelfLifeMonths ?? null,
    input.storageConditions ?? null,
  ];
}

export function productResolvers() {
  return {
    Query: {
      products: async (_p, { search, category, activeOnly, limit, offset }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM products
           WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR sku ILIKE '%' || $1 || '%' OR technical_name ILIKE '%' || $1 || '%')
             AND ($2::text IS NULL OR category = $2::product_category)
             AND ($3::bool IS FALSE OR is_active = TRUE)
           ORDER BY name ASC LIMIT $4 OFFSET $5`,
          [search ?? null, category ?? null, activeOnly, limit, offset],
        );
        return rows.map(mapProduct);
      },
      product: async (_p, { id }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query('SELECT * FROM products WHERE id = $1', [id]);
        return mapProduct(rows[0]);
      },
      productStats: async (_p, _a, ctx) => {
        assertAuth(ctx);
        const totals = await query(
          `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active)::int AS active FROM products`,
        );
        const byCat = await query(
          'SELECT category, COUNT(*)::int AS count FROM products GROUP BY category ORDER BY category',
        );
        return {
          total: totals.rows[0].total,
          active: totals.rows[0].active,
          byCategory: byCat.rows.map((r) => ({ category: r.category, count: r.count })),
        };
      },
    },
    Mutation: {
      createProduct: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        let rows;
        try {
          ({ rows } = await query(
            `INSERT INTO products
               (name, sku, category, technical_name, image_key, uom, packing_size, hsn_code, gst_percent,
                mrp, dealer_price, distributor_price, target_crops, target_diseases, season_tags,
                recommended_dosage, application_frequency, safety_instructions, hazard_category,
                shelf_life_months, storage_conditions)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
             RETURNING *`,
            inputValues(input),
          ));
        } catch (err) {
          if (err.code === '23505') throw httpError('A product with this SKU already exists', 409);
          throw err;
        }
        await logActivity(actor.sub, 'CREATE_PRODUCT', 'product', rows[0].id, { sku: input.sku });
        return mapProduct(rows[0]);
      },
      updateProduct: async (_p, { id, input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        let rows;
        try {
          ({ rows } = await query(
            `UPDATE products SET
               name=$2, sku=$3, category=$4, technical_name=$5, image_key=$6, uom=$7, packing_size=$8,
               hsn_code=$9, gst_percent=$10, mrp=$11, dealer_price=$12, distributor_price=$13,
               target_crops=$14, target_diseases=$15, season_tags=$16, recommended_dosage=$17,
               application_frequency=$18, safety_instructions=$19, hazard_category=$20,
               shelf_life_months=$21, storage_conditions=$22, updated_at=now()
             WHERE id=$1 RETURNING *`,
            [id, ...inputValues(input)],
          ));
        } catch (err) {
          if (err.code === '23505') throw httpError('A product with this SKU already exists', 409);
          throw err;
        }
        if (!rows[0]) throw httpError('Product not found', 404);
        await logActivity(actor.sub, 'UPDATE_PRODUCT', 'product', id);
        return mapProduct(rows[0]);
      },
      setProductActive: async (_p, { id, isActive }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          'UPDATE products SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *',
          [id, isActive],
        );
        if (!rows[0]) throw httpError('Product not found', 404);
        await logActivity(actor.sub, isActive ? 'ACTIVATE_PRODUCT' : 'DEACTIVATE_PRODUCT', 'product', id);
        return mapProduct(rows[0]);
      },
      deleteProduct: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        let rowCount;
        try {
          ({ rowCount } = await query('DELETE FROM products WHERE id = $1', [id]));
        } catch (err) {
          // Referenced by orders/invoices/stock (ON DELETE RESTRICT) — a clean guard, not a 500.
          if (err.code === '23503') throw httpError('This product is used on orders or stock and cannot be deleted. Deactivate it instead.', 409);
          throw err;
        }
        if (!rowCount) throw httpError('Product not found', 404);
        await logActivity(actor.sub, 'DELETE_PRODUCT', 'product', id);
        return true;
      },
      updateProductPrices: async (_p, { id, mrp, dealerPrice, distributorPrice }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `UPDATE products SET
             mrp = COALESCE($2, mrp),
             dealer_price = COALESCE($3, dealer_price),
             distributor_price = COALESCE($4, distributor_price),
             updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, mrp ?? null, dealerPrice ?? null, distributorPrice ?? null],
        );
        if (!rows[0]) throw httpError('Product not found', 404);
        await logActivity(actor.sub, 'UPDATE_PRODUCT_PRICES', 'product', id, { mrp, dealerPrice, distributorPrice });
        return mapProduct(rows[0]);
      },
    },

    Product: {
      // Resolve the stored S3 key to a usable URL (public base URL or presigned GET).
      imageUrl: async (parent) => {
        if (!parent.imageKey) return null;
        if (env.aws.s3PublicBaseUrl) {
          return `${env.aws.s3PublicBaseUrl.replace(/\/$/, '')}/${parent.imageKey}`;
        }
        if (!isAwsConfigured) return null;
        try {
          return await getDownloadUrl(parent.imageKey, 3600);
        } catch {
          return null;
        }
      },
    },
  };
}
