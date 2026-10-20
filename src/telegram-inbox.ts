import type {Store} from './store.ts';
import {Vault} from './security.ts';
import {TelegramError} from './telegram.ts';

const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
function normalized(value:unknown):{id:number;chatId:number;payload:unknown}|null{
  const envelope=object(value),id=envelope?.update_id;
  if(typeof id!=='number'||!Number.isSafeInteger(id)||id<0)return null;
  const message=object(envelope?.message),from=object(message?.from),chat=object(message?.chat),webApp=object(message?.web_app_data);
  if(!message||!from||!chat||chat.type!=='private'||from.is_bot===true||typeof from.id!=='number'||!Number.isSafeInteger(from.id)||from.id<=0||from.id!==chat.id)return {id,chatId:0,payload:null};
  const text=typeof message.text==='string'?message.text.slice(0,4096):null;
  let data:string|null=null;
  if(text===null&&typeof webApp?.data==='string'&&webApp.data.length<=4096){
    try{const action=object(JSON.parse(webApp.data))?.action;if(action==='connected'||action==='assignment_updated'||action==='refresh_connection')data=JSON.stringify({action});}catch{/* Ignore unsupported Mini App data. */}
  }
  if(text===null&&data===null)return {id,chatId:0,payload:null};
  return {id,chatId:from.id,payload:{update_id:id,message:{chat:{id:from.id,type:'private'},from:{id:from.id,is_bot:false},...(text===null?{web_app_data:{data}}:{text})}}};
}
function lane(payload:unknown):'menu'|'network'{
  const text=String(object(object(payload)?.message)?.text||'').trim();
  if(['👤 Profile','✅ Yes, share my profile','✅ Yes, update shared profile'].includes(text))return 'network';
  const slash=/^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text),command=slash?.[1].toLowerCase();
  return command==='profile'||command==='confirmsharing'||command==='start'&&/^pair_[A-Za-z0-9_-]{43}$/.test((slash?.[2]||'').trim())?'network':'menu';
}
/** Durable encrypted commands; preserve ordering within a chat while serving other students concurrently. */
export class TelegramInbox{
  private store:Store;private vault:Vault;private handle:(update:unknown)=>Promise<void>;private now:()=>number;
  private running=new Map<number,{chatId:number;lane:string;work:Promise<void>}>();private stopped=false;
  private isTransientText:(update:unknown)=>boolean;
  private transientQueues=new Map<number,NonNullable<ReturnType<typeof normalized>>[]>();
  private transientIds=new Set<number>();
  constructor(store:Store,vault:Vault,handle:(update:unknown)=>Promise<void>,now=()=>Math.floor(Date.now()/1000),isTransientText:(update:unknown)=>boolean=()=>false){
    this.store=store;this.vault=vault;this.handle=handle;this.now=now;this.isTransientText=isTransientText;
  }
  accept(updates:unknown[],advanceOffset=false):void{
    const unique=new Map<number,NonNullable<ReturnType<typeof normalized>>>();
    for(const update of updates){const value=normalized(update);if(value&&!unique.has(value.id))unique.set(value.id,value);}
    const values=[...unique.values()];
    const transientValues=values.filter(value=>value.chatId&&this.isTransientText(value.payload));
    const durableValues=values.filter(value=>!transientValues.includes(value));
    this.store.transaction(()=>{
      const pending=Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM telegram_inbox').get()?.count||0);
      const fresh=durableValues.filter(value=>value.chatId&&!this.store.hasUpdate(value.id)&&!this.store.db.prepare('SELECT 1 FROM telegram_inbox WHERE id=?').get(value.id));
      if(pending+fresh.length>2048)throw new Error('Telegram inbox is busy; delivery will retry.');
      let offset=Number(this.store.getMeta('telegramOffset')||0);
      for(const value of values){
        offset=Math.max(offset,value.id+1);
        if(this.store.hasUpdate(value.id)||transientValues.includes(value)||this.store.db.prepare('SELECT 1 FROM telegram_inbox WHERE id=?').get(value.id))continue;
        if(!value.chatId){this.store.finishUpdate(value.id,this.now());continue;}
        const count=Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM telegram_inbox WHERE chatId=?').get(value.chatId)?.count||0);
        if(count>=20){this.store.finishUpdate(value.id,this.now());this.store.metric('telegram_overload',this.now());continue;}
        this.store.db.prepare('INSERT INTO telegram_inbox(id,chatId,cipher,createdAt,nextAttempt,lane) VALUES(?,?,?,?,0,?)').run(value.id,value.chatId,this.vault.seal(JSON.stringify(value.payload),`telegram-inbox:${value.id}:${value.chatId}`),this.now(),lane(value.payload));
      }
      if(advanceOffset)this.store.setMeta('telegramOffset',String(offset));
    });
    for(const value of transientValues)this.queueTransient(value);
    this.pump();
  }
  pump():void{
    if(this.stopped||this.running.size>=6)return;
    const rows=this.store.db.prepare("SELECT q.id,q.chatId,q.cipher,q.attempts,q.createdAt,q.lane FROM telegram_inbox q WHERE q.nextAttempt<=? AND NOT EXISTS(SELECT 1 FROM telegram_inbox p WHERE p.chatId=q.chatId AND p.id<q.id) ORDER BY CASE WHEN q.lane='menu' THEN 0 ELSE 1 END,q.id LIMIT 256").all(this.now());
    const busy=new Set([...this.running.values()].map(value=>value.chatId));
    for(const row of rows){
      if(this.running.size>=6)break;
      const id=Number(row.id),chatId=Number(row.chatId);if(busy.has(chatId))continue;busy.add(chatId);
      if(row.lane==='network'&&[...this.running.values()].filter(value=>value.lane==='network').length>=2)continue;
      let healthy=true;
      const work=this.process(row).catch(()=>{healthy=false;/* SQLite failures wait for the next bounded worker tick. */}).finally(()=>{this.running.delete(id);if(healthy&&!this.stopped)this.pump();});
      this.running.set(id,{chatId,lane:String(row.lane),work});
    }
    this.dispatchTransient();
  }
  private queueTransient(value:NonNullable<ReturnType<typeof normalized>>):void{
    if(this.store.hasUpdate(value.id)||this.transientIds.has(value.id))return;
    const queue=this.transientQueues.get(value.chatId)||[];
    queue.push(value);queue.sort((a,b)=>a.id-b.id);this.transientQueues.set(value.chatId,queue);this.transientIds.add(value.id);
  }
  private dispatchTransient():void{
    if(this.stopped||this.running.size>=6)return;
    for(const [chatId,queue]of this.transientQueues){
      if(this.running.size>=6)break;
      if(!queue.length||[...this.running.values()].some(value=>value.chatId===chatId))continue;
      const value=queue[0];
      if(this.store.db.prepare('SELECT 1 FROM telegram_inbox WHERE chatId=? AND id<? LIMIT 1').get(chatId,value.id))continue;
      const work=(async()=>{try{if(!this.store.hasUpdate(value.id))await this.handle(value.payload);}catch{console.error('Transient Telegram text could not be delivered; it was discarded without persistence.');}finally{
        this.store.finishUpdate(value.id,this.now());this.transientIds.delete(value.id);
        const remaining=(this.transientQueues.get(chatId)||[]).filter(item=>item.id!==value.id);
        if(remaining.length)this.transientQueues.set(chatId,remaining);else this.transientQueues.delete(chatId);
        if(!this.stopped)this.pump();
      }})();
      this.running.set(value.id,{chatId,lane:'transient',work});
    }
  }
  private async process(row:Record<string,unknown>):Promise<void>{
    const id=Number(row.id),chatId=Number(row.chatId);
    try{
      if(Number(row.createdAt)<this.now()-86400){this.store.finishUpdate(id,this.now());this.store.db.prepare('DELETE FROM telegram_inbox WHERE id=?').run(id);this.store.metric('telegram_command_expired',this.now());return;}
      if(!this.store.hasUpdate(id))await this.handle(JSON.parse(this.vault.open(String(row.cipher),`telegram-inbox:${id}:${chatId}`)));
      this.store.db.prepare('DELETE FROM telegram_inbox WHERE id=?').run(id);
    }catch(error){
      const permanent=error instanceof TelegramError&&[400,403].includes(error.statusCode||0);
      if(permanent||Number(row.attempts)>=4||Number(row.createdAt)<this.now()-86400){
        this.store.transaction(()=>{
          this.store.finishUpdate(id,this.now());this.store.db.prepare('DELETE FROM telegram_inbox WHERE id=?').run(id);
          this.store.metric('telegram_job_failed',this.now());
          const student=this.store.byTelegram(chatId);
          if(permanent&&student)this.store.patchStudent(student.id,{paused:true});
          else if(student)this.store.enqueue(student.id,`command-failed:${id}`,'⚠️ I could not complete a previous action. Please open the menu and try again. Your coursework was not automatically resubmitted.',true);
        });
      }else{
        const wait=error instanceof TelegramError&&error.retryAfter?error.retryAfter:Math.min(60,2**Number(row.attempts));
        this.store.db.prepare('UPDATE telegram_inbox SET attempts=attempts+1,nextAttempt=? WHERE id=?').run(this.now()+wait,id);
      }
    }
  }
  stop():void{this.stopped=true;}
  async drain():Promise<void>{this.stop();await Promise.allSettled([...this.running.values()].map(value=>value.work));}
}
