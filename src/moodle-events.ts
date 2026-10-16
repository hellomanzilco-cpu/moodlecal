import { createHmac } from 'node:crypto';
import { safeEqual } from './security.ts';

export interface MoodleChangeEvent {eventId:string;eventName:string;courseId:number;occurredAt:number}
export function verifyMoodleSignature(secret:string,timestamp:unknown,signature:unknown,body:Buffer,now:number):boolean {
  if(secret.length<32 || typeof timestamp!=='string' || !/^\d{10}$/.test(timestamp) || typeof signature!=='string' || !/^[a-f0-9]{64}$/i.test(signature))return false;
  if(Math.abs(now-Number(timestamp))>300)return false;
  const expected=createHmac('sha256',secret).update(timestamp+'.').update(body).digest('hex');
  return safeEqual(expected,signature.toLowerCase());
}
export function parseMoodleEvent(body:Buffer,now:number):MoodleChangeEvent|null {
  try {
    const data=JSON.parse(body.toString('utf8')) as Record<string,unknown>;
    if(!data || typeof data!=='object' || Array.isArray(data))return null;
    if(Object.keys(data).length!==4 || !['eventId','eventName','courseId','occurredAt'].every(k=>Object.hasOwn(data,k)))return null;
    if(typeof data.eventId!=='string' || !/^[a-f0-9]{32}$/i.test(data.eventId))return null;
    if(typeof data.eventName!=='string' || !/^\\?[a-zA-Z0-9_]+\\event\\[a-zA-Z0-9_]+$/.test(data.eventName))return null;
    if(typeof data.courseId!=='number' || !Number.isSafeInteger(data.courseId) || data.courseId<0)return null;
    if(typeof data.occurredAt!=='number' || !Number.isSafeInteger(data.occurredAt) || data.occurredAt<=0 || data.occurredAt>now+300)return null;
    return {eventId:data.eventId.toLowerCase(),eventName:data.eventName,courseId:data.courseId,occurredAt:data.occurredAt};
  } catch {return null;}
}
