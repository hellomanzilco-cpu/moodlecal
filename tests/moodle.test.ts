import assert from 'node:assert/strict';
import test from 'node:test';
import { MoodleClient, MoodleError, moodleText } from '../src/moodle.ts';

const site = 'https://moodle.uwed.uz';
const token = 'student-private-token';
const now = 1_792_000_000;
const required = ['core_enrol_get_users_courses', 'core_course_get_contents', 'mod_assign_get_assignments', 'mod_assign_get_submission_status'];
const optional = [
  'mod_quiz_get_quizzes_by_courses', 'mod_quiz_get_user_attempts',
  'core_calendar_get_calendar_events', 'core_group_get_course_user_groups',
];

interface Request { url: string; options: RequestInit; parameters: URLSearchParams }

test('profile identity reads explicit Moodle name fields and username without retaining password or private response fields',async()=>{
  const f=fixture({core_webservice_get_site_info:{userid:4,fullname:'Full display name',firstname:'<b>Ali</b>',lastname:'Vali &amp; family',username:'ali.uwed',password:'never-expose',userprivateaccesskey:'private-key',functions:required.map(name=>({name}))}});
  const identity=await f.client.identify(token);
  assert.equal(identity.firstName,'Ali');assert.equal(identity.lastName,'Vali & family');assert.equal(identity.username,'ali.uwed');
  assert.ok(!JSON.stringify(identity).includes('never-expose'));assert.ok(!JSON.stringify(identity).includes('private-key'));assert.equal(f.requests.length,1);
});

function fixture(overrides: Record<string, unknown> = {}, functions = [...required, ...optional]) {
  const responses: Record<string, unknown> = {
    core_webservice_get_site_info: { userid: 4, fullname: '<b>Ali &amp; Vali</b>', functions: functions.map((name) => ({ name, version: '2024100700' })) },
    core_enrol_get_users_courses: [{ id: 8, fullname: '<span>Economics</span>', shortname: 'ECO' }],
    core_course_get_contents: [{ id: 1, modules: [
      { id: 10, instance: 20, name: 'Lecture 1', modname: 'resource', uservisible: true, description: '<p>Read <b>chapter 1</b>.</p><script>bad()</script>',
        contents: [{ type: 'file', filename: 'lecture.pptx', filesize: 100, timemodified: 50, fileurl: `https://bad.example/steal?token=${token}` }],
        contentsinfo: { lastmodified: 50 }, completiondata: { state: 0 } },
      { id: 11, instance: 21, name: 'Essay', modname: 'assign', uservisible: true, contents: [] },
      { id: 12, instance: 22, name: 'Term control', modname: 'quiz', uservisible: true, contents: [] },
    ] }],
    mod_assign_get_assignments: { courses: [{ id: 8, assignments: [{ id: 21, cmid: 11, course: 8, name: 'Essay', duedate: now + 3600, cutoffdate: now + 7200, allowsubmissionsfromdate: now - 100, timemodified: 100, intro: '<p>Write about trade.</p>', teamsubmission: 0 }] }], warnings: [] },
    mod_assign_get_submission_status: { lastattempt: { submission: { status: 'draft' }, extensionduedate: now + 5000, graded: false, canedit: true, caneditowner: true, cansubmit: false, submissionsenabled: true, locked: false }, warnings: [] },
    mod_quiz_get_quizzes_by_courses: { quizzes: [{ id: 22, coursemodule: 12, course: 8, name: 'Term control', timeopen: now + 100, timeclose: now + 6000, intro: 'Revise chapter 2.' }], warnings: [] },
    mod_quiz_get_user_attempts: { attempts: [{ id: 7, state: 'finished' }], warnings: [] },
    core_group_get_course_user_groups: { groups: [{ id: 30, courseid: 8 }], warnings: [] },
    core_calendar_get_calendar_events: { events: [
      { id: 40, courseid: 8, modulename: 'assign', instance: 21, eventtype: 'due', name: 'Essay due', timestart: now + 3600 },
      { id: 41, courseid: 8, modulename: 'quiz', instance: 22, eventtype: 'close', name: 'Term control closes', timestart: now + 6000 },
      { id: 42, courseid: 8, modulename: '', eventtype: 'course', name: '<b>Seminar</b>', description: 'Bring notes.', timestart: now + 2000, timeduration: 5400, url: `${site}/calendar/view.php?id=42&wstoken=${token}&sesskey=secret` },
    ], warnings: [] },
    ...overrides,
  };
  const requests: Request[] = [];
  const failures=new Set<string>();
  const fake: typeof fetch = async (input, options = {}) => {
    const request = { url: String(input), options, parameters: new URLSearchParams(String(options.body)) };
    requests.push(request);
    const functionName = request.parameters.get('wsfunction') ?? 'login';
    assert.ok(Object.hasOwn(responses, functionName), `Unexpected Moodle call ${functionName}`);
    if(failures.has(functionName))throw new Error('upstream network failure');
    return Response.json(responses[functionName]);
  };
  return { client: new MoodleClient(site, fake), requests, responses,fail:(functionName:string)=>failures.add(functionName) };
}

