import pino from 'pino';
import { isDevelopment } from '../config/index.js';

const transport = isDevelopment()
  ? { target: 'pino-pretty', options: { colorize: true } }
  : undefined;

export const logger = pino({
  level: isDevelopment() ? 'debug' : 'info',
  transport,
});

export function createLogger(name: string) {
  return logger.child({ module: name });
}
