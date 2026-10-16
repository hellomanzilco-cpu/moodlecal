import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {loadConfig} from '../src/config.ts';
import {createApp} from '../src/api.ts';
import {Store} from '../src/store.ts';
import {Vault,hashSecret,newSecret} from '../src/security.ts';
import {SyncService} from '../src/sync.ts';
import {MoodleError} from '../src/moodle.ts';
import {assignmentLink} from '../src/assignment-session.ts';
import {assignmentFixture} from './helpers/assignments.ts';
import type {ConnectionProgress,MoodleGateway} from '../src/types.ts';

function deferred<T=void>() {
 let resolve!:(value:T|PromiseLike<T>)=>void;
 const promise=new Promise<T>(done=>{resolve=done;});
 return {promise,resolve};
}
async function bounded<T>(promise:Promise<T>,milliseconds=5000):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('The request did not finish while upstream work was blocked.')),milliseconds);})]);}
 finally{clearTimeout(timer);}
}
function connectFixture(){
 const config=loadConfig({ENCRYPTION_KEY:randomBytes(32).toString('base64'),PUBLIC_URL:'https://planner.test'});
 const store=new Store(':memory:'),vault=new Vault(config.encryptionKey);
 let loginWork:()=>Promise<string>=async()=> 'temporary-moodle-token';
 let snapshotWork:(progress?:ConnectionProgress)=>Promise<void>=async()=>{};
 const calls:{login:number;snapshot:number}={login:0,snapshot:0};
 const moodle:MoodleGateway={
  async login(){calls.login++;return loginWork();},
  async identify(){return {userId:1,name:'Synthetic Student',functions:[]};},
  async snapshot(_token,_now,_only,progress){calls.snapshot++;await snapshotWork(progress);return {courses:[],items:[],warnings:[]};},
 };
 const service=new SyncService(store,vault,moodle,{async send(){}},config.publicUrl,300);
 const app=createApp(config,store,service,moodle,async()=>{});
 const headers={origin:config.publicUrl};
 const student=(telegramId=111)=>{
  const account=store.ensureStudent(telegramId,telegramId);
  const raw=new URLSearchParams(new URL(service.connectLink(account.id)).hash.slice(1)).get('token')!;
  return {account,raw};
 };
 const connect=(raw:string,attemptId=newSecret())=>app.inject({method:'POST',url:'/api/connect',headers,payload:{linkToken:raw,attemptId,asyncMode:true,username:'synthetic-user',password:'synthetic-password',consent:true}});
 const status=(raw:string,attemptId:string)=>app.inject({method:'POST',url:'/api/connect/status',headers,payload:{linkToken:raw,attemptId}});
 const finished=async(raw:string,attemptId:string)=>bounded((async()=>{
  for(;;){const response=await status(raw,attemptId);if(response.json().status!=='working')return response;await nextTurn();}
 })());
 return {config,store,vault,service,app,calls,headers,student,connect,status,finished,
  setLogin(work:()=>Promise<string>){loginWork=work;},setSnapshot(work:(progress?:ConnectionProgress)=>Promise<void>){snapshotWork=work;},
  async close(){await app.close();store.close();},
 };
}
async function uploadBody(metadata:unknown){
 const form=new FormData();form.set('metadata',JSON.stringify(metadata));form.append('files',new Blob(['%PDF-synthetic coursework']),'essay.pdf');
 const request=new Request('https://planner.test',{method:'POST',body:form});
 return {headers:{'content-type':request.headers.get('content-type')!},payload:Buffer.from(await request.arrayBuffer())};
}
function addReceipt(f:ReturnType<typeof assignmentFixture>){
 const id=newSecret(),now=Math.floor(Date.now()/1000);
 f.store.db.prepare("INSERT INTO submission_operations(id,studentId,assignmentKey,connectionHash,state,stage,message,proof,createdAt,updatedAt) VALUES(?,?,?,?,'uncertain','verification_needed','Synthetic receipt',?,?,?)")
  .run(id,f.student.id,f.session.key,f.session.connectionHash,JSON.stringify({files:[],textHash:null}),now,now);
 return id;
}
function addFileReceipt(f:ReturnType<typeof assignmentFixture>){
 const id=addReceipt(f);
 f.detail={...f.detail,status:'submitted',submittedFiles:[{...f.detail.attachments[0],name:'essay.pdf',size:1}]};
 f.store.db.prepare('UPDATE submission_operations SET proof=? WHERE id=?').run(JSON.stringify({files:[{name:'essay.pdf',size:1,sha256:hashSecret('x')}],textHash:null}),id);
 return id;
}

