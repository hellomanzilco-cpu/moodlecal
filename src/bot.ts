import { DateTime, IANAZone } from 'luxon';
import { Store } from './store.ts';
import { formatTime, isActionable, isFocusItem, prepareText, priorityItems, upcomingClasses } from './planning.ts';
import type { Item, MessageOptions, Messenger, MoodleProfile, SharedProfilePage, Student } from './types.ts';
import { syncFailure } from './sync-errors.ts';
import {formatStatistics} from './statistics.ts';
import {profileField} from './profile-sharing.ts';
import type {ConnectionState} from './connection-progress.ts';
import type {TelegramConnectionOutcome,TelegramConnectionRunner} from './telegram-connection.ts';

export interface BotServices {
  connectLink(studentId: number): string;
  rememberTelegramDisplayName?(studentId:number,firstName:string,lastName:string):void;
  clearConnectionDisplayName?(studentId:number):void;
  calendarLink(studentId: number, rotate?: boolean): string;
  sync(studentId: number): Promise<void>;
  claimPairing?(studentId:number, secret:string):Promise<boolean>;
  updatesStatus?(): string;
  refresh?(studentId:number):Promise<string>;
  recentUpdates?(studentId:number):string;
  requestRefresh?(studentId:number):string;
  assignmentLink?(studentId:number,key:string):string;
  profile?(studentId:number):Promise<MoodleProfile>;
  sharingStatus?(studentId:number):{enabled:boolean;sharedAt:number|null};
  shareProfile?(studentId:number):Promise<void>;
  revokeProfile?(studentId:number):void;
  sharedProfiles?(requesterTelegramId:number,offset?:number):SharedProfilePage;
}

const HELP = `❓ How to use Moodle Calendar

Independent third-party app by Tursunov Sunnatilla. Not created by UWED.
Contact: @sunnatilla_tursunov

1. Connect your own Moodle account.
2. Tap 🔄 Sync to fetch current information.
3. View Today, Assignments or My courses.

More contains your profile, weekly plan, priorities, preparation, calendar and recent changes.
Settings contains your connection, alerts and time zone.

For Connect Moodle, use a private chat. The password message passes through Telegram to the bot server for sign-in only; the app does not store it and will try to delete the message after processing. Automatic website alerts require UWED’s event integration.`;

const MAIN_BUTTONS = [
  ['🏠 Today', '📝 Assignments'],
  ['📚 My courses', '🔄 Sync'],
  ['🧭 More', '⚙️ Settings'],
];
const ASSIGNMENT_BUTTONS = [['📅 Current deadlines this week', '🔜 Upcoming deadlines'], ['📨 Awaiting grades', '✅ Graded'], ['⚠️ Unverified'], ['⬅️ Main menu']];
const BUTTON_COMMANDS: Record<string, string> = {
  '🏠 Today': 'today', '📅 This week': 'week', '🎯 Priorities': 'priorities',
  '📚 My courses': 'courses', '📝 Assignments': 'assignments', '📖 Prepare': 'preparemenu',
  '🗓 Calendar': 'calendar', '⚙️ Settings': 'settings', '🔗 Connect Moodle': 'connect',
  '🔔 Pause alerts': 'pause', '🔔 Resume alerts': 'resume', '🌍 Time zone': 'timezonemenu',
  '🔄 Sync now': 'sync', '🔄 Sync':'sync', 'ℹ️ Status': 'status', '🔒 Disconnect': 'disconnectmenu',
  '⬅️ Main menu': 'menu', '🗑 Yes, disconnect': 'confirmdisconnect',
  '⏳ Outstanding': 'outstanding', '📨 Awaiting grades': 'awaiting', '✅ Graded': 'graded',
  '⚠️ Unverified':'unverified',
  '⏳ Active now': 'outstanding', '🕓 Upcoming / locked': 'upcoming',
  '📅 Current deadlines this week':'outstanding','🔜 Upcoming deadlines':'upcoming',
  '⏳ Next deadlines':'outstanding','🕓 Later / undated':'upcoming',
  '📖 All courses': 'prepare',
  '🔄 Auto update':'sync','📰 Recent updates':'recentupdates','🧭 More':'more','❓ Help':'help',
  '🔗 Reconnect Moodle':'connect','🗓 My timetable':'classes',
  '➡️ Next page':'nextpage','⬅️ Previous page':'previouspage',
  '👤 Profile':'profile','⬅️ More':'more',
  '📊 Bot statistics':'stats','📅 Today stats':'statstoday','🗓 7-day stats':'statsweek','🔄 Refresh stats':'refreshstats',
  '👥 Users':'users','🔄 Refresh users':'users','🔐 Profile sharing':'profilesharing',
  '✅ Yes, share my profile':'confirmsharing','✅ Yes, update shared profile':'confirmsharing','🚫 Stop sharing':'revokesharing','⬅️ Settings':'settings',
};
type Menu = 'main' | 'settings' | 'assignments' | 'prepare' | 'timezone' | 'disconnect' | 'more' | 'connection' | 'profile' | 'statistics' | 'sharing' | 'users';
interface MenuState { menu: Menu; expiresAt?: number }
interface BotReply { text: string; options: MessageOptions; sensitive?:boolean;afterSend?:(messageId:number|null)=>Promise<void> }
const keyboard = (rows: string[][], placeholder = 'Choose a button below'): MessageOptions => ({ reply_markup: {
  keyboard: rows.map(row => row.map(text => ({ text }))), resize_keyboard: true, is_persistent: true,
  one_time_keyboard: false, input_field_placeholder: placeholder,
} });

const CLASS_USAGE = 'Use /class COURSE_ID | Mon | 09:00 | 80 | Seminar | Room 204 | 2026-12-31\nDays: Mon, Tue, Wed, Thu, Fri, Sat, Sun. The final date is your semester end date. Times use your /timezone. Check your course IDs with /courses.';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const nowSeconds = () => Math.floor(Date.now() / 1000);
const positiveId = (value: string): number | null => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function escapeHtml(value: string, maxOutputLength = 100): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  let escaped = '';
  for (const character of value) {
    const next = entities[character] ?? character;
    if (escaped.length + next.length > maxOutputLength) return `${escaped}…`;
    escaped += next;
  }
  return escaped;
}

export class Bot {
  private store: Store;
  private messenger: Messenger;
  private services: BotServices;
  private defaultTimezone: string;
  private manualSyncs = new Map<number, number>();
  private menus = new Map<number, MenuState>();
  private pages = new Map<number,{command:string;arg:string;offset:number;total:number}>();
  private connectionInputs = new Map<number,{stage:'username'|'password';username:string;expires:number}>();
  private connectionTasks=new Set<Promise<void>>();
  private connectionRunner:TelegramConnectionRunner|null=null;
  private assignmentButtons=new Map<number,Item[]>();
  private ownerTelegramId:number|null;
  private statisticsDays=new Map<number,1|7>();

