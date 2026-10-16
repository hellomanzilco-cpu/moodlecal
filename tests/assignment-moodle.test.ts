import test from 'node:test';
import assert from 'node:assert/strict';
import {MoodleClient,MoodleError} from '../src/moodle.ts';
import {trustedFile} from '../src/assignment-moodle.ts';
import {TelegramClient} from '../src/telegram.ts';
const site='https://moodle.uwed.uz',token='private-student-token',now=1_800_000_000;
function readerFixture(){
 const functions=['core_enrol_get_users_courses','core_course_get_contents','mod_assign_get_assignments','mod_assign_get_submission_status','mod_assign_save_submission','mod_assign_submit_for_grading'];
 const assignment:Record<string,unknown>={id:5,cmid:8,course:1,name:'Essay',intro:'<p>Read the professor’s brief.</p>',duedate:now+1000,allowsubmissionsfromdate:0,cutoffdate:0,submissiondrafts:1,requiresubmissionstatement:1,submissionstatement:'<p>This is my own work.</p>',configs:[{subtype:'assignsubmission',plugin:'file',name:'enabled',value:'1'},{subtype:'assignsubmission',plugin:'file',name:'maxfilesubmissions',value:'3'},{subtype:'assignsubmission',plugin:'file',name:'maxsubmissionsizebytes',value:'10000'},{subtype:'assignsubmission',plugin:'file',name:'filetypeslist',value:'.pdf, .docx'}],introattachments:[{filename:'brief.pdf',filesize:5,timemodified:10,mimetype:'application/pdf',fileurl:site+'/pluginfile.php/10/mod_assign/introattachment/0/brief.pdf?token='+token}]};
 const last:Record<string,unknown>={submission:{status:'draft',attemptnumber:0,plugins:[]},canedit:true,cansubmit:false,submissionsenabled:true,locked:false,extensionduedate:now+2000};
 const sections=[{uservisible:true,modules:[{id:8,modname:'assign',uservisible:true}]}];
 const calls:string[]=[];const responses:Record<string,unknown>={core_webservice_get_site_info:{userid:7,fullname:'Private Student',functions:functions.map(name=>({name}))},core_enrol_get_users_courses:[{id:1,fullname:'Economics',shortname:'ECO'}],core_course_get_contents:sections,mod_assign_get_assignments:{courses:[{id:1,assignments:[assignment]}],warnings:[]},mod_assign_get_submission_status:{lastattempt:last,warnings:[]}};
 const client=new MoodleClient(site,async(_input,init)=>{const params=new URLSearchParams(String(init?.body)),name=params.get('wsfunction')!;calls.push(name);assert.equal(params.get('wstoken'),token);return Response.json(responses[name]);});
 return {client,assignment,last,sections,calls,responses};
}
test('fresh assignment reads evaluated permissions, exact teacher rules and statement, extensions and private file references',async()=>{
 const f=readerFixture(),detail=await f.client.assignment(token,5,1,now);assert.equal(detail.canEdit,true);assert.equal(detail.canSubmit,false);assert.equal(detail.dueAt,now+2000);assert.equal(detail.maxFiles,3);assert.deepEqual(detail.acceptedTypes,['.pdf','.docx']);assert.equal(detail.statement,'This is my own work.');assert.equal(detail.attachments[0].url,site+'/webservice/pluginfile.php/10/mod_assign/introattachment/0/brief.pdf');assert.doesNotMatch(JSON.stringify(detail),/private-student-token|Private Student/);assert.equal(detail.revision.length,64);
 await assert.rejects(f.client.assignment(token,6,1,now),/not released/);await assert.rejects(f.client.assignment(token,5,99,now),/no longer available/);
});
test('hidden sections are inaccessible and groups, timed activities and unhandled plugin requirements remain read-only',async()=>{
 const f=readerFixture();f.sections[0].uservisible=false;await assert.rejects(f.client.assignment(token,5,1,now),/not released/);assert.ok(!f.calls.includes('mod_assign_get_submission_status'));
 for(const patch of [{teamsubmission:1},{timelimit:3600},{configs:[{subtype:'assignsubmission',plugin:'mahara',name:'enabled',value:'1'}]}]){const g=readerFixture();Object.assign(g.assignment,patch);assert.ok((await g.client.assignment(token,5,1,now)).unsupportedReason);}
 const group=readerFixture();group.assignment.teamsubmission=1;group.assignment.requireallteammemberssubmit=1;group.last.teamsubmission={status:'submitted',plugins:[]};group.last.submissiongroupmemberswhoneedtosubmit=[7];assert.equal((await group.client.assignment(token,5,1,now)).status,'draft');
});
test('save and final-submit APIs use correct flattened parameters and reject warning arrays without exposing response details',async()=>{
 const requests:URLSearchParams[]=[];let warning=false;
 const client=new MoodleClient(site,async(_input,init)=>{requests.push(new URLSearchParams(String(init?.body)));return Response.json(warning?[{warningcode:'couldnotsave',message:token}]:[]);});
 await client.saveSubmission(token,5,99,'<script>my text</script>\nA & B');assert.equal(requests[0].get('assignmentid'),'5');assert.equal(requests[0].get('plugindata[files_filemanager]'),'99');assert.equal(requests[0].get('plugindata[onlinetext_editor][text]'),'&lt;script&gt;my text&lt;/script&gt;<br>A &amp; B');
 await client.submitForGrading(token,5,true);assert.equal(requests[1].get('acceptsubmissionstatement'),'1');warning=true;await assert.rejects(client.saveSubmission(token,5,99,undefined),error=>error instanceof MoodleError&&!error.message.includes(token));
});
test('uploads use the authenticated draft endpoint and keep every selected file in one draft area',async()=>{
 let count=0;const client=new MoodleClient(site,async(input,init)=>{assert.equal(String(input),site+'/webservice/upload.php');assert.equal(init?.redirect,'error');const form=init?.body as FormData;assert.equal(form.get('token'),token);assert.equal(form.get('itemid'),count?'99':'0');count++;const file=form.get('file_1') as File;return Response.json([{component:'user',filearea:'draft',itemid:99,filename:file.name}]);});
 assert.equal(await client.uploadDraft(token,[{name:'one.pdf',bytes:Buffer.from('one'),mime:'application/pdf'},{name:'two.pdf',bytes:Buffer.from('two'),mime:'application/pdf'}]),99);assert.equal(count,2);
 const rejected=new MoodleClient(site,async()=>Response.json({exception:'moodle_exception',message:token}));await assert.rejects(rejected.uploadDraft(token,[{name:'one.pdf',bytes:Buffer.from('one'),mime:'application/pdf'}]),error=>error instanceof MoodleError&&!error.message.includes(token));
});
test('downloads reject foreign hosts and redirects and bound streamed bytes, keeping credentials server-side',async()=>{
 assert.equal(trustedFile(site,{filename:'brief.pdf',fileurl:'https://evil.test/pluginfile.php/1/file.pdf'}),null);
 const file={name:'brief.pdf',url:site+'/webservice/pluginfile.php/1/brief.pdf',size:5,modifiedAt:1,mime:'application/pdf'};let calls=0;
 const client=new MoodleClient(site,async(input,init)=>{calls++;const url=new URL(String(input));assert.equal(url.origin,site);assert.equal(url.searchParams.get('token'),token);assert.equal(init?.redirect,'error');return new Response('%PDF-',{headers:{'content-type':'application/pdf'}});});assert.equal((await client.download(token,file,10)).toString(),'%PDF-');await assert.rejects(client.download(token,{...file,url:'https://evil.test/file'},10));assert.equal(calls,1);
 const oversized=new MoodleClient(site,async()=>new Response('too many bytes',{headers:{'content-type':'application/pdf'}}));await assert.rejects(oversized.download(token,{...file,size:0},5),/exceeds/);
});
test('Telegram receives file bytes as a multipart upload instead of a token-bearing Moodle URL',async()=>{
 let checked=false;const client=new TelegramClient('123:private_bot_token',async(input,init)=>{assert.match(String(input),/sendDocument$/);const form=init?.body as FormData;assert.equal(form.get('chat_id'),'111');const file=form.get('document') as File;assert.equal(file.name,'brief.pdf');assert.equal(await file.text(),'%PDF-');checked=true;return Response.json({ok:true,result:{}});});await client.sendDocument(111,'brief.pdf',Buffer.from('%PDF-'),'Professor brief');assert.ok(checked);
});