test('async connection acknowledges blocked authentication and reports real stages without exposing credentials',async t=>{
 const f=connectFixture(),login=deferred<string>(),snapshot=deferred(),entered=deferred();
 t.after(async()=>{login.resolve('temporary-moodle-token');snapshot.resolve();await f.close();});
 f.setLogin(()=>login.promise);f.setSnapshot(async progress=>{progress?.('courses');progress?.('assignments');entered.resolve();await snapshot.promise;});
 const {account,raw}=f.student(),attemptId=newSecret();
 const accepted=await bounded(Promise.resolve(f.connect(raw,attemptId)));
 assert.equal(accepted.statusCode,202);assert.deepEqual(accepted.json(),{accepted:true,attemptId});
 let state=await f.status(raw,attemptId);assert.equal(state.json().status,'working');assert.equal(state.json().phase,'authenticating');assert.equal(state.json().percent,10);
 assert.equal(f.calls.snapshot,0);assert.equal(f.store.getStudent(account.id)!.moodleCipher,null);
 login.resolve('temporary-moodle-token');await entered.promise;
 state=await f.status(raw,attemptId);assert.equal(state.json().phase,'assignments');assert.equal(state.json().percent,60);assert.equal(state.json().status,'working');
 assert.equal(f.store.getStudent(account.id)!.moodleCipher,null);
 assert.doesNotMatch(state.body,/synthetic-password|synthetic-user|temporary-moodle-token|linkHash/);
 snapshot.resolve();state=await f.finished(raw,attemptId);assert.equal(state.json().status,'complete');assert.equal(state.json().percent,100);
 assert.ok(f.store.getStudent(account.id)!.moodleCipher);
 assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT * FROM students').all()),/synthetic-password|temporary-moodle-token/);
});

test('an asynchronous failed reconnect reports failure and preserves the previous encrypted connection',async t=>{
 const f=connectFixture(),login=deferred<string>();t.after(async()=>{login.resolve('unused');await f.close();});
 const {account,raw}=f.student(),prior=f.vault.seal('prior-private-token',`moodle:${account.id}`),attemptId=newSecret();
 f.store.patchStudent(account.id,{moodleCipher:prior});
 f.setLogin(async()=>{await login.promise;throw new MoodleError('upstream URL with a private password',true,'network');});
 assert.equal((await f.connect(raw,attemptId)).statusCode,202);login.resolve('unused');
 const state=await f.finished(raw,attemptId);assert.equal(state.json().status,'failed');assert.notEqual(state.json().percent,100);
 assert.match(state.json().error,/UWED Moodle is not responding/);assert.doesNotMatch(state.body,/private password|prior-private-token|synthetic-password/);
 assert.equal(f.store.getStudent(account.id)!.moodleCipher,prior);assert.equal(f.calls.snapshot,0);
 assert.ok(f.store.byLink(hashSecret(raw),Math.floor(Date.now()/1000)));
});

test('connection progress requires the matching private link and attempt, plus the exact origin',async t=>{
 const f=connectFixture(),login=deferred<string>();t.after(async()=>{login.resolve('temporary-moodle-token');await f.close();});f.setLogin(()=>login.promise);
 const own=f.student(111),other=f.student(222),attemptId=newSecret();assert.equal((await f.connect(own.raw,attemptId)).statusCode,202);
 assert.equal((await f.status(other.raw,attemptId)).statusCode,404);assert.equal((await f.status(own.raw,newSecret())).statusCode,404);
 for(const origin of [undefined,'null','https://planner.test.attacker.example','http://planner.test']){
  const response=await f.app.inject({method:'POST',url:'/api/connect/status',headers:origin?{origin}:{},payload:{linkToken:own.raw,attemptId}});
  assert.equal(response.statusCode,403);
 }
 assert.equal(f.calls.login,1);assert.equal(f.calls.snapshot,0);
});

test('overlapping connection attempts cannot bypass the student lock by rotating private links',async t=>{
 const f=connectFixture(),login=deferred<string>();t.after(async()=>{login.resolve('temporary-moodle-token');await f.close();});f.setLogin(()=>login.promise);
 const own=f.student(),attemptId=newSecret();assert.equal((await f.connect(own.raw,attemptId)).statusCode,202);
 const second=f.student();const rejected=await f.connect(second.raw);assert.equal(rejected.statusCode,409);assert.match(rejected.body,/still being checked/);assert.equal(f.calls.login,1);
 login.resolve('temporary-moodle-token');assert.equal((await f.finished(own.raw,attemptId)).json().status,'failed');
 const fresh=f.student(),nextId=newSecret();assert.equal((await f.connect(fresh.raw,nextId)).statusCode,202);assert.equal((await f.finished(fresh.raw,nextId)).json().status,'complete');assert.equal(f.calls.login,2);
});

