import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';
import {formatStatistics} from '../src/statistics.ts';

test('statistics use Tashkent day boundaries, separate current accounts from activity and exclude other periods',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const alice=store.ensureStudent(101,101);store.ensureStudent(202,202);store.patchStudent(alice.id,{moodleCipher:'private-token',paused:true});
  const now=Date.parse('2026-10-16T20:00:00Z')/1000; // 17 October, 01:00 in Tashkent.
  store.metric('student_started',now);store.metric('sync_success',now);store.metric('sync_limited',now);
  store.metric('sync_failure',now-3*3600); // Previous day locally.
  store.metric('file_download',now-6*86400);store.metric('file_download',now-8*86400);
  store.metric('submission_success',now+86400); // Future counters cannot appear.
  const today=formatStatistics(store.statistics(),1,now);
  assert.match(today,/Today · 17 Oct 2026/);assert.match(today,/Registered: 2/);assert.match(today,/Moodle connected: 1/);assert.match(today,/Not connected: 1/);assert.match(today,/Alerts paused: 1/);
  assert.match(today,/Completed: 1 \(limited: 1\)/);assert.match(today,/Failed: 0/);assert.match(today,/Downloads: 0/);assert.match(today,/Verified submitted: 0/);assert.doesNotMatch(today,/private-token/);
  const week=formatStatistics(store.statistics(),7,now);assert.match(week,/Failed: 1/);assert.match(week,/Downloads: 1/);
  store.deleteStudent(alice.id);assert.match(formatStatistics(store.statistics(),7,now),/Registered: 1/);
});
