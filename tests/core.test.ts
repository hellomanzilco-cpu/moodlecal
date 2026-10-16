import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Vault } from '../src/security.ts';
import { Store } from '../src/store.ts';
import { foldLine, renderCalendar } from '../src/calendar.ts';
import { formatTime, isActionable, priorityItems, upcomingClasses } from '../src/planning.ts';
import type { ClassEntry, Item } from '../src/types.ts';

const NOW = Date.UTC(2026, 9, 16, 5) / 1000;
function item(key: string, patch: Partial<Item> = {}): Item {
  return { key, courseId: 5, courseName: 'Economics', kind: 'assignment', title: key,
    description: 'Read the assignment instructions.', url: 'https://moodle.uwed.uz/mod/assign/view.php?id=1',
    modifiedAt: NOW - 60, dueAt: NOW + 3600, startsAt: null, endsAt: null, completed: false, availability: 'open', ...patch };
}
function database(t: { after(fn: () => void): void }): Store {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}

test('Vault ciphertext is bound to its student and secret purpose and rejects tampering', () => {
  const vault = new Vault(randomBytes(32).toString('base64'));
  const encrypted = vault.seal('student-moodle-token', 'moodle:1');
  assert.equal(vault.open(encrypted, 'moodle:1'), 'student-moodle-token');
  assert.notEqual(vault.seal('student-moodle-token', 'moodle:1'), encrypted);
  assert.throws(() => vault.open(encrypted, 'moodle:2'));
  assert.throws(() => vault.open(encrypted, 'calendar:1'));
  const tampered = Buffer.from(encrypted, 'base64');
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => vault.open(tampered.toString('base64'), 'moodle:1'));
});

test('saveSnapshot rolls back courses, items, queued notices, and sync metadata on SQL failure', t => {
  const store = database(t);
  const student = store.ensureStudent(101, 101);
  const initial = { courses: [{ id: 5, name: 'Original course', shortname: 'ORIG' }], items: [item('assignment:old')], warnings: [] };
  store.saveSnapshot(student.id, initial, [{ key: 'old-notice', text: 'Existing notice' }], NOW - 300, NOW);
  store.muteCourse(student.id, 5, true);
  const before = store.getStudent(student.id);
  // Fail the final metadata write, after the new courses/items/notices were written.
  store.db.exec("CREATE TRIGGER reject_snapshot BEFORE UPDATE OF initialized ON students BEGIN SELECT RAISE(ABORT, 'forced metadata failure'); END;");
  assert.throws(() => store.saveSnapshot(student.id, {
    courses: [{ id: 5, name: 'Changed course', shortname: 'NEW' }, { id: 6, name: 'New course', shortname: 'EXTRA' }],
    items: [item('assignment:new')], warnings: ['New warning'],
  }, [{ key: 'new-notice', text: 'Must roll back' }], NOW, NOW + 300), /forced metadata failure/);
  assert.deepEqual(store.getStudent(student.id), before);
  assert.deepEqual(store.courses(student.id), [{ ...initial.courses[0], muted: true }]);
  assert.deepEqual(store.rawItems(student.id), initial.items);
  assert.deepEqual(store.pending(NOW).map(entry => entry.text), ['Existing notice']);
  store.db.exec('DROP TRIGGER reject_snapshot');
  store.saveSnapshot(student.id, initial, [], NOW, NOW + 300);
  assert.equal(store.getStudent(student.id)!.lastSyncAt, NOW);
});

test('identical Moodle item keys and notice keys remain isolated between students', t => {
  const store = database(t);
  const alice = store.ensureStudent(101, 101);
  const bob = store.ensureStudent(202, 202);
  const course = { id: 5, name: 'Economics', shortname: 'ECON' };
  for (const student of [alice, bob]) store.saveSnapshot(student.id, {
    courses: [course], items: [item('assignment:shared', { title: student.id === alice.id ? 'Alice requirements' : 'Bob requirements' })], warnings: [],
  }, [{ key: 'same-notice-key', text: `Notice for ${student.telegramId}` }], NOW, NOW + 300);
  assert.equal(store.markDone(alice.id, 'assignment:shared', true), true);
  assert.equal(store.items(alice.id)[0].completed, true);
  assert.equal(store.items(bob.id)[0].completed, false);
  assert.equal(store.items(bob.id)[0].title, 'Bob requirements');
  store.muteCourse(alice.id, 5, true);
  assert.equal(store.items(alice.id).length, 0);
  assert.equal(store.items(bob.id).length, 1);
  assert.deepEqual(store.pending(NOW).map(entry => entry.chatId).sort(), [101, 202]);
  store.deleteStudent(alice.id);
  assert.equal(store.getStudent(alice.id), null);
  assert.equal(store.items(bob.id)[0].title, 'Bob requirements');
  assert.deepEqual(store.pending(NOW).map(entry => entry.chatId), [202]);
});

test('calendar folding obeys UTF-8 byte limits without corrupting multilingual text', () => {
  const original = 'SUMMARY:' + 'Oʻzbekiston 🎓 日本語 '.repeat(20);
  const folded = foldLine(original);
  assert.equal(folded.replace(/\r\n /g, ''), original);
  for (const line of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
    assert.equal(line.isWellFormed(), true);
  }
});

