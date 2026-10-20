import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';
import {Vault} from '../src/security.ts';
import {TelegramInbox} from '../src/telegram-inbox.ts';
import {TelegramError} from '../src/telegram.ts';

const NOW=1_800_000_000;
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const message=(id:number,chatId=101,text='/start')=>({update_id:id,message:{chat:{id:chatId,type:'private'},from:{id:chatId,is_bot:false},text}});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const pending=(store:Store)=>Number(store.db.prepare('SELECT COUNT(*) AS count FROM telegram_inbox').get()!.count);
async function settle(inbox:TelegramInbox,rounds=3){for(let i=0;i<rounds;i++){await turn();inbox.pump();}await turn();}

test('fresh-link Mini App requests survive inbox normalization with no student identifier or credentials from the payload',async t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64')),received:unknown[]=[];
 const inbox=new TelegramInbox(store,vault,async update=>{received.push(update);store.finishUpdate((update as {update_id:number}).update_id,NOW);},()=>NOW);
 t.after(async()=>{await inbox.drain();store.close();});
 inbox.accept([{update_id:1,message:{chat:{id:101,type:'private'},from:{id:101,is_bot:false},web_app_data:{data:JSON.stringify({action:'refresh_connection',studentId:999,password:'private-secret'})}}}]);
 await settle(inbox);assert.deepEqual(received,[{update_id:1,message:{chat:{id:101,type:'private'},from:{id:101,is_bot:false},web_app_data:{data:'{"action":"refresh_connection"}'}}}]);
});
test('a slow chat does not block another student and later commands stay in strict chat order',async t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64')),gate=deferred();
 const started:number[]=[],finished:number[]=[];
 const inbox=new TelegramInbox(store,vault,async update=>{const id=(update as {update_id:number}).update_id;started.push(id);if(id===1)await gate.promise;finished.push(id);store.finishUpdate(id,NOW);},()=>NOW);
 t.after(async()=>{gate.resolve();await inbox.drain();store.close();});
 inbox.accept([message(1,101),message(2,101),message(3,202),message(4,202)]);
 await settle(inbox);
 assert.deepEqual(started,[1,3,4]);assert.deepEqual(finished,[3,4]);
 gate.resolve();await settle(inbox);
 assert.deepEqual(started,[1,3,4,2]);assert.deepEqual(finished,[3,4,1,2]);assert.equal(pending(store),0);
});

test('worker concurrency stays bounded while additional chats remain durable',async t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64')),gate=deferred();let active=0,maxActive=0,calls=0;
 const inbox=new TelegramInbox(store,vault,async update=>{active++;maxActive=Math.max(maxActive,active);calls++;await gate.promise;active--;store.finishUpdate((update as {update_id:number}).update_id,NOW);},()=>NOW);
 t.after(async()=>{gate.resolve();await inbox.drain();store.close();});
 inbox.accept(Array.from({length:30},(_,i)=>message(i+1,100+i)));await turn();
 assert.equal(active,6);assert.equal(maxActive,6);assert.equal(pending(store),30);
 gate.resolve();await settle(inbox,12);assert.equal(calls,30);assert.equal(maxActive,6);assert.equal(pending(store),0);
});

test('capitalized and whitespace-prefixed network commands cannot exhaust workers reserved for fast menus',async t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64')),gate=deferred(),started:number[]=[];
 const inbox=new TelegramInbox(store,vault,async value=>{const id=(value as {update_id:number}).update_id;started.push(id);if(id<=6)await gate.promise;store.finishUpdate(id,NOW);},()=>NOW);
 t.after(async()=>{gate.resolve();await inbox.drain();store.close();});
 inbox.accept(['/PROFILE','  👤 Профиль',' /PROFILE@calmoodlebot ','  👤 Profil  ','✅ Ha, profilimni ulashish','  /start pair_'+('a'.repeat(43))].map((text,index)=>message(index+1,100+index,text)).concat([message(7,999,'🏠 Today')]));
 await settle(inbox);assert.ok(started.includes(7),'cached menus must remain available while Moodle profile calls wait');assert.equal(started.filter(id=>id<=6).length,2);
 gate.resolve();await settle(inbox,8);assert.equal(pending(store),0);
});

