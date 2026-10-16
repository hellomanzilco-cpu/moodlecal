import {DateTime} from 'luxon';
export const DAILY_SYNCS=5;
export class SyncLimitError extends Error{
  constructor(){super('Your 5 daily full Moodle sync attempts have been used. The limit resets at 00:00 Asia/Tashkent. Saved courses and assignments are still available.');this.name='SyncLimitError';}
}
export function syncDay(now:number):string{return DateTime.fromSeconds(now,{zone:'Asia/Tashkent'}).toISODate()!;}
export function syncResetAt(now:number):number{return Math.floor(DateTime.fromSeconds(now,{zone:'Asia/Tashkent'}).startOf('day').plus({days:1}).toSeconds());}
