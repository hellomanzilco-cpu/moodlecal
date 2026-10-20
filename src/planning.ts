import { DateTime } from 'luxon';
import {tr} from './locale.ts';
import type { ClassEntry, Course, Item, Student } from './types.ts';

export function formatTime(timestamp: number, timezone: string): string {
  return DateTime.fromSeconds(timestamp, { zone: timezone }).toFormat('ccc dd LLL, HH:mm');
}
/** Fail closed for assignments whose effective access has not yet been checked. */
export function isActionable(item: Item, now: number): boolean {
  if (item.availability && item.availability !== 'open') return false;
  if (item.kind === 'assignment' && item.availability !== 'open') return false;
  if (item.availableFrom != null && item.availableFrom > now) return false;
  if (item.cutoffAt != null && item.cutoffAt < now) return false;
  return true;
}
/** Course deadline progression is a planning rule, not a teacher-release claim.
 * Include submitted work when selecting a course's current deadline so an early
 * submission never promotes the next task before the current deadline passes.
 */
export function currentAssignmentKeys(items:Item[],now:number):Set<string> {
  const nearest=new Map<number,number>();
  for(const item of items)if(item.kind==='assignment' && item.dueAt!==null && item.dueAt>=now)nearest.set(item.courseId,Math.min(nearest.get(item.courseId) ?? Infinity,item.dueAt));
  return new Set(items.filter(item=>item.kind==='assignment' && item.dueAt!==null && item.dueAt===nearest.get(item.courseId)).map(item=>item.key));
}
export function isFocusItem(item:Item,items:Item[],now:number):boolean {
  if(!isActionable(item,now))return false;
  return item.kind!=='assignment' || (item.dueAt!==null && (item.dueAt<now || currentAssignmentKeys(items,now).has(item.key)));
}
export function priorityItems(items: Item[], now: number): Item[] {
  const current=currentAssignmentKeys(items,now);
  return items.filter(i => !i.completed && isActionable(i, now) && (i.kind==='assignment' ? i.dueAt!==null && (i.dueAt<now || current.has(i.key)) : i.dueAt!==null || i.kind==='quiz'))
    .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.title.localeCompare(b.title));
}
export function upcomingClasses(student: Student, entries: ClassEntry[], courses: Course[], now: number, days: number): Item[] {
  const result: Item[] = [];
  const start = DateTime.fromSeconds(now, { zone: student.timezone }).startOf('day');
  const courseMap = new Map(courses.map(c => [c.id, c.name]));
  for (let offset = 0; offset < days; offset++) {
    const day = start.plus({ days: offset });
    for (const c of entries) {
      if (day.weekday !== c.weekday || day.toISODate()! > c.until || !courseMap.has(c.courseId)) continue;
      const [hour, minute] = c.time.split(':').map(Number);
      const date = day.set({ hour, minute });
      // Skip a wall-clock time that does not exist during a DST transition.
      if (!date.isValid || date.hour !== hour || date.minute !== minute) continue;
      result.push({ key: `class:${c.id}:${day.toFormat('yyyyLLdd')}`, courseId: c.courseId,
        courseName: courseMap.get(c.courseId)!, kind: 'event', title: c.title,
        description: `Timetable entry${c.location ? ': ' + c.location : ''}`,
        url: '', modifiedAt: 0, dueAt: null, startsAt: Math.floor(date.toSeconds()),
        endsAt: Math.floor(date.plus({ minutes: c.duration }).toSeconds()), completed: false });
    }
  }
  return result.sort((a,b) => a.startsAt! - b.startsAt!);
}
export function prepareText(items: Item[], courseId?: number,lang:import('./locale.ts').Language='en'): string {
  const selected = items.filter(i => courseId === undefined || i.courseId === courseId);
  const materials = selected.filter(i => i.kind === 'resource' && isActionable(i, Math.floor(Date.now()/1000))).sort((a,b) => b.modifiedAt-a.modifiedAt).slice(0,8);
  const work = priorityItems(selected, Math.floor(Date.now()/1000)).slice(0,5);
  const t=(source:string)=>tr(lang,source);
  const lines = [t('Preparation checklist'),t('Based on Moodle titles and descriptions; document contents have not been read.')];
  if (!selected.length) return lines.join('\n') + '\n'+t('No synced items for this course yet.');
  if (materials.length) {
    lines.push('\n'+t('Review these recent materials:'));
    for (const i of materials) lines.push(`• ${i.courseName}: ${i.title}\n${i.description.slice(0,350)}\n${i.url}\n[${i.key}]`);
  }
  if (work.length) {
    lines.push('\n'+t('Check requirements and complete these tasks:'));
    for (const i of work) lines.push(`• ${i.courseName}: ${i.title}\n${i.description.slice(0,350)}\n${i.url}\n[${i.key}]`);
  }
  lines.push('\n'+t('Confirm the next class topic in Moodle and write down questions for the seminar.'));
  return lines.join('\n');
}
