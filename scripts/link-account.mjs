import { loadEnvFile } from 'node:process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { envValue } from '../src/env.ts';
import { MoodleClient } from '../src/moodle.ts';
import { Store } from '../src/store.ts';
import { Vault } from '../src/security.ts';
import { SyncService } from '../src/sync.ts';
let store;
try {
  loadEnvFile('.env');const config=loadConfig();
  const moodle=new MoodleClient(config.moodleUrl);
  const token=envValue(process.env,'MOODLE_TOKEN') || await moodle.login(envValue(process.env,'MOODLE_USERNAME') || '',envValue(process.env,'MOODLE_PASSWORD') || '');
  await moodle.identify(token);
  const response=await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`,{method:'POST',signal:AbortSignal.timeout(15000)});
  const data=await response.json();
  if(!response.ok || data.ok!==true || typeof data.result?.username!=='string' || !/^[A-Za-z0-9_]+$/.test(data.result.username)) throw new Error('Bot unavailable');
  store=new Store(config.databasePath);
  const service=new SyncService(store,new Vault(config.encryptionKey),moodle,{async send(){}},config.publicUrl,config.pollSeconds);
  const secret=service.beginPairing(token);
  const url=`https://t.me/${data.result.username}?start=pair_${secret}`;
  mkdirSync('data',{recursive:true});
  writeFileSync('data/private-telegram-setup.md',`# Private Telegram setup\n\n[Connect your verified Moodle account](${url})\n\nExpires in 15 minutes and can be used once. Keep this link private.\n`,{mode:0o600});
  console.log(JSON.stringify({setupFile:'data/private-telegram-setup.md',expiresInMinutes:15}));
} catch(error) {
  console.error(error?.name==='MoodleError' ? error.userMessage : 'Could not prepare the private Telegram setup link. Check .env and connectivity.');process.exitCode=1;
} finally {store?.close();delete process.env.MOODLE_PASSWORD;}
