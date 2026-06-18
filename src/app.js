// Builds and configures the Fastify application instance.
// Registers infra plugins, security middleware, GraphQL (Mercurius), and REST routes.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import mercurius from 'mercurius';

import { env } from './config/env.js';
import dbPlugin from './plugins/db.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import { schema } from './graphql/schema.js';
import { buildResolvers } from './graphql/resolvers.js';
import { buildContext } from './graphql/context.js';
import { requestStore } from './utils/requestContext.js';
import healthRoutes from './routes/health.js';
import uploadRoutes from './routes/uploads.js';
import reportRoutes from './routes/reports.js';
import { startAuditCleanup } from './jobs/auditCleanup.js';

export async function buildApp() {
  const app = Fastify({
    // Honour X-Forwarded-For so the real client IP is captured behind a proxy.
    trustProxy: true,
    logger: {
      level: env.logLevel,
      transport: env.isProd
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
  });

  // Bind a request-scoped store (client IP) for deep helpers like the audit logger.
  app.addHook('onRequest', (request, _reply, done) => {
    requestStore.enterWith({ ip: request.ip });
    done();
  });

  // ── Security & utility middleware ──────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.corsOrigins, credentials: true });
  await app.register(sensible);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // ── Infrastructure plugins ─────────────────────────────────
  await app.register(dbPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // ── GraphQL (Mercurius) ────────────────────────────────────
  await app.register(mercurius, {
    schema,
    resolvers: buildResolvers(app),
    context: (request) => buildContext(request),
    graphiql: !env.isProd, // GraphiQL IDE available at /graphiql in dev
    path: '/graphql',
  });

  // ── REST routes ────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(uploadRoutes);
  await app.register(reportRoutes);

  app.get('/', async () => ({
    name: 'AgroERP Backend CRM',
    version: '1.0.0',
    graphql: '/graphql',
    graphiql: env.isProd ? null : '/graphiql',
    health: '/health',
  }));

  // ── Scheduled jobs ─────────────────────────────────────────
  const stopAuditCleanup = startAuditCleanup(app); // purge audit logs older than 7 days (daily)
  app.addHook('onClose', async () => stopAuditCleanup());

  return app;
}
