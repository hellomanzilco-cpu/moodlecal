import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { findChanges } from '../src/changes.ts';
import { currentAssignmentKeys, priorityItems } from '../src/planning.ts';
import { loadConfig } from '../src/config.ts';
import type { Item } from '../src/types.ts';

const NOW=2_000_000_000;
const item=(key:string,patch:Partial<Item>={}):Item=>({key,courseId:1,courseName:'Economics',kind:'assignment',title:key,description:'Brief',url:'https://moodle.uwed.uz/mod/assign/view.php?id=1',modifiedAt:1,dueAt:NOW+1000,startsAt:null,endsAt:null,availability:'open',completed:false,...patch});
test('course deadline focus advances by elapsed deadline, never by early submission',()=>{
  const first=item('first',{completed:true,submissionStatus:'submitted_ungraded'});
  const second=item('second',{dueAt:NOW+2000});
  const anotherCourse=item('other-course',{courseId:2,dueAt:NOW+3000});
  const items=[first,second,anotherCourse,item('undated',{dueAt:null})];
  assert.deepEqual([...currentAssignmentKeys(items,NOW)].sort(),['first','other-course']);
  assert.deepEqual(priorityItems(items,NOW).map(i=>i.key),['other-course']);
  assert.deepEqual(priorityItems(items,NOW+1001).map(i=>i.key),['second','other-course']);
});
test('later tasks stay outside current priorities while overdue work stays visible',()=>{
  const items=[item('old',{dueAt:NOW-100}),item('next'),item('later',{dueAt:NOW+3000}),item('future',{courseId:2,availability:'upcoming',availableFrom:NOW+100,dueAt:NOW+1000})];
  assert.deepEqual(priorityItems(items,NOW).map(i=>i.key),['old','next']);
});
test('deadline, grading and file updates report concrete differences and unaffected items stay absent',()=>{
  const old=item('essay',{submissionStatus:'submitted_ungraded',files:[{name:'brief.pdf',size:10,modifiedAt:1}]});
  const updated={...old,dueAt:NOW+2000,submissionStatus:'submitted_graded' as const,grade:'0 / 100',files:[{name:'brief.pdf',size:10,modifiedAt:2}]};
  const changes=findChanges([old,item('removed'),item('same')],[updated,item('new'),item('same')],'Asia/Tashkent');
  assert.deepEqual(changes.map(c=>[c.key,c.type]),[['essay','updated'],['new','new'],['removed','removed']]);
  assert.match(changes[0].details.join('\n'),/Deadline:.*→/);assert.match(changes[0].details.join('\n'),/Grade: not released → 0 \/ 100/);assert.match(changes[0].details.join('\n'),/documents/);
  assert.equal(findChanges([updated],[{...updated,completed:true}],'Asia/Tashkent').length,0);
});
test('Render configuration uses its public HTTPS origin and public bind while preserving explicit configuration',()=>{
  const key=randomBytes(32).toString('base64');
  const config=loadConfig({ENCRYPTION_KEY:key,RENDER:'true',RENDER_EXTERNAL_URL:'https://moodle-calendar.onrender.com',PORT:'10000'});
  assert.equal(config.publicUrl,'https://moodle-calendar.onrender.com');assert.equal(config.host,'0.0.0.0');assert.equal(config.port,10000);
  assert.equal(loadConfig({ENCRYPTION_KEY:key,RENDER_EXTERNAL_URL:'https://default.onrender.com',PUBLIC_URL:'https://calendar.example.com'}).publicUrl,'https://calendar.example.com');
});
