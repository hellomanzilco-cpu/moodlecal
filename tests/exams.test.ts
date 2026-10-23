import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.ts';
import {Vault} from '../src/security.ts';
import {Bot} from '../src/bot.ts';
import {ExamResources} from '../src/exam-resources.ts';
import {controlType,isExam,preparationItems} from '../src/exams.ts';
import {findChanges} from '../src/changes.ts';
import type {Item,MessageOptions,PreparationFile,MoodleGateway} from '../src/types.ts';

const NOW=1792700000;
const base=(overrides:Partial<Item>={}):Item=>({key:'quiz:1',courseId:8,courseName:'Economics',kind:'quiz',title:'Oraliq nazorat 1',description:'',url:'https://moodle.uwed.uz/mod/quiz/view.php?id=1',modifiedAt:NOW,dueAt:NOW+3600,startsAt:null,endsAt:null,completed:false,availability:'open',...overrides});
const resource=(overrides:Partial<Item>={}):Item=>base({key:'module:10',kind:'resource',title:'Yakuniy nazorat savollari',dueAt:null,files:[{name:'Questions.pdf',size:3,modifiedAt:NOW}],...overrides});
const file=(name='Questions.pdf',size=3):PreparationFile=>({title:'Final questions',file:{name,size,modifiedAt:NOW,url:'https://moodle.uwed.uz/webservice/pluginfile.php/1/course/intro/'+name,mime:'application/pdf'}});

test('teacher labels recognize English, Uzbek and Russian controls without turning dates, attendance, preparation or regular homework into exams',()=>{
 for(const title of ['Mid-term control','1-oraliq nazorat (1-Esse)','1 Оралик назорат - промежуточный контроль','2 ОН Оралик назорат - 2 ПК Промежуточный контроль'])assert.equal(controlType(base({title})),'midterm');
 for(const title of ['Final exam','YAKUNIY NAZORAT (Qayta topshirish)','ЯН -ЯКУНИЙ НАЗОРАТ (ИТОГОВЫЙ КОНТРОЛЬ)'])assert.equal(controlType(base({title})),'final');
 for(const title of ['Посещаемость','Joriy nazorat 1','ЖН 4','Seminar on 09.12.2026','Quality control','Final draft lecture','Control questions'])assert.equal(isExam(base({title})),false,title);
 assert.equal(controlType(base({title:'Эссе 1',files:[{name:'1_ОН_маг_ТИФ.pdf',size:1,modifiedAt:0}]})),'midterm');
 assert.equal(controlType(base({title:'ЖН 4',files:[{name:'4 ОН.docx',size:1,modifiedAt:0}]})),null);
 assert.equal(controlType(base({title:'Test',sectionName:'YAKUNIY NAZORAT'})),'final');
 assert.equal(isExam(resource()),false);
});

test('preparation matching stays in one course, respects access and separates midterm/final materials',()=>{
 const final=resource(),mid=resource({key:'module:11',title:'Oraliq nazorat savollari'}),general=resource({key:'module:12',title:'Revision questions'});
 const items=[final,mid,general,resource({key:'module:13',courseId:9}),resource({key:'module:14',availability:'restricted'}),resource({key:'module:15',title:'Lecture 1'})];
 assert.deepEqual(new Set(preparationItems(items,8,'final').map(x=>x.key)),new Set([final.key,general.key]));
 assert.deepEqual(new Set(preparationItems(items,8,'midterm').map(x=>x.key)),new Set([mid.key,general.key]));
});

test('new section metadata enriches old snapshots silently; later teacher section changes are explicit',()=>{
 const original=base(),enriched=base({sectionId:10,sectionName:'Midterm controls'});
 assert.deepEqual(findChanges([original],[enriched],'Asia/Tashkent'),[]);
 const changed={...enriched,sectionName:'Final controls'};
 assert.match(findChanges([enriched],[changed],'Asia/Tashkent')[0].details.join('\n'),/Section: Midterm controls → Final controls/);
 assert.match(findChanges([original],[{...enriched,dueAt:NOW+6000}],'Asia/Tashkent')[0].details.join('\n'),/Deadline:/);
});

