import { stateManager } from '../state/index.js';
import { exchangeClient } from '../exchange/index.js';
import { calcAllIndicators, getLatestIndicators } from '../indicators/index.js';
import { notifySignal } from '../notification/index.js';
import { getConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('workers');

const CIRCUIT_BREAK_LOSSES = 5;
const CIRCUIT_BREAK_DURATION = 900;
const PAIR_COOLDOWN_SECONDS = 1800;

let dataUpdaterTimer: ReturnType<typeof setTimeout> | null = null;
let priceUpdaterTimer: ReturnType<typeof setInterval> | null = null;
let strategyTickTimer: ReturnType<typeof setInterval> | null = null;
let statePersistTimer: ReturnType<typeof setInterval> | null = null;

function getTimeBasedTpHours(): number {
  return Math.min(50 * 15 / 60, 12);
}

function getFee(): number {
  return 0.0015;
}

function getLeverage(): number {
  return 3;
}

export async function startDataUpdater(): Promise<void> {
  const config = getConfig();

  const update = async () => {
    try {
      const pairs = stateManager.get('tradingPairs');
      logger.info(`Data updater: fetching ${pairs.length} pairs`);

      const results: Record<string, Record<string, unknown>> = {};
      const timing: Record<string, number> = {};
      const t0 = Date.now();

      for (const pair of pairs) {
        try {
          const candles = await exchangeClient.fetchPairCandles(pair);
          if (candles.length >= 10) {
            const indicators = calcAllIndicators(candles);
            if (indicators) {
              const latest = getLatestIndicators(indicators);
              if (latest) {
                results[pair] = {
                  pair,
                  signal: 'HOLD',
                  normLong: 0,
                  normShort: 0,
                  ...latest,
                  dataPoints: candles.length,
                };
              }
            }
          }
        } catch (err) {
          logger.warn({ err, pair }, 'Failed to process pair');
        }
      }

      timing.fetchMs = Date.now() - t0;

      stateManager.update(s => {
        s.indicatorCache = results;
        s.lastError = null;
        s.lastTiming = timing;
        s.lastUpdate = new Date().toISOString();
      });
      stateManager.markDirty();

      logger.info(`Data updater: ${Object.keys(results).length} pairs updated in ${timing.fetchMs}ms`);
    } catch (err) {
      logger.error({ err }, 'Data updater failed');
      stateManager.update(s => {
        s.lastError = `Data update failed: ${err}`;
      });
    }

    dataUpdaterTimer = setTimeout(update, config.UPDATE_INTERVAL);
  };

  await update();
}

export function startPriceUpdater(): void {
  const config = getConfig();

  const update = async () => {
    try {
      const pairs = stateManager.get('tradingPairs');
      logger.info(`Price updater: fetching ${pairs.length} prices`);

      const prices = await exchangeClient.fetchAllPrices(pairs);

      stateManager.update(s => {
        for (const [pair, ticker] of Object.entries(prices)) {
          s.priceCache[pair] = {
            last: ticker.last,
            open24h: ticker.open24h,
            vol24h: ticker.vol24h,
            ts: ticker.ts,
          };
        }
        s.priceUpdated = new Date().toISOString();
      });

      logger.info(`Price updater: ${Object.keys(prices).length} prices updated`);
    } catch (err) {
      logger.error({ err }, 'Price updater failed');
    }
  };

  update();
  priceUpdaterTimer = setInterval(update, config.PRICE_UPDATE_INTERVAL);
}

export function startStrategyTick(): void {
  const config = getConfig();

  const tick = async () => {
    try {
      if (!stateManager.get('strategyActive')) {
        return;
      }

      const now = new Date().toISOString();
      const signals: string[] = [];
      const fee = getFee();
      const leverage = getLeverage();
      const positionsToClose: Array<{
        pair: string;
        direction: string;
        entry: number;
        exit: number;
        exitReason: string;
        pnl: number;
        win: boolean;
        closedAt: string;
      }> = [];
      const positionsToOpen: Array<{
        pair: string;
        direction: string;
        entry: number;
        sl: number;
        tp: number;
        openedAt: string;
      }> = [];

      const state = stateManager.getState();
      const openPositions = [...state.openPositions];
      const indicatorCache = { ...state.indicatorCache };
      const priceCache = { ...state.priceCache };
      let consecutiveLosses = state.consecutiveLosses;
      let circuitBroken = state.circuitBroken;
      const pairLastClosed = { ...state.pairLastClosed };

      if (circuitBroken && state.circuitBrokenUntil) {
        if (Date.now() / 1000 < state.circuitBrokenUntil) {
          signals.push(`CIRCUIT BREAKER ACTIVE`);
        } else {
          circuitBroken = false;
          consecutiveLosses = 0;
          signals.push('CIRCUIT BREAKER CLEARED');
        }
      }

      for (const [pair, data] of Object.entries(indicatorCache)) {
        const pos = openPositions.find(p => p.pair === pair);
        const currentPrice = Number(priceCache[pair]?.last ?? 0) || Number(data.close ?? 0);

        if (!currentPrice || currentPrice === 0) continue;

        if (pos) {
          if (pos.sl && pos.tp) {
            let hit = false;
            let exitReason = '';

            if (pos.direction === 'LONG') {
              if (currentPrice <= pos.sl) { hit = true; exitReason = 'SL'; }
              if (currentPrice >= pos.tp) { hit = true; exitReason = 'TP'; }
            } else {
              if (currentPrice >= pos.sl) { hit = true; exitReason = 'SL'; }
              if (currentPrice <= pos.tp) { hit = true; exitReason = 'TP'; }
            }

            if (!hit) {
              const pnl = (currentPrice / pos.entry - 1) * leverage * (pos.direction === 'SHORT' ? -1 : 1);
              const openedAt = pos.openedAt ? new Date(pos.openedAt).getTime() : 0;
              const posAgeHours = openedAt ? (Date.now() - openedAt) / 3600000 : 0;

              if (posAgeHours >= getTimeBasedTpHours() && pnl > 0) {
                hit = true;
                exitReason = 'TIME_TP';
              }
            }

            if (hit) {
              let pnl = (currentPrice / pos.entry - 1) * leverage;
              if (pos.direction === 'SHORT') pnl = -pnl;
              pnl -= fee * 2;
              const win = pnl > 0;

              positionsToClose.push({
                pair, direction: pos.direction, entry: pos.entry,
                exit: currentPrice, exitReason, pnl: Math.round(pnl * 10000) / 100,
                win, closedAt: now,
              });

              if (!win) {
                consecutiveLosses++;
                if (consecutiveLosses >= CIRCUIT_BREAK_LOSSES) {
                  circuitBroken = true;
                }
              } else {
                consecutiveLosses = 0;
              }
            }
          }
        } else {
          const signal = data.signal as string;
          if (signal && signal !== 'HOLD' && !circuitBroken) {
            const cooldown = pairLastClosed[pair] ?? 0;
            if ((Date.now() / 1000 - cooldown) < PAIR_COOLDOWN_SECONDS) continue;

            const direction = signal;
            const entry = currentPrice;
            const atr = Number(data.atr14 ?? 1);
            const sl = direction === 'LONG' ? entry - atr * 3.65 : entry + atr * 3.65;
            const tp = direction === 'LONG' ? entry + atr * 5.51 : entry - atr * 5.51;

            positionsToOpen.push({ pair, direction, entry, sl, tp, openedAt: now });
            signals.push(`${pair} OPEN ${direction} @ ${entry}`);
          }
        }
      }

      stateManager.update(s => {
        for (const close of positionsToClose) {
          s.positionHistory.push({
            pair: close.pair, direction: close.direction as 'LONG' | 'SHORT',
            entry: close.entry, exit: close.exit, exitReason: close.exitReason,
            pnl: close.pnl, win: close.win, closedAt: close.closedAt,
          });
          s.openPositions = s.openPositions.filter(p => p.pair !== close.pair);
          s.pairLastClosed[close.pair] = Date.now() / 1000;
          if (circuitBroken) {
            s.circuitBroken = true;
            s.circuitBrokenUntil = Date.now() / 1000 + CIRCUIT_BREAK_DURATION;
          }
        }
        s.consecutiveLosses = consecutiveLosses;
        s.positionHistory = s.positionHistory.slice(-200);

        for (const open of positionsToOpen) {
          s.openPositions.push({
            pair: open.pair, direction: open.direction as 'LONG' | 'SHORT',
            entry: open.entry, sl: open.sl, tp: open.tp, openedAt: open.openedAt,
          });
        }

        s.strategyLog.unshift({
          time: now, signals, openPos: s.openPositions.length,
          consecutiveLosses, circuitBroken,
          winRate: s.positionHistory.length > 0
            ? Math.round(s.positionHistory.filter(h => h.win).length / s.positionHistory.length * 1000) / 10
            : 0,
        });
        s.strategyLog = s.strategyLog.slice(0, 100);
      });

      for (const close of positionsToClose) {
        notifySignal(state, close.pair, close.direction, close.exit, close.exitReason, close.pnl);
      }
      for (const open of positionsToOpen) {
        notifySignal(state, open.pair, open.direction, open.entry, 'OPEN');
      }

      if (positionsToClose.length > 0 || positionsToOpen.length > 0) {
        stateManager.markDirty();
      }

    } catch (err) {
      logger.error({ err }, 'Strategy tick failed');
    }
  };

  strategyTickTimer = setInterval(tick, config.STRATEGY_TICK_INTERVAL);
  tick();
}

export function startStatePersistor(): void {
  const config = getConfig();

  statePersistTimer = setInterval(async () => {
    if (stateManager.isDirty()) {
      await stateManager.save();
      logger.debug('State persisted');
    }
  }, config.STATE_PERSIST_INTERVAL);
}

export function stopAllWorkers(): void {
  if (dataUpdaterTimer) clearTimeout(dataUpdaterTimer);
  if (priceUpdaterTimer) clearInterval(priceUpdaterTimer);
  if (strategyTickTimer) clearInterval(strategyTickTimer);
  if (statePersistTimer) clearInterval(statePersistTimer);
}
