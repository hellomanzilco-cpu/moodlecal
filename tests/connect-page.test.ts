import test from 'node:test';
import assert from 'node:assert/strict';
import {createContext,Script} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {connectionPage} from '../src/connect-page.ts';

// Execute the rendered inline scripts so expiry/retry tests exercise the actual UI logic.
class Element {
  hidden=false;value='';checked=false;type='';textContent='';className='';focused=false;
  dataset:Record<string,string>={};attributes:Record<string,string>={};
  listeners=new Map<string,()=>unknown>();properties=new Map<string,string>();
  style={setProperty:(key:string,value:string)=>this.properties.set(key,value)};
  classList={add:(name:string)=>{this.className+=' '+name;},contains:(name:string)=>this.className.split(' ').includes(name)};
  setAttribute(key:string,value:string){this.attributes[key]=value;}
  addEventListener(event:string,handler:()=>unknown){this.listeners.set(event,handler);}
  focus(){this.focused=true;}
  reportValidity(){return true;}
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function settle(){await turn();await turn();}
function fixture(responder:(path:string,body:Record<string,unknown>)=>Response|Promise<Response>,token:string|null='a'.repeat(43)) {
  const html=connectionPage('nonce','https://moodle.uwed.uz');
  const elements=new Map<string,Element>();
  for(const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){
    const element=new Element();element.hidden=/\bhidden\b/.test(match[0]);element.type=/\btype="([^"]+)"/.exec(match[0])?.[1]??'';elements.set(match[1],element);
  }
  const steps=['connecting','authenticating','profile','synchronizing','dashboard'].map(phase=>{const element=new Element();element.dataset.phase=phase;return element;});
  const bar=new Element(),sent:string[]=[],requests:{path:string;body:Record<string,unknown>}[]=[];
  const location={hash:token?'#token='+token:'',assign:(url:string)=>sent.push(url)};
  const app={initData:'',platform:'ios',ready(){},expand(){},close(){sent.push('close');},sendData(data:string){sent.push(data);}};
  const context=createContext({window:{Telegram:{WebApp:app}},document:{getElementById:(id:string)=>elements.get(id),querySelector:()=>bar,querySelectorAll:()=>steps},location,history:{replaceState(){}},URLSearchParams,AbortSignal,crypto:webcrypto,Uint8Array,btoa,setTimeout:(callback:()=>void)=>{callback();return 1;},fetch:async(path:string,options:{body:string})=>{const body=JSON.parse(options.body);requests.push({path,body});return responder(path,body);}});
  for(const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Script(script[1]).runInContext(context);
  const element=(id:string)=>elements.get(id)!;
  const click=async(id:string)=>{await element(id).listeners.get('click')?.();await settle();};
  const submit=async()=>{const handler=element('form').listeners.get('submit') as unknown as (event:{preventDefault():void})=>Promise<void>;await handler({preventDefault(){}});await settle();};
  const credentials=()=>{element('username').value='  test.student  ';element('password').value='secret-password';element('consent').checked=true;};
  return {element,click,submit,credentials,requests,sent,steps,bar,html};
}

test('expired and missing links show button recovery before any credentials are sent',async()=>{
  const f=fixture(()=>Response.json({code:'connection_expired'},{status:410}));await settle();
  assert.equal(f.element('form').hidden,true);assert.equal(f.element('fresh-link').hidden,false);
  assert.match(f.element('result').textContent,/expired/);assert.equal(f.requests.length,1);
  assert.deepEqual(Object.keys(f.requests[0].body),['linkToken']);
  await f.click('fresh-link');assert.deepEqual(f.sent,['{"action":"refresh_connection"}']);
  const missing=fixture(()=>{throw new Error('No network access expected');},null);await settle();
  assert.equal(missing.requests.length,0);assert.equal(missing.element('form').hidden,true);assert.equal(missing.element('fresh-link').hidden,false);
});

test('a link expiring while the student types prevents the credential request and clears the password',async()=>{
  let checks=0;
  const f=fixture(()=>++checks===1?Response.json({ok:true}):Response.json({code:'connection_expired'},{status:410}));await settle();
  f.credentials();await f.click('show-password');assert.equal(f.element('password').type,'text');
  await f.submit();assert.equal(f.element('password').value,'');assert.equal(f.element('password').type,'password');
  assert.ok(f.requests.every(request=>request.path==='/api/connect/check'));assert.equal(f.element('form').hidden,true);
});

