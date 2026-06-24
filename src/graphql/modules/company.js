// GraphQL module: Company Settings — seller profile shown on invoices/receipts.

import { query } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity } from '../helpers.js';
import { isAwsConfigured, getDownloadUrl } from '../../utils/aws.js';
import { env } from '../../config/env.js';
import { testGstApiConnection } from '../../services/gst/index.js';

export const companyTypeDefs = /* GraphQL */ `
  type CompanySettings {
    legalName: String!
    tradeName: String
    gstin: String
    pan: String
    cin: String
    email: String
    phone: String
    website: String
    addressLine1: String
    addressLine2: String
    city: String
    state: String
    pincode: String
    logoKey: String
    logoUrl: String
    bankName: String
    bankAccount: String
    bankIfsc: String
    bankBranch: String
    invoicePrefix: String!
    invoiceTerms: String
    gpsLat: Float
    gpsLng: Float
    distributorSuggestion: Boolean!
    # GST API / GSP integration (secrets are never returned — only "set" flags)
    gstApiProvider: String
    gstApiBaseUrl: String
    gstApiClientId: String
    gstApiUsername: String
    gstApiEnabled: Boolean!
    gstApiKeySet: Boolean!
    gstApiSecretSet: Boolean!
    gstApiPasswordSet: Boolean!
    gstApiConfigured: Boolean!
  }

  input GstApiSettingsInput {
    provider: String
    baseUrl: String
    clientId: String
    username: String
    apiKey: String      # secrets only update when a non-empty value is sent
    apiSecret: String
    password: String
    enabled: Boolean
  }

  type GstConnTest { ok: Boolean!, message: String! }

  input CompanySettingsInput {
    legalName: String!
    tradeName: String
    gstin: String
    pan: String
    cin: String
    email: String
    phone: String
    website: String
    addressLine1: String
    addressLine2: String
    city: String
    state: String
    pincode: String
    logoKey: String
    bankName: String
    bankAccount: String
    bankIfsc: String
    bankBranch: String
    invoicePrefix: String
    invoiceTerms: String
    gpsLat: Float
    gpsLng: Float
    distributorSuggestion: Boolean
  }

  extend type Query {
    companySettings: CompanySettings!
  }

  extend type Mutation {
    updateCompanySettings(input: CompanySettingsInput!): CompanySettings!
    setDistributorSuggestion(enabled: Boolean!): Boolean!
    updateGstApiSettings(input: GstApiSettingsInput!): CompanySettings!
    testGstApiConnection: GstConnTest!
  }
`;

export const mapCompany = (r) =>
  r && {
    legalName: r.legal_name,
    tradeName: r.trade_name,
    gstin: r.gstin,
    pan: r.pan,
    cin: r.cin,
    email: r.email,
    phone: r.phone,
    website: r.website,
    addressLine1: r.address_line1,
    addressLine2: r.address_line2,
    city: r.city,
    state: r.state,
    pincode: r.pincode,
    logoKey: r.logo_key,
    bankName: r.bank_name,
    bankAccount: r.bank_account,
    bankIfsc: r.bank_ifsc,
    bankBranch: r.bank_branch,
    invoicePrefix: r.invoice_prefix,
    invoiceTerms: r.invoice_terms,
    gpsLat: r.gps_lat == null ? null : Number(r.gps_lat),
    gpsLng: r.gps_lng == null ? null : Number(r.gps_lng),
    distributorSuggestion: r.distributor_suggestion ?? true,
    gstApiProvider: r.gst_api_provider ?? null,
    gstApiBaseUrl: r.gst_api_base_url ?? null,
    gstApiClientId: r.gst_api_client_id ?? null,
    gstApiUsername: r.gst_api_username ?? null,
    gstApiEnabled: r.gst_api_enabled ?? false,
    gstApiKeySet: !!r.gst_api_key,
    gstApiSecretSet: !!r.gst_api_secret,
    gstApiPasswordSet: !!r.gst_api_password,
    gstApiConfigured: !!(r.gst_api_enabled && r.gst_api_base_url && r.gst_api_key),
  };

