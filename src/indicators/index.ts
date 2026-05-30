import {
  RSI, MACD, BollingerBands, Stochastic, ATR, EMA,
} from 'technicalindicators';
import type { Candle } from '../exchange/index.js';

export interface Indicators {
  rsi14: (number | null)[];
  rsi7: (number | null)[];
  macd: (number | null)[];
  macdSignal: (number | null)[];
  macdHist: (number | null)[];
  bbPosition: number[];
  stochK: (number | null)[];
  stochD: (number | null)[];
  ema7: (number | null)[];
  ema25: (number | null)[];
  ema50: (number | null)[];
  atr14: (number | null)[];
  close: number[];
  timestamps: number[];
}

export interface LatestIndicators {
  rsi14: number;
  rsi7: number;
  macdHist: number;
  macdSignal: number;
  bbPosition: number;
  stochK: number;
  ema7: number;
  ema25: number;
  ema50: number;
  atr14: number;
  close: number;
  timestamps: number;
}

export interface RegimeParams {
  rsiOb: number;
  rsiOs: number;
  rsiWeight: number;
  macdWeight: number;
  bbWeight: number;
  bbThresh: number;
  bbThreshHi: number;
  stochWeight: number;
  stochOb: number;
  stochOs: number;
  emaWeight: number;
  scoreMin: number;
}

export interface Genome {
  regimeMode: 'auto' | 'bull' | 'bear' | 'range';
  regimes: Record<string, RegimeParams>;
  general: { leverage: number; fee: number };
}

const safeVal = (val: number | null | undefined, def = 0): number => {
  if (val === null || val === undefined || isNaN(val)) return def;
  return val;
};

export function calcEMA(data: number[], period: number): (number | null)[] {
  const result = EMA.calculate({ period, values: data });
  const padded = new Array(period - 1).fill(null);
  return [...padded, ...result];
}

export function calcRSI(closes: number[], period: number): (number | null)[] {
  const result = RSI.calculate({ period, values: closes });
  const padded = new Array(period).fill(null);
  return [...padded, ...result];
}

export function calcMACD(closes: number[]) {
  const result = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const padLen = closes.length - result.length;
  const pad = new Array(padLen).fill(null);
  return {
    macd: [...pad, ...result.map(r => r.MACD ?? null)],
    signal: [...pad, ...result.map(r => r.signal ?? null)],
    histogram: [...pad, ...result.map(r => r.histogram ?? null)],
  };
}

export function calcBB(closes: number[], period = 20): number[] {
  const result = BollingerBands.calculate({
    period,
    values: closes,
    stdDev: 2,
  });
  const padLen = closes.length - result.length;
  const positions: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < padLen) {
      positions.push(0.5);
    } else {
      const r = result[i - padLen];
      const range = r.upper - r.lower;
      positions.push(range === 0 ? 0.5 : (closes[i] - r.lower) / range);
    }
  }
  return positions;
}

export function calcStoch(highs: number[], lows: number[], closes: number[], kPeriod = 14, dPeriod = 3) {
  const result = Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: kPeriod,
    signalPeriod: dPeriod,
  });
  const padLen = closes.length - result.length;
  const pad = new Array(padLen).fill(null);
  return {
    k: [...pad, ...result.map(r => r.k ?? null)],
    d: [...pad, ...result.map(r => r.d ?? null)],
  };
}

export function calcATR(highs: number[], lows: number[], closes: number[], period = 14): (number | null)[] {
  const result = ATR.calculate({ high: highs, low: lows, close: closes, period });
  const padLen = closes.length - result.length;
  const pad = new Array(padLen).fill(null);
  return [...pad, ...result.map(r => r === 0 ? 1 : r)];
}

export function calcAllIndicators(candles: Candle[]): Indicators | null {
  if (candles.length < 50) return null;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const timestamps = candles.map(c => c.ts);

  const rsi14 = calcRSI(closes, 14);
  const rsi7 = calcRSI(closes, 7);
  const { macd, signal, histogram } = calcMACD(closes);
  const bbPosition = calcBB(closes);
  const { k: stochK, d: stochD } = calcStoch(highs, lows, closes);
  const ema7 = calcEMA(closes, 7);
  const ema25 = calcEMA(closes, 25);
  const ema50 = calcEMA(closes, 50);
  const atr14 = calcATR(highs, lows, closes);

  return {
    rsi14, rsi7, macd, macdSignal: signal, macdHist: histogram,
    bbPosition, stochK, stochD, ema7, ema25, ema50, atr14,
    close: closes, timestamps,
  };
}

