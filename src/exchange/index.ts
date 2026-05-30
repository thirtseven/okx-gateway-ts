import ccxt from 'ccxt';
import { getProxy } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('exchange');

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}

export interface Ticker {
  instId: string;
  last: string;
  open24h: string;
  vol24h: string;
  ts: string;
}

interface CacheEntry {
  candles: Candle[];
  lastTs: number;
  timestamp: number;
}

const CACHE_TTL_MS = 120_000;
const MAX_CONCURRENT = 5;
const INSTRUMENTS_CACHE_TTL = 3600_000;

class ExchangeClient {
  private exchange: InstanceType<typeof ccxt.okx>;
  private candleCache: Map<string, CacheEntry> = new Map();
  private instrumentsCache: { data: string[] | null; timestamp: number } = { data: null, timestamp: 0 };

  constructor() {
    const proxy = getProxy();
    this.exchange = new ccxt.okx({
      enableRateLimit: true,
      timeout: 30000,
    });
    if (proxy) {
      this.exchange.proxy = proxy;
    }
  }

  async fetchAllUsdtSwapInstruments(): Promise<string[]> {
    const now = Date.now();
    if (this.instrumentsCache.data && (now - this.instrumentsCache.timestamp) < INSTRUMENTS_CACHE_TTL) {
      return this.instrumentsCache.data;
    }

    try {
      const tickers = await this.exchange.fetchTickers();
      const usdtSwap = Object.keys(tickers)
        .filter(s => s.endsWith('/USDT:USDT'))
        .map(s => ({
          symbol: s,
          volume: tickers[s].quoteVolume ?? 0,
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 100)
        .map(t => t.symbol);

      this.instrumentsCache = { data: usdtSwap, timestamp: now };
      logger.info(`Discovered ${usdtSwap.length} USDT-SWAP pairs`);
      return usdtSwap;
    } catch (err) {
      logger.error({ err }, 'Failed to fetch instruments');
      return this.instrumentsCache.data ?? [];
    }
  }

  async fetchCandles(pair: string, limit = 200): Promise<Candle[]> {
    try {
      const ohlcv = await this.exchange.fetchOHLCV(pair, '4h', undefined, limit);
      const result: Candle[] = [];
      for (const c of ohlcv) {
        result.push({
          ts: Number(c[0] ?? 0),
          open: Number(c[1] ?? 0),
          high: Number(c[2] ?? 0),
          low: Number(c[3] ?? 0),
          close: Number(c[4] ?? 0),
          vol: Number(c[5] ?? 0),
        });
      }
      return result
        .filter(c => this.validateCandle(c))
        .sort((a, b) => a.ts - b.ts);
    } catch (err) {
      logger.warn({ err, pair }, 'Failed to fetch candles');
      return [];
    }
  }

  async fetchPairCandles(pair: string, retries = 2): Promise<Candle[]> {
    const cached = this.candleCache.get(pair);
    const cacheValid = cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS && cached.candles.length >= 200;

    if (cacheValid && cached.lastTs > 0) {
      const newCandles = await this.fetchCandles(pair, 100);
      if (newCandles.length > 0) {
        const merged = this.mergeCandles(cached.candles, newCandles);
        this.updateCache(pair, merged);
        return merged;
      }
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      const candles = await this.fetchCandles(pair);
      if (candles.length >= 10) {
        const existing = this.candleCache.get(pair)?.candles ?? [];
        const merged = this.mergeCandles(existing, candles);
        this.updateCache(pair, merged);
        return merged;
      }
      if (attempt < retries) {
        await this.sleep(1000 * (attempt + 1));
      }
    }

    return [];
  }

  async fetchTicker(pair: string): Promise<Ticker | null> {
    try {
      const ticker = await this.exchange.fetchTicker(pair);
      return {
        instId: pair,
        last: String(ticker.last ?? 0),
        open24h: String(ticker.open ?? 0),
        vol24h: String(ticker.quoteVolume ?? 0),
        ts: String(ticker.timestamp ?? 0),
      };
    } catch (err) {
      logger.warn({ err, pair }, 'Failed to fetch ticker');
      return null;
    }
  }

  async fetchAllPrices(pairs: string[]): Promise<Record<string, Ticker>> {
    const prices: Record<string, Ticker> = {};
    const semaphore = new Array(MAX_CONCURRENT).fill(null);
    let index = 0;

    const fetchNext = async (): Promise<void> => {
      while (index < pairs.length) {
        const i = index++;
        const pair = pairs[i];
        const ticker = await this.fetchTicker(pair);
        if (ticker) prices[pair] = ticker;
      }
    };

    await Promise.all(semaphore.map(() => fetchNext()));
    return prices;
  }

  private validateCandle(c: Candle): boolean {
    if (c.high < c.low || c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) return false;
    if (Math.abs(c.high) > 1e7 || Math.abs(c.low) > 1e7 || Math.abs(c.close) > 1e7) return false;
    return true;
  }

  private mergeCandles(cached: Candle[], fresh: Candle[]): Candle[] {
    const tsMap = new Map<number, Candle>();
    for (const c of cached) tsMap.set(c.ts, c);
    for (const c of fresh) tsMap.set(c.ts, c);
    return Array.from(tsMap.values()).sort((a, b) => a.ts - b.ts);
  }

  private updateCache(pair: string, candles: Candle[]): void {
    this.candleCache.set(pair, {
      candles,
      lastTs: candles.length > 0 ? candles[candles.length - 1].ts : 0,
      timestamp: Date.now(),
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

export const exchangeClient = new ExchangeClient();
