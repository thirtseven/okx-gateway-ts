import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('storage');

export class StorageManager {
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? join(process.cwd(), 'data');
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }

  pairCsv(pair: string): string {
    const safe = pair.replace(/-/g, '_');
    return join(this.dataDir, `${safe}_4H.csv`);
  }

  async loadCandles(pair: string): Promise<Array<{ ts: number; open: number; high: number; low: number; close: number; vol: number }>> {
    const path = this.pairCsv(pair);
    if (!existsSync(path)) return [];

    try {
      const data = await readFile(path, 'utf-8');
      const lines = data.trim().split('\n');
      if (lines.length <= 1) return [];

      const headers = lines[0].split(',');
      const candles = [];

      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',');
        const candle: Record<string, number> = {};
        for (let j = 0; j < headers.length; j++) {
          candle[headers[j]] = Number(values[j]);
        }
        if (this.validateCandle(candle)) {
          candles.push(candle as { ts: number; open: number; high: number; low: number; close: number; vol: number });
        }
      }

      return candles.sort((a, b) => a.ts - b.ts);
    } catch (err) {
      logger.warn({ err, pair }, 'Failed to load candles');
      return [];
    }
  }

  async appendCandles(pair: string, candles: Array<{ ts: number; open: number; high: number; low: number; close: number; vol: number }>): Promise<void> {
    if (candles.length === 0) return;

    const path = this.pairCsv(pair);
    const existing = await this.loadCandles(pair);
    const existingTs = new Set(existing.map(c => c.ts));
    const newCandles = candles.filter(c => !existingTs.has(c.ts));

    if (newCandles.length === 0) return;

    const header = 'ts,open,high,low,close,vol\n';
    const rows = newCandles.map(c => `${c.ts},${c.open},${c.high},${c.low},${c.close},${c.vol}`).join('\n');

    if (existing.length === 0) {
      await writeFile(path, header + rows + '\n');
    } else {
      const existingData = await readFile(path, 'utf-8').catch(() => header);
      await writeFile(path, existingData.trimEnd() + '\n' + rows + '\n');
    }
  }

  private validateCandle(c: Record<string, number>): boolean {
    if (!c.ts || !c.open || !c.high || !c.low || !c.close) return false;
    if (c.high < c.low || c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) return false;
    return true;
  }
}

export const storageManager = new StorageManager();
