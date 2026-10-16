import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Vault} from '../src/security.ts';
import {SyncService} from '../src/sync.ts';
import {MoodleError} from '../src/moodle.ts';
import {DAILY_SYNCS,SyncLimitError,syncDay,syncResetAt} from '../src/sync-quota.ts';
import type {MoodleGateway} from '../src/types.ts';
import {assignmentFixture} from './helpers/assignments.ts';

const NOW=Date.parse('2026-10-16T10:00:00Z')/1000;
function fixture(t:{after(fn:()=>void):void}){
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64')),student=store.ensureStudent(101,101);t.after(()=>store.close());
 store.patchStudent(student.id,{moodleCipher:vault.seal('fake-token',`moodle:${student.id}`)});store.saveSnapshot(student.id,{courses:[],items:[],warnings:[]},[],NOW-3600,NOW);
 let clock=NOW,calls=0,identities=0,fail=false;const sent:string[]=[];
 const gateway:MoodleGateway={async login(){return 'fake-token';},async identify(){identities++;return {userId:1,name:'Private Student',firstName:'Private',lastName:'Student',username:'private_username',functions:[]};},async snapshot(){calls++;if(fail)throw new MoodleError('private upstream failure',true,'network');return {courses:[],items:[],warnings:[]};}};
 const service=new SyncService(store,vault,gateway,{async send(_id,text){sent.push(text);}},'https://planner.test',300,()=>clock);
 return {store,vault,student,gateway,service,sent,get calls(){return calls;},get identities(){return identities;},get clock(){return clock;},set clock(value:number){clock=value;},set fail(value:boolean){fail=value;}};
}

test('full-sync budget permits exactly five daily attempts, uses no direct identity and is independent per Telegram student',t=>{
 const f=fixture(t);assert.equal(DAILY_SYNCS,5);
 for(let i=0;i<5;i++){assert.equal(f.store.consumeSync(101,NOW),true);assert.equal(f.store.syncAllowance(101,NOW).used,i+1);}
 for(let i=0;i<10;i++)assert.equal(f.store.consumeSync(101,NOW),false);
 assert.equal(f.store.syncAllowance(101,NOW).remaining,0);assert.equal(f.store.consumeSync(202,NOW),true);assert.equal(f.store.syncAllowance(202,NOW).remaining,4);
 const rows=f.store.db.prepare('SELECT * FROM sync_budgets').all();assert.equal(rows.length,2);assert.deepEqual(Object.keys(rows[0]).sort(),['subjectHash','day','count'].sort());
 assert.ok(rows.every(row=>/^[a-f0-9]{64}$/.test(String(row.subjectHash))));assert.ok(rows.every(row=>row.day==='2026-10-16'));
});

test('quota survives reopening SQLite and disconnect/recreating the same Telegram account cannot reset it',t=>{
 const directory=mkdtempSync(join(tmpdir(),'moodle-quota-')),path=join(directory,'app.sqlite');let store=new Store(path);
 const first=store.ensureStudent(101,101);for(let i=0;i<5;i++)assert.equal(store.consumeSync(101,NOW),true);
 store.close();store=new Store(path);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal(store.syncAllowance(101,NOW).used,5);store.deleteStudent(first.id);const recreated=store.ensureStudent(101,101);
 assert.ok(recreated);assert.equal(store.syncAllowance(recreated.telegramId,NOW).remaining,0);assert.equal(store.consumeSync(recreated.telegramId,NOW),false);
 assert.equal(store.consumeSync(202,NOW),true);
});

test('daily reset happens at Tashkent midnight regardless of a student-selected time zone',t=>{
 const f=fixture(t),before=Date.parse('2026-10-16T18:59:59Z')/1000,midnight=before+1;f.store.patchStudent(f.student.id,{timezone:'America/Los_Angeles'});
 assert.equal(syncDay(before),'2026-10-16');assert.equal(syncResetAt(before),midnight);assert.equal(syncDay(midnight),'2026-10-17');
 for(let i=0;i<5;i++)assert.equal(f.store.consumeSync(101,before),true);assert.equal(f.store.consumeSync(101,before),false);
 assert.equal(f.store.syncAllowance(101,midnight).used,0);assert.equal(f.store.syncAllowance(101,midnight).remaining,5);assert.equal(f.store.consumeSync(101,midnight),true);
 assert.equal(syncResetAt(midnight),midnight+86400);
});