test('normalizes student deadlines, resources and group calendar without duplicate activity events', async () => {
  const { client, requests } = fixture();
  const phases:string[]=[];const result = await client.snapshot(token, now,false,phase=>phases.push(phase));
  assert.deepEqual(phases,['profile','synchronizing']);
  assert.deepEqual(result.courses, [{ id: 8, name: 'Economics', shortname: 'ECO' }]);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.items.length, 4);
  const assignment = result.items.find((item) => item.key === 'assignment:21')!;
  assert.equal(assignment.dueAt, now + 5000);
  assert.equal(assignment.completed, false);
  assert.equal(assignment.url, `${site}/mod/assign/view.php?id=11`);
  assert.equal(result.items.find((item) => item.key === 'quiz:22')!.dueAt, now + 6000);
  assert.equal(result.items.find((item) => item.key === 'quiz:22')!.completed, true);
  const resource = result.items.find((item) => item.key === 'module:10')!;
  assert.equal(resource.description, 'Read chapter 1.');
  assert.deepEqual(resource.files, [{ name: 'lecture.pptx', size: 100, modifiedAt: 50 }]);
  assert.equal(result.items.find((item) => item.key === 'event:42')!.endsAt, now + 7400);
  assert.ok(!JSON.stringify(result).includes(token));
  for (const request of requests) {
    assert.equal(request.url, `${site}/webservice/rest/server.php`);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.redirect, 'error');
    assert.ok(request.options.signal instanceof AbortSignal);
    assert.equal(request.parameters.get('wstoken'), token);
  }
  const calendar = requests.find((request) => request.parameters.get('wsfunction') === 'core_calendar_get_calendar_events')!.parameters;
  assert.equal(calendar.get('events[courseids][0]'), '8');
  assert.equal(calendar.get('events[groupids][0]'), '30');
  assert.equal(calendar.get('options[timestart]'), String(now - 7 * 86400));
  assert.equal(calendar.get('options[timeend]'), String(now + 180 * 86400));
});

test('temporary submission-status outage rejects the snapshot before optional endpoints run',async()=>{
  const f=fixture();f.fail('mod_assign_get_submission_status');
  await assert.rejects(f.client.snapshot(token,now),(error:unknown)=>error instanceof MoodleError&&error.reason==='network'&&error.operation==='mod_assign_get_submission_status');
  assert.ok(!f.requests.some(request=>request.parameters.get('wsfunction')==='mod_quiz_get_quizzes_by_courses'));
  assert.ok(!f.requests.some(request=>request.parameters.get('wsfunction')==='core_calendar_get_calendar_events'));
});

test('submission-status API errors reject the snapshot and expose only safe diagnostic metadata',async()=>{
  const f=fixture({mod_assign_get_submission_status:{exception:'moodle_exception',errorcode:'nopermissiontoaccesspage',message:'private Moodle debug response'}});
  await assert.rejects(f.client.snapshot(token,now),(error:unknown)=>{
    assert.ok(error instanceof MoodleError);assert.equal(error.reason,'permission');assert.equal(error.operation,'mod_assign_get_submission_status');assert.equal(error.apiErrorCode,'nopermissiontoaccesspage');assert.doesNotMatch(error.message,/private Moodle debug response/);return true;
  });
});

