import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('credential');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

const CREDENTIAL_TYPES = [
  'smtp_sender', 'smtp_auth_code', 'smtp_host', 'smtp_port',
  'db_host', 'db_port', 'db_user', 'db_password', 'db_name',
  'okx_api_key', 'okx_secret_key', 'okx_passphrase', 'api_key',
] as const;

type CredentialType = (typeof CREDENTIAL_TYPES)[number];

class CredentialManager {
  private cache: Map<string, string> = new Map();
  private initialized = false;
  private dataDir: string;
  private credentialsFile: string;
  private keyFile: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? join(process.cwd(), 'data');
    this.credentialsFile = join(this.dataDir, 'credentials.json');
    this.keyFile = join(this.dataDir, '.encryption_key');
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.dataDir, { recursive: true });
    await this.ensureKeyPermissions();
    await this.loadCredentials();
    this.initialized = true;
    const count = Array.from(this.cache.values()).filter(Boolean).length;
    logger.info(`Loaded ${count} credentials`);
  }

  private getEncryptionKey(): Buffer {
    if (existsSync(this.keyFile)) {
      const key = require('node:fs').readFileSync(this.keyFile);
      if (key.length === 32) return key;
    }
    const key = randomBytes(32);
    require('node:fs').writeFileSync(this.keyFile, key, { mode: 0o600 });
    logger.info('Generated new encryption key');
    return key;
  }

  private async ensureKeyPermissions(): Promise<void> {
    if (!existsSync(this.keyFile)) {
      this.getEncryptionKey();
    }
  }

  encrypt(text: string): string {
    if (!text) return '';
    const key = this.getEncryptionKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decrypt(encrypted: string): string {
    if (!encrypted) return '';
    try {
      const key = this.getEncryptionKey();
      const data = Buffer.from(encrypted, 'base64');
      const iv = data.subarray(0, IV_LENGTH);
      const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
      const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(ciphertext) + decipher.final('utf8');
    } catch (err) {
      logger.warn({ err }, 'Decryption failed');
      return '';
    }
  }

  private async loadCredentials(): Promise<void> {
    if (!existsSync(this.credentialsFile)) return;
    try {
      const data = await readFile(this.credentialsFile, 'utf-8');
      const stored = JSON.parse(data) as Record<string, string>;
      for (const [key, value] of Object.entries(stored)) {
        if ((CREDENTIAL_TYPES as readonly string[]).includes(key)) {
          this.cache.set(key, this.decrypt(value));
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load credentials');
    }
  }

  private async saveCredentials(): Promise<void> {
    const stored: Record<string, string> = {};
    for (const [key, value] of this.cache) {
      if (value) stored[key] = this.encrypt(value);
    }
    await writeFile(this.credentialsFile, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }

  get(type: CredentialType): string | undefined {
    return this.cache.get(type);
  }

  async set(type: CredentialType, value: string): Promise<void> {
    this.cache.set(type, value);
    await this.saveCredentials();
    logger.info(`Saved credential: ${type}`);
  }

  async remove(type: CredentialType): Promise<void> {
    this.cache.delete(type);
    await this.saveCredentials();
    logger.info(`Removed credential: ${type}`);
  }

  getStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const type of CREDENTIAL_TYPES) {
      status[type] = Boolean(this.cache.get(type));
    }
    return status;
  }

  getSmtpConfig() {
    return {
      host: this.get('smtp_host') || 'smtp.163.com',
      port: Number(this.get('smtp_port')) || 465,
      sender: this.get('smtp_sender'),
      authCode: this.get('smtp_auth_code'),
      enabled: Boolean(this.get('smtp_sender') && this.get('smtp_auth_code')),
    };
  }

  getDbConfig() {
    return {
      host: this.get('db_host') || '127.0.0.1',
      port: Number(this.get('db_port')) || 3306,
      user: this.get('db_user') || 'okx_trader',
      password: this.get('db_password'),
      database: this.get('db_name') || 'okx_gateway',
    };
  }

  getOkxConfig() {
    return {
      apiKey: this.get('okx_api_key'),
      secretKey: this.get('okx_secret_key'),
      passphrase: this.get('okx_passphrase'),
      configured: Boolean(this.get('okx_api_key')),
    };
  }

  applyToEnv(): void {
    const smtpSender = this.get('smtp_sender');
    const smtpAuth = this.get('smtp_auth_code');
    if (smtpSender) process.env.SMTP_SENDER = smtpSender;
    if (smtpAuth) process.env.SMTP_AUTH_CODE = smtpAuth;
  }
}

export const credentialManager = new CredentialManager();
