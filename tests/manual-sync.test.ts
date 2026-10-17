import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {SyncService} from '../src/sync.ts';
import {Vault} from '../src/security.ts';
import {MoodleError} from '../src/moodle.ts';
import {Bot} from '../src/bot.ts';
import type {MoodleGateway} from '../src/types.ts';

const NOW=1800000000;
function setup(t:{after(fn:()=>void):void},path=':memory:'){
 const store=new Store(path);t.after(()=>store.close());
 const vault=new Vault(randomBytes(32).toString('base64'));
 const student=store.ensureStudent(101,101);
 store.patchStudent(student.id,{moodleCipher:vault.seal('private-token',`moodle:${student.id}`)});
 store.saveSnapshot(student.id,{courses:[{id:1,name:'Economics',shortname:'ECO'}],items:[],warnings:[]},[],NOW-3600,NOW);
 const sent:string[]=[];let calls=0;let failure=false;
 const moodle:MoodleGateway={async login(){return 'unused';},async identify(){return {userId:1,name:'Student',functions:[]};},async snapshot(){calls++;if(failure)throw new MoodleError('sensitive detail',true,'network');return {courses:[{id:1,name:'Economics',shortname:'ECO'}],items:[],warnings:[]};}};
 const messenger={async send(_id:number,text:string){sent.push(text);}};
 const service=new SyncService(store,vault,moodle,messenger,'https://planner.test',300,()=>NOW);
 return {store,vault,student,sent,moodle,messenger,service,get calls(){return calls;},set failure(value:boolean){failure=value;}};
}
test('manual sync queues immediately, coalesces requests and delivers one result while paused',async t=>{
 const f=setup(t);f.store.patchStudent(f.student.id,{paused:true});
 assert.match(f.service.requestRefresh(f.student.id),/Sync requested/);assert.equal(f.calls,0);
 assert.match(f.service.requestRefresh(f.student.id),/already queued/);
 await Promise.all([f.service.processManualJobs(),f.service.processManualJobs()]);
 assert.equal(f.calls,1);assert.equal(f.store.getStudent(f.student.id)!.lastSyncAt,NOW);
 await f.service.deliver();assert.equal(f.sent.length,1);assert.match(f.sent[0],/No changes/);
 await f.service.tick();assert.equal(f.calls,1);assert.equal(f.sent.length,1);
});
test('timeout leaves successful timestamp and data unchanged, records attempt and explains outage without leaking details',async t=>{
 const f=setup(t);f.failure=true;f.service.requestRefresh(f.student.id);
 await f.service.tick();
 assert.equal(f.store.getStudent(f.student.id)!.lastSyncAt,NOW-3600);
 assert.equal(f.store.getMeta(`lastSyncAttempt:${f.student.id}`),String(NOW));
 assert.equal(f.store.courses(f.student.id).length,1);
 assert.equal(f.sent.length,1);assert.match(f.sent[0],/UWED Moodle is not responding/);assert.doesNotMatch(f.sent[0],/sensitive|private-token/);
 await f.service.tick();assert.equal(f.calls,1,'a failed explicit request must not become scheduled Moodle polling');
});
test('queued sync survives reopening SQLite and disconnect removes queued jobs',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'moodle-manual-'));
 const path=join(directory,'app.sqlite');let store=new Store(path);
 const vault=new Vault(randomBytes(32).toString('base64'));const student=store.ensureStudent(101,101);
 store.patchStudent(student.id,{moodleCipher:vault.seal('private-token',`moodle:${student.id}`)});
 const moodle:MoodleGateway={async identify(){return {userId:1,name:'Student',functions:[]};},async login(){return 'unused';},async snapshot(){return {courses:[],items:[],warnings:[]};}};
 new SyncService(store,vault,moodle,{async send(){}},'https://planner.test',300,()=>NOW).requestRefresh(student.id);store.close();
 store=new Store(path);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});const sent:string[]=[];
 const service=new SyncService(store,vault,moodle,{async send(_id,text){sent.push(text);}},'https://planner.test',300,()=>NOW);
 await service.tick();assert.equal(sent.length,1);assert.equal(store.getStudent(student.id)!.lastSyncAt,NOW);
 service.requestRefresh(student.id);store.deleteStudent(student.id);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM manual_sync_jobs').get()!.count,0);
});
test('Sync, old Auto update and slash sync share a single cooldown and queued operation',async t=>{
 const f=setup(t);const bot=new Bot(f.store,f.messenger,f.service);let sequence=0;
 const send=(text:string)=>bot.handle({update_id:++sequence,message:{chat:{id:101,type:'private'},from:{id:101,is_bot:false},text}});
 await send('🔄 Sync');assert.match(f.sent.at(-1)!,/Sync requested/);assert.equal(f.calls,0);
 await send('🔄 Auto update');assert.match(f.sent.at(-1)!,/Please wait/);
 await send('/sync');assert.match(f.sent.at(-1)!,/Please wait/);
 await send('📝 Assignments');assert.match(f.sent.at(-1)!,/ASSIGNMENTS DASHBOARD/,'menus must respond while a sync is queued');
 await f.service.processManualJobs();assert.equal(f.calls,1);
});
test('manual sync distinguishes limited checks and identifies a failed API step while preserving the snapshot',async t=>{
 const f=setup(t);f.moodle.snapshot=async()=>({courses:[{id:1,name:'Economics',shortname:'ECO'}],items:[],warnings:['Quiz attempt status is unavailable; completed quizzes may remain in priorities.']});
 const limited=await f.service.refresh(f.student.id);assert.match(limited,/finished with limits/);assert.match(limited,/Quiz attempt status is unavailable/);assert.match(limited,/Checked 1 courses/);
 f.moodle.snapshot=async()=>{const error=new MoodleError('private URL token',true,'network');error.operation='mod_assign_get_submission_status';throw error;};f.service.requestRefresh(f.student.id);await f.service.tick();assert.match(f.sent.at(-1)!,/Failed check: reading submission status and grades/);assert.match(f.sent.at(-1)!,/no API error code/);assert.doesNotMatch(f.sent.at(-1)!,/private URL token/);assert.equal(f.store.getStudent(f.student.id)!.lastSyncAt,NOW);
 f.moodle.snapshot=async()=>{const error=new MoodleError('private Moodle debug response',false,'permission');error.operation='mod_assign_get_submission_status';error.apiErrorCode='nopermissiontoaccesspage';throw error;};f.service.requestRefresh(f.student.id);await f.service.tick();assert.match(f.sent.at(-1)!,/Moodle API code: nopermissiontoaccesspage/);assert.doesNotMatch(f.sent.at(-1)!,/private Moodle debug response/);assert.equal(f.store.getStudent(f.student.id)!.lastSyncAt,NOW);
});
test('loss of an assignment API cannot replace known assignments with generic activity records',async t=>{
 const f=setup(t);const old={key:'assignment:5',courseId:1,courseName:'Economics',kind:'assignment' as const,title:'Known essay',description:'Brief',url:'https://moodle.uwed.uz/mod/assign/view.php?id=8',modifiedAt:1,dueAt:NOW+1000,startsAt:null,endsAt:null,completed:false};
 f.store.saveSnapshot(f.student.id,{courses:[{id:1,name:'Economics',shortname:'ECO'}],items:[old],warnings:[]},[],NOW-3600,NOW);
 f.moodle.snapshot=async()=>({courses:[{id:1,name:'Economics',shortname:'ECO'}],items:[{...old,key:'module:8'}],warnings:['Assignment details and deadlines are unavailable; only course activity changes are monitored.']});
 await assert.rejects(f.service.refresh(f.student.id),/access was lost/);assert.equal(f.store.rawItems(f.student.id)[0].key,'assignment:5');assert.equal(f.store.getStudent(f.student.id)!.lastSyncAt,NOW-3600);
});
