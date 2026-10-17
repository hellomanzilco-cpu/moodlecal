# Moodle Calendar

A Telegram study assistant for students at **moodle.uwed.uz**. Independent third-party application created by **Tursunov Sunnatilla**, not created by or on behalf of UWED. Contact: [@sunnatilla_tursunov](https://t.me/sunnatilla_tursunov). Each student connects their own Moodle account, receives notices about supported course changes and deadlines, and gets a private calendar subscription for Google Calendar, Apple Calendar, or Outlook.

This repository contains the implementation and [delivery plan](docs/PLAN.md). Read-only login and assignment inspection were tested with a real UWED student account on **16 October 2026**. The emoji menu and assignment views are implemented. The university-side event bridge has **not been installed or activated**, and live automatic change notifications have not been validated.

The pilot is hosted on Railway independently of the owner's computer. Open [@calmoodlebot](https://t.me/calmoodlebot) in a private Telegram chat. [Deployment and operating details](docs/HOSTING.md) include persistent storage, manual deployments, and the Free/Trial credit limits. The university event bridge is still required for website-triggered automatic updates; **🔄 Sync** works through an explicit student request.

**Moodle is never checked on a fixed interval.** Automatic website changes require UWED IT to install the included [Moodle event bridge](docs/MOODLE_EVENTS.md) and connect it to a public HTTPS receiver. A regular student account cannot enable that server feature. Until then, the bot uses saved data and explicit student refreshes; it does not fall back to interval checks.

## Inspect your own account

Fill `MOODLE_USERNAME` and `MOODLE_PASSWORD` in your local `.env`, or use `MOODLE_TOKEN`. These credentials are used only by the local inspection script; other students always connect their own accounts.

```text
npm run account:check
```

The script logs in, reads assignment statuses, and writes private reports to `data/account-report.md` and `data/account-report.json`. It separates outstanding work (including drafts), submitted work awaiting grading, and submitted graded work. Outstanding assignments are further distinguished by current availability: open, upcoming, restricted, closed, or unknown. A zero grade counts as graded. Personal done marks do not change Moodle submission states. No assignments, submissions, or grades are modified.

The `.env` and reports are ignored by Git. Keep operator credentials in that file; never commit or post them.

Existing keys named `Bot_token`, `Moodle_username`, and `Moodle_password` are supported. If you already have a credentials file, `npm run setup -- --complete` adds missing application settings while preserving the values you supplied. `npm run bot:info` checks the bot identity without sending any messages.

For your own pilot account, run `npm run account:link`. Open the private link in `data/private-telegram-setup.md` and press Telegram's Start button. The link binds the verified local account to that private chat, expires after 15 minutes, and works once. The pending Moodle token is encrypted in the database; no password is stored there. Other students continue to use their own private connection flow.

## What it does

- Keeps each Telegram user's Moodle connection, courses, preferences, tasks, and timetable separate.
- Establishes a silent initial baseline when a student connects; later signed Moodle events queue a refresh for affected students using each student's own token.
- Compares accessible course activities, file metadata, assignments, quizzes, and calendar events after a received event or explicit refresh.
- Provides today/week views, deadline priorities, preparation lists with Moodle links, and personal done/undo controls.
- Uses persistent emoji buttons for navigation and groups assignments into outstanding, submitted awaiting grades, and submitted graded work.
- Focuses on the next open deadline per course, plus unfinished overdue work that remains accessible. Later and undated assignments have a separate view; submitting early does not advance to the following deadline.
- Provides **🔄 Sync** to fetch and explain website changes, and **📰 Recent updates** to review each student's saved change history.
- Names added, removed and revised documents, shows old/new deadlines, grades, instructions and course changes, and identifies failed checks or coverage limits in each sync report.
- Opens assignments inside Telegram to read fresh requirements, download task files or send them to the student's chat, and review supported file/online-text submissions before sending them to Moodle.
- Confirms submission status and saved file checksums before showing success. Analytics use aggregate counts without names, usernames, passwords or session cookies.
- Evaluates 24-hour / 1-hour reminders from cached active deadlines locally, without requesting Moodle on a timer. Stale or failed data can suppress reminders.
- Publishes a revocable private ICS calendar containing deadlines and classes.
- Lets students add a recurring timetable when Moodle does not supply scheduled class times.

Coverage depends on the bridge's supported Moodle events, the student's API permissions, and exposed metadata. File replacement is detected when exposed metadata changes; inaccessible or removed items can produce a no-longer-available notice after refresh. The service does not inspect presentation contents or promise notification of every possible LMS change. Term controls appear when represented as a supported assignment, quiz, or event. Preparation lists use available descriptions and links.

Moodle cron and its task workers deliver queued events, so automatic notices have queue/network latency. A clock-only transition to a future opening time does not necessarily emit an event: it may require the next relevant event or **🔄 Sync**. The current bridge does not schedule release-time checks. [Event coverage and timing](docs/MOODLE_EVENTS.md).

## Run locally

Install **Node.js 24.14 or later within the 24.x line**. Commands below work from the project directory in PowerShell and other shells:

```text
npm install
npm run setup
```

Edit the generated `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=your-token-from-BotFather
PUBLIC_URL=http://localhost:3000
```

Create the bot through [Telegram's BotFather](https://t.me/BotFather). Keep `ENCRYPTION_KEY`, `WEBHOOK_SECRET`, and `MOODLE_EVENT_SECRET` private. Setup generates random keys for a new or empty `.env` and preserves nonempty configuration. Use `npm run setup -- --complete` to append missing settings without replacing existing values.

```text
npm run diagnose
npm run check
npm test
npm start
```

Open a **private chat** with your bot, press Start, and tap **🔗 Connect Moodle**. New students see only this button. It opens the existing sign-in form as a Telegram Web App inside Telegram; students enter their Moodle username and password there, with explicit consent. The password is sent to the bot server for sign-in only and is not stored. The server exchanges the credentials with Moodle and stores the resulting token encrypted.

The Web App shows live progress for Moodle availability, sign-in, profile loading, course and assignment synchronization, and dashboard preparation. It reports a partial result separately from failure and returns the student to the live dashboard after a successful or limited-coverage connection. Passwords are never sent in chat or to the operator. Failed or limited-coverage attempts retain an encrypted Telegram display name and safe stage/error details for up to 90 days. If `OWNER_TELEGRAM_ID` is configured, operational failures and limited coverage also generate a sanitized private alert. HTTP access logs contain only method, route template, status and duration.

`localhost` links work only on the computer running the app. To connect from a phone, receive Moodle events, or let a calendar provider fetch feeds, use a public HTTPS address and set `PUBLIC_URL` accordingly. This is required even with Telegram long polling, which only retrieves incoming Telegram messages and never checks Moodle. Plain HTTP is accepted only for local development.

Reconnecting establishes a fresh baseline and clears the previous connection's timetable, completion marks, course preferences, and calendar URL. Tap **🗓 Calendar** again and replace your subscription after reconnecting.

If UWED requires browser SSO, MFA, CAPTCHA, or denies mobile token creation, the username/password method may fail. The bot cannot complete additional SSO, MFA, CAPTCHA or password-change steps and will not bypass them or send students to a browser login. It reports that extra verification is required and directs the student to university support.

## Student menu

Press Start to open the persistent keyboard. Connected students see six buttons: Today, Assignments, My courses, Sync, More, and Settings. More contains This week, Priorities, Prepare, Calendar, Recent updates, and My timetable. Settings contains alerts, connection, status, help, and time zone. New students see only Connect Moodle. Return with **⬅️ Main menu**. Task lists show six items per page with Previous / Next buttons. The full introduction appears before Start; the chat opens with a short welcome.

| Button | Action |
| --- | --- |
| 🏠 Today | Today's unfinished deadlines and your manual class timetable. |
| 📅 This week | Classes and dated work over the next seven days. |
| 🎯 Priorities | Next assignment deadline per course, accessible unfinished overdue work, and eligible quizzes/events. |
| 📚 My courses | Your enrolled courses, with course buttons for preparation. |
| 📝 Assignments | Counts and category buttons for your assignment submission states. |
| 📖 Prepare | Choose a course for a checklist from its descriptions and material links. |
| 🔄 Sync | Pull current Moodle data and show what changed since the last successful check. |
| 📰 Recent updates | Read your saved website change history. |
| 🗓 Calendar | Your private calendar subscription URL. |
| ⚙️ Settings | Alerts, time zone, connection status, reconnect, help, and disconnect. |
| 🔗 Connect Moodle | Opens the private Moodle sign-in form inside Telegram. |

Under **📝 Assignments**, choose **⏳ Next deadlines**, **🕓 Later / undated**, **📨 Awaiting grades**, or **✅ Graded**. The nearest future deadline in each course determines its current assignment group; tied deadlines stay together, and early submission does not advance the next group before that deadline passes. Accessible unfinished overdue work remains visible. This is a planning rule, not proof that a teacher released an assignment. Drafts remain outstanding; a zero grade counts as graded. Missing access information is reported without guessing. Personal done marks do not submit work or modify grades.

Moodle's effective access/permission result, opening time, cutoff, and conditional restrictions determine technical availability. An assignment without a deadline appears in **🕓 Later / undated**, outside current priorities, reminders, and the calendar. The bot invents no deadline.

Under **⚙️ Settings**, use **🔔 Pause alerts** or **🔔 Resume alerts**, **🌍 Time zone**, **🔗 Reconnect Moodle**, and **ℹ️ Status**. Time zone prompts you to type an IANA zone such as `Asia/Tashkent`. **🔒 Disconnect** opens a confirmation; **🗑 Yes, disconnect** deletes your saved connection and personal data, while **⬅️ Main menu** cancels.

Slash commands remain available for compatibility and advanced controls:

| Command | Action |
| --- | --- |
| `/start`, `/help` | Show help and connection instructions. |
| `/connect` | Show a fresh Connect Moodle Web App button. |
| `/courses` | List your enrolled courses and their IDs. |
| `/mute COURSE_ID`, `/unmute COURSE_ID` | Manage a course's inclusion in your assistant. |
| `/today`, `/week` | Show upcoming classes and dated work. |
| `/priorities` | Show outstanding tasks ranked by deadline. |
| `/assignments` | Show assignment submission counts and category buttons. |
| `/outstanding`, `/awaiting`, `/graded` | Show one assignment submission category. |
| `/prepare [COURSE_ID]` | Show course materials and tasks to prepare; omit the ID for all courses. |
| `/done ITEM_KEY`, `/undo ITEM_KEY` | Set or clear a personal completion mark. |
| `/calendar` | Get your private calendar URL. |
| `/calendar rotate` | Revoke the old URL and generate a replacement. |
| `/class …`, `/classes`, `/unclass CLASS_ID` | Add, inspect, or remove recurring classes. |
| `/timezone Asia/Tashkent` | Set your IANA timezone. |
| `/sync`, `/status` | Request a sync or inspect its last result. |
| `/pause`, `/resume` | Pause or resume event processing and alerts; resuming explicitly refreshes your account. |
| `/disconnect` | Immediately delete your local connection and student data and revoke your feed. |

Use the exact course ID or item key shown by the bot. A personal done mark affects the assistant; it does not submit coursework. Actual submissions use the explicit assignment window or the university website.

## Assignment files and submission

Choose **📝 Assignments → a category → 📄 an assignment**. The private window reads the current task definition, attachments, deadline, effective access, submission status and visible grade directly from Moodle. File buttons download an attachment or send its bytes to your own Telegram chat; Moodle tokens and private file URLs never reach the browser or Telegram.

Select your work, read any teacher statement, review filenames and requirements, then explicitly confirm **Submit for grading**. The server rechecks requirements before saving and uses Moodle's own draft/save/final-submit APIs. Success requires reading back the official submitted status and downloading the saved files to verify their SHA-256 hashes against the selected files. The bot sends a receipt and asks you to check Moodle yourself and keep a backup.

The bot accepts up to **10 files / 20 MiB total**, subject to stricter teacher file count, per-file size, formats, word limit, opening/cutoff and editing permissions. Replacing existing work needs an explicit replacement confirmation. Group/timed assignments, unsupported plugins or file-type groups, and larger files must use Moodle. A draft is never presented as submitted. An uncertain write is not retried; verify its status first. [Detailed behavior and recovery](docs/ASSIGNMENTS.md).

The public `/privacy` page explains account data and aggregate analytics. Set `OWNER_TELEGRAM_ID` to your verified numeric Telegram user ID in `.env` and cloud variables. Only that account sees **More → 📊 Bot statistics**, with Today, 7-day and Refresh buttons. The configured account also receives sanitized alerts for actionable Moodle connection failures and limited coverage. Other accounts cannot open the statistics by typing the button text or `/stats`; authorization never uses a username. The page shows current registered/connected/paused account counts and aggregate activity since tracking was enabled, using Asia/Tashkent dates. Disconnect removes an account from current totals; these are not lifetime signups. No student names, usernames, credentials or individual activity histories appear in aggregate statistics.

Operators can also run `npm run stats` locally or `node /app/scripts/stats.mjs` through authenticated Railway SSH. There is no public statistics or student roster endpoint.

The owner can open **More → Bot statistics → 👥 Users** for a separate list of students who explicitly agreed to profile sharing. Each student chooses **Settings → 🔐 Profile sharing → Yes** after reading the disclosure. Sharing is off for existing and new accounts by default and is not required to use the bot. Only the first name, last name and Moodle username are saved, encrypted and bound to the current connection and configured owner. Six records appear per page. Opening or refreshing the list never fetches unconsented Moodle profiles. Details reflect the last consent confirmation, and students can explicitly update them or stop sharing. Revocation, reconnect and disconnect remove the shared record from the live database; previously delivered Telegram messages and encrypted operator backups need separate handling. Passwords and cookies are not shared. Aggregate analytics remain anonymous.

Example timetable entry, using a course ID from **📚 My courses**:

```text
/class 42 | Mon | 09:00 | 90 | Seminar | Room 201 | 2027-01-30
```

Fields are course ID, weekday, local start time, duration in minutes, class title, location, and final date. `/classes` supplies the ID needed by `/unclass`. The feed publishes a rolling 90-day window of manual class occurrences.

## Connect an external calendar

Tap **🗓 Calendar** and copy its HTTPS URL. Subscribe to the URL so future changes can appear:

- **Google Calendar:** On a computer, open Calendar → the `+` beside **Other calendars** → **From URL** → paste the feed → **Add calendar**. [Google instructions](https://support.google.com/calendar/answer/37100?hl=en).
- **Apple Calendar on Mac:** **File → New Calendar Subscription**, paste the feed, then choose an account and refresh interval. [Apple instructions](https://support.apple.com/en-am/guide/calendar/icl1022/mac).
- **Outlook on the web:** **Calendar → Add calendar → Subscribe from web**, paste the feed and save. [Microsoft instructions](https://support.microsoft.com/en-us/outlook/import-or-subscribe-to-a-calendar-in-outlook-com-or-outlook-on-the-web).

The feed is a one-way subscription of saved eligible deadlines and classes; downloading it does not request Moodle. Editing an external event does not change Moodle or the bot. Providers choose their refresh frequency, and updates can take many hours; Microsoft says Outlook refresh can exceed 24 hours. After the university bridge is activated, Telegram notices can arrive before a calendar provider refreshes.

The private URL acts as a password to your calendar. Anyone who has it can read the feed, and your calendar provider must be able to fetch it without an interactive login. Keep it private. If it leaks, use `/calendar rotate` and replace the subscription. Rotating a URL or disconnecting prevents future downloads with that URL; a provider may retain previously cached events until you remove the subscription.

## Configuration

See [.env.example](.env.example) for all settings.

| Variable | Default / purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather token; required for Telegram operation. |
| `TELEGRAM_MODE` | `polling`; optional `webhook` mode requires HTTPS and webhook registration. |
| `PUBLIC_URL` | `http://localhost:3000`; public HTTPS base URL in production. |
| `HOST`, `PORT` | `127.0.0.1`, `3000`; Compose sets the container host to `0.0.0.0`. |
| `MOODLE_URL` | `https://moodle.uwed.uz`; one Moodle site for this deployment. |
| `DEFAULT_TIMEZONE` | `Asia/Tashkent`. |
| `POLL_SECONDS` | Legacy setting, `300`, minimum `60`; retained for retry/freshness calculations. It does **not** schedule Moodle requests. |
| `DATABASE_PATH` | `./data/moodle-calendar.sqlite`. |
| `ENCRYPTION_KEY` | 32 random bytes encoded as base64; generated by setup. |
| `WEBHOOK_SECRET` | Random secret for authenticating incoming Telegram webhook requests. |
| `MOODLE_EVENT_SECRET` | Random shared secret for signed `/moodle/events` requests; the university bridge must use the same value. |

Students are tenants within one Moodle deployment. The current app does not provide a separate institution-level administrator interface or arbitrary Moodle hosts per user.

## Host with Docker

For hosting independent of your computer, follow the [Railway deployment guide](docs/HOSTING.md). The prepared [Railway configuration](railway.json) uses one service and persistent storage. Free usage credits do not guarantee uninterrupted 24/7 hosting.

After setup, set the real `TELEGRAM_BOT_TOKEN` and public HTTPS `PUBLIC_URL` in `.env`, then run:

```text
docker compose up --build -d
docker compose logs -f
```

Compose binds port 3000 to the host's loopback interface. Configure your HTTPS reverse proxy to forward to `http://127.0.0.1:3000`. The container runs as an unprivileged user and stores SQLite in a named volume. Keep **one running app instance / one replica**, including in polling mode. Do not scale this SQLite implementation horizontally.

The default polling transport does not require a Telegram webhook. If the bot already has a webhook registered, explicitly remove or reconfigure it before switching transports; the app does not silently change an existing registration. Webhook requests must carry the configured Telegram secret header. With `TELEGRAM_MODE=webhook`, the helper `node --env-file=.env scripts/configure-telegram.mjs` explicitly registers the configured HTTPS webhook. See [operations notes](docs/OPERATIONS.md) for hosting, backups, and transport changes.

`GET /healthz` reports process liveness. `GET /readyz` checks local readiness, returns 503 when the Telegram token is missing, and reports event mode, receiver configuration, and the last accepted event. A configured secret or a successful readiness response does not prove that UWED installed the bridge. Without a bot token the app supports local endpoint development only.

The app runs native TypeScript using Node 24 and uses built-in `node:sqlite`. That SQLite API is experimental on early Node 24 releases and a release candidate from 24.15 onward; it is not yet a stable API. [Node's SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

## Privacy and operational limits

Moodle tokens and recoverable calendar secrets use AES-256-GCM encryption at rest. Link and calendar lookup tokens are hashed. Course/task metadata remains in SQLite, and notifications are sent through Telegram. Database access and the encryption key together allow the operator to access stored Moodle tokens: host the service with an operator you trust. Protect the database, backups, `.env`, and reverse-proxy logs.

Notification delivery uses a persistent outbox with retries. A process crash after Telegram accepts a message but before the database records success can produce a duplicate. Repeated delivery of a Telegram command reuses its cached response and menu so a transient reply failure does not create a timetable entry twice. If Telegram permanently refuses delivery, the affected student is paused; after fixing access, open **⚙️ Settings → 🔔 Resume alerts**.

Moodle outages, token expiry, disabled API functions, and an offline bot can delay event jobs and reminders. **⚙️ Settings → ℹ️ Status** states that interval checks are off and whether a signed website event has arrived. **🔄 Sync**, reconnecting, and resuming are explicit actions that can request Moodle. Ordinary menu views read cached data. Keep checking Moodle for authoritative requirements during the pilot.

The [plan](docs/PLAN.md) covers the remaining steps: UWED approval and event-bridge installation, staging validation of automatic notices and calendar subscriptions, monitoring/backups, and a queue/database migration if multiple workers become necessary.
