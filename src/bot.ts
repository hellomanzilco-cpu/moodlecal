import { DateTime, IANAZone } from 'luxon';
import { Store } from './store.ts';
import { currentAssignmentKeys, formatTime, isActionable, isFocusItem, prepareText, priorityItems, upcomingClasses } from './planning.ts';
import type { Item, MessageOptions, Messenger, Student } from './types.ts';

export interface BotServices {
  connectLink(studentId: number): string;
  calendarLink(studentId: number, rotate?: boolean): string;
  sync(studentId: number): Promise<void>;
  claimPairing?(studentId:number, secret:string):Promise<boolean>;
  updatesStatus?(): string;
  refresh?(studentId:number):Promise<string>;
  recentUpdates?(studentId:number):string;
}

const HELP = `🎓 Welcome to Moodle Calendar

Use the buttons below to follow your UWED courses.

🏠 Today and 📅 This week — deadlines and classes
🎯 Priorities — next deadline per course and overdue work
📝 Assignments — current deadlines, later tasks, and submission grades
📖 Prepare — course materials and preparation checklist
🗓 Calendar — your private calendar subscription
🔄 Auto update — pull Moodle now and show what changed
📰 Recent updates — your saved change history
⚙️ Settings — alerts, time zone, sync, and account connection

Start with 🔗 Connect Moodle if your account is not connected.
Never send Moodle passwords or tokens in Telegram. Enter them only on the private connection page.

Your timetable is entered manually. Advanced commands remain available: /class, /classes, /unclass, /mute, /unmute, /done ITEM_KEY, and /undo ITEM_KEY.`;

const MAIN_BUTTONS = [
  ['🏠 Today', '📅 This week'],
  ['🎯 Priorities', '📚 My courses'],
  ['📝 Assignments', '📖 Prepare'],
  ['🔄 Auto update', '📰 Recent updates'],
  ['🗓 Calendar', '⚙️ Settings'],
  ['🔗 Connect Moodle'],
];
const ASSIGNMENT_BUTTONS = [['⏳ Next deadlines', '🕓 Later / undated'], ['📨 Awaiting grades', '✅ Graded'], ['⬅️ Main menu']];
const BUTTON_COMMANDS: Record<string, string> = {
  '🏠 Today': 'today', '📅 This week': 'week', '🎯 Priorities': 'priorities',
  '📚 My courses': 'courses', '📝 Assignments': 'assignments', '📖 Prepare': 'preparemenu',
  '🗓 Calendar': 'calendar', '⚙️ Settings': 'settings', '🔗 Connect Moodle': 'connect',
  '🔔 Pause alerts': 'pause', '🔔 Resume alerts': 'resume', '🌍 Time zone': 'timezonemenu',
  '🔄 Sync now': 'sync', 'ℹ️ Status': 'status', '🔒 Disconnect': 'disconnectmenu',
  '⬅️ Main menu': 'menu', '🗑 Yes, disconnect': 'confirmdisconnect',
  '⏳ Outstanding': 'outstanding', '📨 Awaiting grades': 'awaiting', '✅ Graded': 'graded',
  '⏳ Active now': 'outstanding', '🕓 Upcoming / locked': 'upcoming',
  '⏳ Next deadlines':'outstanding','🕓 Later / undated':'upcoming',
  '📖 All courses': 'prepare',
  '🔄 Auto update':'autoupdate','📰 Recent updates':'recentupdates',
};
type Menu = 'main' | 'settings' | 'assignments' | 'prepare' | 'timezone' | 'disconnect';
interface MenuState { menu: Menu; expiresAt?: number }
interface BotReply { text: string; options: MessageOptions }
const keyboard = (rows: string[][], placeholder = 'Choose a button below'): MessageOptions => ({ reply_markup: {
  keyboard: rows.map(row => row.map(text => ({ text }))), resize_keyboard: true, is_persistent: true,
  one_time_keyboard: false, input_field_placeholder: placeholder,
} });

