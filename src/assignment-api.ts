import multipart from '@fastify/multipart';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {newSecret} from './security.ts';
import {AssignmentError,MAX_UPLOAD_BYTES,MAX_UPLOAD_FILES,parseSubmissionRequest,publicAssignment} from './assignments.ts';
import type {AssignmentService,PortalSession,SubmissionOperation} from './assignments.ts';
import type {Config} from './config.ts';
import type {SubmissionFile} from './types.ts';
import {MoodleError} from './moodle.ts';
import {assignmentPage} from './assignment-page.ts';
export function publicOperation(operation:SubmissionOperation|null){if(!operation)return null;const {id,state,stage,message,updatedAt}=operation;return {id,state,stage,message,updatedAt};}
export function registerAssignmentRoutes(app:FastifyInstance,config:Config,service:AssignmentService){
 app.get('/assignment',async(_request,reply)=>{const nonce=newSecret();reply.removeHeader('X-Frame-Options').header('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}' https://telegram.org; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org`);return reply.type('text/html; charset=utf-8').send(assignmentPage(nonce));});
 app.register(async routes=>{
  await routes.register(multipart,{limits:{fileSize:MAX_UPLOAD_BYTES,files:MAX_UPLOAD_FILES,fields:1,parts:MAX_UPLOAD_FILES+1,fieldSize:150000}});
  const sessions=new WeakMap<FastifyRequest,PortalSession>(),rates=new Map<string,{count:number;until:number}>();let uploads=0;
  routes.setErrorHandler((error,_request,reply)=>{if(error instanceof AssignmentError)return reply.code(error.status).send({error:error.message});if(error instanceof MoodleError)return reply.code(error.reason==='network'?503:400).send({error:error.message});return reply.code(400).send({error:'The request could not be completed. Check your file sizes, formats and assignment requirements.'});});
  routes.addHook('preHandler',async(request)=>{
   if(request.headers.origin!==new URL(config.publicUrl).origin)throw new AssignmentError('Open the private assignment window from Telegram.',403);
   const header=request.headers.authorization;if(typeof header!=='string'||!header.startsWith('Bearer '))throw new AssignmentError('Open a fresh assignment button in Telegram.',401);
   const session=service.session(header.slice(7));sessions.set(request,session);
   const bucket=request.url.endsWith('/verify')||request.url.endsWith('/release')?'verify':request.url.includes('/operations/')?'progress':request.url.endsWith('/file')?'file':request.url.endsWith('/submit')?'submit':'detail';
   const now=Date.now();for(const [key,rate]of rates)if(rate.until<now)rates.delete(key);
   const key=session.student.id+':'+bucket,rate=rates.get(key)||{count:0,until:now+60000};if(++rate.count>(bucket==='progress'?120:bucket==='submit'?5:bucket==='file'?8:15))throw new AssignmentError('Please wait a moment before trying again.',429);rates.set(key,rate);
  });
  const session=(request:FastifyRequest)=>sessions.get(request)!;
  routes.post('/detail',async request=>{const auth=session(request),detail=await service.detail(auth);return {detail:publicAssignment(detail,auth.student.timezone),operation:publicOperation(service.latest(auth))};});
  routes.post<{Body:{fileId:string;toTelegram:boolean}}>('/file',{schema:{body:{type:'object',additionalProperties:false,required:['fileId','toTelegram'],properties:{fileId:{type:'string',pattern:'^[a-f0-9]{64}$'},toTelegram:{type:'boolean'}}}}},async(request,reply)=>{
   const {file,bytes}=await service.file(session(request),request.body.fileId,request.body.toTelegram);if(request.body.toTelegram)return {ok:true};
   return reply.type('application/octet-stream').header('Content-Disposition',`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g,'%27')}`).send(bytes);
  });
  routes.post('/submit',async(request,reply)=>{
   if(uploads>=2)throw new AssignmentError('Uploads are busy. Please try again shortly.',429);uploads++;
   const files:SubmissionFile[]=[];let accepted=false;
   try{let meta:unknown=null,total=0;for await(const part of request.parts()){
    if(part.type==='file'){if(part.fieldname!=='files')throw new AssignmentError('Unexpected upload field.');const bytes=await part.toBuffer();total+=bytes.length;if(total>MAX_UPLOAD_BYTES)throw new AssignmentError('The total upload limit is 20 MiB.',413);files.push({name:part.filename,mime:part.mimetype,bytes});}
    else {if(part.fieldname!=='metadata'||meta!==null||typeof part.value!=='string')throw new AssignmentError('Submission review metadata is missing or repeated.');try{meta=JSON.parse(part.value);}catch{throw new AssignmentError('Submission review metadata is invalid.');}}
   }
   const requestData=parseSubmissionRequest(meta);const existing=service.operation(session(request),requestData.operationId);const operation=existing||service.start(session(request),requestData,files);accepted=!existing;
   return reply.code(202).send({operation:publicOperation(operation)});
   }finally{uploads--;if(!accepted)for(const file of files)file.bytes.fill(0);}
  });
  routes.post<{Params:{id:string}}>('/operations/:id',async(request,reply)=>{const operation=service.operation(session(request),request.params.id);if(!operation)return reply.code(404).send({error:'Submission receipt not found.'});return {operation:publicOperation(operation)};});
  routes.post<{Params:{id:string}}>('/operations/:id/verify',async request=>({operation:publicOperation(await service.verify(session(request),request.params.id))}));
  routes.post<{Params:{id:string};Body:{confirmedNotSubmitted:boolean}}>('/operations/:id/release',{schema:{body:{type:'object',additionalProperties:false,required:['confirmedNotSubmitted'],properties:{confirmedNotSubmitted:{type:'boolean',const:true}}}}},async request=>({operation:publicOperation(await service.release(session(request),request.params.id,request.body.confirmedNotSubmitted))}));
 },{prefix:'/api/assignment'});
}
