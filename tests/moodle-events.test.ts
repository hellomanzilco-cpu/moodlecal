import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { Store } from '../src/store.ts';
import { Vault } from '../src/security.ts';
import { SyncService } from '../src/sync.ts';
import { createApp } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { parseMoodleEvent, verifyMoodleSignature } from '../src/moodle-events.ts';
import type { MoodleChangeEvent } from '../src/moodle-events.ts';
import type { MoodleGateway, Snapshot } from '../src/types.ts';
import { priorityItems } from '../src/planning.ts';
import { renderCalendar } from '../src/calendar.ts';

const event=(id='a'.repeat(32),courseId=1):MoodleChangeEvent=>({eventId:id,eventName:'\\core\\event\\course_module_updated',courseId,occurredAt:1_999_999_000});
function fixture(){
  let now=2_000_000_000;let fail=false;let title='Essay';
  const store=new Store(':memory:');const vault=new Vault(randomBytes(32).toString('base64'));
  const calls:string[]=[];const sent:{chatId:number;text:string}[]=[];
  const snapshot=(courseId:number):Snapshot=>({courses:[{id:courseId,name:'Course '+courseId,shortname:'C'+courseId}],items:[{key:'assignment:'+courseId,courseId,courseName:'Course '+courseId,kind:'assignment',title,description:'Brief',url:'https://moodle.uwed.uz/mod/assign/view.php?id='+courseId,modifiedAt:1,dueAt:now+10000,startsAt:null,endsAt:null,completed:false,availability:'open'}],warnings:[]});
  const moodle:MoodleGateway={async identify(){return {userId:1,name:'Student',functions:[]};},async login(){return 'tokenA';},async snapshot(token){calls.push(token);if(fail)throw new Error('unavailable');return snapshot(token==='tokenA'?1:2);}};
  const service=new SyncService(store,vault,moodle,{async send(chatId,text){sent.push({chatId,text});}},'https://planner.test',300,()=>now);
  const a=store.ensureStudent(101,101),b=store.ensureStudent(202,202);
  for(const [s,token,id] of [[a,'tokenA',1],[b,'tokenB',2]] as const){store.patchStudent(s.id,{moodleCipher:vault.seal(token,`moodle:${s.id}`)});store.saveSnapshot(s.id,snapshot(id),[],now-1000,now-10);}
  return {store,vault,moodle,service,a,b,calls,sent,snapshot,get now(){return now;},set now(v:number){now=v;},set fail(v:boolean){fail=v;},set title(v:string){title=v;}};
}
test('signed Moodle events verify exact bytes, fresh timestamps and reject tampering',()=>{
  const secret='x'.repeat(43);const now=2_000_000_000;const timestamp=String(now);
  const body=Buffer.from(JSON.stringify(event()));
  const signature=createHmac('sha256',secret).update(timestamp+'.').update(body).digest('hex');
  assert.equal(verifyMoodleSignature(secret,timestamp,signature,body,now),true);
  assert.equal(verifyMoodleSignature(secret,timestamp,signature,Buffer.from(body.toString()+' '),now),false);
  assert.equal(verifyMoodleSignature(secret,timestamp,signature,body,now+301),false);
  assert.equal(verifyMoodleSignature('wrong',timestamp,signature,body,now),false);
  assert.deepEqual(parseMoodleEvent(body,now),event());
  assert.equal(parseMoodleEvent(Buffer.from(JSON.stringify({...event(),token:'unexpected'})),now),null);
  assert.equal(parseMoodleEvent(Buffer.from('{bad json'),now),null);
});
test('background ticks never query Moodle without an inbound event even when legacy nextSyncAt is overdue',async t=>{
  const f=fixture();t.after(()=>f.store.close());await f.service.tick();f.now+=86400;await f.service.tick();
  assert.deepEqual(f.calls,[]);
});
test('Moodle course events sync affected students and send changes without a student command',async t=>{
  const f=fixture();t.after(()=>f.store.close());f.title='New assignment requirements';
  const result=f.store.acceptMoodleEvent(event(),f.now);assert.equal(result.queued,1);
  await f.service.tick();assert.deepEqual(f.calls,['tokenA']);
  assert.equal(f.sent.filter(message=>message.text.startsWith('Updated assignment:')).length,1);
  assert.ok(f.sent.every(message=>message.chatId===101));assert.match(f.sent[0].text,/New assignment requirements/);
  assert.equal(f.store.rawItems(f.b.id)[0].title,'Essay');
  assert.equal(f.store.acceptMoodleEvent(event(),f.now).duplicate,true);await f.service.tick();assert.equal(f.calls.length,1);
});
test('multiple events coalesce and failed event jobs retry without replacing snapshots',async t=>{
  const f=fixture();t.after(()=>f.store.close());f.store.acceptMoodleEvent(event(),f.now);f.store.acceptMoodleEvent(event('b'.repeat(32)),f.now);
  assert.equal(f.store.pendingMoodleJobs(f.now).length,1);f.fail=true;await f.service.tick();assert.equal(f.calls.length,1);
  assert.equal(f.store.rawItems(f.a.id)[0].title,'Essay');assert.equal(f.store.pendingMoodleJobs(f.now).length,0);
  await f.service.tick();assert.equal(f.calls.length,1);f.now+=16;f.fail=false;await f.service.tick();assert.equal(f.calls.length,2);assert.equal(f.store.pendingMoodleJobs(f.now).length,0);
  f.now+=86400;await f.service.tick();assert.equal(f.calls.length,2);
});
test('an event received during a sync cannot be erased by acknowledging an earlier revision',async t=>{
  const f=fixture();t.after(()=>f.store.close());let release!:(s:Snapshot)=>void;let requests=0;
  f.moodle.snapshot=async()=>{requests++;return requests===1 ? new Promise(resolve=>{release=resolve;}) : f.snapshot(1);};
  f.store.acceptMoodleEvent(event(),f.now);const work=f.service.processEvents();await new Promise(resolve=>setImmediate(resolve));
  f.store.acceptMoodleEvent(event('b'.repeat(32)),f.now);release(f.snapshot(1));await work;assert.equal(requests,2);
});
test('paused students do not receive event syncs until resumed and enrolment events can discover new courses',async t=>{
  const f=fixture();t.after(()=>f.store.close());f.store.patchStudent(f.a.id,{paused:true});f.store.acceptMoodleEvent(event(),f.now);await f.service.tick();assert.equal(f.calls.length,0);
  f.store.patchStudent(f.a.id,{paused:false});await f.service.tick();assert.deepEqual(f.calls,['tokenA']);
  f.calls.length=0;f.store.acceptMoodleEvent({...event('c'.repeat(32),99),eventName:'\\core\\event\\user_enrolment_created'},f.now);await f.service.tick();assert.deepEqual(f.calls.sort(),['tokenA','tokenB']);
});
test('HTTP event receiver rejects forged signatures and queues a valid event idempotently',async t=>{
  const f=fixture();const secret='e'.repeat(43);const config=loadConfig({ENCRYPTION_KEY:randomBytes(32).toString('base64'),PUBLIC_URL:'https://planner.test',MOODLE_EVENT_SECRET:secret});
  const app=createApp(config,f.store,f.service,f.moodle,async()=>{});
  t.after(async()=>{await f.service.processEvents();await app.close();f.store.close();});
  const now=Math.floor(Date.now()/1000);const payload=JSON.stringify({...event(),occurredAt:now});
  const signature=createHmac('sha256',secret).update(String(now)+'.'+payload).digest('hex');
  const headers={'content-type':'application/json','x-moodle-calendar-timestamp':String(now),'x-moodle-calendar-signature':signature};
  assert.equal((await app.inject({method:'POST',url:'/moodle/events',payload,headers:{...headers,'x-moodle-calendar-signature':'0'.repeat(64)}})).statusCode,403);assert.equal(f.calls.length,0);
  const response=await app.inject({method:'POST',url:'/moodle/events',payload,headers});assert.equal(response.statusCode,202);assert.equal(response.json().queued,1);await f.service.processEvents();
  const repeated=await app.inject({method:'POST',url:'/moodle/events',payload,headers});assert.equal(repeated.json().duplicate,true);assert.equal(f.calls.length,1);
});
test('inactive work is absent from priorities, reminders and feed even with a published deadline',async t=>{
  const f=fixture();t.after(()=>f.store.close());const s=f.snapshot(1);s.items[0].availability='upcoming';s.items[0].availableFrom=f.now+3600;s.items[0].dueAt=f.now+20000;
  f.store.saveSnapshot(f.a.id,s,[],f.now,f.now);await f.service.tick();assert.equal(f.sent.length,0);
  assert.equal(priorityItems(f.store.items(f.a.id),f.now).length,0);
  assert.doesNotMatch(renderCalendar(f.store.items(f.a.id),f.a.id,f.now),/BEGIN:VEVENT/);
});
