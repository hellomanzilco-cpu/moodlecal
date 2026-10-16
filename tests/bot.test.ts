import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { Bot } from '../src/bot.ts';
import { Store } from '../src/store.ts';
import { TelegramClient, TelegramError, splitTelegramText } from '../src/telegram.ts';
import type { BotServices } from '../src/bot.ts';
import type { Item, MessageOptions, Messenger, Student } from '../src/types.ts';

const now = () => Math.floor(Date.now() / 1000);
function item(key: string, title = key): Item {
  return { key, courseId: 5, courseName: 'Economics', kind: 'assignment', title, description: 'Read the requirements in Moodle.', url: 'https://moodle.uwed.uz/mod/assign/view.php?id=1', modifiedAt: now(), dueAt: now() + 3600, startsAt: null, endsAt: null, completed: false, availability: 'open' };
}
function setup(t: { after(fn: () => void): void }) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sent: { chatId: number; text: string; options?: MessageOptions }[] = [];
  const messenger: Messenger = { async send(chatId, text, options) { sent.push({ chatId, text, options }); } };
  const calls: { sync: number[]; connect: number[]; calendar: { id: number; rotate: boolean }[] } = { sync: [], connect: [], calendar: [] };
  const services: BotServices = {
    connectLink(id) { calls.connect.push(id); return `https://calendar.test/connect/private-${id}`; },
    calendarLink(id, rotate = false) { calls.calendar.push({ id, rotate }); return `https://calendar.test/calendar/private-${id}.ics`; },
    async sync(id) { calls.sync.push(id); },
  };
  const bot = new Bot(store, messenger, services);
  let sequence = 0;
  const update = (telegramId: number, text: string, extra: Record<string, unknown> = {}) => ({ update_id: ++sequence, message: { chat: { id: telegramId, type: 'private' }, from: { id: telegramId, is_bot: false }, text, ...extra } });
  async function send(telegramId: number, text: string) { await bot.handle(update(telegramId, text)); return sent.at(-1)!.text; }
  function connected(telegramId: number, items: Item[] = []): Student {
    const student = store.ensureStudent(telegramId, telegramId);
    store.patchStudent(student.id, { moodleCipher: 'encrypted-for-test', calendarHash: `calendar-${telegramId}`, calendarCipher: 'calendar-cipher', linkHash: `link-${telegramId}`, linkExpires: now() + 300 });
    store.saveSnapshot(student.id, { courses: [{ id: 5, name: 'Economics', shortname: 'ECON' }], items, warnings: [] }, [], now() - 70, now());
    return store.getStudent(student.id)!;
  }
  return { store, sent, services, calls, bot, update, send, connected };
}
const labels = (options?: MessageOptions) => options?.reply_markup?.keyboard.flatMap(row => row.map(button => button.text)) ?? [];

test('emoji reply buttons navigate the main menu and settings without slash commands', async t => {
  const s = setup(t);
  const alice = s.connected(101, [item('assignment:alice', 'Alice assignment')]);
  const bob = s.connected(202);
  await s.send(101, '/start');
  assert.match(s.sent.at(-1)!.text, /Your UWED study planner/);
  assert.ok(s.sent.at(-1)!.text.length<350);
  assert.equal(s.sent.at(-1)!.options?.reply_markup?.is_persistent, true);
  assert.deepEqual(labels(s.sent.at(-1)!.options), ['🏠 Today', '📝 Assignments', '📚 My courses', '🔄 Sync', '🧭 More', '⚙️ Settings']);
  await s.send(101,'🧭 More');assert.ok(labels(s.sent.at(-1)!.options).includes('🗓 Calendar'));
  assert.match(await s.send(101, '🎯 Priorities'), /Alice assignment/);
  await s.send(101, '⚙️ Settings');
  assert.ok(labels(s.sent.at(-1)!.options).includes('🔔 Pause alerts'));
  await s.send(101, '🔔 Pause alerts');
  assert.equal(s.store.getStudent(alice.id)!.paused, true);
  assert.equal(s.store.getStudent(bob.id)!.paused, false);
  assert.ok(labels(s.sent.at(-1)!.options).includes('🔔 Resume alerts'));
  await s.send(101, '🌍 Time zone');
  assert.match(s.sent.at(-1)!.text, /Type your IANA/);
  await s.send(101, 'Europe/London');
  assert.equal(s.store.getStudent(alice.id)!.timezone, 'Europe/London');
  assert.equal(s.store.getStudent(bob.id)!.timezone, 'Asia/Tashkent');
  await s.send(101, '⬅️ Main menu');
  assert.ok(labels(s.sent.at(-1)!.options).includes('📝 Assignments'));
});

