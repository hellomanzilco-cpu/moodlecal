import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.ts';
import { Vault } from '../src/security.ts';
import { SyncService } from '../src/sync.ts';
import { createApp } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import type { MoodleGateway } from '../src/types.ts';
import { MoodleError } from '../src/moodle.ts';
import {setImmediate as nextTurn} from 'node:timers/promises';

function fixture() {
  const config=loadConfig({ENCRYPTION_KEY:randomBytes(32).toString('base64'),PUBLIC_URL:'https://planner.test',TELEGRAM_MODE:'webhook',WEBHOOK_SECRET:'a'.repeat(43)});
  const store=new Store(':memory:');const vault=new Vault(config.encryptionKey);const now=Math.floor(Date.now()/1000);
  let usedPassword='';let fail=false;const updates:unknown[]=[];
  const moodle:MoodleGateway={async login(_u,p){usedPassword=p;return 'moodle-token';},async identify(){return {userId:10,name:'Student',functions:[]};},async snapshot(_token,_now,_only,progress){progress?.('profile');progress?.('synchronizing');if(fail)throw new Error('private error token secret');return {courses:[{id:1,name:'ECO',shortname:'ECO'}],items:[{key:'assignment:5',courseId:1,courseName:'ECO',kind:'assignment',title:'Essay',description:'Requirements',url:'https://moodle.uwed.uz/mod/assign/view.php?id=5',modifiedAt:now,dueAt:now+3600,startsAt:null,endsAt:null,completed:false,availability:'open'}],warnings:[]};}};
  const service=new SyncService(store,vault,moodle,{async send(){}},config.publicUrl,300);
  const app=createApp(config,store,service,moodle,async update=>{updates.push(update);});
  const s=store.ensureStudent(111,111);const raw=new URLSearchParams(new URL(service.connectLink(s.id)).hash.slice(1)).get('token')!;
  return {config,store,service,app,moodle,s,raw,updates,get usedPassword(){return usedPassword;},set fail(value:boolean){fail=value;}};
}
test('connection page opens as the Telegram Web App and keeps its one-time token out of the page body',async t => {
  const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});
  const response=await f.app.inject({url:'/connect'});assert.equal(response.statusCode,200);
  assert.match(String(response.headers['content-security-policy']),/frame-ancestors https:\/\/web\.telegram\.org/);
  assert.ok(!response.body.includes(f.raw));assert.match(response.body,/history\.replaceState/);assert.match(response.body,/telegram-web-app\.js/);
  assert.match(response.body,/id="username"/);assert.match(response.body,/id="password"/);assert.match(response.body,/id="consent"/);
  assert.match(response.body,/data-phase="connecting"/);assert.match(response.body,/data-phase="authenticating"/);assert.match(response.body,/data-phase="profile"/);assert.match(response.body,/data-phase="synchronizing"/);assert.match(response.body,/data-phase="dashboard"/);
  const privacy=await f.app.inject({url:'/privacy'});assert.equal(privacy.statusCode,200);assert.match(privacy.body,/Passwords entered in the Telegram Web App pass to the bot server/);assert.match(privacy.body,/Optional profile sharing is off by default/);assert.match(privacy.body,/saved encrypted, separately from analytics/);assert.match(privacy.body,/Stop sharing, reconnect or disconnect/);
});
test('connection progress belongs to its private attempt, follows actual stages and completes only after saving',async t=>{
 const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});
 let release!:()=>void;let reached!:()=>void;let releaseReachability!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>reached=resolve),reachability=new Promise<void>(resolve=>releaseReachability=resolve);
 const moodle:MoodleGateway={async checkReachable(){await reachability;},async login(){return 'private-token';},async identify(){return {userId:1,name:'Student',functions:[]};},async snapshot(_token,_now,_only,progress){progress?.('profile');progress?.('synchronizing');reached();await gate;return {courses:[],items:[],warnings:[]};}};
 const service=new SyncService(f.store,new Vault(f.config.encryptionKey),moodle,{async send(){}},f.config.publicUrl,300);
 const app=createApp(f.config,f.store,service,moodle,async()=>{});t.after(()=>app.close());
 const attemptId='a'.repeat(43),headers={origin:'https://planner.test'};
 const pending=app.inject({method:'POST',url:'/api/connect',headers,payload:{linkToken:f.raw,attemptId,username:'student',password:'secret-password',consent:true}}).then(response=>response);
 const read=(linkToken:string,attempt=attemptId)=>app.inject({method:'POST',url:'/api/connect/status',headers,payload:{linkToken,attemptId:attempt}});
 assert.equal((await read('b'.repeat(43))).statusCode,404);assert.equal((await read(f.raw,'c'.repeat(43))).statusCode,404);
 let state=await read(f.raw);assert.equal(state.json().phase,'connecting');assert.equal(state.json().percent,0);assert.equal(state.json().serverStatus,'pending');assert.equal(state.json().authStatus,'not_started');
 releaseReachability();await started;
 state=await read(f.raw);assert.equal(state.json().phase,'synchronizing');assert.equal(state.json().status,'working');assert.equal(state.json().percent,65);assert.equal(state.json().serverStatus,'reachable');assert.equal(state.json().authStatus,'verified');assert.equal(state.json().profileStatus,'loaded');assert.equal(state.json().syncStatus,'pending');
 assert.equal(f.store.getStudent(f.s.id)!.moodleCipher,null);assert.doesNotMatch(state.body,/private-token|secret-password|linkHash/);
 release();assert.equal((await pending).statusCode,200);const complete=await read(f.raw);assert.equal(complete.json().status,'complete');assert.equal(complete.json().percent,100);assert.equal(complete.json().dashboardStatus,'prepared');assert.ok(f.store.getStudent(f.s.id)!.moodleCipher);
});
test('language queries localize the sign-in and privacy pages without accepting arbitrary markup',async t=>{
 const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});
 for(const lang of ['uz','ru']){
   const page=await f.app.inject({url:'/connect?lang='+lang});assert.equal(page.statusCode,200);assert.match(page.body,new RegExp('<html lang="'+lang+'"'));
   const privacy=await f.app.inject({url:'/privacy?lang='+lang});assert.equal(privacy.statusCode,200);assert.match(privacy.body,/90/);assert.match(privacy.body,/Tursunov|Турсунов/);assert.match(privacy.body,/Telegram/);
 }
 const invalid=await f.app.inject({url:'/connect?lang='+encodeURIComponent('ru"><script>evil()</script>')});assert.match(invalid.body,/<html lang="en"/);assert.doesNotMatch(invalid.body,/evil\(\)/);
});
test('a Russian student gets a localized failed-status response while the Moodle error code stays intact',async t=>{
 const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});f.store.patchStudent(f.s.id,{language:'ru'});
 f.moodle.snapshot=async(_token,_now,_only,progress)=>{progress?.('profile');progress?.('synchronizing');const error=new MoodleError('private Moodle error',true,'network');error.operation='mod_assign_get_submission_status';error.apiErrorCode='timeout';throw error;};
 const headers={origin:f.config.publicUrl},attemptId='r'.repeat(43);
 assert.equal((await f.app.inject({method:'POST',url:'/api/connect',headers,payload:{linkToken:f.raw,attemptId,asyncMode:true,username:'private-name',password:'private-password',consent:true}})).statusCode,202);
 let state;for(let i=0;i<50;i++){state=await f.app.inject({method:'POST',url:'/api/connect/status',headers,payload:{linkToken:f.raw,attemptId}});if(state.json().status!=='working')break;await nextTurn();}
 assert.equal(state!.json().status,'failed');assert.match(state!.json().error,/обязательные данные курсов и заданий/);assert.doesNotMatch(state!.body,/private Moodle|private-password|private-name/);
 assert.equal(f.store.connectionAttempts(0)[0].apiErrorCode,'timeout');assert.equal(f.store.getStudent(f.s.id)!.moodleCipher,null);
});

