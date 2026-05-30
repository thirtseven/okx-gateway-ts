import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { stateManager } from '../state/index.js';
import { credentialManager } from '../credential/index.js';
import { exchangeClient } from '../exchange/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('api');

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const state = stateManager.getState();
    return {
      status: 'ok',
      mode: state.mode,
      pairs: state.tradingPairs.length,
      openPositions: state.openPositions.length,
      lastUpdate: state.lastUpdate,
    };
  });

  app.get('/api/pairs', async () => {
    return { pairs: stateManager.get('tradingPairs') };
  });

  app.post('/api/pairs', async (req: FastifyRequest<{ Body: { pair: string } }>, reply: FastifyReply) => {
    const { pair } = req.body;
    if (!pair || !pair.endsWith('-USDT-SWAP')) {
      return reply.status(400).send({ ok: false, msg: 'Invalid pair format' });
    }

    const pairs = stateManager.get('tradingPairs');
    if (pairs.includes(pair)) {
      return reply.status(409).send({ ok: false, msg: 'Pair already active' });
    }

    try {
      const candles = await exchangeClient.fetchPairCandles(pair);
      if (candles.length < 10) {
        return reply.status(400).send({ ok: false, msg: 'Insufficient data' });
      }

      stateManager.update(s => {
        s.tradingPairs.push(pair);
      });
      stateManager.markDirty();

      return { ok: true, pairs: stateManager.get('tradingPairs') };
    } catch (err) {
      logger.error({ err, pair }, 'Failed to add pair');
      return reply.status(500).send({ ok: false, msg: 'Failed to add pair' });
    }
  });

  app.delete('/api/pairs/:pair', async (req: FastifyRequest<{ Params: { pair: string } }>) => {
    const { pair } = req.params;
    stateManager.update(s => {
      s.tradingPairs = s.tradingPairs.filter(p => p !== pair);
    });
    stateManager.markDirty();
    return { pairs: stateManager.get('tradingPairs') };
  });

  app.post('/api/pairs/add-all', async () => {
    try {
      const instruments = await exchangeClient.fetchAllUsdtSwapInstruments();
      const existing = new Set(stateManager.get('tradingPairs'));
      const toAdd = instruments.filter(p => !existing.has(p)).slice(0, 50);

      const added: string[] = [];
      for (const pair of toAdd) {
        try {
          const candles = await exchangeClient.fetchPairCandles(pair);
          if (candles.length >= 10) {
            stateManager.update(s => {
              s.tradingPairs.push(pair);
            });
            added.push(pair);
          }
        } catch {
          // Skip failed pairs
        }
      }

      if (added.length > 0) {
        stateManager.markDirty();
        await stateManager.save();
      }

      return { ok: true, added: added.length, total: stateManager.get('tradingPairs').length };
    } catch (err) {
      logger.error({ err }, 'Failed to add all pairs');
      return { ok: false, msg: 'Failed to fetch instruments' };
    }
  });

  app.get('/api/positions', async () => {
    const state = stateManager.getState();
    return {
      open: state.openPositions,
      history: state.positionHistory.slice(0, 50),
    };
  });

  app.get('/api/status', async () => {
    const state = stateManager.getState();
    return {
      mode: state.mode,
      strategyActive: state.strategyActive,
      pairs: state.tradingPairs.length,
      openPositions: state.openPositions.length,
      consecutiveLosses: state.consecutiveLosses,
      circuitBroken: state.circuitBroken,
      lastUpdate: state.lastUpdate,
      priceUpdated: state.priceUpdated,
    };
  });

  app.get('/api/strategy', async () => {
    const state = stateManager.getState();
    return {
      active: state.strategyActive,
      mode: state.mode,
      log: state.strategyLog.slice(0, 20),
    };
  });

  app.post('/api/strategy/toggle', async () => {
    stateManager.update(s => {
      s.strategyActive = !s.strategyActive;
    });
    stateManager.markDirty();
    return { active: stateManager.get('strategyActive') };
  });

  app.post('/api/mode', async (req: FastifyRequest<{ Body: { mode: string } }>) => {
    const { mode } = req.body;
    if (mode !== 'safe' && mode !== 'running') {
      return { ok: false, msg: 'Invalid mode' };
    }
    stateManager.set('mode', mode);
    return { mode: stateManager.get('mode') };
  });

  app.get('/api/users', async () => {
    return { users: stateManager.get('safeUsers') };
  });

  app.post('/api/users', async (req: FastifyRequest<{ Body: { email: string } }>) => {
    const { email } = req.body;
    if (!email) return { ok: false, msg: 'Email required' };

    const users = stateManager.get('safeUsers');
    if (users.some(u => u.email === email)) {
      return { ok: false, msg: 'User already exists' };
    }

    stateManager.update(s => {
      s.safeUsers.push({ email });
    });
    stateManager.markDirty();
    return { ok: true, users: stateManager.get('safeUsers') };
  });

  app.delete('/api/users/:idx', async (req: FastifyRequest<{ Params: { idx: string } }>) => {
    const idx = Number(req.params.idx);
    stateManager.update(s => {
      s.safeUsers.splice(idx, 1);
    });
    stateManager.markDirty();
    return { users: stateManager.get('safeUsers') };
  });

  app.get('/api/credentials', async () => {
    return credentialManager.getStatus();
  });

  app.post('/api/credentials', async (req: FastifyRequest<{ Body: Record<string, string> }>) => {
    const body = req.body;
    for (const [key, value] of Object.entries(body)) {
      if (value) {
        await credentialManager.set(key as any, value);
      }
    }
    credentialManager.applyToEnv();
    return { ok: true, status: credentialManager.getStatus() };
  });

  app.get('/api/prices', async () => {
    return stateManager.get('priceCache');
  });

  app.get('/api/indicators', async () => {
    const state = stateManager.getState();
    return {
      lastUpdate: state.lastUpdate,
      timing: state.lastTiming,
      pairCount: Object.keys(state.indicatorCache).length,
    };
  });
}
