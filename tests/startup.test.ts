import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

test('application boots from a fresh database without live credentials and serves its connection page',async t => {
  const temp=mkdtempSync(join(tmpdir(),'moodle-startup-'));
  const child=spawn(process.execPath,['src/main.ts'],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',TELEGRAM_MODE:'polling',TELEGRAM_BOT_TOKEN:'',PUBLIC_URL:'http://localhost:3000',MOODLE_URL:'https://moodle.uwed.uz',DATABASE_PATH:join(temp,'app.sqlite'),ENCRYPTION_KEY:randomBytes(32).toString('base64')},stdio:['ignore','pipe','pipe']});
  let exited=false;child.once('exit',()=>{exited=true;});
  t.after(async()=>{if(!exited){child.kill();await new Promise(resolve=>child.once('exit',resolve));}rmSync(temp,{recursive:true,force:true});});
  const address=await new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Startup timeout')),10000);
    child.stdout.on('data',data=>{const match=/listening at (http:\/\/[^\s"}]+)/.exec(String(data));if(match){clearTimeout(timer);resolve(match[1].replace(/\.$/,''));}});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Startup exited '+code));});
  });
  assert.equal((await fetch(address+'/healthz')).status,200);
  assert.equal((await fetch(address+'/readyz')).status,503);
  const retired=await fetch(address+'/connect');assert.equal(retired.status,410);assert.match(await retired.text(),/private Telegram bot chat/);
});