test('assignment buttons show Moodle submission status independently of personal completion', async t => {
  const s = setup(t);
  const alice = s.connected(101, [
    { ...item('assignment:1', 'Outstanding essay'), submissionStatus: 'outstanding' },
    { ...item('assignment:2', 'Submitted report'), submissionStatus: 'submitted_ungraded', completed: true },
    { ...item('assignment:3', 'Graded paper'), submissionStatus: 'submitted_graded', grade: '87 / 100', completed: true },
    { ...item('assignment:4', 'Unknown task'), submissionStatus: 'unknown' },
  ]);
  s.connected(202, [{ ...item('assignment:bob', 'Bob private report'), submissionStatus: 'submitted_graded', grade: '90' }]);
  s.store.markDone(alice.id, 'assignment:1', true);
  const overview = await s.send(101, '📝 Assignments');
  assert.match(overview, /Next deadlines \/ overdue: 1/);
  assert.match(overview, /Awaiting grades: 1/);
  assert.match(overview, /Graded: 1/);
  assert.match(overview, /status is unavailable for 1 assignment/);
  assert.deepEqual(labels(s.sent.at(-1)!.options), ['⏳ Next deadlines', '🕓 Later / undated', '📨 Awaiting grades', '✅ Graded', '⬅️ Main menu']);
  const outstanding = await s.send(101, '⏳ Outstanding');
  assert.match(outstanding, /Outstanding essay/);
  assert.doesNotMatch(outstanding, /Submitted report|Graded paper|Bob private/);
  const awaiting = await s.send(101, '📨 Awaiting grades');
  assert.match(awaiting, /Submitted report/);
  assert.doesNotMatch(awaiting, /Outstanding essay|Graded paper/);
  const graded = await s.send(101, '✅ Graded');
  assert.match(graded, /Graded paper/);
  assert.match(graded, /Grade: 87 \/ 100/);
  assert.doesNotMatch(graded, /Bob private/);
});

test('active and upcoming buttons keep inactive tasks out of priorities, agenda, and preparation', async t => {
  const s=setup(t);
  const today=DateTime.now().setZone('Asia/Tashkent');
  const due=Math.floor(today.endOf('day').toSeconds());
  s.connected(101,[
    {...item('assignment:open','Available essay'),dueAt:due,submissionStatus:'outstanding'},
    {...item('assignment:future','Future essay'),dueAt:due,submissionStatus:'outstanding',availability:'upcoming',availableFrom:now()+86400,availabilityReason:'Opening date has not arrived.'},
    {...item('assignment:locked','Locked essay'),dueAt:due,submissionStatus:'outstanding',availability:'restricted',availabilityReason:'Complete the previous activity in Moodle.'},
    {...item('assignment:submitted','Submitted locked essay'),dueAt:due,submissionStatus:'submitted_ungraded',availability:'restricted',completed:true},
  ]);
  const overview=await s.send(101,'📝 Assignments');
  assert.match(overview,/Next deadlines \/ overdue: 1/);assert.match(overview,/Later \/ undated: 2/);assert.match(overview,/Awaiting grades: 1/);assert.match(overview,/Total unfinished: 3/);
  const active=await s.send(101,'⏳ Active now');
  assert.match(active,/Available essay/);assert.doesNotMatch(active,/Future essay|Locked essay|Submitted locked essay/);
  const future=await s.send(101,'🕓 Upcoming / locked');
  assert.match(future,/Future essay/);assert.match(future,/Opens:/);assert.match(future,/Locked essay/);assert.match(future,/Complete the previous activity/);
  for(const button of ['🎯 Priorities','🏠 Today','📅 This week','📖 All courses']) {
    const view=await s.send(101,button);
    assert.match(view,/Available essay/);assert.doesNotMatch(view,/Future essay|Locked essay|Submitted locked essay/);
  }
  assert.match(await s.send(101,'📨 Awaiting grades'),/Submitted locked essay/);
});

