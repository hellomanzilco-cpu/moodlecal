import type { MessageOptions, Messenger } from './types.ts';
import {boundedBody} from './limits.ts';

export class TelegramError extends Error {
  readonly retryAfter: number | undefined;
  readonly statusCode: number | undefined;
  constructor(message: string, retryAfter?: number, statusCode?: number) {
    super(message);
    this.name = 'TelegramError';
    this.retryAfter = retryAfter;
    this.statusCode = statusCode;
  }
}

/** Telegram counts UTF-16 units. Never split a Unicode surrogate pair. */
export function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 4000) {
    let end = 4000;
    const newline = remaining.lastIndexOf('\n', end - 1);
    if (newline >= 2000) end = newline + 1;
    const last = remaining.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class TelegramClient implements Messenger {
  private token: string;
  private fetcher: typeof fetch;
  private queues=new Map<number,Promise<void>>();
  private lastGlobal = 0;
  private lastChat = new Map<number, number>();
  private onProgress:()=>void;

  constructor(token: string, fetcher: typeof fetch = fetch, onProgress:()=>void=()=>{}) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Set a valid TELEGRAM_BOT_TOKEN.');
    this.token = token;
    this.fetcher = fetcher;
    this.onProgress=onProgress;
  }

  private result(data:unknown,response:Response,message:string):Record<string,unknown>{
    const result=data&&typeof data==='object'&&!Array.isArray(data)?data as Record<string,unknown>:{};
    if(!response.ok||result.ok!==true){
      const parameters=result.parameters&&typeof result.parameters==='object'&&!Array.isArray(result.parameters)?result.parameters as Record<string,unknown>:{};
      const retry=parameters.retry_after;
      const retryAfter=typeof retry==='number'&&Number.isInteger(retry)&&retry>0&&retry<=86400?retry:undefined;
      const code=typeof result.error_code==='number'&&Number.isInteger(result.error_code)&&result.error_code>=400&&result.error_code<600?result.error_code:response.status;
      throw new TelegramError(message,retryAfter,code);
    }
    // A health observer must never turn a successful delivery into a retry.
    try{this.onProgress();}catch{/* Delivery already succeeded. */}
    return result;
  }

  private async request(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    let data: unknown;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
      });
      data = JSON.parse((await boundedBody(response,2*1024*1024)).toString('utf8'));
    } catch {
      // Network errors can contain the entire request URL, which contains the bot token.
      throw new TelegramError(`Telegram ${method} request failed.`);
    }
    const result=this.result(data,response,`Telegram ${method} failed (HTTP ${response.status}).`);
    return result.result;
  }

  async send(chatId: number, text: string, options?: MessageOptions): Promise<void> {
    return this.forChat(chatId,async()=>{
      const chunks = splitTelegramText(text);
      for (const [index, chunk] of chunks.entries()) {
        await this.slot(chatId);
        await this.request('sendMessage', { chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true }, ...(index === chunks.length - 1 && options?.reply_markup ? { reply_markup: options.reply_markup } : {}) });
      }
    });
  }
  private async forChat(chatId:number,action:()=>Promise<void>):Promise<void>{
    const work=(this.queues.get(chatId)||Promise.resolve()).then(action);
    const tail=work.catch(()=>{});this.queues.set(chatId,tail);
    try{await work;}finally{if(this.queues.get(chatId)===tail)this.queues.delete(chatId);}
  }
  private async slot(chatId:number):Promise<void>{
    const chatWait=(this.lastChat.get(chatId)||0)+1000-Date.now();if(chatWait>0)await new Promise(resolve=>setTimeout(resolve,chatWait));
    const at=Math.max(Date.now(),this.lastGlobal+40);this.lastGlobal=at;
    if(at>Date.now())await new Promise(resolve=>setTimeout(resolve,at-Date.now()));
    this.lastChat.set(chatId,Date.now());
    if(this.lastChat.size>5000)for(const [id,time]of this.lastChat)if(time<Date.now()-60000)this.lastChat.delete(id);
  }

  async getUpdates(offset: number, signal?: AbortSignal): Promise<unknown[]> {
    const result = await this.request('getUpdates', { offset, timeout: 25, limit: 100, allowed_updates: ['message'] }, signal);
    if (!Array.isArray(result)) throw new TelegramError('Telegram returned invalid updates.');
    return result;
  }
  async sendDocument(chatId:number,name:string,bytes:Buffer,caption:string):Promise<void>{
    if(bytes.length>20*1024*1024)throw new TelegramError('File exceeds the bot transfer limit.');
    return this.forChat(chatId,async()=>{
      await this.slot(chatId);
      const form=new FormData();form.set('chat_id',String(chatId));form.set('caption',caption.slice(0,900).toWellFormed());form.set('document',new Blob([new Uint8Array(bytes)],{type:'application/octet-stream'}),name);
      try{const response=await this.fetcher(`https://api.telegram.org/bot${this.token}/sendDocument`,{method:'POST',redirect:'error',body:form,signal:AbortSignal.timeout(60000)});const data:unknown=JSON.parse((await boundedBody(response,1024*1024)).toString('utf8'));this.result(data,response,'Telegram could not deliver this file.');}
      catch(error){if(error instanceof TelegramError)throw error;throw new TelegramError('Telegram file delivery was interrupted.');}
    });
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    if (new URL(url).protocol !== 'https:') throw new Error('Telegram webhook must use HTTPS.');
    await this.request('setWebhook', { url, secret_token: secret, allowed_updates: ['message'] });
  }

  async getWebhookInfo(): Promise<{ url: string }> {
    const result = await this.request('getWebhookInfo', {});
    if (!result || typeof result !== 'object' || !('url' in result) || typeof result.url !== 'string') throw new TelegramError('Telegram returned invalid webhook information.');
    return { url: result.url };
  }
}
