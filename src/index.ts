import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { getConfig } from './config/index.js';
import { stateManager } from './state/index.js';
import { credentialManager } from './credential/index.js';
import { storageManager } from './storage/index.js';
import { registerRoutes } from './api/index.js';
import { startDataUpdater, startPriceUpdater, startStrategyTick, startStatePersistor, stopAllWorkers } from './workers/index.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('main');

async function main() {
  const config = getConfig();

  logger.info('Starting OKX Gateway TypeScript v2.0.0');

  await credentialManager.init();
  credentialManager.applyToEnv();

  await storageManager.init();
  await stateManager.init();

  if (stateManager.get('tradingPairs').length === 0) {
    logger.info('No trading pairs found, will populate on first data update');
  } else {
    logger.info(`Loaded ${stateManager.get('tradingPairs').length} trading pairs`);
  }

  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  await registerRoutes(app);

  app.addHook('onClose', async () => {
    stopAllWorkers();
    await stateManager.save();
    logger.info('Gateway shutdown complete');
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...');
    await app.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    await app.close();
    process.exit(0);
  });

  await startDataUpdater();
  startPriceUpdater();
  startStrategyTick();
  startStatePersistor();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info(`Gateway listening on ${config.HOST}:${config.PORT}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

main().catch(err => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
