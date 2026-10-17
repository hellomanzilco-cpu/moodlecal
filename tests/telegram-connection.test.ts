import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../src/api.ts';
import {loadConfig} from '../src/config.ts';
import {Vault} from '../src/security.ts';
import {Store} from '../src/store.ts';
import {SyncService} from '../src/sync.ts';
import {createTelegramConnectionRunner} from '../src/telegram-connection.ts';
import type {MoodleGateway} from '../src/types.ts';

test('Telegram connection runner reuses the server connection workflow and returns only actual progress',async t=>{
  const config=loadConfig({ENCRYPTION_KEY:randomBytes(32).toString('base64'),PUBLIC_URL:'https://planner.test',TELEGRAM_MODE:'webhook',WEBHOOK_SECRET:'w'.repeat(43)});
  const store=new Store(':memory:');const vault=new Vault(config.encryptionKey);const now=Math.floor(Date.now()/1000);
  t.after(()=>store.close());
  let receivedUsername='',receivedPassword='';
  const moodle:MoodleGateway={
    async checkReachable(){await delay(120);},
    async login(username,password){receivedUsername=username;receivedPassword=password;await delay(120);return 'private-moodle-token';},
    async identify(){return {userId:7,name:'Student',functions:[]};},
    async snapshot(_token,_now,_only,progress){progress?.('profile');await delay(8);progress?.('synchronizing');await delay(8);return {courses:[{id:7,name:'Economics',shortname:'ECON'}],items:[],warnings:[]};},
  };
  const service=new SyncService(store,vault,moodle,{async send(){}},config.publicUrl,300);
  const app=createApp(config,store,service,moodle,async()=>{});t.after(()=>app.close());
  const student=store.ensureStudent(101,101);const runner=createTelegramConnectionRunner(app,id=>service.connectionToken(id),config.publicUrl,1);
  const progress=[] as string[];
  const outcome=await runner(student.id,'moodle_user','private-chat-password',state=>{progress.push(state.phase+':'+state.status);});

  assert.equal(outcome.status,'complete');assert.equal(outcome.state?.serverStatus,'reachable');assert.equal(outcome.state?.authStatus,'verified');assert.equal(outcome.state?.profileStatus,'loaded');assert.equal(outcome.state?.syncStatus,'complete');assert.equal(outcome.state?.dashboardStatus,'prepared');
  for(const phase of ['connecting','authenticating','profile','synchronizing','dashboard'])assert.ok(progress.some(value=>value.startsWith(phase+':')),'missing '+phase+' progress: '+JSON.stringify(progress));
  assert.equal(receivedUsername,'moodle_user');assert.equal(receivedPassword,'private-chat-password');
  const connected=store.getStudent(student.id)!;assert.ok(connected.moodleCipher);assert.equal(vault.open(connected.moodleCipher!,`moodle:${student.id}`),'private-moodle-token');assert.equal(connected.linkHash,null);
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get()?.count),0,'Telegram chat flow should send its own dashboard without a duplicate generic outbox message');
  const retained=JSON.stringify(store.db.prepare('SELECT * FROM students').all())+JSON.stringify(store.connectionAttempts(0));
  assert.doesNotMatch(retained,/moodle_user|private-chat-password|private-moodle-token/);
});