test('three blocked connection jobs cap global work while the health endpoint remains available',async t=>{
 const f=connectFixture(),login=deferred<string>();t.after(async()=>{login.resolve('temporary-moodle-token');await f.close();});f.setLogin(()=>login.promise);
 const students=[f.student(111),f.student(222),f.student(333),f.student(444)];
 for(const own of students.slice(0,3))assert.equal((await f.connect(own.raw)).statusCode,202);
 const rejected=await f.connect(students[3].raw);assert.equal(rejected.statusCode,429);assert.match(rejected.body,/Connections are busy/);assert.equal(f.calls.login,3);assert.equal(f.calls.snapshot,0);
 assert.deepEqual((await bounded(Promise.resolve(f.app.inject({url:'/healthz'})))).json(),{ok:true});
});

test('exhausted daily full-sync allowance is rejected before Moodle credential exchange and survives disconnect',async t=>{
 const f=connectFixture();t.after(()=>f.close());let own=f.student();
 for(let index=0;index<5;index++)assert.equal(f.store.consumeSync(own.account.telegramId),true);
 assert.equal((await f.connect(own.raw)).statusCode,429);assert.equal(f.calls.login,0);assert.equal(f.calls.snapshot,0);
 f.store.deleteStudent(own.account.id);own=f.student();
 const response=await f.connect(own.raw);assert.equal(response.statusCode,429);assert.match(response.body,/5 daily full Moodle sync attempts/);assert.equal(f.calls.login,0);
});

test('an async-mode request without an attempt ID is rejected before any Moodle request',async t=>{
 const f=connectFixture();t.after(()=>f.close());const {raw}=f.student();
 const response=await f.app.inject({method:'POST',url:'/api/connect',headers:f.headers,payload:{linkToken:raw,asyncMode:true,username:'synthetic-user',password:'synthetic-password',consent:true}});
 assert.equal(response.statusCode,400);assert.equal(f.calls.login,0);assert.equal(f.calls.snapshot,0);
});

test('query strings and fresh assignment sessions cannot bypass the expensive verification rate limit',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const id=addReceipt(f),headers={origin:f.config.publicUrl,authorization:'Bearer '+f.raw};
 for(let index=0;index<15;index++){
  const response=await f.app.inject({method:'POST',url:`/api/assignment/operations/${id}/verify?nonce=${index}`,headers,payload:{}});assert.equal(response.statusCode,200,response.body);
 }
 assert.equal(f.calls.filter(call=>call.kind==='read').length,15);
 const raw=new URLSearchParams(new URL(assignmentLink(f.store,f.config.publicUrl,f.student.id,'assignment:5')).hash.slice(1)).get('session')!;
 const response=await f.app.inject({method:'POST',url:`/api/assignment/operations/${id}/verify?another=query`,headers:{...headers,authorization:'Bearer '+raw},payload:{}});
 assert.equal(response.statusCode,429);assert.equal(f.calls.filter(call=>call.kind==='read').length,15);
 // Receipt-status polling is local and has its own bucket; it does not read Moodle.
 assert.equal((await f.app.inject({method:'POST',url:`/api/assignment/operations/${id}`,headers,payload:{}})).statusCode,200);
 assert.equal(f.calls.filter(call=>call.kind==='read').length,15);
});

test('query strings cannot move submission requests into the cheaper detail-rate bucket',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const metadata={operationId:newSecret(),revision:hashSecret('original'),confirm:true,replaceExisting:false,statementAccepted:false},body=await uploadBody(metadata);
 const headers={...body.headers,origin:f.config.publicUrl,authorization:'Bearer '+f.raw};
 for(let index=0;index<5;index++){
  const response=await f.app.inject({method:'POST',url:'/api/assignment/submit?nonce='+index,headers,payload:body.payload});assert.equal(response.statusCode,202,response.body);await f.service.drain();
 }
 assert.equal(f.calls.filter(call=>call.kind==='save').length,1);
 assert.equal((await f.app.inject({method:'POST',url:'/api/assignment/submit?nonce=5',headers,payload:body.payload})).statusCode,429);
 assert.equal(f.calls.filter(call=>call.kind==='save').length,1);
});

