import { createHash } from 'node:crypto';
import {DateTime} from 'luxon';
import { formatTime } from './planning.ts';
import type { Course, Item, Snapshot } from './types.ts';
import {tr,intlLocale} from './locale.ts';
import type {Language} from './locale.ts';

export interface WebsiteChange {key:string;courseId?:number;type:'new'|'updated'|'removed';title:string;courseName:string;url:string;details:string[]}
export interface RefreshResult {checkedAt:number;changes:WebsiteChange[];baseline:boolean;warnings?:string[];checked?:{courses:number;assignments:number;materials:number}}
export function checkedCoverage(snapshot:Snapshot){return {courses:snapshot.courses.length,assignments:snapshot.items.filter(i=>i.kind==='assignment').length,materials:snapshot.items.filter(i=>i.kind==='resource').length};}
function excerpt(value:string,index=0){const start=Math.max(0,index-55);return (start?'…':'')+value.slice(start,start+180)+(value.length>start+180?'…':'') || '(empty)';}
function textDiff(before:string,after:string){let index=0;while(index<Math.min(before.length,after.length)&&before[index]===after[index])index++;return `Before: ${excerpt(before,index)}\nNow: ${excerpt(after,index)}`;}
export function findCourseChanges(previous:Course[],next:Course[]):WebsiteChange[]{
 const before=new Map(previous.map(c=>[c.id,c])),after=new Set(next.map(c=>c.id));const changes:WebsiteChange[]=[];
 for(const course of next){const old=before.get(course.id);if(!old||old.name!==course.name||old.shortname!==course.shortname)changes.push({key:`course:${course.id}`,courseId:course.id,type:old?'updated':'new',title:course.name,courseName:course.name,url:'',details:old?[`Course name: ${old.name} → ${course.name}`,`Course code: ${old.shortname} → ${course.shortname}`]:['Course is now visible in your enrolments.']});}
 for(const old of previous)if(!after.has(old.id))changes.push({key:`course:${old.id}`,courseId:old.id,type:'removed',title:old.name,courseName:old.name,url:'',details:['Course is no longer returned in your enrolments.']});
 return changes;
}
export function fingerprint(item:Item):string {
  const {completed:_completed,...fields}=item;
  const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable((value as Record<string,unknown>)[key])])):value;
  return createHash('sha256').update(JSON.stringify(stable(fields))).digest('hex');
}
function enrichment(old:Item,item:Item):boolean {
  if(old.availability!==undefined || item.availability===undefined)return false;
  const legacy={...item};
  for(const key of ['availability','availabilityReason','availableFrom','cutoffAt','canSubmit','canEdit'] as const)delete legacy[key];
  return fingerprint(old)===fingerprint(legacy);
}
export function findChanges(previous:Item[],next:Item[],timezone:string):WebsiteChange[] {
  const before=new Map(previous.map(item=>[item.key,item]));const after=new Set(next.map(item=>item.key));const changes:WebsiteChange[]=[];
  const date=(value:number|null)=>value===null?'not published':DateTime.fromSeconds(value,{zone:timezone}).toFormat('dd LLL yyyy, HH:mm:ss');
  const status=(value:Item['submissionStatus'])=>({outstanding:'not submitted',submitted_ungraded:'submitted, awaiting grade',submitted_graded:'submitted and graded',unknown:'unavailable'}[value || 'unknown']);
  for(const item of next) {
    const old=before.get(item.key);
    if(old && (fingerprint(old)===fingerprint(item) || enrichment(old,item)))continue;
    const details:string[]=[];
    if(!old)details.push('New item found in your Moodle account.');
    else {
      if(old.dueAt!==item.dueAt)details.push(`Deadline: ${date(old.dueAt)} → ${date(item.dueAt)}`);
      if((old.availableFrom??null)!==(item.availableFrom??null))details.push(`Opening date: ${date(old.availableFrom ?? null)} → ${date(item.availableFrom??null)}`);
      if((old.cutoffAt??null)!==(item.cutoffAt??null))details.push(`Submission cutoff: ${date(old.cutoffAt??null)} → ${date(item.cutoffAt??null)}`);
      if(old.startsAt!==item.startsAt)details.push(`Starts: ${date(old.startsAt)} → ${date(item.startsAt)}`);
      if(old.endsAt!==item.endsAt)details.push(`Ends: ${date(old.endsAt)} → ${date(item.endsAt)}`);
      if(old.submissionStatus!==item.submissionStatus)details.push(`Submission: ${status(old.submissionStatus)} → ${status(item.submissionStatus)}`);
      if(old.grade!==item.grade)details.push(`Grade: ${old.grade ?? 'not released'} → ${item.grade ?? 'not released'}`);
      if(old.availability!==item.availability)details.push(`Moodle access: ${old.availability ?? 'unconfirmed'} → ${item.availability ?? 'unconfirmed'}`);
      const oldFiles=new Map((old.files||[]).map(file=>[file.name,file])),newFiles=new Map((item.files||[]).map(file=>[file.name,file]));
      for(const [name,file] of newFiles){const previous=oldFiles.get(name);if(!previous)details.push(`Document added: ${name} (${file.size} bytes)`);else if(file.size!==previous.size||file.modifiedAt!==previous.modifiedAt)details.push(`Document revised: ${name} · ${previous.size} → ${file.size} bytes · modified ${date(previous.modifiedAt||null)} → ${date(file.modifiedAt||null)}`);}
      for(const name of oldFiles.keys())if(!newFiles.has(name))details.push(`Document removed: ${name}`);
      if(old.title!==item.title)details.push(`Renamed from “${old.title}”.`);
      if(old.description!==item.description)details.push('Instructions changed.\n'+textDiff(old.description,item.description));
      if(old.canEdit!==item.canEdit && item.canEdit!==undefined)details.push(`Editing allowed: ${old.canEdit===undefined?'unconfirmed':old.canEdit?'yes':'no'} → ${item.canEdit?'yes':'no'}`);
      if(old.canSubmit!==item.canSubmit && item.canSubmit!==undefined)details.push(`Final submission allowed: ${old.canSubmit===undefined?'unconfirmed':old.canSubmit?'yes':'no'} → ${item.canSubmit?'yes':'no'}`);
      if(old.availabilityReason!==item.availabilityReason && old.availability===item.availability)details.push(`Access details: ${old.availabilityReason||'not provided'} → ${item.availabilityReason||'not provided'}`);
      if(old.courseName!==item.courseName)details.push(`Course: ${old.courseName} → ${item.courseName}`);
      if(old.url!==item.url)details.push('The Moodle activity link changed.');
      if(!details.length)details.push(`Moodle modified time: ${date(old.modifiedAt||null)} → ${date(item.modifiedAt||null)}. No visible content difference was provided.`);
    }
    changes.push({key:item.key,courseId:item.courseId,type:old?'updated':'new',title:item.title,courseName:item.courseName,url:item.url,details});
  }
  for(const old of previous)if(!after.has(old.key))changes.push({key:old.key,courseId:old.courseId,type:'removed',title:old.title,courseName:old.courseName,url:old.url,details:['Removed or no longer accessible to your Moodle account.']});
  return changes;
}
export function formatChanges(result:RefreshResult,timezone:string,lang:Language='en'):string {
  const warnings=result.warnings||[];
  const t=(source:string,values:Record<string,string|number>={})=>tr(lang,source,values);
  const heading=t(warnings.length?'⚠️ Sync finished with limits':'✅ Sync complete')+'\n'+DateTime.fromSeconds(result.checkedAt,{zone:timezone,locale:intlLocale[lang]}).toFormat('ccc d LLL, HH:mm')+' · '+timezone+(result.checked?'\n'+t('Checked {courses} courses · {assignments} assignments · {materials} materials',result.checked):'');
  const limits=warnings.length?'\n\n'+t('Could not fully check:')+'\n'+warnings.map(warning=>'• '+warning).join('\n'):'';
  if(result.baseline)return heading+'\n\n'+t('Your first snapshot is saved. Future refreshes will show what changed.')+limits;
  if(!result.changes.length)return heading+'\n\n'+t(warnings.length?'No visible changes in the data Moodle allowed us to check.':'No changes since the last successful website check.')+limits;
  return heading+'\n\n'+t(result.changes.length===1?'{count} change found:':'{count} changes found:',{count:result.changes.length})+'\n\n'+result.changes.map(change=>`${change.type==='new'?'🆕':change.type==='removed'?'➖':'✏️'} ${change.courseName}: ${change.title}\n${change.details.map(detail=>'• '+localizeChangeDetail(detail,lang)).join('\n')}${change.url?'\n'+change.url:''}`).join('\n\n')+limits;
}
export function localizeChangeDetail(detail:string,lang:Language):string{
 const colon=detail.indexOf(':');
 if(colon>0){const prefix=detail.slice(0,colon+1);return tr(lang,prefix)+detail.slice(colon+1);}
 return tr(lang,detail);
}
