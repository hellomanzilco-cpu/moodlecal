import { DateTime, IANAZone } from 'luxon';
import { Store } from './store.ts';
import { formatTime, isActionable, isFocusItem, prepareText, priorityItems, upcomingClasses } from './planning.ts';
import type { Item, MessageOptions, Messenger, MoodleProfile, SharedProfilePage, Student } from './types.ts';
import { syncFailure } from './sync-errors.ts';
import {formatStatistics} from './statistics.ts';
import {profileField} from './profile-sharing.ts';
import {language,languageNames,intlLocale,tr,buttonCommand} from './locale.ts';
import {controlType,controlTime,isExam,preparationItems} from './exams.ts';

export interface BotServices {
  privacyUrl?:string;
  connectLink(studentId: number): string;
  rememberTelegramDisplayName?(studentId:number,firstName:string,lastName:string):void;
  clearConnectionDisplayName?(studentId:number):void;
  calendarLink(studentId: number, rotate?: boolean): string;
  sync(studentId: number): Promise<void>;
  claimPairing?(studentId:number, secret:string):Promise<boolean>;
  updatesStatus?(lang?:import('./locale.ts').Language): string;
  refresh?(studentId:number):Promise<string>;
  recentUpdates?(studentId:number):string;
  requestRefresh?(studentId:number):string;
  assignmentLink?(studentId:number,key:string):string;
  profile?(studentId:number):Promise<MoodleProfile>;
  examFiles?(studentId:number,courseId:number):Promise<string>;
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

For Connect Moodle, open the private sign-in window inside Telegram. Your password is used only to sign in and is not stored. Automatic website alerts require UWED’s event integration.`;

const MAIN_BUTTONS = [
  ['📝 Assignments', '🔄 Sync'],
  ['🧭 More', '⚙️ Settings'],
];
const ASSIGNMENT_BUTTONS = [['📅 Current deadlines this week', '🔜 Upcoming deadlines'], ['📨 Awaiting grades', '✅ Graded'], ['⚠️ Unverified'], ['⬅️ Main menu']];
const BUTTON_COMMANDS: Record<string, string> = {
  '🌐 Language':'languagemenu','🔐 Privacy':'privacy',
  '🎓 Exams':'exams','📎 Send preparation files':'examfiles',
  '🇬🇧 English':'lang_en','🇺🇿 O‘zbekcha':'lang_uz','🇷🇺 Русский':'lang_ru',
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
type Menu = 'main' | 'settings' | 'assignments' | 'prepare' | 'timezone' | 'disconnect' | 'more' | 'connection' | 'profile' | 'statistics' | 'sharing' | 'users' | 'language' | 'privacy' | 'exams' | 'exam';
interface MenuState { menu: Menu; expiresAt?: number;courseId?:number }
interface BotReply { text: string; options: MessageOptions; sensitive?:boolean }
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
  private pages = new Map<number,{command:string;arg:string;offset:number;total:number;size?:number}>();
  private connectionWindows = new Map<number,{url:string;expires:number}>();
  private assignmentButtons=new Map<number,Item[]>();
  private assignmentUrls=new Map<number,Map<string,string>>();
  private ownerTelegramId:number|null;
  private statisticsDays=new Map<number,1|7>();

  constructor(store: Store, messenger: Messenger, services: BotServices, defaultTimezone = 'Asia/Tashkent',ownerTelegramId:number|null=null) {
    this.store = store;
    this.messenger = messenger;
    this.services = services;
    this.defaultTimezone = defaultTimezone;
    this.ownerTelegramId=typeof ownerTelegramId==='number'&&Number.isSafeInteger(ownerTelegramId)&&ownerTelegramId>0?ownerTelegramId:null;
  }

  isTransientChatText(update:unknown):boolean{
    const envelope=record(update),message=record(envelope?.message),from=record(message?.from),chat=record(message?.chat);
    if(!message||!from||!chat||chat.type!=='private'||typeof message.text!=='string'||!Number.isSafeInteger(from.id)||Number(from.id)<=0||from.id!==chat.id)return false;
    const text=message.text.trim();
    if(!text||/^\/[a-z]+(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text)||buttonCommand(text,BUTTON_COMMANDS)||/^(?:📘|🎓) \d+:/.test(text))return false;
    const student=this.store.byTelegram(Number(from.id));
    return !student||this.menus.get(student.id)?.menu!=='timezone';
  }

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
      try{const action=record(JSON.parse(webApp.data))?.action;if(action==='connected')text='/start connected';else if(action==='refresh_connection')text='/connect';else if(action==='assignment_updated')text='📝 Assignments';}catch{ /* Never trust Mini App data as account authorization. */ }
    }
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
    await this.messenger.send(student.chatId, reply.text, reply.options);
    this.store.finishUpdate(updateId, nowSeconds());
  }

  private menuOptions(student: Student, menu: Menu): MessageOptions {
    if(menu==='language')return keyboard([[languageNames.uz,languageNames.ru],[languageNames.en],['⬅️ Settings']]);
    if(!student.moodleCipher || menu==='connection'){
      const url=this.connectionWindow(student.id);
      const button=new URL(url).protocol==='https:'?{text:'🔗 Connect Moodle',web_app:{url}}:{text:'🔗 Connect Moodle'};
      return {reply_markup:{keyboard:[[button],[{text:'🌐 Language'}],...(student.moodleCipher?[[{text:'⬅️ Main menu'}]]:[])],resize_keyboard:true,is_persistent:true,input_field_placeholder:'Connect Moodle to begin'}};
    }
    if(menu==='more')return keyboard([['🎓 Exams','📚 My courses'],['📅 This week','🗓 Calendar'],['👤 Profile','❓ Help'],...(this.isOwner(student)?[['📊 Bot statistics']]:[]),['⬅️ Main menu']]);
    if(menu==='exams'){
      const offset=this.pages.get(student.id)?.offset||0;
      const courses=this.store.courses(student.id).filter(c=>!c.muted).slice(offset,offset+6);
      return keyboard([...courses.map(c=>[`🎓 ${c.id}: ${c.name.slice(0,48)}`]),['⬅️ More','⬅️ Main menu']]);
    }
    if(menu==='exam')return keyboard([...(this.services.examFiles?[['📎 Send preparation files']]:[]),['🎓 Exams','⬅️ More'],['⬅️ Main menu']]);
    if(menu==='statistics'&&this.isOwner(student))return keyboard([...(this.services.sharedProfiles?[['👥 Users']]:[]),['📅 Today stats','🗓 7-day stats'],['🔄 Refresh stats'],['⬅️ More','⬅️ Main menu']]);
    if(menu==='users'&&this.isOwner(student))return keyboard([['🔄 Refresh users'],['📊 Bot statistics'],['⬅️ More','⬅️ Main menu']]);
    if(menu==='profile')return keyboard([...(this.sharingAvailable()?[['🔐 Profile sharing']]:[]),['🔗 Reconnect Moodle'],['⬅️ More','⬅️ Main menu']]);
    if(menu==='privacy')return keyboard([...(this.sharingAvailable()?[['🔐 Profile sharing']]:[]),['⬅️ Settings']]);
    if(menu==='sharing'&&this.sharingAvailable()){
      const enabled=this.services.sharingStatus!(student.id).enabled;
      return keyboard([[enabled?'✅ Yes, update shared profile':'✅ Yes, share my profile'],...(enabled?[['🚫 Stop sharing']]:[]),['⬅️ Settings']]);
    }
    if (menu === 'assignments') return keyboard(ASSIGNMENT_BUTTONS);
    if (menu === 'disconnect') return keyboard([['🗑 Yes, disconnect'], ['⬅️ Main menu']]);
    if (menu === 'settings' || menu === 'timezone') return keyboard([
      [student.paused ? '🔔 Resume alerts' : '🔔 Pause alerts', '🌍 Time zone'],
      ['🌐 Language','🔐 Privacy'],['ℹ️ Status', '🔗 Reconnect Moodle'], ['🔒 Disconnect','⬅️ Main menu'],
    ], menu === 'timezone' ? 'Type a time zone, e.g. Asia/Tashkent' : 'Choose a setting');
    if (menu === 'prepare') {
      const courses = this.store.courses(student.id).filter(course => !course.muted).slice(0, 40);
      return keyboard([...courses.map(course => [`📘 ${course.id}: ${course.name.slice(0, 55)}`]), ['📖 All courses'], ['⬅️ Main menu']]);
    }
    return keyboard(MAIN_BUTTONS);
  }
  private isOwner(student:Student):boolean{return this.ownerTelegramId!==null&&student.telegramId===this.ownerTelegramId;}
  private sharingAvailable():boolean{return this.ownerTelegramId!==null&&!!this.services.sharingStatus&&!!this.services.shareProfile&&!!this.services.revokeProfile;}
  private connectionWindow(id:number,force=false):string{
    const cached=this.connectionWindows.get(id);
    if(!force&&cached&&cached.expires>nowSeconds())return cached.url;
    const url=this.services.connectLink(id);this.connectionWindows.set(id,{url,expires:nowSeconds()+840});return url;
  }
  private async route(student: Student, text: string): Promise<BotReply> {
    const id = student.id;
    this.assignmentButtons.delete(id);
    this.assignmentUrls.delete(id);
    const slash = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text);
    const courseButton = /^📘 (\d+):/.exec(text);
    const examButton=/^🎓 ([1-9]\d*):/.exec(text);
    let command = slash ? slash[1].toLowerCase() : buttonCommand(text,BUTTON_COMMANDS);
    if(command==='disconnect')command='disconnectmenu';
    if(command==='autoupdate')command='sync';
    let arg = slash ? (slash[2] || '').trim() : '';
    const t=(source:string,values:Record<string,string|number>={})=>tr(language(student.language),source,values);
    if(command?.startsWith('lang_')||command==='language'&&['en','uz','ru'].includes(arg)){
      const selected=command.startsWith('lang_')?command.slice(5):arg;
      student.language=language(selected);this.store.patchStudent(id,{language:student.language});
      this.connectionWindows.delete(id);this.pages.delete(id);
      // An earlier consent or disconnect confirmation must not survive a
      // language change and be confirmed from a stale Telegram keyboard.
      this.menus.set(id,{menu:student.moodleCipher?'settings':'main'});
      const options=this.localizedOptions(this.menuOptions(student,student.moodleCipher?'settings':'main'),student);
      return {text:t('Language saved.')+'\n\n'+(student.moodleCipher?t('Language: {name}',{name:languageNames[student.language]}):this.welcome(student)),options,sensitive:true};
    }
    if(command==='language')command='languagemenu';
    if(command==='start'&&arg==='connect'){command='connect';arg='';}
    if(command==='nextpage'||command==='previouspage'){
      const page=this.pages.get(id);
      if(page){const size=page.size||6;page.offset=Math.max(0,Math.min(Math.floor((page.total-1)/size)*size,page.offset+(command==='nextpage'?size:-size)));command=page.command;arg=page.arg;}
      else command='menu';
    }else this.pages.delete(id);
    const state = this.menus.get(id);
    if (!command && courseButton) { command = 'prepare'; arg = courseButton[1]; }
    if(!command&&examButton){command='exam';arg=examButton[1];}
    if(command==='examfiles'&&!arg&&state?.menu==='exam'&&state.courseId)arg=String(state.courseId);
    if (!command && state?.menu === 'timezone') { command = 'timezone'; arg = text; }
    let menu: Menu = state?.menu ?? 'main';
    let reply: string;
    let personalizedReturn=false;
    const unstructuredText=!command&&!courseButton&&!examButton;
    if(command==='languagemenu'){
      menu='language';reply='🌐 '+t('Choose your language. You can change it later in Settings.')+'\n\n🇺🇿 O‘zbekcha · 🇷🇺 Русский · 🇬🇧 English';
    }else if(command==='privacy'){
      menu='privacy';reply=this.privacy(student);
    }else if(command==='connect'){
      menu='connection';reply=await this.command(student,'connect','');
    } else if(command==='start'&&arg==='connected'&&student.moodleCipher){
      command='assignments';arg='';menu='assignments';personalizedReturn=true;
      const greeting=`✅ <b>${t('Moodle connected')}</b>`;
      reply=greeting+'\n\n'+await this.command(student,'assignments','');
    } else if (command === 'start' || command === 'help' || command === 'menu') {
      if(command==='start')this.connectionWindows.delete(id);
      menu = 'main'; reply = command === 'help' ? this.help(student) : student.moodleCipher ? await this.command(student,'assignments','') : this.welcome(student);
      if(command==='start' && /^pair_[A-Za-z0-9_-]{43}$/.test(arg) && this.services.claimPairing) {
        try {
          const connected=await this.services.claimPairing(id,arg.slice(5));
          reply=connected ? '✅ Your Moodle account is connected and synced.\nTap 📝 Assignments to check outstanding work, awaiting grades, and graded submissions.\n\n'+HELP
            : 'This private setup link has expired or was already used. Tap 🔗 Connect Moodle to connect your own account.\n\n'+HELP;
        } catch { reply='Moodle could not be connected just now. Your setup link remains available until it expires; try opening it again.\n\n'+HELP; }
      }
    } else if(command==='more'){
      menu='more';reply='🧭 '+t('More')+'\n\n'+t('Choose what you need.');
    } else if (command === 'settings') {
      menu='settings';reply=t('⚙️ Settings')+'\n\n'+t('Language: {name}',{name:languageNames[language(student.language)]})+'\n'+t('Alerts: {state}',{state:t(student.paused?'paused':'enabled')})+'\n'+t('Time zone: {zone}',{zone:student.timezone});
    } else if(command==='profilesharing'){
      if(!student.moodleCipher||!this.sharingAvailable()){
        menu='settings';reply=t(student.moodleCipher?'Profile sharing is unavailable. Try again later.':'Connect Moodle first.');
      }else{
        const status=this.services.sharingStatus!(id);
        this.menus.set(id,{menu:'sharing',expiresAt:nowSeconds()+300});
        return {text:'🔐 '+t('Share profile with creator?')+'\n\n'+t('Currently: {state}',{state:t(status.enabled?'enabled':'paused')})+'\n\n'+t('If you agree, Tursunov Sunnatilla (@sunnatilla_tursunov) can see your Moodle first name, last name and username in a private user list. These details are stored encrypted until you stop sharing, reconnect or disconnect.')+'\n\n'+t('Sharing is optional. You can use all student features without it. Passwords, cookies, coursework and grades are not included.')+'\n\n'+t('You can stop sharing here at any time. This removes the saved shared profile; messages already delivered cannot be erased. Tap Yes only if you agree.'),options:this.localizedOptions(this.menuOptions(student,'sharing'),student)};
      }
    } else if(command==='confirmsharing'){
      menu='profile';
      if(!student.moodleCipher||!this.sharingAvailable()||state?.menu!=='sharing'||(state.expiresAt??0)<nowSeconds()){
        reply=t('Read the disclosure under Privacy → Profile sharing before confirming.');
      }else{
        try{await this.services.shareProfile!(id);reply='✅ '+t('Profile sharing enabled. You can update or stop sharing in Privacy → Profile sharing.');}
        catch{reply='⚠️ '+t('Profile sharing is unavailable. Try again later.');}
      }
    } else if(command==='revokesharing'){
      menu='settings';
      if(this.services.revokeProfile){this.services.revokeProfile(id);reply='✅ '+t('Profile sharing disabled. Your saved shared profile has been removed. Previously delivered messages cannot be erased.');}
      else reply=t('Profile sharing is unavailable. Try again later.');
    } else if (command === 'timezonemenu') {
      menu='timezone';reply=t('🌍 Time zone')+'\n\n'+t('Type an IANA time zone, e.g. Asia/Tashkent.');
    } else if (command === 'disconnectmenu') {
      this.menus.set(id, { menu: 'disconnect', expiresAt: nowSeconds() + 300 });
      return {text:'🔒 '+t('Disconnect Moodle?')+'\n\n'+t('This deletes your saved bot connection, courses, timetable and calendar links. Your work in Moodle stays in Moodle.'),options:this.localizedOptions(this.menuOptions(student,'disconnect'),student)};
    } else if (command === 'confirmdisconnect') {
      menu = 'main';
      reply = state?.menu === 'disconnect' && (state.expiresAt ?? 0) >= nowSeconds()
        ? await this.command(student, 'disconnect', '')
        : 'Open ⚙️ Settings → 🔒 Disconnect to review and confirm deleting your connection.';
    } else if (command === 'preparemenu') {
      menu = student.moodleCipher ? 'prepare' : 'main';
      reply=student.moodleCipher?t('📖 Prepare')+'\n\n'+t('Choose a course to prepare for class.'):await this.command(student,'prepare','');
    } else if (['assignments', 'outstanding', 'upcoming', 'awaiting', 'graded', 'unverified'].includes(command ?? '')) {
      menu = student.moodleCipher ? 'assignments' : 'main';
      reply = await this.command(student, command!, arg);
    } else if (command) {
      if (['pause', 'resume', 'status'].includes(command) && !slash) menu = 'settings';
      else if(command==='sync')menu='main';
      else if(command==='profile')menu='profile';
      else if(command==='exams')menu='exams';
      else if(command==='exam'||command==='examfiles')menu='exam';
      else if(['stats','statstoday','statsweek','refreshstats'].includes(command))menu=this.isOwner(student)?'statistics':'more';
      else if(command==='users')menu=this.isOwner(student)?'users':'more';
      else if (command === 'timezone') menu = IANAZone.isValidZone(arg) ? 'settings' : 'timezone';
      else if (['disconnect', 'today', 'week', 'priorities', 'calendar'].includes(command)) menu = 'main';
      else if (command === 'courses') {menu = student.moodleCipher ? 'prepare' : 'main';if(!slash)arg='menu';}
      reply = await this.command(student, command, arg);
    } else {
      menu = !student.moodleCipher||state?.menu==='connection'?'connection':'main';
      reply=t('Choose a button below')+'\n\n'+t('Connect inside Telegram. Never send your password in chat.');
    }
    if (this.store.getStudent(id)) this.menus.set(id, { menu,...(menu==='exam'&&positiveId(arg)?{courseId:positiveId(arg)!}:{}) });
    else this.menus.delete(id);
    const options=this.menuOptions(this.store.getStudent(id) ?? {...student,moodleCipher:null}, menu);
    if (['assignments', 'outstanding', 'upcoming', 'awaiting', 'graded', 'unverified'].includes(command ?? '')||student.moodleCipher&&['start','menu'].includes(command??'')) options.parse_mode = 'HTML';
    if(['privacy','calendar','today','week','priorities','exams','exam'].includes(command??''))options.parse_mode='HTML';
    if(student.moodleCipher&&this.services.assignmentLink&&options.reply_markup){
      const buttons=(this.assignmentButtons.get(id)||[]).filter(item=>/^assignment:[1-9]\d*$/.test(item.key)).map(item=>[{text:'📄 '+item.title.slice(0,48),web_app:{url:this.taskUrl(student,item)}}]);
      options.reply_markup.keyboard.unshift(...buttons);
    }
    const page=this.pages.get(id);
    if(page && page.total>(page.size||6) && options.reply_markup){
      const navigation=[];
      if(page.offset>0)navigation.push({text:'⬅️ Previous page'});
      if(page.offset+(page.size||6)<page.total)navigation.push({text:'➡️ Next page'});
      options.reply_markup.keyboard.unshift(navigation);
    }
    return {text:reply,options:this.localizedOptions(options,student),sensitive:unstructuredText||personalizedReturn||command==='connect'||command==='profile'||!!this.assignmentUrls.get(id)?.size||['stats','statstoday','statsweek','refreshstats','users'].includes(command??'')};
  }

  private localizedOptions(options:MessageOptions,student:Student):MessageOptions{
    const lang=language(student.language),markup=options.reply_markup;
    if(!markup)return options;
    return {...options,reply_markup:{...markup,input_field_placeholder:tr(lang,markup.input_field_placeholder||'Choose a button below'),keyboard:markup.keyboard.map(row=>row.map(button=>({...button,text:tr(lang,button.text)})))}};
  }
  private welcome(student:Student):string{
    const t=(source:string)=>tr(language(student.language),source);
    return '🎓 Moodle Calendar\n'+t('Your deadlines, in one place.')+'\n\n'+t('Connect your Moodle account to see assignment deadlines, submission status and grades.')+'\n\n'+t('Tap Connect Moodle below. Sign in with your usual Moodle username and password inside Telegram. No separate registration.')+'\n\n🔐 '+t('Your password is never saved. Your access token is encrypted. You can disconnect anytime.')+'\n\n'+t('Independent app by Tursunov Sunnatilla · not created by UWED.')+'\n@sunnatilla_tursunov';
  }
  private help(student:Student):string{
    const t=(source:string)=>tr(language(student.language),source);
    return '❓ '+t('Help')+'\n\n'+t('1. Connect Moodle.\n2. Open Assignments to read tasks and submit work.\n3. Tap Sync to check for changes.')+'\n\n'+t('Automatic website alerts require UWED’s event integration.')+'\n\n'+t('Independent app by Tursunov Sunnatilla · not created by UWED.')+'\n@sunnatilla_tursunov';
  }
  private privacy(student:Student):string{
    const t=(source:string)=>tr(language(student.language),source);
    return '🔐 <b>'+t('Your account, your choice.')+'</b>\n\n'+[
      'Passwords are used for sign-in only and are never stored. Encrypted Moodle access tokens let the bot read your own courses.',
      'Usage statistics are aggregate counts. Connection diagnostics can include your Telegram display name and a safe error reason for support.',
      'Sharing your Moodle name and username with the creator is optional and off by default.',
      'Disconnect removes your active bot records. Existing Telegram messages, Moodle submissions and retained encrypted backups are not erased.',
    ].map(t).join('\n\n')+(this.services.privacyUrl?'\n\n'+this.link(t('Read the privacy notice'),this.services.privacyUrl+'?lang='+language(student.language)):'')+'\n@sunnatilla_tursunov';
  }
  private link(title:string,url:string):string{
    try{const parsed=new URL(url);if(parsed.protocol==='https:'&&!parsed.username&&!parsed.password)return '<a href="'+escapeHtml(parsed.href,2000)+'">'+escapeHtml(title,160)+'</a>';}catch{}
    return escapeHtml(title,160);
  }
  private taskUrl(student:Student,item:Item):string{
    if(!this.services.assignmentLink||!/^assignment:[1-9]\d*$/.test(item.key))return item.url;
    let urls=this.assignmentUrls.get(student.id);if(!urls){urls=new Map();this.assignmentUrls.set(student.id,urls);}
    if(!urls.has(item.key))urls.set(item.key,this.services.assignmentLink(student.id,item.key));
    return urls.get(item.key)!;
  }
  private date(student:Student,seconds:number):string{return DateTime.fromSeconds(seconds,{zone:student.timezone,locale:intlLocale[language(student.language)]}).toFormat('ccc d LLL, HH:mm');}
  private page<T>(id:number,command:string,arg:string,items:T[],size=6):{items:T[];footer:string}{
    const existing=this.pages.get(id);
    const offset=existing?.command===command && existing.arg===arg ? existing.offset : 0;
    this.pages.set(id,{command,arg,offset,total:items.length,size});
    return {items:items.slice(offset,offset+size),footer:items.length>size?`\n\n${offset+1}–${Math.min(offset+size,items.length)} of ${items.length}`:''};
  }

  private coverage(student: Student): string {
    return this.assignmentCoverage(student);
  }
  private itemLine(item: Item, student:Student): string {
    const task = item.kind === 'assignment' || item.kind === 'quiz';
    const time = task ? item.dueAt : item.startsAt ?? item.dueAt;
    const label = item.key.startsWith('class:') ? 'Class' : task ? 'Due' : item.kind === 'resource' ? 'Material' : item.startsAt !== null ? 'Event' : 'Due';
    return this.link(item.title,item.kind==='assignment'?this.taskUrl(student,item):item.url)+'\n'+escapeHtml(item.courseName,120)+(time!==null?'\n'+tr(language(student.language),'Due: {time}',{time:this.date(student,time)}):'')+(item.key.startsWith('class:')?'\n'+escapeHtml(item.description,200):'');
  }

  private assignmentLine(item:Item,student:Student,now:number,index:number):string {
    const t=(source:string,values:Record<string,string|number>={})=>tr(language(student.language),source,values);
    const lines=[index+'. '+this.link(item.title,this.taskUrl(student,item)),escapeHtml(item.courseName,120)];
    const access={open:'Available now',upcoming:'Not open yet',restricted:'Restricted',closed:'Submissions closed',unknown:'Availability unknown'} as const;
    lines.push((item.availability==='open'?'🟢 ':'')+t(access[item.availability||'unknown']));
    if(item.availability!=='open'&&item.availabilityReason)lines.push(escapeHtml(item.availabilityReason,180));
    if(item.availability==='upcoming'&&item.availableFrom)lines.push(t('Opens: {time}',{time:this.date(student,item.availableFrom)}));
    if(item.dueAt===null)lines.push('📅 '+t('Deadline unavailable'));
    else {
      lines.push('📅 '+t('Due: {time}',{time:this.date(student,item.dueAt)}));
      const due=DateTime.fromSeconds(item.dueAt,{zone:student.timezone}),current=DateTime.fromSeconds(now,{zone:student.timezone});
      if (item.dueAt <= now) lines.push('⌛ '+t('Deadline passed'));
      else {
        const days = Math.round(due.startOf('day').diff(current.startOf('day'), 'days').days);
        if(days<2)lines.push('⌛ '+t(days===0?'Due today':'Due tomorrow'));
      }
    }
    return lines.join('\n');
  }

  private assignmentCoverage(student: Student): string {
    const t=(source:string)=>tr(language(student.language),source);
    const notes: string[] = [];
    const syncFailed = student.lastError?.startsWith('Sync failed.') ?? false;
    const stale = student.lastSyncAt !== null && nowSeconds() - student.lastSyncAt > 15 * 60;
    if (syncFailed) {
      notes.push('⚠️ '+t('Showing saved data. The last sync failed. Verify deadlines in Moodle.'));
    } else {
      if(stale)notes.push('🕒 '+t('Saved data may be out of date. Tap Sync to check Moodle.'));
      if(student.lastError)notes.push('🟠 '+t('Limited Moodle coverage. Some activities may be unavailable.'));
    }
    if (student.paused) notes.push(t('Notifications are paused in Settings.'));
    return notes.length ? `\n\n${notes.join('\n')}` : '';
  }

  private async command(student: Student, command: string, arg: string): Promise<string> {
    const id = student.id;
    const now = nowSeconds();
    const t=(source:string,values:Record<string,string|number>={})=>tr(language(student.language),source,values);
    if (command === 'start' || command === 'help') return this.help(student);
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
      const url=this.connectionWindow(id,true);
      return t('🔗 Connect Moodle')+'\n\n'+t('Connect inside Telegram. Never send your password in chat.')+'\n\n'+t('Your password is never saved. Your access token is encrypted. You can disconnect anytime.')+'\n\n'+t('Independent app by Tursunov Sunnatilla · not created by UWED.')+(new URL(url).protocol==='https:'?'':'\n'+url);
    }
    if (command === 'disconnect') {
      this.store.deleteStudent(id);
      this.services.clearConnectionDisplayName?.(id);
      this.manualSyncs.delete(id);
      this.pages.delete(id);
      this.connectionWindows.delete(id);
      this.statisticsDays.delete(id);
      this.assignmentUrls.delete(id);return t('Disconnected. Your active bot records and private calendar links have been removed.');
    }
    if (command === 'timezone') {
      if (!arg || arg.length > 100 || !IANAZone.isValidZone(arg)) return 'Use a valid IANA time zone, for example /timezone Asia/Tashkent or /timezone Europe/London.';
      this.store.patchStudent(id, { timezone: arg });
      return t('Time zone saved: {zone}',{zone:arg});
    }
    if (command === 'pause' || command === 'resume') {
      this.store.patchStudent(id, { paused: command === 'pause' });
      if (command === 'pause') return t('Alerts paused. You can still use Sync.');
      if (student.moodleCipher) {
        if(this.services.requestRefresh){try{return t('Alerts enabled.')+'\n\n'+this.services.requestRefresh(id);}catch(error){return t('Alerts enabled.')+'\n\n'+syncFailure(error,language(student.language));}}
        try { await this.services.sync(id); }
        catch { return 'Notifications are enabled. Moodle could not be refreshed just now; your saved information is still available.'; }
      }
      return t('Alerts enabled.');
    }
    if (command === 'status') {
      const attempt=Number(this.store.getMeta(`lastSyncAttempt:${id}`));
      const queued=!!this.store.db.prepare('SELECT 1 FROM manual_sync_jobs WHERE studentId=?').get(id);
      return t('ℹ️ Status')+'\n\n'+t(student.moodleCipher?'Moodle connected':'Not connected')+'\n'+t('Last successful sync: {time}',{time:student.lastSyncAt?this.date(student,student.lastSyncAt):t('Not synced yet')})+'\n'+t('Sync: {state}',{state:t(queued?'queued / running':'idle')})+'\n'+t('Courses: {count}',{count:this.store.courses(id).length})+'\n\n'+(this.services.updatesStatus?.(language(student.language))||t('Automatic website updates await a university-enabled event connection.'))+this.coverage(student);
    }
    const connectedCommands = new Set(['courses', 'today', 'week', 'priorities', 'prepare', 'assignments', 'outstanding', 'upcoming', 'awaiting', 'graded', 'unverified', 'done', 'undo', 'mute', 'unmute', 'calendar', 'sync', 'autoupdate','recentupdates','class', 'classes', 'unclass','profile','exams','exam','examfiles']);
    if (connectedCommands.has(command) && !student.moodleCipher) return t('Connect Moodle first.')+'\n'+t('Connect inside Telegram. Never send your password in chat.');

    switch (command) {
      case 'exams': {
        const courses=this.store.courses(id).filter(c=>!c.muted),items=this.store.rawItems(id);
        const page=this.page(id,'exams','',courses);
        const entries=page.items.map(c=>'<b>'+escapeHtml(c.name,140)+'</b>\n'+t('Midterm controls: {count}',{count:items.filter(x=>x.courseId===c.id&&isExam(x)&&controlType(x)==='midterm').length})+' · '+t('Final controls: {count}',{count:items.filter(x=>x.courseId===c.id&&isExam(x)&&controlType(x)==='final').length}));
        return '<b>'+t('🎓 Exams')+'</b>\n\n'+t('Choose a subject for controls, dates and preparation materials.')+'\n\n'+(entries.join('\n\n')||t('No courses have been synced yet.'))+(page.footer?'\n\n'+t('Showing {from}–{to} of {total}',{from:(this.pages.get(id)?.offset||0)+1,to:(this.pages.get(id)?.offset||0)+page.items.length,total:courses.length}):'')+'\n\n'+t('Talaba UWED exam appointments are not connected. These are Moodle controls and materials.')+'\n'+t('Only teacher-labelled controls are listed. An assignment deadline is not an exam appointment.')+'\n'+t('Use Sync to check Moodle for changes.')+this.coverage(student);
      }
      case 'exam': {
        const courseId=positiveId(arg),course=this.store.courses(id).find(c=>c.id===courseId&&!c.muted);
        if(!course)return t('This course is not available in your Moodle connection.');
        const items=this.store.rawItems(id),controls=items.filter(x=>x.courseId===course.id&&isExam(x)).sort((a,b)=>(controlTime(a)??Infinity)-(controlTime(b)??Infinity)||a.title.localeCompare(b.title));
        const page=this.page(id,'exam',arg,controls,4);this.assignmentButtons.set(id,page.items);
        const link=(title:string,url:string)=>this.link(title.slice(0,100),url.length<=240?url:'');
        const stage=(item:Item)=>t(controlType(item)==='midterm'?'Midterm control':controlType(item)==='final'?'Final control':'Exam');
        const entries=page.items.map(item=>{
          const dates=item.kind==='quiz'?[item.availableFrom?t('Opens: {time}',{time:this.date(student,item.availableFrom)}):'',item.dueAt?t('Closes: {time}',{time:this.date(student,item.dueAt)}):''].filter(Boolean):item.kind==='event'?[item.startsAt?t('Starts: {time}',{time:this.date(student,item.startsAt)}):'']:item.dueAt?[t('Submission deadline: {time}',{time:this.date(student,item.dueAt)})]:[];
          const status=item.submissionStatus==='submitted_graded'?t('Submitted and graded'):item.submissionStatus==='submitted_ungraded'?t('Submitted · awaiting grade'):item.completed?t('Completed in Moodle'):item.availability==='restricted'?t('Restricted in Moodle'):item.availability==='upcoming'?t('Not open yet'):item.availability==='closed'?t('Closed in Moodle'):t('See Moodle for access and status');
          return stage(item)+'\n'+link(item.title,item.kind==='assignment'?this.taskUrl(student,item):item.url)+'\n'+(dates.filter(Boolean).join('\n')||t('Date not published'))+'\n'+status;
        });
        const resources=preparationItems(items,course.id),shown=resources.slice(0,3);
        const links=shown.map(item=>'• '+link(item.title,item.kind==='assignment'?this.taskUrl(student,item):item.url)+(item.files?.length?' · '+t('{count} files',{count:item.files.length}):''));
        return '<b>'+escapeHtml(course.name,180)+'</b>\n\n'+(entries.join('\n\n')||t('No teacher-labelled controls have been published in the data Moodle returned.'))+(page.footer?'\n\n'+t('Showing {from}–{to} of {total}',{from:(this.pages.get(id)?.offset||0)+1,to:(this.pages.get(id)?.offset||0)+page.items.length,total:controls.length}):'')+'\n\n<b>'+t('Preparation materials')+'</b>\n'+(links.join('\n')||t('No accessible preparation files have been published for this course.'))+(resources.length>shown.length?'\n'+t('More preparation materials are available through Send preparation files.'):'')+'\n\n'+t('Only teacher-labelled controls are listed. An assignment deadline is not an exam appointment.')+'\n🕒 '+(student.lastSyncAt?t('Updated: {time}',{time:this.date(student,student.lastSyncAt)}):t('Not synced yet'))+this.coverage(student);
      }
      case 'examfiles': {
        const courseId=positiveId(arg);
        if(!courseId||!this.store.courses(id).some(c=>c.id===courseId&&!c.muted))return t('Choose a subject under Exams first.');
        if(!this.services.examFiles)return t('Preparation file delivery is unavailable. Open the resource links in Moodle.');
        try{return await this.services.examFiles(id,courseId);}catch{return t('Preparation files could not be verified with Moodle. Open Moodle directly or try again later.');}
      }
      case 'profile': {
        try{
          if(!this.services.profile)throw new Error('Profile unavailable');
          const profile=await this.services.profile(id);
          const field=(value:string)=>profileField(value)||t('Not provided by Moodle');
          const sharing=this.sharingAvailable()?'\n'+t('Profile sharing with creator: {state}',{state:t(this.services.sharingStatus!(id).enabled?'enabled':'paused')}):'';
          return '👤 '+t('Your Moodle profile')+'\n\n'+t('First name: {name}',{name:field(profile.firstName)})+'\n'+t('Last name: {name}',{name:field(profile.lastName)})+'\n'+t('Username: {name}',{name:field(profile.username)})+'\n'+t('Password: Not stored')+sharing;
        }catch{
          return '👤 '+t('Profile unavailable. Try again later or reconnect in Settings.')+'\n\n'+t('Password: Not stored');
        }
      }
      case 'recentupdates': return this.services.recentUpdates?.(id) || '📰 No recorded website changes yet.';
      case 'courses': {
        const courses = this.store.courses(id);
        return (courses.length?t('📚 My courses')+'\n\n'+(arg==='menu'?t('Choose a course to prepare for class.'):courses.map(course=>course.id+': '+course.name).join('\n')):t('No courses have been synced yet. Tap Sync.'))+this.coverage(student);
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
        return t(command==='today'?'🏠 Today':'📅 This week')+' · '+student.timezone+'\n\n'+(items.length?page.items.map(item=>this.itemLine(item,student)).join('\n\n'):t('No unfinished deadlines or scheduled classes.'))+page.footer+this.coverage(student);
      }
      case 'priorities': {
        const items = priorityItems(this.store.items(id), now);
        const page=this.page(id,command,arg,items);
        return t('🎯 Priorities')+'\n\n'+(items.length?page.items.map(item=>this.itemLine(item,student)).join('\n\n'):t('No current unfinished tasks found.'))+page.footer+this.coverage(student);
      }
      case 'prepare': {
        const courseId = arg ? positiveId(arg) : undefined;
        if (arg && (!courseId || !this.store.courses(id).some(course => course.id === courseId))) return 'Course not found in your enrolled courses. Use /courses, then /prepare COURSE_ID.';
        return prepareText(this.store.items(id),courseId??undefined,language(student.language))+this.coverage(student);
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
        const next=assignments.filter(item=>item.submissionStatus==='outstanding'&&item.dueAt!==null&&item.dueAt>=now&&isActionable(item,now)).sort((a,b)=>a.dueAt!-b.dueAt!)[0];
        const summary=t('📝 Assignments')+'\n\n<b>'+t('Unfinished: {count}',{count:totalUnfinished})+'</b>\n'+t('This week / overdue: {count}',{count:counts.outstanding})+'\n'+t('Later / undated: {count}',{count:counts.upcoming})+'\n\n'+t('Awaiting grades: {count}',{count:counts.awaiting})+' · '+t('Graded: {count}',{count:counts.graded})+(unknown.length?'\n⚠️ '+t('Unverified: {count}',{count:unknown.length}):'')+(next?'\n\n'+t('Next: {title}',{title:escapeHtml(next.title)})+'\n'+this.date(student,next.dueAt!):'')+'\n\n🕒 '+(student.lastSyncAt?t('Updated: {time}',{time:this.date(student,student.lastSyncAt)}):t('Not synced yet'));
        const unknownNotice=unknown.length?'\n\n⚠️ '+t('Moodle has not verified these statuses. Upload is enabled only after a fresh Moodle check confirms access.'):'';
        if(command==='assignments')return summary+'\n\n'+t(assignments.length?'Choose a category below.':'No assignments have been synced yet.')+this.coverage(student);
        const status = statuses[command];
        const filtered = assignments.filter(item => command==='unverified'?(!item.submissionStatus||item.submissionStatus==='unknown'):item.submissionStatus === status && (command === 'outstanding' ? currentWork(item) : command === 'upcoming' ? !currentWork(item) : true)).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.title.localeCompare(b.title));
        const headings={outstanding:'📅 Current deadlines this week',upcoming:'🔜 Upcoming deadlines',awaiting:'📨 Awaiting grades',graded:'✅ Graded',unverified:'⚠️ Unverified'};
        const page=this.page(id,command,arg,filtered);
        this.assignmentButtons.set(id,page.items);
        const firstNumber = (this.pages.get(id)?.offset ?? 0) + 1;
        const entries=page.items.map((item,index)=>this.assignmentLine(item,student,now,firstNumber+index)+(command==='graded'?'\n'+t('Grade: {grade}',{grade:escapeHtml(item.grade||t('See Moodle for grade details'))}):''));
        const footer=page.footer?'\n\n'+t('Showing {from}–{to} of {total}',{from:firstNumber,to:firstNumber+page.items.length-1,total:filtered.length}):'';
        const hint=entries.length?'\n\n'+t('Open a task to read its instructions or submit your work.'):'';
        return '<b>'+t(headings[command])+'</b>\n\n'+(entries.length?entries.join('\n\n'):t('No assignments in this category.'))+footer+hint+(command==='unverified'?unknownNotice:'')+this.assignmentCoverage(student);
      }
      case 'done':
      case 'undo': {
        if (!arg || arg.length > 300 || !this.store.markDone(id, arg, command === 'done')) return 'Item not found in your saved Moodle items. Copy an item key from /priorities or /prepare.';
        return command === 'done' ? 'Marked complete in Moodle Calendar. This does not submit work or change completion in Moodle.' : 'Removed your personal completion mark. Any completion recorded in Moodle still applies.';
      }
      case 'calendar':
        if (arg && arg.toLowerCase() !== 'rotate') return 'Use /calendar to get your private subscription, or /calendar rotate to revoke the old link.';
        return '🗓 '+this.link(t('Private calendar subscription'),this.services.calendarLink(id,arg.toLowerCase()==='rotate'))+'\n\n'+t('Subscribe by URL in Google Calendar, Apple Calendar or Outlook. Keep this private link to yourself; anyone with it can read your calendar. Refresh timing depends on your calendar app.')+'\n\n/calendar rotate';
      case 'sync': {
        const previous = this.manualSyncs.get(id) ?? 0;
        if (now - previous < 15) return t('Please wait {seconds} seconds before syncing again.',{seconds:15-(now-previous)});
        this.manualSyncs.set(id, now);
        try {
          if(this.services.requestRefresh)return this.services.requestRefresh(id);
          if(this.services.refresh)return await this.services.refresh(id);
          await this.services.sync(id);
          const current = this.store.getStudent(id);
          return `Moodle sync finished. Return to the main menu for Today, Priorities, or My courses.${current ? this.coverage(current) : ''}`;
        } catch(error) {
          return syncFailure(error,language(student.language));
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
