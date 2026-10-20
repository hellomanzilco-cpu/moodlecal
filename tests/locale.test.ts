import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Bot} from '../src/bot.ts';
import {Vault} from '../src/security.ts';
import {SyncService} from '../src/sync.ts';
import {MoodleError} from '../src/moodle.ts';
import {syncFailure} from '../src/sync-errors.ts';
import {language,languageNames,tr} from '../src/locale.ts';
import {connectionPage} from '../src/connect-page.ts';
import {assignmentPage} from '../src/assignment-page.ts';
import {formatChanges} from '../src/changes.ts';
import type {Item,MessageOptions} from '../src/types.ts';

function fixture(t:{after(fn:()=>void):void}){
 const store=new Store(':memory:');t.after(()=>store.close());
 const sent:{text:string;options?:MessageOptions}[]=[],links:{id:number;key:string}[]=[];let networkCalls=0;
 const services={connectLink:(id:number)=>'https://bot.test/connect#token=private-'+id,assignmentLink:(id:number,key:string)=>{links.push({id,key});return 'https://bot.test/assignment#session=private-'+id+'-'+key;},calendarLink:()=>'',privacyUrl:'https://bot.test/privacy',async sync(){networkCalls++;},async profile(){networkCalls++;return {firstName:'Private',lastName:'Name',username:'private-moodle-name'};}};
 const messenger={async send(_id:number,text:string,options?:MessageOptions){sent.push({text,options});}};
 const bot=new Bot(store,messenger,services);let seq=0;
 async function send(id:number,text:string,instance=bot){await instance.handle({update_id:++seq,message:{chat:{id,type:'private'},from:{id,is_bot:false},text}});return sent.at(-1)!;}
 function connect(id:number){const student=store.ensureStudent(id,id);store.patchStudent(student.id,{moodleCipher:'encrypted',initialized:true,lastSyncAt:Math.floor(Date.now()/1000)});return store.getStudent(student.id)!;}
 return {store,sent,send,bot,services,messenger,links,connect,get networkCalls(){return networkCalls;}};
}
const labels=(options?:MessageOptions)=>options?.reply_markup?.keyboard.flat().map(button=>button.text)||[];
test('new students can choose Uzbek or Russian without connecting; preferences stay per student across Bot restarts',async t=>{
 const f=fixture(t);await f.send(101,'/start');assert.ok(labels(f.sent.at(-1)!.options).includes('🌐 Language'));
 await f.send(101,'🌐 Language');assert.ok(labels(f.sent.at(-1)!.options).includes(languageNames.uz));
 let reply=await f.send(101,languageNames.uz);assert.match(reply.text,/Parolingiz saqlanmaydi/);assert.ok(labels(reply.options).includes('🔗 Moodle hisobini ulash'));
 assert.equal(f.store.byTelegram(101)!.language,'uz');assert.equal(f.store.byTelegram(101)!.moodleCipher,null);
 await f.send(202,'/start');assert.equal(f.store.byTelegram(202)!.language,'en');
 const restarted=new Bot(f.store,f.messenger,f.services);reply=await f.send(101,'⚙️ Sozlamalar',restarted);assert.match(reply.text,/Til: 🇺🇿/);
 await f.send(101,'🌐 Til',restarted);reply=await f.send(101,languageNames.ru,restarted);assert.match(reply.text,/Язык сохранён/);assert.ok(labels(reply.options).includes('🔗 Подключить Moodle'));
 assert.equal(f.store.byTelegram(202)!.language,'en');assert.equal(f.networkCalls,0);
 await f.send(101,'/language javascript:evil',restarted);assert.equal(f.store.byTelegram(101)!.language,'ru');
});

