// GraphQL module: WhatsApp Campaign Console (Phase 4).
// Compose a broadcast (text / product card / advisory), pick an audience
// (farmers / distributors / all), and send via the WhatsApp service.

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity } from '../helpers.js';
import { sendWhatsApp, whatsappStatus } from '../../services/whatsapp/index.js';

export const whatsappTypeDefs = /* GraphQL */ `
  type WaCampaign {
    id: ID!
    campaignNo: String!
    name: String!
    audience: String!
    messageType: String!
    body: String!
    productId: ID
    productName: String
    imageUrl: String
    status: String!
    recipientsCount: Int!
    sentCount: Int!
    failedCount: Int!
    createdAt: DateTime!
    sentAt: DateTime
  }
  type WaMessage { id: ID!, name: String, phone: String, status: String!, error: String, sentAt: DateTime! }
  type WaStats { campaigns: Int!, sentTotal: Int!, configured: Boolean!, provider: String!, reachableFarmers: Int!, reachableDistributors: Int! }

  input WaCampaignInput {
    name: String!
    audience: String!          # FARMERS / DISTRIBUTORS / ALL
    messageType: String        # TEXT / PRODUCT / ADVISORY
    body: String!
    productId: ID
    imageUrl: String
  }

  extend type Query {
    waCampaigns(limit: Int = 100): [WaCampaign!]!
    waCampaign(id: ID!): WaCampaign
    waMessages(campaignId: ID!): [WaMessage!]!
    waStats: WaStats!
  }
  extend type Mutation {
    createWaCampaign(input: WaCampaignInput!): WaCampaign!
    sendWaCampaign(id: ID!): WaCampaign!
    deleteWaCampaign(id: ID!): Boolean!
  }
`;

const SELECT = `SELECT c.*, p.name product_name FROM whatsapp_campaigns c LEFT JOIN products p ON p.id = c.product_id`;
const mapCampaign = (r) => r && {
  id: r.id, campaignNo: r.campaign_no, name: r.name, audience: r.audience, messageType: r.message_type,
  body: r.body, productId: r.product_id, productName: r.product_name ?? null, imageUrl: r.image_url,
  status: r.status, recipientsCount: r.recipients_count, sentCount: r.sent_count, failedCount: r.failed_count,
  createdAt: r.created_at, sentAt: r.sent_at,
};

// Resolve recipients (with phones) for an audience.
async function recipientsFor(audience) {
  const out = [];
  if (audience === 'FARMERS' || audience === 'ALL') {
    const r = await query("SELECT id, name, phone, 'FARMER' party_type FROM farmers WHERE phone IS NOT NULL AND btrim(phone) <> ''");
    out.push(...r.rows);
  }
  if (audience === 'DISTRIBUTORS' || audience === 'ALL') {
    const r = await query("SELECT id, name, phone, 'DISTRIBUTOR' party_type FROM distributors WHERE is_active AND phone IS NOT NULL AND btrim(phone) <> ''");
    out.push(...r.rows);
  }
  return out;
}

export function whatsappResolvers() {
  return {
    Query: {
      waCampaigns: async (_p, { limit }, ctx) => { assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES'); const { rows } = await query(`${SELECT} ORDER BY c.created_at DESC LIMIT $1`, [limit]); return rows.map(mapCampaign); },
      waCampaign: async (_p, { id }, ctx) => { assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES'); const { rows } = await query(`${SELECT} WHERE c.id=$1`, [id]); return mapCampaign(rows[0]); },
      waMessages: async (_p, { campaignId }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query('SELECT * FROM whatsapp_messages WHERE campaign_id=$1 ORDER BY sent_at DESC LIMIT 1000', [campaignId]);
        return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, status: r.status, error: r.error, sentAt: r.sent_at }));
      },
      waStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT (SELECT COUNT(*) FROM whatsapp_campaigns)::int campaigns,
                  COALESCE((SELECT SUM(sent_count) FROM whatsapp_campaigns),0)::int sent_total,
                  (SELECT COUNT(*) FROM farmers WHERE phone IS NOT NULL AND btrim(phone) <> '')::int farmers,
                  (SELECT COUNT(*) FROM distributors WHERE is_active AND phone IS NOT NULL AND btrim(phone) <> '')::int distributors`,
        );
        const st = whatsappStatus();
        return { campaigns: rows[0].campaigns, sentTotal: rows[0].sent_total, configured: st.configured, provider: st.provider, reachableFarmers: rows[0].farmers, reachableDistributors: rows[0].distributors };
      },
    },

    Mutation: {
      createWaCampaign: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        if (!['FARMERS', 'DISTRIBUTORS', 'ALL'].includes(input.audience)) throw httpError('Invalid audience', 400);
        const type = ['TEXT', 'PRODUCT', 'ADVISORY'].includes(input.messageType) ? input.messageType : 'TEXT';
        const recipients = await recipientsFor(input.audience);
        const no = `WA-${String((await query("SELECT nextval('wacamp_seq') n")).rows[0].n).padStart(5, '0')}`;
        const { rows } = await query(
          `INSERT INTO whatsapp_campaigns (campaign_no, name, audience, message_type, body, product_id, image_url, recipients_count, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [no, input.name, input.audience, type, input.body, input.productId ?? null, input.imageUrl ?? null, recipients.length, a.sub],
        );
        await logActivity(a.sub, 'CREATE_WA_CAMPAIGN', 'whatsapp_campaign', rows[0].id, { no, recipients: recipients.length });
        return mapCampaign({ ...rows[0], product_name: null });
      },

      sendWaCampaign: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const camp = (await query('SELECT * FROM whatsapp_campaigns WHERE id=$1', [id])).rows[0];
        if (!camp) throw httpError('Campaign not found', 404);
        if (camp.status === 'SENT') throw httpError('Campaign already sent', 400);
        const recipients = await recipientsFor(camp.audience);

        let sent = 0, failed = 0;
        await withTransaction(async (client) => {
          for (const r of recipients) {
            const res = await sendWhatsApp({ to: r.phone, body: camp.body, mediaUrl: camp.image_url });
            const status = res.ok ? 'SENT' : 'FAILED';
            if (res.ok) sent += 1; else failed += 1;
            await client.query(
              'INSERT INTO whatsapp_messages (campaign_id, party_type, party_id, name, phone, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [id, r.party_type, r.id, r.name, r.phone, status, res.error ?? null],
            );
          }
          await client.query("UPDATE whatsapp_campaigns SET status='SENT', sent_count=$2, failed_count=$3, recipients_count=$4, sent_at=now() WHERE id=$1", [id, sent, failed, recipients.length]);
        });
        await logActivity(a.sub, 'SEND_WA_CAMPAIGN', 'whatsapp_campaign', id, { sent, failed });
        const { rows } = await query(`${SELECT} WHERE c.id=$1`, [id]);
        return mapCampaign(rows[0]);
      },

      deleteWaCampaign: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rowCount } = await query('DELETE FROM whatsapp_campaigns WHERE id=$1', [id]);
        if (!rowCount) throw httpError('Campaign not found', 404);
        await logActivity(a.sub, 'DELETE_WA_CAMPAIGN', 'whatsapp_campaign', id);
        return true;
      },
    },
  };
}
