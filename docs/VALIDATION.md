# Pilot validation — 16 October 2026

## Refresh and outage behavior

The displayed update time is the last **successful** Moodle snapshot, not the time a menu is opened. A failed request preserves the previous snapshot and timestamp, records a separate attempt time, and reports the failure. It must never claim a successful refresh during an outage.

During this investigation, both the Railway container and the local computer resolved Moodle to `194.93.25.170`, but HTTPS requests timed out. Telegram remained reachable from both environments. The owner independently confirmed that Moodle did not open in their browser. These observations indicate a UWED availability problem; they do not identify its server-side cause. No IP bypass, alternative credential destination, or periodic Moodle scan was introduced.

## Updated behavior

- One visible **🔄 Sync** action replaces separate Auto update / Sync now paths. Legacy buttons and `/sync` use the same handler and cooldown.
- Explicit sync requests are durable SQLite jobs. The menu acknowledges immediately; the worker delivers one result through the outbox. Repeated taps coalesce. Failed manual jobs do not turn into interval polling.
- Manual sync results still arrive when background alerts are paused. Ordinary alerts respect pause settings.
- The connected main menu has six buttons. Secondary tools are under More and Settings; unconnected students see Connect and Help.
- Task lists paginate six items at a time. Starting or changing menus resets pagination. Student pages cannot access another student's data.
- Telegram's long introduction is configured as the description visible before Start. The post-Start response is short.
- Connection requires explicit consent, reports connectivity failures as HTTP 503, and offers a Return to Telegram link after success. A Moodle-hosted authorization callback remains dependent on university support; a plain login redirect is not an authorization mechanism.

## Verification

Run `npm run check` and `npm test` for API consent/origin validation, tenant isolation, token encryption, assignment statuses and access, calendar revocation and escaping, time zones, timetable commands, queue recovery, sync deduplication, pagination, alert pause behavior, event signatures and event job retries, backup integrity, and fresh startup.

Cloud verification uses the deployed code with an in-memory synthetic account and a fake messenger; it does not send test messages to students or alter their Moodle data. Real Moodle refresh/login was retried after the university site recovered, as recorded below.

### Completed checks

All **92 automated tests** and TypeScript checks passed. The deployed container passed a synthetic smoke check covering 14 menu actions, the six-button main menu, queued sync success, and outage handling. Health, readiness, and the connection page returned HTTP 200.

Moodle recovered during verification. A real API authentication succeeded from Railway, and both connected accounts refreshed successfully. The older account's last successful update advanced from **16 October 2026, 00:32** to **11:45 Asia/Tashkent**, with seven courses and 213 items retained. The second account also refreshed successfully. University uptime remains external to the bot; future failed requests preserve the last successful snapshot.
