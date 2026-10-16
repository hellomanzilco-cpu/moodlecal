import { loadEnvFile } from 'node:process';
import { loadConfig } from '../src/config.ts';
import { TelegramClient } from '../src/telegram.ts';
try {
  loadEnvFile('.env');
  const config=loadConfig();
  const response=await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`,{method:'POST',signal:AbortSignal.timeout(15000)});
  const data=await response.json();
  if(!response.ok || data.ok!==true || typeof data.result?.username!=='string' || !/^[a-zA-Z0-9_]+$/.test(data.result.username)) throw new Error('Unavailable');
  const webhook=await new TelegramClient(config.telegramToken).getWebhookInfo();
  console.log(JSON.stringify({bot:`https://t.me/${data.result.username}`,webhookRegistered:!!webhook.url}));
} catch {
  console.error('Could not inspect the bot. Check .env and network access. Bot credentials were not logged.');process.exitCode=1;
}