test('queued updates retain encrypted minimal payload, omit Telegram identity metadata and survive SQLite reopening',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'moodle-inbox-')),path=join(directory,'app.sqlite'),vault=new Vault(randomBytes(32).toString('base64'));
 let store=new Store(path),inbox=new TelegramInbox(store,vault,async()=>{throw new Error('Stopped inbox must not run');},()=>NOW);inbox.stop();
 const update={...message(71,101,'private command text'),message:{...message(71).message,from:{id:101,is_bot:false,first_name:'Private first',last_name:'Private last',username:'private_username'},chat:{id:101,type:'private',first_name:'Private first'},text:'private command text',photo:[{file_id:'private-file'}],contact:{phone_number:'private-number'},web_app_data:{data:JSON.stringify({action:'connected',password:'private-password'})}}};
 inbox.accept([update],true);
 const row=store.db.prepare('SELECT * FROM telegram_inbox').get()!;
 assert.deepEqual(Object.keys(row).sort(),['attempts','chatId','cipher','createdAt','id','lane','nextAttempt'].sort());
 assert.doesNotMatch(String(row.cipher),/private command|Private first|private_username|private-password|private-number/);
 assert.deepEqual(JSON.parse(vault.open(String(row.cipher),'telegram-inbox:71:101')),message(71,101,'private command text'));
 assert.equal(store.getMeta('telegramOffset'),'72');store.close();
 store=new Store(path);const received:unknown[]=[];
 inbox=new TelegramInbox(store,vault,async value=>{received.push(value);store.finishUpdate((value as {update_id:number}).update_id,NOW);},()=>NOW);
 t.after(async()=>{await inbox.drain();store.close();rmSync(directory,{recursive:true,force:true});});
 inbox.pump();await settle(inbox);assert.deepEqual(received,[message(71,101,'private command text')]);assert.equal(pending(store),0);assert.equal(store.getMeta('telegramOffset'),'72');
 inbox.accept([update],true);await settle(inbox);assert.equal(received.length,1);
});

test('unstructured Telegram text is handled transiently without writing its contents to the durable inbox',async t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64')),received:unknown[]=[];
 const secret='accidentally-pasted-moodle-password';
 const inbox=new TelegramInbox(store,vault,async value=>{received.push(value);store.finishUpdate((value as {update_id:number}).update_id,NOW);},()=>NOW,()=>true);
 t.after(async()=>{await inbox.drain();store.close();});
 inbox.accept([message(81,101,secret)],true);await settle(inbox);
 assert.equal(pending(store),0);assert.equal(store.hasUpdate(81),true);assert.equal(received.length,1);
 assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT * FROM telegram_inbox').all()),new RegExp(secret));
});

test('duplicates before, during and after processing execute one command and keep offset monotonic',async t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64')),gate=deferred();let calls=0;
 const inbox=new TelegramInbox(store,vault,async value=>{calls++;await gate.promise;store.finishUpdate((value as {update_id:number}).update_id,NOW);},()=>NOW);
 t.after(async()=>{gate.resolve();await inbox.drain();store.close();});
 inbox.accept([message(11),message(11),message(11)],true);inbox.accept([message(11)],true);await turn();
 assert.equal(calls,1);assert.equal(pending(store),1);assert.equal(store.getMeta('telegramOffset'),'12');
 gate.resolve();await settle(inbox);inbox.accept([message(11),{update_id:8,message:{text:'ignored'}}],true);await settle(inbox);
 assert.equal(calls,1);assert.equal(pending(store),0);assert.equal(store.getMeta('telegramOffset'),'12');
});

test('invalid, group, bot and mismatched sender updates are ignored and cannot authorize Mini App actions',async t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64'));const received:unknown[]=[];
 const inbox=new TelegramInbox(store,vault,async value=>{received.push(value);store.finishUpdate((value as {update_id:number}).update_id,NOW);},()=>NOW);
 t.after(async()=>{await inbox.drain();store.close();});
 inbox.accept([null,{}, {update_id:-1}, {update_id:1.2}, {update_id:Number.MAX_SAFE_INTEGER+1},
  {...message(1),message:{...message(1).message,chat:{id:-101,type:'group'}}},
  {...message(2),message:{...message(2).message,from:{id:202,is_bot:false}}},
  {...message(3),message:{...message(3).message,from:{id:101,is_bot:true}}},
  {update_id:4,callback_query:{from:{id:101},data:'connected'}},
  {...message(5),message:{...message(5).message,text:undefined,web_app_data:{data:'{"action":"grant_access","token":"secret"}'}}},
  {...message(6),message:{...message(6).message,text:undefined,web_app_data:{data:'not-json'}}},
  {...message(7),message:{...message(7).message,text:undefined,web_app_data:{data:JSON.stringify({action:'connected',owner:true,token:'secret'})}}},
 ],true);
 await settle(inbox);
 assert.equal(received.length,1);
 assert.deepEqual(received[0],{update_id:7,message:{chat:{id:101,type:'private'},from:{id:101,is_bot:false},web_app_data:{data:'{"action":"connected"}'}}});
 for(let id=1;id<=7;id++)assert.ok(store.hasUpdate(id));assert.equal(store.getMeta('telegramOffset'),'8');assert.equal(store.statistics().students!.total,0);
});

test('per-chat floods stay bounded and dropped commands are recorded once without blocking other students',async t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64'));let calls=0;
 const inbox=new TelegramInbox(store,vault,async()=>{calls++;},()=>NOW);inbox.stop();t.after(()=>store.close());
 inbox.accept([...Array.from({length:40},(_,i)=>message(i+1,101)),message(41,202)],true);
 assert.equal(calls,0);assert.equal(pending(store),21);assert.equal(store.getMeta('telegramOffset'),'42');
 assert.ok(store.hasUpdate(21));assert.ok(store.hasUpdate(40));assert.equal(store.db.prepare('SELECT count FROM usage_daily WHERE event=?').get('telegram_overload')!.count,20);
 inbox.accept([message(21,101)],true);assert.equal(store.db.prepare('SELECT count FROM usage_daily WHERE event=?').get('telegram_overload')!.count,20);
});