export function getLatestIndicators(ind: Indicators): LatestIndicators | null {
  const n = ind.close.length;
  if (n === 0) return null;
  const i = n - 1;
  return {
    rsi14: safeVal(ind.rsi14[i], 50),
    rsi7: safeVal(ind.rsi7[i], 50),
    macdHist: safeVal(ind.macdHist[i]),
    macdSignal: safeVal(ind.macdSignal[i]),
    bbPosition: ind.bbPosition[i] ?? 0.5,
    stochK: safeVal(ind.stochK[i], 50),
    ema7: safeVal(ind.ema7[i]),
    ema25: safeVal(ind.ema25[i]),
    ema50: safeVal(ind.ema50[i]),
    atr14: safeVal(ind.atr14[i], 1),
    close: ind.close[i],
    timestamps: ind.timestamps[i],
  };
}

function detectTrend(ema20: number, ema50: number, threshold = 0.02): 'bull' | 'bear' | 'range' {
  if (Math.abs(ema50) < 1e-10) return 'range';
  const slope = (ema20 - ema50) / ema50;
  if (slope > threshold) return 'bull';
  if (slope < -threshold) return 'bear';
  return 'range';
}

export function computeSignal(
  latest: LatestIndicators,
  genome: Genome
): { signal: 'LONG' | 'SHORT' | 'HOLD'; longScore: number; shortScore: number } {
  const { close, ema25, ema50, atr14, rsi14, macdHist, macdSignal, bbPosition, stochK } = latest;

  if (close <= 0 || ema50 <= 0 || ema25 <= 0 || atr14 < 1e-6) {
    return { signal: 'HOLD', longScore: 0, shortScore: 0 };
  }

  const regime = genome.regimeMode === 'auto'
    ? detectTrend(ema25, ema50)
    : genome.regimeMode;

  const params: RegimeParams = genome.regimes?.[regime] ?? genome.regimes?.bull ?? {
    rsiOb: 76, rsiOs: 28, rsiWeight: 0.82, macdWeight: 0.89,
    bbWeight: 1.03, bbThresh: 0.3, bbThreshHi: 0.7,
    stochWeight: 0.95, stochOb: 83, stochOs: 25,
    emaWeight: 0.3, scoreMin: 1.5,
  };

  let longScore = 0;
  let shortScore = 0;

  if (rsi14 < params.rsiOs) longScore += params.rsiWeight + 0.3;
  else if (rsi14 < params.rsiOb) longScore += (params.rsiOb - rsi14) / params.rsiOb * params.rsiWeight;

  if (rsi14 > (100 - params.rsiOs)) shortScore += params.rsiWeight + 0.3;
  else if (rsi14 > params.rsiOs) shortScore += (rsi14 - params.rsiOb) / (100 - params.rsiOb) * params.rsiWeight;

  if (macdHist > 0) longScore += params.macdWeight * 0.5;
  if (macdHist < 0) shortScore += params.macdWeight * 0.5;
  if (macdSignal > 0) longScore += params.macdWeight * 0.3;
  if (macdSignal < 0) shortScore += params.macdWeight * 0.3;

  if (bbPosition < params.bbThresh) longScore += params.bbWeight * (params.bbThresh - bbPosition) / params.bbThresh;
  if (bbPosition > params.bbThreshHi) shortScore += params.bbWeight * (bbPosition - params.bbThreshHi) / (1 - params.bbThreshHi);

  if (stochK < params.stochOs) longScore += params.stochWeight * (params.stochOs - stochK) / params.stochOs;
  if (stochK > params.stochOb) shortScore += params.stochWeight * (stochK - params.stochOb) / (100 - params.stochOb);

  if (ema25 > ema50) longScore += params.emaWeight;
  if (ema25 < ema50) shortScore += params.emaWeight;

  let signal: 'LONG' | 'SHORT' | 'HOLD' = 'HOLD';
  if (regime === 'bull' && longScore >= params.scoreMin) signal = 'LONG';
  else if (regime === 'bear' && shortScore >= params.scoreMin) signal = 'SHORT';
  else if (regime === 'range') {
    if (longScore >= params.scoreMin && shortScore >= params.scoreMin) {
      signal = longScore > shortScore ? 'LONG' : 'SHORT';
    } else if (longScore >= params.scoreMin) signal = 'LONG';
    else if (shortScore >= params.scoreMin) signal = 'SHORT';
  }

  return { signal, longScore, shortScore };
}
