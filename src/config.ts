export interface Config {
  port: number; host: string; publicUrl: string; moodleUrl: string; databasePath: string;
  encryptionKey: string; telegramToken: string; webhookSecret: string;
  telegramMode: 'polling' | 'webhook'; pollSeconds: number; timezone: string;
  moodleEventSecret: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const railwayUrl=env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined;
  const publicUrl = (env.PUBLIC_URL || railwayUrl || env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('PUBLIC_URL must use HTTPS except for local development.');
  }
  const encryptionKey = env.ENCRYPTION_KEY || '';
  if (Buffer.from(encryptionKey, 'base64').length !== 32) throw new Error('Set a 32-byte base64 ENCRYPTION_KEY; run npm run setup.');
  const telegramMode = env.TELEGRAM_MODE || 'polling';
  if (!['polling', 'webhook'].includes(telegramMode)) throw new Error('TELEGRAM_MODE must be polling or webhook.');
  if (telegramMode === 'webhook' && (!env.WEBHOOK_SECRET || env.WEBHOOK_SECRET.length < 32)) throw new Error('Set WEBHOOK_SECRET (at least 32 characters).');
  const pollSeconds = Number(env.POLL_SECONDS || 300);
  if (!Number.isInteger(pollSeconds) || pollSeconds < 60) throw new Error('POLL_SECONDS must be at least 60.');
  const moodleUrl = (env.MOODLE_URL || 'https://moodle.uwed.uz').replace(/\/$/, '');
  if (new URL(moodleUrl).protocol !== 'https:') throw new Error('MOODLE_URL must use HTTPS.');
  const moodleEventSecret=env.MOODLE_EVENT_SECRET || '';
  if(moodleEventSecret && moodleEventSecret.length<32)throw new Error('MOODLE_EVENT_SECRET must contain at least 32 characters.');
  return {
    port: Number(env.PORT || 3000), host: env.HOST || (env.RENDER==='true' || env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PUBLIC_DOMAIN ? '0.0.0.0':'127.0.0.1'), publicUrl, moodleUrl,
    databasePath: env.DATABASE_PATH || './data/moodle-calendar.sqlite', encryptionKey,
    telegramToken: envValue(env,'TELEGRAM_BOT_TOKEN','Bot_token') || '', webhookSecret: env.WEBHOOK_SECRET || '',
    telegramMode: telegramMode as Config['telegramMode'], pollSeconds, timezone: env.DEFAULT_TIMEZONE || 'Asia/Tashkent',
    moodleEventSecret,
  };
}
import { envValue } from './env.ts';