test('course preparation buttons contain only the student courses and validate forged selections', async t => {
  const s = setup(t);
  s.connected(101, [{ ...item('resource:1', 'Alice slides'), kind: 'resource', dueAt: null }]);
  const bob = s.connected(202);
  s.store.saveSnapshot(bob.id, { courses: [{ id: 9, name: 'Bob private course', shortname: 'PRIVATE' }], items: [], warnings: [] }, [], now(), now() + 300);
  await s.send(101, '📖 Prepare');
  assert.ok(labels(s.sent.at(-1)!.options).includes('📘 5: Economics'));
  assert.ok(!labels(s.sent.at(-1)!.options).some(label => label.includes('Bob private')));
  assert.match(await s.send(101, '📘 5: Economics'), /Alice slides/);
  assert.match(await s.send(101, '📘 9: Bob private course'), /Course not found/);
});

test('disconnect button requires this student confirmation and main menu cancels it', async t => {
  const s = setup(t);
  const alice = s.connected(101);
  const bob = s.connected(202);
  await s.send(101, '🔒 Disconnect');
  assert.ok(s.store.getStudent(alice.id));
  assert.deepEqual(labels(s.sent.at(-1)!.options), ['🗑 Yes, disconnect', '⬅️ Main menu']);
  await s.send(202, '🗑 Yes, disconnect');
  assert.ok(s.store.getStudent(bob.id));
  await s.send(101, '⬅️ Main menu');
  await s.send(101, '🗑 Yes, disconnect');
  assert.ok(s.store.getStudent(alice.id));
  await s.send(101, '🔒 Disconnect');
  await s.send(101, '🗑 Yes, disconnect');
  assert.equal(s.store.getStudent(alice.id), null);
  assert.ok(s.store.getStudent(bob.id));
  assert.ok(labels(s.sent.at(-1)!.options).includes('🔗 Connect Moodle'));
});

test('Auto update refreshes only the requesting student and shows changes, while recent history stays scoped',async t=>{
  const s=setup(t);const alice=s.connected(101),bob=s.connected(202);const refreshed:number[]=[];
  s.services.refresh=async id=>{refreshed.push(id);return '🔄 1 change found: assignment deadline moved.';};
  s.services.recentUpdates=id=>id===alice.id?'Alice deadline moved.':'Bob grade was released.';
  assert.match(await s.send(101,'🔄 Auto update'),/deadline moved/);assert.deepEqual(refreshed,[alice.id]);
  assert.match(await s.send(101,'🔄 Auto update'),/Please wait/);assert.equal(refreshed.length,1);
  assert.doesNotMatch(await s.send(101,'📰 Recent updates'),/Bob/);assert.match(await s.send(202,'📰 Recent updates'),/Bob grade/);
  assert.equal(s.store.getStudent(bob.id)!.paused,false);
});

test('cached responses preserve buttons across transport retry without repeating changes', async t => {
  const s = setup(t);
  s.connected(101);
  let attempts = 0;
  const responses: { text: string; options?: MessageOptions }[] = [];
  const messenger: Messenger = { async send(_chatId, text, options) {
    responses.push({ text, options });
    if (++attempts === 1) throw new Error('offline');
  } };
  const update = s.update(101, '/calendar rotate');
  await assert.rejects(new Bot(s.store, messenger, s.services).handle(update), /offline/);
  await new Bot(s.store, messenger, s.services).handle(update);
  assert.equal(s.calls.calendar.length, 1);
  assert.deepEqual(responses[0], responses[1]);
  assert.ok(labels(responses[1].options).includes('🏠 Today'));
});

