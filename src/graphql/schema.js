// Composed GraphQL SDL for the AgroERP / Cropland CRM API (Mercurius).
//
// Phase 1 scope: User & Role Management, Product Master, Pricing, Distributors,
// Inventory, Order-to-Cash, GST Compliance (E-Invoice + E-Way Bill), Loyalty.
// Each domain lives in src/graphql/modules/* and extends the base Query/Mutation.

import { userTypeDefs } from './modules/users.js';
import { productTypeDefs } from './modules/products.js';
import { pricingTypeDefs } from './modules/pricing.js';
import { distributorTypeDefs } from './modules/distributors.js';
import { inventoryTypeDefs } from './modules/inventory.js';
import { companyTypeDefs } from './modules/company.js';
import { orderTypeDefs } from './modules/orders.js';
import { gstTypeDefs } from './modules/gst.js';
import { loyaltyTypeDefs } from './modules/loyalty.js';
import { notificationTypeDefs } from './modules/notifications.js';
import { reportTypeDefs } from './modules/reports.js';
import { opsTypeDefs } from './modules/ops.js';
import { financeTypeDefs } from './modules/finance.js';
import { complaintTypeDefs } from './modules/complaints.js';
import { weatherTypeDefs } from './modules/weather.js';
import { langTypeDefs } from './modules/multilang.js';
import { engagementTypeDefs } from './modules/engagement.js';
import { procurementTypeDefs } from './modules/procurement.js';
import { manufacturingTypeDefs } from './modules/manufacturing.js';
import { aiTypeDefs } from './modules/ai.js';
import { returnsTypeDefs } from './modules/returns.js';
import { partyTypeDefs } from './modules/parties.js';
import { forecastTypeDefs } from './modules/forecast.js';
import { whatsappTypeDefs } from './modules/whatsapp.js';
import { farmerAppTypeDefs } from './modules/farmerApp.js';
import { distributorAppTypeDefs } from './modules/distributorApp.js';
import { enquiryTypeDefs } from './modules/enquiries.js';
import { redemptionTypeDefs } from './modules/redemptions.js';
import { translateTypeDefs } from './modules/translate.js';
import { financialsTypeDefs } from './modules/financials.js';

const baseTypeDefs = /* GraphQL */ `
  scalar DateTime
  scalar JSON

  type Query {
    _empty: String
  }

  type Mutation {
    _empty: String
  }
`;

export const schema = [
  baseTypeDefs,
  userTypeDefs,
  productTypeDefs,
  pricingTypeDefs,
  distributorTypeDefs,
  inventoryTypeDefs,
  companyTypeDefs,
  orderTypeDefs,
  gstTypeDefs,
  loyaltyTypeDefs,
  notificationTypeDefs,
  reportTypeDefs,
  opsTypeDefs,
  financeTypeDefs,
  complaintTypeDefs,
  weatherTypeDefs,
  langTypeDefs,
  engagementTypeDefs,
  procurementTypeDefs,
  manufacturingTypeDefs,
  aiTypeDefs,
  returnsTypeDefs,
  partyTypeDefs,
  forecastTypeDefs,
  whatsappTypeDefs,
  farmerAppTypeDefs,
  distributorAppTypeDefs,
  enquiryTypeDefs,
  redemptionTypeDefs,
  translateTypeDefs,
  financialsTypeDefs,
].join('\n');