export async function getCompany() {
  const { rows } = await query('SELECT * FROM company_settings WHERE id = 1');
  return rows[0];
}

export function companyResolvers() {
  return {
    Query: {
      companySettings: async (_p, _a, ctx) => {
        assertAuth(ctx);
        return mapCompany(await getCompany());
      },
    },
    Mutation: {
      updateCompanySettings: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `UPDATE company_settings SET
             legal_name=$1, trade_name=$2, gstin=$3, pan=$4, cin=$5, email=$6, phone=$7, website=$8,
             address_line1=$9, address_line2=$10, city=$11, state=$12, pincode=$13, logo_key=$14,
             bank_name=$15, bank_account=$16, bank_ifsc=$17, bank_branch=$18,
             invoice_prefix=COALESCE($19,'INV'), invoice_terms=$20,
             gps_lat=$21, gps_lng=$22, distributor_suggestion=COALESCE($23, distributor_suggestion), updated_at=now()
           WHERE id = 1 RETURNING *`,
          [
            input.legalName, input.tradeName ?? null, input.gstin ?? null, input.pan ?? null,
            input.cin ?? null, input.email ?? null, input.phone ?? null, input.website ?? null,
            input.addressLine1 ?? null, input.addressLine2 ?? null, input.city ?? null,
            input.state ?? null, input.pincode ?? null, input.logoKey ?? null,
            input.bankName ?? null, input.bankAccount ?? null, input.bankIfsc ?? null,
            input.bankBranch ?? null, input.invoicePrefix ?? null, input.invoiceTerms ?? null,
            input.gpsLat ?? null, input.gpsLng ?? null, input.distributorSuggestion ?? null,
          ],
        );
        if (!rows[0]) throw httpError('Company settings not found', 404);
        await logActivity(actor.sub, 'UPDATE_COMPANY_SETTINGS', 'company_settings', null);
        return mapCompany(rows[0]);
      },
      setDistributorSuggestion: async (_p, { enabled }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        await query('UPDATE company_settings SET distributor_suggestion = $1, updated_at = now() WHERE id = 1', [enabled]);
        await logActivity(actor.sub, 'TOGGLE_DISTRIBUTOR_SUGGESTION', 'company_settings', null, { enabled });
        return true;
      },

      // Secrets (apiKey/apiSecret/password) only overwrite when a non-empty value is sent,
      // so the UI can show "configured" without forcing a re-entry on every save.
      updateGstApiSettings: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `UPDATE company_settings SET
             gst_api_provider = $1, gst_api_base_url = $2, gst_api_client_id = $3, gst_api_username = $4,
             gst_api_key      = COALESCE(NULLIF($5,''), gst_api_key),
             gst_api_secret   = COALESCE(NULLIF($6,''), gst_api_secret),
             gst_api_password = COALESCE(NULLIF($7,''), gst_api_password),
             gst_api_enabled  = COALESCE($8, gst_api_enabled), updated_at = now()
           WHERE id = 1 RETURNING *`,
          [input.provider ?? null, input.baseUrl ?? null, input.clientId ?? null, input.username ?? null,
            input.apiKey ?? null, input.apiSecret ?? null, input.password ?? null, input.enabled ?? null],
        );
        await logActivity(actor.sub, 'UPDATE_GST_API_SETTINGS', 'company_settings', null, { provider: input.provider, enabled: input.enabled });
        return mapCompany(rows[0]);
      },

      testGstApiConnection: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        return testGstApiConnection();
      },
    },
    CompanySettings: {
      logoUrl: async (parent) => {
        if (!parent.logoKey) return null;
        if (env.aws.s3PublicBaseUrl) {
          return `${env.aws.s3PublicBaseUrl.replace(/\/$/, '')}/${parent.logoKey}`;
        }
        if (!isAwsConfigured) return null;
        try {
          return await getDownloadUrl(parent.logoKey, 3600);
        } catch {
          return null;
        }
      },
    },
  };
}
