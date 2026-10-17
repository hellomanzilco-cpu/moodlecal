import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {DateTime} from 'luxon';
import {loadConfig} from '../src/config.ts';
import {Store} from '../src/store.ts';
import {Vault} from '../src/security.ts';
import {telegramDisplayName,telegramDisplayNameContext} from '../src/connection-diagnostics.ts';

if(existsSync('.env'))loadEnvFile('.env');
const daysArg=process.argv.slice(2).find(value=>/^--days=\d+$/.test(value));
const days=daysArg?Number(daysArg.slice('--days='.length)):7;
if(!Number.isSafeInteger(days)||days<1||days>90){console.error('Use --days=1..90.');process.exit(1);}
const config=loadConfig();
const store=new Store(config.databasePath);
const vault=new Vault(config.encryptionKey);
const labels={
  moodle_reachability:'Check Moodle site availability',
  login_token:'Verify Moodle username/password sign-in',
  core_webservice_get_site_info:'Load Moodle profile and account access',
  core_enrol_get_users_courses:'Read enrolled courses',
  core_course_get_contents:'Read course activities and documents',
  mod_assign_get_assignments:'Read assignment requirements',
  mod_assign_get_submission_status:'Read assignment submission status and grades',
  mod_quiz_get_quizzes_by_courses:'Read quiz availability',
  mod_quiz_get_user_attempts:'Read quiz attempts',
  core_calendar_get_calendar_events:'Read calendar events',
  core_group_get_course_user_groups:'Read course groups',
};
const stageLabels={connection_setup:'Validate the connection link',connecting:'Check Moodle site availability',authenticating:'Verify Moodle sign-in',profile:'Load Moodle profile and account access',synchronizing:'Synchronize courses and assignments',dashboard:'Save data and prepare the dashboard'};
const now=Math.floor(Date.now()/1000);
try{
  const records=store.connectionAttempts(now-days*86400).map(row=>{
    let name='Name unavailable';
    if(row.displayNameCipher){
      try{name=telegramDisplayName(vault.open(row.displayNameCipher,telegramDisplayNameContext(row.studentId)),'')||name;}catch{}
    }
    return {
      startedAt:DateTime.fromSeconds(row.startedAt,{zone:'Asia/Tashkent'}).toISO({suppressMilliseconds:true}),
      finishedAt:row.finishedAt===null?null:DateTime.fromSeconds(row.finishedAt,{zone:'Asia/Tashkent'}).toISO({suppressMilliseconds:true}),
      telegramName:name,
      status:row.status,
      step:row.operation?(labels[row.operation]||row.operation):(stageLabels[row.stage]||row.stage),
      stage:row.stage,
      failureCategory:row.failureCategory,
      moodleApiCode:row.apiErrorCode,
      details:row.message,
    };
  });
  console.log(JSON.stringify({windowDays:days,timeZone:'Asia/Tashkent',retentionDays:90,recordCount:records.length,records},null,2));
}finally{store.close();}
