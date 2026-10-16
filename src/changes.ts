import { createHash } from 'node:crypto';
import { formatTime } from './planning.ts';
import type { Item } from './types.ts';

export interface WebsiteChange {key:string;type:'new'|'updated'|'removed';title:string;courseName:string;url:string;details:string[]}
export interface RefreshResult {checkedAt:number;changes:WebsiteChange[];baseline:boolean}
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
  const date=(value:number|null)=>value===null?'not published':formatTime(value,timezone);
  const status=(value:Item['submissionStatus'])=>({outstanding:'not submitted',submitted_ungraded:'submitted, awaiting grade',submitted_graded:'submitted and graded',unknown:'unavailable'}[value || 'unknown']);
  for(const item of next) {
    const old=before.get(item.key);
    if(old && (fingerprint(old)===fingerprint(item) || enrichment(old,item)))continue;
    const details:string[]=[];
    if(!old)details.push('New item found in your Moodle account.');
    else {
      if(old.dueAt!==item.dueAt)details.push(`Deadline: ${date(old.dueAt)} → ${date(item.dueAt)}`);
      if(old.availableFrom!==item.availableFrom && item.availableFrom)details.push(`Opening date: ${date(old.availableFrom ?? null)} → ${date(item.availableFrom)}`);
      if(old.submissionStatus!==item.submissionStatus)details.push(`Submission: ${status(old.submissionStatus)} → ${status(item.submissionStatus)}`);
      if(old.grade!==item.grade)details.push(`Grade: ${old.grade ?? 'not released'} → ${item.grade ?? 'not released'}`);
      if(old.availability!==item.availability)details.push(`Moodle access: ${old.availability ?? 'unconfirmed'} → ${item.availability ?? 'unconfirmed'}`);
      if(JSON.stringify(old.files || [])!==JSON.stringify(item.files || []))details.push('Attached documents were added, removed, or revised.');
      if(old.title!==item.title)details.push(`Renamed from “${old.title}”.`);
      if(old.description!==item.description)details.push('The instructions or description changed.');
      if(!details.length)details.push('Activity details were updated.');
    }
    changes.push({key:item.key,type:old?'updated':'new',title:item.title,courseName:item.courseName,url:item.url,details});
  }
  for(const old of previous)if(!after.has(old.key))changes.push({key:old.key,type:'removed',title:old.title,courseName:old.courseName,url:old.url,details:['Removed or no longer accessible to your Moodle account.']});
  return changes;
}
export function formatChanges(result:RefreshResult,timezone:string):string {
  const heading=`✅ Sync complete\n${formatTime(result.checkedAt,timezone)} · ${timezone}`;
  if(result.baseline)return heading+'\n\nYour first snapshot is saved. Future refreshes will show what changed.';
  if(!result.changes.length)return heading+'\n\nNo changes since the last successful website check.';
  const visible=result.changes.slice(0,15);
  return heading+`\n\n${result.changes.length} change${result.changes.length===1?'':'s'} found:\n\n`+visible.map(change=>`${change.type==='new'?'🆕':change.type==='removed'?'➖':'✏️'} ${change.courseName}: ${change.title}\n${change.details.map(detail=>'• '+detail).join('\n')}${change.url?'\n'+change.url:''}`).join('\n\n')+(result.changes.length>visible.length?'\n\nOpen 📰 Recent updates for more changes.':'');
}