test('Exams menu shows own controls and safe resource links; opening it never makes a Moodle request or invents an appointment',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const alice=store.ensureStudent(101,101),bob=store.ensureStudent(202,202);
 for(const student of [alice,bob])store.patchStudent(student.id,{moodleCipher:'encrypted',initialized:true,lastSyncAt:NOW});
 const course={id:8,name:'Economics <b>& trade',shortname:'E'};
 const control=base({key:'assignment:1',kind:'assignment',title:'Final control <script>',submissionStatus:'submitted_ungraded'});
 store.saveSnapshot(alice.id,{courses:[course],items:[control,resource()],warnings:[]},[],NOW,NOW+300);
 store.saveSnapshot(bob.id,{courses:[{id:9,name:'Other private course',shortname:'P'}],items:[base({courseId:9,title:'Private control'})],warnings:[]},[],NOW,NOW+300);
 const sent:{text:string;options?:MessageOptions}[]=[];let requests=0,seq=0;
 const bot=new Bot(store,{async send(_id,text,options){sent.push({text,options});}},{connectLink:()=>'https://bot.test/connect#token=test',calendarLink:()=>'',async sync(){requests++;},assignmentLink:(id,key)=>`https://bot.test/assignment#session=${id}-${key}`,async examFiles(id,courseId){assert.equal(id,alice.id);assert.equal(courseId,8);requests++;return 'Files sent';}});
 const send=async(id:number,text:string)=>{await bot.handle({update_id:++seq,message:{chat:{id,type:'private'},from:{id,is_bot:false},text}});return sent.at(-1)!;};
 const more=await send(101,'🧭 More');assert.ok(more.options?.reply_markup?.keyboard.flat().some(x=>x.text==='🎓 Exams'));
 const catalog=await send(101,'🎓 Exams');assert.match(catalog.text,/Final controls: 1/);assert.doesNotMatch(catalog.text,/Private control|Other private course/);
 const reply=await send(101,'🎓 8: Economics');assert.equal(reply.options?.parse_mode,'HTML');assert.match(reply.text,/Submission deadline:/);assert.match(reply.text,/Submitted · awaiting grade/);assert.match(reply.text,/Preparation materials/);assert.match(reply.text,/<a href="https:\/\/moodle.uwed.uz/);assert.match(reply.text,/Final control &lt;script&gt;/);assert.doesNotMatch(reply.text,/<script>|09.12.2026|10.12.2026/);assert.equal(requests,0);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM replies WHERE text LIKE ?').get('%session=%')!.c,0);
 assert.match((await send(202,'/exam 8')).text,/not available/);assert.match((await send(202,'/examfiles 8')).text,/Choose a subject/);assert.equal(requests,0);
 await send(101,'📎 Send preparation files');assert.equal(requests,1);
 await send(101,'/language uz');const uz=await send(101,'🎓 Imtihonlar');assert.match(uz.text,/Yakuniy nazoratlar: 1/);
 await send(101,'/language ru');const ru=await send(101,'🎓 Экзамены');assert.match(ru.text,/Итоговые: 1/);
 assert.match((await send(303,'/exams')).text,/Connect Moodle first/);
});

test('locally marked done does not claim a quiz was completed in Moodle',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const s=store.ensureStudent(101,101);store.patchStudent(s.id,{moodleCipher:'encrypted'});store.saveSnapshot(s.id,{courses:[{id:8,name:'E',shortname:'E'}],items:[base()],warnings:[]},[],NOW,NOW+300);store.markDone(s.id,'quiz:1',true);
 let reply='';const bot=new Bot(store,{async send(_id,text){reply=text;}},{connectLink:()=>'',calendarLink:()=>'',async sync(){}});
 await bot.handle({update_id:1,message:{chat:{id:101,type:'private'},from:{id:101,is_bot:false},text:'/exam 8'}});assert.doesNotMatch(reply,/Completed in Moodle/);
});