test('a full global backlog rejects new delivery atomically and leaves Telegram offset retryable',t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64')),inbox=new TelegramInbox(store,vault,async()=>{},()=>NOW);inbox.stop();t.after(()=>store.close());
 inbox.accept(Array.from({length:2048},(_,i)=>message(i+1,1000+Math.floor(i/20))),true);
 assert.equal(pending(store),2048);assert.equal(store.getMeta('telegramOffset'),'2049');
 assert.throws(()=>inbox.accept([message(2049,9999)],true),/inbox is busy/);
 assert.equal(pending(store),2048);assert.equal(store.getMeta('telegramOffset'),'2049');assert.equal(store.hasUpdate(2049),false);
});

test('duplicate IDs in one batch do not exaggerate global backlog pressure',t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64')),inbox=new TelegramInbox(store,vault,async()=>{},()=>NOW);inbox.stop();t.after(()=>store.close());
 inbox.accept(Array.from({length:2047},(_,i)=>message(i+1,1000+Math.floor(i/20))),true);
 assert.doesNotThrow(()=>inbox.accept([message(2048,9999),message(2048,9999)],true));assert.equal(pending(store),2048);assert.equal(store.getMeta('telegramOffset'),'2049');
});

test('Telegram 429 respects retry_after, keeps chat order and lets another chat progress',async t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64'));let clock=NOW,attempts=0;const done:number[]=[];
 const inbox=new TelegramInbox(store,vault,async value=>{const id=(value as {update_id:number}).update_id;if(id===1&&++attempts===1)throw new TelegramError('temporary',30,429);done.push(id);store.finishUpdate(id,clock);},()=>clock);
 t.after(async()=>{await inbox.drain();store.close();});
 inbox.accept([message(1,101),message(2,101),message(3,202)]);await settle(inbox);
 assert.deepEqual(done,[3]);assert.equal(store.db.prepare('SELECT nextAttempt FROM telegram_inbox WHERE id=1').get()!.nextAttempt,NOW+30);
 clock=NOW+29;await settle(inbox);assert.equal(attempts,1);assert.deepEqual(done,[3]);
 clock++;await settle(inbox);assert.equal(attempts,2);assert.deepEqual(done,[3,1,2]);assert.equal(pending(store),0);
});

test('a poison command has bounded retries, queues one safe failure receipt and releases later commands',async t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64')),student=store.ensureStudent(101,101);let clock=NOW,attempts=0;const done:number[]=[];
 const inbox=new TelegramInbox(store,vault,async value=>{const id=(value as {update_id:number}).update_id;if(id===1){attempts++;throw new Error('private token or internal error');}done.push(id);store.finishUpdate(id,clock);},()=>clock);
 t.after(async()=>{await inbox.drain();store.close();});
 inbox.accept([message(1),message(2)]);await settle(inbox);
 for(const wait of [1,2,4,8]){clock+=wait;await settle(inbox);}
 assert.equal(attempts,5);assert.ok(store.hasUpdate(1));assert.deepEqual(done,[2]);assert.equal(pending(store),0);
 const receipts=store.pending(clock);assert.equal(receipts.length,1);assert.equal(receipts[0].studentId,student.id);assert.match(receipts[0].text,/not automatically resubmitted/);assert.doesNotMatch(receipts[0].text,/private token|internal error/);
 inbox.accept([message(1)]);await settle(inbox);assert.equal(attempts,5);assert.equal(store.pending(clock).length,1);
});

test('permanent Telegram refusal pauses alerts without endless retries and expired commands never execute',async t=>{
 const store=new Store(':memory:'),vault=new Vault(randomBytes(32).toString('base64')),student=store.ensureStudent(101,101);let clock=NOW,calls=0;
 const first=new TelegramInbox(store,vault,async()=>{calls++;throw new TelegramError('blocked',undefined,403);},()=>clock);
 first.accept([message(1)]);await settle(first);await first.drain();assert.equal(calls,1);assert.equal(store.getStudent(student.id)!.paused,true);assert.ok(store.hasUpdate(1));
 const expired=new TelegramInbox(store,vault,async()=>{calls++;},()=>clock);expired.stop();expired.accept([message(2)]);clock+=86401;
 const restarted=new TelegramInbox(store,vault,async()=>{calls++;},()=>clock);t.after(async()=>{await restarted.drain();store.close();});restarted.pump();await settle(restarted);
 assert.equal(calls,1);assert.ok(store.hasUpdate(2));assert.equal(pending(store),0);assert.equal(store.db.prepare('SELECT count FROM usage_daily WHERE event=?').get('telegram_command_expired')!.count,1);
});
