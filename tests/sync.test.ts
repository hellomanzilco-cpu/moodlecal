import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.ts';
import { Vault, hashSecret } from '../src/security.ts';
import { SyncService } from '../src/sync.ts';
import type { Item, MoodleGateway, Snapshot } from '../src/types.ts';

const item=(title='Essay',completed=false):Item => ({key:'assignment:1',courseId:10,courseName:'Economics',kind:'assignment',title,description:'Read the brief',url:'https://moodle.uwed.uz/mod/assign/view.php?id=4',modifiedAt:100,dueAt:2_000_000_000,startsAt:null,endsAt:null,completed,availability:'open'});
function fixture() {
  const store=new Store(':memory:'); const vault=new Vault(randomBytes(32).toString('base64'));
  let now=1_999_950_000; let snapshot:Snapshot={courses:[{id:10,name:'Economics',shortname:'ECO'}],items:[item()],warnings:[]};
  let fail=false; const sent:string[]=[]; let sendFail=false;
  const moodle:MoodleGateway={async identify(){return {userId:1,name:'Student',functions:[]};},async login(){return 'access-token';},async snapshot(){if(fail)throw new Error('secret-debug');return structuredClone(snapshot);}};
  const service=new SyncService(store,vault,moodle,{async send(_chatId,text){if(sendFail)throw new Error('Telegram unavailable');sent.push(text);}},'https://planner.test',300,()=>now);
  const s=store.ensureStudent(111,111);
  async function connect(id=s.id) { const link=new URL(service.connectLink(id));const token=new URLSearchParams(link.hash.slice(1)).get('token')!;await service.connect(token,'access-token');return token; }
  return {store,vault,moodle,service,s,sent,connect,get now(){return now;},set now(value:number){now=value;},set snapshot(value:Snapshot){snapshot=value;},get snapshot(){return snapshot;},set fail(value:boolean){fail=value;},set sendFail(value:boolean){sendFail=value;}};
}

test('profile decrypts only the requesting account and refuses stale identity after reconnection or disconnect',async t=>{
  const f=fixture();t.after(()=>f.store.close());await f.connect();
  const other=f.store.ensureStudent(222,222);await f.connect(other.id);
  f.store.patchStudent(other.id,{moodleCipher:f.vault.seal('bob-token',`moodle:${other.id}`)});
  const tokens:string[]=[];
  f.moodle.identify=async token=>{tokens.push(token);return {userId:1,name:'Display',functions:[],firstName:token==='bob-token'?'Bob':'Ali',lastName:'Family',username:token==='bob-token'?'bob':'ali'};};
  assert.deepEqual(await f.service.profile(f.s.id),{firstName:'Ali',lastName:'Family',username:'ali'});
  assert.equal((await f.service.profile(other.id)).username,'bob');assert.deepEqual(tokens,['access-token','bob-token']);
  const original=f.moodle.identify;
  f.moodle.identify=async token=>{const identity=await original(token);f.store.patchStudent(f.s.id,{moodleCipher:f.vault.seal('replacement-token',`moodle:${f.s.id}`)});return identity;};
  await assert.rejects(f.service.profile(f.s.id),/connection changed/);
  f.store.deleteStudent(f.s.id);await assert.rejects(f.service.profile(f.s.id),/Connect Moodle first/);
});