  constructor(store: Store, messenger: Messenger, services: BotServices, defaultTimezone = 'Asia/Tashkent',ownerTelegramId:number|null=null) {
    this.store = store;
    this.messenger = messenger;
    this.services = services;
    this.defaultTimezone = defaultTimezone;
    this.ownerTelegramId=typeof ownerTelegramId==='number'&&Number.isSafeInteger(ownerTelegramId)&&ownerTelegramId>0?ownerTelegramId:null;
  }

  setConnectionRunner(runner:TelegramConnectionRunner):void{this.connectionRunner=runner;}
  expectsTransientCredential(update:unknown):boolean{
    const envelope=record(update),message=record(envelope?.message),from=record(message?.from);
    if(!Number.isSafeInteger(from?.id)||Number(from?.id)<=0)return false;
    const student=this.store.byTelegram(Number(from!.id));
    const input=student?this.connectionInputs.get(student.id):undefined;
    return !!input&&input.expires>nowSeconds()&&(input.stage==='username'||input.stage==='password');
  }
  async drain():Promise<void>{await Promise.allSettled([...this.connectionTasks]);}

  async handle(update: unknown): Promise<void> {
    const envelope = record(update);
    if (!envelope || !Number.isSafeInteger(envelope.update_id) || Number(envelope.update_id) < 0) return;
    const updateId = Number(envelope.update_id);
    if (this.store.hasUpdate(updateId)) return;
    const cached = this.store.cachedReply(updateId);
    if (cached) {
      let text = cached.text;
      let options = keyboard(MAIN_BUTTONS);
      try {
        const saved = JSON.parse(cached.text);
        if (saved?.moodleCalendarReply === 1 && typeof saved.text === 'string') {
          text = saved.text;
          if (saved.options?.reply_markup) options = saved.options;
        }
      } catch { /* Older cached replies contain plain text. */ }
      await this.messenger.send(cached.chatId, text, options);
      this.store.finishUpdate(updateId, nowSeconds());
      return;
    }
    const message = record(envelope.message);
    const from = record(message?.from);
    const chat = record(message?.chat);
    const rawText=typeof message?.text==='string'?message.text:null;
    let text=rawText?.trim()??null;
    const webApp=record(message?.web_app_data);
    if(text===null && typeof webApp?.data==='string'){
      try{const action=record(JSON.parse(webApp.data))?.action;if(action==='connected')text='/start connected';else if(action==='assignment_updated')text='📝 Assignments';}catch{ /* Never trust Mini App data as account authorization. */ }
    }
    const incomingId=typeof from?.id==='number'?Number(from.id):0;
    const incomingStudent=incomingId>0?this.store.byTelegram(incomingId):null;
    const input=incomingStudent?this.connectionInputs.get(incomingStudent.id):undefined;
    const passwordMessage=rawText!==null&&!!input&&input.stage==='password'&&input.expires>nowSeconds();
    const passwordMessageId=passwordMessage&&typeof message?.message_id==='number'&&Number.isSafeInteger(message.message_id)?Number(message.message_id):null;
    if(passwordMessage)text=rawText;
    if (!message || !from || !chat || chat.type !== 'private' || from.is_bot === true ||
        !Number.isSafeInteger(from.id) || Number(from.id) <= 0 || from.id !== chat.id || text===null) {
      this.store.finishUpdate(updateId, nowSeconds());
      return;
    }
    const isNew=!this.store.byTelegram(Number(from.id));
    const student = this.store.ensureStudent(Number(from.id), Number(chat.id), this.defaultTimezone);
    try {
      this.services.rememberTelegramDisplayName?.(student.id,typeof from.first_name==='string'?from.first_name:'',typeof from.last_name==='string'?from.last_name:'');
    } catch { /* Name capture is diagnostic-only and must not block bot commands. */ }
    if(isNew)this.store.metric('student_started');
    const reply = await this.route(student, text);
    // A transport retry must resend the same response, not repeat a class addition
    // or rotate a private calendar link for the same Telegram update.
    // Read-only profile/statistics replies can be repeated without retaining their contents.
    if(!reply.sensitive)this.store.cacheReply(updateId, student.chatId, JSON.stringify({ moodleCalendarReply: 1, ...reply }), nowSeconds());
    let progressMessageId:number|null=null;
    if(reply.afterSend){
      try{
        if(this.messenger.sendWithId)progressMessageId=await this.messenger.sendWithId(student.chatId,reply.text,reply.options);
        else await this.messenger.send(student.chatId,reply.text,reply.options);
      }catch{console.error('Telegram connection progress could not be delivered; continuing connection processing.');}
    }else await this.messenger.send(student.chatId, reply.text, reply.options);
    this.store.finishUpdate(updateId, nowSeconds());
    if(passwordMessageId!==null&&this.messenger.deleteMessage){
      void this.messenger.deleteMessage(student.chatId,passwordMessageId).catch(()=>console.error('Telegram could not delete a processed password message.'));
    }
    if(reply.afterSend){
      const task=reply.afterSend(progressMessageId).catch(async()=>{
        try{await this.messenger.send(student.chatId,'⚠️ The connection result could not be confirmed. Your password was not saved. Tap 🔗 Connect Moodle to try again.',this.menuOptions(this.store.getStudent(student.id)??student,'connection'));}catch{/* Do not retain credential input after a Telegram delivery error. */}
      });
      this.connectionTasks.add(task);
      void task.finally(()=>this.connectionTasks.delete(task));
    }
  }