test('bot accepts only a real student in their private chat', async t => {
  const s = setup(t);
  await s.bot.handle(s.update(101, '/connect', { chat: { id: -100, type: 'supergroup' } }));
  await s.bot.handle(s.update(101, '/connect', { chat: { id: 202, type: 'private' } }));
  await s.bot.handle(s.update(101, '/connect', { from: { id: 101, is_bot: true } }));
  await s.bot.handle({ update_id: 99, edited_message: { text: '/connect' } });
  assert.equal(s.sent.length, 0);
  assert.equal(s.store.byTelegram(101), null);
  await s.send(101, '/connect');
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.calls.connect, [s.store.byTelegram(101)!.id]);
  assert.match(s.sent[0].text, /Do not forward/);
  assert.ok(s.sent[0].options!.reply_markup!.keyboard[0][0].web_app);
});

test('bot remembers successful updates and retries failed delivery', async t => {
  const s = setup(t);
  let attempts = 0;
  const bot = new Bot(s.store, { async send() { if (++attempts === 1) throw new Error('offline'); } }, s.services);
  const update = s.update(101, '/help');
  await assert.rejects(bot.handle(update), /offline/);
  assert.equal(s.store.hasUpdate(update.update_id), false);
  await bot.handle(update);
  await bot.handle(update);
  assert.equal(attempts, 2);
  assert.equal(s.store.hasUpdate(update.update_id), true);
});

test('course views, completion, and mute settings stay inside one student account', async t => {
  const s = setup(t);
  const alice = s.connected(101, [item('assignment:alice', 'Alice task')]);
  const bob = s.connected(202, [item('assignment:bob', 'Bob task')]);
  const priorities = await s.send(101, '/priorities');
  assert.match(priorities, /Alice task/);
  assert.doesNotMatch(priorities, /Bob task/);
  assert.match(await s.send(101, '/done assignment:bob'), /not found/i);
  assert.equal(s.store.items(bob.id)[0].completed, false);
  await s.send(101, '/done assignment:alice');
  assert.equal(s.store.items(alice.id)[0].completed, true);
  assert.doesNotMatch(await s.send(101, '/priorities'), /Alice task/);
  await s.send(101, '/undo assignment:alice');
  assert.equal(s.store.items(alice.id)[0].completed, false);
  await s.send(101, '/mute 5');
  assert.equal(s.store.courses(alice.id)[0].muted, true);
  assert.equal(s.store.courses(bob.id)[0].muted, false);
  assert.doesNotMatch(await s.send(101, '/priorities'), /Alice task/);
  await s.send(101, '/unmute 5');
  assert.match(await s.send(101, '/priorities'), /Alice task/);
});

test('private calendar requires connection, rotation is explicit, and credentials are never echoed', async t => {
  const s = setup(t);
  assert.match(await s.send(101, '/calendar'), /Connect your Moodle account first/);
  assert.equal(s.calls.calendar.length, 0);
  const student = s.connected(101);
  await s.send(101, '/calendar');
  await s.send(101, '/calendar rotate');
  assert.deepEqual(s.calls.calendar, [{ id: student.id, rotate: false }, { id: student.id, rotate: true }]);
  const response = await s.send(101, 'my-password-secret');
  assert.doesNotMatch(response, /my-password-secret/);
  assert.match(response, /Never send Moodle passwords/);
});

test('disconnect removes all personal data, calendar access, and pending notices', async t => {
  const s = setup(t);
  const alice = s.connected(101, [item('assignment:alice')]);
  const bob = s.connected(202, [item('assignment:bob')]);
  s.store.addClass(alice.id, { courseId: 5, weekday: 1, time: '09:00', duration: 80, title: 'Seminar', location: '204', until: '2027-01-31' });
  s.store.markDone(alice.id, 'assignment:alice', true);
  s.store.enqueue(alice.id, 'alice-notice', 'A pending alert');
  await s.send(101, '/disconnect');
  assert.equal(s.store.byTelegram(101), null);
  assert.equal(s.store.byCalendar('calendar-101'), null);
  assert.equal(s.store.byLink('link-101', now()), null);
  assert.deepEqual(s.store.classes(alice.id), []);
  assert.deepEqual(s.store.items(alice.id), []);
  assert.deepEqual(s.store.courses(alice.id), []);
  assert.deepEqual(s.store.pending(now()), []);
  assert.ok(s.store.getStudent(bob.id));
  assert.equal(s.store.items(bob.id).length, 1);
});

