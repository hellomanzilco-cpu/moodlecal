import type { Course, Identity, Item, MoodleGateway, Snapshot, ConnectionProgress,AssignmentDetail,AssignmentFile,AssignmentGateway,SubmissionFile } from './types.ts';
import {readAssignment,submissionParameters,requireNoWriteWarnings,trustedFile} from './assignment-moodle.ts';
import {boundedBody,CapacityError,ConcurrencyGate,mapConcurrent,requestSignal,withDeadline} from './limits.ts';

type RecordValue = Record<string, unknown>;
type Parameter = string | number | boolean | Parameter[] | { [key: string]: Parameter };

const REQUIRED = ['core_enrol_get_users_courses', 'core_course_get_contents'];
const ASSIGNMENTS = 'mod_assign_get_assignments';
const SUBMISSIONS = 'mod_assign_get_submission_status';
const QUIZZES = 'mod_quiz_get_quizzes_by_courses';
const ATTEMPTS = 'mod_quiz_get_user_attempts';
const CALENDAR = 'core_calendar_get_calendar_events';
const GROUPS = 'core_group_get_course_user_groups';
const REQUEST_TIMEOUT_MS = 20_000;
export const ASSIGNMENT_STATUS_WARNING='Moodle did not return assignment submission statuses or grades.';

/** An intentionally safe error: never includes Moodle responses, tokens or credentials. */
export class MoodleError extends Error {
  readonly reason: 'network' | 'authentication' | 'permission' | 'upstream';
  readonly retryable: boolean;
  readonly userMessage: string;
  operation?: string;
  apiErrorCode?: string;
  httpStatus?: number;
  warningCodes?: string[];

  constructor(message: string, retryable = false, reason: MoodleError['reason'] = 'upstream') {
    super(message);
    this.name = 'MoodleError';
    this.userMessage = message;
    this.retryable = retryable;
    this.reason = reason;
  }
}

function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MoodleError('Moodle returned an incomplete response. Please try again.', true);
  }
  return value as RecordValue;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new MoodleError('Moodle returned an incomplete response. Please try again.', true);
  }
  return value;
}

function number(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : fallback;
}

function id(value: unknown): number {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new MoodleError('Moodle returned an incomplete response. Please try again.', true);
  }
  return result;
}