test('minimal main menu, localized categories and private task links keep Moodle content intact and reuse each session',async t=>{
 const f=fixture(t),alice=f.connect(101),bob=f.connect(202),now=Math.floor(Date.now()/1000);
 const item:Item={key:'assignment:21',courseId:1,courseName:'Settings <trade>',kind:'assignment',title:'Grade: <script>& Essay',description:'Professor text must stay unchanged.',url:'https://moodle.uwed.uz/mod/assign/view.php?id=21',modifiedAt:now,dueAt:now+60,startsAt:null,endsAt:null,completed:false,availability:'open',submissionStatus:'outstanding'};
 f.store.saveSnapshot(alice.id,{courses:[{id:1,name:item.courseName,shortname:'E'}],items:[item],warnings:[]},[],now,now+300);
 await f.send(101,'/language uz');let reply=await f.send(101,'/start');
 assert.deepEqual(labels(reply.options),['📝 Topshiriqlar','🔄 Yangilash','🧭 Qo‘shimcha','⚙️ Sozlamalar']);assert.match(reply.text,/Bajarilmagan: 1/);assert.doesNotMatch(reply.text,/<pre>|█|STATUS DISTRIBUTION|\d+%/);assert.equal(f.networkCalls,0);
 reply=await f.send(101,'📅 Shu haftadagi muddatlar');assert.match(reply.text,/<a href="https:\/\/bot.test\/assignment#session=private-/);
 assert.match(reply.text,/Grade: &lt;script&gt;&amp; Essay<\/a>/);assert.doesNotMatch(reply.text,/<script>/);assert.match(reply.text,/Settings &lt;trade&gt;/);
 assert.equal(f.links.length,1);assert.equal(f.links[0].id,alice.id);assert.equal(reply.options!.reply_markup!.keyboard[0][0].web_app!.url,'https://bot.test/assignment#session=private-'+alice.id+'-assignment:21');assert.equal(reply.options!.parse_mode,'HTML');assert.ok(reply.text.length<2000);
 assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS count FROM replies WHERE text LIKE ?').get('%private-%')!.count),0,'private task capabilities must not be stored in reply history');
 assert.equal(f.store.getStudent(bob.id)!.language,'en');assert.equal(f.networkCalls,0);
 await f.send(101,'🌐 Til');await f.send(101,languageNames.ru);reply=await f.send(101,'📝 Assignments');assert.match(reply.text,/Не завершены: 1/);assert.equal(f.store.rawItems(alice.id)[0].title,item.title);
});

test('privacy wording states real protections and diagnostic/backup limits in all three languages',async t=>{
 const f=fixture(t);f.connect(101);
 for(const lang of ['en','uz','ru'] as const){await f.send(101,'/language '+lang);const reply=await f.send(101,'🔐 Privacy');assert.equal(reply.options!.parse_mode,'HTML');assert.match(reply.text,/<a href=/);assert.doesNotMatch(reply.text,/100%|completely secure|never collect any data/);assert.ok(reply.text.length<2500);}
 assert.equal(f.networkCalls,0);
});

test('changing language cancels an old destructive confirmation instead of accepting a stale keyboard',async t=>{
 const f=fixture(t),student=f.connect(101);await f.send(101,'🔒 Disconnect');await f.send(101,'/language ru');
 await f.send(101,'🗑 Yes, disconnect');assert.ok(f.store.getStudent(student.id)?.moodleCipher);assert.equal(f.store.getStudent(student.id)!.language,'ru');
});

test('localized pages compile, retain protocol identifiers and safety confirmations, and cannot inject a language parameter',()=>{
 for(const lang of ['en','uz','ru'] as const){
  const connect=connectionPage('safe-nonce','https://moodle.uwed.uz',lang),assignment=assignmentPage('safe-nonce',lang);
  for(const page of [connect,assignment])for(const script of page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new Script(script[1]));
  assert.match(connect,new RegExp('<html lang="'+lang+'"'));assert.match(assignment,new RegExp('<html lang="'+lang+'"'));
  assert.match(connect,/\/api\/connect\/check/);assert.match(connect,/refresh_connection/);assert.match(connect,/asyncMode:true/);
  assert.match(assignment,/data.status==='submitted'/);assert.match(assignment,/statementAccepted/);assert.match(assignment,/replaceExisting/);assert.match(assignment,/confirmedNotSubmitted:true/);
  if(lang==='uz'){assert.match(connect,/Moodle hisobingizni ulang/);assert.match(assignment,/O‘qituvchining topshirig‘i/);assert.match(assignment,/Baholash uchun topshirish/);}
  if(lang==='ru'){assert.match(connect,/Подключите Moodle/);assert.match(assignment,/Задание преподавателя/);assert.match(assignment,/Отправить на оценивание/);}
 }
 assert.equal(language('ru<script>'),'en');
});

test('sync results and safe failures use the chosen language and preserve the exact Moodle title and API code',()=>{
 const result={checkedAt:1792513500,baseline:false,changes:[{key:'assignment:1',type:'updated' as const,title:'Settings & assignment',courseName:'Grades 101',url:'https://moodle.uwed.uz',details:['Deadline: today → tomorrow']}]};
 for(const lang of ['uz','ru'] as const){const text=formatChanges(result,'Asia/Tashkent',lang);assert.match(text,/Settings & assignment/);assert.match(text,/Grades 101/);assert.doesNotMatch(text,/1 change found/);
  const error=new MoodleError('private username/token secret',true,'network');error.operation='mod_assign_get_submission_status';error.apiErrorCode='timeout';const message=syncFailure(error,lang);assert.match(message,/timeout/);assert.doesNotMatch(message,/private username|token secret/);assert.doesNotMatch(message,/Failed check:/);}
});

test('connection links follow the saved language without contacting Moodle or changing authentication rules',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const student=store.ensureStudent(101,101);store.patchStudent(student.id,{language:'ru'});
 const vault=new Vault(randomBytes(32).toString('base64'));let calls=0;const service=new SyncService(store,vault,{async login(){calls++;return '';},async identify(){calls++;return {userId:1,name:'',functions:[]};},async snapshot(){calls++;return {items:[],courses:[],warnings:[]};}},{async send(){}},'https://bot.test',300);
 const link=new URL(service.connectLink(student.id));assert.equal(link.searchParams.get('lang'),'ru');assert.ok(link.hash.startsWith('#token='));assert.equal(calls,0);assert.equal(store.getStudent(student.id)!.moodleCipher,null);
 assert.equal(tr('uz','Due: {time}',{time:'12:30'}),'Muddat: 12:30');
});