  private menuOptions(student: Student, menu: Menu): MessageOptions {
    if(!student.moodleCipher || menu==='connection'){
      const input=this.connectionInputs.get(student.id);
      const placeholder=input?.stage==='password'?'Type your Moodle password':input?.stage==='username'?'Type your Moodle username':'Connect Moodle to begin';
      return {reply_markup:{keyboard:[[{text:'🔗 Connect Moodle'}],...(student.moodleCipher?[[{text:'⬅️ Main menu'}]]:[])],resize_keyboard:true,is_persistent:true,input_field_placeholder:placeholder}};
    }
    if(menu==='more')return keyboard([['👤 Profile',...(this.isOwner(student)?['📊 Bot statistics']:[])],['📅 This week','🎯 Priorities'],['📖 Prepare','🗓 Calendar'],['📰 Recent updates','🗓 My timetable'],['⬅️ Main menu']]);
    if(menu==='statistics'&&this.isOwner(student))return keyboard([...(this.services.sharedProfiles?[['👥 Users']]:[]),['📅 Today stats','🗓 7-day stats'],['🔄 Refresh stats'],['⬅️ More','⬅️ Main menu']]);
    if(menu==='users'&&this.isOwner(student))return keyboard([['🔄 Refresh users'],['📊 Bot statistics'],['⬅️ More','⬅️ Main menu']]);
    if(menu==='profile')return keyboard([...(this.sharingAvailable()?[['🔐 Profile sharing']]:[]),['🔗 Reconnect Moodle'],['⬅️ More','⬅️ Main menu']]);
    if(menu==='sharing'&&this.sharingAvailable()){
      const enabled=this.services.sharingStatus!(student.id).enabled;
      return keyboard([[enabled?'✅ Yes, update shared profile':'✅ Yes, share my profile'],...(enabled?[['🚫 Stop sharing']]:[]),['⬅️ Settings']]);
    }
    if (menu === 'assignments') return keyboard(ASSIGNMENT_BUTTONS);
    if (menu === 'disconnect') return keyboard([['🗑 Yes, disconnect'], ['⬅️ Main menu']]);
    if (menu === 'settings' || menu === 'timezone') return keyboard([
      [student.paused ? '🔔 Resume alerts' : '🔔 Pause alerts', '🌍 Time zone'],
      ['ℹ️ Status', '🔗 Reconnect Moodle'], ...(this.sharingAvailable()?[['🔐 Profile sharing']]:[]), ['❓ Help', '🔒 Disconnect'], ['⬅️ Main menu'],
    ], menu === 'timezone' ? 'Type a time zone, e.g. Asia/Tashkent' : 'Choose a setting');
    if (menu === 'prepare') {
      const courses = this.store.courses(student.id).filter(course => !course.muted).slice(0, 40);
      return keyboard([...courses.map(course => [`📘 ${course.id}: ${course.name.slice(0, 55)}`]), ['📖 All courses'], ['⬅️ Main menu']]);
    }
    return keyboard(MAIN_BUTTONS);
  }
  private isOwner(student:Student):boolean{return this.ownerTelegramId!==null&&student.telegramId===this.ownerTelegramId;}
  private sharingAvailable():boolean{return this.ownerTelegramId!==null&&!!this.services.sharingStatus&&!!this.services.shareProfile&&!!this.services.revokeProfile;}
  private startConnectionPrompt(student:Student):BotReply{
    this.connectionInputs.set(student.id,{stage:'username',username:'',expires:nowSeconds()+900});
    this.menus.set(student.id,{menu:'connection',expiresAt:nowSeconds()+900});
    return {
      text:'🔗 Connect your Moodle account\n\nSend your Moodle username in this private chat. By sending it, you agree that the bot will use your username and password through Telegram and its server to sign in and read your courses, assignments, submission statuses, visible grades and deadlines.\n\nThe app does not store your password. If the connection needs diagnosis, your Telegram display name and safe step/error details may be stored encrypted for up to 90 days. Send /menu any time to stop.\n\nIndependent app by Tursunov Sunnatilla; not created by UWED.',
      options:this.menuOptions(student,'connection'),sensitive:true,
    };
  }
  private acceptConnectionInput(student:Student,input:{stage:'username'|'password';username:string;expires:number},text:string):BotReply{
    if(input.stage==='username'){
      const username=text.trim();
      if(!username||username.length>256)return {text:'Please send a valid Moodle username (up to 256 characters).',options:this.menuOptions(student,'connection'),sensitive:true};
      input.username=username;input.stage='password';input.expires=nowSeconds()+900;
      return {text:'🔐 Now send your Moodle password as your next message. It will pass through Telegram to the bot server for sign-in only; the app does not store it. The bot will try to delete the password message as soon as it is processed. Keep this in your private chat.',options:this.menuOptions(student,'connection'),sensitive:true};
    }
    if(text.length>512)return {text:'That password message is too long. Send a password of up to 512 characters.',options:this.menuOptions(student,'connection'),sensitive:true};
    const credentials={username:input.username,password:text};
    this.connectionInputs.delete(student.id);
    if(!this.connectionRunner){credentials.username='';credentials.password='';return {text:'⚠️ The in-chat Moodle connection service is not available right now. Try again later.',options:this.menuOptions(student,'connection'),sensitive:true};}
    const initial='🔄 Moodle connection\n\n⏳ Connecting to the Moodle server\n▫️ Verifying credentials\n▫️ Loading the student profile\n▫️ Synchronizing assignments\n▫️ Preparing the dashboard';
    return {
      text:initial,options:this.menuOptions(student,'connection'),sensitive:true,
      afterSend:async messageId=>{
        let currentMessageId=messageId,lastText=initial;
        const updateProgress=async(state:ConnectionState)=>{
          const next=this.connectionProgressText(state);
          if(next===lastText)return;
          try{
            if(currentMessageId!==null&&this.messenger.editMessage)await this.messenger.editMessage(student.chatId,currentMessageId,next);
            else await this.messenger.send(student.chatId,next);
            lastText=next;
          }catch{currentMessageId=null;}
        };
        let outcome:TelegramConnectionOutcome;
        try{outcome=await this.connectionRunner!(student.id,credentials.username,credentials.password,updateProgress);}
        catch{outcome={status:'unknown',error:'The connection result could not be confirmed. This does not mean Moodle rejected your sign-in. Tap Status in Settings before retrying.'};}
        finally{credentials.username='';credentials.password='';}
        if(outcome.state)await updateProgress(outcome.state);
        else if(outcome.error){
          const finalText=`${outcome.status==='unknown'?'⚠️':'❌'} Moodle connection\n\n${outcome.error}${outcome.diagnosticId?`\n\nDiagnostic reference: CONN-${outcome.diagnosticId}`:''}`;
          try{
            if(currentMessageId!==null&&this.messenger.editMessage)await this.messenger.editMessage(student.chatId,currentMessageId,finalText);
            else await this.messenger.send(student.chatId,finalText);
          }catch{/* Keep the connection status itself authoritative. */}
        }
        if(outcome.status==='complete'||outcome.status==='partial'){
          const connected=this.store.getStudent(student.id);
          if(!connected?.moodleCipher){
            try{await this.messenger.send(student.chatId,'⚠️ Moodle reported a connection, but the saved account could not be confirmed. Open Status in Settings before retrying.');}catch{/* No credential data is retained. */}
            return;
          }
          try{
            const dashboard=await this.route(connected,'/start connected');
            await this.messenger.send(student.chatId,dashboard.text,dashboard.options);
          }catch{
            try{await this.messenger.send(student.chatId,'✅ Moodle connected. Your dashboard is saved; tap 📝 Assignments to open it.');}catch{/* The student can request the dashboard again. */}
          }
        }
      },
    };
  }
  private connectionProgressText(state:ConnectionState):string{
    const item=(status:string,pending:string,label:string)=>`${status===pending?'⏳':status==='unavailable'||status==='failed'?'❌':status==='partial'?'⚠️':status==='reachable'||status==='verified'||status==='loaded'||status==='complete'||status==='prepared'?'✅':'▫️'} ${label}`;
    const lines=[
      item(state.serverStatus,'pending','Connecting to the Moodle server'),
      item(state.authStatus,'pending','Verifying credentials'),
      item(state.profileStatus,'pending','Loading the student profile'),
      item(state.syncStatus,'pending','Synchronizing assignments'),
      item(state.dashboardStatus,'pending','Preparing the dashboard'),
    ];
    if(state.authStatus==='unknown')lines[1]='⚠️ Credentials were not confirmed';
    let text=`🔄 Moodle connection\n\n${lines.join('\n')}`;
    if(state.status==='partial')text+='\n\n⚠️ Moodle connected with partial synchronization.';
    if(state.error)text+=`\n\n${state.error}`;
    if(state.coverageWarnings?.length)text+=`\n\nCoverage notes:\n${state.coverageWarnings.slice(0,4).map(value=>'• '+value.slice(0,180)).join('\n')}`;
    if(state.diagnosticId)text+=`\n\nDiagnostic reference: CONN-${state.diagnosticId}`;
    return text;
  }
  private async route(student: Student, text: string): Promise<BotReply> {
    const id = student.id;
    this.assignmentButtons.delete(id);
    const activeInput=this.connectionInputs.get(id);
    if(activeInput){
      if(activeInput.expires<=nowSeconds()){
        this.connectionInputs.delete(id);
        return {text:'Your Moodle connection prompt expired. Tap 🔗 Connect Moodle to begin again.',options:this.menuOptions(student,'connection'),sensitive:true};
      }
      const choice=text.trim();
      if(choice==='/menu'||choice==='/start'||choice==='⬅️ Main menu')this.connectionInputs.delete(id);
      else if(choice==='/connect'||choice==='🔗 Connect Moodle'){
        if(activeInput.stage==='password')return {text:'The password step is still waiting. Type your Moodle password as a separate message here; tapping Connect Moodle does not submit it.',options:this.menuOptions(student,'connection'),sensitive:true};
        return this.startConnectionPrompt(student);
      }
      else return this.acceptConnectionInput(student,activeInput,text);
    }
    const slash = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text);
    const courseButton = /^📘 (\d+):/.exec(text);
    let command = slash ? slash[1].toLowerCase() : BUTTON_COMMANDS[text];
    if(command==='disconnect')command='disconnectmenu';
    if(command==='autoupdate')command='sync';
    let arg = slash ? (slash[2] || '').trim() : '';
    if(command==='nextpage'||command==='previouspage'){
      const page=this.pages.get(id);
      if(page){page.offset=Math.max(0,Math.min(Math.floor((page.total-1)/6)*6,page.offset+(command==='nextpage'?6:-6)));command=page.command;arg=page.arg;}
      else command='menu';
    }else this.pages.delete(id);
    const state = this.menus.get(id);
    if (!command && courseButton) { command = 'prepare'; arg = courseButton[1]; }
    if (!command && state?.menu === 'timezone') { command = 'timezone'; arg = text; }
    let menu: Menu = state?.menu ?? 'main';
    let reply: string;
    let personalizedReturn=false;
    if(command==='connect')return this.startConnectionPrompt(student);
    if(command==='start'&&arg==='connected'&&student.moodleCipher){
      command='assignments';arg='';menu='assignments';personalizedReturn=true;
      let firstName='';try{firstName=profileField((await this.services.profile?.(id))?.firstName??'');}catch{/* The saved dashboard remains available if a profile refresh is unavailable. */}
      const greeting=`✅ <b>Moodle connected${firstName?`, ${escapeHtml(firstName)}`:''}</b>\n\nYour live assignment dashboard is ready.`;
      reply=greeting+'\n\n'+await this.command(student,'assignments','');
    } else if (command === 'start' || command === 'help' || command === 'menu') {
      menu = 'main'; reply = command === 'help' ? HELP : command==='menu' ? '🏠 Main menu\n\nChoose a button below.' : student.moodleCipher ? `🎓 Moodle Calendar\n\nYour UWED study planner.\nIndependent app by Tursunov Sunnatilla; not created by UWED.\n\n✅ Moodle connected\n🕒 Last updated: ${student.lastSyncAt ? formatTime(student.lastSyncAt,student.timezone) : 'not yet synced'}\n\nChoose a button below.` : '🎓 Welcome to Moodle Calendar\n\nAn independent study planner by Tursunov Sunnatilla, not created by UWED.\n\nConnect your Moodle account to see your courses, assignment deadlines, submission status, grades Moodle makes visible, and course updates. Use the existing menu to explore assignments and your weekly plan.\n\nTap 🔗 Connect Moodle below. I will ask for your username and password here in this private chat. The password goes through Telegram to the bot server for sign-in only, is not stored by the app, and the bot will try to delete the message after processing.\n\nContact: @sunnatilla_tursunov';
      if(command==='start' && /^pair_[A-Za-z0-9_-]{43}$/.test(arg) && this.services.claimPairing) {
        try {
          const connected=await this.services.claimPairing(id,arg.slice(5));
          reply=connected ? '✅ Your Moodle account is connected and synced.\nTap 📝 Assignments to check outstanding work, awaiting grades, and graded submissions.\n\n'+HELP
            : 'This private setup link has expired or was already used. Tap 🔗 Connect Moodle to connect your own account.\n\n'+HELP;
        } catch { reply='Moodle could not be connected just now. Your setup link remains available until it expires; try opening it again.\n\n'+HELP; }
      }
    } else if(command==='more'){
      menu='more';reply='🧭 More\n\nView your profile, plan your week or open your calendar.';
    } else if (command === 'settings') {
      menu = 'settings'; reply = `⚙️ Settings\nAlerts: ${student.paused ? 'paused' : 'enabled'}\nTime zone: ${student.timezone}\nChoose a setting below.`;
    } else if(command==='profilesharing'){
      if(!student.moodleCipher||!this.sharingAvailable()){
        menu='settings';reply=student.moodleCipher?'Profile sharing is not available.':'Connect Moodle before managing profile sharing.';
      }else{
        const status=this.services.sharingStatus!(id);
        this.menus.set(id,{menu:'sharing',expiresAt:nowSeconds()+300});
        return {text:`🔐 Share profile with creator?\n\nCurrently: ${status.enabled?'On':'Off'}\n\nIf you agree, Tursunov Sunnatilla (@sunnatilla_tursunov), the creator of this independent app, can see your Moodle first name, last name and username in a private user list. These details will be saved encrypted until you stop sharing, reconnect or disconnect.\n\nSharing is optional. You can use all student features without it. Passwords, cookies, coursework and grades are not included.\n\nStop sharing here at any time. This removes the saved shared profile; messages already delivered cannot be erased.\n\nTap Yes below only if you agree.`,options:this.menuOptions(student,'sharing')};
      }
    } else if(command==='confirmsharing'){
      menu='profile';
      if(!student.moodleCipher||!this.sharingAvailable()||state?.menu!=='sharing'||(state.expiresAt??0)<nowSeconds()){
        reply='Open Settings → 🔐 Profile sharing to read the disclosure and confirm your choice.';
      }else{
        try{await this.services.shareProfile!(id);reply='✅ Profile sharing is on\n\nYour Moodle first name, last name and username are visible to Tursunov Sunnatilla. Open 🔐 Profile sharing to update or stop sharing at any time.';}
        catch{reply='⚠️ Your profile could not be shared. Moodle may be unavailable or your connection changed. Open 🔐 Profile sharing to check your current setting and try again.';}
      }
    } else if(command==='revokesharing'){
      menu='settings';
      if(this.services.revokeProfile){this.services.revokeProfile(id);reply='✅ Profile sharing is off\n\nYour saved shared profile has been removed from the creator’s list. You can continue using the bot. Messages already delivered cannot be erased.';}
      else reply='Profile sharing is not available.';
    } else if (command === 'timezonemenu') {
      menu = 'timezone'; reply = '🌍 Time zone\nType your IANA time zone, for example Asia/Tashkent, Europe/London, or America/New_York. Your manual class times will use this zone.\nTap Main menu to cancel.';
    } else if (command === 'disconnectmenu') {
      this.menus.set(id, { menu: 'disconnect', expiresAt: nowSeconds() + 300 });
      return { text: '🔒 Disconnect Moodle?\nThis deletes your Moodle connection, saved courses, timetable, completion marks, and private calendar links.\nTap Yes, disconnect to confirm, or Main menu to cancel.', options: this.menuOptions(student, 'disconnect') };
    } else if (command === 'confirmdisconnect') {
      menu = 'main';
      reply = state?.menu === 'disconnect' && (state.expiresAt ?? 0) >= nowSeconds()
        ? await this.command(student, 'disconnect', '')
        : 'Open ⚙️ Settings → 🔒 Disconnect to review and confirm deleting your connection.';
    } else if (command === 'preparemenu') {
      menu = student.moodleCipher ? 'prepare' : 'main';
      reply = student.moodleCipher ? '📖 Prepare for class\nChoose a course below. Checklists use Moodle descriptions and links; document contents have not been read.' : await this.command(student, 'prepare', '');
    } else if (['assignments', 'outstanding', 'upcoming', 'awaiting', 'graded', 'unverified'].includes(command ?? '')) {
      menu = student.moodleCipher ? 'assignments' : 'main';
      reply = await this.command(student, command!, arg);
    } else if (command) {
      if (['pause', 'resume', 'status'].includes(command) && !slash) menu = 'settings';
      else if(command==='sync')menu='main';
      else if(command==='profile')menu='profile';
      else if(['stats','statstoday','statsweek','refreshstats'].includes(command))menu=this.isOwner(student)?'statistics':'more';
      else if(command==='users')menu=this.isOwner(student)?'users':'more';
      else if (command === 'timezone') menu = IANAZone.isValidZone(arg) ? 'settings' : 'timezone';
      else if (['disconnect', 'today', 'week', 'priorities', 'calendar'].includes(command)) menu = 'main';
      else if (command === 'courses') {menu = student.moodleCipher ? 'prepare' : 'main';if(!slash)arg='menu';}
      reply = await this.command(student, command, arg);
    } else {
      menu = 'main';
      reply = 'Choose an emoji button below. Connect Moodle asks for your username and password in this private Telegram chat.';
    }
    if (this.store.getStudent(id)) this.menus.set(id, { menu });
    else this.menus.delete(id);
    const options=this.menuOptions(this.store.getStudent(id) ?? {...student,moodleCipher:null}, menu);
    if (['assignments', 'outstanding', 'upcoming', 'awaiting', 'graded', 'unverified'].includes(command ?? '')) options.parse_mode = 'HTML';
    if(student.moodleCipher&&this.services.assignmentLink&&options.reply_markup){
      const buttons=(this.assignmentButtons.get(id)||[]).filter(item=>/^assignment:[1-9]\d*$/.test(item.key)).map(item=>[{text:'📄 '+item.title.slice(0,48),web_app:{url:this.services.assignmentLink!(id,item.key)}}]);
      options.reply_markup.keyboard.unshift(...buttons);
    }
    const page=this.pages.get(id);
    if(page && page.total>6 && options.reply_markup){
      const navigation=[];
      if(page.offset>0)navigation.push({text:'⬅️ Previous page'});
      if(page.offset+6<page.total)navigation.push({text:'➡️ Next page'});
      options.reply_markup.keyboard.unshift(navigation);
    }
    return { text: reply, options, sensitive:personalizedReturn||command==='profile'||['stats','statstoday','statsweek','refreshstats','users'].includes(command??'') };
  }

  private page<T>(id:number,command:string,arg:string,items:T[]):{items:T[];footer:string}{
    const existing=this.pages.get(id);
    const offset=existing?.command===command && existing.arg===arg ? existing.offset : 0;
    this.pages.set(id,{command,arg,offset,total:items.length});
    return {items:items.slice(offset,offset+6),footer:items.length>6?`\n\n${offset+1}–${Math.min(offset+6,items.length)} of ${items.length}`:''};
  }

  private coverage(student: Student): string {
    const notes: string[] = [];
    if (!student.initialized) notes.push('The first Moodle sync has not completed yet.');
    const syncFailed = student.lastError?.startsWith('Sync failed.') ?? false;
    if (student.lastSyncAt !== null && (syncFailed || nowSeconds() - student.lastSyncAt > 15 * 60)) notes.push(`🕒 Saved data may be out of date · ${formatTime(student.lastSyncAt, student.timezone)}. Tap 🔄 Sync.`);
    if (syncFailed) {
      notes.push(student.lastError?.includes('UWED Moodle is not responding')
        ? '⚠️ UWED Moodle is unavailable. Showing the last successful snapshot.'
        : '⚠️ Sync failed. Showing the last successful snapshot.');
    } else if (student.lastError) {
      notes.push('🟠 Moodle synced with limited coverage. Some activities or details may be missing.');
    }
    if (student.paused) notes.push('Background notifications are paused. Open Settings → Resume alerts to turn them on.');
    return notes.length ? `\n\n${notes.join('\n')}` : '';
  }

  private itemLine(item: Item, timezone: string): string {
    const task = item.kind === 'assignment' || item.kind === 'quiz';
    const time = task ? item.dueAt : item.startsAt ?? item.dueAt;
    const label = item.key.startsWith('class:') ? 'Class' : task ? 'Due' : item.kind === 'resource' ? 'Material' : item.startsAt !== null ? 'Event' : 'Due';
    return `${item.title}\n${item.courseName}\n${label}${time !== null ? ` ${formatTime(time, timezone)}` : ''}${item.key.startsWith('class:') ? `\n${item.description}` : ''}${item.url ? `\n${item.url}` : ''}`;
  }

  private assignmentLine(item: Item, timezone: string, now: number, number: number): string {
    const lines = [`<b>${number}. ${escapeHtml(item.title)}</b>`, `📘 ${escapeHtml(item.courseName)}`];
    if (item.availability === 'open') lines.push('🟢 Available now');
    else if (item.availability === 'upcoming') lines.push('🕒 Not open yet');
    else if (item.availability === 'restricted') lines.push('🔒 Restricted');
    else if (item.availability === 'closed') lines.push('⛔ Submissions closed');
    else lines.push('⚪ Availability unknown');
    if (item.availability === 'upcoming' && item.availableFrom !== null && item.availableFrom !== undefined) lines.push(`📅 <b>Opens:</b> ${formatTime(item.availableFrom, timezone)}`);
    if (item.availabilityReason) lines.push(`ℹ️ ${escapeHtml(item.availabilityReason)}`);

    if (item.dueAt === null) lines.push('📅 Deadline unavailable');
    else {
      lines.push(`📅 <b>Due:</b> ${formatTime(item.dueAt, timezone)}`);
      const due = DateTime.fromSeconds(item.dueAt, { zone: timezone });
      const current = DateTime.fromSeconds(now, { zone: timezone });
      if (item.dueAt <= now) lines.push('⌛ Deadline passed');
      else {
        const days = Math.round(due.startOf('day').diff(current.startOf('day'), 'days').days);
        lines.push(`⌛ ${days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days`}`);
      }
    }
    return lines.join('\n');
  }

  private assignmentCoverage(student: Student): string {
    const notes: string[] = [];
    const syncFailed = student.lastError?.startsWith('Sync failed.') ?? false;
    const stale = student.lastSyncAt !== null && nowSeconds() - student.lastSyncAt > 15 * 60;
    if (syncFailed) {
      notes.push('⚠️ <b>Showing saved data</b>\nThe latest synchronization failed. Verify deadlines in Moodle.');
    } else if (stale) {
      notes.push('⚠️ <b>Saved data may be out of date</b>\nVerify deadlines in Moodle.');
    } else if (student.lastError) {
      notes.push('🟠 <b>Limited Moodle coverage</b>\nSome assignment or course details may be missing. Verify coverage in Moodle.');
    }
    if (student.paused) notes.push('Notifications are paused in Settings.');
    return notes.length ? `\n\n${notes.join('\n')}` : '';
  }

  private async command(student: Student, command: string, arg: string): Promise<string> {
    const id = student.id;
    const now = nowSeconds();
    if (command === 'start' || command === 'help') return HELP;
    if(command==='users'){
      if(!this.isOwner(student))return '🔒 The shared user list is available only to the bot owner.';
      try{
        if(!this.services.sharedProfiles)throw new Error('User list unavailable');
        const page=this.services.sharedProfiles(student.telegramId,this.pages.get(id)?.offset||0);
        this.pages.set(id,{command:'users',arg:'',offset:page.offset,total:page.total});
        const field=(value:string)=>profileField(value)||'Not provided by Moodle';
        const entries=page.profiles.map((profile,index)=>`${page.offset+index+1}. First name: ${field(profile.firstName)}\nLast name: ${field(profile.lastName)}\nMoodle username: ${field(profile.username)}\nShared: ${formatTime(profile.sharedAt,student.timezone)}`);
        return `👥 Shared user profiles\n\nShared profiles: ${page.total}\nOther accounts not listed: ${Math.max(0,page.registered-page.total)}\n\n${entries.length?entries.join('\n\n'):'No students have opted in yet.'}${page.total>6?`\n\n${page.offset+1}–${Math.min(page.offset+6,page.total)} of ${page.total}`:''}\n\nOnly students who chose Settings → Profile sharing appear here. Details reflect their last sharing confirmation. Refresh reloads consented records without requesting private profiles from Moodle.`;
      }catch{return '👥 The shared user list could not be loaded. Try again later. No private profiles were requested from Moodle.';}
    }
    if(['stats','statstoday','statsweek','refreshstats'].includes(command)){
      if(!this.isOwner(student))return '🔒 Bot statistics are available only to the bot owner.';
      const days=command==='statstoday'?1:command==='refreshstats'?(this.statisticsDays.get(id)||7):7;
      this.statisticsDays.set(id,days);
      return formatStatistics(this.store.statistics(),days,now);
    }
    if (command === 'connect') {
      return 'Tap 🔗 Connect Moodle in the menu to begin a private-chat connection.';
    }
    if (command === 'disconnect') {
      this.store.deleteStudent(id);
      this.services.clearConnectionDisplayName?.(id);
      this.manualSyncs.delete(id);
      this.pages.delete(id);
      this.statisticsDays.delete(id);
      return 'Disconnected. Your Moodle connection, saved course data, timetable, completion marks, and calendar links have been deleted. Remove the old calendar subscription from your calendar app. Tap 🔗 Connect Moodle whenever you want to start again.';
    }
    if (command === 'timezone') {
      if (!arg || arg.length > 100 || !IANAZone.isValidZone(arg)) return 'Use a valid IANA time zone, for example /timezone Asia/Tashkent or /timezone Europe/London.';
      this.store.patchStudent(id, { timezone: arg });
      return `Time zone set to ${arg}. Your manual class times now use this time zone.`;
    }
    if (command === 'pause' || command === 'resume') {
      this.store.patchStudent(id, { paused: command === 'pause' });
      if (command === 'pause') return 'Moodle notifications are paused. Tap Resume alerts to continue; Sync now still works manually.';
      if (student.moodleCipher) {
        if(this.services.requestRefresh){try{return '🔔 Alerts resumed\n\n'+this.services.requestRefresh(id);}catch(error){return '🔔 Alerts resumed\n\n'+syncFailure(error);}}
        try { await this.services.sync(id); }
        catch { return 'Notifications are enabled. Moodle could not be refreshed just now; your saved information is still available.'; }
      }
      return `Moodle notifications are enabled.${this.services.updatesStatus ? '\n' + this.services.updatesStatus() : ''}`;
    }
    if (command === 'status') {
      const attempt=Number(this.store.getMeta(`lastSyncAttempt:${id}`));
      const queued=!!this.store.db.prepare('SELECT 1 FROM manual_sync_jobs WHERE studentId=?').get(id);
      return `ℹ️ Status\n\nConnection: ${student.moodleCipher ? 'Moodle connected' : 'not connected'}\nLast successful sync: ${student.lastSyncAt === null ? 'never' : formatTime(student.lastSyncAt, student.timezone)}\nLast attempt: ${attempt ? formatTime(attempt,student.timezone) : 'none'}\nSync: ${queued ? 'queued / running' : 'idle'}\nCourses: ${this.store.courses(id).length}\nAlerts: ${student.paused ? 'paused' : 'enabled'}\nTime zone: ${student.timezone}\n\n${this.services.updatesStatus ? this.services.updatesStatus() : 'Automatic website alerts require UWED’s event integration.'}${this.coverage(student)}`;
    }
    const connectedCommands = new Set(['courses', 'today', 'week', 'priorities', 'prepare', 'assignments', 'outstanding', 'upcoming', 'awaiting', 'graded', 'unverified', 'done', 'undo', 'mute', 'unmute', 'calendar', 'sync', 'autoupdate','recentupdates','class', 'classes', 'unclass','profile']);
    if (connectedCommands.has(command) && !student.moodleCipher) return 'Connect your Moodle account first by tapping 🔗 Connect Moodle. The bot will explain how your credentials are handled before asking for them in this private chat.';

    switch (command) {
      case 'profile': {
        try{
          if(!this.services.profile)throw new Error('Profile unavailable');
          const profile=await this.services.profile(id);
          const field=(value:string)=>profileField(value)||'Not provided by Moodle';
          const sharing=this.sharingAvailable()?`\nProfile sharing with creator: ${this.services.sharingStatus!(id).enabled?'On':'Off'}`:'';
          return `👤 Your Moodle profile\n\nFirst name: ${field(profile.firstName)}\nLast name: ${field(profile.lastName)}\nUsername: ${field(profile.username)}\nPassword: Not stored${sharing}\n\nYour password cannot be viewed here. To update your connection, tap 🔗 Reconnect Moodle.\n\nProfile details are read from your connected Moodle account.`;
        }catch{
          return '👤 Profile unavailable\n\nI could not read your current profile from Moodle. Try 👤 Profile in More again, or reconnect if your access has expired.\n\nPassword: Not stored; it cannot be displayed.';
        }
      }
      case 'recentupdates': return this.services.recentUpdates?.(id) || '📰 No recorded website changes yet.';
      case 'courses': {
        const courses = this.store.courses(id);
        return (courses.length ? arg==='menu' ? `📚 My courses\n\n${courses.length} enrolled courses.\nChoose a course below to prepare for class.` : '📚 My courses\n\n' + courses.map(course => `${course.id}: ${course.name}${course.muted ? ' (muted)' : ''}`).join('\n') : 'No courses have been synced yet. Tap 🔄 Sync, then check Status.') + this.coverage(student);
      }
      case 'mute':
      case 'unmute': {
        const courseId = positiveId(arg);
        if (!courseId || !this.store.muteCourse(id, courseId, command === 'mute')) return 'Course not found in your enrolled courses. Use /courses, then /mute COURSE_ID or /unmute COURSE_ID.';
        return command === 'mute' ? 'Course muted. Its updates, reminders, deadlines, and manual classes are hidden from your default views and calendar. Manage saved timetable entries with /classes.' : 'Course unmuted. Its Moodle items and manual classes are included again.';
      }
      case 'today':
      case 'week': {
        const days = command === 'today' ? 1 : 7;
        const start = DateTime.fromSeconds(now, { zone: student.timezone }).startOf('day');
        const end = start.plus({ days }).toSeconds();
        const courses = this.store.courses(id).filter(course => !course.muted);
        const all = [...this.store.items(id), ...upcomingClasses(student, this.store.classes(id), courses, start.toSeconds(), days)];
        const items = all.filter(item => !item.completed && isFocusItem(item,all,now) && ((item.dueAt !== null && item.dueAt >= start.toSeconds() && item.dueAt < end) || (item.startsAt !== null && item.startsAt >= start.toSeconds() && item.startsAt < end)))
          .sort((a, b) => (a.startsAt ?? a.dueAt ?? Infinity) - (b.startsAt ?? b.dueAt ?? Infinity));
        const page=this.page(id,command,arg,items);
        return `${command === 'today' ? '🏠 Today' : '📅 Next 7 days'} · ${student.timezone}\n\n${items.length ? page.items.map(item => this.itemLine(item, student.timezone)).join('\n\n') : 'No unfinished deadlines or scheduled classes.'}${page.footer}${this.coverage(student)}`;
      }
      case 'priorities': {
        const items = priorityItems(this.store.items(id), now);
        const page=this.page(id,command,arg,items);
        return `🎯 Priorities\n\n${items.length ? page.items.map(item => `${item.dueAt !== null && item.dueAt < now ? '⚠️ Overdue · ' : ''}${this.itemLine(item, student.timezone)}`).join('\n\n') : 'No current unfinished tasks found.'}${page.footer}\n\nNext deadline per course and accessible overdue work.${this.coverage(student)}`;
      }
      case 'prepare': {
        const courseId = arg ? positiveId(arg) : undefined;
        if (arg && (!courseId || !this.store.courses(id).some(course => course.id === courseId))) return 'Course not found in your enrolled courses. Use /courses, then /prepare COURSE_ID.';
        return prepareText(this.store.items(id), courseId ?? undefined) + this.coverage(student);
      }
      case 'assignments':
      case 'outstanding':
      case 'upcoming':
      case 'awaiting':
      case 'graded':
      case 'unverified': {
        const assignments = this.store.items(id).filter(item => item.kind === 'assignment');
        const weekStart = DateTime.fromSeconds(now, { zone: student.timezone }).startOf('week');
        const nextWeekStart = weekStart.plus({ weeks: 1 });
        const currentWork=(item:Item)=>item.dueAt!==null && (item.dueAt<now || (item.dueAt>=weekStart.toSeconds() && item.dueAt<nextWeekStart.toSeconds())) && isActionable(item,now);
        const statuses = { outstanding: 'outstanding', upcoming: 'outstanding', awaiting: 'submitted_ungraded', graded: 'submitted_graded', unverified:'unknown' } as const;
        const unknown = assignments.filter(item => !item.submissionStatus || item.submissionStatus === 'unknown');
        const counts = {
          outstanding: assignments.filter(item => item.submissionStatus === 'outstanding' && currentWork(item)).length,
          upcoming: assignments.filter(item => item.submissionStatus === 'outstanding' && !currentWork(item)).length,
          awaiting: assignments.filter(item => item.submissionStatus === 'submitted_ungraded').length,
          graded: assignments.filter(item => item.submissionStatus === 'submitted_graded').length,
        };
        const totalUnfinished = counts.outstanding + counts.upcoming;
        const distribution = [
          { icon: '📅', label: 'Current deadlines this week', count: counts.outstanding },
          { icon: '🔜', label: 'Upcoming deadlines', count: counts.upcoming },
          { icon: '📨', label: 'Awaiting grades', count: counts.awaiting },
          { icon: '✅', label: 'Graded', count: counts.graded },
          { icon: '⚠️', label: 'Status unverified', count: unknown.length },
        ];
        const largestCount = Math.max(0, ...distribution.map(category => category.count));
        const chartRows = distribution.map(category => {
          const percent = assignments.length ? Math.round(category.count * 100 / assignments.length) : 0;
          const barLength = largestCount ? category.count ? Math.max(1, Math.round(category.count * 5 / largestCount)) : 0 : 0;
          const bar = barLength ? '█'.repeat(barLength) : '·';
          return `${category.icon} ${category.label.padEnd(20)} ${String(category.count).padStart(3)} · ${String(percent).padStart(3)}% ${bar}`;
        }).join('\n');
        const summary = `📊 <b>ASSIGNMENTS DASHBOARD</b>\n━━━━━━━━━━━━━━━━━━\n\n<b>TOTAL UNFINISHED</b>\n<b>${totalUnfinished} ${totalUnfinished === 1 ? 'assignment' : 'assignments'}</b>\n\n📈 <b>STATUS DISTRIBUTION</b>\nShare of ${assignments.length} ${assignments.length === 1 ? 'assignment' : 'assignments'}\n<pre>${chartRows}</pre>`;
        const unknownNotice = unknown.length ? `\n\n⚠️ Moodle did not confirm submission status for ${unknown.length} assignment${unknown.length === 1 ? '' : 's'}. Open ⚠️ Unverified to check each task directly. Upload is enabled only when Moodle confirms the current status and your access.` : '';
        if (command === 'assignments') return summary + (assignments.length ? '\n\nChoose a category below.' : '\n\nNo assignments have been synced yet.') + this.coverage(student);
        const status = statuses[command];
        const filtered = assignments.filter(item => command==='unverified'?(!item.submissionStatus||item.submissionStatus==='unknown'):item.submissionStatus === status && (command === 'outstanding' ? currentWork(item) : command === 'upcoming' ? !currentWork(item) : true)).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.title.localeCompare(b.title));
        const headings = { outstanding: '📅 Current deadlines this week', upcoming: '🔜 Upcoming deadlines', awaiting: '📨 Submitted — awaiting grades', graded: '✅ Submitted — graded', unverified:'⚠️ Status unverified — check with Moodle' };
        const page=this.page(id,command,arg,filtered);
        this.assignmentButtons.set(id,page.items);
        const firstNumber = (this.pages.get(id)?.offset ?? 0) + 1;
        const entries = page.items.map((item, index) => `${this.assignmentLine(item, student.timezone, now, firstNumber + index)}${command === 'graded' ? `\nGrade: ${escapeHtml(item.grade || 'See Moodle for grade details')}` : ''}`);
        const footer = page.footer ? `\n\n📄 Showing ${page.footer.trim()} assignments` : '';
        const menuHint = this.services.assignmentLink && filtered.length ? '\n\nSelect an assignment from the menu below to view its task details.' : '';
        return `📚 <b>${headings[command]}</b>\n━━━━━━━━━━━━━━━━━━\n\n${entries.length ? entries.join('\n\n──────────────────\n\n') : 'No assignments in this category.'}${footer}${menuHint}${command==='unverified'?unknownNotice:''}${this.assignmentCoverage(student)}`;
      }
      case 'done':
      case 'undo': {
        if (!arg || arg.length > 300 || !this.store.markDone(id, arg, command === 'done')) return 'Item not found in your saved Moodle items. Copy an item key from /priorities or /prepare.';
        return command === 'done' ? 'Marked complete in Moodle Calendar. This does not submit work or change completion in Moodle.' : 'Removed your personal completion mark. Any completion recorded in Moodle still applies.';
      }
      case 'calendar':
        if (arg && arg.toLowerCase() !== 'rotate') return 'Use /calendar to get your private subscription, or /calendar rotate to revoke the old link.';
        return `Private calendar subscription:\n${this.services.calendarLink(id, arg.toLowerCase() === 'rotate')}\n\nIn your calendar app, choose Add calendar → Subscribe by URL and paste this link. Anyone with the link can read your calendar. Do not share it. Calendar apps choose their own refresh interval; Telegram alerts arrive independently.${arg ? '\nThe old subscription link is now revoked. Replace it in your calendar app.' : '\nUse /calendar rotate to revoke this link.'}`;
      case 'sync': {
        const previous = this.manualSyncs.get(id) ?? 0;
        if (now - previous < 15) return `Please wait ${15 - (now - previous)} seconds before syncing again.`;
        this.manualSyncs.set(id, now);
        try {
          if(this.services.requestRefresh)return this.services.requestRefresh(id);
          if(this.services.refresh)return await this.services.refresh(id);
          await this.services.sync(id);
          const current = this.store.getStudent(id);
          return `Moodle sync finished. Return to the main menu for Today, Priorities, or My courses.${current ? this.coverage(current) : ''}`;
        } catch(error) {
          return syncFailure(error);
        }
      }
      case 'class': {
        if (!arg) return CLASS_USAGE;
        const parts = arg.split('|').map(part => part.trim());
        if (parts.length !== 7) return CLASS_USAGE;
        const [courseText, dayText, time, durationText, title, location, until] = parts;
        const courseId = positiveId(courseText);
        if (!courseId || !this.store.courses(id).some(course => course.id === courseId)) return 'Choose one of your enrolled course IDs from /courses.\n\n' + CLASS_USAGE;
        const weekday = DAYS.findIndex(day => day.toLowerCase() === dayText.replace(/^weekday\s+/i, '').toLowerCase()) + 1;
        if (!weekday || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !/^\d+$/.test(durationText) || Number(durationText) < 1 || Number(durationText) > 720) return 'Use a valid weekday, 24-hour HH:mm time, and a duration from 1 to 720 minutes.\n\n' + CLASS_USAGE;
        if (!title || title.length > 120 || location.length > 200 || /[\u0000-\u001f]/.test(title + location)) return 'Use a class title of 1–120 characters and a location of at most 200 characters.';
        const today = DateTime.fromSeconds(now, { zone: student.timezone }).startOf('day');
        const end = /^\d{4}-\d{2}-\d{2}$/.test(until) ? DateTime.fromISO(until, { zone: student.timezone }) : null;
        if (!end?.isValid || end < today || end > today.plus({ years: 2 })) return 'Use a valid semester end date in YYYY-MM-DD format, from today through the next 2 years.';
        if (this.store.classes(id).length >= 100) return 'You have reached the limit of 100 timetable entries. Remove an entry with /unclass ID first.';
        const classId = this.store.addClass(id, { courseId, weekday, time, duration: Number(durationText), title, location, until });
        return `Class ${classId} saved: ${title}, every ${DAYS[weekday - 1]} at ${time} (${student.timezone}), ${durationText} minutes, through ${until}${location ? `, ${location}` : ''}.\nUse /classes to manage your timetable.`;
      }
      case 'classes': {
        const courses = this.store.courses(id);
        const entries = this.store.classes(id);
        return (entries.length ? entries.map(entry => `${entry.id}: ${entry.title}\n${courses.find(course => course.id === entry.courseId)?.name || `Course ${entry.courseId}`} — ${DAYS[entry.weekday - 1]} ${entry.time}, ${entry.duration} min\n${entry.location || 'No location'}; through ${entry.until}`).join('\n\n') : 'Your manual timetable is empty. Use /class to add a recurring class.') + `\n\nTimes use ${student.timezone}. Remove entries with /unclass ID.`;
      }
      case 'unclass': {
        const classId = positiveId(arg);
        return classId && this.store.removeClass(id, classId) ? 'Class removed from your timetable.' : 'Class not found in your timetable. Use /classes, then /unclass ID.';
      }
      default: return 'Choose an emoji button below, or use /help to open the main menu.';
    }
  }
}
