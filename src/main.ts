import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Vault } from './security.ts';
import { MoodleClient } from './moodle.ts';
import { TelegramClient, TelegramError } from './telegram.ts';
import {TelegramInbox} from './telegram-inbox.ts';
import { Bot } from './bot.ts';
import { SyncService } from './sync.ts';
import { createApp } from './api.ts';
import {AssignmentService} from './assignments.ts';
import {createEncryptedBackup,pruneEncryptedBackups} from './backups.ts';
import {RuntimeHealth} from './runtime-health.ts';

async function main() {
  process.umask(0o077);
  const config=loadConfig();
  const store=new Store(config.databasePath);
  store.markInterruptedConnectionAttempts();
  const vault=new Vault(config.encryptionKey);
  const moodle=new MoodleClient(config.moodleUrl);
  const runtime=new RuntimeHealth(!!config.telegramToken&&config.telegramMode==='polling');
  const telegram=config.telegramToken ? new TelegramClient(config.telegramToken,fetch,()=>{runtime.workerBeat();runtime.pollingBeat(true);}) : null;
  const messenger=telegram || {async send() { throw new Error('Telegram is not configured.'); }};
  const service=new SyncService(store,vault,moodle,messenger,config.publicUrl,config.pollSeconds,undefined,config.ownerTelegramId);
  const assignments=new AssignmentService(store,vault,moodle,messenger);
  const bot=new Bot(store,messenger,service,config.timezone,config.ownerTelegramId);
  const inbox=new TelegramInbox(store,vault,update=>bot.handle(update),undefined,update=>bot.isTransientChatText(update));
  const handleUpdate=async(update:unknown)=>{inbox.accept([update]);};
  const app=createApp(config,store,service,moodle,handleUpdate,assignments,runtime);
  const controller=new AbortController();
  const {signal}=controller;
  let backupWork:Promise<void>|null=null;
  const backupIfDue=()=>{
    if(backupWork||Date.now()/1000-Number(store.getMeta('encryptedBackupAt')||0)<86400)return;
    const work=(async()=>{try{await createEncryptedBackup(config.databasePath,config.encryptionKey);store.setMeta('encryptedBackupAt',String(Math.floor(Date.now()/1000)));pruneEncryptedBackups(config.databasePath);}catch{console.error('Encrypted backup failed; a later local maintenance cycle will retry.');}})();
    backupWork=work.finally(()=>{backupWork=null;});
  };
  let nextBackupCheck=0;
  if (telegram && config.telegramMode==='polling') {
    const info=await telegram.getWebhookInfo();
    if(info.url) throw new Error('This Telegram bot has an existing webhook. Use webhook mode or remove its webhook deliberately before polling.');
  }
  const address=await app.listen({host:config.host,port:config.port});
  const inboxTimer=setInterval(()=>{try{inbox.pump();runtime.inboxBeat();}catch{console.error('Command queue is unavailable; waiting for recovery.');}},250);inbox.pump();
  const watchdog=setInterval(()=>{if(runtime.stalled()){console.error('A background worker stalled. Restarting through the hosting policy.');process.exit(1);}},10000);watchdog.unref();
  console.info(`Moodle Calendar listening at ${address}. Telegram ${telegram ? config.telegramMode : 'not configured; local setup only'}. Moodle uses server events; interval checks are off.`);
  const worker=async () => {
    while(!signal.aborted) {
      runtime.workerBeat();
      try { await service.tick(); } catch { console.error('Background cycle failed; retrying.'); }
      runtime.workerBeat();
      if(Date.now()>nextBackupCheck){nextBackupCheck=Date.now()+3600000;backupIfDue();}
      try { await delay(15000,undefined,{signal}); } catch { break; }
    }
  };
  const polling=async () => {
    if(!telegram || config.telegramMode!=='polling') return;
    while(!signal.aborted) {
      try {
        runtime.pollingBeat();
        const updates=await telegram.getUpdates(Number(store.getMeta('telegramOffset')||0),signal);
        runtime.pollingBeat(true);
        if(!signal.aborted)inbox.accept(updates,true);
      } catch(error) {
        if(signal.aborted) break;
        console.error('Telegram update failed; retrying.');
        const wait=error instanceof TelegramError && error.retryAfter ? Math.max(5,error.retryAfter) : 5;
        try {let remaining=wait;while(remaining>0&&!signal.aborted){const chunk=Math.min(30,remaining);await delay(chunk*1000,undefined,{signal});remaining-=chunk;runtime.pollingBeat();}} catch { break; }
      }
    }
  };
  // The single process owns the SQLite database, polling loops, and update queue.
  const tasks=[worker(),polling()];
  const stop=() => {inbox.stop();controller.abort();};
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  await new Promise<void>(resolve => signal.addEventListener('abort',()=>resolve(),{once:true}));
  clearInterval(inboxTimer);clearInterval(watchdog);
  const deadline=setTimeout(()=>process.exit(1),25000);deadline.unref();
  await app.close(); await Promise.allSettled(tasks); await inbox.drain();await service.drain();await assignments.drain();if(backupWork)await backupWork;store.close();clearTimeout(deadline);
}
main().catch(() => { console.error('Moodle Calendar failed to start. Check environment configuration, database access, and Telegram webhook mode.');process.exit(1); });
