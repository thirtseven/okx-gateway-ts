import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('state');

export interface Position {
  pair: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  sl: number;
  tp: number;
  openedAt: string;
  entryBar?: number;
}

export interface PositionHistory {
  pair: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  exit: number;
  exitReason: string;
  pnl: number;
  win: boolean;
  closedAt: string;
}

export interface StrategyLogEntry {
  time: string;
  signals: string[];
  openPos: number;
  consecutiveLosses: number;
  circuitBroken: boolean;
  winRate: number;
}

export interface GatewayState {
  mode: 'safe' | 'running';
  safeUsers: Array<{ email: string }>;
  tradingPairs: string[];
  strategyActive: boolean;
  strategyLog: StrategyLogEntry[];
  priceCache: Record<string, { last: string; open24h: string; vol24h: string; ts: string }>;
  priceUpdated: string;
  lastError: string | null;
  lastUpdate: string;
  lastTiming: Record<string, number>;
  indicatorCache: Record<string, Record<string, unknown>>;
  dataStatus: Record<string, [number, string, string]>;
  openPositions: Position[];
  positionHistory: PositionHistory[];
  consecutiveLosses: number;
  circuitBroken: boolean;
  circuitBrokenUntil: number | null;
  pairLastClosed: Record<string, number>;
}

const DEFAULT_STATE: GatewayState = {
  mode: 'safe',
  safeUsers: [],
  tradingPairs: [],
  strategyActive: true,
  strategyLog: [],
  priceCache: {},
  priceUpdated: 'never',
  lastError: null,
  lastUpdate: 'never',
  lastTiming: {},
  indicatorCache: {},
  dataStatus: {},
  openPositions: [],
  positionHistory: [],
  consecutiveLosses: 0,
  circuitBroken: false,
  circuitBrokenUntil: null,
  pairLastClosed: {},
};

const PERSIST_KEYS: (keyof GatewayState)[] = [
  'mode', 'safeUsers', 'tradingPairs',
  'strategyActive', 'openPositions', 'positionHistory',
  'consecutiveLosses', 'circuitBroken', 'circuitBrokenUntil',
  'pairLastClosed',
];

class StateManager {
  private state: GatewayState;
  private dirty = false;
  private lock = Promise.resolve();
  private stateFile: string;

  constructor(dataDir?: string) {
    const dir = dataDir ?? join(process.cwd(), 'data');
    this.stateFile = join(dir, 'gateway_state.json');
    this.state = { ...DEFAULT_STATE };
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    await this.load();
  }

  private async acquireLock<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.lock;
    let release: () => void;
    this.lock = new Promise<void>((r) => { release = r; });
    await current;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  get<K extends keyof GatewayState>(key: K): GatewayState[K] {
    return this.state[key];
  }

  set<K extends keyof GatewayState>(key: K, value: GatewayState[K]): void {
    this.state[key] = value;
    this.markDirty();
  }

  update(fn: (state: GatewayState) => void): void {
    fn(this.state);
    this.markDirty();
  }

  getState(): Readonly<GatewayState> {
    return this.state;
  }

  markDirty(): void {
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  async save(): Promise<void> {
    await this.acquireLock(async () => {
      try {
        const persist: Record<string, unknown> = {};
        for (const key of PERSIST_KEYS) {
          if (key in this.state) {
            persist[key] = this.state[key];
          }
        }
        await writeFile(this.stateFile, JSON.stringify(persist, null, 2), 'utf-8');
        this.dirty = false;
        logger.debug('State saved');
      } catch (err) {
        logger.error({ err }, 'Failed to save state');
      }
    });
  }

  async load(): Promise<void> {
    await this.acquireLock(async () => {
      try {
        if (!existsSync(this.stateFile)) {
          logger.info('No state file found, using defaults');
          return;
        }
        const data = await readFile(this.stateFile, 'utf-8');
        const loaded = JSON.parse(data) as Partial<GatewayState>;
        for (const key of PERSIST_KEYS) {
          if (key in loaded) {
            (this.state as unknown as Record<string, unknown>)[key] = loaded[key];
          }
        }
        logger.info(`Loaded state: ${this.state.tradingPairs.length} pairs`);
      } catch (err) {
        logger.error({ err }, 'Failed to load state');
      }
    });
  }
}

export const stateManager = new StateManager();
