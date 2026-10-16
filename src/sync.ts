import { randomInt } from 'node:crypto';
import { Store } from './store.ts';
import { Vault, hashSecret, newSecret } from './security.ts';
import { formatTime, priorityItems, isActionable } from './planning.ts';
import type { Item, Messenger, MoodleGateway, ConnectionProgress } from './types.ts';
import { findChanges, findCourseChanges, fingerprint, formatChanges, checkedCoverage } from './changes.ts';
import type { RefreshResult } from './changes.ts';
import { syncFailure } from './sync-errors.ts';
import { MoodleError } from './moodle.ts';
import { assignmentLink } from './assignment-session.ts';
export { fingerprint } from './changes.ts';

export class SyncService {
  private locks = new Map<number, Promise<void>>();
  private eventWork:Promise<void>|null=null;
  private deliveryWork:Promise<void>|null=null;
  private manualWork:Promise<void>|null=null;
  private store: Store;
  private vault: Vault;
  private moodle: MoodleGateway;
  private messenger: Messenger;
  private publicUrl: string;
  private pollSeconds: number;
  private now: () => number;
  constructor(store: Store, vault: Vault, moodle: MoodleGateway,
    messenger: Messenger, publicUrl: string, pollSeconds: number,
    now: () => number = () => Math.floor(Date.now()/1000)) {
    this.store=store; this.vault=vault; this.moodle=moodle; this.messenger=messenger;
    this.publicUrl=publicUrl; this.pollSeconds=pollSeconds; this.now=now;
  }
  private async locked<T>(id: number, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) || Promise.resolve();
    let release!: () => void; const next = new Promise<void>(r => { release=r; });
    this.locks.set(id, next); await previous;
    try { return await work(); }
    finally { release(); if (this.locks.get(id)===next) this.locks.delete(id); }
  }
  connectLink(id: number): string {
    const raw = newSecret();
    this.store.patchStudent(id, {linkHash:hashSecret(raw),linkExpires:this.now()+900});
    return `${this.publicUrl}/connect#token=${raw}`;
  }
  assignmentLink(id:number,key:string):string{return assignmentLink(this.store,this.publicUrl,id,key,this.now());}
  beginPairing(moodleToken: string): string {
    const raw=newSecret();
    this.store.setMeta('ownerPairing',JSON.stringify({hash:hashSecret(raw),expires:this.now()+900,cipher:this.vault.seal(moodleToken,'owner-pairing')}));
    return raw;
  }
  updatesStatus():string {
    const received=this.store.getMeta('moodleEventReceivedAt');
    return received ? 'Moodle interval checks: off. Last signed website event: '+new Date(Number(received)*1000).toISOString()+'.'
      : 'Moodle interval checks: off. Automatic website updates await a university-enabled Moodle event connection.';
  }
  async claimPairing(id: number, raw: string): Promise<boolean> {
    return this.locked(0,async()=>{
      const value=this.store.getMeta('ownerPairing');if(!value)return false;
      const pairing=JSON.parse(value) as {hash:string;expires:number;cipher:string};
      if(pairing.expires<=this.now()){this.store.setMeta('ownerPairing','');return false;}
      if(pairing.hash!==hashSecret(raw) || !this.store.getStudent(id))return false;
      const link=new URL(this.connectLink(id));
      await this.connect(new URLSearchParams(link.hash.slice(1)).get('token')!,this.vault.open(pairing.cipher,'owner-pairing'));
      this.store.setMeta('ownerPairing','');
      return true;
    });
  }
  calendarLink(id: number, rotate=false): string {
    const s = this.store.getStudent(id);
    if (!s?.moodleCipher) throw new Error('Connect Moodle first.');
    let raw = s.calendarCipher ? this.vault.open(s.calendarCipher,`calendar:${id}`) : null;
    if (!raw || rotate) {
      raw = newSecret(); this.store.patchStudent(id, {calendarHash:hashSecret(raw),calendarCipher:this.vault.seal(raw,`calendar:${id}`)});
    }
    return `${this.publicUrl}/calendar/${raw}.ics`;
  }
  async connect(linkToken: string, moodleToken: string,progress?:ConnectionProgress): Promise<void> {
    const hash = hashSecret(linkToken); const original = this.store.byLink(hash,this.now());
    if (!original) throw new Error('Connection link expired. Send /connect in Telegram.');
    await this.locked(original.id, async () => {
      if (!this.store.byLink(hash,this.now())) throw new Error('Connection link expired. Send /connect in Telegram.');
      const snapshot = await this.moodle.snapshot(moodleToken,this.now(),false,progress);
      if (!this.store.byLink(hash,this.now())) throw new Error('Connection link expired. Send /connect in Telegram.');
      progress?.('saving');
      this.store.transaction(() => {
        // Reconnecting can use a different Moodle identity: remove all previous account data.
        for (const table of ['courses','items','done','classes','outbox','change_log','manual_sync_jobs','portal_sessions','submission_operations']) this.store.db.prepare(`DELETE FROM ${table} WHERE studentId=?`).run(original.id);
        this.store.patchStudent(original.id,{moodleCipher:this.vault.seal(moodleToken,`moodle:${original.id}`),linkHash:null,linkExpires:null,calendarHash:null,calendarCipher:null,paused:false,initialized:false});
        this.store.saveSnapshot(original.id,snapshot,[],this.now(),this.now()+this.pollSeconds);
        this.store.metric('connection_success',this.now());
        this.store.enqueue(original.id,`connected:${hash}`,'✅ Moodle connected\n\nYour courses and tasks are ready. Open the main menu to view them. Tap 🔄 Sync whenever you want to check for changes.');
      });
    });
  }
  async sync(id: number, manual=true): Promise<void> {
    await this.synchronize(id,manual,true);
  }
  async refresh(id:number):Promise<string> {
    const result=await this.synchronize(id,true,false);
    if(!result)throw new Error('Connect Moodle before refreshing.');
    return formatChanges(result,this.store.getStudent(id)?.timezone || 'Asia/Tashkent');
  }
  requestRefresh(id:number):string {
    if(!this.store.getStudent(id)?.moodleCipher)return 'Connect Moodle first.';
    const inserted=this.store.db.prepare('INSERT OR IGNORE INTO manual_sync_jobs(studentId,requestId,requestedAt) VALUES(?,?,?)').run(id,newSecret(),this.now());
    return inserted.changes ? '🔄 Sync requested\n\nI’ll check Moodle and send the result here. You can keep using the menu.' : '🔄 Sync is already queued or running. I’ll send the result here.';
  }
  processManualJobs():Promise<void> {
    if(this.manualWork)return this.manualWork;
    const work=(async()=>{
      const jobs=this.store.db.prepare('SELECT studentId,requestId FROM manual_sync_jobs ORDER BY requestedAt LIMIT 100').all();
      for(const job of jobs){
        const id=Number(job.studentId);
        let text:string;
        try{const result=await this.synchronize(id,true,false);if(!result){this.store.db.prepare('DELETE FROM manual_sync_jobs WHERE studentId=? AND requestId=?').run(id,job.requestId);continue;}text=formatChanges(result,this.store.getStudent(id)?.timezone || 'Asia/Tashkent');}
        catch(error){text='⚠️ Sync unavailable\n\n'+syncFailure(error);}
        this.store.transaction(()=>{
          if(!this.store.db.prepare('SELECT 1 FROM manual_sync_jobs WHERE studentId=? AND requestId=?').get(id,job.requestId))return;
          if(this.store.getStudent(id))this.store.enqueue(id,`manual-sync:${job.requestId}`,text,true);
          this.store.db.prepare('DELETE FROM manual_sync_jobs WHERE studentId=? AND requestId=?').run(id,job.requestId);
        });
      }
    })();
    this.manualWork=work.finally(()=>{this.manualWork=null;});return this.manualWork;
  }
  recentUpdates(id:number):string {
    const student=this.store.getStudent(id);if(!student)return 'Connect Moodle first.';
    const rows=this.store.recentChanges(id);
    if(!rows.length)return '📰 Recent updates\n\nNo recorded website changes yet. Tap 🔄 Sync to compare Moodle with your saved snapshot.';
    return '📰 Recent updates\n\n'+rows.map(({checkedAt,change})=>`${formatTime(checkedAt,student.timezone)} · ${change.courseName}\n${change.title}\n${change.details.map(detail=>'• '+detail).join('\n')}${change.url?'\n'+change.url:''}`).join('\n\n');
  }
  private async synchronize(id:number,manual:boolean,notify:boolean):Promise<RefreshResult|null> {
    return this.locked(id, async () => {
      const s = this.store.getStudent(id); if (!s?.moodleCipher || (s.paused && !manual)) return null;
      try {
        this.store.setMeta(`lastSyncAttempt:${id}`,String(this.now()));
        const token = this.vault.open(s.moodleCipher,`moodle:${id}`);
        const snapshot = await this.moodle.snapshot(token,this.now());
        const latest = this.store.getStudent(id);
        if (!latest || latest.moodleCipher!==s.moodleCipher || (latest.paused && !manual)) return null;
        const previousItems=this.store.rawItems(id);
        const previous = new Map(previousItems.map(i => [i.key,i]));
        const muted = new Set(this.store.courses(id).filter(c => c.muted).map(c => c.id));
        if(s.initialized && previousItems.some(item=>item.key.startsWith('assignment:')) && snapshot.warnings.some(w=>w.startsWith('Assignment details and deadlines are unavailable'))){const error=new MoodleError('Assignment API access was lost. The last complete snapshot is preserved.',false,'permission');error.operation='mod_assign_get_assignments';throw error;}
        const allChanges=s.initialized ? [...findCourseChanges(this.store.courses(id),snapshot.courses),...findChanges(previousItems,snapshot.items,s.timezone)] : [];
        const changes=manual?allChanges:allChanges.filter(change=>!muted.has(change.courseId??0));
        const notices: {key:string; text:string}[] = [];
        if(notify && !latest.paused)for(const change of changes){
          if(muted.has(change.courseId??0))continue;
          const item=snapshot.items.find(item=>item.key===change.key) || previous.get(change.key);
          const label=change.type==='removed'?'No longer available':change.type==='new'?'New '+(item?.kind||'course'):'Updated '+(item?.kind||'course');
          notices.push({key:`change:${change.key}:${item?fingerprint(item):hashSecret(JSON.stringify(change))}:${this.now()}:${change.type}`,text:`${label}: ${change.title}\n${change.courseName}\n${change.details.map(detail=>'• '+detail).join('\n')}\n${change.url}\n[${change.key}]`});
        }
        this.store.saveSnapshot(id,snapshot,notices,this.now(),this.now()+this.pollSeconds+randomInt(0,30),changes);
        this.store.metric('sync_success',this.now());if(snapshot.warnings.length)this.store.metric('sync_limited',this.now());
        return {checkedAt:this.now(),changes,baseline:!s.initialized,warnings:snapshot.warnings,checked:checkedCoverage(snapshot)};
      } catch(error) {
        if (this.store.getStudent(id)?.moodleCipher!==s.moodleCipher) return null;
        const failedBefore = this.store.getStudent(id)?.lastError?.startsWith('Sync failed');
        this.store.metric('sync_failure',this.now());
        this.store.patchStudent(id,{lastError:'Sync failed. '+syncFailure(error),nextSyncAt:this.now()+Math.min(3600,this.pollSeconds*(failedBefore?4:1))});
        if (notify && !failedBefore) this.store.enqueue(id,`failure:${s.lastSyncAt || 0}`,'Moodle sync failed. I kept your last successful data. Tap 🔄 Sync to try again, or check ⚙️ Settings → ℹ️ Status. Reconnect if your Moodle access has expired.');
        throw error instanceof Error ? error : new Error('Moodle sync failed. Previous data has been preserved.');
      }
    });
  }
  reminders() {
    const now=this.now();
    for (const s of this.store.db.prepare('SELECT id FROM students WHERE moodleCipher IS NOT NULL AND paused=0').all()) {
      const id=Number(s.id); const student=this.store.getStudent(id)!;
      // Do not remind from stale data: a newly submitted assignment might have been missed.
      if (!student.lastSyncAt || now-student.lastSyncAt>this.pollSeconds*3 || student.lastError?.startsWith('Sync failed')) continue;
      for (const item of priorityItems(this.store.items(id),now)) {
        if(item.dueAt===null) continue;
        const remaining=item.dueAt!-now;
        for (const hours of [24,1]) {
          // Catch up after restarts, sending only the most relevant threshold.
          if (remaining<=hours*3600 && remaining>(hours===24 ? 3600 : 0)) {
            this.store.enqueue(id,`reminder:${item.key}:${item.dueAt}:${hours}`,`Deadline reminder: ${item.title}\n${item.courseName}\nDue ${formatTime(item.dueAt!,student.timezone)}\n${item.url}\n[${item.key}]`);
          }
        }
      }
    }
  }
  deliver(): Promise<void> {
    if(this.deliveryWork)return this.deliveryWork;
    const work=this.deliverPending();
    this.deliveryWork=work.finally(()=>{this.deliveryWork=null;});
    return this.deliveryWork;
  }
  private async deliverPending(): Promise<void> {
    for (const entry of this.store.pending(this.now())) {
      if (!this.store.getStudent(entry.studentId) || (this.store.getStudent(entry.studentId)?.paused && !entry.interactive)) continue;
      try { await this.messenger.send(entry.chatId,entry.text); this.store.delivered(entry.id,this.now()); }
      catch(error) {
        const status=(error as {statusCode?:number})?.statusCode;
        if(status===400 || status===403) {
          this.store.delivered(entry.id,this.now());
          this.store.patchStudent(entry.studentId,{paused:true,lastError:'Telegram refused delivery. Send /resume to enable notifications again.'});
        } else {
          this.store.retry(entry.id,this.now(),entry.attempts);
          const retryAfter=(error as {retryAfter?:number})?.retryAfter;
          if(retryAfter && Number.isFinite(retryAfter)) this.store.db.prepare('UPDATE outbox SET nextAttempt=MAX(nextAttempt,?) WHERE id=?').run(this.now()+retryAfter,entry.id);
        }
      }
    }
  }
  async tick(): Promise<void> {
    // Website reads happen only after received Moodle events or explicit student actions.
    await this.processManualJobs();
    await this.processEvents();
    this.reminders(); await this.deliver();
  }
  async drain():Promise<void>{
    await Promise.allSettled([this.manualWork,this.eventWork].filter((work):work is Promise<void>=>work!==null));
    if(this.deliveryWork)await this.deliveryWork.catch(()=>{});
  }
  processEvents():Promise<void> {
    if(this.eventWork)return this.eventWork;
    const work=(async()=>{
      while(true) {
        const jobs=this.store.pendingMoodleJobs(this.now());if(!jobs.length)break;
        for(const job of jobs) {
          try {await this.sync(job.studentId,false);this.store.finishMoodleJob(job.studentId,job.revision);}
          catch {this.store.retryMoodleJob(job.studentId,job.revision,job.attempts,this.now());}
        }
      }
    })();
    this.eventWork=work.finally(()=>{this.eventWork=null;});
    return this.eventWork;
  }
}
