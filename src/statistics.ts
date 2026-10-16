import {DateTime} from 'luxon';
import type {Store} from './store.ts';

/** Render anonymous event totals only; current account counts are not a historical roster. */
export function formatStatistics(stats:ReturnType<Store['statistics']>,days:1|7,now:number):string{
  const today=DateTime.fromSeconds(now,{zone:'Asia/Tashkent'}).startOf('day');
  const start=today.minus({days:days-1}).toISODate()!,end=today.toISODate()!;
  const events=new Map<string,number>();
  for(const row of stats.daily){
    if(typeof row.day!=='string'||row.day<start||row.day>end||typeof row.event!=='string')continue;
    events.set(row.event,(events.get(row.event)||0)+Number(row.count));
  }
  const count=(event:string)=>events.get(event)||0;
  const total=Number(stats.students?.total)||0,connected=Number(stats.students?.connected)||0;
  const period=days===1?`Today · ${today.toFormat('d LLL yyyy')}`:`Last 7 days · ${today.minus({days:6}).toFormat('d LLL')}–${today.toFormat('d LLL yyyy')}`;
  return `📊 Bot statistics\n\n👥 Accounts now\nRegistered: ${total}\nMoodle connected: ${connected}\nNot connected: ${total-connected}\nAlerts paused: ${Number(stats.students?.paused)||0}\n\n📅 ${period}\nNew starts: ${count('student_started')}\nConnections: ${count('connection_success')} successful · ${count('connection_failure')} failed\n\n🔄 Moodle syncs\nCompleted: ${count('sync_success')} (limited: ${count('sync_limited')})\nFailed: ${count('sync_failure')}\n\n📤 Assignment submissions\nRequested: ${count('submission_requested')}\nVerified submitted: ${count('submission_success')}\nSaved as draft: ${count('submission_draft')}\nUncertain results: ${count('submission_uncertain')}\nFailed: ${count('submission_failure')}\n\n📁 Files\nDownloads: ${count('file_download')}\nSent to Telegram: ${count('telegram_file_sent')}\n\n🕒 Asia/Tashkent · Updated ${DateTime.fromSeconds(now,{zone:'Asia/Tashkent'}).toFormat('HH:mm:ss')}\nAggregate counts only. Activity starts when tracking was enabled; disconnected accounts are removed from current totals. Up to 90 days of counters are retained.`;
}