test('manual classes validate courses, date, time and duration, and deletion is scoped', async t => {
  const s = setup(t);
  const alice = s.connected(101);
  const bob = s.connected(202);
  const until = DateTime.now().setZone('Asia/Tashkent').plus({ months: 3 }).toISODate()!;
  assert.match(await s.send(101, `/class 999 | Mon | 09:00 | 80 | Seminar | 204 | ${until}`), /enrolled course IDs/);
  assert.match(await s.send(101, `/class 5 | Mon | 25:00 | 80 | Seminar | 204 | ${until}`), /valid weekday/);
  assert.match(await s.send(101, `/class 5 | Mon | 09:00 | 0 | Seminar | 204 | ${until}`), /duration/);
  assert.match(await s.send(101, '/class 5 | Mon | 09:00 | 80 | Seminar | 204 | 2027-02-30'), /valid semester end date/);
  assert.match(await s.send(101, '/class 5 | Mon | 09:00 | 80 | Seminar | 204 | 2035-01-01'), /valid semester end date/);
  assert.equal(s.store.classes(alice.id).length, 0);
  assert.match(await s.send(101, `/class 5 | Mon | 09:00 | 80 | Seminar | 204 | ${until}`), /Class \d+ saved/);
  const saved = s.store.classes(alice.id)[0];
  assert.equal(saved.weekday, 1);
  assert.equal(saved.time, '09:00');
  assert.match(await s.send(202, `/unclass ${saved.id}`), /not found/);
  assert.equal(s.store.classes(alice.id).length, 1);
  assert.equal(s.store.classes(bob.id).length, 0);
  assert.match(await s.send(101, `/unclass ${saved.id}`), /Class removed/);
  assert.equal(s.store.classes(alice.id).length, 0);
});

test('today follows the student time zone and excludes completed work', async t => {
  const s = setup(t);
  const today = DateTime.now().setZone('Asia/Tashkent');
  const current = item('assignment:today', 'Today task');
  current.dueAt = Math.floor(today.endOf('day').toSeconds());
  const finished = { ...item('assignment:done', 'Finished task'), dueAt:current.dueAt, completed: true };
  const student = s.connected(101, [current, finished]);
  s.store.addClass(student.id, { courseId: 5, weekday: today.weekday, time: '09:00', duration: 80, title: 'Today seminar', location: '204', until: today.plus({ months: 1 }).toISODate()! });
  const response = await s.send(101, '/today');
  assert.match(response, /Today task/);
  assert.match(response, /Today seminar/);
  assert.doesNotMatch(response, /Finished task/);
  assert.match(response, /Asia\/Tashkent/);
  assert.match(await s.send(101, '/timezone invalid/zone'), /valid IANA/);
  await s.send(101, '/timezone Europe/London');
  assert.equal(s.store.getStudent(student.id)!.timezone, 'Europe/London');
});

test('timetable limits are per student and muted classes disappear from agenda views', async t => {
  const s = setup(t);
  const alice = s.connected(101);
  const bob = s.connected(202);
  const today = DateTime.now().setZone('Asia/Tashkent');
  const until = today.plus({ months: 1 }).toISODate()!;
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][today.weekday - 1];
  for (let index = 0; index < 100; index++) s.store.addClass(alice.id, { courseId: 5, weekday: today.weekday, time: '09:00', duration: 80, title: `Seminar ${index}`, location: '204', until });
  assert.match(await s.send(101, `/class 5 | ${day} | 09:00 | 80 | Extra | 204 | ${until}`), /limit of 100/);
  assert.match(await s.send(202, `/class 5 | ${day} | 09:00 | 80 | Bob seminar | 204 | ${until}`), /saved/);
  assert.equal(s.store.classes(bob.id).length, 1);
  assert.match(await s.send(202, '/today'), /Bob seminar/);
  await s.send(202, '/mute 5');
  assert.doesNotMatch(await s.send(202, '/today'), /Bob seminar/);
  assert.match(await s.send(202, '/classes'), /Bob seminar/);
});

