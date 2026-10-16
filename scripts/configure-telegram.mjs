import { loadConfig } from '../src/config.ts';
import { TelegramClient } from '../src/telegram.ts';
const config=loadConfig();
if (!config.telegramToken) throw new Error('Set TELEGRAM_BOT_TOKEN first.');
const telegram=new TelegramClient(config.telegramToken);
if (config.telegramMode!=='webhook') throw new Error('Set TELEGRAM_MODE=webhook before registering the webhook.');
await telegram.setWebhook(`${config.publicUrl}/telegram/webhook`,config.webhookSecret);
console.log('Telegram webhook configured. Start the service in webhook mode.');
