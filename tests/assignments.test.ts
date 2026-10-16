import test from 'node:test';
import assert from 'node:assert/strict';
import {newSecret,hashSecret} from '../src/security.ts';
import {AssignmentService,parseSubmissionRequest,publicAssignment,validateSubmission} from '../src/assignments.ts';
import type {SubmissionRequest} from '../src/assignments.ts';
import {assignmentLink} from '../src/assignment-session.ts';
import {MoodleError} from '../src/moodle.ts';
import {assignmentDetail,assignmentFixture} from './helpers/assignments.ts';
const file=()=>({name:'essay.pdf',bytes:Buffer.from('%PDF-essay'),mime:'application/pdf'});
const request=(patch:Partial<SubmissionRequest>={}):SubmissionRequest=>({operationId:newSecret(),revision:hashSecret('original'),confirm:true,replaceExisting:false,statementAccepted:false,...patch});
test('submission is verified against official status and files before success, and repeated operation does not write again',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const upload=file(),req=request();const started=f.service.start(f.session,req,[upload]);assert.equal(started.state,'working');assert.equal(f.store.items(f.student.id)[0].submissionStatus,'outstanding');
 await f.service.drain();assert.equal(f.service.operation(f.session,req.operationId)?.state,'submitted');assert.equal(f.store.items(f.student.id)[0].submissionStatus,'submitted_ungraded');assert.equal(f.store.getStudent(f.student.id)!.lastSyncAt,f.session.student.lastSyncAt);
 const receipt=f.store.pending(Math.floor(Date.now()/1000)).find(row=>row.text.includes('Submitted for grading'));assert.ok(receipt);assert.match(receipt.text,/also open Moodle yourself/);assert.match(receipt.text,/essay.pdf/);assert.ok(upload.bytes.every(byte=>byte===0));
 f.service.start(f.session,req,[file()]);await f.service.drain();assert.equal(f.calls.filter(c=>c.kind==='save').length,1);assert.equal(f.calls.filter(c=>c.kind==='finalize').length,0);
});
test('separate final-submit and required teacher statement are respected; drafts are never reported as submitted',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());f.detail={...f.detail,requiresFinalSubmit:true,requiresStatement:true,statement:'This is my own work.'};
 const req=request({statementAccepted:true});f.service.start(f.session,req,[file()]);await f.service.drain();assert.equal(f.service.operation(f.session,req.operationId)?.state,'submitted');assert.equal(f.calls.filter(c=>c.kind==='finalize').length,1);
 const g=assignmentFixture();t.after(()=>g.close());g.detail={...g.detail,requiresFinalSubmit:true};g.gateway.submitForGrading=async()=>{throw new MoodleError('Not accepted');};const draft=request();g.service.start(g.session,draft,[file()]);await g.service.drain();assert.equal(g.service.operation(g.session,draft.operationId)?.state,'draft');assert.match(g.service.operation(g.session,draft.operationId)!.message,/NOT confirmed/);assert.equal(g.store.items(g.student.id)[0].submissionStatus,'outstanding');
});
test('stale requirements, access restrictions, file limits, statement and replacement confirmation reject before assignment writes',async t=>{
 const cases=[
  {detail:{revision:hashSecret('changed')},req:{},files:[file()]},
  {detail:{availability:'closed' as const,canEdit:false},req:{},files:[file()]},
  {detail:{requiresStatement:true},req:{},files:[file()]},
  {detail:{submittedFiles:[{...assignmentDetail().attachments[0],name:'old.pdf'}]},req:{},files:[file()]},
  {detail:{maxFiles:1},req:{},files:[file(),{...file(),name:'other.pdf'}]},
  {detail:{maxFileBytes:2},req:{},files:[file()]},
  {detail:{},req:{},files:[{...file(),name:'wrong.exe'}]},
  {detail:{},req:{},files:[{...file(),name:'../essay.pdf'}]},
  {detail:{},req:{},files:[file(),file()]},
  {detail:{unsupportedReason:'Timed assignment: use Moodle.'},req:{},files:[file()]},
 ];
 for(const scenario of cases){const f=assignmentFixture();t.after(()=>f.close());f.detail={...f.detail,...scenario.detail};f.service.start(f.session,request(scenario.req),scenario.files);await f.service.drain();assert.equal(f.service.latest(f.session)?.state,'failed');assert.equal(f.calls.filter(c=>['upload','save','finalize'].includes(c.kind)).length,0);}
 assert.throws(()=>parseSubmissionRequest({operationId:newSecret(),revision:hashSecret('original'),confirm:false}),/explicitly confirm/);
 assert.throws(()=>validateSubmission(assignmentDetail({fileEnabled:false,textEnabled:true,wordLimit:2}),request({onlineText:'one two three'}),[]),/word limit/);
});
test('requirements changed during draft upload block saving the assignment record',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const upload=f.gateway.uploadDraft;f.gateway.uploadDraft=async(...args)=>{const id=await upload(...args);f.detail={...f.detail,revision:hashSecret('teacher changed deadline')};return id;};f.service.start(f.session,request(),[file()]);await f.service.drain();assert.equal(f.service.latest(f.session)?.state,'failed');assert.equal(f.calls.filter(c=>c.kind==='save').length,0);
});
test('a lost save response is resolved with readback; writes are never retried',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const save=f.gateway.saveSubmission;f.gateway.saveSubmission=async(...args)=>{await save(...args);throw new MoodleError('lost response',true,'network');};f.service.start(f.session,request(),[file()]);await f.service.drain();assert.equal(f.service.latest(f.session)?.state,'submitted');assert.equal(f.calls.filter(c=>c.kind==='save').length,1);
});
test('unverifiable writes become uncertain and block duplicate attempts until an explicit read-only verification succeeds',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const save=f.gateway.saveSubmission,read=f.gateway.assignment;let outage=false;
 f.gateway.saveSubmission=async(...args)=>{await save(...args);outage=true;throw new MoodleError('lost response',true,'network');};f.gateway.assignment=async(...args)=>{if(outage)throw new MoodleError('offline',true,'network');return read(...args);};const req=request();f.service.start(f.session,req,[file()]);await f.service.drain();assert.equal(f.service.latest(f.session)?.state,'uncertain');assert.throws(()=>f.service.start(f.session,request(),[file()]),/previous submission needs verification/);outage=false;assert.equal((await f.service.verify(f.session,req.operationId)).state,'submitted');assert.equal(f.calls.filter(c=>c.kind==='save').length,1);
});
test('mismatched saved files never produce a submitted receipt',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());f.gateway.saveSubmission=async()=>{f.detail={...f.detail,status:'submitted',submittedFiles:[{...f.detail.attachments[0],name:'unexpected.pdf'}]};};f.service.start(f.session,request(),[file()]);await f.service.drain();assert.equal(f.service.latest(f.session)?.state,'uncertain');assert.equal(f.store.items(f.student.id)[0].submissionStatus,'outstanding');
});
test('an older same-name same-size file cannot be finalized or mistaken for the new work',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());f.detail={...f.detail,requiresFinalSubmit:true};f.gateway.download=async()=>Buffer.from('%PDF-older');f.service.start(f.session,request(),[file()]);await f.service.drain();assert.equal(f.service.latest(f.session)?.state,'uncertain');assert.equal(f.calls.filter(c=>c.kind==='finalize').length,0);assert.equal(f.store.items(f.student.id)[0].submissionStatus,'outstanding');
});
test('uncertain attempts can be closed only after explicit acknowledgement and a fresh Moodle check showing editable unsubmitted work',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());f.gateway.saveSubmission=async()=>{throw new MoodleError('lost reply',true,'network');};const req=request();f.service.start(f.session,req,[file()]);await f.service.drain();assert.equal(f.service.latest(f.session)?.state,'uncertain');
 await assert.rejects(f.service.release(f.session,req.operationId,false),/Check the uncertain/);f.detail={...f.detail,status:'submitted'};await assert.rejects(f.service.release(f.session,req.operationId,true),/already reports submitted/);f.detail={...f.detail,status:'new'};const released=await f.service.release(f.session,req.operationId,true);assert.equal(released.state,'failed');assert.match(released.message,/Nothing was resubmitted/);
});
test('private assignment sessions and receipts are bound to student, assignment and current Moodle connection',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());assert.throws(()=>assignmentLink(f.store,f.config.publicUrl,f.student.id,'assignment:999'),/not found/);
 const req=request();f.service.start(f.session,req,[file()]);await f.service.drain();const other=f.store.ensureStudent(222,222);f.store.patchStudent(other.id,{moodleCipher:f.vault.seal('other-private-token',`moodle:${other.id}`)});f.store.saveSnapshot(other.id,{courses:[{id:1,name:'Economics',shortname:'ECO'}],items:f.store.rawItems(f.student.id),warnings:[]},[],Math.floor(Date.now()/1000),0);
 const raw=new URLSearchParams(new URL(assignmentLink(f.store,f.config.publicUrl,other.id,'assignment:5')).hash.slice(1)).get('session')!;assert.equal(f.service.operation(f.service.session(raw),req.operationId),null);
 f.store.patchStudent(f.student.id,{moodleCipher:f.vault.seal('new-token',`moodle:${f.student.id}`)});assert.throws(()=>f.service.session(f.raw),/expired/);assert.throws(()=>f.service.operation(f.session,req.operationId),/connection changed/);
});
test('expired windows and disconnect during upload cannot recreate personal data or submit',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());f.advance(1801);assert.throws(()=>f.service.session(f.raw),/expired/);
 const g=assignmentFixture();t.after(()=>g.close());let release!:()=>void;let reached!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>reached=r);
 g.gateway.uploadDraft=async()=>{reached();await gate;return 99;};g.service.start(g.session,request(),[file()]);await started;g.store.deleteStudent(g.student.id);release();await g.service.drain();assert.equal(g.calls.filter(c=>c.kind==='save').length,0);assert.equal(g.store.db.prepare('SELECT COUNT(*) AS count FROM submission_operations').get()?.count,0);
});
test('restart recovery marks unfinished writes for verification without replaying uploads',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());f.store.db.prepare("INSERT INTO submission_operations VALUES(?,?,?,?,?,?,?,?,?,?)").run(newSecret(),f.student.id,'assignment:5',f.session.connectionHash,'working','saving','Saving…',JSON.stringify({files:[],textHash:null}),1,1);
 const restarted=new AssignmentService(f.store,f.vault,f.gateway,{async send(){}});assert.equal(restarted.latest(f.session)?.state,'uncertain');assert.equal(f.calls.length,0);
});
test('file delivery uses this account token and chat, rejects stale file identifiers, and never exposes Moodle file URLs',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const view=publicAssignment(f.detail,f.student.timezone);assert.ok(!JSON.stringify(view).includes('pluginfile.php'));await assert.rejects(f.service.file(f.session,'0'.repeat(64),true),/changed or is no longer/);
 await f.service.file(f.session,view.attachments[0].id,true);assert.equal(f.sent[0].chatId,111);assert.equal(f.sent[0].name,'teacher-brief.pdf');assert.ok(f.calls.filter(c=>c.kind==='download').every(c=>c.token===f.token));
});
test('aggregate statistics contain no student identity, credentials, file names or per-person event history',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());f.service.start(f.session,request(),[file()]);await f.service.drain();const stats=f.store.statistics(),text=JSON.stringify(stats);assert.equal(stats.containsPersonalIdentifiers,false);assert.doesNotMatch(text,/private-moodle-token|essay.pdf|studentId|telegramId|username|password/);assert.ok(stats.daily.some(row=>row.event==='submission_success'&&row.count===1));f.store.deleteStudent(f.student.id);assert.ok(f.store.statistics().daily.length>0);
});
