import Fastify from 'fastify';
import { newSecret, hashSecret, safeEqual } from './security.ts';
import { upcomingClasses } from './planning.ts';
import { renderCalendar } from './calendar.ts';
import { parseMoodleEvent, verifyMoodleSignature } from './moodle-events.ts';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { SyncService } from './sync.ts';
import type { MoodleGateway } from './types.ts';
import { MoodleError } from './moodle.ts';
import { syncFailure } from './sync-errors.ts';
import { connectionPage } from './connect-page.ts';
import { CONNECTION_PHASES } from './connection-progress.ts';
import type { ConnectionState } from './connection-progress.ts';
import type { ConnectionStage } from './types.ts';
import type {AssignmentService} from './assignments.ts';
import {registerAssignmentRoutes} from './assignment-api.ts';
import {SyncLimitError} from './sync-quota.ts';
import type {RuntimeHealth} from './runtime-health.ts';

export function createApp(config: Config, store: Store, service: SyncService, moodle: MoodleGateway, onUpdate: (update: unknown) => Promise<void>,assignments?:AssignmentService,runtime?:RuntimeHealth) {
  // Access logs are disabled: feed URLs and linking requests contain bearer secrets.
  const app=Fastify({logger:false,bodyLimit:16*1024,requestTimeout:120000,connectionTimeout:120000,keepAliveTimeout:5000,maxRequestsPerSocket:100});
  app.server.headersTimeout=10000;app.server.maxConnections=200;
  const rates=new Map<string,{count:number;expires:number}>();
  const connections=new Map<string,ConnectionState>();
  const activeConnections=new Set<number>(),connectionJobs=new Set<Promise<unknown>>();
  app.addHook('onClose',async()=>{await Promise.allSettled(connectionJobs);});
  app.addHook('onRequest',async (_request,reply) => {
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer')
      .header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY');
    reply.header('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
      .header('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if(config.publicUrl.startsWith('https:'))reply.header('Strict-Transport-Security','max-age=31536000');
  });
  app.setErrorHandler((_error,_request,reply) => { reply.code(400).send({error:'Request could not be completed. Check your input and try again.'}); });
  if(assignments)registerAssignmentRoutes(app,config,assignments);
  app.get('/privacy',async(_request,reply)=>reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy · Moodle Calendar</title><h1>Moodle Calendar privacy</h1><p>Independent application by Tursunov Sunnatilla, not created by UWED. Contact: @sunnatilla_tursunov.</p><p>Passwords are used only for sign-in and are not stored. Moodle session cookies are not collected. Encrypted access tokens, your Telegram chat identifier, course snapshots, preferences and submission receipts support your connection. Analytics contain aggregate daily counts only, without names, Moodle usernames, files, cookies, or identifiers.</p><p>Optional profile sharing is off by default. Under Settings → Profile sharing you can separately agree to share your Moodle first name, last name and username with Tursunov Sunnatilla in a private owner-only user list. These fields are saved encrypted, separately from analytics, at the time you confirm sharing. They are not automatically refreshed. You can use the student features without sharing. Stop sharing, reconnect or disconnect to remove the shared record from the live database. This cannot erase messages already delivered or copies in encrypted operator backups; operators must protect and retire those backups separately. Passwords, cookies, coursework and grades are never included in the shared profile.</p><p>Uploaded work is held temporarily in server memory while it is sent to Moodle; it is not retained as a local file. Submission receipts record filenames, sizes and status to prevent duplicate writes. Files you send to Telegram are handled by Telegram. Verify important submissions directly in Moodle.</p><p>Disconnect in the bot to delete your connection and personal application records from the live database. This does not delete work already submitted to Moodle or messages already delivered to Telegram. Aggregate counts are retained for 90 days and cannot identify an individual.</p></html>'));
  app.get('/healthz',async () => ({ok:true}));
  app.get('/readyz',async (_request,reply) => {
    store.db.prepare('SELECT 1').get();
    if (!config.telegramToken) return reply.code(503).send({ready:false,reason:'Telegram bot token is not configured.'});
    const health=runtime?.readiness();if(health&&!health.ready)return reply.code(503).send(health);
    return {ready:true,moodleUpdates:{mode:'events',periodicChecks:false,receiverConfigured:!!config.moodleEventSecret,lastEventAt:store.getMeta('moodleEventReceivedAt')}};
  });
  app.get('/',async (_request,reply) => reply.type('text/html').send('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moodle Calendar</title><h1>Moodle Calendar</h1><p>Open your Moodle Calendar bot in Telegram and send /connect to link your student account.</p></html>'));
  app.get('/connect',async (_request,reply) => {
    const nonce=newSecret();
    reply.removeHeader('X-Frame-Options');
    reply.header('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}' https://telegram.org; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org`);
    return reply.type('text/html; charset=utf-8').send(connectionPage(nonce,config.moodleUrl));
  });
  app.post<{Body:{linkToken:string;attemptId:string}}>('/api/connect/status',{
    schema:{body:{type:'object',additionalProperties:false,required:['linkToken','attemptId'],properties:{linkToken:{type:'string',minLength:40,maxLength:100},attemptId:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}}}},
  },async(request,reply)=>{
    if(request.headers.origin!==new URL(config.publicUrl).origin)return reply.code(403).send({error:'Open the connection window from Telegram.'});
    const state=connections.get(hashSecret(request.body.attemptId));
    if(!state || state.expires<=Date.now()/1000 || !safeEqual(state.linkHash,hashSecret(request.body.linkToken)))return reply.code(404).send({error:'Connection status unavailable.'});
    const {phase,percent,label,status,error}=state;
    return {phase,percent,label,status,...(error?{error}:{} )};
  });
  app.post<{Body:{linkToken:string;token?:string;username?:string;password?:string;consent:boolean;attemptId?:string;asyncMode?:boolean}}>('/api/connect',{
    schema:{body:{type:'object',additionalProperties:false,required:['linkToken','consent'],properties:{linkToken:{type:'string',minLength:40,maxLength:100},token:{type:'string',maxLength:512},username:{type:'string',maxLength:256},password:{type:'string',maxLength:512},consent:{type:'boolean',const:true},attemptId:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'},asyncMode:{type:'boolean'}}}},
  },async (request,reply) => {
    if (request.headers.origin!==new URL(config.publicUrl).origin) return reply.code(403).send({error:'Open the connection page from your Telegram link.'});
    const now=Math.floor(Date.now()/1000); const {linkToken}=request.body;
    const rateKey=hashSecret(linkToken); const rate=rates.get(rateKey);
    if (rates.size>5000) for(const [key,value] of rates) if(value.expires<=now) rates.delete(key);
    if(rates.size>10000 && !rate) return reply.code(429).send({error:'Please try again later.'});
    if (rate && rate.expires>now && rate.count>=6) return reply.code(429).send({error:'Too many attempts. Request a fresh /connect link.'});
    rates.set(rateKey,{count:rate && rate.expires>now ? rate.count+1:1,expires:now+900});
    const student=store.byLink(rateKey,now);
    if (!student) return reply.code(400).send({error:'Connection link expired. Send /connect in Telegram.'});
    if(service.syncAllowance(student.id).remaining===0)return reply.code(429).send({error:new SyncLimitError().message});
    if(activeConnections.has(student.id))return reply.code(409).send({error:'Your connection is still being checked. Wait for its result before retrying.'});
    if(activeConnections.size>=3)return reply.code(429).send({error:'Connections are busy. Please try again shortly.'});
    if(request.body.asyncMode&&!request.body.attemptId)return reply.code(400).send({error:'A private connection attempt identifier is required.'});
    for(const [key,state] of connections)if(state.expires<=now)connections.delete(key);
    const attemptKey=request.body.attemptId?hashSecret(request.body.attemptId):null;
    if(attemptKey && connections.has(attemptKey))return reply.code(409).send({error:'This connection attempt is already being processed. Check its status before retrying.'});
    if(connections.size>=5000)return reply.code(429).send({error:'Please try again later.'});
    const report=(phase:ConnectionStage)=>{if(attemptKey)connections.set(attemptKey,{phase,...CONNECTION_PHASES[phase],status:'working',linkHash:rateKey,expires:now+900});};
    const failed=(error:string)=>{const state=attemptKey?connections.get(attemptKey):null;if(state){state.status='failed';state.error=error;state.label='Could not connect.';}};
    const credentials={token:request.body.token,username:request.body.username,password:request.body.password};
    request.body.password='';request.body.token='';
    activeConnections.add(student.id);
    const execute=async()=>{try {
      report('authenticating');
      let token=credentials.token?.trim();
      if (!token) {
        if (!credentials.username || !credentials.password){failed('Enter your Moodle username and password.');return {code:400,body:{error:'Enter your Moodle username and password.'}};}
        try{token=await moodle.login(credentials.username,credentials.password);}finally{credentials.password='';}
      }
      await service.connect(linkToken,token,report);
      const state=attemptKey?connections.get(attemptKey):null;
      if(state){state.percent=100;state.status='complete';state.label='You’re connected.';state.expires=now+1200;}
      return {code:200,body:{ok:true}};
    } catch(error) {
      store.metric('connection_failure');
      if(error instanceof SyncLimitError){failed(error.message);return {code:429,body:{error:error.message}};}
      if(error instanceof MoodleError){const message=error.reason==='authentication'?'Moodle did not accept this sign-in. Check your Moodle username and password.':syncFailure(error);failed(message);return {code:error.reason==='network'?503:400,body:{error:message,code:error.reason}};}
      failed('Moodle could not be connected. Try again with a fresh connection link. Your previous data is preserved.');
      return {code:400,body:{error:'Moodle could not be connected. Check your credentials and link expiry. Student web service permissions may need university IT support. Your previous data is preserved.'}};
    } finally {
      credentials.password='';credentials.token='';credentials.username='';activeConnections.delete(student.id);
    }};
    const work=execute();connectionJobs.add(work);work.then(()=>connectionJobs.delete(work),()=>connectionJobs.delete(work));
    if(request.body.asyncMode)return reply.code(202).send({accepted:true,attemptId:request.body.attemptId});
    const result=await work;return reply.code(result.code).send(result.body);
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