test('calendar text cannot inject events and UIDs are stable but student-specific', () => {
  const malicious = item('assignment:1', {
    title: 'Essay; topic, one\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Injected',
    description: 'Notes\\references\nBEGIN:VEVENT',
    url: 'https://moodle.uwed.uz/\r\nBEGIN:VEVENT',
  });
  const calendar = renderCalendar([malicious, malicious, item('completed', { completed: true }), item('undated', { dueAt: null })], 1, NOW);
  const unfolded = calendar.replace(/\r\n /g, '');
  assert.equal(unfolded.split('\r\n').filter(line => line === 'BEGIN:VEVENT').length, 1);
  assert.equal(unfolded.split('\r\n').filter(line => line === 'END:VEVENT').length, 1);
  assert.match(unfolded, /Essay\\; topic\\, one\\nEND:VEVENT/);
  assert.match(unfolded, /Notes\\\\references\\nBEGIN:VEVENT/);
  assert.equal(unfolded.split('\r\n').some(line => line.startsWith('URL:')), false);
  const uid = (value: string) => value.replace(/\r\n /g, '').split('\r\n').find(line => line.startsWith('UID:'));
  assert.equal(uid(calendar), uid(renderCalendar([malicious], 1, NOW + 60)));
  assert.notEqual(uid(calendar), uid(renderCalendar([malicious], 2, NOW)));
  assert.ok(calendar.endsWith('\r\n'));
});

test('manual classes use the student local date, semester end, and enrolled courses', t => {
  const store = database(t);
  const student = store.ensureStudent(101, 101, 'Asia/Tashkent');
  // UTC Thursday night is already Friday in Tashkent.
  const thursdayNight = Date.UTC(2026, 9, 15, 23, 30) / 1000;
  const entries: ClassEntry[] = [
    { id: 1, courseId: 5, title: 'Friday seminar', weekday: 5, time: '09:00', duration: 80, location: '204', until: '2026-10-16' },
    { id: 2, courseId: 5, title: 'Expired class', weekday: 5, time: '10:00', duration: 80, location: '', until: '2026-10-15' },
    { id: 3, courseId: 9, title: 'Unenrolled course', weekday: 5, time: '11:00', duration: 80, location: '', until: '2026-12-31' },
  ];
  const classes = upcomingClasses(student, entries, [{ id: 5, name: 'Economics', shortname: 'ECON' }], thursdayNight, 1);
  assert.equal(classes.length, 1);
  assert.equal(classes[0].title, 'Friday seminar');
  assert.equal(classes[0].startsAt, Date.UTC(2026, 9, 16, 4) / 1000);
  assert.equal(classes[0].endsAt! - classes[0].startsAt!, 80 * 60);
  assert.equal(classes[0].key, 'class:1:20261016');
  assert.match(formatTime(classes[0].startsAt!, student.timezone), /09:00/);
});

test('manual classes skip nonexistent daylight saving wall-clock times', t => {
  const store = database(t);
  const student = store.ensureStudent(101, 101, 'America/New_York');
  const entries: ClassEntry[] = [
    { id: 1, courseId: 5, title: 'Nonexistent time', weekday: 7, time: '02:30', duration: 60, location: '', until: '2026-03-08' },
    { id: 2, courseId: 5, title: 'Valid time', weekday: 7, time: '03:30', duration: 60, location: '', until: '2026-03-08' },
  ];
  const classes = upcomingClasses(student, entries, [{ id: 5, name: 'Economics', shortname: 'ECON' }], Date.UTC(2026, 2, 8, 5) / 1000, 1);
  assert.deepEqual(classes.map(entry => entry.title), ['Valid time']);
  assert.equal(classes[0].startsAt, Date.UTC(2026, 2, 8, 7, 30) / 1000);
});

test('priorities retain overdue work and omit undated assignments from current deadlines', () => {
  const priorities = priorityItems([
    item('undated-quiz', { kind: 'quiz', title: 'Z quiz', dueAt: null }),
    item('next', { dueAt: NOW + 86400 }),
    item('old-overdue', { dueAt: NOW - 50 * 86400 }),
    item('done', { dueAt: NOW - 3600, completed: true }),
    item('undated-resource', { kind: 'resource', dueAt: null }),
    item('undated-assignment', { title: 'A assignment', dueAt: null }),
  ], NOW);
  assert.deepEqual(priorities.map(entry => entry.key), ['old-overdue', 'next', 'undated-quiz']);
});

test('priorities exclude unavailable or unverified assignments even when their deadline is near', () => {
  const items=[
    item('active-overdue',{dueAt:NOW-100}),
    item('active-undated',{dueAt:null}),
    item('upcoming',{availability:'upcoming',availableFrom:NOW+100}),
    item('restricted',{availability:'restricted'}),
    item('closed',{availability:'closed'}),
    item('unknown',{availability:'unknown'}),
    item('legacy',{availability:undefined}),
    item('cutoff-reached',{availability:'open',cutoffAt:NOW-1}),
    item('opening-not-reached',{availability:'open',availableFrom:NOW+1}),
  ];
  assert.deepEqual(priorityItems(items,NOW).map(i=>i.key),['active-overdue']);
  assert.equal(isActionable(item('no-final-submit',{canSubmit:false,canEdit:true}),NOW),true);
});
