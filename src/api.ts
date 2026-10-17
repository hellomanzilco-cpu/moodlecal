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
import { connectionPage } from './connect-page.ts';
import { CONNECTION_PHASES } from './connection-progress.ts';
import type { ConnectionState } from './connection-progress.ts';
import type { ConnectionStage } from './types.ts';
import type {AssignmentService} from './assignments.ts';
import {registerAssignmentRoutes} from './assignment-api.ts';
import type {RuntimeHealth} from './runtime-health.ts';

export function createApp(config: Config, store: Store, service: SyncService, moodle: MoodleGateway, onUpdate: (update: unknown) => Promise<void>,assignments?:AssignmentService,runtime?:RuntimeHealth) {
  // Structured access logging uses route templates only; secret URLs and payloads stay out of logs.
  const app=Fastify({logger:{level:'info',serializers:{req:request=>({method:request.method})}},disableRequestLogging:true,requestIdHeader:false,bodyLimit:16*1024,requestTimeout:120000,connectionTimeout:120000,keepAliveTimeout:5000,maxRequestsPerSocket:100});
  app.server.headersTimeout=10000;app.server.maxConnections=200;
  app.addHook('onResponse',async(request,reply)=>{
    request.log.info({event:'http_access',method:request.method,route:request.routeOptions.url??'unmatched',statusCode:reply.statusCode,durationMs:Math.round(reply.elapsedTime)},'HTTP access');
  });
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
  app.get('/privacy',async(_request,reply)=>reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy · Moodle Calendar</title><h1>Moodle Calendar privacy</h1><p>Independent application by Tursunov Sunnatilla, not created by UWED. Contact: @sunnatilla_tursunov.</p><p>Passwords entered in the Telegram Web App pass to the bot server for sign-in only and are not stored. Moodle session cookies are not collected. Encrypted access tokens, your Telegram chat identifier, course snapshots, preferences and submission receipts support your connection. Analytics contain aggregate daily counts only, without names, Moodle usernames, files, cookies, or identifiers.</p><p>Separately, failed or limited-coverage Moodle connection attempts retain your Telegram display name, the connection step, a safe reason, and a Moodle API error code when available. Names are encrypted at rest. If the app creator has configured an operator Telegram account, operational failures and limited-coverage notices are sent there without passwords, Moodle usernames, tokens or raw Moodle responses. Diagnostic records are retained for up to 90 days and deleted from the live database when you disconnect; encrypted backups may retain them until backup expiry. These records do not contain passwords, Moodle usernames, access tokens, request bodies, IP addresses or raw Moodle responses. Operational access logs contain only HTTP method, route template, response status and duration.</p><p>Optional profile sharing is off by default. Under Settings → Profile sharing you can separately agree to share your Moodle first name, last name and username with Tursunov Sunnatilla in a private owner-only user list. These fields are saved encrypted, separately from analytics, at the time you confirm sharing. They are not automatically refreshed. You can use the student features without sharing. Stop sharing, reconnect or disconnect to remove the shared record from the live database. This cannot erase messages already delivered or copies in encrypted operator backups; operators must protect and retire those backups separately. Passwords, cookies, coursework and grades are never included in the shared profile.</p><p>Uploaded work is held temporarily in server memory while it is sent to Moodle; it is not retained as a local file. Submission receipts record filenames, sizes and status to prevent duplicate writes. Files you send to Telegram are handled by Telegram. Verify important submissions directly in Moodle.</p><p>Disconnect in the bot to delete your connection and personal application records from the live database. This does not delete work already submitted to Moodle or messages already delivered to Telegram. Aggregate counts are retained for 90 days and cannot identify an individual.</p></html>'));
  app.get('/healthz',async () => ({ok:true}));
  app.get('/readyz',async (_request,reply) => {
    store.db.prepare('SELECT 1').get();
    if (!config.telegramToken) return reply.code(503).send({ready:false,reason:'Telegram bot token is not configured.'});
    const health=runtime?.readiness();if(health&&!health.ready)return reply.code(503).send(health);
    return {ready:true,moodleUpdates:{mode:'events',periodicChecks:false,receiverConfigured:!!config.moodleEventSecret,lastEventAt:store.getMeta('moodleEventReceivedAt')}};
  });
  app.get('/',async (_request,reply) => reply.type('text/html').send('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moodle Calendar</title><h1>Moodle Calendar</h1><p>Open your Moodle Calendar bot in Telegram and tap Connect Moodle to sign in inside Telegram.</p></html>'));
  app.get('/connect',async (_request,reply) => {
    const nonce=newSecret();
    reply.removeHeader('X-Frame-Options');
    reply.header('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}' https://telegram.org; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org`);
    return reply.type('text/html; charset=utf-8').send(connectionPage(nonce,config.moodleUrl));
  });
  app.post<{Body:{linkToken:string;attemptId:string}}>('/api/connect/status',{
    schema:{body:{type:'object',additionalProperties:false,required:['linkToken','attemptId'],properties:{linkToken:{type:'string',minLength:40,maxLength:100},attemptId:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}}}},
  },async(request,reply)=>{
    if(request.headers.origin!==new URL(config.publicUrl).origin)return reply.code(403).send({error:'Connection status is unavailable.'});
    const state=connections.get(hashSecret(request.body.attemptId));
    if(!state || state.expires<=Date.now()/1000 || !safeEqual(state.linkHash,hashSecret(request.body.linkToken)))return reply.code(404).send({error:'Connection status unavailable.'});
    const {phase,percent,label,status,serverStatus,authStatus,profileStatus,syncStatus,dashboardStatus,error,diagnosticId,coverageWarnings}=state;
    return {phase,percent,label,status,serverStatus,authStatus,profileStatus,syncStatus,dashboardStatus,...(error?{error}:{}),...(diagnosticId?{diagnosticId}:{}),...(coverageWarnings?.length?{coverageWarnings}:{} )};
  });
  app.post<{Body:{linkToken:string;token?:string;username?:string;password?:string;consent:boolean;attemptId?:string;asyncMode?:boolean;telegramConversation?:boolean}}>('/api/connect',{
    schema:{body:{type:'object',additionalProperties:false,required:['linkToken','consent'],properties:{linkToken:{type:'string',minLength:40,maxLength:100},token:{type:'string',maxLength:512},username:{type:'string',maxLength:256},password:{type:'string',maxLength:512},consent:{type:'boolean',const:true},attemptId:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'},asyncMode:{type:'boolean'},telegramConversation:{type:'boolean'}}}},
  },async (request,reply) => {
    if (request.headers.origin!==new URL(config.publicUrl).origin) return reply.code(403).send({error:'Connection request must come from the bot.'});
    const now=Math.floor(Date.now()/1000); const {linkToken}=request.body;
    const rateKey=hashSecret(linkToken); const rate=rates.get(rateKey);
    if (rates.size>5000) for(const [key,value] of rates) if(value.expires<=now) rates.delete(key);
    if(rates.size>10000 && !rate) return reply.code(429).send({error:'Please try again later.'});
    if (rate && rate.expires>now && rate.count>=6) return reply.code(429).send({error:'Too many attempts. Request a fresh /connect link.'});
    rates.set(rateKey,{count:rate && rate.expires>now ? rate.count+1:1,expires:now+900});
    const student=store.byLink(rateKey,now);
    if (!student) return reply.code(400).send({error:'Connection link expired. Send /connect in Telegram.'});
    const credentials={token:request.body.token,username:request.body.username,password:request.body.password};
    request.body.password='';request.body.token='';request.body.username='';request.body.linkToken='';
    const clearCredentials=()=>{credentials.password='';credentials.token='';credentials.username='';};
    let diagnosticId:number|null=null;
    try{diagnosticId=service.startConnectionAttempt?.(student.id,now)??null;}catch{request.log.error({event:'connection_diagnostic_write_failed',step:'start'},'Connection diagnostic could not be stored');}
    let currentStage:ConnectionStage='connecting';
    const recordFailure=(failure:{category:string;message:string;operation?:string|null;apiErrorCode?:string|null;status?:'failed'|'blocked'|'partial'},stage=currentStage)=>{
      if(diagnosticId===null)return;
      try{store.failConnectionAttempt(diagnosticId,{stage,status:failure.status,failureCategory:failure.category,operation:failure.operation,apiErrorCode:failure.apiErrorCode,message:failure.message},Math.floor(Date.now()/1000));}
      catch{request.log.error({event:'connection_diagnostic_write_failed',step:'finish'},'Connection diagnostic could not be stored');}
    };
    const notifyOwner=async(details:{stage:string;failureCategory:string;operation?:string|null;apiErrorCode?:string|null;httpStatus?:number;coverageWarningCount?:number;userMessage?:string;syncCoverage?:string})=>{
      if(diagnosticId===null)return;
      try{await service.notifyConnectionIssue(student.id,diagnosticId,details);}
      catch{request.log.error({event:'connection_admin_alert_failed',diagnosticId},'Connection issue alert could not be delivered');}
    };
    const reject=(status:number,category:string,message:string)=>{
      clearCredentials();
      recordFailure({category,message,status:'blocked'});
      return reply.code(status).send({error:message});
    };
    if(activeConnections.has(student.id))return reject(409,'already_connecting','Your connection is still being checked. Wait for its result before retrying.');
    if(activeConnections.size>=3)return reject(429,'service_busy','Connections are busy. Please try again shortly.');
    if(request.body.asyncMode&&!request.body.attemptId)return reject(400,'attempt_id_missing','A private connection attempt identifier is required.');
    for(const [key,state] of connections)if(state.expires<=now)connections.delete(key);
    const attemptKey=request.body.attemptId?hashSecret(request.body.attemptId):null;
    if(attemptKey && connections.has(attemptKey))return reject(409,'duplicate_attempt','This connection attempt is already being processed. Check its status before retrying.');
    if(connections.size>=5000)return reject(429,'service_busy','Please try again later.');
    const report=(phase:ConnectionStage)=>{
      currentStage=phase;
      if(diagnosticId!==null){try{store.setConnectionAttemptStage(diagnosticId,phase);}catch{request.log.error({event:'connection_diagnostic_write_failed',step:'progress'},'Connection diagnostic could not be stored');}}
      if(attemptKey){
        const previous=connections.get(attemptKey);
        const state:ConnectionState=previous??{phase,...CONNECTION_PHASES[phase],status:'working',serverStatus:'not_started',authStatus:'not_started',profileStatus:'not_started',syncStatus:'not_started',dashboardStatus:'not_started',linkHash:rateKey,expires:now+900};
        Object.assign(state,{phase,...CONNECTION_PHASES[phase],status:'working',expires:now+900});
        if(phase==='connecting'){state.serverStatus='pending';state.authStatus='not_started';}
        if(phase==='authenticating'){state.serverStatus='reachable';state.authStatus='pending';}
        if(phase==='profile'){state.serverStatus='reachable';state.authStatus='verified';state.profileStatus='pending';}
        if(phase==='synchronizing'){state.serverStatus='reachable';state.authStatus='verified';state.profileStatus='loaded';state.syncStatus='pending';}
        if(phase==='dashboard'){state.serverStatus='reachable';state.authStatus='verified';state.profileStatus='loaded';state.syncStatus='complete';state.dashboardStatus='pending';}
        connections.set(attemptKey,state);
      }
    };
    const failed=async(message:string,details:{category:string;operation?:string|null;apiErrorCode?:string|null;httpStatus?:number;authRejected?:boolean;notify?:boolean})=>{
      recordFailure({category:details.category,message,operation:details.operation,apiErrorCode:details.apiErrorCode});
      const state=attemptKey?connections.get(attemptKey):null;
      if(state){state.status='failed';state.error=message;state.label='Connection stopped at this step.';state.diagnosticId=diagnosticId??undefined;
        if(currentStage==='connecting')state.serverStatus='unavailable';
        if(currentStage==='authenticating')state.authStatus=details.authRejected?'rejected':'unknown';
        if(currentStage==='profile')state.profileStatus='unavailable';
        if(currentStage==='synchronizing')state.syncStatus='failed';
        if(currentStage==='dashboard')state.dashboardStatus='failed';}
      if(details.notify)await notifyOwner({stage:currentStage,failureCategory:details.category,operation:details.operation,apiErrorCode:details.apiErrorCode,httpStatus:details.httpStatus,userMessage:message,syncCoverage:currentStage==='synchronizing'||currentStage==='dashboard'?'failed':'not started'});
    };
    activeConnections.add(student.id);
    const hasSavedData=!!(student.moodleCipher||student.lastSyncAt!==null);let sessionToken='';
    const execute=async()=>{try {
      report('connecting');
      await moodle.checkReachable?.();
      report('authenticating');
      sessionToken=credentials.token?.trim()??'';
      if (!sessionToken) {
        if (!credentials.username?.trim() || !credentials.password){const message='Enter your Moodle username and password in the Telegram sign-in window.';await failed(message,{category:'credentials_missing'});return {code:400,body:{error:message}};}
        try{sessionToken=await moodle.login(credentials.username,credentials.password);}catch(error){if(error instanceof MoodleError&&!error.operation)error.operation='login_token';throw error;}finally{credentials.password='';}
      }
      const stateBefore=attemptKey?connections.get(attemptKey):null;if(stateBefore){stateBefore.authStatus='verified';stateBefore.label='Moodle sign-in accepted.';}
      const warnings=await service.connect(linkToken,sessionToken,report,!request.body.telegramConversation);
      try{service.clearConnectionDisplayName?.(student.id);}catch{}
      const state=attemptKey?connections.get(attemptKey):null;
      if(warnings.length){
        if(diagnosticId!==null){recordFailure({status:'partial',category:'partial_coverage',message:`Moodle connection saved with ${warnings.length} coverage limitation${warnings.length===1?'':'s'}.`},'synchronizing');}
        if(state){state.percent=100;state.status='partial';state.serverStatus='reachable';state.authStatus='verified';state.profileStatus='loaded';state.syncStatus='partial';state.dashboardStatus='prepared';state.label='Connected with limited Moodle coverage.';state.coverageWarnings=warnings.slice(0,12);state.diagnosticId=diagnosticId??undefined;state.expires=now+1200;}
        await notifyOwner({stage:'synchronizing',failureCategory:'partial_coverage',coverageWarningCount:warnings.length,userMessage:'Moodle account connected, but some optional information is unavailable. The available dashboard data was saved.',syncCoverage:'partial'});
        return {code:200,body:{ok:true,partial:true}};
      }
      if(diagnosticId!==null){try{store.completeConnectionAttempt(diagnosticId);}catch{request.log.error({event:'connection_diagnostic_write_failed',step:'complete'},'Connection diagnostic could not be stored');}}
      if(state){state.percent=100;state.status='complete';state.serverStatus='reachable';state.authStatus='verified';state.profileStatus='loaded';state.syncStatus='complete';state.dashboardStatus='prepared';state.label='You’re connected.';state.expires=now+1200;}
      return {code:200,body:{ok:true}};
    } catch(error) {
      store.metric('connection_failure');
      const moodleError=error instanceof MoodleError?error:null;
      const category=moodleError?.reason??'unexpected';
      let message:string;
      if(currentStage==='connecting'&&moodleError?.httpStatus===429)message='Moodle is temporarily limiting requests. Your username and password have not been checked. Wait a little, then try again.';
      else if(currentStage==='connecting'&&moodleError?.reason==='network'&&moodleError.apiErrorCode==='timeout')message='The Moodle availability check timed out. Your username and password have not been checked. Try again later.';
      else if(currentStage==='connecting'&&moodleError?.reason==='network')message='Could not reach Moodle. Your username and password have not been checked. Try again when Moodle is available.';
      else if(currentStage==='connecting')message='Moodle responded, but its sign-in page could not be opened at this site address. Your credentials have not been checked. Verify the Moodle address or contact support.';
      else if(currentStage==='authenticating'&&moodleError?.reason==='authentication'&&moodleError.apiErrorCode==='invalidlogin')message='Moodle rejected the supplied username or password. Check them and try again.';
      else if(currentStage==='authenticating'&&moodleError?.apiErrorCode&&/additional_authentication|forcepasswordchange|usernotfullysetup|captcha|multifactor|twofactor|otp/i.test(moodleError.apiErrorCode))message='Moodle requires an additional verification step, such as MFA, CAPTCHA, or a password change, that this bot cannot complete. Contact university support; your credentials were not bypassed.';
      else if(currentStage==='authenticating'&&moodleError?.apiErrorCode==='invalid_response')message='Moodle returned an unexpected response from its sign-in service. Your credentials have not been classified as incorrect. Try again later or contact support.';
      else if(currentStage==='authenticating'&&moodleError?.httpStatus===429)message='Moodle is temporarily limiting sign-in requests. Your credentials may not have been checked. Wait a little, then try again.';
      else if(currentStage==='authenticating'&&moodleError?.reason==='network'&&moodleError.apiErrorCode==='timeout')message='Moodle did not respond in time to verify your sign-in. Your credentials have not been confirmed. Try again later.';
      else if(currentStage==='authenticating'&&moodleError?.reason==='network')message='Could not contact Moodle to verify your sign-in. This does not mean your credentials are wrong; try again later.';
      else if(currentStage==='authenticating')message='Moodle could not complete sign-in. Check your Moodle account and mobile web service access, then try again.';
      else if(currentStage==='profile')message='Moodle accepted your sign-in, but the required profile or account access could not be loaded. Your credentials were not rejected. Try again later or contact university IT.';
      else if(currentStage==='synchronizing')message=`Moodle accepted your sign-in, but required course and assignment data could not be synchronized. ${hasSavedData?'Your previous saved data is preserved.':'No dashboard data was saved.'} Try again later or contact university IT.`;
      else message=`Moodle accepted your sign-in and data was loaded, but the dashboard could not be saved. ${hasSavedData?'Your previous saved data is preserved.':'No dashboard data was saved.'} Please try again later.`;
      const authRejected=currentStage==='authenticating'&&moodleError?.reason==='authentication'&&moodleError.apiErrorCode==='invalidlogin';
      const notify=!!moodleError&&(moodleError.reason!=='authentication'||currentStage!=='authenticating')||!moodleError;
      await failed(message,{category,operation:moodleError?.operation,apiErrorCode:moodleError?.apiErrorCode,httpStatus:moodleError?.httpStatus,authRejected,notify});
      const code=moodleError?.reason==='network'?503:400;
      return {code,body:{error:message,...(moodleError?.reason?{code:moodleError.reason}:{}),...(diagnosticId!==null&&notify?{diagnosticId}:{} )}};
    } finally {
      clearCredentials();sessionToken='';activeConnections.delete(student.id);
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
