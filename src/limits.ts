import {AsyncLocalStorage} from 'node:async_hooks';

const budgets=new AsyncLocalStorage<AbortSignal>();
export function withDeadline<T>(milliseconds:number,work:()=>Promise<T>):Promise<T>{
  const parent=budgets.getStore(),own=AbortSignal.timeout(milliseconds);
  return budgets.run(parent?AbortSignal.any([parent,own]):own,work);
}
export function requestSignal(milliseconds:number):AbortSignal{
  const parent=budgets.getStore(),own=AbortSignal.timeout(milliseconds);
  return parent?AbortSignal.any([parent,own]):own;
}
export class CapacityError extends Error{}
interface Waiter {resolve:()=>void;reject:(error:Error)=>void;signal?:AbortSignal;abort?:()=>void}
export class ConcurrencyGate{
  private active=0;private waiting:Waiter[]=[];private maximum:number;private backlog:number;
  constructor(maximum:number,backlog=64){this.maximum=maximum;this.backlog=backlog;}
  private acquire(signal?:AbortSignal):Promise<void>{
    if(signal?.aborted)return Promise.reject(new Error('Operation timed out.'));
    if(this.active<this.maximum){this.active++;return Promise.resolve();}
    if(this.waiting.length>=this.backlog)return Promise.reject(new CapacityError('Service is busy. Please try again shortly.'));
    return new Promise((resolve,reject)=>{
      const waiter:Waiter={resolve,reject,signal};
      waiter.abort=()=>{const index=this.waiting.indexOf(waiter);if(index>=0)this.waiting.splice(index,1);reject(new Error('Operation timed out.'));};
      this.waiting.push(waiter);signal?.addEventListener('abort',waiter.abort,{once:true});
    });
  }
  private release():void{
    const next=this.waiting.shift();
    if(next){if(next.abort)next.signal?.removeEventListener('abort',next.abort);next.resolve();}else this.active--;
  }
  async run<T>(work:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    await this.acquire(signal);try{signal?.throwIfAborted();return await work();}finally{this.release();}
  }
}
export async function mapConcurrent<T,R>(items:T[],maximum:number,work:(item:T)=>Promise<R>):Promise<R[]>{
  const results:R[]=new Array(items.length);let index=0,failed=false;
  const workers=Array.from({length:Math.min(maximum,items.length)},async()=>{
    while(!failed&&index<items.length){const current=index++;try{results[current]=await work(items[current]);}catch(error){failed=true;throw error;}}
  });
  const settled=await Promise.allSettled(workers),failure=settled.find(result=>result.status==='rejected');
  if(failure?.status==='rejected')throw failure.reason;
  return results;
}
export async function boundedBody(response:Response,maximum:number):Promise<Buffer>{
  if(Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();throw new CapacityError('The upstream response exceeds the size limit.');}
  if(!response.body)return Buffer.alloc(0);
  const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;
  try{while(true){const value=await reader.read();if(value.done)break;size+=value.value.byteLength;if(size>maximum){await reader.cancel();throw new CapacityError('The upstream response exceeds the size limit.');}chunks.push(Buffer.from(value.value));}}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks);
}
