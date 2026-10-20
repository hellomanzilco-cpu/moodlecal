import {hashSecret} from './security.ts';
import {createHash} from 'node:crypto';
import {assignmentSession} from './assignment-session.ts';
import {MoodleError} from './moodle.ts';
import {findChanges} from './changes.ts';
import {formatTime} from './planning.ts';
import {ConcurrencyGate} from './limits.ts';
import {language,tr} from './locale.ts';
import type {Store} from './store.ts';
import type {Vault} from './security.ts';
import type {AssignmentDetail,AssignmentFile,AssignmentGateway,Messenger,SubmissionFile} from './types.ts';
export const MAX_UPLOAD_BYTES=20*1024*1024,MAX_UPLOAD_FILES=10;
export type PortalSession=NonNullable<ReturnType<typeof assignmentSession>>;
export interface SubmissionRequest {operationId:string;revision:string;confirm:true;replaceExisting:boolean;statementAccepted:boolean;onlineText?:string}
interface Proof {files:{name:string;size:number;sha256:string}[];textHash:string|null}
export interface SubmissionOperation {id:string;studentId:number;assignmentKey:string;connectionHash:string;state:'working'|'submitted'|'draft'|'failed'|'uncertain';stage:string;message:string;proof:string;createdAt:number;updatedAt:number}
export class AssignmentError extends Error {status:number;constructor(message:string,status=400){super(message);this.name='AssignmentError';this.status=status;}}
const normalizeText=(value:string)=>value.normalize('NFC').replace(/\s+/gu,' ').trim();
const fileId=(file:AssignmentFile)=>hashSecret(JSON.stringify(file));
export function publicAssignment(detail:AssignmentDetail,timezone:string){return {...detail,attachments:detail.attachments.map(file=>({id:fileId(file),name:file.name,size:file.size,mime:file.mime})),submittedFiles:detail.submittedFiles.map(file=>({id:fileId(file),name:file.name,size:file.size,mime:file.mime})),timezone,botLimits:{maxFiles:MAX_UPLOAD_FILES,maxTotalBytes:MAX_UPLOAD_BYTES},checkedAt:Math.floor(Date.now()/1000)};}
export function parseSubmissionRequest(value:unknown):SubmissionRequest{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new AssignmentError('Submission review is missing.');const data=value as Record<string,unknown>;
 if(Object.keys(data).some(k=>!['operationId','revision','confirm','replaceExisting','statementAccepted','onlineText'].includes(k))||typeof data.operationId!=='string'||!/^[-\w]{43}$/.test(data.operationId)||typeof data.revision!=='string'||!/^([a-f\d]{64})$/.test(data.revision)||data.confirm!==true||typeof data.replaceExisting!=='boolean'||typeof data.statementAccepted!=='boolean'||(data.onlineText!==undefined&&(typeof data.onlineText!=='string'||data.onlineText.length>100000)))throw new AssignmentError('Review the assignment and explicitly confirm your submission.');
 return data as unknown as SubmissionRequest;
}
export function validateSubmission(detail:AssignmentDetail,request:SubmissionRequest,files:SubmissionFile[]):void{
 if(request.confirm!==true)throw new AssignmentError('Explicitly confirm your reviewed submission.');
 if(detail.revision!==request.revision)throw new AssignmentError('The assignment requirements or submission changed since you opened it. Refresh and review again.',409);
 if(detail.unsupportedReason)throw new AssignmentError(detail.unsupportedReason);
 if(detail.status==='unknown')throw new AssignmentError('Moodle did not confirm your current submission status. Refresh or open Moodle before uploading.');
 if(detail.availability!=='open'||!detail.canEdit)throw new AssignmentError(detail.availabilityReason||'Moodle is not allowing new uploads.');
 if(detail.requiresStatement&&!request.statementAccepted)throw new AssignmentError('Read and accept the teacher’s submission statement first.');
 if((detail.submittedFiles.length||detail.onlineText||detail.status==='submitted')&&!request.replaceExisting)throw new AssignmentError('Confirm replacing the current submission contents. The selected files replace the existing file set.');
 if(files.length>Math.min(detail.maxFiles,MAX_UPLOAD_FILES)||files.length>MAX_UPLOAD_FILES)throw new AssignmentError('Too many files for this assignment.');
 if(detail.fileEnabled&&!files.length)throw new AssignmentError('Choose your submission files. To preserve an existing file set without re-uploading it, edit directly in Moodle.');
 if(!detail.fileEnabled&&files.length)throw new AssignmentError('The teacher has not enabled file submissions.');
 const names=new Set<string>();let total=0;
 for(const file of files){
  if(!file.name||file.name.length>180||/[\\/\u0000-\u001f\u007f]/.test(file.name)||file.name==='.'||file.name==='..')throw new AssignmentError('Use a simple filename without folders or control characters.');
  const normalized=file.name.normalize('NFC').toLowerCase();if(names.has(normalized))throw new AssignmentError('Each file must have a different name.');names.add(normalized);
  total+=file.bytes.length;if(!file.bytes.length)throw new AssignmentError('Empty files cannot be submitted.');
  if(file.bytes.length>MAX_UPLOAD_BYTES||(detail.maxFileBytes>0&&file.bytes.length>detail.maxFileBytes))throw new AssignmentError('A selected file exceeds Moodle’s file limit or the bot’s 20 MiB limit.');
  const extensions:Record<string,string[]>={'application/pdf':['.pdf'],'text/plain':['.txt'],'application/msword':['.doc'],'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['.docx'],'application/vnd.ms-powerpoint':['.ppt'],'application/vnd.openxmlformats-officedocument.presentationml.presentation':['.pptx'],'application/zip':['.zip'],'image/jpeg':['.jpg','.jpeg'],'image/png':['.png']};
  if(detail.acceptedTypes.length&&!detail.acceptedTypes.some(type=>type.startsWith('.')?normalized.endsWith(type):extensions[type]?.some(ext=>normalized.endsWith(ext))))throw new AssignmentError('A selected file type does not match the teacher’s accepted formats. Submit directly in Moodle for additional formats.');
 }
 if(total>MAX_UPLOAD_BYTES)throw new AssignmentError('The selected files exceed the bot’s 20 MiB total upload limit.');
 const text=request.onlineText||'';
 if(!detail.textEnabled&&text)throw new AssignmentError('The teacher has not enabled online-text submissions.');
 if(detail.textEnabled&&!normalizeText(text)&&!files.length)throw new AssignmentError('Enter your online-text submission.');
 if(detail.wordLimit!==null&&text.trim().split(/\s+/u).filter(Boolean).length>detail.wordLimit)throw new AssignmentError('Your online text exceeds the teacher’s word limit.');
}
export class AssignmentService {
 private running=new Map<string,Promise<void>>();private downloading=new Set<number>();
 private downloads=new ConcurrencyGate(2,8);
 private verifying=new Map<string,Promise<SubmissionOperation>>();private releasing=new Set<string>();
 private store:Store;private vault:Vault;private gateway:AssignmentGateway;private messenger:Messenger;private now:()=>number;
 constructor(store:Store,vault:Vault,gateway:AssignmentGateway,messenger:Messenger,now=()=>Math.floor(Date.now()/1000)){
  this.store=store;this.vault=vault;this.gateway=gateway;this.messenger=messenger;this.now=now;
  // Writes have no Moodle idempotency key. After a restart, never replay them.
  store.db.prepare("UPDATE submission_operations SET state='uncertain',message='The bot restarted before verification. Check the current Moodle status before uploading again.',updatedAt=? WHERE state='working'").run(this.now());
 }
 session(raw:string):PortalSession{const value=assignmentSession(this.store,raw,this.now());if(!value)throw new AssignmentError('This private assignment window expired. Open a fresh assignment button in Telegram.',401);return value;}
 private current(session:PortalSession){const student=this.store.getStudent(session.student.id);if(!student?.moodleCipher||hashSecret(student.moodleCipher)!==session.connectionHash)throw new AssignmentError('This Moodle connection changed. Open a fresh assignment window.',401);return student;}
 private async detailWithToken(session:PortalSession):Promise<{detail:AssignmentDetail;token:string}>{
  const student=this.current(session),item=this.store.rawItems(student.id).find(item=>item.key===session.key&&item.kind==='assignment');
  if(!item||!/^assignment:[1-9]\d*$/.test(item.key))throw new AssignmentError('Assignment not found in your account.',404);
  const token=this.vault.open(student.moodleCipher!,`moodle:${student.id}`),detail=await this.gateway.assignment(token,Number(item.key.split(':')[1]),item.courseId,this.now());
  this.current(session);if(detail.id!==Number(item.key.split(':')[1])||detail.courseId!==item.courseId)throw new AssignmentError('Moodle returned an unexpected assignment.',409);return {detail,token};
 }
 async detail(session:PortalSession){return (await this.detailWithToken(session)).detail;}
 async file(session:PortalSession,id:string,toTelegram:boolean):Promise<{file:AssignmentFile;bytes:Buffer}>{
  return this.downloads.run(()=>this.downloadFile(session,id,toTelegram));
 }
 private async downloadFile(session:PortalSession,id:string,toTelegram:boolean):Promise<{file:AssignmentFile;bytes:Buffer}>{
  if(this.downloading.has(session.student.id))throw new AssignmentError('Your previous file is still being downloaded.',429);
  this.downloading.add(session.student.id);
  try{const {detail,token}=await this.detailWithToken(session),file=[...detail.attachments,...detail.submittedFiles].find(f=>fileId(f)===id);if(!file)throw new AssignmentError('This file changed or is no longer available. Refresh the assignment.',404);
   const bytes=await this.gateway.download(token,file,MAX_UPLOAD_BYTES);this.current(session);
   if(toTelegram){if(!this.messenger.sendDocument)throw new AssignmentError('Telegram file delivery is not configured.',503);await this.messenger.sendDocument(session.student.chatId,file.name,bytes,`📄 ${detail.title}\n${detail.courseName}\nDownloaded from your Moodle account.`);}
   this.store.metric(toTelegram?'telegram_file_sent':'file_download',this.now());return {file,bytes};
  }finally{this.downloading.delete(session.student.id);}
 }
 operation(session:PortalSession,id:string):SubmissionOperation|null{
  this.current(session);if(!/^[-\w]{43}$/.test(id))return null;
  return this.store.db.prepare('SELECT * FROM submission_operations WHERE id=? AND studentId=? AND assignmentKey=? AND connectionHash=?').get(id,session.student.id,session.key,session.connectionHash) as unknown as SubmissionOperation||null;
 }
 private update(id:string,state:SubmissionOperation['state'],stage:string,message:string){this.store.db.prepare('UPDATE submission_operations SET state=?,stage=?,message=?,updatedAt=? WHERE id=?').run(state,stage,message,this.now(),id);}
 start(session:PortalSession,request:SubmissionRequest,files:SubmissionFile[]):SubmissionOperation{
  this.current(session);const duplicate=this.operation(session,request.operationId);if(duplicate)return duplicate;
  if(this.store.db.prepare('SELECT 1 FROM submission_operations WHERE id=?').get(request.operationId))throw new AssignmentError('Choose a fresh submission operation.',409);
  if(this.store.db.prepare("SELECT 1 FROM submission_operations WHERE studentId=? AND assignmentKey=? AND state IN ('working','uncertain')").get(session.student.id,session.key))throw new AssignmentError('A previous submission needs verification. Check its status or open Moodle before uploading again.',409);
  if(this.running.size>=2)throw new AssignmentError('The bot is processing uploads. Please try again shortly.',429);
  if(Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM submission_operations WHERE studentId=? AND createdAt>?').get(session.student.id,this.now()-3600)?.count)>=10)throw new AssignmentError('Submission attempt limit reached. Please use Moodle directly or try later.',429);
  const proof:Proof={files:files.map(f=>({name:f.name,size:f.bytes.length,sha256:createHash('sha256').update(f.bytes).digest('hex')})),textHash:request.onlineText===undefined?null:hashSecret(normalizeText(request.onlineText))};
  this.store.db.prepare("INSERT INTO submission_operations(id,studentId,assignmentKey,connectionHash,state,stage,message,proof,createdAt,updatedAt) VALUES(?,?,?,?,'working','validating','Checking current Moodle requirements…',?,?,?)").run(request.operationId,session.student.id,session.key,session.connectionHash,JSON.stringify(proof),this.now(),this.now());
  this.store.metric('submission_requested',this.now());
  const work=this.run(session,request,files).finally(()=>{this.running.delete(request.operationId);for(const file of files)file.bytes.fill(0);});this.running.set(request.operationId,work);
  return this.operation(session,request.operationId)!;
 }
 private matches(detail:AssignmentDetail,proof:Proof){return detail.submittedFiles.length===proof.files.length&&proof.files.every(f=>detail.submittedFiles.some(actual=>actual.name===f.name&&actual.size===f.size))&&(proof.textHash===null||hashSecret(normalizeText(detail.onlineText))===proof.textHash);}
 private async verifyContents(session:PortalSession,detail:AssignmentDetail,proof:Proof):Promise<boolean>{
  if(!this.matches(detail,proof))return false;
  const student=this.current(session),token=this.vault.open(student.moodleCipher!,`moodle:${student.id}`);
  // File delivery already holds this gate for its entire transfer. Submission
  // verification enters it here so concurrent receipts share the same budget.
  for(const file of proof.files){const actual=detail.submittedFiles.find(f=>f.name===file.name)!;const bytes=await this.downloads.run(()=>{this.current(session);return this.gateway.download(token,actual,MAX_UPLOAD_BYTES);});try{if(!file.sha256||createHash('sha256').update(bytes).digest('hex')!==file.sha256)return false;}finally{bytes.fill(0);}}
  this.current(session);return true;
 }
 private async finish(session:PortalSession,id:string,detail:AssignmentDetail,proof:Proof):Promise<boolean>{
  this.current(session);if(!this.matches(detail,proof))return false;
  if(detail.status!=='submitted'&&detail.status!=='draft')return false;
  if(!await this.verifyContents(session,detail,proof))return false;
  const prior=this.operation(session,id);if(!prior)return false;
  const submitted=detail.status==='submitted';const state=submitted?'submitted':'draft';
  const message=submitted?'Moodle confirms: submitted for grading. Please also open Moodle yourself, check the correct files and “Submitted for grading” status, and keep a backup copy.':'Your files are saved as a Moodle draft. They are NOT confirmed as submitted for grading. Open Moodle to complete the final submission.';
  this.store.transaction(()=>{
   this.update(id,state,'verified',message);
   if(prior.state!==state)this.store.metric(submitted?'submission_success':'submission_draft',this.now());
   const item=this.store.rawItems(session.student.id).find(i=>i.key===session.key);
   if(item){const next={...item,completed:submitted,submissionStatus:submitted?(detail.graded?'submitted_graded' as const:'submitted_ungraded' as const):'outstanding' as const,grade:detail.grade,canEdit:detail.canEdit,canSubmit:detail.canSubmit};
    this.store.db.prepare('UPDATE items SET data=? WHERE studentId=? AND key=?').run(JSON.stringify(next),session.student.id,session.key);
    for(const change of findChanges([item],[next],session.student.timezone))this.store.db.prepare('INSERT INTO change_log(studentId,checkedAt,data) VALUES(?,?,?)').run(session.student.id,this.now(),JSON.stringify(change));
   }
   const lang=language(session.student.language);this.store.enqueue(session.student.id,`submission:${id}:${state}`,`${tr(lang,submitted?'✅ Submitted for grading':'⚠️ Draft saved')}\n\n${detail.title}\n${detail.courseName}\n${formatTime(this.now(),session.student.timezone)}\n${proof.files.map(f=>`📎 ${f.name} (${f.size} bytes)`).join('\n')}\n\n${tr(lang,message)}\n${detail.url}`,true);
  });return true;
 }
 private async run(session:PortalSession,request:SubmissionRequest,files:SubmissionFile[]):Promise<void>{
  let mutationStarted=false;
  try{
   let {detail,token}=await this.detailWithToken(session);validateSubmission(detail,request,files);
   this.update(request.operationId,'working','uploading','Uploading your selected files to Moodle’s draft area…');
   const draftId=files.length?await this.gateway.uploadDraft(token,files):null;
   this.current(session);
   // Uploads are drafts only. Recheck before changing the assignment record.
   ({detail,token}=await this.detailWithToken(session));validateSubmission(detail,request,files);
   this.update(request.operationId,'working','saving','Saving the reviewed submission in Moodle…');mutationStarted=true;
   await this.gateway.saveSubmission(token,detail.id,draftId,detail.textEnabled?request.onlineText||'':undefined);
   ({detail}=await this.detailWithToken(session));
   const proof=JSON.parse(this.operation(session,request.operationId)!.proof) as Proof;
   if(!await this.verifyContents(session,detail,proof))throw new AssignmentError('Moodle’s saved files differ from the reviewed files. Check Moodle before trying again.');
   if(detail.status!=='submitted'&&detail.requiresFinalSubmit&&detail.canSubmit){
    this.current(session);this.update(request.operationId,'working','finalizing','Requesting Moodle’s final submission for grading…');
    await this.gateway.submitForGrading(token,detail.id,request.statementAccepted);
   }
   this.update(request.operationId,'working','verifying','Reading back the official submission status and uploaded files…');
   ({detail}=await this.detailWithToken(session));
   if(!await this.finish(session,request.operationId,detail,proof))throw new AssignmentError('Moodle has not confirmed the submitted files. Check Moodle before trying again.');
  }catch(error){
   if(!this.store.getStudent(session.student.id)||!this.operationSafe(session,request.operationId))return;
   if(mutationStarted){
    try{const detail=await this.detail(session),proof=JSON.parse(this.operation(session,request.operationId)!.proof) as Proof;if(await this.finish(session,request.operationId,detail,proof))return;}catch{/* A lost response never justifies replaying a write. */}
    this.update(request.operationId,'uncertain','verification_needed','The submission outcome is not confirmed. Moodle may have received it. Check status below or open Moodle before uploading again.');this.store.metric('submission_uncertain',this.now());
    this.store.enqueue(session.student.id,`submission:${request.operationId}:uncertain`,tr(language(session.student.language),'⚠️ Submission needs verification\n\nMoodle may have received your work, but the bot could not confirm it. Open Moodle and check the files and submission status before uploading again.'),true);
   }else{
    const message=error instanceof AssignmentError||error instanceof MoodleError?error.message:'The upload could not be completed. No final submission was requested. Try directly in Moodle.';
    this.update(request.operationId,'failed','stopped',message);this.store.metric('submission_failure',this.now());
   }
  }
 }
 private operationSafe(session:PortalSession,id:string){try{return this.operation(session,id);}catch{return null;}}
 async verify(session:PortalSession,id:string):Promise<SubmissionOperation>{
  const operation=this.operation(session,id);if(!operation)throw new AssignmentError('Submission receipt not found.',404);if(operation.state==='working'||operation.state==='failed')return operation;
  if(this.releasing.has(id))throw new AssignmentError('This receipt is being checked before closing. Wait for its result.',409);
  const existing=this.verifying.get(id);if(existing)return existing;
  const work=(async()=>{
   const detail=await this.detail(session),proof=JSON.parse(operation.proof) as Proof;
   const matched=await this.finish(session,id,detail,proof);
   if(!matched&&(operation.state==='submitted'||operation.state==='draft'))throw new AssignmentError('The current Moodle status or files do not match this receipt. Refresh the assignment and check Moodle directly.',409);
   return this.operation(session,id)!;
  })();
  this.verifying.set(id,work);
  try{return await work;}finally{if(this.verifying.get(id)===work)this.verifying.delete(id);}
 }
 latest(session:PortalSession){this.current(session);return this.store.db.prepare('SELECT * FROM submission_operations WHERE studentId=? AND assignmentKey=? AND connectionHash=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(session.student.id,session.key,session.connectionHash) as unknown as SubmissionOperation||null;}
 async release(session:PortalSession,id:string,confirmedNotSubmitted:boolean){
  const operation=this.operation(session,id);if(!operation)throw new AssignmentError('Submission receipt not found.',404);
  if(!confirmedNotSubmitted||operation.state!=='uncertain'||this.running.has(id))throw new AssignmentError('Check the uncertain submission in Moodle before closing this attempt.');
  if(this.verifying.has(id)||this.releasing.has(id))throw new AssignmentError('This receipt is already being checked. Wait for its result before closing it.',409);
  this.releasing.add(id);
  try{
   const detail=await this.detail(session);if(!['new','draft','reopened'].includes(detail.status)||!detail.canEdit)throw new AssignmentError('Moodle already reports submitted work or does not allow editing. Check it directly before making another submission.');
   this.update(id,'failed','closed_by_student','You closed this uncertain attempt after checking Moodle. Nothing was resubmitted. Review the current task and selected files before starting a new upload.');this.store.metric('submission_attempt_closed',this.now());return this.operation(session,id)!;
  }finally{this.releasing.delete(id);}
 }
 async drain(){await Promise.allSettled([...this.running.values(),...this.verifying.values()]);}
}
