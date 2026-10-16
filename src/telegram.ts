import type { MessageOptions, Messenger } from './types.ts';

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
  private queue: Promise<void> = Promise.resolve();
  private lastGlobal = 0;
  private lastChat = new Map<number, number>();

  constructor(token: string, fetcher: typeof fetch = fetch) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Set a valid TELEGRAM_BOT_TOKEN.');
    this.token = token;
    this.fetcher = fetcher;
  }

  private async request(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    let data: unknown;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
      });
      data = await response.json();
    } catch {
      // Network errors can contain the entire request URL, which contains the bot token.
      throw new TelegramError(`Telegram ${method} request failed.`);
    }
    const result = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (!response.ok || result.ok !== true) {
      const parameters = result.parameters && typeof result.parameters === 'object' ? result.parameters as Record<string, unknown> : {};
      const retry = parameters.retry_after;
      const retryAfter = typeof retry === 'number' && Number.isInteger(retry) && retry > 0 && retry <= 86400 ? retry : undefined;
      const code = typeof result.error_code === 'number' && Number.isInteger(result.error_code) && result.error_code >= 400 && result.error_code < 600 ? result.error_code : response.status;
      throw new TelegramError(`Telegram ${method} failed (HTTP ${response.status}).`, retryAfter, code);
    }
    return result.result;
  }

  async send(chatId: number, text: string, options?: MessageOptions): Promise<void> {
    const work = this.queue.then(async () => {
      const chunks = splitTelegramText(text);
      for (const [index, chunk] of chunks.entries()) {
        const wait = Math.max(this.lastGlobal + 40, (this.lastChat.get(chatId) ?? 0) + 1000) - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        const sentAt = Date.now();
        this.lastGlobal = sentAt;
        this.lastChat.set(chatId, sentAt);
        await this.request('sendMessage', { chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true }, ...(index === chunks.length - 1 && options?.reply_markup ? { reply_markup: options.reply_markup } : {}) });
      }
    });
    this.queue = work.catch(() => {});
    await work;
  }

  async getUpdates(offset: number, signal?: AbortSignal): Promise<unknown[]> {
    const result = await this.request('getUpdates', { offset, timeout: 25, limit: 100, allowed_updates: ['message'] }, signal);
    if (!Array.isArray(result)) throw new TelegramError('Telegram returned invalid updates.');
    return result;
  }
  async sendDocument(chatId:number,name:string,bytes:Buffer,caption:string):Promise<void>{
    if(bytes.length>20*1024*1024)throw new TelegramError('File exceeds the bot transfer limit.');
    const work=this.queue.then(async()=>{
      const wait=Math.max(this.lastGlobal+40,(this.lastChat.get(chatId)??0)+1000)-Date.now();if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));this.lastGlobal=Date.now();this.lastChat.set(chatId,this.lastGlobal);
      const form=new FormData();form.set('chat_id',String(chatId));form.set('caption',caption.slice(0,900).toWellFormed());form.set('document',new Blob([new Uint8Array(bytes)],{type:'application/octet-stream'}),name);
      try{const response=await this.fetcher(`https://api.telegram.org/bot${this.token}/sendDocument`,{method:'POST',body:form,signal:AbortSignal.timeout(60000)});const data=await response.json() as {ok?:boolean};if(!response.ok||data.ok!==true)throw new TelegramError('Telegram could not deliver this file.',undefined,response.status);}
      catch(error){if(error instanceof TelegramError)throw error;throw new TelegramError('Telegram file delivery was interrupted.');}
    });this.queue=work.catch(()=>{});await work;
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