test('assignment APIs reject malformed or cross-origin credentials before touching Moodle',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());
 const inputs=[
  {origin:'https://attacker.example',authorization:'Bearer '+f.raw,status:403},
  {origin:'null',authorization:'Bearer '+f.raw,status:403},
  {origin:f.config.publicUrl,authorization:undefined,status:401},
  {origin:f.config.publicUrl,authorization:'Basic '+f.raw,status:401},
  {origin:f.config.publicUrl,authorization:'Bearer '+newSecret(),status:401},
  {origin:f.config.publicUrl,authorization:'Bearer '+f.raw+' trailing',status:401},
 ];
 for(const input of inputs){
  const headers:Record<string,string>={origin:input.origin};if(input.authorization)headers.authorization=input.authorization;
  const response=await f.app.inject({method:'POST',url:'/api/assignment/detail',headers,payload:{}});assert.equal(response.statusCode,input.status);assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['referrer-policy'],'no-referrer');assert.equal(response.headers['x-content-type-options'],'nosniff');assert.equal(response.headers['x-frame-options'],'DENY');
 }
 assert.equal(f.calls.length,0);
});

test('another connected student cannot inspect, verify, release or reuse someone else’s submission ID',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const id=addReceipt(f),other=f.store.ensureStudent(222,222),token='other-private-token';
 f.store.patchStudent(other.id,{moodleCipher:f.vault.seal(token,`moodle:${other.id}`)});
 f.store.saveSnapshot(other.id,{courses:f.store.courses(f.student.id),items:f.store.rawItems(f.student.id),warnings:[]},[],Math.floor(Date.now()/1000),2_000_000_000);
 const raw=new URLSearchParams(new URL(assignmentLink(f.store,f.config.publicUrl,other.id,'assignment:5')).hash.slice(1)).get('session')!;
 const headers={origin:f.config.publicUrl,authorization:'Bearer '+raw};
 for(const [suffix,payload]of [['',{}],['/verify',{}],['/release',{confirmedNotSubmitted:true}]]as const){
  const response=await f.app.inject({method:'POST',url:`/api/assignment/operations/${id}${suffix}`,headers,payload});assert.equal(response.statusCode,404);assert.doesNotMatch(response.body,/Synthetic receipt|proof|connectionHash/);
 }
 const body=await uploadBody({operationId:id,revision:hashSecret('original'),confirm:true,replaceExisting:false,statementAccepted:false});
 assert.equal((await f.app.inject({method:'POST',url:'/api/assignment/submit',headers:{...headers,...body.headers},payload:body.payload})).statusCode,409);
 assert.equal(f.calls.length,0);assert.equal(f.service.operation(f.session,id)!.state,'uncertain');
});

test('reconnecting invalidates old assignment capabilities and prevents file delivery to a stale account',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());
 const response=await f.app.inject({method:'POST',url:'/api/assignment/detail',headers:{origin:f.config.publicUrl,authorization:'Bearer '+f.raw},payload:{}});const fileId=response.json().detail.attachments[0].id;
 f.calls.splice(0);f.store.patchStudent(f.student.id,{moodleCipher:f.vault.seal('replacement-private-token',`moodle:${f.student.id}`)});
 const headers={origin:f.config.publicUrl,authorization:'Bearer '+f.raw};
 assert.equal((await f.app.inject({method:'POST',url:'/api/assignment/detail',headers,payload:{}})).statusCode,401);
 assert.equal((await f.app.inject({method:'POST',url:'/api/assignment/file',headers,payload:{fileId,toTelegram:true}})).statusCode,401);
 assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});

test('simultaneous verification of one receipt shares a single fresh read and file download',async t=>{
 const f=assignmentFixture(),download=deferred();t.after(async()=>{download.resolve();await f.close();});
 const id=addFileReceipt(f);let count=0;
 f.gateway.download=async()=>{count++;await download.promise;return Buffer.from('x');};
 const attempts=Array.from({length:15},()=>f.service.verify(f.session,id));
 for(let index=0;index<10;index++)await nextTurn();
 assert.equal(f.calls.filter(call=>call.kind==='read').length,1);assert.equal(count,1);
 download.resolve();assert.ok((await Promise.all(attempts)).every(operation=>operation.state==='submitted'));
 await f.service.verify(f.session,id);assert.equal(count,2);assert.equal(f.calls.filter(call=>call.kind==='read').length,2);
 assert.equal(f.calls.filter(call=>['save','upload','finalize'].includes(call.kind)).length,0);
});

