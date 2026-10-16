import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {hashSecret,newSecret} from '../src/security.ts';
import {assignmentFixture} from './helpers/assignments.ts';
async function multipart(metadata:unknown,name='essay.pdf',bytes=Buffer.from('%PDF-essay')){const form=new FormData();form.set('metadata',JSON.stringify(metadata));form.append('files',new Blob([new Uint8Array(bytes)]),name);const req=new Request('https://planner.test',{method:'POST',body:form});return {headers:{'content-type':req.headers.get('content-type')!},payload:Buffer.from(await req.arrayBuffer())};}
test('assignment window compiles, protects embedding and contains no account secrets; APIs enforce origin and private session',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const page=await f.app.inject({url:'/assignment'});assert.equal(page.statusCode,200);assert.equal(page.headers['x-frame-options'],undefined);assert.match(String(page.headers['content-security-policy']),/frame-ancestors https:\/\/web.telegram.org/);assert.doesNotMatch(page.body,new RegExp(f.raw+'|'+f.token));assert.match(page.body,/Submit for grading/);for(const script of page.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new Script(script[1]));
 const headers={origin:f.config.publicUrl,authorization:'Bearer '+f.raw};
 assert.equal((await f.app.inject({method:'POST',url:'/api/assignment/detail',headers:{authorization:headers.authorization},payload:{}})).statusCode,403);
 assert.equal((await f.app.inject({method:'POST',url:'/api/assignment/detail',headers:{origin:f.config.publicUrl,authorization:'Bearer '+newSecret()},payload:{}})).statusCode,401);
 const response=await f.app.inject({method:'POST',url:'/api/assignment/detail',headers,payload:{}});assert.equal(response.statusCode,200);assert.match(response.body,/teacher-brief.pdf/);assert.doesNotMatch(response.body,/pluginfile.php|private-moodle-token|connectionHash/);
});
test('multipart submission returns immediately, verifies in background, and deduplicates repeat operation',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const meta={operationId:newSecret(),revision:hashSecret('original'),confirm:true,replaceExisting:false,statementAccepted:false},body=await multipart(meta),headers={...body.headers,origin:f.config.publicUrl,authorization:'Bearer '+f.raw};
 const response=await f.app.inject({method:'POST',url:'/api/assignment/submit',headers,payload:body.payload});assert.equal(response.statusCode,202,response.body);assert.equal(response.json().operation.state,'working');await f.service.drain();
 const status=await f.app.inject({method:'POST',url:'/api/assignment/operations/'+meta.operationId,headers:{origin:f.config.publicUrl,authorization:headers.authorization},payload:{}});assert.equal(status.json().operation.state,'submitted');assert.doesNotMatch(status.body,/proof|connectionHash|studentId|private-moodle-token/);
 const duplicate=await f.app.inject({method:'POST',url:'/api/assignment/submit',headers,payload:body.payload});assert.equal(duplicate.statusCode,202);assert.equal(f.calls.filter(c=>c.kind==='save').length,1);
});
test('file downloads are authenticated attachments and Telegram sends are scoped to the connected chat',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());const headers={origin:f.config.publicUrl,authorization:'Bearer '+f.raw};const detail=await f.app.inject({method:'POST',url:'/api/assignment/detail',headers,payload:{}});const fileId=detail.json().detail.attachments[0].id;
 const download=await f.app.inject({method:'POST',url:'/api/assignment/file',headers,payload:{fileId,toTelegram:false}});assert.equal(download.statusCode,200);assert.equal(download.body,'%PDF-');assert.match(String(download.headers['content-disposition']),/attachment/);assert.equal(download.headers['cache-control'],'no-store');
 const send=await f.app.inject({method:'POST',url:'/api/assignment/file',headers,payload:{fileId,toTelegram:true}});assert.equal(send.statusCode,200);assert.equal(f.sent[0].chatId,111);
 assert.equal((await f.app.inject({method:'POST',url:'/api/assignment/file',headers,payload:{fileId:hashSecret('not-in-this-assignment'),toTelegram:false}})).statusCode,404);
});
test('multipart missing explicit confirmation and oversized files never start Moodle writes',async t=>{
 const f=assignmentFixture();t.after(()=>f.close());for(const [meta,bytes] of [[{operationId:newSecret(),revision:hashSecret('original'),confirm:false,replaceExisting:false,statementAccepted:false},Buffer.from('small')],[{operationId:newSecret(),revision:hashSecret('original'),confirm:true,replaceExisting:false,statementAccepted:false},Buffer.alloc(20*1024*1024+1)]] as const){const body=await multipart(meta,'essay.pdf',bytes);const response=await f.app.inject({method:'POST',url:'/api/assignment/submit',headers:{...body.headers,origin:f.config.publicUrl,authorization:'Bearer '+f.raw},payload:body.payload});assert.ok(response.statusCode>=400);}
 assert.equal(f.calls.filter(c=>c.kind==='upload'||c.kind==='save').length,0);
});
