// REST wrapper over the financial-statements mapping engine.
// The app is GraphQL-first; these endpoints exist because the spec asked for
// GET /api/reports/balance-sheet and /api/reports/profit-loss. They are thin
// shells over services/finance/financials.js and share the same auth (Bearer JWT).

import { buildBalanceSheet, buildProfitLoss } from '../services/finance/financials.js';

export default async function reportRoutes(fastify) {
  // Parse the shared query string: ?fromDate&toDate&reportType&gstOnly
  function parseOpts(request) {
    const q = request.query ?? {};
    const gstOnly = q.gstOnly == null ? true : !['false', '0', 'no'].includes(String(q.gstOnly).toLowerCase());
    return {
      reportType: q.reportType ?? null,
      fromDate: q.fromDate ?? null,
      toDate: q.toDate ?? null,
      gstOnly,
    };
  }

  fastify.get('/api/reports/balance-sheet', { preHandler: fastify.authenticate }, async (request) => {
    return buildBalanceSheet(parseOpts(request));
  });

  fastify.get('/api/reports/profit-loss', { preHandler: fastify.authenticate }, async (request) => {
    return buildProfitLoss(parseOpts(request));
  });
}
