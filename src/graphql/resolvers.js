// Composes resolver maps from all GraphQL modules into a single object for Mercurius.

import { GraphQLScalarType, Kind } from 'graphql';
import { userResolvers } from './modules/users.js';
import { productResolvers } from './modules/products.js';
import { pricingResolvers } from './modules/pricing.js';
import { distributorResolvers } from './modules/distributors.js';
import { inventoryResolvers } from './modules/inventory.js';
import { companyResolvers } from './modules/company.js';
import { orderResolvers } from './modules/orders.js';
import { gstResolvers } from './modules/gst.js';
import { loyaltyResolvers } from './modules/loyalty.js';
import { notificationResolvers } from './modules/notifications.js';
import { reportResolvers } from './modules/reports.js';
import { opsResolvers } from './modules/ops.js';
import { financeResolvers } from './modules/finance.js';
import { complaintResolvers } from './modules/complaints.js';
import { weatherResolvers } from './modules/weather.js';
import { langResolvers } from './modules/multilang.js';
import { engagementResolvers } from './modules/engagement.js';
import { procurementResolvers } from './modules/procurement.js';
import { manufacturingResolvers } from './modules/manufacturing.js';
import { aiResolvers } from './modules/ai.js';
import { returnsResolvers } from './modules/returns.js';
import { partyResolvers } from './modules/parties.js';
import { forecastResolvers } from './modules/forecast.js';
import { whatsappResolvers } from './modules/whatsapp.js';
import { farmerAppResolvers } from './modules/farmerApp.js';
import { distributorAppResolvers } from './modules/distributorApp.js';
import { enquiryResolvers } from './modules/enquiries.js';
import { redemptionResolvers } from './modules/redemptions.js';
import { translateResolvers } from './modules/translate.js';
import { financialsResolvers } from './modules/financials.js';

const DateTime = new GraphQLScalarType({
  name: 'DateTime',
  serialize: (v) => (v instanceof Date ? v.toISOString() : v),
  parseValue: (v) => new Date(v),
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? new Date(ast.value) : null),
});

const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: function parse(ast) {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.INT:
      case Kind.FLOAT:
        return Number(ast.value);
      case Kind.OBJECT:
        return Object.fromEntries(ast.fields.map((f) => [f.name.value, parse(f.value)]));
      case Kind.LIST:
        return ast.values.map(parse);
      case Kind.NULL:
        return null;
      default:
        return null;
    }
  },
});

/** Shallow-merge the Query/Mutation/type maps from each module. */
function mergeResolvers(maps) {
  const out = { DateTime, JSON: JSONScalar };
  for (const map of maps) {
    for (const [key, value] of Object.entries(map)) {
      out[key] = { ...(out[key] ?? {}), ...value };
    }
  }
  return out;
}

export function buildResolvers(app) {
  return mergeResolvers([
    userResolvers(app),
    productResolvers(app),
    pricingResolvers(app),
    distributorResolvers(app),
    inventoryResolvers(app),
    companyResolvers(app),
    orderResolvers(app),
    gstResolvers(app),
    loyaltyResolvers(app),
    notificationResolvers(app),
    reportResolvers(app),
    opsResolvers(app),
    financeResolvers(app),
    complaintResolvers(app),
    weatherResolvers(app),
    langResolvers(app),
    engagementResolvers(app),
    procurementResolvers(app),
    manufacturingResolvers(app),
    aiResolvers(app),
    returnsResolvers(app),
    partyResolvers(app),
    forecastResolvers(app),
    whatsappResolvers(app),
    farmerAppResolvers(app),
    distributorAppResolvers(app),
    enquiryResolvers(app),
    redemptionResolvers(app),
    translateResolvers(app),
    financialsResolvers(app),
  ]);
}