function timestamp(value: unknown): number | null {
  const result = number(value);
  return result > 0 ? result : null;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/** Conservative plain text for Telegram/calendar; no active markup survives. */
export function moodleText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>|<\s*\/\s*(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d+)|#x([a-f\d]+)|([a-z]+));/gi, (match, dec: string, hex: string, named: string) => {
      if (dec || hex) {
        const code = Number.parseInt(dec || hex, dec ? 10 : 16);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code) : '';
      }
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[named?.toLowerCase()] ?? match;
    })
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    // Embedded file hyperlinks sometimes expose a webservice token as visible text.
    .replace(/((?:[?&]|&amp;)(?:wstoken|token|sesskey|password|secret|access_token)=)[^\s&#<>]*/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/https?:\/\/[^\s<>"']+/gi,value=>{
      try{const url=new URL(value);url.username='';url.password='';url.hash='';for(const key of [...url.searchParams.keys()])if(/token|password|sesskey|secret|credential|authorization|^auth$|^key$/i.test(key))url.searchParams.set(key,'[redacted]');return url.href;}catch{return '[unreadable link]';}
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

function flatten(parameters: Record<string, Parameter>): URLSearchParams {
  const output = new URLSearchParams();
  function append(key: string, value: Parameter): void {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => append(`${key}[${index}]`, entry));
    } else if (typeof value === 'object') {
      for (const [child, entry] of Object.entries(value)) append(`${key}[${child}]`, entry);
    } else {
      output.append(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
  }
  for (const [key, value] of Object.entries(parameters)) append(key, value);
  return output;
}

function isComplete(module: RecordValue | undefined): boolean {
  const completion = module?.completiondata;
  if (!completion || typeof completion !== 'object') return false;
  const data = object(completion);
  return bool(data.isoverallcomplete) || data.state === 1 || data.state === 2 || data.state === 3;
}

function moduleRestriction(module: RecordValue | undefined): string | null {
  if (!module) return null;
  if ((module.uservisible !== undefined && !bool(module.uservisible)) || module.sectionRestricted === true) {
    return moodleText(module.availabilityinfo) || moodleText(module.sectionAvailability) || 'Moodle has not made this activity available to you.';
  }
  return null;
}

/** Use Moodle's evaluated permissions; raw availability condition JSON is not a student access decision. */
function assignmentAccess(assignment: RecordValue, module: RecordValue | undefined, last: RecordValue | undefined, now: number): Pick<Item, 'availability' | 'availabilityReason' | 'availableFrom' | 'cutoffAt' | 'canSubmit' | 'canEdit'> {
  const availableFrom = timestamp(assignment.allowsubmissionsfromdate);
  const cutoff = timestamp(assignment.cutoffdate);
  const extension = timestamp(last?.extensionduedate);
  const cutoffAt = cutoff === null ? null : Math.max(cutoff, extension ?? 0);
  const canSubmit = last?.cansubmit === undefined ? undefined : bool(last.cansubmit);
  const canEdit = last?.canedit !== undefined ? bool(last.canedit)
    : last?.caneditowner !== undefined ? bool(last.caneditowner) : undefined;
  const metadata = { availableFrom, cutoffAt, canSubmit, canEdit };
  const restricted = moduleRestriction(module);
  if (restricted) return { ...metadata, availability: 'restricted', availabilityReason: restricted };
  if (bool(assignment.nosubmissions) || (last?.submissionsenabled !== undefined && !bool(last.submissionsenabled))) {
    return { ...metadata, availability: 'restricted', availabilityReason: 'Moodle does not collect student submissions for this activity.' };
  }
  if (availableFrom !== null && availableFrom > now) return { ...metadata, availability: 'upcoming', availabilityReason: 'The submission opening date has not arrived.' };
  if (cutoffAt !== null && cutoffAt < now) return { ...metadata, availability: 'closed', availabilityReason: 'The submission cutoff has passed.' };
  if (bool(last?.locked)) return { ...metadata, availability: 'restricted', availabilityReason: 'Moodle has locked new submissions for your account.' };
  // cansubmit means the final-submit button. It is commonly false while canedit
  // is true for a new submission or when a separate final-submit step is disabled.
  if (canSubmit === true || canEdit === true) return { ...metadata, availability: 'open', availabilityReason: 'Moodle currently allows you to add, edit, or submit work.' };
  if (canSubmit === false && canEdit === false) return { ...metadata, availability: 'restricted', availabilityReason: 'Moodle does not currently allow you to add, edit, or submit work. Check its access requirements.' };
  return { ...metadata, availability: 'unknown', availabilityReason: 'Moodle did not provide enough information to confirm submission access.' };
}

function files(...collections: unknown[]): NonNullable<Item['files']> {
  const result = new Map<string, NonNullable<Item['files']>[number]>();
  for (const collection of collections) {
    if (collection === undefined || collection === null) continue;
    for (const raw of list(collection)) {
      const file = object(raw);
      if (file.type !== undefined && file.type !== 'file') continue;
      const name = moodleText(file.filename);
      if (!name) continue;
      const path = typeof file.filepath === 'string' ? file.filepath : '';
      const entry = { name: `${path}${name}`, size: number(file.filesize), modifiedAt: number(file.timemodified) };
      result.set(`${entry.name}\u0000${entry.size}\u0000${entry.modifiedAt}`, entry);
    }
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name) || a.size - b.size || a.modifiedAt - b.modifiedAt);
}

/**
 * Student adapter. Snapshot reads observe only content exposed to that token;
 * assignment writes are invoked only by the separate, explicit submission flow.
 * Polling cannot see hidden content or changes between scans; unsupported plugin
 * activities have generic course-content coverage. Moodle enrolments are courses,
 * not a class timetable. Group calendars need the optional group discovery API.
 */
export class MoodleClient implements MoodleGateway,AssignmentGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new MoodleError('Moodle must use a trusted HTTPS site address.');
    }
    this.baseUrl = parsed.href.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  private network=new ConcurrencyGate(6,64);
  private failures=0;private openUntil=0;
  async checkReachable():Promise<void>{
    const signal=requestSignal(REQUEST_TIMEOUT_MS);
    try{
      const response=await this.network.run(()=>this.fetchImpl(`${this.baseUrl}/login/index.php`,{method:'GET',redirect:'manual',signal}),signal);
      try{await response.body?.cancel();}catch{}
      if(response.status===429||response.status>=500){const error=new MoodleError('UWED Moodle is not responding. Try again when the site is available.',true,'network');error.operation='moodle_reachability';error.httpStatus=response.status;throw error;}
      if(response.status===404){const error=new MoodleError('The Moodle sign-in page was not found at this site address.',false,'upstream');error.operation='moodle_reachability';error.apiErrorCode='login_page_not_found';error.httpStatus=404;throw error;}
      this.failures=0;
    }catch(error){
      if(error instanceof MoodleError)throw error;
      const timeout=error instanceof Error&&(error.name==='AbortError'||error.name==='TimeoutError');
      const failure=new MoodleError(timeout?'The Moodle connection check timed out. Try again later.':'UWED Moodle is not responding. Try again when the site is available.',true,'network');
      failure.operation='moodle_reachability';failure.apiErrorCode=timeout?'timeout':'unreachable';throw failure;
    }
  }
  private async request(path: string, parameters: Record<string, Parameter>, allowWarning?: (warning:RecordValue)=>boolean): Promise<unknown> {
    if(Date.now()<this.openUntil)throw new MoodleError('UWED Moodle is temporarily unavailable. Please try again in 30 seconds.',true,'network');
    const signal=requestSignal(REQUEST_TIMEOUT_MS);
    try{return await this.network.run(()=>this.requestNow(path,parameters,signal,allowWarning),signal);}
    catch(error){
      if(error instanceof MoodleError){if(error.reason==='network'&&++this.failures>=3)this.openUntil=Date.now()+30000;throw error;}
      if(error instanceof CapacityError)throw new MoodleError(error.message,true);
      throw new MoodleError('Moodle could not be reached. Please try again.',true,'network');
    }
  }
  private async requestNow(path:string,parameters:Record<string,Parameter>,signal:AbortSignal,allowWarning?:(warning:RecordValue)=>boolean):Promise<unknown>{
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: flatten(parameters),
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        const error=new MoodleError(
          response.status === 429 ? 'Moodle is busy. Please try again later.' : 'Moodle could not be reached. Please try again.',
          response.status === 429 || response.status >= 500,
          response.status>=500?'network':'upstream',
        );
        error.httpStatus=response.status;
        throw error;
      }
      const content = (await boundedBody(response,20_000_000)).toString('utf8');
      let data: unknown;
      try { data = JSON.parse(content); } catch {
        const error=new MoodleError('Moodle returned an unreadable response. Please try again.', true);error.apiErrorCode='invalid_response';throw error;
      }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const result = object(data);
        if (result.exception || result.errorcode || result.error) {
          const code = typeof result.errorcode === 'string' ? result.errorcode : '';
          const safeCode=/^[a-zA-Z0-9_-]{1,80}$/.test(code)?code:'unknown';
          const coded=(error:MoodleError):MoodleError=>{error.apiErrorCode=safeCode;return error;};
          if(path==='/login/token.php'&&/(?:invalidlogin|invalid\s+login|invalid\s+username\s+or\s+password|incorrect\s+username\s+or\s+password)/i.test(`${code} ${String(result.error??'')}`)){
            const error=coded(new MoodleError('Moodle rejected the supplied username or password. Check them and try again.',false,'authentication'));error.operation='login_token';error.apiErrorCode='invalidlogin';throw error;
          }
          if(path==='/login/token.php'&&/(?:forcepasswordchange|usernotfullysetup|captcha|multifactor|two.factor|one.time.password|\botp\b)/i.test(`${code} ${String(result.error??'')}`)){
            const error=coded(new MoodleError('Moodle requires an additional account or verification step before sign-in can finish.',false,'upstream'));error.operation='login_token';if(safeCode==='unknown')error.apiErrorCode='additional_authentication';throw error;
          }
          if (/invalidtoken|expiredtoken|invalidlogin|usernotfullysetup|forcepasswordchange|requireloginerror/i.test(code)) {
            throw coded(new MoodleError('Your Moodle connection is no longer valid. Please reconnect your account.',false,'authentication'));
          }
          if (/accessexception|nopermission|accessdenied|servicenotavailable|webservice.*disabled/i.test(code)) {
            throw coded(new MoodleError('Moodle does not allow this API request. Ask the university to check the mobile web service permissions.',false,'permission'));
          }
          // Moodle exception text and debugging information may contain secrets.
          throw coded(new MoodleError('Moodle returned an API error. Please try again or reconnect your account.', true));
        }
        if (result.warnings !== undefined && list(result.warnings).some(w=>!allowWarning?.(object(w)))) {
          const error=new MoodleError('Moodle returned incomplete data. Your saved snapshot will not be replaced.', true);
          error.warningCodes=list(result.warnings).map(w=>String(object(w).warningcode ?? 'unknown')).map(code=>/^[a-zA-Z0-9_-]{1,80}$/.test(code)?code:'unknown');
          throw error;
        }
      }
      this.failures=0;return data;
    } catch (error) {
      if (error instanceof MoodleError) throw error;
      if(error instanceof CapacityError)throw new MoodleError(error.message,true);
      const timeout=error instanceof Error&&(error.name==='AbortError'||error.name==='TimeoutError');
      const failure=new MoodleError(timeout?'Moodle request timed out. Please try again.':'Moodle could not be reached. Please try again.',true,'network');failure.apiErrorCode=timeout?'timeout':'unreachable';throw failure;
    }
  }

  private async call(token: string, functionName: string, parameters: Record<string, Parameter> = {}, allowWarning?: (warning:RecordValue)=>boolean): Promise<unknown> {
    try { return await this.request('/webservice/rest/server.php', { ...parameters, wstoken: token, wsfunction: functionName, moodlewsrestformat: 'json' },allowWarning); }
    catch(error) { if(error instanceof MoodleError) error.operation=functionName;throw error; }
  }

  async login(username: string, password: string): Promise<string> {
    if (!username.trim() || !password) throw new MoodleError('Enter your Moodle username and password.');
    const data = object(await this.request('/login/token.php', {
      username: username.trim(), password, service: 'moodle_mobile_app',
    }));
    if (typeof data.token !== 'string' || !data.token.trim()) {
      const loginError=String(data.errorcode??data.error??'').trim().toLowerCase().replace(/[ _-]/g,'');
      if(['invalidlogin','invalidusernameorpassword','incorrectusernameorpassword'].includes(loginError)){
        const error=new MoodleError('Moodle rejected the supplied username or password. Check them and try again.',false,'authentication');
        error.operation='login_token';error.apiErrorCode='invalidlogin';throw error;
      }
      const error=new MoodleError('Moodle did not issue an access token. Check Moodle account and mobile web service access.',false,'upstream');
      error.operation='login_token';error.apiErrorCode=/^[a-z0-9_-]{1,80}$/i.test(String(data.errorcode??''))?String(data.errorcode):undefined;throw error;
    }
    return data.token;
  }

  async identify(token: string): Promise<Identity> {
    if (!token.trim()) throw new MoodleError('Your Moodle access token is missing. Please reconnect your account.');
    const data = object(await this.call(token, 'core_webservice_get_site_info'));
    const functions = list(data.functions).map((entry) => object(entry).name).filter((name): name is string => typeof name === 'string');
    return { userId: id(data.userid), name: moodleText(data.fullname) || moodleText(data.username) || 'Student', functions,
      firstName:moodleText(data.firstname),lastName:moodleText(data.lastname),username:typeof data.username==='string'?data.username.trim():'' };
  }

  private view(module: string, cmid: number): string {
    return `${this.baseUrl}/mod/${module}/view.php?id=${cmid}`;
  }

  private safeUrl(value: unknown, fallback: string): string {
    if (typeof value !== 'string' || !value) return fallback;
    try {
      const parsed = new URL(value, `${this.baseUrl}/`);
      if (parsed.origin !== new URL(this.baseUrl).origin || parsed.username || parsed.password || parsed.protocol !== 'https:') return fallback;
      for (const key of [...parsed.searchParams.keys()]) {
        if (/token|password|sesskey|secret|credential|authorization|^auth$|^key$/i.test(key)) parsed.searchParams.delete(key);
      }
      parsed.hash = '';
      return parsed.href;
    } catch { return fallback; }
  }

  async assignment(token:string,assignmentId:number,courseId:number,now:number):Promise<AssignmentDetail>{
    return withDeadline(60000,()=>readAssignment({baseUrl:this.baseUrl,identify:value=>this.identify(value),call:(value,name,params,allowWarning)=>this.call(value,name,params,allowWarning)},token,assignmentId,courseId,now,assignmentAccess));
  }
  async download(token:string,file:AssignmentFile,maxBytes:number):Promise<Buffer>{
    const trusted=trustedFile(this.baseUrl,{filename:file.name,fileurl:file.url,filesize:file.size});
    if(!trusted||file.size>maxBytes)throw new MoodleError('This file cannot be downloaded here. Open it directly in Moodle.');
    try{
      const url=new URL(trusted.url);url.searchParams.set('token',token);url.searchParams.set('forcedownload','1');
      const response=await this.fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)});
      if(!response.ok||!response.body)throw new MoodleError('Moodle did not allow this file download.',false,'permission');
      if(Number(response.headers.get('content-length'))>maxBytes)throw new MoodleError('This file exceeds the bot download limit. Open Moodle to download it.');
      const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;
      try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maxBytes){await reader.cancel();throw new MoodleError('This file exceeds the bot download limit. Open Moodle to download it.');}chunks.push(Buffer.from(part.value));}}finally{reader.releaseLock();}
      const bytes=Buffer.concat(chunks);const contentType=response.headers.get('content-type')||'';
      if(contentType.includes('application/json')){try{const data=JSON.parse(bytes.toString());if(data.exception||data.errorcode||data.error)throw new MoodleError('Moodle did not allow this file download.',false,'permission');}catch(error){if(error instanceof MoodleError)throw error;}}
      if(file.size>0&&bytes.length!==file.size)throw new MoodleError('Moodle returned an incomplete or changed file. Refresh this assignment before downloading again.',true);
      if(contentType.includes('text/html')&&file.mime!=='text/html')throw new MoodleError('Moodle returned a login page instead of the file. Reconnect or open Moodle.',false,'authentication');
      return bytes;
    }catch(error){if(error instanceof MoodleError)throw error;throw new MoodleError('Moodle file download was interrupted. Please try again.',true,'network');}
  }
  async uploadDraft(token:string,files:SubmissionFile[]):Promise<number>{
    let draftId=0;
    for(const file of files){try{
      const form=new FormData();form.set('token',token);form.set('itemid',String(draftId));form.set('filepath','/');form.set('file_1',new Blob([new Uint8Array(file.bytes)],{type:file.mime} ),file.name);
      const response=await this.fetchImpl(this.baseUrl+'/webservice/upload.php',{method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)});
      if(!response.ok)throw new MoodleError('Moodle rejected the file upload. Check its upload limits and try directly in Moodle.',false,'permission');
      const data:unknown=JSON.parse((await boundedBody(response,1024*1024)).toString('utf8'));if(!Array.isArray(data)||data.length!==1)throw new MoodleError('Moodle did not confirm the draft file upload. No final submission was requested.');
      const uploaded=object(data[0]);const returnedId=id(uploaded.itemid);
      if(uploaded.component!=='user'||uploaded.filearea!=='draft'||uploaded.filename!==file.name||(draftId!==0&&draftId!==returnedId))throw new MoodleError('Moodle returned an unexpected upload receipt. No final submission was requested.');
      draftId=returnedId;
    }catch(error){if(error instanceof MoodleError)throw error;throw new MoodleError('Moodle upload was interrupted. Check your connection before trying again.',true,'network');}}
    if(!draftId)throw new MoodleError('Choose a file before uploading.');return draftId;
  }
  async saveSubmission(token:string,assignmentId:number,draftId:number|null,text:string|undefined):Promise<void>{
    requireNoWriteWarnings(await this.call(token,'mod_assign_save_submission',submissionParameters(assignmentId,draftId,text)));
  }
  async submitForGrading(token:string,assignmentId:number,acceptStatement:boolean):Promise<void>{
    requireNoWriteWarnings(await this.call(token,'mod_assign_submit_for_grading',{assignmentid:assignmentId,acceptsubmissionstatement:acceptStatement}));
  }

  async snapshot(token: string, now: number, assignmentsOnly=false,progress?:ConnectionProgress): Promise<Snapshot> {
    return withDeadline(90000,()=>this.snapshotData(token,now,assignmentsOnly,progress));
  }
  private async snapshotData(token:string,now:number,assignmentsOnly:boolean,progress?:ConnectionProgress):Promise<Snapshot>{
    progress?.('profile');
    const identity = await this.identify(token);
    progress?.('synchronizing');
    const available = new Set(identity.functions);
    const warnings: string[] = [];
    const supports = (functionName: string, limitation: string): boolean => {
      if (available.has(functionName)) return true;
      warnings.push(limitation);
      return false;
    };
    const requireFunction=(functionName:string,message:string):void=>{
      if(available.has(functionName))return;
      const error=new MoodleError(message,false,'permission');error.operation=functionName;throw error;
    };
    for(const functionName of REQUIRED)requireFunction(functionName,'Moodle sign-in succeeded, but your account cannot read enrolled courses and course contents. Ask university IT to enable the required mobile web service functions.');
    requireFunction(ASSIGNMENTS,'Moodle has not enabled assignment details for this connection. Ask the university to enable the mobile assignment service.');
    requireFunction(SUBMISSIONS,'Moodle has not enabled submission status and grade access for this connection. Ask the university to enable the mobile assignment status service.');
    const hasAssignments = true;
    const hasSubmissions = true;
    const hasQuizzes = !assignmentsOnly && supports(QUIZZES, 'Quiz availability and deadlines are unavailable; only course activity changes are monitored.');
    const hasAttempts = !assignmentsOnly && supports(ATTEMPTS, 'Quiz attempt status is unavailable; completed quizzes may remain in priorities.');
    const hasCalendar = !assignmentsOnly && supports(CALENDAR, 'Moodle calendar events are unavailable; classes need a personal timetable.');

    const courses: Course[] = list(await this.call(token, 'core_enrol_get_users_courses', { userid: identity.userId, returnusercount: false }))
      .map((raw) => {
        const course = object(raw);
        return { id: id(course.id), name: moodleText(course.fullname), shortname: moodleText(course.shortname) };
      });
    const courseIds = courses.map((course) => course.id);
    const courseMap = new Map(courses.map((course) => [course.id, course]));
    const modules = new Map<number, RecordValue>();
    const items = new Map<string, Item>();
    const contents=await mapConcurrent(courses,3,async course=>({course,sections:list(await this.call(token,'core_course_get_contents',{courseid:course.id}))}));
    for (const {course,sections} of contents) {
      for (const rawSection of sections) {
        const section = object(rawSection);
        for (const rawModule of list(section.modules)) {
          const module: RecordValue = { ...object(rawModule), sectionRestricted: section.uservisible !== undefined && !bool(section.uservisible), sectionAvailability: section.availabilityinfo };
          const cmid = id(module.id);
          modules.set(cmid, module);
          const moduleName = typeof module.modname === 'string' && /^[a-z][a-z0-9_]*$/.test(module.modname) ? module.modname : '';
          if (!moduleName) throw new MoodleError('Moodle returned an incomplete activity. Please try again.', true);
          const attachedFiles = files(module.contents);
          const contentInfo = module.contentsinfo === undefined ? {} : object(module.contentsinfo);
          const resource = ['resource', 'folder', 'url', 'page', 'book'].includes(moduleName);
          const restriction = moduleRestriction(module);
          const item: Item = {
            key: `module:${cmid}`, courseId: course.id, courseName: course.name,
            kind: moduleName === 'assign' ? 'assignment' : moduleName === 'quiz' ? 'quiz' : resource ? 'resource' : 'activity',
            title: moodleText(module.name), description: moodleText(module.description),
            url: this.view(moduleName, cmid),
            modifiedAt: Math.max(number(module.timemodified), number(contentInfo.lastmodified), ...attachedFiles.map((file) => file.modifiedAt), 0),
            dueAt: null, startsAt: null, endsAt: null, completed: isComplete(module), files: attachedFiles,
            availability: restriction ? 'restricted' : moduleName === 'assign' ? 'unknown' : 'open',
            availabilityReason: restriction || (moduleName === 'assign' ? 'Assignment access has not been confirmed by Moodle.' : undefined),
            ...(moduleName === 'assign' ? { submissionStatus: 'unknown' as const } : {}),
          };
          items.set(item.key, item);
        }
      }
    }

    const assignmentIds = new Set<number>();
    const quizIds = new Set<number>();
    if (courseIds.length && hasAssignments) {
      let restricted=0;
      const result = object(await this.call(token, ASSIGNMENTS, { courseids: courseIds },warning=>{
        // Moodle lists permission warnings for hidden/future modules. Confirm the
        // module is absent from this student's visible contents before omitting it.
        const inaccessible=warning.item==='module' && String(warning.warningcode)==='1'
          && Number.isSafeInteger(Number(warning.itemid)) && Number(warning.itemid)>0
          && (!modules.has(Number(warning.itemid)) || moduleRestriction(modules.get(Number(warning.itemid))) !== null);
        if(inaccessible) restricted++;
        return inaccessible;
      }));
      if(restricted) warnings.push(`${restricted} assignment activities could not be inspected with your student account. Hidden activity details are not available.`);
      const submissionStatuses=new Map<number,RecordValue>();
      const visible=list(result.courses).map(object).flatMap(course=>list(course.assignments).map(object)).filter(assignment=>!moduleRestriction(modules.get(id(assignment.cmid))));
      if(hasSubmissions){
        for(let index=0;index<visible.length;index++){
          const assignment=visible[index];
          const assignmentId=id(assignment.id);
          const status=object(await this.call(token,SUBMISSIONS,{assignid:assignmentId,userid:identity.userId}));
          if(status.lastattempt===undefined&&!bool(assignment.nosubmissions)){
            const error=new MoodleError('Moodle returned no student submission-status record for an assignment. Check the student role permissions for submission summaries.',false,'permission');
            error.operation=SUBMISSIONS;error.apiErrorCode='missing_lastattempt';throw error;
          }
          if(status.lastattempt!==undefined&&!bool(assignment.nosubmissions)){
            const last=object(status.lastattempt);
            const required=['graded','submissionsenabled','locked','cansubmit','extensionduedate'];
            if(required.some(field=>last[field]===undefined)||(last.canedit===undefined&&last.caneditowner===undefined)){
              const error=new MoodleError('Moodle returned an incomplete student submission-status record. The snapshot was not saved.',true,'upstream');
              error.operation=SUBMISSIONS;error.apiErrorCode='incomplete_lastattempt';throw error;
            }
          }
          submissionStatuses.set(assignmentId,status);
        }
      }
      for (const rawCourse of list(result.courses)) {
        const courseData = object(rawCourse);
        const course = courseMap.get(id(courseData.id));
        if (!course) throw new MoodleError('Moodle returned unexpected course data. Please try again.', true);
        for (const rawAssignment of list(courseData.assignments)) {
          const assignment = object(rawAssignment);
          const assignmentId = id(assignment.id);
          const cmid = id(assignment.cmid);
          const module = modules.get(cmid);
          if (moduleRestriction(module)) continue;
          let dueAt = timestamp(assignment.duedate);
          let completed = isComplete(module);
          let submissionStatus: Item['submissionStatus']='unknown';
          let grade: string | null=null;
          let lastAttempt: RecordValue | undefined;
          if (hasSubmissions) {
            const status = submissionStatuses.get(assignmentId);
            if (status?.lastattempt !== undefined) {
              const last = object(status.lastattempt);
              lastAttempt = last;
              const extension = timestamp(last.extensionduedate);
              if (extension !== null && (dueAt === null || extension > dueAt)) dueAt = extension;
              const submission = last.submission === undefined ? undefined : object(last.submission);
              const team = last.teamsubmission === undefined ? undefined : object(last.teamsubmission);
              const needsToSubmit = last.submissiongroupmemberswhoneedtosubmit === undefined ? [] : list(last.submissiongroupmemberswhoneedtosubmit);
              if (!bool(assignment.nosubmissions)) {
                const membershipKnown = !bool(assignment.teamsubmission) || !bool(assignment.requireallteammemberssubmit)
                  || last.submissiongroupmemberswhoneedtosubmit !== undefined;
                completed = (bool(assignment.teamsubmission) ? team?.status === 'submitted' : submission?.status === 'submitted')
                  && membershipKnown
                  && !needsToSubmit.some((userId) => Number(userId) === identity.userId);
                const feedback=status.feedback===undefined ? undefined : object(status.feedback);
                const gradeRecord=feedback?.grade===undefined ? undefined : object(feedback.grade);
                const activeSubmission=bool(assignment.teamsubmission) ? team : submission;
                const sameAttempt=gradeRecord?.attemptnumber===undefined || activeSubmission?.attemptnumber===undefined
                  || Number(gradeRecord.attemptnumber)===Number(activeSubmission.attemptnumber);
                const gradeValue=gradeRecord?.grade;
                const hasGradeValue=(typeof gradeValue==='number' || (typeof gradeValue==='string' && gradeValue.trim()!==''))
                  && Number.isFinite(Number(gradeValue)) && Number(gradeValue)>=0;
                const graded=last.graded!==undefined ? bool(last.graded)
                  : last.gradingstatus==='graded' || (sameAttempt && hasGradeValue);
                if(graded && sameAttempt) grade=moodleText(feedback?.gradefordisplay) || (gradeRecord?.grade!==undefined ? moodleText(String(gradeRecord.grade)) : null);
                submissionStatus=!membershipKnown ? 'unknown' : completed ? (graded ? 'submitted_graded' : 'submitted_ungraded') : 'outstanding';
              }
            }
          }
          const attachedFiles = files(assignment.introfiles, assignment.introattachments, assignment.activityattachments);
          const item: Item = {
            key: `assignment:${assignmentId}`, courseId: course.id, courseName: course.name, kind: 'assignment',
            title: moodleText(assignment.name), description: [moodleText(assignment.intro), moodleText(assignment.activity)].filter(Boolean).join('\n\n'),
            url: this.view('assign', cmid),
            modifiedAt: Math.max(number(assignment.timemodified), ...attachedFiles.map((file) => file.modifiedAt), 0),
            dueAt, startsAt: null, endsAt: null, completed, files: attachedFiles, submissionStatus, grade,
            ...assignmentAccess(assignment, module, lastAttempt, now),
          };
          items.delete(`module:${cmid}`);
          items.set(item.key, item);
          assignmentIds.add(assignmentId);
        }
      }
    }

    if (courseIds.length && hasQuizzes) {
      const result = object(await this.call(token, QUIZZES, { courseids: courseIds }));
      for (const rawQuiz of list(result.quizzes)) {
        const quiz = object(rawQuiz);
        const quizId = id(quiz.id);
        const cmid = id(quiz.coursemodule);
        const course = courseMap.get(id(quiz.course));
        if (!course) throw new MoodleError('Moodle returned unexpected course data. Please try again.', true);
        const module = modules.get(cmid);
        if (moduleRestriction(module)) continue;
        let completed = isComplete(module);
        if (hasAttempts) {
          const result = object(await this.call(token, ATTEMPTS, { quizid: quizId, userid: identity.userId, status: 'all', includepreviews: false }));
          // A finished attempt is reported as done for planning; further attempts remain available in Moodle.
          const attempts = list(result.attempts).map(object);
          completed = attempts.some((attempt) => attempt.state === 'finished') && !attempts.some((attempt) => attempt.state === 'inprogress' || attempt.state === 'overdue') || completed;
        }
        const attachedFiles = files(quiz.introfiles);
        const item: Item = {
          key: `quiz:${quizId}`, courseId: course.id, courseName: course.name, kind: 'quiz',
          title: moodleText(quiz.name), description: moodleText(quiz.intro), url: this.view('quiz', cmid),
          modifiedAt: Math.max(number(quiz.timemodified), ...attachedFiles.map((file) => file.modifiedAt), 0),
          dueAt: timestamp(quiz.timeclose), startsAt: null, endsAt: null, completed, files: attachedFiles,
          availableFrom: timestamp(quiz.timeopen), cutoffAt: timestamp(quiz.timeclose),
          availability: timestamp(quiz.timeopen) !== null && number(quiz.timeopen) > now ? 'upcoming'
            : timestamp(quiz.timeclose) !== null && number(quiz.timeclose) < now ? 'closed' : 'open',
        };
        items.delete(`module:${cmid}`);
        items.set(item.key, item);
        quizIds.add(quizId);
      }
    }

    if (hasCalendar) {
      const groupIds = new Set<number>();
      if (available.has(GROUPS)) {
        const result = object(await this.call(token, GROUPS, { courseid: 0, userid: identity.userId }));
        for (const rawGroup of list(result.groups)) groupIds.add(id(object(rawGroup).id));
      } else {
        warnings.push('Group calendar events are unavailable because Moodle does not expose group discovery.');
      }
      const result = object(await this.call(token, CALENDAR, {
        events: { courseids: courseIds, groupids: [...groupIds] },
        options: { userevents: true, siteevents: true, ignorehidden: true, timestart: Math.max(0, Math.floor(now - 7 * 86400)), timeend: Math.floor(now + 180 * 86400) },
      }));
      for (const rawEvent of list(result.events)) {
        const event = object(rawEvent);
        const moduleName = typeof event.modulename === 'string' ? event.modulename : '';
        const instance = number(event.instance);
        const eventType = typeof event.eventtype === 'string' ? event.eventtype : '';
        if (moduleName === 'assign' && assignmentIds.has(instance) && ['due', 'gradingdue'].includes(eventType)) continue;
        if (moduleName === 'quiz' && quizIds.has(instance) && ['close', 'open'].includes(eventType)) continue;
        const eventId = id(event.id);
        const courseId = number(event.courseid);
        const startsAt = timestamp(event.timestart);
        const duration = number(event.timeduration);
        const isDeadline = (moduleName === 'assign' && eventType === 'due') || (moduleName === 'quiz' && eventType === 'close');
        const relatedModule = [...modules.values()].find(module => module.modname === moduleName && number(module.instance) === instance);
        const restriction = moduleRestriction(relatedModule);
        const item: Item = {
          key: `event:${eventId}`, courseId, courseName: courseMap.get(courseId)?.name ?? 'Moodle calendar', kind: 'event',
          title: moodleText(event.name), description: moodleText(event.description),
          url: this.safeUrl(event.url, `${this.baseUrl}/calendar/view.php?view=day&time=${number(event.timestart)}`),
          modifiedAt: number(event.timemodified), dueAt: isDeadline ? startsAt : null, startsAt,
          endsAt: startsAt !== null && duration > 0 ? startsAt + duration : null, completed: false,
          // Calendar visibility confirms the deadline exists, not that a student
          // can submit. Do not resurrect a locked assignment via a fallback event.
          ...(moduleName === 'assign' ? { availability: restriction ? 'restricted' as const : 'unknown' as const,
            availabilityReason: restriction || 'The deadline is published, but assignment submission access is unconfirmed.' }
            : restriction ? { availability: 'restricted' as const, availabilityReason: restriction } : {}),
        };
        items.set(item.key, item);
      }
    }
    return { courses, items: [...items.values()].filter(item=>!assignmentsOnly || item.kind==='assignment').sort((a, b) => a.key.localeCompare(b.key)), warnings };
  }
}