test('preparation is explicit about source limits and pause/resume changes only the owner', async t => {
  const s = setup(t);
  const alice = s.connected(101, [{ ...item('resource:1', 'Lecture slides'), kind: 'resource', dueAt: null }]);
  const bob = s.connected(202);
  const preparation = await s.send(101, '/prepare 5');
  assert.match(preparation, /document contents have not been read/);
  assert.match(preparation, /Lecture slides/);
  assert.match(await s.send(101, '/prepare 999'), /not found/);
  await s.send(101, '/pause');
  assert.equal(s.store.getStudent(alice.id)!.paused, true);
  assert.equal(s.store.getStudent(bob.id)!.paused, false);
  await s.send(101, '/resume');
  assert.equal(s.store.getStudent(alice.id)!.paused, false);
});

test('sync throttles repeated calls and never exposes sensitive failure details', async t => {
  const s = setup(t);
  const student = s.connected(101);
  let attempts = 0;
  const bot = new Bot(s.store, { async send(chatId, text) { s.sent.push({ chatId, text }); } }, {
    ...s.services,
    async sync() { attempts++; throw new Error('password=private-token https://api.telegram.org/botSECRET'); },
  });
  await bot.handle(s.update(101, '/sync'));
  assert.match(s.sent.at(-1)!.text, /could not be synced/);
  assert.doesNotMatch(s.sent.at(-1)!.text, /private-token|SECRET/);
  await bot.handle(s.update(101, '/sync'));
  assert.equal(attempts, 1);
  assert.match(s.sent.at(-1)!.text, /wait/);
  s.store.patchStudent(student.id, { lastSyncAt: now() - 3600, lastError: 'secret access details' });
  const status = await s.send(101, '/status');
  assert.match(status, /may be out of date/);
  assert.match(status, /coverage problem/);
  assert.doesNotMatch(status, /secret access details/);
});

test('Telegram splitting keeps all text and preserves surrogate pairs', () => {
  const original = 'a'.repeat(3999) + '🎓' + '\nMoodle'.repeat(900);
  const chunks = splitTelegramText(original);
  assert.equal(chunks.join(''), original);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4000);
    assert.equal(chunk.isWellFormed(), true);
  }
});

test('Telegram sends plain text and disables previews for private links', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const client = new TelegramClient('123:test_token', async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: {} });
  });
  await client.send(101, 'A <deadline> & _task_');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.text, 'A <deadline> & _task_');
  assert.equal(requests[0].body.parse_mode, undefined);
  assert.deepEqual(requests[0].body.link_preview_options, { is_disabled: true });
});

test('Telegram attaches a reply keyboard only to the final message chunk', async () => {
  const requests: Record<string, unknown>[] = [];
  const client = new TelegramClient('123:test_token', async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: {} });
  });
  const options: MessageOptions = { reply_markup: { keyboard: [[{ text: '🏠 Today' }]], resize_keyboard: true, is_persistent: true } };
  await client.send(101, 'a'.repeat(4001), options);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].reply_markup, undefined);
  assert.deepEqual(requests[1].reply_markup, options.reply_markup);
  assert.equal(requests[1].parse_mode, undefined);
});

