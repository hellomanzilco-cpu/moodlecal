import {readFileSync,existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {envValue} from '../src/env.ts';
if(existsSync('.env'))loadEnvFile('.env');
const token=envValue(process.env,'TELEGRAM_BOT_TOKEN','Bot_token');
const path=process.argv[2];
if(!token||!path){console.error('Provide a JPG file path and configure the bot token in .env.');process.exit(1);}
try{
 const bytes=readFileSync(path);if(bytes[0]!==255||bytes[1]!==216)throw new Error('JPG required');
 const form=new FormData();form.set('photo',JSON.stringify({type:'static',photo:'attach://profile_photo'}));form.set('profile_photo',new Blob([bytes],{type:'image/jpeg'}),'profile.jpg');
 const response=await fetch(`https://api.telegram.org/bot${token}/setMyProfilePhoto`,{method:'POST',body:form,signal:AbortSignal.timeout(60000)});
 const data=await response.json();if(!response.ok||!data.ok){console.error('Telegram rejected the profile photo (HTTP '+response.status+').');process.exit(1);}
 console.log('Bot profile photo updated from the supplied image.');
}catch{console.error('Profile photo could not be updated. Check the JPG file and connection.');process.exitCode=1;}