test('invalid Moodle credentials are recorded at sign-in without being confused with access or network failures',async t=>{
 const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});
 const moodle:MoodleGateway={async login(){const error=new MoodleError('private raw response',false,'authentication');error.operation='login_token';error.apiErrorCode='invalidlogin';throw error;},async identify(){throw new Error('unused');},async snapshot(){throw new Error('unused');}};
 const service=new SyncService(f.store,new Vault(f.config.encryptionKey),moodle,{async send(){}},f.config.publicUrl,300);
 const app=createApp(f.config,f.store,service,moodle,async()=>{});t.after(()=>app.close());
 const response=await app.inject({method:'POST',url:'/api/connect',headers:{origin:f.config.publicUrl},payload:{linkToken:f.raw,username:'private-moodle-name',password:'private-password',consent:true}});
 assert.equal(response.statusCode,400);assert.match(response.body,/rejected the supplied username or password/);assert.doesNotMatch(response.body,/private-moodle-name|private-password|private raw response/);
 const row=f.store.connectionAttempts(0)[0];assert.equal(row.stage,'authenticating');assert.equal(row.failureCategory,'authentication');assert.equal(row.operation,'login_token');assert.equal(row.apiErrorCode,'invalidlogin');
});

test('accepted sign-in followed by synchronization failure is identified at step four and preserves saved assignments',async t=>{
 const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});await f.service.connect(f.raw,'old-private-token');
 const previous=f.store.getStudent(f.s.id)!.moodleCipher,items=f.store.items(f.s.id),raw=new URLSearchParams(new URL(f.service.connectLink(f.s.id)).hash.slice(1)).get('token')!;
 const config=loadConfig({ENCRYPTION_KEY:f.config.encryptionKey,PUBLIC_URL:f.config.publicUrl,OWNER_TELEGRAM_ID:'999'}),sent:{chatId:number;text:string}[]=[];
 const moodle:MoodleGateway={async login(){return 'new-private-token';},async identify(){return {userId:1,name:'Student',functions:[]};},async snapshot(_token,_now,_only,progress){progress?.('profile');progress?.('synchronizing');const error=new MoodleError('private raw Moodle error',false,'permission');error.operation='mod_assign_get_assignments';error.apiErrorCode='accessexception';error.httpStatus=403;throw error;}};
 const service=new SyncService(f.store,new Vault(config.encryptionKey),moodle,{async send(chatId,text){sent.push({chatId,text});}},config.publicUrl,300,undefined,999),app=createApp(config,f.store,service,moodle,async()=>{});t.after(()=>app.close());
 const attemptId='s'.repeat(43),headers={origin:config.publicUrl};assert.equal((await app.inject({method:'POST',url:'/api/connect',headers,payload:{linkToken:raw,attemptId,asyncMode:true,username:'private-moodle-name',password:'new-private-password',consent:true}})).statusCode,202);
 let state;for(let i=0;i<50;i++){state=await app.inject({method:'POST',url:'/api/connect/status',headers,payload:{linkToken:raw,attemptId}});if(state.json().status!=='working')break;await nextTurn();}
 assert.equal(state!.json().status,'failed');assert.equal(state!.json().phase,'synchronizing');assert.equal(state!.json().authStatus,'verified');assert.equal(state!.json().profileStatus,'loaded');assert.equal(state!.json().syncStatus,'failed');assert.match(state!.json().error,/accepted your sign-in/);assert.match(state!.json().error,/previous saved data is preserved/);
 assert.equal(f.store.getStudent(f.s.id)!.moodleCipher,previous);assert.deepEqual(f.store.items(f.s.id),items);const record=f.store.connectionAttempts(0)[0];assert.equal(record.stage,'synchronizing');assert.equal(record.operation,'mod_assign_get_assignments');assert.equal(record.apiErrorCode,'accessexception');
 assert.doesNotMatch(state!.body,/private raw|private-moodle-name|new-private-password|new-private-token/);assert.equal(sent.length,1);assert.equal(sent[0].chatId,999);assert.match(sent[0].text,/Telegram ID: 111/);assert.match(sent[0].text,/synchronization failed|could not be synchronized/);assert.match(sent[0].text,/mod_assign_get_assignments/);assert.match(sent[0].text,/accessexception/);assert.match(sent[0].text,/HTTP status: 403/);assert.match(sent[0].text,/CONN-/);assert.doesNotMatch(sent[0].text,/private-moodle-name|new-private-password|new-private-token|private raw Moodle error/);
});