test('duplicate queued taps consume one attempt when executed, including while a full sync is running',async t=>{
 const f=fixture(t);let release!:()=>void;const gate=new Promise<void>(r=>release=r),snapshot=f.gateway.snapshot;
 f.gateway.snapshot=async(...args)=>{await gate;return snapshot(...args);};
 assert.match(f.service.requestRefresh(f.student.id),/Sync requested/);for(let i=0;i<20;i++)assert.match(f.service.requestRefresh(f.student.id),/already queued/);
 assert.equal(f.service.syncAllowance(f.student.id).used,0);
 const work=f.service.processManualJobs();await new Promise<void>(r=>setImmediate(r));
 assert.equal(f.service.syncAllowance(f.student.id).used,1);assert.match(f.service.requestRefresh(f.student.id),/already queued/);
 release();await Promise.all([work,f.service.processManualJobs()]);assert.equal(f.calls,1);assert.equal(f.service.syncAllowance(f.student.id).used,1);
 await f.service.deliver();assert.equal(f.sent.length,1);assert.match(f.sent[0],/1\/5 used · 4 left/);
});

test('failed full sync attempts count and the sixth attempt cannot reach Moodle or replace successful data',async t=>{
 const f=fixture(t);f.fail=true;
 for(let i=0;i<5;i++)await assert.rejects(f.service.refresh(f.student.id),MoodleError);
 assert.equal(f.calls,5);assert.equal(f.store.getStudent(f.student.id)!.lastSyncAt,NOW-3600);assert.equal(f.service.syncAllowance(f.student.id).remaining,0);
 await assert.rejects(f.service.refresh(f.student.id),SyncLimitError);assert.throws(()=>f.service.requestRefresh(f.student.id),SyncLimitError);
 assert.equal(f.calls,5);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM manual_sync_jobs').get()!.count,0);
});

test('connection and reconnect full snapshots share the quota and cannot bypass it with new private links',async t=>{
 const f=fixture(t);const raw=()=>new URLSearchParams(new URL(f.service.connectLink(f.student.id)).hash.slice(1)).get('token')!;
 await f.service.refresh(f.student.id);for(let i=0;i<4;i++)await f.service.connect(raw(),'new-fake-token');
 assert.equal(f.calls,5);assert.equal(f.service.syncAllowance(f.student.id).remaining,0);
 const prior=f.store.getStudent(f.student.id)!.moodleCipher;await assert.rejects(f.service.connect(raw(),'rejected-token'),SyncLimitError);
 assert.equal(f.calls,5);assert.equal(f.store.getStudent(f.student.id)!.moodleCipher,prior);
});

test('profile and assignment reads stay usable when the five full syncs have been spent',async t=>{
 const f=fixture(t);for(let i=0;i<5;i++)f.store.consumeSync(101,NOW);
 for(let i=0;i<3;i++)assert.deepEqual(await f.service.profile(f.student.id),{firstName:'Private',lastName:'Student',username:'private_username'});
 assert.equal(f.identities,3);assert.equal(f.calls,0);assert.equal(f.service.syncAllowance(f.student.id).used,5);
 const a=assignmentFixture();t.after(()=>a.close());for(let i=0;i<5;i++)a.store.consumeSync(a.student.telegramId,Math.floor(Date.now()/1000));
 for(let i=0;i<3;i++)assert.equal((await a.service.detail(a.session)).id,5);
 assert.equal(a.calls.filter(value=>value.kind==='read').length,3);assert.equal(a.sync.syncAllowance(a.student.id).used,5);
});

test('a queued full-sync request remains one counted attempt after a process restart',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'moodle-quota-job-')),path=join(directory,'app.sqlite'),vault=new Vault(randomBytes(32).toString('base64'));let store=new Store(path),calls=0;
 const student=store.ensureStudent(101,101);store.patchStudent(student.id,{moodleCipher:vault.seal('fake-token',`moodle:${student.id}`)});
 const gateway:MoodleGateway={async login(){return 'fake-token';},async identify(){return {userId:1,name:'Student',functions:[]};},async snapshot(){calls++;return {courses:[],items:[],warnings:[]};}};
 const create=()=>new SyncService(store,vault,gateway,{async send(){}},'https://planner.test',300,()=>NOW);
 create().requestRefresh(student.id);store.close();store=new Store(path);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const resumed=create();assert.match(resumed.requestRefresh(student.id),/already queued/);await Promise.all([resumed.processManualJobs(),resumed.processManualJobs()]);
 assert.equal(calls,1);assert.equal(store.syncAllowance(101,NOW).used,1);assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM manual_sync_jobs').get()!.count,0);
});