test('Telegram long polling filters messages and sanitizes errors while preserving retry-after', async () => {
  let body: Record<string, unknown> = {};
  const client = new TelegramClient('123:test_token', async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ ok: true, result: [{ update_id: 7 }] });
  });
  assert.deepEqual(await client.getUpdates(7), [{ update_id: 7 }]);
  assert.equal(body.offset, 7);
  assert.equal(body.timeout, 25);
  assert.deepEqual(body.allowed_updates, ['message']);
  const network = new TelegramClient('123:test_token', async () => { throw new Error('https://api.telegram.org/bot123:test_token/getUpdates'); });
  await assert.rejects(network.getUpdates(0), error => error instanceof TelegramError && !String(error).includes('test_token'));
  const limited = new TelegramClient('123:test_token', async () => Response.json({ ok: false, description: 'secret payload', parameters: { retry_after: 42 } }, { status: 429 }));
  await assert.rejects(limited.getUpdates(0), error => error instanceof TelegramError && error.retryAfter === 42 && error.statusCode === 429 && !String(error).includes('secret payload'));
});
test('assignment pages stay concise, support both directions and do not expose another student',async t=>{
 const s=setup(t);s.connected(101,Array.from({length:14},(_,index)=>({...item('assignment:'+index,'Task '+String(index).padStart(2,'0')),submissionStatus:'outstanding' as const,dueAt:now()+3600})));
 s.connected(202,[{...item('assignment:private','Private Bob task'),submissionStatus:'outstanding'}]);
 const first=await s.send(101,'⏳ Next deadlines');assert.match(first,/Task 00/);assert.doesNotMatch(first,/Task 06|Private Bob/);assert.match(first,/1–6 of 14/);
 assert.ok(labels(s.sent.at(-1)!.options).includes('➡️ Next page'));
 const second=await s.send(101,'➡️ Next page');assert.match(second,/Task 06/);assert.doesNotMatch(second,/Task 00|Task 12/);
 assert.match(await s.send(101,'⬅️ Previous page'),/Task 00/);
 await s.send(101,'⬅️ Main menu');assert.ok(!labels(s.sent.at(-1)!.options).includes('➡️ Next page'));
});
test('new students see only a native Connect window and independent-author disclosure',async t=>{
 const s=setup(t);const welcome=await s.send(101,'/start');assert.ok(welcome.length<250);assert.doesNotMatch(welcome,/\/class|\/mute/);
 assert.deepEqual(labels(s.sent.at(-1)!.options),['🔗 Connect Moodle']);
 assert.match(welcome,/Tursunov Sunnatilla/);assert.match(welcome,/Not created by UWED/);assert.match(welcome,/@sunnatilla_tursunov/);
 assert.match(s.sent.at(-1)!.options!.reply_markup!.keyboard[0][0].web_app!.url,/^https:\/\//);
});
test('Mini App return refreshes the menu without trusting the payload for authorization',async t=>{
 const s=setup(t);
 const payload=(id:number)=>({update_id:id,message:{chat:{id:101,type:'private'},from:{id:101,is_bot:false},web_app_data:{data:JSON.stringify({action:'connected'}),button_text:'🔗 Connect Moodle'}}});
 await s.bot.handle(payload(100));assert.deepEqual(labels(s.sent.at(-1)!.options),['🔗 Connect Moodle']);assert.equal(s.store.byTelegram(101)!.moodleCipher,null);
 s.connected(101);await s.bot.handle(payload(101));assert.ok(labels(s.sent.at(-1)!.options).includes('🔄 Sync'));
});
test('assignment rows open private native windows for only the requesting student and displayed page',async t=>{
 const s=setup(t);const alice=s.connected(101,Array.from({length:8},(_,i)=>({...item('assignment:'+(i+1),'Essay '+i),submissionStatus:'outstanding' as const})));s.connected(202,[{...item('assignment:99','Bob private essay'),submissionStatus:'outstanding'}]);const links:{id:number;key:string}[]=[];s.services.assignmentLink=(id,key)=>{links.push({id,key});return 'https://calendar.test/assignment#session=private-'+id+'-'+key;};
 await s.send(101,'⏳ Next deadlines');assert.equal(links.length,6);assert.ok(links.every(link=>link.id===alice.id));assert.ok(!labels(s.sent.at(-1)!.options).some(text=>text.includes('Bob private')));assert.equal(s.sent.at(-1)!.options!.reply_markup!.keyboard.flat().filter(button=>button.web_app).length,6);
 await s.send(101,'➡️ Next page');assert.equal(s.sent.at(-1)!.options!.reply_markup!.keyboard.flat().filter(button=>button.web_app).length,2);await s.send(101,'⬅️ Main menu');assert.ok(!s.sent.at(-1)!.options!.reply_markup!.keyboard.flat().some(button=>button.web_app));
});
test('reconnection opens a fresh native window and unconnected menus keep only Connect',async t=>{
 const s=setup(t);
 await s.send(101,'/start');await s.send(101,'⚙️ Settings');assert.deepEqual(labels(s.sent.at(-1)!.options),['🔗 Connect Moodle']);
 s.connected(101);await s.send(101,'🔗 Reconnect Moodle');
 assert.deepEqual(labels(s.sent.at(-1)!.options),['🔗 Connect Moodle','⬅️ Main menu']);
 assert.ok(s.sent.at(-1)!.options!.reply_markup!.keyboard[0][0].web_app);
 const generated=s.calls.connect.length;await s.send(101,'⬅️ Main menu');assert.equal(s.calls.connect.length,generated);
});
