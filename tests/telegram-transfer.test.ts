import test from 'node:test';
import assert from 'node:assert/strict';
import {TelegramClient,TelegramError} from '../src/telegram.ts';

const token='123:fake_secret_bot_token';
const upload=(client:TelegramClient,chatId=101)=>client.sendDocument(chatId,'brief.pdf',Buffer.from('%PDF-'),'Professor brief');

test('document delivery preserves a validated Telegram retry_after and API error code without exposing response details',async()=>{
 const client=new TelegramClient(token,async()=>Response.json({ok:false,error_code:429,description:'sensitive '+token,parameters:{retry_after:37}},{status:503}));
 await assert.rejects(upload(client),error=>error instanceof TelegramError&&error.statusCode===429&&error.retryAfter===37&&!error.message.includes(token)&&!error.message.includes('sensitive'));
 const send=new TelegramClient(token,async()=>Response.json({ok:false,error_code:429,description:token,parameters:{retry_after:37}},{status:503}));
 await assert.rejects(send.send(101,'hello'),error=>error instanceof TelegramError&&error.statusCode===429&&error.retryAfter===37&&!error.message.includes(token));
});

test('document delivery rejects invalid retry/code metadata, malformed bodies and redirects safely',async()=>{
 for(const retry_after of [-1,0,1.5,'30',86401,{},[]]){
  const client=new TelegramClient(token,async()=>Response.json({ok:false,error_code:'403',parameters:{retry_after},description:token},{status:429}));
  await assert.rejects(upload(client),error=>error instanceof TelegramError&&error.retryAfter===undefined&&error.statusCode===429&&!error.message.includes(token));
 }
 for(const response of [new Response(token,{status:500}),Response.json([{ok:true}]),new Response(null,{status:302,headers:{location:'https://example.test/'+token}})]){
  const client=new TelegramClient(token,async()=>response);await assert.rejects(upload(client),error=>error instanceof TelegramError&&!error.message.includes(token));
 }
});

test('oversized document responses are bounded and do not count as successful network progress',async()=>{
 let progress=0,cancelled=false;
 const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled=true;}});
 const client=new TelegramClient(token,async()=>new Response(stream,{headers:{'content-type':'application/json'}}),()=>progress++);
 await assert.rejects(upload(client),error=>error instanceof TelegramError&&!error.message.includes(token));assert.equal(cancelled,true);assert.equal(progress,0);
 const declared=new TelegramClient(token,async()=>new Response('{}',{headers:{'content-length':String(1024*1024+1)}}),()=>progress++);
 await assert.rejects(upload(declared),TelegramError);assert.equal(progress,0);
});

test('real Telegram success envelopes report progress once, reject redirects and observer failures never replay successful delivery',async()=>{
 let progress=0,calls=0;
 const client=new TelegramClient(token,async(input,init)=>{assert.equal(init?.redirect,'error');calls++;return Response.json({ok:true,result:String(input).endsWith('getWebhookInfo')?{url:''}:{}});},()=>{progress++;throw new Error('observer failed');});
 assert.deepEqual(await client.getWebhookInfo(),{url:''});await upload(client);await client.send(202,'hello');
 assert.equal(calls,3);assert.equal(progress,3);
 const failed=new TelegramClient(token,async()=>Response.json({ok:false,error_code:403},{status:403}),()=>progress++);await assert.rejects(upload(failed),TelegramError);assert.equal(progress,3);
});

test('a blocked outgoing chat keeps its order while another chat sends without waiting for it',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const calls:{chatId:number;text:string}[]=[];
 const client=new TelegramClient(token,async(_input,init)=>{const body=JSON.parse(String(init?.body)) as {chat_id:number;text:string};calls.push({chatId:body.chat_id,text:body.text});if(body.text==='first')await gate;return Response.json({ok:true,result:{}});});
 const first=client.send(101,'first'),second=client.send(101,'second'),other=client.send(202,'other');
 try{await other;assert.deepEqual(calls,[{chatId:101,text:'first'},{chatId:202,text:'other'}]);}finally{release();await Promise.allSettled([first,second,other]);}
 assert.deepEqual(calls,[{chatId:101,text:'first'},{chatId:202,text:'other'},{chatId:101,text:'second'}]);
});

test('outgoing transport errors remain sanitized and do not strand the next command in that chat',async()=>{
 let calls=0;const client=new TelegramClient(token,async()=>{calls++;if(calls===1)throw new Error('request to https://api.telegram.org/bot'+token+'/sendMessage failed');return Response.json({ok:true,result:{}});});
 const failed=client.send(101,'first');const next=client.send(101,'second');
 await assert.rejects(failed,error=>error instanceof TelegramError&&!error.message.includes(token));await next;assert.equal(calls,2);
});