test('verified link reveals the short form; a failed Moodle check never shows a successful connection',async()=>{
  const f=fixture(path=>{
    if(path==='/api/connect/check')return Response.json({ok:true});
    if(path==='/api/connect')return Response.json({accepted:true},{status:202});
    return Response.json({status:'failed',percent:65,label:'Status check failed',serverStatus:'reachable',authStatus:'verified',profileStatus:'loaded',syncStatus:'failed',dashboardStatus:'not_started',error:'Moodle could not verify submission status.',diagnosticId:23});
  });await settle();assert.equal(f.element('form').hidden,false);
  f.credentials();await f.click('show-password');assert.equal(f.element('password').type,'text');
  assert.equal(f.element('show-password').attributes['aria-pressed'],'true');
  await f.submit();assert.equal(f.element('password').value,'');assert.equal(f.element('password').type,'password');
  const writes=f.requests.filter(request=>request.path==='/api/connect');assert.equal(writes.length,1);
  assert.equal(writes[0].body.username,'test.student');assert.equal(writes[0].body.password,'secret-password');assert.equal(writes[0].body.consent,true);
  assert.match(f.element('result').textContent,/could not verify submission status/);assert.match(f.element('result').textContent,/CONN-23/);
  assert.equal(f.element('progress').classList.contains('failure'),true);assert.equal(f.element('progress').classList.contains('success'),false);
  assert.equal(f.steps[3].className,'failed');assert.equal(f.element('liquid').properties.get('--level'),'65%');
  await f.click('retry');assert.equal(f.element('form').hidden,false);assert.equal(f.element('username').value,'  test.student  ');
  assert.equal(f.element('password').focused,true);assert.equal(f.requests.filter(request=>request.path==='/api/connect').length,1);
});

test('an interrupted start checks the same attempt result and opens the dashboard only after confirmed completion',async()=>{
  const f=fixture(path=>{
    if(path==='/api/connect/check')return Response.json({ok:true});
    if(path==='/api/connect')throw new Error('Lost HTTP response');
    return Response.json({status:'complete',percent:100,label:'Connected',serverStatus:'reachable',authStatus:'verified',profileStatus:'loaded',syncStatus:'complete',dashboardStatus:'prepared'});
  });await settle();f.credentials();await f.submit();
  assert.equal(f.requests.filter(request=>request.path==='/api/connect').length,1);
  const start=f.requests.find(request=>request.path==='/api/connect')!,status=f.requests.find(request=>request.path==='/api/connect/status')!;
  assert.equal(start.body.attemptId,status.body.attemptId);
  assert.equal(f.element('progress').classList.contains('success'),true);assert.equal(f.element('retry').hidden,true);
  assert.equal(f.element('return').textContent,'✅ Open my dashboard');
  await f.click('return');assert.deepEqual(f.sent,['{"action":"connected"}']);
});

test('offline preflight retries locally without sending credentials or accepting missing consent',async()=>{
  let offline=true;
  const f=fixture(()=>{if(offline)throw new Error('offline');return Response.json({ok:true});});await settle();
  assert.equal(f.element('form').hidden,true);assert.match(f.element('link-status').textContent,/credentials have not been sent/);
  offline=false;await f.click('retry');assert.equal(f.element('form').hidden,false);
  f.credentials();f.element('form').reportValidity=()=>false;await f.submit();
  assert.ok(f.requests.every(request=>request.path==='/api/connect/check'));
});

test('limited Moodle results remain amber and show the actual coverage warning',async()=>{
  const f=fixture(path=>{
    if(path==='/api/connect/check')return Response.json({ok:true});
    if(path==='/api/connect')return Response.json({accepted:true},{status:202});
    return Response.json({status:'partial',percent:100,label:'Limited coverage',serverStatus:'reachable',authStatus:'verified',profileStatus:'loaded',syncStatus:'partial',dashboardStatus:'prepared',coverageWarnings:['Quiz attempts are unavailable.'],diagnosticId:7});
  });await settle();f.credentials();await f.submit();
  assert.equal(f.element('progress').classList.contains('partial'),true);assert.equal(f.element('progress').classList.contains('success'),false);
  assert.match(f.element('result').textContent,/Quiz attempts are unavailable/);assert.match(f.element('result').textContent,/CONN-7/);
  assert.equal(f.steps[3].className,'partial');
});