test('missing and incomplete student status records both reject the snapshot',async()=>{
  for(const [payload,code] of [[{warnings:[]},'missing_lastattempt'],[{lastattempt:{submission:{status:'new'}},warnings:[]},'incomplete_lastattempt']] as const){
    const f=fixture({mod_assign_get_submission_status:payload});
    await assert.rejects(f.client.snapshot(token,now),(error:unknown)=>error instanceof MoodleError&&error.operation==='mod_assign_get_submission_status'&&error.apiErrorCode===code);
  }
});

test('a missing status API rejects the connection before reading assignment data',async()=>{
  const f=fixture({},['core_enrol_get_users_courses','core_course_get_contents','mod_assign_get_assignments']);
  await assert.rejects(f.client.snapshot(token,now),(error:unknown)=>error instanceof MoodleError&&error.reason==='permission'&&error.operation==='mod_assign_get_submission_status');
  assert.ok(!f.requests.some(request=>request.parameters.get('wsfunction')==='mod_assign_get_submission_status'));
});

test('same-name same-size file replacements keep their changed modification timestamp', async () => {
  const { client, responses } = fixture();
  const first = await client.snapshot(token, now);
  const sections = responses.core_course_get_contents as { modules: { contents: { timemodified?: number }[] }[] }[];
  sections[0].modules[0].contents[0].timemodified = 51;
  const second = await client.snapshot(token, now);
  assert.notDeepEqual(first.items.find((item) => item.key === 'module:10'), second.items.find((item) => item.key === 'module:10'));
});
test('assignment report distinguishes drafts, awaiting grades, and graded submissions including zero',async () => {
  const cases=[
    {lastattempt:{submission:{status:'draft'},graded:false},expected:'outstanding',grade:null},
    {lastattempt:{submission:{status:'submitted'},graded:false},expected:'submitted_ungraded',grade:null},
    {lastattempt:{submission:{status:'submitted'},graded:true},feedback:{grade:{grade:'0'},gradefordisplay:'0 / 100'},expected:'submitted_graded',grade:'0 / 100'},
    {lastattempt:{submission:{status:'submitted'},graded:true},expected:'submitted_graded',grade:null},
    {lastattempt:{submission:{status:'submitted',attemptnumber:2},graded:false},feedback:{grade:{grade:'90',attemptnumber:1},gradefordisplay:'90 / 100'},expected:'submitted_ungraded',grade:null},
  ];
  for(const {expected,grade,...status} of cases) {
    const lastattempt=status.lastattempt as Record<string,unknown>;
    const {client}=fixture({mod_assign_get_submission_status:{...status,lastattempt:Object.assign({extensionduedate:0,canedit:true,caneditowner:true,cansubmit:false,submissionsenabled:true,locked:false,graded:false},lastattempt),warnings:[]}});
    const result=await client.snapshot(token,now,true);assert.equal(result.items.length,1);
    assert.equal(result.items[0].submissionStatus,expected);assert.equal(result.items[0].grade,grade);
    assert.equal(result.items[0].startsAt,null);assert.equal(result.items[0].endsAt,null);
  }
});
test('assignment-only inspection verifies assignment status without unrelated quiz/calendar endpoints',async () => {
  const {client,requests}=fixture({},required);
  const result=await client.snapshot(token,now,true);
  assert.equal(result.items.find(item=>item.kind==='assignment')!.submissionStatus,'outstanding');assert.equal(result.items.find(item=>item.kind==='assignment')!.grade,null);
  assert.equal(result.warnings.length,0);
  assert.ok(requests.every(r=>!r.parameters.get('wsfunction')?.includes('quiz') && !r.parameters.get('wsfunction')?.includes('calendar')));
});
test('permission warnings for modules absent from visible contents are reported without blocking accessible assignments',async () => {
  const f=fixture();
  const response=f.responses.mod_assign_get_assignments as {warnings:unknown[]};
  response.warnings=[{item:'module',itemid:999,warningcode:'1',message:'No access rights in module context'}];
  const result=await f.client.snapshot(token,now,true);assert.equal(result.items.length,1);assert.match(result.warnings[0],/1 assignment activities/);
  response.warnings=[{item:'module',itemid:11,warningcode:'1',message:'No access rights in module context'}];
  await assert.rejects(f.client.snapshot(token,now,true),/incomplete data/);
});

