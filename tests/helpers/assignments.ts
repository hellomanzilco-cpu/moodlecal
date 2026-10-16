import {randomBytes} from 'node:crypto';
import {Store} from '../../src/store.ts';
import {Vault,hashSecret} from '../../src/security.ts';
import {AssignmentService} from '../../src/assignments.ts';
import {assignmentLink} from '../../src/assignment-session.ts';
import {loadConfig} from '../../src/config.ts';
import {SyncService} from '../../src/sync.ts';
import {createApp} from '../../src/api.ts';
import type {AssignmentDetail,AssignmentGateway,Item,SubmissionFile} from '../../src/types.ts';
export function assignmentDetail(patch:Partial<AssignmentDetail>={}):AssignmentDetail{return {id:5,courseId:1,title:'Trade essay',courseName:'Economics',description:'Read the brief and explain your reasoning.\nSubmit a PDF.',url:'https://moodle.uwed.uz/mod/assign/view.php?id=8',dueAt:2_000_000_000,availableFrom:null,cutoffAt:null,availability:'open',availabilityReason:'Moodle permits editing.',status:'new',graded:false,grade:null,submittedAt:null,canEdit:true,canSubmit:false,requiresFinalSubmit:false,requiresStatement:false,statement:'',fileEnabled:true,textEnabled:false,maxFiles:3,maxFileBytes:5*1024*1024,acceptedTypes:['.pdf'],wordLimit:null,unsupportedReason:null,attachments:[{name:'teacher-brief.pdf',size:5,modifiedAt:1,url:'https://moodle.uwed.uz/webservice/pluginfile.php/10/mod_assign/introattachment/0/teacher-brief.pdf',mime:'application/pdf'}],submittedFiles:[],onlineText:'',attempt:0,revision:hashSecret('original'),...patch};}
export function assignmentFixture(){
 const config=loadConfig({ENCRYPTION_KEY:randomBytes(32).toString('base64'),PUBLIC_URL:'https://planner.test'}),store=new Store(':memory:'),vault=new Vault(config.encryptionKey);
 let detail=assignmentDetail(),uploaded:SubmissionFile[]=[],clock=Math.floor(Date.now()/1000);const calls:{kind:string;token:string}[]=[];const sent:{chatId:number;name:string;bytes:Buffer}[]=[];
 const student=store.ensureStudent(111,111),token='private-moodle-token';store.patchStudent(student.id,{moodleCipher:vault.seal(token,`moodle:${student.id}`)});
 const item:Item={key:'assignment:5',courseId:1,courseName:'Economics',kind:'assignment',title:'Trade essay',description:'Brief',url:detail.url,modifiedAt:1,dueAt:detail.dueAt,startsAt:null,endsAt:null,completed:false,availability:'open',submissionStatus:'outstanding'};
 store.saveSnapshot(student.id,{courses:[{id:1,name:'Economics',shortname:'ECO'}],items:[item],warnings:[]},[],clock,clock+300);
 const messenger={async send(){},async sendDocument(chatId:number,name:string,bytes:Buffer){sent.push({chatId,name,bytes:Buffer.from(bytes)});}};
 const gateway:AssignmentGateway={async assignment(value){calls.push({kind:'read',token:value});return structuredClone(detail);},async download(value,file){calls.push({kind:'download',token:value});return Buffer.from(uploaded.find(f=>f.name===file.name)?.bytes||'%PDF-');},async uploadDraft(value,files){calls.push({kind:'upload',token:value});uploaded=files.map(f=>({...f,bytes:Buffer.from(f.bytes)}));return 99;},async saveSubmission(value,_id,_draft,text){calls.push({kind:'save',token:value});detail={...detail,submittedFiles:uploaded.map(f=>({name:f.name,size:f.bytes.length,modifiedAt:clock,url:'https://moodle.uwed.uz/webservice/pluginfile.php/10/assignsubmission_file/submission_files/1/'+f.name,mime:f.mime})),onlineText:text||'',status:detail.requiresFinalSubmit?'draft':'submitted',canSubmit:detail.requiresFinalSubmit,submittedAt:clock,revision:hashSecret('saved')};},async submitForGrading(value){calls.push({kind:'finalize',token:value});detail={...detail,status:'submitted',canSubmit:false,revision:hashSecret('submitted')};}};
 const service=new AssignmentService(store,vault,gateway,messenger,()=>clock);
 const raw=new URLSearchParams(new URL(assignmentLink(store,config.publicUrl,student.id,'assignment:5',clock)).hash.slice(1)).get('session')!,session=service.session(raw);
 const moodle={async login(){return token;},async identify(){return {userId:1,name:'Private Person',functions:[]};},async snapshot(){return {courses:[],items:[],warnings:[]};}};
 const sync=new SyncService(store,vault,moodle,messenger,config.publicUrl,300),app=createApp(config,store,sync,moodle,async()=>{},service);
 return {config,store,vault,student,service,session,raw,token,gateway,sent,calls,sync,app,get detail(){return detail;},set detail(value:AssignmentDetail){detail=value;},advance(seconds:number){clock+=seconds;},async close(){await service.drain();await app.close();store.close();}};
}
