import test from 'node:test';
import assert from 'node:assert/strict';
import {ConcurrencyGate,boundedBody,mapConcurrent,requestSignal,withDeadline} from '../src/limits.ts';
import {MoodleClient,MoodleError,moodleText} from '../src/moodle.ts';
import {RuntimeHealth} from '../src/runtime-health.ts';

test('upstream streaming bodies are cancelled at byte limits, including oversized headers',async()=>{
  let cancelled=false,pulls=0;
  const stream=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(1024));},cancel(){cancelled=true;}});
  await assert.rejects(boundedBody(new Response(stream),2048),/size limit/);assert.equal(cancelled,true);assert.ok(pulls<=5);
  cancelled=false;
  const headers=new ReadableStream({cancel(){cancelled=true;}});
  await assert.rejects(boundedBody(new Response(headers,{headers:{'content-length':'99999'}}),1024),/size limit/);assert.equal(cancelled,true);
});

test('network capacity bounds both in-flight work and backlog; cancelled waiters do not hold slots',async()=>{
  const gate=new ConcurrencyGate(1,1);let release!:()=>void;
  const first=gate.run(()=>new Promise<void>(resolve=>{release=resolve;}));await Promise.resolve();
  const controller=new AbortController(),second=gate.run(async()=>{},controller.signal);
  await assert.rejects(gate.run(async()=>{}),/busy/);controller.abort();await assert.rejects(second,/timed out/);
  let completed=false;const next=gate.run(async()=>{completed=true;});release();await Promise.all([first,next]);assert.equal(completed,true);
});

test('a single operation deadline covers queued and successive upstream requests',async()=>{
  let aborted=false;
  const keepAlive=setTimeout(()=>{},100);
  try{await withDeadline(10,async()=>{const signal=requestSignal(1000);await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));assert.equal(requestSignal(1000).aborted,true);});}
  finally{clearTimeout(keepAlive);}assert.equal(aborted,true);
});

test('bounded parallel work preserves ordering and stops starting work after a failure',async()=>{
  let active=0,peak=0;
  const result=await mapConcurrent([1,2,3,4,5,6],3,async value=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return value*2;});
  assert.deepEqual(result,[2,4,6,8,10,12]);assert.equal(peak,3);
  let called=0;await assert.rejects(mapConcurrent([1,2,3,4],1,async()=>{called++;throw new Error('failure');}),/failure/);assert.equal(called,1);
});

test('an unavailable Moodle host opens a short circuit while invalid credentials cannot block other users',async()=>{
  let requests=0;const offline=new MoodleClient('https://moodle.uwed.uz',async()=>{requests++;throw new Error('secret network URL');});
  for(let attempt=0;attempt<3;attempt++)await assert.rejects(offline.identify('private'),MoodleError);
  await assert.rejects(offline.identify('private'),/temporarily unavailable/);assert.equal(requests,3);
  const client=new MoodleClient('https://moodle.uwed.uz',async(_url,options)=>{
    const token=new URLSearchParams(String(options?.body)).get('wstoken');return Response.json(token==='bad'?{errorcode:'invalidtoken'}:{userid:1,fullname:'Student',functions:[{name:'core_enrol_get_users_courses'},{name:'core_course_get_contents'}]});
  });
  for(let attempt=0;attempt<4;attempt++)await assert.rejects(client.identify('bad'),MoodleError);
  assert.equal((await client.identify('good')).userId,1);
});

test('course and submission checks run with bounded parallelism instead of one long serial queue',async()=>{
  let active=0,peak=0;
  const assignments=(course:number)=>Array.from({length:8},(_,index)=>({id:course*100+index+1,cmid:course*100+index+1001,name:'Task',duedate:2_000_000_000}));
  const client=new MoodleClient('https://moodle.uwed.uz',async(_url,options)=>{
    const name=new URLSearchParams(String(options?.body)).get('wsfunction');
    if(name==='core_webservice_get_site_info')return Response.json({userid:1,fullname:'Student',functions:['core_enrol_get_users_courses','core_course_get_contents','mod_assign_get_assignments','mod_assign_get_submission_status'].map(name=>({name}))});
    if(name==='core_enrol_get_users_courses')return Response.json([1,2,3].map(id=>({id,fullname:'Course',shortname:'C'})));
    if(name==='mod_assign_get_assignments')return Response.json({courses:[1,2,3].map(id=>({id,assignments:assignments(id)})),warnings:[]});
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;
    if(name==='core_course_get_contents'){const course=Number(new URLSearchParams(String(options?.body)).get('courseid'));return Response.json([{modules:assignments(course).map(item=>({id:item.cmid,instance:item.id,name:'Task',modname:'assign',uservisible:true}))}]);}
    if(name==='mod_assign_get_submission_status')return Response.json({lastattempt:{submission:{status:'new'},canedit:true,caneditowner:true,cansubmit:false,graded:false,submissionsenabled:true,locked:false,extensionduedate:0},warnings:[]});
    throw new Error('Unexpected endpoint');
  });
  const snapshot=await client.snapshot('private',1_900_000_000,true);assert.equal(snapshot.items.length,24);assert.ok(peak>1&&peak<=3);
});

test('public academic text cannot carry URL-encoded or fragment credentials to calendar providers',()=>{
  const output=moodleText('Read https://moodle.uwed.uz/file?%74oken=private123&x=2#session=secret456 and https://user:password@example.com/page');
  assert.doesNotMatch(output,/private123|secret456|password/);assert.match(output,/x=2/);
});

test('runtime readiness distinguishes university outages from stalled local workers and stale Telegram responses',t=>{
  let now=1_000_000;t.mock.method(Date,'now',()=>now);const runtime=new RuntimeHealth(true);
  assert.deepEqual(runtime.readiness(),{ready:true});now+=181000;runtime.workerBeat();runtime.inboxBeat();runtime.pollingBeat();assert.equal(runtime.stalled(),false);assert.equal(runtime.readiness().ready,false);
  runtime.pollingBeat(true);assert.equal(runtime.readiness().ready,true);now+=301000;assert.equal(runtime.stalled(),true);assert.equal(runtime.readiness().ready,false);
});
