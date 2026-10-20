import {newSecret,hashSecret} from './security.ts';
import type {Store} from './store.ts';
import {language} from './locale.ts';
export function assignmentLink(store:Store,origin:string,studentId:number,key:string,now=Math.floor(Date.now()/1000)):string {
 const student=store.getStudent(studentId);
 if(!student?.moodleCipher||!/^assignment:[1-9]\d*$/.test(key)||!store.rawItems(studentId).some(item=>item.key===key&&item.kind==='assignment'))throw new Error('Assignment not found in this account.');
 const raw=newSecret();store.db.prepare('DELETE FROM portal_sessions WHERE expires<=?').run(now);
 store.db.prepare('INSERT INTO portal_sessions(hash,studentId,assignmentKey,connectionHash,expires) VALUES(?,?,?,?,?)').run(hashSecret(raw),studentId,key,hashSecret(student.moodleCipher),now+1800);
 const lang=language(student.language);return `${origin}/assignment${lang==='en'?'':'?lang='+lang}#session=${raw}`;
}
export function assignmentSession(store:Store,raw:string,now=Math.floor(Date.now()/1000)){
 if(!/^[\w-]{43}$/.test(raw))return null;
 const row=store.db.prepare('SELECT studentId,assignmentKey,connectionHash FROM portal_sessions WHERE hash=? AND expires>?').get(hashSecret(raw),now);
 if(!row)return null;const student=store.getStudent(Number(row.studentId));
 if(!student?.moodleCipher||hashSecret(student.moodleCipher)!==row.connectionHash)return null;
 return {student,key:String(row.assignmentKey),connectionHash:String(row.connectionHash)};
}