test('connect encrypts credentials, consumes link, and silently baselines existing items',async t => {
  const f=fixture();t.after(()=>f.store.close());const raw=await f.connect();
  const current=f.store.getStudent(f.s.id)!;
  assert.notEqual(current.moodleCipher,'access-token');assert.equal(f.vault.open(current.moodleCipher!,`moodle:${f.s.id}`),'access-token');
  assert.equal(f.store.byLink(hashSecret(raw),f.now),null);assert.equal(f.store.rawItems(f.s.id).length,1);
  const notices=f.store.pending(f.now);assert.equal(notices.length,1);assert.match(notices[0].text,/Moodle connected/);
  await assert.rejects(f.service.connect(raw,'other-token'),/expired/);
});
test('connection refuses an incomplete status snapshot without storing credentials or consuming the link',async t=>{
  const f=fixture();t.after(()=>f.store.close());
  f.snapshot={...f.snapshot,items:[{...item(),submissionStatus:'unknown'}],warnings:['Moodle did not return assignment submission statuses or grades.']};
  const link=new URL(f.service.connectLink(f.s.id));
  const token=new URLSearchParams(link.hash.slice(1)).get('token')!;
  await assert.rejects(f.service.connect(token,'access-token'),/did not verify/);
  assert.equal(f.store.getStudent(f.s.id)!.moodleCipher,null);assert.equal(f.store.rawItems(f.s.id).length,0);
  assert.ok(f.store.byLink(hashSecret(token),f.now));assert.equal(f.store.pending(f.now).length,0);
});
test('a failed status check preserves grades, deadlines, last sync time and the whole previous snapshot',async t=>{
  const f=fixture();t.after(()=>f.store.close());
  const quiz:Item={key:'quiz:22',courseId:10,courseName:'Economics',kind:'quiz',title:'Exam',description:'',url:'https://moodle.uwed.uz/mod/quiz/view.php?id=22',modifiedAt:1,dueAt:2_000_000_200,startsAt:null,endsAt:null,completed:false,files:[]};
  const event:Item={key:'event:23',courseId:10,courseName:'Economics',kind:'event',title:'Seminar',description:'',url:'https://moodle.uwed.uz/calendar/view.php?id=23',modifiedAt:1,dueAt:null,startsAt:2_000_000_300,endsAt:null,completed:false,files:[]};
  const submitted={...item('Essay',true),submissionStatus:'submitted_graded' as const,grade:'90 / 100'};
  f.snapshot={...f.snapshot,items:[submitted,quiz,event]};await f.connect();await f.service.deliver();
  const lastSuccess=f.store.getStudent(f.s.id)!.lastSyncAt;
  const previous=f.store.rawItems(f.s.id),courses=f.store.courses(f.s.id);
  f.now+=300;
  f.snapshot={...f.snapshot,items:[{...item('Essay',false),dueAt:2_000_000_100,submissionStatus:'unknown',grade:null},quiz,event],warnings:['Moodle did not return assignment submission statuses or grades.']};
  await assert.rejects(f.service.refresh(f.s.id),/did not verify/);const saved=f.store.rawItems(f.s.id);
  const assignment=saved.find(value=>value.key==='assignment:1')!;
  assert.equal(assignment.submissionStatus,'submitted_graded');assert.equal(assignment.completed,true);assert.equal(assignment.grade,'90 / 100');assert.equal(assignment.dueAt,2_000_000_000);
  const lastSyncAt=f.store.getStudent(f.s.id)!.lastSyncAt;
  assert.equal(lastSyncAt,lastSuccess);assert.deepEqual(saved,previous);assert.deepEqual(f.store.courses(f.s.id),courses);assert.equal(f.store.pending(f.now).length,0);
  assert.ok(saved.some(value=>value.key==='quiz:22'));assert.ok(saved.some(value=>value.key==='event:23'));
});
test('snapshot changes are durable and unchanged polls do not duplicate notifications; reverted edits notify',async t => {
  const f=fixture();t.after(()=>f.store.close());await f.connect();await f.service.deliver();
  f.now+=300;f.snapshot.items=[item('Updated essay')];await f.service.sync(f.s.id);
  assert.equal(f.store.pending(f.now).length,1);assert.match(f.store.pending(f.now)[0].text,/Updated assignment/);
  await f.service.sync(f.s.id);assert.equal(f.store.pending(f.now).length,1);
  await f.service.deliver();f.now+=300;f.snapshot.items=[item('Essay')];await f.service.sync(f.s.id);assert.equal(f.store.pending(f.now).length,1);
  await f.service.deliver();f.now+=300;f.snapshot.items=[item('Updated essay')];await f.service.sync(f.s.id);assert.equal(f.store.pending(f.now).length,1);
});
test('failed Moodle polls preserve the last good snapshot and isolate other students',async t => {
  const f=fixture();t.after(()=>f.store.close());await f.connect();
  const other=f.store.ensureStudent(222,222);await f.connect(other.id);await f.service.deliver();
  f.fail=true;await assert.rejects(f.service.sync(f.s.id));
  assert.equal(f.store.rawItems(f.s.id)[0].title,'Essay');assert.equal(f.store.rawItems(other.id)[0].title,'Essay');
  assert.equal(f.store.getStudent(other.id)!.lastError,null);assert.doesNotMatch(f.store.getStudent(f.s.id)!.lastError!,/secret-debug/);
  assert.equal(f.store.pending(f.now).length,1);await assert.rejects(f.service.sync(f.s.id));assert.equal(f.store.pending(f.now).length,1);
});
test('completion changes update data without update noise; course mute stops new notices',async t => {
  const f=fixture();t.after(()=>f.store.close());await f.connect();await f.service.deliver();
  f.snapshot.items=[item('Essay',true)];await f.service.sync(f.s.id);
  assert.equal(f.store.items(f.s.id)[0].completed,true);assert.equal(f.store.pending(f.now).length,0);
  f.store.muteCourse(f.s.id,10,true);f.snapshot.items=[item('New title')];await f.service.sync(f.s.id);
  assert.equal(f.store.pending(f.now).length,0);assert.equal(f.store.items(f.s.id).length,0);
});
test('outbox retries persist independently from sync and pause suppresses delivery',async t => {
  const f=fixture();t.after(()=>f.store.close());await f.connect();f.sendFail=true;await f.service.deliver();
  assert.equal(f.store.pending(f.now).length,0);f.now+=16;
  assert.equal(f.store.pending(f.now)[0].attempts,1);f.sendFail=false;
  f.store.patchStudent(f.s.id,{paused:true});await f.service.deliver();assert.equal(f.sent.length,0);
  f.store.patchStudent(f.s.id,{paused:false});await f.service.deliver();assert.equal(f.sent.length,1);
});
test('reminders catch up in 24h and 1h windows, dedupe and ignore completion/stale data',async t => {
  const f=fixture();t.after(()=>f.store.close());await f.connect();await f.service.deliver();
  f.service.reminders();assert.equal(f.store.pending(f.now).length,1);f.service.reminders();assert.equal(f.store.pending(f.now).length,1);
  await f.service.deliver();f.now=1_999_999_000;await f.service.sync(f.s.id);f.service.reminders();assert.equal(f.store.pending(f.now).length,1);
  await f.service.deliver();f.store.markDone(f.s.id,'assignment:1',true);f.service.reminders();assert.equal(f.store.pending(f.now).length,0);
  f.store.markDone(f.s.id,'assignment:1',false);f.now+=1000;f.service.reminders();assert.equal(f.store.pending(f.now).length,0);
});
test('manual sync works while paused and does not queue change notifications',async t => {
  const f=fixture();t.after(()=>f.store.close());await f.connect();await f.service.deliver();f.store.patchStudent(f.s.id,{paused:true});
  f.snapshot.items=[item('Changed')];await f.service.sync(f.s.id,false);assert.equal(f.store.rawItems(f.s.id)[0].title,'Essay');
  await f.service.sync(f.s.id);assert.equal(f.store.rawItems(f.s.id)[0].title,'Changed');assert.equal(f.store.pending(f.now).length,0);
});
test('disconnect during an in-flight sync cannot recreate student data',async t => {
  const f=fixture();t.after(()=>f.store.close());await f.connect();
  let release!:(value:Snapshot)=>void;f.moodle.snapshot=()=>new Promise(resolve=>{release=resolve;});
  const pending=f.service.sync(f.s.id);await new Promise(resolve=>setImmediate(resolve));
  f.store.deleteStudent(f.s.id);release(f.snapshot);await pending;
  assert.equal(f.store.getStudent(f.s.id),null);assert.equal(f.store.rawItems(f.s.id).length,0);
});
test('reconnect rolls back completely if saving new baseline fails',async t => {
  const f=fixture();t.after(()=>f.store.close());await f.connect();
  const original=f.store.getStudent(f.s.id)!;
  const raw=new URLSearchParams(new URL(f.service.connectLink(f.s.id)).hash.slice(1)).get('token')!;
  const save=f.store.saveSnapshot.bind(f.store);f.store.saveSnapshot=()=>{throw new Error('disk full');};
  await assert.rejects(f.service.connect(raw,'different-token'));
  f.store.saveSnapshot=save;
  assert.equal(f.store.getStudent(f.s.id)!.moodleCipher,original.moodleCipher);
  assert.equal(f.store.rawItems(f.s.id)[0].title,'Essay');assert.ok(f.store.byLink(hashSecret(raw),f.now));
});
test('connection links expire before use and cannot be bound after a slow Moodle request',async t => {
  const f=fixture();t.after(()=>f.store.close());
  let raw=new URLSearchParams(new URL(f.service.connectLink(f.s.id)).hash.slice(1)).get('token')!;
  f.now+=901;await assert.rejects(f.service.connect(raw,'access-token'),/expired/);
  raw=new URLSearchParams(new URL(f.service.connectLink(f.s.id)).hash.slice(1)).get('token')!;
  f.moodle.snapshot=async()=>{f.now+=901;return f.snapshot;};
  await assert.rejects(f.service.connect(raw,'access-token'),/expired/);assert.equal(f.store.getStudent(f.s.id)!.moodleCipher,null);
});
test('permanent Telegram refusal pauses one student while rate limits postpone a retry',async t => {
  const f=fixture();t.after(()=>f.store.close());await f.connect();
  const other=f.store.ensureStudent(222,222);await f.connect(other.id);
  const service=new SyncService(f.store,f.vault,f.moodle,{async send(chatId){if(chatId===111)throw Object.assign(new Error('refused'),{statusCode:403});throw Object.assign(new Error('rate limit'),{statusCode:429,retryAfter:90});}},'https://planner.test',300,()=>f.now);
  await service.deliver();assert.equal(f.store.getStudent(f.s.id)!.paused,true);assert.equal(f.store.getStudent(other.id)!.paused,false);
  f.now+=16;assert.equal(f.store.pending(f.now).length,0);f.now+=75;assert.equal(f.store.pending(f.now).length,1);
});
test('local account pairing requires a private secret, expires and can bind only one Telegram student',async t=>{
  const f=fixture();t.after(()=>f.store.close());
  const raw=f.service.beginPairing('access-token');
  assert.equal(await f.service.claimPairing(f.s.id,'wrong-secret'),false);
  assert.equal(f.store.getStudent(f.s.id)!.moodleCipher,null);
  assert.equal(await f.service.claimPairing(f.s.id,raw),true);
  const other=f.store.ensureStudent(222,222);assert.equal(await f.service.claimPairing(other.id,raw),false);
  assert.equal(f.store.getStudent(other.id)!.moodleCipher,null);assert.equal(f.store.getMeta('ownerPairing'),null);
  const expired=f.service.beginPairing('access-token');f.now+=901;assert.equal(await f.service.claimPairing(other.id,expired),false);
});
test('manual Auto update returns website changes once, retains scoped history and does not double-send alerts',async t=>{
  const f=fixture();t.after(()=>f.store.close());await f.connect();await f.service.deliver();
  const other=f.store.ensureStudent(222,222);await f.connect(other.id);await f.service.deliver();
  f.snapshot.items=[{...item('Changed essay'),dueAt:2_000_000_100}];
  const result=await f.service.refresh(f.s.id);assert.match(result,/1 change found/);assert.match(result,/Deadline:/);
  assert.equal(f.store.pending(f.now).length,0);assert.equal(f.store.recentChanges(f.s.id).length,1);assert.equal(f.store.recentChanges(other.id).length,0);
  assert.match(await f.service.refresh(f.s.id),/No changes since/);assert.equal(f.store.recentChanges(f.s.id).length,1);
  assert.match(f.service.recentUpdates(f.s.id),/Changed essay/);
});