test('different receipts and task-file downloads share the same two-transfer capacity',async t=>{
 const f=assignmentFixture(),download=deferred();t.after(async()=>{download.resolve();await f.close();});
 const ids=Array.from({length:5},()=>addFileReceipt(f));let active=0,peak=0,completed=0;
 f.gateway.download=async()=>{active++;peak=Math.max(peak,active);try{await download.promise;return Buffer.from('x');}finally{active--;completed++;}};
 const fileId=hashSecret(JSON.stringify(f.detail.attachments[0]));
 // The task download enters the gate first. Its transfer and verification of
 // other receipts must share capacity rather than use separate queues.
 const taskFile=f.service.file(f.session,fileId,false);
 const checks=ids.map(id=>f.service.verify(f.session,id));
 for(let index=0;index<10;index++)await nextTurn();assert.equal(peak,2);assert.equal(active,2);
 download.resolve();await Promise.all(checks);const result=await taskFile;result.bytes.fill(0);
 assert.equal(peak,2);assert.equal(completed,6);
});

test('a verification flood has a bounded backlog and does not start excess downloads',async t=>{
 const f=assignmentFixture(),download=deferred();t.after(async()=>{download.resolve();await f.close();});
 const ids=Array.from({length:12},()=>addFileReceipt(f));let active=0,peak=0;
 f.gateway.download=async()=>{active++;peak=Math.max(peak,active);try{await download.promise;return Buffer.from('x');}finally{active--;}};
 const outcomes=ids.map(id=>f.service.verify(f.session,id).then(operation=>({operation,error:null}),error=>({operation:null,error})));
 for(let index=0;index<10;index++)await nextTurn();assert.equal(peak,2);assert.equal(active,2);
 download.resolve();const results=await Promise.all(outcomes);
 assert.equal(results.filter(result=>result.error).length,2);assert.ok(results.filter(result=>result.error).every(result=>/busy/.test(result.error.message)));
 assert.equal(results.filter(result=>result.operation?.state==='submitted').length,10);assert.equal(peak,2);
});

test('verification and closing an uncertain receipt cannot race to overwrite each other',async t=>{
 const f=assignmentFixture(),read=deferred(),entered=deferred();t.after(async()=>{read.resolve();await f.close();});
 const id=addReceipt(f),original=f.gateway.assignment;f.gateway.assignment=async(...args)=>{entered.resolve();await read.promise;return original(...args);};
 const verifying=f.service.verify(f.session,id);await entered.promise;
 await assert.rejects(f.service.release(f.session,id,true),/already being checked/);read.resolve();assert.equal((await verifying).state,'uncertain');
 const g=assignmentFixture(),readAgain=deferred(),enteredAgain=deferred();t.after(async()=>{readAgain.resolve();await g.close();});
 const otherId=addReceipt(g),otherRead=g.gateway.assignment;g.gateway.assignment=async(...args)=>{enteredAgain.resolve();await readAgain.promise;return otherRead(...args);};
 const closing=g.service.release(g.session,otherId,true);await enteredAgain.promise;
 await assert.rejects(g.service.verify(g.session,otherId),/being checked before closing/);await assert.rejects(g.service.release(g.session,otherId,true),/already being checked/);
 readAgain.resolve();assert.equal((await closing).state,'failed');
 assert.equal(g.calls.filter(call=>['save','upload','finalize'].includes(call.kind)).length,0);
});

test('fresh verification rejects changed files instead of presenting an old submitted receipt as newly verified',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const id=addFileReceipt(f);
 f.gateway.download=async()=>Buffer.from('x');assert.equal((await f.service.verify(f.session,id)).state,'submitted');
 f.gateway.download=async()=>Buffer.from('y');await assert.rejects(f.service.verify(f.session,id),/current Moodle status or files do not match/);
 // The historical receipt is retained; the failed fresh verification must be
 // surfaced to the caller rather than silently replacing that history.
 assert.equal(f.service.operation(f.session,id)!.state,'submitted');
 f.detail={...f.detail,status:'new',submittedFiles:[]};await assert.rejects(f.service.verify(f.session,id),/current Moodle status or files do not match/);
 assert.equal(f.calls.filter(call=>['save','upload','finalize'].includes(call.kind)).length,0);
});

test('a queued verification does not download using a revoked Moodle connection',async t=>{
 const f=assignmentFixture(),download=deferred();t.after(async()=>{download.resolve();await f.close();});
 const ids=Array.from({length:3},()=>addFileReceipt(f));let count=0;
 f.gateway.download=async()=>{count++;await download.promise;return Buffer.from('x');};
 const outcomes=ids.map(id=>f.service.verify(f.session,id).then(()=>null,error=>error));
 for(let index=0;index<10;index++)await nextTurn();assert.equal(count,2);
 f.store.patchStudent(f.student.id,{moodleCipher:f.vault.seal('replacement-private-token',`moodle:${f.student.id}`)});download.resolve();
 assert.ok((await Promise.all(outcomes)).every(error=>/connection changed/.test(error.message)));assert.equal(count,2);
});
