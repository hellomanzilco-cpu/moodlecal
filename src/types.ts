export type ItemKind = 'resource' | 'assignment' | 'quiz' | 'event' | 'activity';
export type Availability = 'open' | 'upcoming' | 'restricted' | 'closed' | 'unknown';
export interface Course { id: number; name: string; shortname: string }
export interface Item {
  key: string;
  courseId: number;
  courseName: string;
  kind: ItemKind;
  title: string;
  description: string;
  url: string;
  modifiedAt: number;
  dueAt: number | null;
  startsAt: number | null;
  endsAt: number | null;
  completed: boolean;
  availability?: Availability;
  availabilityReason?: string;
  availableFrom?: number | null;
  cutoffAt?: number | null;
  /** Moodle's final-submit button; editing a new/draft submission can still be allowed. */
  canSubmit?: boolean;
  canEdit?: boolean;
  submissionStatus?: 'outstanding' | 'submitted_ungraded' | 'submitted_graded' | 'unknown';
  grade?: string | null;
  files?: { name: string; size: number; modifiedAt: number }[];
}
export interface Snapshot { courses: Course[]; items: Item[]; warnings: string[] }
export type ConnectionStage = 'authenticating' | 'courses' | 'assignments' | 'calendar' | 'saving';
export type ConnectionProgress = (stage:ConnectionStage)=>void;
export interface Identity { userId: number; name: string; functions: string[] }
export interface Student {
  id: number; telegramId: number; chatId: number; timezone: string;
  moodleCipher: string | null; calendarHash: string | null; calendarCipher: string | null;
  linkHash: string | null; linkExpires: number | null;
  lastSyncAt: number | null; nextSyncAt: number; lastError: string | null;
  initialized: boolean; paused: boolean;
}
export interface ClassEntry {
  id: number; courseId: number; title: string; weekday: number; time: string;
  duration: number; location: string; until: string;
}
export interface OutboxEntry { id: number; studentId: number; chatId: number; text: string; attempts: number; interactive?:number }
export interface MoodleGateway {
  identify(token: string): Promise<Identity>;
  login(username: string, password: string): Promise<string>;
  snapshot(token: string, now: number, assignmentsOnly?:boolean, progress?:ConnectionProgress): Promise<Snapshot>;
}
export interface ReplyMarkup {
  keyboard: {text:string;web_app?:{url:string}}[][];
  resize_keyboard?:boolean;
  is_persistent?:boolean;
  one_time_keyboard?:boolean;
  input_field_placeholder?:string;
}
export interface MessageOptions { reply_markup?:ReplyMarkup }
export interface Messenger { send(chatId: number, text: string, options?:MessageOptions): Promise<void> }
