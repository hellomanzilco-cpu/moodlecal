import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Vault } from './security.ts';
import { MoodleClient } from './moodle.ts';
import { TelegramClient, TelegramError } from './telegram.ts';
import { Bot } from './bot.ts';
import { SyncService } from './sync.ts';
import { createApp } from './api.ts';
import {AssignmentService} from './assignments.ts';

async function main() {
  const config=loadConfig();
  const store=new Store(config.databasePath);
  const vault=new Vault(config.encryptionKey);
  const moodle=new MoodleClient(config.moodleUrl);
  const telegram=config.telegramToken ? new TelegramClient(config.telegramToken) : null;
  const messenger=telegram || {async send() { throw new Error('Telegram is not configured.'); }};
  const service=new SyncService(store,vault,moodle,messenger,config.publicUrl,config.pollSeconds);
  const assignments=new AssignmentService(store,vault,moodle,messenger);
  const bot=new Bot(store,messenger,service,config.timezone,config.ownerTelegramId);
  let queue=Promise.resolve();
  const handleUpdate=(update:unknown) => {
    const task=queue.then(async () => {
      try { await bot.handle(update); }
      catch(error) {
        if(error instanceof TelegramError && [400,403].includes(error.statusCode ?? 0)) {
          const id=(update as {update_id?:unknown})?.update_id;
          if(typeof id==='number' && Number.isSafeInteger(id)) store.finishUpdate(id,Math.floor(Date.now()/1000));
          return;
        }
        throw error;
      }
    });
    queue=task.catch(() => {});return task;
  };
  const app=createApp(config,store,service,moodle,handleUpdate,assignments);
  const controller=new AbortController();
  const {signal}=controller;
  if (telegram && config.telegramMode==='polling') {
    const info=await telegram.getWebhookInfo();
    if(info.url) throw new Error('This Telegram bot has an existing webhook. Use webhook mode or remove its webhook deliberately before polling.');
  }
  const address=await app.listen({host:config.host,port:config.port});
  console.info(`Moodle Calendar listening at ${address}. Telegram ${telegram ? config.telegramMode : 'not configured; local setup only'}. Moodle uses server events; interval checks are off.`);
  const worker=async () => {
    while(!signal.aborted) {
      try { await service.tick(); } catch { console.error('Background cycle failed; retrying.'); }
      try { await delay(15000,undefined,{signal}); } catch { break; }
    }
  };
  const polling=async () => {
    if(!telegram || config.telegramMode!=='polling') return;
    let offset=Number(store.getMeta('telegramOffset') || 0);
    while(!signal.aborted) {
      try {
        const updates=await telegram.getUpdates(offset,signal);
        for(const update of updates) {
          if(signal.aborted) break;
          await handleUpdate(update);
          const id=(update as {update_id?:unknown})?.update_id;
          if(typeof id==='number' && Number.isSafeInteger(id)) { offset=Math.max(offset,id+1);store.setMeta('telegramOffset',String(offset)); }
        }
      } catch(error) {
        if(signal.aborted) break;
        console.error('Telegram update failed; retrying.');
        const wait=error instanceof TelegramError && error.retryAfter ? Math.max(5,error.retryAfter) : 5;
        try { await delay(wait*1000,undefined,{signal}); } catch { break; }
      }
    }
  };
  // The single process owns the SQLite database, polling loops, and update queue.
  const tasks=[worker(),polling()];
  const stop=() => controller.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  await new Promise<void>(resolve => signal.addEventListener('abort',()=>resolve(),{once:true}));
  await app.close(); await Promise.allSettled(tasks); await queue; await service.drain();await assignments.drain(); store.close();
}
main().catch(() => { console.error('Moodle Calendar failed to start. Check environment configuration, database access, and Telegram webhook mode.');process.exitCode=1; });