test('missing optional APIs reports coverage limitations without invoking unavailable functions', async () => {
  const { client, requests } = fixture({}, required);
  const snapshot = await client.snapshot(token, now);
  assert.equal(snapshot.items.length, 3);
  assert.ok(snapshot.warnings.some((warning) => warning.includes('Quiz availability')));
  assert.ok(snapshot.warnings.some((warning) => warning.includes('calendar events')));
  assert.equal(requests.length, 5);
});

test('API warnings abort the snapshot rather than returning partial data', async () => {
  const { client } = fixture({ mod_assign_get_assignments: { courses: [], warnings: [{ warningcode: 'nopermissions', message: `SECRET ${token}` }] } });
  await assert.rejects(client.snapshot(token, now), (error: unknown) => {
    assert.ok(error instanceof MoodleError);
    assert.equal(error.retryable, true);
    assert.match(error.message, /incomplete data/);
    assert.ok(!error.message.includes(token));
    return true;
  });
});

test('an unexpected optional API failure aborts the snapshot with sanitized text', async () => {
  const { client } = fixture({ mod_quiz_get_user_attempts: { exception: 'moodle_exception', errorcode: 'customproblem', message: token, debuginfo: 'private username/password' } });
  await assert.rejects(client.snapshot(token, now), (error: unknown) => {
    assert.ok(error instanceof MoodleError);
    assert.equal(error.retryable, true);
    assert.ok(!JSON.stringify(error).includes(token));
    return true;
  });
});

test('invalid token and missing mandatory capabilities fail in their actual profile and synchronization stages', async () => {
  const invalid = fixture({ core_webservice_get_site_info: { exception: 'webservice_access_exception', errorcode: 'invalidtoken', message: token } });
  await assert.rejects(invalid.client.identify(token), (error: unknown) => error instanceof MoodleError && !error.retryable && !error.message.includes(token));
  const restricted = fixture({}, ['core_course_get_contents']);
  await assert.rejects(restricted.client.snapshot(token,now), /cannot read enrolled courses/);
});

test('site reachability is checked without credentials and reports an HTTP status safely',async()=>{
 let seenUrl='';let seenOptions:RequestInit|undefined;
 const ok:typeof fetch=async(input,options={})=>{seenUrl=String(input);seenOptions=options;return new Response(null,{status:200});};
 await new MoodleClient(site,ok).checkReachable();assert.equal(seenUrl,`${site}/login/index.php`);assert.equal(seenOptions?.method,'GET');assert.equal(seenOptions?.body,undefined);assert.equal(seenOptions?.redirect,'manual');
 const unavailable:typeof fetch=async()=>new Response(null,{status:503});
 await assert.rejects(new MoodleClient(site,unavailable).checkReachable(),(error:unknown)=>error instanceof MoodleError&&error.reason==='network'&&error.operation==='moodle_reachability'&&error.httpStatus===503);
});

test('submitted personal work is completed; team members who still need to submit are incomplete', async () => {
  const personal = fixture({ mod_assign_get_submission_status: { lastattempt: { submission: { status: 'submitted' },extensionduedate:0,graded:false,canedit:true,caneditowner:true,cansubmit:false,submissionsenabled:true,locked:false }, warnings: [] } });
  assert.equal((await personal.client.snapshot(token, now)).items.find((item) => item.kind === 'assignment')!.completed, true);
  const group = fixture({
    mod_assign_get_assignments: { courses: [{ id: 8, assignments: [{ id: 21, cmid: 11, name: 'Team essay', teamsubmission: 1, duedate: now + 3600 }] }], warnings: [] },
    mod_assign_get_submission_status: { lastattempt: { teamsubmission: { status: 'submitted' }, submissiongroupmemberswhoneedtosubmit: [4],extensionduedate:0,graded:false,canedit:true,caneditowner:true,cansubmit:false,submissionsenabled:true,locked:false }, warnings: [] },
  });
  assert.equal((await group.client.snapshot(token, now)).items.find((item) => item.kind === 'assignment')!.completed, false);
});

