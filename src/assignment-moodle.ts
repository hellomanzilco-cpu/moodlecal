import {createHash} from 'node:crypto';
import {MoodleError,moodleText} from './moodle.ts';
import type {AssignmentDetail,AssignmentFile,Identity,Item,SubmissionFile} from './types.ts';
type R=Record<string,unknown>;
type P=string|number|boolean|P[]|{[key:string]:P};
interface Reader {baseUrl:string;identify(token:string):Promise<Identity>;call(token:string,name:string,params?:Record<string,P>,allowWarning?:(warning:R)=>boolean):Promise<unknown>}
const obj=(value:unknown):R=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new MoodleError('Moodle returned incomplete assignment data.',true);return value as R;};
const arr=(value:unknown):unknown[]=>{if(!Array.isArray(value))throw new MoodleError('Moodle returned incomplete assignment data.',true);return value;};
const yes=(value:unknown)=>value===true||value===1||value==='1';
const num=(value:unknown)=>Number.isFinite(Number(value))&&Number(value)>=0?Number(value):0;
const time=(value:unknown)=>num(value)>0?num(value):null;
export function trustedFile(baseUrl:string,raw:unknown):AssignmentFile|null{
 const file=obj(raw);if(typeof file.fileurl!=='string'||typeof file.filename!=='string')return null;
 try{const base=new URL(baseUrl),url=new URL(file.fileurl);const prefix=base.pathname.replace(/\/$/,'');
  if(url.origin!==base.origin||url.username||url.password||url.protocol!=='https:')return null;
  if(url.pathname.startsWith(prefix+'/pluginfile.php/'))url.pathname=prefix+'/webservice'+url.pathname.slice(prefix.length);
  if(!url.pathname.startsWith(prefix+'/webservice/pluginfile.php/'))return null;
  url.search='';url.hash='';return {name:moodleText(file.filename),size:num(file.filesize),modifiedAt:num(file.timemodified),url:url.href,mime:typeof file.mimetype==='string'?file.mimetype:'application/octet-stream'};
 }catch{return null;}
}
function fileList(base:string,...values:unknown[]):AssignmentFile[]{const files=new Map<string,AssignmentFile>();for(const value of values){if(value===undefined)continue;for(const raw of arr(value)){const file=trustedFile(base,raw);if(file)files.set(file.url,file);}}return [...files.values()].sort((a,b)=>a.name.localeCompare(b.name));}
export async function readAssignment(reader:Reader,token:string,assignmentId:number,courseId:number,now:number,access:(assignment:R,module:R|undefined,last:R|undefined,now:number)=>Pick<Item,'availability'|'availabilityReason'|'availableFrom'|'cutoffAt'|'canEdit'|'canSubmit'>):Promise<AssignmentDetail>{
 const identity=await reader.identify(token),functions=new Set(identity.functions);
 if(!functions.has('mod_assign_get_assignments')||!functions.has('mod_assign_get_submission_status'))throw new MoodleError('Moodle has not enabled assignment details for this connection.',false,'permission');
 const courses=arr(await reader.call(token,'core_enrol_get_users_courses',{userid:identity.userId,returnusercount:false})).map(obj);
 const course=courses.find(c=>num(c.id)===courseId);if(!course)throw new MoodleError('This course is no longer available to your account.',false,'permission');
 const sections=arr(await reader.call(token,'core_course_get_contents',{courseid:courseId})).map(obj);
 const modules=sections.flatMap(section=>arr(section.modules).map(raw=>({...obj(raw),sectionRestricted:section.uservisible!==undefined&&!yes(section.uservisible),sectionAvailability:section.availabilityinfo} as R)));
 const result=obj(await reader.call(token,'mod_assign_get_assignments',{courseids:[courseId]},w=>w.item==='module'&&String(w.warningcode)==='1'&&!modules.some(m=>num(m.id)===num(w.itemid)&&!m.sectionRestricted&&(m.uservisible===undefined||yes(m.uservisible)))));
 const assignments=arr(result.courses).map(obj).filter(c=>num(c.id)===courseId).flatMap(c=>arr(c.assignments).map(obj));
 const assignment=assignments.find(a=>num(a.id)===assignmentId),module=assignment?modules.find(m=>num(m.id)===num(assignment.cmid)&&m.modname==='assign'):undefined;
 if(!assignment||!module||module.sectionRestricted||(module.uservisible!==undefined&&!yes(module.uservisible)))throw new MoodleError('Moodle has not released this assignment to your account.',false,'permission');
 const status=obj(await reader.call(token,'mod_assign_get_submission_status',{assignid:assignmentId,userid:identity.userId}));
 const last=status.lastattempt===undefined?{}:obj(status.lastattempt),submissionSource=yes(assignment.teamsubmission)?last.teamsubmission:last.submission,submission=submissionSource===undefined?{}:obj(submissionSource);
 const plugins=submission.plugins===undefined?[]:arr(submission.plugins).map(obj);
 const submittedFiles=fileList(reader.baseUrl,...plugins.filter(p=>p.type==='file').flatMap(p=>p.fileareas===undefined?[]:arr(p.fileareas).map(area=>obj(area).files)));
 const online=plugins.filter(p=>p.type==='onlinetext').flatMap(p=>p.editorfields===undefined?[]:arr(p.editorfields).map(obj)).find(e=>e.name==='onlinetext');
 const configs=new Map(arr(assignment.configs).map(obj).filter(c=>c.subtype==='assignsubmission').map(c=>[`${c.plugin}:${c.name}`,String(c.value??'')]));
 const fileEnabled=yes(configs.get('file:enabled')),textEnabled=yes(configs.get('onlinetext:enabled'));
 const acceptedRaw=configs.get('file:filetypeslist')||'';let acceptedTypes:string[];
 try{acceptedTypes=acceptedRaw.startsWith('[')?JSON.parse(acceptedRaw):acceptedRaw.split(/[\s,;]+/);if(!Array.isArray(acceptedTypes)||!acceptedTypes.every(t=>typeof t==='string'))throw new Error();}catch{acceptedTypes=['unsupported'];}
 acceptedTypes=[...new Set(acceptedTypes.map(t=>t.trim().toLowerCase()).filter(Boolean))];if(acceptedTypes.includes('*'))acceptedTypes=[];
 const unsupportedPlugin=[...configs.entries()].find(([key,value])=>key.endsWith(':enabled')&&yes(value)&&!['file:enabled','onlinetext:enabled','comments:enabled'].includes(key));
 let unsupportedReason:string|null=null;
 if(yes(assignment.teamsubmission))unsupportedReason='Group submissions must be managed directly in Moodle so every member’s confirmation is respected.';
 else if(num(assignment.timelimit)>0)unsupportedReason='This is a timed assignment. Start and submit it directly in Moodle.';
 else if(unsupportedPlugin)unsupportedReason='This assignment uses a submission plugin that must be completed in Moodle.';
 else if(!fileEnabled&&!textEnabled)unsupportedReason='The teacher has not enabled a supported file or online-text submission for this assignment.';
 else if(!functions.has('mod_assign_save_submission')||(yes(assignment.submissiondrafts)&&!functions.has('mod_assign_submit_for_grading')))unsupportedReason='Moodle has not enabled the required student submission API.';
 else if(acceptedTypes.some(t=>!/^\.[a-z\d][a-z\d.+_-]*$/.test(t)&&!/^[-\w.+]+\/[-\w.+*]+$/.test(t)))unsupportedReason='Moodle uses a file-type group the bot cannot safely validate. Submit directly in Moodle.';
 else if(yes(assignment.requiresubmissionstatement)&&!moodleText(assignment.submissionstatement))unsupportedReason='Moodle did not provide the required submission statement. Submit directly in Moodle.';
 else if(yes(assignment.requiresubmissionstatement)&&!yes(assignment.submissiondrafts))unsupportedReason='Complete the required submission statement directly in Moodle for this submission configuration.';
 const permission=access(assignment,module,last,now),feedback=status.feedback===undefined?{}:obj(status.feedback),grade=feedback.grade===undefined?{}:obj(feedback.grade);
 const sameAttempt=grade.attemptnumber===undefined||submission.attemptnumber===undefined||num(grade.attemptnumber)===num(submission.attemptnumber);
 const graded=sameAttempt&&(yes(last.graded)||last.gradingstatus==='graded');
 const detail:AssignmentDetail={id:assignmentId,courseId,title:moodleText(assignment.name),courseName:moodleText(course.fullname),description:[moodleText(assignment.intro),moodleText(assignment.activity)].filter(Boolean).join('\n\n'),url:`${reader.baseUrl}/mod/assign/view.php?id=${num(assignment.cmid)}`,
  dueAt:Math.max(num(assignment.duedate),num(last.extensionduedate))||null,availableFrom:permission.availableFrom??null,cutoffAt:permission.cutoffAt??null,availability:permission.availability||'unknown',availabilityReason:permission.availabilityReason||'Access unconfirmed.',
  status:['new','draft','submitted','reopened'].includes(String(submission.status))?submission.status as AssignmentDetail['status']:'unknown',graded,grade:graded?(moodleText(feedback.gradefordisplay)||moodleText(String(grade.grade??''))||null):null,submittedAt:time(submission.timemodified),
  canEdit:permission.canEdit===true,canSubmit:permission.canSubmit===true,requiresFinalSubmit:yes(assignment.submissiondrafts),requiresStatement:yes(assignment.requiresubmissionstatement),statement:moodleText(assignment.submissionstatement),
  fileEnabled,textEnabled,maxFiles:num(configs.get('file:maxfilesubmissions')),maxFileBytes:num(configs.get('file:maxsubmissionsizebytes')),acceptedTypes,wordLimit:yes(configs.get('onlinetext:wordlimitenabled'))?num(configs.get('onlinetext:wordlimit')):null,unsupportedReason,
  attachments:fileList(reader.baseUrl,assignment.introfiles,assignment.introattachments,assignment.activityattachments),submittedFiles,onlineText:moodleText(online?.text),attempt:num(submission.attemptnumber),revision:''};
 if(fileEnabled&&detail.maxFiles===0&&!unsupportedReason)detail.unsupportedReason='Moodle did not provide a valid maximum file count. Use Moodle to submit.';
 if(yes(assignment.teamsubmission)&&yes(assignment.requireallteammemberssubmit)){
  if(last.submissiongroupmemberswhoneedtosubmit===undefined)detail.status='unknown';
  else if(arr(last.submissiongroupmemberswhoneedtosubmit).some(user=>Number(user)===identity.userId)&&detail.status==='submitted')detail.status='draft';
 }
 detail.revision=createHash('sha256').update(JSON.stringify({...detail,submissionModifiedAt:num(submission.timemodified)})).digest('hex');return detail;
}
export function submissionParameters(assignmentId:number,draftId:number|null,text:string|undefined):Record<string,P>{
 const plugindata:Record<string,P>={};if(draftId!==null)plugindata.files_filemanager=draftId;
 if(text!==undefined)plugindata.onlinetext_editor={text:text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)).replace(/\n/g,'<br>'),format:1,itemid:0};
 return {assignmentid:assignmentId,plugindata};
}
export function requireNoWriteWarnings(value:unknown):void{if(!Array.isArray(value)||value.length)throw new MoodleError('Moodle did not confirm the submission action. Check its current status before trying again.',false);}
