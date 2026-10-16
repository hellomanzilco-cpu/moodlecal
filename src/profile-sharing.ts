import type {Store} from './store.ts';
import {Vault,hashSecret} from './security.ts';
import type {MoodleProfile,SharedProfilePage} from './types.ts';

export const PROFILE_SHARING_CONSENT='profile-sharing-v1';
export const profileField=(value:string)=>value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,200);

/** Named profiles are separate from anonymous analytics and require the student's explicit opt-in. */
export class ProfileSharingService{
  private store:Store;private vault:Vault;private readProfile:(id:number)=>Promise<MoodleProfile>;
  private ownerId:number|null;private now:()=>number;private generations=new Map<number,number>();
  constructor(store:Store,vault:Vault,readProfile:(id:number)=>Promise<MoodleProfile>,ownerId:number|null,now:()=>number=()=>Math.floor(Date.now()/1000)){
    this.store=store;this.vault=vault;this.readProfile=readProfile;this.ownerId=ownerId;this.now=now;
  }
  private context(id:number,connectionHash:string):string{return `profile-share:${id}:${this.ownerId}:${connectionHash}:${PROFILE_SHARING_CONSENT}`;}
  status(id:number):{enabled:boolean;sharedAt:number|null}{
    const student=this.store.getStudent(id);
    const row=this.store.db.prepare('SELECT ownerTelegramId,connectionHash,sharedAt,consentVersion FROM profile_shares WHERE studentId=?').get(id);
    const enabled=!!(this.ownerId&&student?.moodleCipher&&row?.ownerTelegramId===this.ownerId&&row.connectionHash===hashSecret(student.moodleCipher)&&row.consentVersion===PROFILE_SHARING_CONSENT);
    return {enabled,sharedAt:enabled?Number(row!.sharedAt):null};
  }
  async share(id:number,confirmed:boolean):Promise<void>{
    const student=this.store.getStudent(id);
    if(!confirmed||!this.ownerId||!student?.moodleCipher)throw new Error('Explicit profile sharing consent and a connected account are required.');
    const generation=(this.generations.get(id)||0)+1;this.generations.set(id,generation);
    const profile=await this.readProfile(id);
    if(this.generations.get(id)!==generation||this.store.getStudent(id)?.moodleCipher!==student.moodleCipher)throw new Error('Your connection or sharing preference changed.');
    const fields={firstName:profileField(profile.firstName),lastName:profileField(profile.lastName),username:profileField(profile.username)};
    const connectionHash=hashSecret(student.moodleCipher);
    this.store.db.prepare('INSERT INTO profile_shares(studentId,ownerTelegramId,connectionHash,profileCipher,sharedAt,consentVersion) VALUES(?,?,?,?,?,?) ON CONFLICT(studentId) DO UPDATE SET ownerTelegramId=excluded.ownerTelegramId,connectionHash=excluded.connectionHash,profileCipher=excluded.profileCipher,sharedAt=excluded.sharedAt,consentVersion=excluded.consentVersion')
      .run(id,this.ownerId,connectionHash,this.vault.seal(JSON.stringify(fields),this.context(id,connectionHash)),this.now(),PROFILE_SHARING_CONSENT);
  }
  revoke(id:number):void{
    this.generations.set(id,(this.generations.get(id)||0)+1);
    this.store.db.prepare('DELETE FROM profile_shares WHERE studentId=?').run(id);
  }
  list(requesterTelegramId:number,offset=0):SharedProfilePage{
    if(!this.ownerId||requesterTelegramId!==this.ownerId)throw new Error('Only the configured owner can view shared profiles.');
    if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid profile page.');
    const total=Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM profile_shares p JOIN students s ON s.id=p.studentId WHERE p.ownerTelegramId=? AND p.consentVersion=? AND s.moodleCipher IS NOT NULL').get(this.ownerId,PROFILE_SHARING_CONSENT)?.count||0);
    const registered=Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM students').get()?.count||0);
    offset=Math.min(offset,Math.max(0,Math.floor((total-1)/6)*6));
    const rows=this.store.db.prepare('SELECT p.studentId,p.profileCipher,p.sharedAt,p.connectionHash,s.moodleCipher FROM profile_shares p JOIN students s ON s.id=p.studentId WHERE p.ownerTelegramId=? AND p.consentVersion=? AND s.moodleCipher IS NOT NULL ORDER BY p.sharedAt DESC,p.studentId LIMIT 6 OFFSET ?').all(this.ownerId,PROFILE_SHARING_CONSENT,offset);
    const profiles=rows.filter(row=>row.connectionHash===hashSecret(String(row.moodleCipher))).map(row=>{
      const value=JSON.parse(this.vault.open(String(row.profileCipher),this.context(Number(row.studentId),String(row.connectionHash))));
      if(!value||typeof value.firstName!=='string'||typeof value.lastName!=='string'||typeof value.username!=='string')throw new Error('Shared profile unavailable.');
      return {firstName:profileField(value.firstName),lastName:profileField(value.lastName),username:profileField(value.username),sharedAt:Number(row.sharedAt)};
    });
    return {profiles,total,registered,offset};
  }
}
