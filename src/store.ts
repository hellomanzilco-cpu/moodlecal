import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClassEntry, Course, Item, OutboxEntry, Snapshot, Student } from './types.ts';
import type { MoodleChangeEvent } from './moodle-events.ts';
import type { WebsiteChange } from './changes.ts';
import {hashSecret} from './security.ts';

type Row = Record<string, unknown>;
export interface ConnectionAttemptRow {
  id:number;studentId:number;displayNameCipher:string|null;startedAt:number;finishedAt:number|null;
  stage:string;status:'working'|'failed'|'blocked'|'partial';failureCategory:string|null;operation:string|null;
  apiErrorCode:string|null;message:string|null;
}
const statisticsDay=(seconds:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(seconds*1000));
function student(row: Row | undefined): Student | null {
  if (!row) return null;
  return { ...row, initialized: !!row.initialized, paused: !!row.paused } as unknown as Student;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY, telegramId INTEGER NOT NULL UNIQUE, chatId INTEGER NOT NULL,
        timezone TEXT NOT NULL, moodleCipher TEXT, calendarHash TEXT UNIQUE, calendarCipher TEXT,
        linkHash TEXT UNIQUE, linkExpires INTEGER, lastSyncAt INTEGER, nextSyncAt INTEGER NOT NULL DEFAULT 0,
        lastError TEXT, initialized INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS courses (
        studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        id INTEGER NOT NULL, name TEXT NOT NULL, shortname TEXT NOT NULL, muted INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(studentId,id)
      );
      CREATE TABLE IF NOT EXISTS items (
        studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(studentId,key)
      );
      CREATE TABLE IF NOT EXISTS done (
        studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        key TEXT NOT NULL, PRIMARY KEY(studentId,key)
      );
      CREATE TABLE IF NOT EXISTS classes (
        id INTEGER PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        courseId INTEGER NOT NULL, title TEXT NOT NULL, weekday INTEGER NOT NULL,
        time TEXT NOT NULL, duration INTEGER NOT NULL, location TEXT NOT NULL, until TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY, studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        dedupeKey TEXT NOT NULL, text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        nextAttempt INTEGER NOT NULL DEFAULT 0, sentAt INTEGER, UNIQUE(studentId,dedupeKey)
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, processedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY, chatId INTEGER NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS change_log(id INTEGER PRIMARY KEY,studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,checkedAt INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS moodle_events (eventId TEXT PRIMARY KEY,eventName TEXT NOT NULL,courseId INTEGER NOT NULL,occurredAt INTEGER NOT NULL,receivedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS moodle_jobs (
        studentId INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1,attempts INTEGER NOT NULL DEFAULT 0,nextAttempt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS manual_sync_jobs (
        studentId INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
        requestId TEXT NOT NULL,requestedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portal_sessions(hash TEXT PRIMARY KEY,studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,assignmentKey TEXT NOT NULL,connectionHash TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS submission_operations(id TEXT PRIMARY KEY,studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,assignmentKey TEXT NOT NULL,connectionHash TEXT NOT NULL,state TEXT NOT NULL,stage TEXT NOT NULL,message TEXT NOT NULL,proof TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS submission_owner ON submission_operations(studentId,assignmentKey,createdAt);
      CREATE TABLE IF NOT EXISTS usage_daily(day TEXT NOT NULL,event TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(day,event));
      CREATE TABLE IF NOT EXISTS connection_attempts(
        id INTEGER PRIMARY KEY,studentId INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        displayNameCipher TEXT,startedAt INTEGER NOT NULL,finishedAt INTEGER,stage TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'working',failureCategory TEXT,operation TEXT,apiErrorCode TEXT,message TEXT
      );
      CREATE INDEX IF NOT EXISTS connection_attempts_started ON connection_attempts(startedAt DESC);
      CREATE TABLE IF NOT EXISTS connection_link_names(
        studentId INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
        nameCipher TEXT NOT NULL,expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_shares(studentId INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,ownerTelegramId INTEGER NOT NULL,connectionHash TEXT NOT NULL,profileCipher TEXT NOT NULL,sharedAt INTEGER NOT NULL,consentVersion TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_inbox(id INTEGER PRIMARY KEY,chatId INTEGER NOT NULL,cipher TEXT NOT NULL,createdAt INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,nextAttempt INTEGER NOT NULL DEFAULT 0,lane TEXT NOT NULL DEFAULT 'menu');
      CREATE INDEX IF NOT EXISTS telegram_inbox_chat ON telegram_inbox(chatId,id);
      PRAGMA user_version=1;`);
    // Remove the obsolete daily-sync accounting table from existing databases.
    this.db.exec('DROP TABLE IF EXISTS sync_budgets');
    if(!this.db.prepare('PRAGMA table_info(outbox)').all().some(row=>row.name==='interactive'))this.db.exec('ALTER TABLE outbox ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(telegram_inbox)').all().some(row=>row.name==='lane'))this.db.exec("ALTER TABLE telegram_inbox ADD COLUMN lane TEXT NOT NULL DEFAULT 'menu'");
    if(!this.db.prepare('PRAGMA table_info(students)').all().some(row=>row.name==='language'))this.db.exec("ALTER TABLE students ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK(language IN ('en','uz','ru'))");
    this.pruneConnectionAttempts();
    this.db.prepare('DELETE FROM connection_link_names WHERE expires<=?').run(Math.floor(Date.now()/1000));
  }
  close() { this.db.close(); }
  metric(event:string,now=Math.floor(Date.now()/1000)) {
    if(!/^[a-z_]{1,40}$/.test(event))throw new Error('Invalid aggregate event');
    const day=statisticsDay(now);
    this.db.prepare('INSERT INTO usage_daily(day,event,count) VALUES(?,?,1) ON CONFLICT(day,event) DO UPDATE SET count=count+1').run(day,event);
    this.db.prepare('DELETE FROM usage_daily WHERE day<?').run(statisticsDay(now-90*86400));
  }
  startConnectionAttempt(studentId:number,displayNameCipher:string|null,now=Math.floor(Date.now()/1000)):number {
    this.pruneConnectionAttempts(now);
    const result=this.db.prepare("INSERT INTO connection_attempts(studentId,displayNameCipher,startedAt,stage,status) VALUES(?,?,?,'connection_setup','working')")
      .run(studentId,displayNameCipher,now);
    return Number(result.lastInsertRowid);
  }
  setConnectionLinkName(studentId:number,nameCipher:string,expires:number):void {
    this.db.prepare('INSERT INTO connection_link_names(studentId,nameCipher,expires) VALUES(?,?,?) ON CONFLICT(studentId) DO UPDATE SET nameCipher=excluded.nameCipher,expires=excluded.expires').run(studentId,nameCipher,expires);
  }
  connectionLinkName(studentId:number,now=Math.floor(Date.now()/1000)):string|null {
    this.db.prepare('DELETE FROM connection_link_names WHERE studentId=? AND expires<=?').run(studentId,now);
    const row=this.db.prepare('SELECT nameCipher FROM connection_link_names WHERE studentId=? AND expires>?').get(studentId,now);
    return row?String(row.nameCipher):null;
  }
  clearConnectionLinkName(studentId:number):void {
    this.db.prepare('DELETE FROM connection_link_names WHERE studentId=?').run(studentId);
  }
  pruneConnectionLinkNames(now=Math.floor(Date.now()/1000)):void {
    this.db.prepare('DELETE FROM connection_link_names WHERE expires<=?').run(now);
  }
  setConnectionAttemptStage(id:number,stage:string):void {
    this.db.prepare("UPDATE connection_attempts SET stage=? WHERE id=? AND status='working'").run(stage,id);
  }
  failConnectionAttempt(id:number,record:{stage:string;status?:'failed'|'blocked'|'partial';failureCategory:string;operation?:string|null;apiErrorCode?:string|null;message:string},now=Math.floor(Date.now()/1000)):void {
    const token=(value:string|null|undefined)=>value&&/^[a-zA-Z0-9_-]{1,80}$/.test(value)?value:null;
    const message=record.message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,' ').slice(0,700);
    this.db.prepare("UPDATE connection_attempts SET finishedAt=?,stage=?,status=?,failureCategory=?,operation=?,apiErrorCode=?,message=? WHERE id=? AND status='working'")
      .run(now,record.stage,record.status??'failed',token(record.failureCategory)??'unknown',token(record.operation),token(record.apiErrorCode),message,id);
  }
  completeConnectionAttempt(id:number):void {
    // Successful connects do not retain a named diagnostic record.
    this.db.prepare("DELETE FROM connection_attempts WHERE id=? AND status='working'").run(id);
  }
  connectionAttempts(since:number):ConnectionAttemptRow[] {
    return this.db.prepare('SELECT id,studentId,displayNameCipher,startedAt,finishedAt,stage,status,failureCategory,operation,apiErrorCode,message FROM connection_attempts WHERE startedAt>=? ORDER BY startedAt DESC,id DESC LIMIT 500').all(since) as unknown as ConnectionAttemptRow[];
  }
  connectionAttempt(id:number):ConnectionAttemptRow|null {
    const row=this.db.prepare('SELECT id,studentId,displayNameCipher,startedAt,finishedAt,stage,status,failureCategory,operation,apiErrorCode,message FROM connection_attempts WHERE id=?').get(id);
    return row?(row as unknown as ConnectionAttemptRow):null;
  }
  pruneConnectionAttempts(now=Math.floor(Date.now()/1000)):void {
    this.db.prepare('DELETE FROM connection_attempts WHERE startedAt<?').run(now-90*86400);
  }
  markInterruptedConnectionAttempts(now=Math.floor(Date.now()/1000)):void {
    this.db.prepare("UPDATE connection_attempts SET finishedAt=?,status='failed',failureCategory='interrupted',message='Service restarted before the connection result was recorded.' WHERE status='working'").run(now);
  }
  statistics(){return {students:this.db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN moodleCipher IS NOT NULL THEN 1 ELSE 0 END),0) AS connected,COALESCE(SUM(CASE WHEN paused=1 THEN 1 ELSE 0 END),0) AS paused FROM students').get(),daily:this.db.prepare('SELECT day,event,count FROM usage_daily ORDER BY day DESC,event').all(),dayTimeZone:'Asia/Tashkent',retentionDays:90,containsPersonalIdentifiers:false};}
  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  ensureStudent(telegramId: number, chatId: number, timezone = 'Asia/Tashkent'): Student {
    this.db.prepare('INSERT INTO students(telegramId,chatId,timezone) VALUES(?,?,?) ON CONFLICT(telegramId) DO UPDATE SET chatId=excluded.chatId').run(telegramId, chatId, timezone);
    return this.byTelegram(telegramId)!;
  }
  byTelegram(telegramId: number): Student | null { return student(this.db.prepare('SELECT * FROM students WHERE telegramId=?').get(telegramId)); }
  getStudent(id: number): Student | null { return student(this.db.prepare('SELECT * FROM students WHERE id=?').get(id)); }
  byLink(hash: string, now: number): Student | null { return student(this.db.prepare('SELECT * FROM students WHERE linkHash=? AND linkExpires>?').get(hash, now)); }
  byCalendar(hash: string): Student | null { return student(this.db.prepare('SELECT * FROM students WHERE calendarHash=? AND moodleCipher IS NOT NULL').get(hash)); }
  patchStudent(id: number, patch: Partial<Omit<Student, 'id' | 'telegramId' | 'chatId'>>) {
    const allowed = new Set(['timezone','moodleCipher','calendarHash','calendarCipher','linkHash','linkExpires','lastSyncAt','nextSyncAt','lastError','initialized','paused','language']);
    const entries = Object.entries(patch);
    if (!entries.length) return;
    if (entries.some(([key]) => !allowed.has(key))) throw new Error('Invalid student field');
    this.db.prepare(`UPDATE students SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...entries.map(([, value]) => typeof value === 'boolean' ? Number(value) : value ?? null), id);
  }
  deleteStudent(id: number) {
    this.transaction(() => {
      const s=this.getStudent(id);
      if(s){this.db.prepare('DELETE FROM replies WHERE chatId=?').run(s.chatId);this.db.prepare('DELETE FROM telegram_inbox WHERE chatId=?').run(s.chatId);}
      this.db.prepare('DELETE FROM meta WHERE key=?').run(`lastSyncAttempt:${id}`);
      this.db.prepare('DELETE FROM students WHERE id=?').run(id);
    });
  }
  dueStudents(now: number): Student[] { return this.db.prepare('SELECT * FROM students WHERE moodleCipher IS NOT NULL AND paused=0 AND nextSyncAt<=? ORDER BY nextSyncAt LIMIT 100').all(now).map(row => student(row)!); }
  acceptMoodleEvent(event:MoodleChangeEvent,now:number):{duplicate:boolean;queued:number} {
    return this.transaction(()=>{
      const inserted=this.db.prepare('INSERT OR IGNORE INTO moodle_events(eventId,eventName,courseId,occurredAt,receivedAt) VALUES(?,?,?,?,?)').run(event.eventId,event.eventName,event.courseId,event.occurredAt,now);
      if(!inserted.changes)return {duplicate:true,queued:0};
      // Enrolment/group changes can grant access to a course not yet in a student's cache.
      const affectsMembership=/\\(?:user_enrolment_|role_(?:assigned|unassigned)|group_member_)/.test(event.eventName);
      const students=event.courseId===0 || affectsMembership
        ? this.db.prepare('SELECT id FROM students WHERE moodleCipher IS NOT NULL').all()
        : this.db.prepare('SELECT DISTINCT s.id FROM students s JOIN courses c ON c.studentId=s.id WHERE s.moodleCipher IS NOT NULL AND c.active=1 AND c.id=?').all(event.courseId);
      for(const s of students)this.db.prepare('INSERT INTO moodle_jobs(studentId,nextAttempt) VALUES(?,?) ON CONFLICT(studentId) DO UPDATE SET revision=revision+1,attempts=0,nextAttempt=MIN(nextAttempt,excluded.nextAttempt)').run(Number(s.id),now);
      this.setMeta('moodleEventReceivedAt',String(now));
      this.db.prepare('DELETE FROM moodle_events WHERE receivedAt<?').run(now-30*86400);
      return {duplicate:false,queued:students.length};
    });
  }
  pendingMoodleJobs(now:number):{studentId:number;revision:number;attempts:number}[] {
    return this.db.prepare('SELECT j.studentId,j.revision,j.attempts FROM moodle_jobs j JOIN students s ON s.id=j.studentId WHERE nextAttempt<=? AND s.paused=0 AND s.moodleCipher IS NOT NULL ORDER BY nextAttempt LIMIT 100').all(now) as unknown as {studentId:number;revision:number;attempts:number}[];
  }
  finishMoodleJob(studentId:number,revision:number) {this.db.prepare('DELETE FROM moodle_jobs WHERE studentId=? AND revision=?').run(studentId,revision);}
  retryMoodleJob(studentId:number,revision:number,attempts:number,now:number) {
    this.db.prepare('UPDATE moodle_jobs SET attempts=attempts+1,nextAttempt=? WHERE studentId=? AND revision=?').run(now+Math.min(3600,15*2**Math.min(attempts,8)),studentId,revision);
  }
  courses(id: number): (Course & { muted: boolean })[] {
    return this.db.prepare('SELECT id,name,shortname,muted FROM courses WHERE studentId=? AND active=1 ORDER BY name').all(id).map(row => ({...row, muted: !!row.muted}) as unknown as Course & { muted: boolean });
  }
  muteCourse(id: number, courseId: number, muted: boolean): boolean { return !!this.db.prepare('UPDATE courses SET muted=? WHERE studentId=? AND id=? AND active=1').run(Number(muted), id, courseId).changes; }
  rawItems(id: number): Item[] { return this.db.prepare('SELECT data FROM items WHERE studentId=?').all(id).map(row => JSON.parse(String(row.data)) as Item); }
  items(id: number, includeMuted = false): Item[] {
    const muted = new Set(this.courses(id).filter(c => c.muted).map(c => c.id));
    const done = new Set(this.db.prepare('SELECT key FROM done WHERE studentId=?').all(id).map(row => String(row.key)));
    return this.rawItems(id).filter(item => includeMuted || !muted.has(item.courseId)).map(item => ({...item, completed: item.completed || done.has(item.key)}));
  }
  markDone(id: number, key: string, done: boolean): boolean {
    if (!this.db.prepare('SELECT 1 FROM items WHERE studentId=? AND key=?').get(id, key)) return false;
    if (done) this.db.prepare('INSERT OR IGNORE INTO done(studentId,key) VALUES(?,?)').run(id, key);
    else this.db.prepare('DELETE FROM done WHERE studentId=? AND key=?').run(id, key);
    return true;
  }
  saveSnapshot(id: number, snapshot: Snapshot, notices: {key: string; text: string}[], now: number, next: number, changes:WebsiteChange[]=[]) {
    this.transaction(() => {
      this.db.prepare('UPDATE courses SET active=0 WHERE studentId=?').run(id);
      for (const c of snapshot.courses) this.db.prepare('INSERT INTO courses(studentId,id,name,shortname) VALUES(?,?,?,?) ON CONFLICT(studentId,id) DO UPDATE SET name=excluded.name,shortname=excluded.shortname,active=1').run(id, c.id, c.name, c.shortname);
      this.db.prepare('DELETE FROM items WHERE studentId=?').run(id);
      for (const item of snapshot.items) this.db.prepare('INSERT INTO items(studentId,key,data) VALUES(?,?,?)').run(id, item.key, JSON.stringify(item));
      for (const n of notices) this.enqueue(id, n.key, n.text);
      for(const change of changes)this.db.prepare('INSERT INTO change_log(studentId,checkedAt,data) VALUES(?,?,?)').run(id,now,JSON.stringify(change));
      this.db.prepare('DELETE FROM change_log WHERE studentId=? AND (checkedAt<? OR id NOT IN (SELECT id FROM change_log WHERE studentId=? ORDER BY id DESC LIMIT 200))').run(id,now-30*86400,id);
      this.patchStudent(id, {lastSyncAt: now, nextSyncAt: next, lastError: snapshot.warnings.length ? snapshot.warnings.join('; ').slice(0, 1500) : null, initialized: true});
    });
  }
  classes(id: number): ClassEntry[] { return this.db.prepare('SELECT id,courseId,title,weekday,time,duration,location,until FROM classes WHERE studentId=? ORDER BY weekday,time').all(id) as unknown as ClassEntry[]; }
  recentChanges(id:number):{checkedAt:number;change:WebsiteChange}[] {return this.db.prepare('SELECT checkedAt,data FROM change_log WHERE studentId=? ORDER BY id DESC LIMIT 30').all(id).map(row=>({checkedAt:Number(row.checkedAt),change:JSON.parse(String(row.data)) as WebsiteChange}));}
  addClass(id: number, c: Omit<ClassEntry, 'id'>): number {
    if (!this.courses(id).some(course => course.id === c.courseId)) throw new Error('Course not found');
    return Number(this.db.prepare('INSERT INTO classes(studentId,courseId,title,weekday,time,duration,location,until) VALUES(?,?,?,?,?,?,?,?)').run(id,c.courseId,c.title,c.weekday,c.time,c.duration,c.location,c.until).lastInsertRowid);
  }
  removeClass(id: number, classId: number): boolean { return !!this.db.prepare('DELETE FROM classes WHERE studentId=? AND id=?').run(id, classId).changes; }
  enqueue(id: number, key: string, text: string,interactive=false) { this.db.prepare('INSERT OR IGNORE INTO outbox(studentId,dedupeKey,text,interactive) VALUES(?,?,?,?)').run(id, key, text,Number(interactive)); }
  pending(now: number): OutboxEntry[] { return this.db.prepare('SELECT id,studentId,chatId,text,attempts,interactive FROM (SELECT o.id,o.studentId,s.chatId,o.text,o.attempts,o.interactive,ROW_NUMBER() OVER(PARTITION BY o.studentId ORDER BY o.id) AS position FROM outbox o JOIN students s ON s.id=o.studentId WHERE sentAt IS NULL AND nextAttempt<=? AND (s.paused=0 OR o.interactive=1)) WHERE position<=5 ORDER BY id LIMIT 100').all(now) as unknown as OutboxEntry[]; }
  delivered(id: number, now: number) { this.db.prepare('UPDATE outbox SET sentAt=? WHERE id=?').run(now,id); }
  retry(id: number, now: number, attempts: number) { this.db.prepare('UPDATE outbox SET attempts=attempts+1,nextAttempt=? WHERE id=?').run(now + Math.min(3600, 15 * 2 ** Math.min(attempts, 8)),id); }
  hasUpdate(id: number): boolean { return !!this.db.prepare('SELECT 1 FROM updates WHERE id=?').get(id); }
  cachedReply(id: number): {chatId:number;text:string} | null { return this.db.prepare('SELECT chatId,text FROM replies WHERE id=?').get(id) as unknown as {chatId:number;text:string} ?? null; }
  cacheReply(id: number, chatId: number, text: string, now: number) { this.db.prepare('INSERT OR IGNORE INTO replies(id,chatId,text,createdAt) VALUES(?,?,?,?)').run(id,chatId,text,now); }
  finishUpdate(id: number, now: number) {
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO updates(id,processedAt) VALUES(?,?)').run(id,now);
      this.db.prepare('DELETE FROM replies WHERE id=? OR createdAt<?').run(id,now-86400);
      this.db.prepare('DELETE FROM updates WHERE processedAt<?').run(now-7*86400);
    });
  }
  getMeta(key: string): string | null { return String(this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? '') || null; }
  setMeta(key: string, value: string) { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value); }
}
