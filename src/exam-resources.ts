import type {Store} from './store.ts';
import type {Vault} from './security.ts';
import type {AssignmentFile,Messenger,MoodleGateway} from './types.ts';
import {preparationItems} from './exams.ts';
import {ConcurrencyGate} from './limits.ts';
import {language,tr} from './locale.ts';
import {hashSecret} from './security.ts';

type Gateway=MoodleGateway&{download(token:string,file:AssignmentFile,maxBytes:number):Promise<Buffer>};
export class ExamResources{
 private active=new Set<number>();private gate=new ConcurrencyGate(2,8);
 private store:Store;private vault:Vault;private gateway:Gateway;private messenger:Messenger;private now:()=>number;
 constructor(store:Store,vault:Vault,gateway:Gateway,messenger:Messenger,now=()=>Math.floor(Date.now()/1000)){
  this.store=store;this.vault=vault;this.gateway=gateway;this.messenger=messenger;this.now=now;
 }
 async send(id:number,courseId:number):Promise<string>{
  const student=this.store.getStudent(id),t=(s:string,v:Record<string,string|number>={})=>tr(language(student?.language),s,v);
  if(!student?.moodleCipher||!this.store.courses(id).some(c=>c.id===courseId&&!c.muted))return t('This course is not available in your Moodle connection.');
  if(!this.gateway.preparationFiles||!this.messenger.sendDocument)return t('Preparation file delivery is unavailable. Open the resource links in Moodle.');
  const candidates=preparationItems(this.store.items(id),courseId).filter(x=>x.kind==='resource'||x.kind==='assignment').slice(0,30);
  if(!candidates.length)return t('No accessible preparation files have been published for this course.');
  if(this.active.has(id)||this.now()-Number(this.store.getMeta(`examFilesAt:${id}`)||0)<60)return t('Please wait a minute before requesting preparation files again.');
  this.active.add(id);let sent=0,skipped=0,failed=0;
  try{return await this.gate.run(async()=>{
   this.store.setMeta(`examFilesAt:${id}`,String(this.now()));
   const connectionHash=hashSecret(student.moodleCipher!);
   const current=()=>{const s=this.store.getStudent(id);if(!s?.moodleCipher||hashSecret(s.moodleCipher)!==connectionHash||!this.store.courses(id).some(c=>c.id===courseId&&!c.muted))throw new Error('Connection changed');return s;};
   current();const token=this.vault.open(student.moodleCipher!,`moodle:${id}`),deadline=Date.now()+90000;
   const documents=await this.gateway.preparationFiles!(token,courseId,candidates.map(x=>x.key));
   let total=0;
   for(const [index,{title,file}]of documents.entries()){
    if(Date.now()>=deadline||index>=12||file.size>20*1024*1024||total+file.size>30*1024*1024){skipped++;continue;}
    try{
     current();const bytes=await this.gateway.download(token,file,Math.min(20*1024*1024,30*1024*1024-total));total+=bytes.length;current();
     const name=file.name.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,180)||'preparation-file';
     await this.messenger.sendDocument!(student.chatId,name,bytes,title.slice(0,180));sent++;this.store.metric('telegram_file_sent',this.now());
    }catch{failed++;}
   }
   return t('Preparation files sent: {count}',{count:sent})+(skipped?'\n'+t('Skipped by transfer limits: {count}',{count:skipped}):'')+(failed?'\n'+t('Files not delivered: {count}',{count:failed}):'')+(!documents.length?'\n'+t('No accessible preparation files have been published for this course.'):'')+'\n'+t('Use Moodle links for other materials. File delivery does not confirm exam dates.');
  });}catch{return t('Preparation files could not be verified with Moodle. Open Moodle directly or try again later.')+(sent?'\n'+t('Preparation files sent: {count}',{count:sent}):'');}
  finally{this.active.delete(id);}
 }
}