test('limited coverage is saved as partial and sends a sanitized alert to the configured operator',async t=>{
 const config=loadConfig({ENCRYPTION_KEY:randomBytes(32).toString('base64'),PUBLIC_URL:'https://planner.test',OWNER_TELEGRAM_ID:'999'});
 const store=new Store(':memory:');t.after(()=>store.close());const vault=new Vault(config.encryptionKey),sent:{chatId:number;text:string}[]=[];
 const warning='Quiz availability and deadlines are unavailable; only course activity changes are monitored.';
 const moodle:MoodleGateway={async login(){return 'private-token';},async identify(){return {userId:1,name:'Student',functions:[]};},async snapshot(_token,_now,_only,progress){progress?.('profile');progress?.('synchronizing');return {courses:[],items:[],warnings:[warning]};}};
 const service=new SyncService(store,vault,moodle,{async send(chatId,text){sent.push({chatId,text});}},config.publicUrl,300,undefined,999);
 const student=store.ensureStudent(111,111);service.rememberTelegramDisplayName(student.id,'Amina','Student');const raw=new URLSearchParams(new URL(service.connectLink(student.id)).hash.slice(1)).get('token')!;
 const app=createApp(config,store,service,moodle,async()=>{});t.after(()=>app.close());const attemptId='p'.repeat(43),headers={origin:config.publicUrl};
 const accepted=await app.inject({method:'POST',url:'/api/connect',headers,payload:{linkToken:raw,attemptId,asyncMode:true,username:'private-moodle-name',password:'private-password',consent:true}});assert.equal(accepted.statusCode,202);
 let state;for(let i=0;i<50;i++){state=await app.inject({method:'POST',url:'/api/connect/status',headers,payload:{linkToken:raw,attemptId}});if(state.json().status!=='working')break;await nextTurn();}
 assert.equal(state!.json().status,'partial');assert.equal(state!.json().authStatus,'verified');assert.equal(state!.json().profileStatus,'loaded');assert.equal(state!.json().syncStatus,'partial');assert.deepEqual(state!.json().coverageWarnings,[warning]);assert.ok(store.getStudent(student.id)!.moodleCipher);
 const record=store.connectionAttempts(0)[0];assert.equal(record.status,'partial');assert.equal(record.stage,'synchronizing');assert.equal(record.failureCategory,'partial_coverage');assert.ok(record.displayNameCipher);assert.doesNotMatch(record.displayNameCipher!,/Amina|private-moodle-name|private-password/);
 assert.equal(sent.length,1);assert.equal(sent[0].chatId,999);assert.match(sent[0].text,/Amina Student/);assert.match(sent[0].text,/synchronization/);assert.match(sent[0].text,/CONN-/);assert.doesNotMatch(sent[0].text,/private-moodle-name|private-password|private-token|Quiz availability/);
});
test('submission-status failures stop newcomer and reconnect flows without replacing existing account data',async t=>{
  for(const reconnect of [false,true]){
    const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});
    if(reconnect)await f.service.connect(f.raw,'previous-account-token');
    const previous=f.store.getStudent(f.s.id)!,items=f.store.rawItems(f.s.id);
    const raw=reconnect?new URLSearchParams(new URL(f.service.connectLink(f.s.id)).hash.slice(1)).get('token')!:f.raw;
    f.moodle.snapshot=async(_token,_now,_only,progress)=>{progress?.('profile');progress?.('synchronizing');const error=new MoodleError('private Moodle response',true,'network');error.operation='mod_assign_get_submission_status';error.apiErrorCode='timeout';throw error;};
    const response=await f.app.inject({method:'POST',url:'/api/connect',headers:{origin:f.config.publicUrl},payload:{linkToken:raw,username:'private-student',password:'private-password',consent:true}});
    assert.equal(response.statusCode,503);assert.match(response.body,/required course and assignment data could not be synchronized/);assert.doesNotMatch(response.body,/private Moodle response|private-student|private-password/);
    const after=f.store.getStudent(f.s.id)!;assert.equal(after.moodleCipher,previous.moodleCipher);assert.equal(after.lastSyncAt,previous.lastSyncAt);assert.deepEqual(f.store.rawItems(f.s.id),items);
    const attempt=f.store.connectionAttempts(0)[0];assert.equal(attempt.status,'failed');assert.equal(attempt.stage,'synchronizing');assert.equal(attempt.operation,'mod_assign_get_submission_status');assert.equal(attempt.apiErrorCode,'timeout');
  }
});
test('connect enforces origin and uses one-time links; password is never returned or stored',async t => {
  const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});
  const payload={linkToken:f.raw,username:'alice',password:'very-secret-password',consent:true};
  const evil=await f.app.inject({method:'POST',url:'/api/connect',headers:{origin:'https://evil.test'},payload});assert.equal(evil.statusCode,403);
  const good=await f.app.inject({method:'POST',url:'/api/connect',headers:{origin:'https://planner.test'},payload});assert.equal(good.statusCode,200);assert.equal(f.usedPassword,payload.password);
  assert.doesNotMatch(good.body,/very-secret-password|moodle-token/);assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT * FROM students').all()),/very-secret-password|moodle-token/);
  const again=await f.app.inject({method:'POST',url:'/api/connect',headers:{origin:'https://planner.test'},payload});assert.equal(again.statusCode,400);
});
test('connection failures are sanitized and do not bind a Moodle token',async t => {
  const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});f.fail=true;
  const response=await f.app.inject({method:'POST',url:'/api/connect',headers:{origin:'https://planner.test'},payload:{linkToken:f.raw,token:'private-moodle-token',consent:true}});
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
test('connection requires explicit consent before any credential exchange',async t=>{
  const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});
  for(const consent of [undefined,false]){
    const response=await f.app.inject({method:'POST',url:'/api/connect',headers:{origin:'https://planner.test'},payload:{linkToken:f.raw,username:'alice',password:'private-password',consent}});
    assert.equal(response.statusCode,400);assert.equal(f.usedPassword,'');assert.equal(f.store.getStudent(f.s.id)!.moodleCipher,null);
  }
});
test('link preflight rejects expired and consumed links without contacting Moodle or revealing student data',async t=>{
  const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});
  const payload={linkToken:f.raw},headers={origin:f.config.publicUrl};
  const check=(value=payload,origin=headers)=>f.app.inject({method:'POST',url:'/api/connect/check',headers:origin,payload:value});
  assert.equal((await check(payload,{origin:'https://other.test'})).statusCode,403);
  const ready=await check();assert.equal(ready.statusCode,200);assert.deepEqual(ready.json(),{ok:true});
  assert.equal(f.usedPassword,'');assert.equal(f.store.getStudent(f.s.id)!.moodleCipher,null);
  assert.equal(f.store.connectionAttempts(0).length,0);
  assert.equal((await check({linkToken:'x'.repeat(43)})).statusCode,410);
  f.store.patchStudent(f.s.id,{linkExpires:Math.floor(Date.now()/1000)-1});
  assert.equal((await check()).json().code,'connection_expired');assert.equal(f.usedPassword,'');
  f.store.patchStudent(f.s.id,{linkExpires:Math.floor(Date.now()/1000)+300});
  await f.service.connect(f.raw,'moodle-token');
  assert.equal((await check()).statusCode,410);
  const expired=await f.app.inject({method:'POST',url:'/api/connect',headers,payload:{...payload,username:'student',password:'not-sent-to-moodle',consent:true}});
  assert.equal(expired.json().code,'connection_expired');assert.equal(f.usedPassword,'');
});
test('cloud connectivity failures return 503 without blaming credentials or consuming the connection link',async t=>{
 const f=fixture();t.after(async()=>{await f.app.close();f.store.close();});
 const moodle:MoodleGateway={async identify(){throw new Error('unused');},async snapshot(){throw new Error('unused');},async login(){throw new MoodleError('secret internal URL',true,'network');}};
 const app=createApp(f.config,f.store,f.service,moodle,async()=>{});t.after(()=>app.close());
 const response=await app.inject({method:'POST',url:'/api/connect',headers:{origin:'https://planner.test'},payload:{linkToken:f.raw,username:'alice',password:'private-password',consent:true}});
 assert.equal(response.statusCode,503);assert.match(response.body,/does not mean your credentials are wrong/);assert.doesNotMatch(response.body,/private-password|secret internal|Check your credentials/);
 assert.ok(f.store.byLink(f.store.getStudent(f.s.id)!.linkHash!,Math.floor(Date.now()/1000)));
});
