import {loadEnvFile} from 'node:process';
import {existsSync} from 'node:fs';
import {envValue} from '../src/env.ts';
if(existsSync('.env'))loadEnvFile('.env');
const token=envValue(process.env,'TELEGRAM_BOT_TOKEN','Bot_token');
if(!token)throw new Error('Bot token is missing');
const description='🎓 Moodle Calendar\n\nIndependent third-party app created by Tursunov Sunnatilla. Not created by or on behalf of UWED.\n\nKeep your courses, assignments and deadlines together.\n\nTap Start, then Connect Moodle to sign in inside Telegram.\n\nContact: https://t.me/sunnatilla_tursunov';
const bio='Third-party app by Tursunov Sunnatilla. Not created by UWED. Contact: @sunnatilla_tursunov';
const methods=[['setMyDescription',{description}],['setMyShortDescription',{short_description:bio}],['setMyCommands',{commands:[{command:'start',description:'Open the main menu'},{command:'assignments',description:'View assignment status and categories'},{command:'today',description:'View today’s deadlines and classes'},{command:'week',description:'View the next seven days'},{command:'priorities',description:'View your next deadlines'},{command:'courses',description:'List your Moodle courses'},{command:'sync',description:'Sync Moodle and show changes'},{command:'status',description:'Check connection and sync status'},{command:'help',description:'How to use Moodle Calendar'}]}]];
for(const [method,body] of methods){
 try{const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok||!data.ok)throw new Error('Rejected');console.log(method+' configured.');}
 catch{console.error('Telegram profile configuration failed at '+method);process.exit(1);}
}