test('language migration preserves an existing account and preferences survive a database reopen',()=>{
 const directory=mkdtempSync(join(tmpdir(),'moodle-language-')),path=join(directory,'legacy.sqlite');let store:Store|null=null;
 try{
  const old=new DatabaseSync(path);old.exec(`CREATE TABLE students(id INTEGER PRIMARY KEY,telegramId INTEGER NOT NULL UNIQUE,chatId INTEGER NOT NULL,timezone TEXT NOT NULL,moodleCipher TEXT,calendarHash TEXT UNIQUE,calendarCipher TEXT,linkHash TEXT UNIQUE,linkExpires INTEGER,lastSyncAt INTEGER,nextSyncAt INTEGER NOT NULL DEFAULT 0,lastError TEXT,initialized INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0); INSERT INTO students(id,telegramId,chatId,timezone,moodleCipher,lastSyncAt) VALUES(1,101,101,'Asia/Tashkent','existing-encrypted-token',12345);`);old.close();
  store=new Store(path);assert.equal(store.getStudent(1)!.language,'en');assert.equal(store.getStudent(1)!.moodleCipher,'existing-encrypted-token');assert.equal(store.getStudent(1)!.lastSyncAt,12345);
  store.patchStudent(1,{language:'uz'});assert.throws(()=>store!.patchStudent(1,{language:'bad' as never}));store.close();store=new Store(path);assert.equal(store.getStudent(1)!.language,'uz');assert.equal(store.getStudent(1)!.moodleCipher,'existing-encrypted-token');
 }finally{store?.close();unlinkSync(path);rmdirSync(directory);}
});
