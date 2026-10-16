import Fastify from 'fastify';
import { newSecret, hashSecret, safeEqual } from './security.ts';
import { upcomingClasses } from './planning.ts';
import { renderCalendar } from './calendar.ts';
import { parseMoodleEvent, verifyMoodleSignature } from './moodle-events.ts';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { SyncService } from './sync.ts';
import type { MoodleGateway } from './types.ts';

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!)); }
export function createApp(config: Config, store: Store, service: SyncService, moodle: MoodleGateway, onUpdate: (update: unknown) => Promise<void>) {
  // Access logs are disabled: feed URLs and linking requests contain bearer secrets.
  const app=Fastify({logger:false,bodyLimit:16*1024,requestTimeout:30000});
  const rates=new Map<string,{count:number;expires:number}>();
  app.addHook('onRequest',async (_request,reply) => {
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer')
      .header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY');
  });
  app.setErrorHandler((_error,_request,reply) => { reply.code(400).send({error:'Request could not be completed. Check your input and try again.'}); });
  app.get('/healthz',async () => ({ok:true}));
  app.get('/readyz',async (_request,reply) => {
    store.db.prepare('SELECT 1').get();
    if (!config.telegramToken) return reply.code(503).send({ready:false,reason:'Telegram bot token is not configured.'});
    return {ready:true,moodleUpdates:{mode:'events',periodicChecks:false,receiverConfigured:!!config.moodleEventSecret,lastEventAt:store.getMeta('moodleEventReceivedAt')}};
  });
  app.get('/',async (_request,reply) => reply.type('text/html').send('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moodle Calendar</title><h1>Moodle Calendar</h1><p>Open your Moodle Calendar bot in Telegram and send /connect to link your student account.</p></html>'));
  app.get('/connect',async (_request,reply) => {
    const nonce=newSecret();
    reply.header('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`);
    return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect · Moodle Calendar</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#18283d;font:16px/1.6 system-ui,sans-serif}main{max-width:540px;margin:6vh auto;padding:32px;background:white;border:1px solid #dce4ed;border-radius:20px}h1{font-size:28px;line-height:1.2}label{display:block;margin:18px 0 5px}input,button{width:100%;padding:12px;border:1px solid #a9b7c9;border-radius:8px;font:inherit}button{background:#175c4c;color:white;margin-top:24px;cursor:pointer}small{color:#52627a}details{margin-top:20px}#result{white-space:pre-wrap}@media(max-width:600px){main{margin:16px;padding:24px}}</style></head>
<body><main><small>MOODLE CALENDAR · PRIVATE CONNECTION</small><h1>Your classes, in one place.</h1><p>Connect your student account at <strong>${escapeHtml(new URL(config.moodleUrl).hostname)}</strong>.</p>
<p>Only connect through a Moodle Calendar operator you trust. A Moodle token grants the service access to your account. It is encrypted in storage; no Moodle password is stored.</p>
<form id="form"><label for="token">Moodle web service token</label><input id="token" type="password" autocomplete="off" maxlength="512"><small>Use your own token if the university provides one.</small>
<details><summary>Connect using your Moodle username and password</summary><p>Your credentials are sent over HTTPS to Moodle once to obtain a token. This may not work with SSO or university restrictions.</p><label for="username">Username</label><input id="username" autocomplete="username" maxlength="256"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" maxlength="512"></details>
<button type="submit" id="submit">Connect Moodle</button></form><p id="result" role="status"></p><small>We sync accessible course materials, tasks, and calendar events. Link expires after 15 minutes. Send /disconnect in Telegram to delete your stored account data.</small></main>
<script nonce="${nonce}">
const linkToken=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'','/connect');
const form=document.getElementById('form'),result=document.getElementById('result'),button=document.getElementById('submit');
if(!linkToken){result.textContent='Open a fresh connection link from /connect in Telegram.';button.disabled=true;}
form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;result.textContent='Connecting and syncing your courses…';
const token=document.getElementById('token'),username=document.getElementById('username'),password=document.getElementById('password');
try{const response=await fetch('/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({linkToken,token:token.value.trim(),username:username.value.trim(),password:password.value})});
const data=await response.json();result.textContent=response.ok?'Connected. Return to Telegram and use /priorities or /calendar.':data.error;
token.value='';password.value='';if(response.ok){form.hidden=true;}else{button.disabled=false;}}
catch{result.textContent='Connection interrupted. Please try again.';button.disabled=false;password.value='';}});
</script></body></html>`);
  });
  app.post<{Body:{linkToken:string;token?:string;username?:string;password?:string}}>('/api/connect',{
    schema:{body:{type:'object',additionalProperties:false,required:['linkToken'],properties:{linkToken:{type:'string',minLength:40,maxLength:100},token:{type:'string',maxLength:512},username:{type:'string',maxLength:256},password:{type:'string',maxLength:512}}}},
  },async (request,reply) => {
    if (request.headers.origin!==new URL(config.publicUrl).origin) return reply.code(403).send({error:'Open the connection page from your Telegram link.'});
    const now=Math.floor(Date.now()/1000); const {linkToken}=request.body;
    const rateKey=hashSecret(linkToken); const rate=rates.get(rateKey);
    if (rates.size>5000) for(const [key,value] of rates) if(value.expires<=now) rates.delete(key);
    if(rates.size>10000 && !rate) return reply.code(429).send({error:'Please try again later.'});
    if (rate && rate.expires>now && rate.count>=6) return reply.code(429).send({error:'Too many attempts. Request a fresh /connect link.'});
    rates.set(rateKey,{count:rate && rate.expires>now ? rate.count+1:1,expires:now+900});
    if (!store.byLink(rateKey,now)) return reply.code(400).send({error:'Connection link expired. Send /connect in Telegram.'});
    try {
      let token=request.body.token?.trim();
      if (!token) {
        if (!request.body.username || !request.body.password) return reply.code(400).send({error:'Enter a Moodle token or your username and password.'});
        token=await moodle.login(request.body.username,request.body.password);
      }
      await service.connect(linkToken,token);
      return {ok:true};
    } catch {
      return reply.code(400).send({error:'Moodle could not be connected. Check your credentials and link expiry. Student web service permissions may need university IT support. Your previous data is preserved.'});
    } finally {
      request.body.password='';request.body.token='';
    }
  });
  app.get<{Params:{token:string}}>('/calendar/:token.ics',async (request,reply) => {
    const raw=request.params.token;
    if(!/^[\w-]{43}$/.test(raw)) return reply.code(404).send({error:'Calendar not found.'});
    const student=store.byCalendar(hashSecret(raw));
    if(!student) return reply.code(404).send({error:'Calendar not found.'});
    const now=Math.floor(Date.now()/1000);
    const courses=store.courses(student.id).filter(c => !c.muted);
    const items=[...store.items(student.id),...upcomingClasses(student,store.classes(student.id),courses,now,90)];
    return reply.type('text/calendar; charset=utf-8').header('Content-Disposition','inline; filename="moodle-calendar.ics"').send(renderCalendar(items,student.id,now));
  });
  app.post('/telegram/webhook',async (request,reply) => {
    const secret=request.headers['x-telegram-bot-api-secret-token'];
    if(config.telegramMode!=='webhook' || typeof secret!=='string' || !safeEqual(secret,config.webhookSecret)) return reply.code(403).send({error:'Forbidden'});
    await onUpdate(request.body);
    return {ok:true};
  });
  // A scoped raw parser preserves the exact bytes Moodle signed, without
  // changing the JSON parsing of account-link or Telegram requests.
  app.register(async events=>{
    events.removeContentTypeParser('application/json');
    events.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
    events.post<{Body:Buffer}>('/moodle/events',async(request,reply)=>{
      if(!config.moodleEventSecret)return reply.code(503).send({error:'Moodle event receiver is not configured.'});
      const now=Math.floor(Date.now()/1000);
      if(!Buffer.isBuffer(request.body) || !verifyMoodleSignature(config.moodleEventSecret,request.headers['x-moodle-calendar-timestamp'],request.headers['x-moodle-calendar-signature'],request.body,now))return reply.code(403).send({error:'Invalid Moodle event signature.'});
      const event=parseMoodleEvent(request.body,now);
      if(!event)return reply.code(400).send({error:'Invalid Moodle event.'});
      try {
        const accepted=store.acceptMoodleEvent(event,now);
        // Acknowledge the durable job immediately. Its retries survive restarts.
        void service.processEvents().then(()=>service.deliver()).catch(()=>{});
        return reply.code(202).send({ok:true,...accepted});
      } catch {return reply.code(503).send({error:'Moodle event could not be queued. Please retry.'});}
    });
  });
  return app;
}
