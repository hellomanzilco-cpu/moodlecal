export class RuntimeHealth{
  private started=Date.now();private worker=Date.now();private polling=Date.now();private inbox=Date.now();private telegramSuccess=Date.now();private enabled:boolean;
  constructor(telegramPolling:boolean){this.enabled=telegramPolling;}
  workerBeat():void{this.worker=Date.now();}
  inboxBeat():void{this.inbox=Date.now();}
  pollingBeat(success=false):void{this.polling=Date.now();if(success)this.telegramSuccess=Date.now();}
  stalled():boolean{return Date.now()-this.worker>300000||Date.now()-this.inbox>300000||(this.enabled&&Date.now()-this.polling>300000);}
  readiness():{ready:boolean;reason?:string}{
    if(this.stalled())return {ready:false,reason:'A background worker is stalled.'};
    if(this.enabled&&Date.now()-this.telegramSuccess>180000)return {ready:false,reason:'Telegram has not responded recently.'};
    return {ready:true};
  }
  snapshot(){return {uptimeSeconds:Math.floor((Date.now()-this.started)/1000),workerAgeSeconds:Math.floor((Date.now()-this.worker)/1000),telegramAgeSeconds:this.enabled?Math.floor((Date.now()-this.telegramSuccess)/1000):null};}
}
