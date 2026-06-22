// Server bootstrap — builds the app, listens, and wires graceful shutdown.

import closeWithGrace from 'close-with-grace';
import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = await buildApp();

closeWithGrace({ delay: 10_000 }, async ({ err }) => {
  if (err) app.log.error({ err }, 'shutting down due to error..');
  await app.close();
});

try {
  await app.listen({ host: env.host, port: env.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
