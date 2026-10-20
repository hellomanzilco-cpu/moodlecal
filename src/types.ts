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
export interface AssignmentFile {name:string;size:number;modifiedAt:number;url:string;mime:string}
export interface AssignmentDetail {
  id:number;courseId:number;title:string;courseName:string;description:string;url:string;
  dueAt:number|null;availableFrom:number|null;cutoffAt:number|null;availability:Availability;availabilityReason:string;
  status:'new'|'draft'|'submitted'|'reopened'|'unknown';graded:boolean;grade:string|null;submittedAt:number|null;
  canEdit:boolean;canSubmit:boolean;requiresFinalSubmit:boolean;requiresStatement:boolean;statement:string;
  fileEnabled:boolean;textEnabled:boolean;maxFiles:number;maxFileBytes:number;acceptedTypes:string[];
  wordLimit:number|null;unsupportedReason:string|null;attachments:AssignmentFile[];submittedFiles:AssignmentFile[];
  onlineText:string;attempt:number;revision:string;
}
export interface SubmissionFile {name:string;bytes:Buffer;mime:string}
export interface AssignmentGateway {
  assignment(token:string,assignmentId:number,courseId:number,now:number):Promise<AssignmentDetail>;
  download(token:string,file:AssignmentFile,maxBytes:number):Promise<Buffer>;
  uploadDraft(token:string,files:SubmissionFile[]):Promise<number>;
  saveSubmission(token:string,assignmentId:number,draftId:number|null,text:string|undefined):Promise<void>;
  submitForGrading(token:string,assignmentId:number,acceptStatement:boolean):Promise<void>;
}
export type ConnectionStage = 'connecting' | 'authenticating' | 'profile' | 'synchronizing' | 'dashboard';
export type ConnectionProgress = (stage:ConnectionStage)=>void;
export interface Identity { userId: number; name: string; functions: string[]; firstName?:string;lastName?:string;username?:string }
export interface MoodleProfile {firstName:string;lastName:string;username:string}
export interface SharedProfile extends MoodleProfile {sharedAt:number}
export interface SharedProfilePage {profiles:SharedProfile[];total:number;registered:number;offset:number}
export interface Student {
  language?:import('./locale.ts').Language;
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
  checkReachable?(): Promise<void>;
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
export interface MessageOptions { reply_markup?:ReplyMarkup; parse_mode?:'HTML' }
export interface Messenger {
  send(chatId: number, text: string, options?:MessageOptions): Promise<void>;
  sendWithId?(chatId:number,text:string,options?:MessageOptions):Promise<number>;
  editMessage?(chatId:number,messageId:number,text:string,options?:MessageOptions):Promise<void>;
  deleteMessage?(chatId:number,messageId:number):Promise<void>;
  sendDocument?(chatId:number,name:string,bytes:Buffer,caption:string):Promise<void>;
}
