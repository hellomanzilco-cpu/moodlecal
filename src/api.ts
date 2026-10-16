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

export function createApp(config: Config, store: Store, service: SyncService, moodle: MoodleGateway, onUpdate: (update: unknown) => Promise<void>,assignments?:AssignmentService) {
  // Access logs are disabled: feed URLs and linking requests contain bearer secrets.
  const app=Fastify({logger:false,bodyLimit:16*1024,requestTimeout:120000});
  const rates=new Map<string,{count:number;expires:number}>();
  const connections=new Map<string,ConnectionState>();
  app.addHook('onRequest',async (_request,reply) => {
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer')
      .header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY');
  });
  app.setErrorHandler((_error,_request,reply) => { reply.code(400).send({error:'Request could not be completed. Check your input and try again.'}); });
  if(assignments)registerAssignmentRoutes(app,config,assignments);
  app.get('/privacy',async(_request,reply)=>reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy · Moodle Calendar</title><h1>Moodle Calendar privacy</h1><p>Independent application by Tursunov Sunnatilla, not created by UWED. Contact: @sunnatilla_tursunov.</p><p>Passwords are used only for sign-in and are not stored. Moodle session cookies are not collected. Encrypted access tokens, your Telegram chat identifier, course snapshots, preferences and submission receipts support your connection. Analytics contain aggregate daily counts only, without names, Moodle usernames, files, cookies, or identifiers.</p><p>Optional profile sharing is off by default. Under Settings → Profile sharing you can separately agree to share your Moodle first name, last name and username with Tursunov Sunnatilla in a private owner-only user list. These fields are saved encrypted, separately from analytics, at the time you confirm sharing. They are not automatically refreshed. You can use the student features without sharing. Stop sharing, reconnect or disconnect to remove the shared record from the live database. This cannot erase messages already delivered or copies in encrypted operator backups; operators must protect and retire those backups separately. Passwords, cookies, coursework and grades are never included in the shared profile.</p><p>Uploaded work is held temporarily in server memory while it is sent to Moodle; it is not retained as a local file. Submission receipts record filenames, sizes and status to prevent duplicate writes. Files you send to Telegram are handled by Telegram. Verify important submissions directly in Moodle.</p><p>Disconnect in the bot to delete your connection and personal application records from the live database. This does not delete work already submitted to Moodle or messages already delivered to Telegram. Aggregate counts are retained for 90 days and cannot identify an individual.</p></html>'));
  app.get('/healthz',async () => ({ok:true}));
  app.get('/readyz',async (_request,reply) => {
    store.db.prepare('SELECT 1').get();
    if (!config.telegramToken) return reply.code(503).send({ready:false,reason:'Telegram bot token is not configured.'});
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
  app.post<{Body:{linkToken:string;token?:string;username?:string;password?:string;consent:boolean;attemptId?:string}}>('/api/connect',{
    schema:{body:{type:'object',additionalProperties:false,required:['linkToken','consent'],properties:{linkToken:{type:'string',minLength:40,maxLength:100},token:{type:'string',maxLength:512},username:{type:'string',maxLength:256},password:{type:'string',maxLength:512},consent:{type:'boolean',const:true},attemptId:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}}}},
  },async (request,reply) => {
    if (request.headers.origin!==new URL(config.publicUrl).origin) return reply.code(403).send({error:'Open the connection page from your Telegram link.'});
    const now=Math.floor(Date.now()/1000); const {linkToken}=request.body;
    const rateKey=hashSecret(linkToken); const rate=rates.get(rateKey);
    if (rates.size>5000) for(const [key,value] of rates) if(value.expires<=now) rates.delete(key);
    if(rates.size>10000 && !rate) return reply.code(429).send({error:'Please try again later.'});
    if (rate && rate.expires>now && rate.count>=6) return reply.code(429).send({error:'Too many attempts. Request a fresh /connect link.'});
    rates.set(rateKey,{count:rate && rate.expires>now ? rate.count+1:1,expires:now+900});
    if (!store.byLink(rateKey,now)) return reply.code(400).send({error:'Connection link expired. Send /connect in Telegram.'});
    for(const [key,state] of connections)if(state.expires<=now)connections.delete(key);
    const attemptKey=request.body.attemptId?hashSecret(request.body.attemptId):null;
    if(attemptKey && connections.has(attemptKey))return reply.code(409).send({error:'This connection attempt is already being processed. Check its status before retrying.'});
    if(connections.size>=5000)return reply.code(429).send({error:'Please try again later.'});
    const report=(phase:ConnectionStage)=>{if(attemptKey)connections.set(attemptKey,{phase,...CONNECTION_PHASES[phase],status:'working',linkHash:rateKey,expires:now+900});};
    const failed=(error:string)=>{const state=attemptKey?connections.get(attemptKey):null;if(state){state.status='failed';state.error=error;state.label='Could not connect.';}};
    try {
      report('authenticating');
      let token=request.body.token?.trim();
      if (!token) {
        if (!request.body.username || !request.body.password){failed('Enter your Moodle username and password.');return reply.code(400).send({error:'Enter your Moodle username and password.'});}
        token=await moodle.login(request.body.username,request.body.password);
      }
      await service.connect(linkToken,token,report);
      const state=attemptKey?connections.get(attemptKey):null;
      if(state){state.percent=100;state.status='complete';state.label='You’re connected.';state.expires=now+1200;}
      return {ok:true};
    } catch(error) {
      store.metric('connection_failure');
      if(error instanceof MoodleError){const message=error.reason==='authentication'?'Moodle did not accept this sign-in. Check your Moodle username and password.':syncFailure(error);failed(message);return reply.code(error.reason==='network'?503:400).send({error:message,code:error.reason});}
      failed('Moodle could not be connected. Try again with a fresh connection link. Your previous data is preserved.');
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
