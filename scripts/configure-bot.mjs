import {loadEnvFile} from 'node:process';
import {existsSync} from 'node:fs';
import {envValue} from '../src/env.ts';
if(existsSync('.env'))loadEnvFile('.env');
const token=envValue(process.env,'TELEGRAM_BOT_TOKEN','Bot_token');
if(!token)throw new Error('Bot token is missing');
const description='🎓 Moodle Calendar\n\nYour UWED classes, assignments and deadlines in one place.\n\n📚 Connect your own Moodle account\n🔄 Sync when you want fresh information\n🗓 Subscribe to your private calendar\n\nTap Start to begin. Automatic website alerts depend on UWED’s event integration.';
const methods=[['setMyDescription',{description}],['setMyShortDescription',{short_description:'Your UWED study planner: courses, tasks, deadlines and a private calendar.'}],['setMyCommands',{commands:[{command:'start',description:'Open the main menu'},{command:'sync',description:'Sync Moodle and show changes'},{command:'help',description:'How to use Moodle Calendar'}]}]];
for(const [method,body] of methods){
 try{const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok||!data.ok)throw new Error('Rejected');console.log(method+' configured.');}
 catch{console.error('Telegram profile configuration failed at '+method);process.exit(1);}
}
