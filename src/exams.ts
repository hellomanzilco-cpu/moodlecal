import type {Item} from './types.ts';

export type ControlType='midterm'|'final'|'exam';
const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[ʻ‘’`ʼ]/g,"'");
/** Explicit teacher labels only. A date or a generic 'control' is not an exam. */
function labelled(value:string):ControlType|null{
 const s=normalize(value);
 if(/\bfinal\s+(?:exam|control|assessment|test)|\byakuniy\s+nazorat|якуний\s+назорат|итогов\p{L}*\s+контрол\p{L}*|(?:^|[\s_./(-])(?:ян|ик)(?=$|[\s_./)-])/u.test(s))return 'final';
 if(/\bmid[\s-]?term\b|\borali[qk]\s+nazorat|орали[кқ]\s+назорат|промежуточн\p{L}*\s+контрол\p{L}*|(?:^|[\s_./(-])(?:он|пк)(?=$|[\s_./)-])/u.test(s))return 'midterm';
 if(/\bexam(?:ination)?\b|\bimtihon\b|экзамен/u.test(s))return 'exam';
 return null;
}
export function controlType(item:Item):ControlType|null{
 const explicit=labelled(item.title);
 if(explicit)return explicit;
 // 'Joriy nazorat' is a regular assessment even if a reused attachment says ON.
 if(/joriy\s+nazor|жорий\s+наз|(?:^|\s)жн(?:\s|$)/iu.test(item.title))return null;
 return labelled(item.sectionName||'')||labelled((item.files||[]).map(x=>x.name).join(' '));
}
export const isExam=(item:Item)=>['assignment','quiz','event','activity'].includes(item.kind)&&controlType(item)!==null;
export function preparationItems(items:readonly Item[],courseId:number,type?:ControlType):Item[]{
 return items.filter(item=>{
  if(item.courseId!==courseId||['restricted','closed','unknown'].includes(item.availability||'unknown'))return false;
  const stage=controlType(item);
  if(type&&stage&&stage!==type)return false;
  if(isExam(item))return !!item.files?.length;
  if(item.kind!=='resource')return false;
  return !!stage||/prepar|revision|practice\s+questions|tayyor|savol|савол|подготов|вопрос/iu.test(item.title);
 }).sort((a,b)=>Number(isExam(b))-Number(isExam(a))||a.title.localeCompare(b.title));
}
export function controlTime(item:Item):number|null{
 return item.kind==='event'?item.startsAt??item.dueAt:item.kind==='quiz'?item.availableFrom??item.dueAt:item.dueAt;
}