test('malformed advertised API output fails the whole snapshot', async () => {
  const { client } = fixture({ mod_quiz_get_quizzes_by_courses: { warnings: [] } });
  await assert.rejects(client.snapshot(token, now), (error: unknown) => error instanceof MoodleError && error.retryable);
});

test('calendar deadline fallback does not assume an assignment is actionable without its access data', async () => {
  const f=fixture({},[...required,'core_calendar_get_calendar_events']);
  f.responses.mod_assign_get_assignments={courses:[{id:8,assignments:[]}],warnings:[]};
  const snapshot = await f.client.snapshot(token, now);
  assert.equal(snapshot.items.find((item) => item.key === 'event:40')!.dueAt, now + 3600);
  assert.equal(snapshot.items.find((item) => item.key === 'event:40')!.availability, 'unknown');
  assert.equal(snapshot.items.find((item) => item.key === 'event:41')!.dueAt, now + 6000);
});

test('team submission with required individual confirmations stays unfinished when membership status is unknown', async () => {
  const { client } = fixture({
    mod_assign_get_assignments: { courses: [{ id: 8, assignments: [{ id: 21, cmid: 11, name: 'Team essay', teamsubmission: 1, requireallteammemberssubmit: 1, duedate: now + 3600 }] }], warnings: [] },
    mod_assign_get_submission_status: { lastattempt: { teamsubmission: { status: 'submitted' },extensionduedate:0,graded:false,canedit:true,caneditowner:true,cansubmit:false,submissionsenabled:true,locked:false }, warnings: [] },
  });
  assert.equal((await client.snapshot(token, now)).items.find((item) => item.kind === 'assignment')!.completed, false);
});

test('username/password login uses POST without retaining private token response fields', async () => {
  let seen: Request | undefined;
  const fake: typeof fetch = async (input, options = {}) => {
    seen = { url: String(input), options, parameters: new URLSearchParams(String(options.body)) };
    return Response.json({ token, privatetoken: 'private-token-not-needed' });
  };
  const client = new MoodleClient(site, fake);
  assert.equal(await client.login(' student ', 'password-secret'), token);
  assert.equal(seen!.url, `${site}/login/token.php`);
  assert.equal(seen!.options.method, 'POST');
  assert.equal(seen!.parameters.get('username'), 'student');
  assert.equal(seen!.parameters.get('password'), 'password-secret');
  assert.equal(seen!.parameters.get('service'), 'moodle_mobile_app');
});

test('known invalid login responses are distinguished from service and network failures',async()=>{
 const invalid:typeof fetch=async()=>Response.json({error:'invalid login'});
 await assert.rejects(new MoodleClient(site,invalid).login('student','wrong'),(error:unknown)=>error instanceof MoodleError&&error.reason==='authentication'&&error.operation==='login_token'&&error.apiErrorCode==='invalidlogin'&&/rejected/.test(error.message));
 const extraStep:typeof fetch=async()=>Response.json({errorcode:'forcepasswordchange',message:'private server detail'});
 await assert.rejects(new MoodleClient(site,extraStep).login('student','password'),(error:unknown)=>error instanceof MoodleError&&error.reason==='upstream'&&error.apiErrorCode==='forcepasswordchange'&&!/private server detail/.test(error.message));
});

test('network failures and rate limits are retryable without exposing raw fetch messages', async () => {
  const throwing: typeof fetch = async () => { throw new Error(`https://example.com?token=${token}`); };
  await assert.rejects(new MoodleClient(site, throwing).identify(token), (error: unknown) => error instanceof MoodleError && error.retryable && !error.message.includes(token));
  const limited: typeof fetch = async () => new Response('slow down', { status: 429 });
  await assert.rejects(new MoodleClient(site, limited).identify(token), (error: unknown) => error instanceof MoodleError && error.retryable);
});

