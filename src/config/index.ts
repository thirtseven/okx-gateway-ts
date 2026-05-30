import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const ConfigSchema = z.object({
  // Server
  PORT: z.coerce.number().default(5000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),

  // OKX
  OKX_BASE_URL: z.string().default('https://www.okx.com'),
  OKX_API_KEY: z.string().optional(),
  OKX_SECRET_KEY: z.string().optional(),
  OKX_PASSPHRASE: z.string().optional(),

  // Proxy
  HTTP_PROXY: z.string().optional(),
  HTTPS_PROXY: z.string().optional(),

  // Database
  DATABASE_URL: z.string().optional(),

  // Redis
  REDIS_URL: z.string().optional(),

  // SMTP
  SMTP_HOST: z.string().default('smtp.163.com'),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_SENDER: z.string().optional(),
  SMTP_AUTH_CODE: z.string().optional(),

  // Strategy
  CANDLE_BAR: z.string().default('4H'),
  CANDLE_LIMIT: z.coerce.number().default(200),
  UPDATE_INTERVAL: z.coerce.number().default(7200),
  PRICE_UPDATE_INTERVAL: z.coerce.number().default(30000),
  STRATEGY_TICK_INTERVAL: z.coerce.number().default(30000),
  STATE_PERSIST_INTERVAL: z.coerce.number().default(60000),

  // Model
  MODEL_DIR: z.string().default('./models'),
  ACTIVE_MODEL: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export function getProxy(): string | undefined {
  const config = getConfig();
  return config.HTTPS_PROXY || config.HTTP_PROXY;
}

export function isDevelopment(): boolean {
  return getConfig().NODE_ENV === 'development';
}

export function isProduction(): boolean {
  return getConfig().NODE_ENV === 'production';
}
