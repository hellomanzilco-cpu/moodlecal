import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.ts';
import { Vault } from '../src/security.ts';
import { SyncService } from '../src/sync.ts';
import { createApp } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import type { MoodleGateway } from '../src/types.ts';

function fixture() {
  const config=loadConfig({ENCRYPTION_KEY:randomBytes(32).toString('base64'),PUBLIC_URL:'https://planner.test',TELEGRAM_MODE:'webhook',WEBHOOK_SECRET:'a'.repeat(43)});
  const store=new Store(':memory:');const vault=new Vault(config.encryptionKey);const now=Math.floor(Date.now()/1000);
  let usedPassword='';let fail=false;const updates:unknown[]=[];
  const moodle:MoodleGateway={async login(_u,p){usedPassword=p;return 'moodle-token';},async identify(){return {userId:10,name:'Student',functions:[]};},async snapshot(){if(fail)throw new Error('private error token secret');return {courses:[{id:1,name:'ECO',shortname:'ECO'}],items:[{key:'assignment:5',courseId:1,courseName:'ECO',kind:'assignment',title:'Essay',description:'Requirements',url:'https://moodle.uwed.uz/mod/assign/view.php?id=5',modifiedAt:now,dueAt:now+3600,startsAt:null,endsAt:null,completed:false,availability:'open'}],warnings:[]};}};
  const service=new SyncService(store,vault,moodle,{async send(){}},config.publicUrl,300);
  const app=createApp(config,store,service,moodle,async update=>{updates.push(update);});
  const s=store.ensureStudent(111,111);const raw=new URLSearchParams(new URL(service.connectLink(s.id)).hash.slice(1)).get('token')!;
  return {config,store,service,app,s,raw,updates,get usedPassword(){return usedPassword;},set fail(value:boolean){fail=value;}};
}
test('connection page has no external assets, no bearer secret in HTML, and restrictive browser headers',async t => {
  const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});
  const response=await f.app.inject({url:'/connect'});assert.equal(response.statusCode,200);
  assert.equal(response.headers['referrer-policy'],'no-referrer');assert.match(String(response.headers['content-security-policy']),/default-src 'none'/);
  assert.ok(!response.body.includes(f.raw));assert.match(response.body,/history.replaceState/);assert.doesNotMatch(response.body,/<script src=/);
});
test('connect enforces origin and uses one-time links; password is never returned or stored',async t => {
  const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});
  const payload={linkToken:f.raw,username:'alice',password:'very-secret-password'};
  const evil=await f.app.inject({method:'POST',url:'/api/connect',headers:{origin:'https://evil.test'},payload});assert.equal(evil.statusCode,403);
  const good=await f.app.inject({method:'POST',url:'/api/connect',headers:{origin:'https://planner.test'},payload});assert.equal(good.statusCode,200);assert.equal(f.usedPassword,payload.password);
  assert.doesNotMatch(good.body,/very-secret-password|moodle-token/);assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT * FROM students').all()),/very-secret-password|moodle-token/);
  const again=await f.app.inject({method:'POST',url:'/api/connect',headers:{origin:'https://planner.test'},payload});assert.equal(again.statusCode,400);
});
test('connection failures are sanitized and do not bind a Moodle token',async t => {
  const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});f.fail=true;
  const response=await f.app.inject({method:'POST',url:'/api/connect',headers:{origin:'https://planner.test'},payload:{linkToken:f.raw,token:'private-moodle-token'}});
  assert.equal(response.statusCode,400);assert.doesNotMatch(response.body,/private-moodle-token|private error/);assert.equal(f.store.getStudent(f.s.id)!.moodleCipher,null);
});
test('calendar feed is private, supports revocation and disconnect, and serves only its owner data',async t => {
  const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});await f.service.connect(f.raw,'moodle-token');
  const path=new URL(f.service.calendarLink(f.s.id)).pathname;
  const response=await f.app.inject({url:path});assert.equal(response.statusCode,200);assert.match(String(response.headers['content-type']),/text\/calendar/);assert.match(response.body,/SUMMARY:ECO: Essay \(deadline\)/);
  const invalid=await f.app.inject({url:'/calendar/'+'x'.repeat(43)+'.ics'});assert.equal(invalid.statusCode,404);
  const rotated=new URL(f.service.calendarLink(f.s.id,true)).pathname;assert.equal((await f.app.inject({url:path})).statusCode,404);assert.equal((await f.app.inject({url:rotated})).statusCode,200);
  f.store.deleteStudent(f.s.id);assert.equal((await f.app.inject({url:rotated})).statusCode,404);
});
test('webhook accepts only the configured Telegram secret',async t => {
  const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});const payload={update_id:1};
  assert.equal((await f.app.inject({method:'POST',url:'/telegram/webhook',payload})).statusCode,403);
  assert.equal((await f.app.inject({method:'POST',url:'/telegram/webhook',headers:{'x-telegram-bot-api-secret-token':'wrong'},payload})).statusCode,403);
  assert.equal((await f.app.inject({method:'POST',url:'/telegram/webhook',headers:{'x-telegram-bot-api-secret-token':f.config.webhookSecret},payload})).statusCode,200);assert.deepEqual(f.updates,[payload]);
});
test('live HTTP listener serves health and setup readiness',async t => {
  const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});const url=await f.app.listen({host:'127.0.0.1',port:0});
  assert.deepEqual(await (await fetch(url+'/healthz')).json(),{ok:true});assert.equal((await fetch(url+'/readyz')).status,503);
});
