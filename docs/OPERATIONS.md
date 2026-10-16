# Operating Moodle Calendar

## Current deployment boundary

Moodle interval checks are disabled. Automatic website updates require UWED IT to install and activate the included Moodle bridge; the prepared bridge has not been installed at `moodle.uwed.uz`. With student access only, use cached menus and explicit **🔄 Sync**, Connect, Resume, or assignment-window actions. Do not introduce a scheduled Moodle-fetch fallback.

Run one app instance against persistent SQLite storage. The default Compose service binds port 3000 to host loopback; place a valid HTTPS reverse proxy in front and set `PUBLIC_URL` to the external address. A public receiver is required for university events even when Telegram uses long polling.

Allow outbound HTTPS to UWED and Telegram. Allow the university to reach `/moodle/events`, Telegram to reach its webhook when selected, and calendar providers to fetch private ICS URLs. Keep clocks synchronized for event-signature skew checks, connection expiry, and local deadline reminders.

## Activate the Moodle event bridge

Give the university administrator [MOODLE_EVENTS.md](MOODLE_EVENTS.md) and `moodle-plugin/local_moodlecalendar/`. That guide owns the exact installation, event allowlist, envelope, and Moodle staging procedure. An application signing secret alone does not enable a subscription to Moodle's internal events.

Configure a strong random `MOODLE_EVENT_SECRET` in the app and the same value in the university plugin. Setup creates the secret for a fresh configuration; `npm run setup -- --complete` appends it when missing without replacing existing settings. Deploy the receiver before enabling the Moodle plugin.

The endpoint is `POST /moodle/events` with UTF-8 JSON, using these headers:

```text
Content-Type: application/json
X-Moodle-Calendar-Timestamp: <Unix seconds at delivery attempt>
X-Moodle-Calendar-Signature: <64-character hexadecimal HMAC-SHA256>
```

The signature covers `timestamp + "." + rawBody` using `MOODLE_EVENT_SECRET`. Preserve the exact request bytes through the proxy. The app allows a 300-second timestamp skew, rejects invalid signatures/payloads, and deduplicates accepted event IDs. It returns HTTP 202 after durable acceptance; that means jobs were queued, rather than all Telegram messages delivered. A missing event secret returns 503. Moodle retries failed deliveries with the same event ID and a fresh signed delivery timestamp.

Received events create durable per-student jobs, scoped to affected course tenants, with coalescing and retry. Each job reads Moodle using that student's token. The event envelope contains a course/event hint, not student content to forward directly. No automatic Moodle request is made without an accepted event job; explicit student Connect, Sync, and Resume can also request Moodle.

Moodle cron/adhoc workers must be running. Queue and network latency affect notices. A future opening date passing does not necessarily create a Moodle event; the initial plugin has no release-time scheduler. A relevant event or manual refresh is needed for that transition. See the bridge guide before promising complete or instantaneous change coverage.

## Configuration, secrets, and upgrades

`npm run setup` initializes a missing or zero-byte `.env` and preserves a nonempty file. `npm run setup -- --complete` appends missing settings and preserves existing credentials and keys. Compare `.env.example` after upgrades.

Preserve `ENCRYPTION_KEY` when restarting, moving hosts, or restoring SQLite. Replacing it makes saved encrypted Moodle and calendar tokens unreadable; this release has no online key-migration procedure. `MOODLE_EVENT_SECRET` is a separate shared signing secret: coordinating its replacement requires updating the receiver and university bridge together. `WEBHOOK_SECRET` authenticates Telegram and is independent of both.

The legacy `POLL_SECONDS` value remains for retry/freshness calculations. It does **not** start Moodle interval checks. Local workers can retry already accepted event jobs and process cached reminders/outbox delivery; those are separate from searching Moodle for new changes.

Each Telegram student can start at most **five full Moodle syncs per Tashkent calendar day**. Connect/reconnect snapshots count toward that limit; a failed attempt counts because it still uses upstream capacity. A sixth attempt is refused before contacting Moodle. Profile, assignment-detail, and task-file views remain separate from this full-sync allowance and have their own bounded request and transfer limits. The bot shows remaining syncs in Status.

If Moodle's `mod_assign_get_submission_status` request times out or is denied, the app keeps course and assignment data, marks submission status unknown, and warns that grades, individual extensions, quizzes, and calendar events could not be refreshed. Existing students retain their last-known completion, grade, and deadline values plus cached quiz/calendar items; reminders pause until a later successful check. Students should verify their status and deadlines in Moodle during this condition.

Restrict `.env`, reports, database files, and backups to the operator. Disable request-body logging and redact calendar bearer-secret paths in proxy logs. Do not put passwords, bot tokens, or signing secrets in URLs, shell history, or tickets.

Install locked dependencies with `npm ci`; run `npm run check` and `npm test` before deploying a change. Build with `docker compose up --build -d`. Keep a backup and previous release before schema changes. Run plugin PHPUnit tests in a compatible Moodle/PHP test environment, then stage the integration; application tests do not prove Moodle plugin compatibility.

## Telegram transport