test('plain text removes active markup and token-bearing visible URLs', () => {
  assert.equal(moodleText('<style>hidden</style><p>A &amp; B &#x1f4da;</p>'), 'A & B 📚');
  assert.ok(!moodleText(`https://moodle.uwed.uz/pluginfile.php?token=${token}&id=1`).includes(token));
});

test('assignment access uses evaluated edit permissions rather than final-submit button or due date', async () => {
  const cases = [
    { label: 'new or draft work with no separate submit step', last: {canedit:true,caneditowner:true,cansubmit:false}, expected:'open' },
    { label: 'older Moodle returning only owner edit flag', last: {caneditowner:true,cansubmit:false}, expected:'open' },
    { label: 'group membership can forbid editing despite general owner capability', last: {canedit:false,caneditowner:true,cansubmit:false}, expected:'restricted' },
    { label: 'final submission permitted', last: {canedit:false,cansubmit:true}, expected:'open' },
    { label: 'future opening', last: {canedit:false,cansubmit:false}, assignment:{allowsubmissionsfromdate:now+3600}, expected:'upcoming' },
    { label: 'past due date without cutoff still accepts late work', last: {canedit:true,cansubmit:false}, assignment:{duedate:now-100,cutoffdate:0}, expected:'open' },
    { label: 'no published due date still allows work', last: {canedit:true,cansubmit:false}, assignment:{duedate:0}, expected:'open' },
    { label: 'cutoff closed', last: {canedit:false,cansubmit:false}, assignment:{cutoffdate:now-100}, expected:'closed' },
    { label: 'extension supersedes cutoff', last: {canedit:true,cansubmit:false,extensionduedate:now+100}, assignment:{cutoffdate:now-100}, expected:'open' },
    { label: 'teacher lock', last: {canedit:false,cansubmit:false,locked:true}, expected:'restricted' },
    { label: 'offline activity', last: {submissionsenabled:false,canedit:false,cansubmit:false}, expected:'restricted' },
  ];
  for(const scenario of cases) {
    const f=fixture();
    const assignments=f.responses.mod_assign_get_assignments as {courses:{assignments:Record<string,unknown>[]}[]};
    Object.assign(assignments.courses[0].assignments[0],scenario.assignment ?? {});
    f.responses.mod_assign_get_submission_status={lastattempt:Object.assign({submission:{status:'new'},extensionduedate:0,graded:false,canedit:true,caneditowner:true,cansubmit:false,submissionsenabled:true,locked:false},scenario.last),warnings:[]};
    const result=await f.client.snapshot(token,now,true);
    assert.equal(result.items[0].availability,scenario.expected,scenario.label);
    assert.equal(result.items[0].submissionStatus,'outstanding',scenario.label);
  }
});

test('visible restricted modules retain the evaluated access reason without calling submission APIs', async () => {
  const f=fixture();
  const sections=f.responses.core_course_get_contents as {modules:Record<string,unknown>[]}[];
  Object.assign(sections[0].modules[1],{uservisible:false,availabilityinfo:'<p>Not available until previous activity is complete.</p>'});
  f.responses.mod_assign_get_assignments={courses:[],warnings:[{item:'module',itemid:11,warningcode:'1'}]};
  const result=await f.client.snapshot(token,now,true);
  assert.equal(result.items[0].availability,'restricted');
  assert.equal(result.items[0].availabilityReason,'Not available until previous activity is complete.');
  assert.ok(!f.requests.some(r=>r.parameters.get('wsfunction')==='mod_assign_get_submission_status'));
});

test('section visibility overrides otherwise accessible-looking module metadata', async () => {
  const f=fixture();
  const sections=f.responses.core_course_get_contents as Record<string,unknown>[];
  sections[0].uservisible=false;
  sections[0].availabilityinfo='This section is not available yet.';
  f.responses.mod_assign_get_assignments={courses:[],warnings:[{item:'module',itemid:11,warningcode:'1'}]};
  const result=await f.client.snapshot(token,now,true);
  assert.equal(result.items[0].availability,'restricted');
  assert.match(result.items[0].availabilityReason!,/section is not available/);
});