test('long exam lists paginate without splitting HTML and keep the selected subject for file delivery',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const student=store.ensureStudent(101,101);store.patchStudent(student.id,{moodleCipher:'encrypted'});
 const controls=Array.from({length:9},(_,i)=>base({key:`quiz:${i+1}`,title:'Final control '+i+' < & '.repeat(80),url:'https://moodle.uwed.uz/mod/quiz/view.php?id='+i,availableFrom:NOW,dueAt:NOW+100+i}));
 store.saveSnapshot(student.id,{courses:[{id:8,name:'Long course '.repeat(30),shortname:'E'}],items:[...controls,...Array.from({length:5},(_,i)=>resource({key:`module:${i+10}`,title:'Final preparation '+'questions '.repeat(60)}))],warnings:[]},[],NOW,NOW+300);
 const sent:{text:string;options?:MessageOptions}[]=[];let seq=0,files=0;
 const bot=new Bot(store,{async send(_id,text,options){sent.push({text,options});}},{connectLink:()=>'https://bot.test/connect',calendarLink:()=>'',async sync(){},async examFiles(id,course){assert.equal(id,student.id);assert.equal(course,8);files++;return 'sent';}});
 const send=async(text:string)=>{await bot.handle({update_id:++seq,message:{chat:{id:101,type:'private'},from:{id:101,is_bot:false},text}});return sent.at(-1)!;};
 for(const lang of ['en','uz','ru']){
  await send('/language '+lang);const first=await send('/exam 8');assert.ok(first.text.length<4000);assert.match(first.text,/1–4|4.*9/);
  const second=await send('➡️ Next page');assert.ok(second.text.length<4000);assert.match(second.text,/5–8|8.*9/);
 }
 await send('📎 Send preparation files');assert.equal(files,1);
 assert.equal(bot.isTransientChatText({message:{chat:{id:101,type:'private'},from:{id:101},text:'🎓 8: Long course'}}),false);
});

function filesFixture(t:{after(fn:()=>void):void}){
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64'));t.after(()=>store.close());
 const s=store.ensureStudent(101,101);store.patchStudent(s.id,{moodleCipher:vault.seal('own-token',`moodle:${s.id}`)});
 store.saveSnapshot(s.id,{courses:[{id:8,name:'E',shortname:'E'}],items:[resource()],warnings:[]},[],NOW,NOW+300);
 let documents=[file()],calls=0,downloads=0;const sent:string[]=[];
 const gateway:MoodleGateway&{download:()=>Promise<Buffer>}={async login(){throw new Error('unused');},async identify(){throw new Error('unused');},async snapshot(){throw new Error('unused');},async preparationFiles(token,courseId,keys){calls++;assert.equal(token,'own-token');assert.equal(courseId,8);assert.deepEqual(keys,['module:10']);return documents;},async download(){downloads++;return Buffer.from('pdf');}};
 const service=new ExamResources(store,vault,gateway,{async send(){},async sendDocument(chatId,name){assert.equal(chatId,101);sent.push(name);}},()=>NOW);
 return {store,s,gateway,service,sent,setDocuments(value:PreparationFile[]){documents=value;},get calls(){return calls;},get downloads(){return downloads;}};
}

test('file delivery revalidates ownership, sends only on request and rate limits repeated reads',async t=>{
 const f=filesFixture(t);
 assert.match(await f.service.send(f.s.id,9),/not available/);assert.equal(f.calls,0);
 assert.match(await f.service.send(f.s.id,8),/sent: 1/);assert.deepEqual(f.sent,['Questions.pdf']);
 assert.match(await f.service.send(f.s.id,8),/wait a minute/);assert.equal(f.calls,1);
 assert.equal(f.store.getStudent(f.s.id)!.lastSyncAt,NOW,'file reads must not pretend a full sync occurred');
});

test('disconnect during download prevents delivery of student files',async t=>{
 const f=filesFixture(t);f.gateway.download=async()=>{f.store.deleteStudent(f.s.id);return Buffer.from('pdf');};
 const result=await f.service.send(f.s.id,8);assert.match(result,/Files not delivered: 1/);assert.deepEqual(f.sent,[]);
});

test('a slow metadata lookup cannot start an unbounded batch of file downloads',async t=>{
 const f=filesFixture(t);let clock=100000;t.mock.method(Date,'now',()=>clock);
 f.gateway.preparationFiles=async()=>{clock+=90001;return [file()];};
 const result=await f.service.send(f.s.id,8);assert.match(result,/Skipped by transfer limits: 1/);assert.equal(f.downloads,0);assert.deepEqual(f.sent,[]);
});

test('file transfer limits and Moodle failures are reported without bypassing verification',async t=>{
 const f=filesFixture(t);f.setDocuments([file('big.pdf',21*1024*1024),...Array.from({length:13},(_,i)=>file('Q'+i+'.pdf'))]);
 const result=await f.service.send(f.s.id,8);assert.match(result,/Skipped by transfer limits: 3/);assert.equal(f.sent.length,11);assert.equal(f.downloads,11);
 const g=filesFixture(t);g.gateway.preparationFiles=async()=>{throw new Error('private provider response with token');};
 const failed=await g.service.send(g.s.id,8);assert.match(failed,/could not be verified/);assert.doesNotMatch(failed,/private provider|token/);assert.equal(g.downloads,0);assert.deepEqual(g.sent,[]);
});