const CLASS_USAGE = 'Use /class COURSE_ID | Mon | 09:00 | 80 | Seminar | Room 204 | 2026-12-31\nDays: Mon, Tue, Wed, Thu, Fri, Sat, Sun. The final date is your semester end date. Times use your /timezone. Check your course IDs with /courses.';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const nowSeconds = () => Math.floor(Date.now() / 1000);
const positiveId = (value: string): number | null => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export class Bot {
  private store: Store;
  private messenger: Messenger;
  private services: BotServices;
  private defaultTimezone: string;
  private manualSyncs = new Map<number, number>();
  private menus = new Map<number, MenuState>();

  constructor(store: Store, messenger: Messenger, services: BotServices, defaultTimezone = 'Asia/Tashkent') {
    this.store = store;
    this.messenger = messenger;
    this.services = services;
    this.defaultTimezone = defaultTimezone;
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
    if (!message || !from || !chat || chat.type !== 'private' || from.is_bot === true ||
        !Number.isSafeInteger(from.id) || Number(from.id) <= 0 || from.id !== chat.id || typeof message.text !== 'string') {
      this.store.finishUpdate(updateId, nowSeconds());
      return;
    }
    const student = this.store.ensureStudent(Number(from.id), Number(chat.id), this.defaultTimezone);
    const reply = await this.route(student, message.text.trim());
    // A transport retry must resend the same response, not repeat a class addition
    // or rotate a private calendar link for the same Telegram update.
    this.store.cacheReply(updateId, student.chatId, JSON.stringify({ moodleCalendarReply: 1, ...reply }), nowSeconds());
    await this.messenger.send(student.chatId, reply.text, reply.options);
    this.store.finishUpdate(updateId, nowSeconds());
  }

  private menuOptions(student: Student, menu: Menu): MessageOptions {
    if (menu === 'assignments') return keyboard(ASSIGNMENT_BUTTONS);
    if (menu === 'disconnect') return keyboard([['🗑 Yes, disconnect'], ['⬅️ Main menu']]);
    if (menu === 'settings' || menu === 'timezone') return keyboard([
      [student.paused ? '🔔 Resume alerts' : '🔔 Pause alerts', '🌍 Time zone'],
      ['🔄 Auto update', 'ℹ️ Status'], ['🔒 Disconnect'], ['⬅️ Main menu'],
    ], menu === 'timezone' ? 'Type a time zone, e.g. Asia/Tashkent' : 'Choose a setting');
    if (menu === 'prepare') {
      const courses = this.store.courses(student.id).filter(course => !course.muted).slice(0, 40);
      return keyboard([...courses.map(course => [`📘 ${course.id}: ${course.name.slice(0, 55)}`]), ['📖 All courses'], ['⬅️ Main menu']]);
    }
    return keyboard(MAIN_BUTTONS);
  }

  private async route(student: Student, text: string): Promise<BotReply> {
    const id = student.id;
    const slash = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text);
    const courseButton = /^📘 (\d+):/.exec(text);
    let command = slash ? slash[1].toLowerCase() : BUTTON_COMMANDS[text];
    let arg = slash ? (slash[2] || '').trim() : '';
    const state = this.menus.get(id);
    if (!command && courseButton) { command = 'prepare'; arg = courseButton[1]; }
    if (!command && state?.menu === 'timezone') { command = 'timezone'; arg = text; }
    let menu: Menu = state?.menu ?? 'main';
    let reply: string;
    if (command === 'start' || command === 'help' || command === 'menu') {
      menu = 'main'; reply = command === 'menu' ? '🏠 Main menu\nChoose what you want to check.' : HELP;
      if(command==='start' && /^pair_[A-Za-z0-9_-]{43}$/.test(arg) && this.services.claimPairing) {
        try {
          const connected=await this.services.claimPairing(id,arg.slice(5));
          reply=connected ? '✅ Your Moodle account is connected and synced.\nTap 📝 Assignments to check outstanding work, awaiting grades, and graded submissions.\n\n'+HELP
            : 'This private setup link has expired or was already used. Tap 🔗 Connect Moodle to connect your own account.\n\n'+HELP;
        } catch { reply='Moodle could not be connected just now. Your setup link remains available until it expires; try opening it again.\n\n'+HELP; }
      }
    } else if (command === 'settings') {
      menu = 'settings'; reply = `⚙️ Settings\nAlerts: ${student.paused ? 'paused' : 'enabled'}\nTime zone: ${student.timezone}\nChoose a setting below.`;
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
    } else if (['assignments', 'outstanding', 'upcoming', 'awaiting', 'graded'].includes(command ?? '')) {
      menu = student.moodleCipher ? 'assignments' : 'main';
      reply = await this.command(student, command!, arg);
    } else if (command) {
      if (['pause', 'resume', 'sync', 'status'].includes(command) && !slash) menu = 'settings';
      else if (command === 'timezone') menu = IANAZone.isValidZone(arg) ? 'settings' : 'timezone';
      else if (['disconnect', 'connect', 'today', 'week', 'priorities', 'calendar'].includes(command)) menu = 'main';
      else if (command === 'courses') menu = student.moodleCipher ? 'prepare' : 'main';
      reply = await this.command(student, command, arg);
    } else {
      menu = 'main';
      reply = 'Choose an emoji button below. Never send Moodle passwords or tokens here; tap 🔗 Connect Moodle to open the secure connection page.';
    }
    if (this.store.getStudent(id)) this.menus.set(id, { menu });
    else this.menus.delete(id);
    return { text: reply, options: this.menuOptions(this.store.getStudent(id) ?? student, menu) };
  }

  private coverage(student: Student): string {
    const notes: string[] = [];
    if (!student.initialized) notes.push('The first Moodle sync has not completed yet.');
    if (student.lastSyncAt !== null && nowSeconds() - student.lastSyncAt > 15 * 60) notes.push(`Saved data may be out of date. Last synced: ${formatTime(student.lastSyncAt, student.timezone)}. Open Settings → Sync now to refresh.`);
    if (student.lastError) notes.push('The last sync reported an access or coverage problem. Some course content or deadlines may be missing; check Moodle directly.');
    if (student.paused) notes.push('Background notifications are paused. Open Settings → Resume alerts to turn them on.');
    return notes.length ? `\n\n${notes.join('\n')}` : '';
  }

  private itemLine(item: Item, timezone: string): string {
    const task = item.kind === 'assignment' || item.kind === 'quiz';
    const time = task ? item.dueAt : item.startsAt ?? item.dueAt;
    const label = item.key.startsWith('class:') ? 'Class' : task ? 'Due' : item.kind === 'resource' ? 'Material' : item.startsAt !== null ? 'Event' : 'Due';
    return `${label}${time !== null ? ` ${formatTime(time, timezone)}` : ''}: ${item.title}\n${item.courseName}${item.key.startsWith('class:') ? `\n${item.description}` : ''}\nKey: ${item.key}${item.url ? `\n${item.url}` : ''}`;
  }

  private async command(student: Student, command: string, arg: string): Promise<string> {
    const id = student.id;
    const now = nowSeconds();
    if (command === 'start' || command === 'help') return HELP;
    if (command === 'connect') return `🔗 Connect your UWED Moodle account here:\n${this.services.connectLink(id)}\n\nThis link is private and expires shortly. Enter credentials only on the connection page. Do not forward it.`;
    if (command === 'disconnect') {
      this.store.deleteStudent(id);
      this.manualSyncs.delete(id);
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
        try { await this.services.sync(id); }
        catch { return 'Notifications are enabled. Moodle could not be refreshed just now; your saved information is still available.'; }
      }
      return `Moodle notifications are enabled.${this.services.updatesStatus ? '\n' + this.services.updatesStatus() : ''}`;
    }
    if (command === 'status') {
      return `${student.moodleCipher ? 'Moodle connected.' : 'Moodle is not connected. Tap Connect Moodle in the main menu.'}\nTime zone: ${student.timezone}\nNotifications: ${student.paused ? 'paused' : 'enabled'}\n${this.services.updatesStatus ? this.services.updatesStatus() : 'Automatic website alerts require a university-enabled Moodle event connection.'}\nLast successful sync: ${student.lastSyncAt === null ? 'never' : formatTime(student.lastSyncAt, student.timezone)}\nStored courses: ${this.store.courses(id).length}\nTimetable: manually entered with /class${this.coverage(student)}`;
    }
    const connectedCommands = new Set(['courses', 'today', 'week', 'priorities', 'prepare', 'assignments', 'outstanding', 'upcoming', 'awaiting', 'graded', 'done', 'undo', 'mute', 'unmute', 'calendar', 'sync', 'autoupdate','recentupdates','class', 'classes', 'unclass']);
    if (connectedCommands.has(command) && !student.moodleCipher) return 'Connect your Moodle account first: tap 🔗 Connect Moodle in the main menu. Never send your password or token in Telegram.';

    switch (command) {
      case 'autoupdate': {
        const previous=this.manualSyncs.get(id) || 0;
        if(now-previous<15)return `Please wait ${15-(now-previous)} seconds before checking Moodle again.`;
        this.manualSyncs.set(id,now);
        try {
          if(this.services.refresh)return await this.services.refresh(id);
          await this.services.sync(id);return '🔄 Website refreshed. Your saved views are up to date.';
        }catch{return 'Moodle could not be refreshed right now. Your saved data is preserved. Tap Auto update to retry; use Status to check the connection.';}
      }
      case 'recentupdates': return this.services.recentUpdates?.(id) || '📰 No recorded website changes yet.';
      case 'courses': {
        const courses = this.store.courses(id);
        return (courses.length ? '📚 My courses\n\n' + courses.map(course => `${course.id}: ${course.name}${course.muted ? ' (muted)' : ''}`).join('\n') + '\n\nTap a course below to prepare for class.' : 'No courses have been synced yet. Open Settings → Sync now, then check Status.') + this.coverage(student);
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
        return `${command === 'today' ? 'Today' : 'Next 7 days'} (${student.timezone})\n\n${items.length ? items.map(item => this.itemLine(item, student.timezone)).join('\n\n') : 'No unfinished deadlines or scheduled classes in this period.'}\n\nClasses come from your manual timetable. Tap Priorities for overdue work.${this.coverage(student)}`;
      }
      case 'priorities': {
        const items = priorityItems(this.store.items(id), now);
        return `Your priorities (${student.timezone})\n\n${items.length ? items.map(item => `${item.dueAt !== null && item.dueAt < now ? 'OVERDUE — ' : ''}${this.itemLine(item, student.timezone)}${item.dueAt === null ? '\nAvailable now — no published deadline' : ''}`).join('\n\n') : 'No active unfinished tasks found.'}\n\nOnly currently available work appears here. Upcoming, locked, and closed assignments are in 📝 Assignments → 🕓 Upcoming / locked. Moodle can allow work without a deadline; those tasks appear last.${this.coverage(student)}`;
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
      case 'graded': {
        const assignments = this.store.items(id).filter(item => item.kind === 'assignment');
        const current=currentAssignmentKeys(assignments,now);
        const currentWork=(item:Item)=>item.dueAt!==null && (current.has(item.key) || item.dueAt<now) && isActionable(item,now);
        const statuses = { outstanding: 'outstanding', upcoming: 'outstanding', awaiting: 'submitted_ungraded', graded: 'submitted_graded' } as const;
        const unknown = assignments.filter(item => !item.submissionStatus || item.submissionStatus === 'unknown');
        const counts = {
          outstanding: assignments.filter(item => item.submissionStatus === 'outstanding' && currentWork(item)).length,
          upcoming: assignments.filter(item => item.submissionStatus === 'outstanding' && !currentWork(item)).length,
          awaiting: assignments.filter(item => item.submissionStatus === 'submitted_ungraded').length,
          graded: assignments.filter(item => item.submissionStatus === 'submitted_graded').length,
        };
        const summary = `📝 Your assignments\n\n⏳ Next deadlines / overdue: ${counts.outstanding}\n🕓 Later / undated: ${counts.upcoming}\n📨 Awaiting grades: ${counts.awaiting}\n✅ Graded: ${counts.graded}\nTotal unfinished: ${counts.outstanding + counts.upcoming}\n\nFocus uses the nearest upcoming deadline in each course. Submitting early does not advance the next task; the earlier deadline must pass. This is a planning view, not confirmation of teacher release.`;
        const accessLine = (item: Item): string => `\n${item.availability === 'open' ? '🟢 Available now' : item.availability === 'upcoming' ? '🕓 Not open yet' : item.availability === 'closed' ? '⛔ Submissions closed' : item.availability === 'restricted' ? '🔒 Restricted' : '❓ Access unconfirmed'}${item.availableFrom ? `\nOpens: ${formatTime(item.availableFrom, student.timezone)}` : ''}${item.availabilityReason ? `\n${item.availabilityReason}` : ''}`;
        const unknownNotice = unknown.length ? `\n\n⚠️ Submission status is unavailable for ${unknown.length} assignment${unknown.length === 1 ? '' : 's'}; check Moodle directly:\n${unknown.map(item => `${item.title}${accessLine(item)}\n${item.url}`).join('\n\n')}` : '';
        if (command === 'assignments') return summary + (assignments.length ? '\n\nChoose a category below.' : '\n\nNo assignments have been synced yet.') + unknownNotice + '\n\nStatuses come from Moodle. Personal completion marks do not change your submission or grade.' + this.coverage(student);
        const status = statuses[command];
        const filtered = assignments.filter(item => item.submissionStatus === status && (command === 'outstanding' ? currentWork(item) : command === 'upcoming' ? !currentWork(item) : true)).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.title.localeCompare(b.title));
        const headings = { outstanding: '⏳ Next deadlines and unfinished overdue work', upcoming: '🕓 Later, undated, or unavailable assignments', awaiting: '📨 Submitted — awaiting grades', graded: '✅ Submitted — graded' };
        return `${headings[command]}\n\n${filtered.length ? filtered.map(item => `${this.itemLine(item, student.timezone)}${item.dueAt === null ? '\nNo published deadline' : ''}${command === 'upcoming' ? accessLine(item) : ''}${command === 'graded' ? `\nGrade: ${item.grade || 'See Moodle for grade details'}` : ''}`).join('\n\n') : 'No assignments in this category.'}${unknownNotice}\n\nStatuses and access come from Moodle; personal completion marks do not change them.${this.coverage(student)}`;
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
        const previous = Math.max(student.lastSyncAt ?? 0, this.manualSyncs.get(id) ?? 0);
        if (now - previous < 60) return `Please wait ${60 - (now - previous)} seconds before syncing again.`;
        this.manualSyncs.set(id, now);
        try {
          await this.services.sync(id);
          const current = this.store.getStudent(id);
          return `Moodle sync finished. Return to the main menu for Today, Priorities, or My courses.${current ? this.coverage(current) : ''}`;
        } catch {
          return 'Moodle could not be synced right now. Your saved information is still available. Check Status and try again later; if access has expired, tap Connect Moodle in the main menu.';
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
