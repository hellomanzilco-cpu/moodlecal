import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { newSecret } from './security.ts';
import type { ConnectionState } from './connection-progress.ts';

export interface TelegramConnectionOutcome {
  status:'complete'|'partial'|'failed'|'unknown';
  error?:string;
  diagnosticId?:number;
  state?:ConnectionState;
}

export type TelegramConnectionRunner=(
  studentId:number,
  username:string,
  password:string,
  onProgress:(state:ConnectionState)=>Promise<void>|void,
)=>Promise<TelegramConnectionOutcome>;

export function createTelegramConnectionRunner(
  app:FastifyInstance,
  connectionToken:(studentId:number)=>string,
  publicUrl:string,
  pollMilliseconds=400,
):TelegramConnectionRunner {
  const origin=new URL(publicUrl).origin;
  return async(studentId,username,password,onProgress)=>{
    const linkToken=connectionToken(studentId);
    const attemptId=newSecret();
    const payload:{linkToken:string;attemptId:string;asyncMode:boolean;username:string;password:string;consent:boolean;telegramConversation:boolean}={
      linkToken,attemptId,asyncMode:true,username,password,consent:true,telegramConversation:true,
    };
    let start;
    try {
      start=await app.inject({method:'POST',url:'/api/connect',headers:{origin},payload});
    } finally {
      payload.username='';
      payload.password='';
      username='';
      password='';
    }
    if(start.statusCode!==202){
      const body=start.json() as {error?:unknown;diagnosticId?:unknown};
      return {
        status:'failed',
        error:typeof body.error==='string'?body.error:'The Moodle connection could not be started. Try again from Telegram.',
        ...(typeof body.diagnosticId==='number'?{diagnosticId:body.diagnosticId}:{}),
      };
    }

    const deadline=Date.now()+180_000;
    while(Date.now()<deadline){
      await delay(pollMilliseconds);
      const response=await app.inject({
        method:'POST',url:'/api/connect/status',headers:{origin},payload:{linkToken,attemptId},
      });
      if(response.statusCode!==200)return {status:'unknown',error:'The connection result could not be confirmed. This does not mean Moodle rejected your sign-in. Tap Status in Settings before retrying.'};
      const state=response.json() as ConnectionState;
      try{await onProgress(state);}catch{/* A Telegram message edit failure must not interrupt Moodle connection work. */}
      if(state.status==='complete'||state.status==='partial')return {status:state.status,state,...(state.diagnosticId?{diagnosticId:state.diagnosticId}:{})};
      if(state.status==='failed')return {status:'failed',state,error:state.error,...(state.diagnosticId?{diagnosticId:state.diagnosticId}:{})};
    }
    return {status:'unknown',error:'The connection result could not be confirmed in time. This does not mean Moodle rejected your sign-in. Tap Status in Settings before retrying.'};
  };
}