`TELEGRAM_MODE=polling` is Telegram long polling for incoming messages. It never requests Moodle. Keep one bot process and preserve existing webhook registrations. If Telegram reports a conflict, stop duplicate instances and deliberately remove an old webhook before starting long polling.

For Telegram webhooks, set `TELEGRAM_MODE=webhook`, preserve a random `WEBHOOK_SECRET` of at least 32 characters, start the public HTTPS app, then run:

```text
node --env-file=.env scripts/configure-telegram.mjs
```

The helper registers `/telegram/webhook` using Telegram's `secret_token`. It only registers webhooks. Incoming requests require `X-Telegram-Bot-Api-Secret-Token`. To switch back, stop the app, deliberately remove the webhook through Telegram's `deleteWebhook` API while preserving pending updates, select polling, and restart one instance. [Telegram webhook API](https://core.telegram.org/bots/api#setwebhook), [remove a webhook](https://core.telegram.org/bots/api#deletewebhook).

## Backups and recovery

The app creates daily SQLite snapshots encrypted with AES-256-GCM and retains the latest 14 encrypted backups. They are stored under `DATABASE_PATH`'s `backups` directory (on Railway, `/data/backups`). These protect against an application-level database issue but share the same volume. Download an encrypted copy separately for volume-loss recovery. Protect the exact `ENCRYPTION_KEY` separately; it is required to restore.

Before this release, older deployments may have plaintext backups in that directory. After deploying this release, first confirm a new `.sqlite.enc` backup exists, then run `node scripts/secure-legacy-backups.mjs` in the app container. The migration verifies the encrypted copy before removing each plaintext source. If a SQLite journal/WAL companion prevents a safe migration, it preserves that source for manual handling. Do not delete those files by hand until a consistent encrypted replacement is verified.

For a restore, stop the app and run `node scripts/restore-backup.mjs <encrypted-backup> <new-database-path>` with the matching key. The destination must not already exist. Verify the restored database before pointing `DATABASE_PATH` at it. For a raw copy of a live database, stop the app gracefully and include the SQLite `-wal`/`-shm` files. A container image does not include its named data volume.

To restore, stop the app, restore the complete directory with ownership writable by the runtime user, restore the matching keys, and start one instance. Durable event jobs and pending messages should remain available. Check connection status and a private feed, then use an explicit refresh or staging signed event to verify the integration. Never overwrite the only working database during a recovery test.

Disconnect deletes active local student data and revokes future calendar fetches. Backups can retain historical records until expiry, and external calendar providers can retain cached events. Local deletion does not revoke the token upstream at Moodle. Document retention to pilot students.

## Delivery and monitoring

The notification outbox retries transient failures and survives restarts. Delivery is at least once: a crash after Telegram accepts a message but before local acknowledgement can produce a duplicate. Cached command replies prevent completed timetable commands from rerunning after a transient reply failure. Telegram refusal can pause the affected student; after restoring access, use **Settings → Resume alerts**. Telegram rate limits postpone retries according to the supplied delay.

Deadline reminders use saved active deadlines only. They do not query Moodle on a timer. Future, restricted, closed, or unknown-availability assignments are excluded; open assignments without deadlines have no fabricated date or reminder. Unsuitable or stale cached data can suppress reminders. A student's manual refresh can update cached state before the university connection is available.

| Symptom | First checks |
| --- | --- |
| No automatic website notices | Confirm UWED actually installed/enabled the bridge, then inspect Moodle task failures and the last accepted signed event. Student login alone cannot enable events. |
| Event rejected | Check matching signing secret, clock skew, exact raw body, header spelling, envelope, and HTTPS destination. |
| Accepted event but no notice | Check durable job failures, course targeting, student pause/access state, and whether student-visible metadata actually changed. |
| Newly opened future work is missing | Check whether an event occurred; a clock-only opening may need explicit Sync now. Do not classify it open from a guessed date. |
| Assignment looks inactive | Compare effective access, submission-edit permissions, opening/cutoff, and conditional restrictions in Moodle. Outstanding does not necessarily mean open. |
| Bot does not respond | Check one process, Telegram token/access, transport conflicts, and app logs. |
| Moodle refresh fails | Check Status, token validity, permitted functions, and site availability. The anonymous diagnose command checks advertised services only. |
| Calendar is stale | Check the saved snapshot and subscription URL, then provider caching. Fetching the feed does not refresh Moodle. |
| Connections fail after moving hosts | Verify the database uses its original encryption key. |

`GET /healthz` is process liveness and backs Docker's check. `GET /readyz` reports worker/Telegram readiness, a missing Telegram token as 503, event mode, receiver configuration, and last accepted event. A configured receiver is not proof that UWED installed the plugin or that every student refresh succeeds. Railway's configured single replica and crash-restart limit improve recovery but do not guarantee uninterrupted availability; monitor service status and trial credits.

Monitor received-event errors, failed/retrying jobs, queue age, Telegram delivery age, disk space, uptime, and backup age. Track last-event time separately from each student's last refresh: lack of an event can simply mean no relevant Moodle change occurred. No external alerting service is configured by this repository.
