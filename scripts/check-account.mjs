import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { MoodleClient } from '../src/moodle.ts';
import { currentAssignmentKeys, formatTime, isActionable } from '../src/planning.ts';
import { envValue } from '../src/env.ts';

if(existsSync('.env')) loadEnvFile('.env');
const token=envValue(process.env,'MOODLE_TOKEN')?.trim();
const username=envValue(process.env,'MOODLE_USERNAME')?.trim();
const password=envValue(process.env,'MOODLE_PASSWORD');
if(!token && (!username || !password)) {
  console.error('Add MOODLE_USERNAME and MOODLE_PASSWORD (or MOODLE_TOKEN) to your local .env, then rerun npm run account:check. No login was attempted.');
  process.exitCode=2;
} else {
  try {
    const client=new MoodleClient(process.env.MOODLE_URL || 'https://moodle.uwed.uz');
    const access=token || await client.login(username,password);
    const now=Math.floor(Date.now()/1000);
    const snapshot=await client.snapshot(access,now,!process.argv.includes('--full'));
    const current=currentAssignmentKeys(snapshot.items,now);
    const groups={current:[],overdue:[],later:[],undated:[],restricted:[],closed:[],access_unknown:[],submitted_ungraded:[],submitted_graded:[],unknown:[]};
    const counts={outstanding:0,current:0,overdue:0,later:0,undated:0,restricted:0,closed:0,access_unknown:0,submitted_ungraded:0,submitted_graded:0,unknown:0};
    for(const item of snapshot.items) {
      if(item.kind!=='assignment') continue;
      const status=item.submissionStatus || 'unknown';
      let group=status;
      if(status==='outstanding'){
        counts.outstanding++;
        group=item.dueAt===null?'undated':!isActionable(item,now)?(['restricted','closed'].includes(item.availability)?item.availability:item.availability==='upcoming'?'later':'access_unknown'):item.dueAt<now?'overdue':current.has(item.key)?'current':'later';
      }
      counts[group]++;
      groups[group].push({course:item.courseName,title:item.title,key:item.key,deadline:item.dueAt,grade:item.grade || null,url:item.url,availability:item.availability,availabilityReason:item.availabilityReason,availableFrom:item.availableFrom,cutoffAt:item.cutoffAt});
    }
    for(const values of Object.values(groups)) values.sort((a,b)=>(a.deadline ?? Infinity)-(b.deadline ?? Infinity) || a.course.localeCompare(b.course));
    const report={checkedAt:new Date().toISOString(),courseCount:snapshot.courses.length,warnings:snapshot.warnings,counts,groups};
    const timezone=process.env.DEFAULT_TIMEZONE || 'Asia/Tashkent';
    const lines=['# Your Moodle assignments','',`Checked: ${formatTime(now,timezone)} (${timezone})`,'','This is a read-only account report. Focus means the nearest upcoming deadline per course; it is a planning rule, not confirmation that a teacher released a task. Submitted tasks remain in the deadline sequence until their deadline passes. Moodle edit permissions alone are not described as teacher release.','',`Total unfinished: ${counts.outstanding}. Next deadlines: ${counts.current}. Overdue: ${counts.overdue}. Later: ${counts.later}. Undated: ${counts.undated}. Restricted: ${counts.restricted}. Closed: ${counts.closed}. Access unconfirmed: ${counts.access_unknown}.`,''];
    const labels={current:'⏳ Next deadline per course',overdue:'⚠️ Overdue, still editable',later:'🕓 Later deadlines or not open yet',undated:'📋 No published deadline',restricted:'🔒 Restricted',closed:'⛔ Submissions closed',access_unknown:'❓ Submission access unconfirmed',submitted_ungraded:'📨 Submitted, awaiting grading',submitted_graded:'✅ Submitted and graded',unknown:'❓ Status unavailable or not a submission activity'};
    for(const [key,values] of Object.entries(groups)) {
      lines.push(`## ${labels[key]} (${values.length})`,'');
      if(!values.length) lines.push('None.','');
      for(const item of values) lines.push(`- **${item.course}: ${item.title.replace(/[\r\n]/g,' ')}**`, `  - Deadline: ${item.deadline ? formatTime(item.deadline,timezone) : 'Not published'}${item.deadline && item.deadline<now && key==='overdue' ? ' (overdue, Moodle still accepts work)' : ''}`,`  - Moodle access: ${item.availability ?? 'unknown'}${item.availabilityReason ? ' — '+item.availabilityReason : ''}`,`  - Opens: ${item.availableFrom ? formatTime(item.availableFrom,timezone) : 'No opening date set'}`,`  - Cutoff: ${item.cutoffAt ? formatTime(item.cutoffAt,timezone) : 'No cutoff date set'}`,`  - Grade: ${item.grade ?? 'Not available / not released'}`,`  - [Open in Moodle](${item.url})`,'');
    }
    if(snapshot.warnings.length) lines.push('## Coverage notes','',...snapshot.warnings.map(w=>'- '+w));
    mkdirSync('data',{recursive:true});
    writeFileSync('data/account-report.json',JSON.stringify(report,null,2),{mode:0o600});
    writeFileSync('data/account-report.md',lines.join('\n'),{mode:0o600});
    console.log(JSON.stringify({checked:true,courses:report.courseCount,counts,report:'data/account-report.md',warnings:report.warnings}));
  } catch(error) {
    console.error(error?.name==='MoodleError' ? error.userMessage : 'Account inspection failed. Check your network and .env settings. Credentials were not logged.');
    if(error?.name==='MoodleError' && error.operation) console.error('Operation:',error.operation,'Warning codes:',error.warningCodes?.join(',') || 'none');
    process.exitCode=1;
  } finally { delete process.env.MOODLE_PASSWORD; }
}
