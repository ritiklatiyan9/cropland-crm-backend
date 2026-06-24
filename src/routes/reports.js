// REST wrapper over the financial-statements mapping engine.
// The app is GraphQL-first; these endpoints exist because the spec asked for
// GET /api/reports/balance-sheet and /api/reports/profit-loss. They are thin
// shells over services/finance/financials.js and share the same auth (Bearer JWT).

import { buildBalanceSheet, buildProfitLoss } from '../services/finance/financials.js';
import { buildAgingReport } from '../services/finance/aging.js';

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

  // ── Aging / Group Outstandings ──────────────────────────────────────────────
  // Shared parser for ?asOn&fromDate&reportType&partyType&branchId&search&buckets
  // (buckets = comma-separated day cut-offs, e.g. 30,60,90).
  function parseAgingOpts(request) {
    const q = request.query ?? {};
    const buckets = q.buckets
      ? String(q.buckets).split(',').map((s) => parseInt(s.trim(), 10)).filter((x) => Number.isFinite(x) && x > 0)
      : undefined;
    return {
      asOn: q.asOn ?? null,
      fromDate: q.fromDate ?? null,
      reportType: (q.reportType ?? 'RECEIVABLE').toUpperCase(),
      partyType: q.partyType ?? null,
      branchId: q.branchId ?? null,
      search: q.search ?? null,
      buckets: buckets && buckets.length ? buckets : undefined,
    };
  }

  // JSON read model (the canonical machine-readable format).
  fastify.get('/api/reports/aging', { preHandler: fastify.authenticate }, async (request) => {
    return buildAgingReport(parseAgingOpts(request));
  });

  // Same payload, but as a downloadable .json attachment (for archival / sharing).
  fastify.get('/api/reports/aging.json', { preHandler: fastify.authenticate }, async (request, reply) => {
    const report = await buildAgingReport(parseAgingOpts(request));
    const fname = `aging-${report.meta.reportType.toLowerCase()}_as-on_${report.meta.asOn}.json`;
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${fname}"`);
    return JSON.stringify(report, null, 2);
  });
}
