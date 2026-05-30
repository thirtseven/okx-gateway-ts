import nodemailer from 'nodemailer';
import { credentialManager } from '../credential/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('notification');

let transporter: nodemailer.Transporter | null = null;
let lastConfigHash: string | null = null;

function getConfigHash(): string | null {
  const cfg = credentialManager.getSmtpConfig();
  if (!cfg.enabled) return null;
  return `${cfg.sender}:${cfg.authCode}:${cfg.host}:${cfg.port}`;
}

function getOrCreateTransporter(): nodemailer.Transporter | null {
  const hash = getConfigHash();
  if (!hash) return null;

  if (hash === lastConfigHash && transporter) return transporter;

  const cfg = credentialManager.getSmtpConfig();
  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.sender, pass: cfg.authCode },
    connectionTimeout: 10000,
  });
  lastConfigHash = hash;
  logger.info(`SMTP connected to ${cfg.host}:${cfg.port}`);
  return transporter;
}

export async function sendTradeNotification(
  toEmail: string,
  subject: string,
  body: string
): Promise<boolean> {
  const transport = getOrCreateTransporter();
  if (!transport) {
    logger.debug('SMTP not configured, skipping');
    return false;
  }

  try {
    await transport.sendMail({
      from: credentialManager.getSmtpConfig().sender,
      to: toEmail,
      subject,
      text: body,
    });
    logger.info(`Email sent to ${toEmail}`);
    return true;
  } catch (err) {
    logger.error({ err }, `Failed to send email to ${toEmail}`);
    transporter = null;
    lastConfigHash = null;
    return false;
  }
}

export function notifySignal(
  state: { safeUsers: Array<{ email: string }> },
  pair: string,
  direction: string,
  price: number,
  sigType: string,
  pnl?: number
): void {
  if (!credentialManager.getSmtpConfig().enabled) return;
  if (sigType === 'HOLD') return;

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const directionCn = direction === 'LONG' ? '做多' : direction === 'SHORT' ? '做空' : '观望';
  const typeCn: Record<string, string> = {
    OPEN: '开仓信号', TP: '止盈平仓', SL: '止损平仓',
    TIME_TP: '时间止盈', LONG: '做多信号', SHORT: '做空信号',
  };
  const type = typeCn[sigType] ?? sigType;

  const lines = [
    'OKX量化网关信号通知', '',
    `时间: ${now}`, `交易对: ${pair}`,
    `方向: ${directionCn} (${direction})`,
    `价格: ${price}`, `类型: ${type}`,
  ];

  if (pnl !== undefined) {
    lines.push(`盈亏: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`);
  }

  lines.push('', '---', '来自 OKX 量化网关');
  const body = lines.join('\n');
  const subject = `【${type}】${pair} ${directionCn}`;

  const users = state.safeUsers ?? [];
  const seen = new Set<string>();
  for (const user of users) {
    if (seen.has(user.email)) continue;
    seen.add(user.email);
    sendTradeNotification(user.email, subject, body);
  }
}
