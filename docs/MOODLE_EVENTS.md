# Event-triggered Moodle updates

The bot can receive changes from Moodle without repeatedly asking Moodle on a fixed interval. This requires **UWED IT to install and configure the included Moodle plugin**. A regular student login cannot subscribe to Moodle's internal event stream or install a plugin. The prepared bridge is an alpha integration for administrator review, not an already active service at moodle.uwed.uz.

Flow: Moodle commits a relevant change → the local plugin queues an adhoc delivery task → Moodle cron sends a signed HTTPS event → the bot refreshes the affected connected students using their own access → actual student-visible differences create Telegram notifications and update their private calendar feed. Students do not need to send a Telegram command for these notifications. The signed event is a refresh hint; its contents are not sent directly to students.

## Administrator deployment

1. Review `moodle-plugin/local_moodlecalendar/`, the outbound destination, data handling, and this contract. The plugin targets Moodle 4.5+ (`2024100700`) with `mod_assign`; compatibility still needs validation on UWED's exact Moodle version and installed availability plugins.
2. Deploy the bot receiver with a stable **public HTTPS** endpoint and persistent application storage. Configure the application's event-triggered sync mode and a strong random `MOODLE_EVENT_SECRET` in `.env`. Use the exact secret in the plugin. Do not put Moodle passwords, a token or the signing secret in the endpoint URL.
3. Copy `moodle-plugin/local_moodlecalendar/` to `<moodle-root>/local/moodlecalendar/`, then visit **Site administration → Notifications** to complete installation. A plugin ZIP must contain one top-level `moodlecalendar/` directory; do not zip the project, `.env`, node_modules or student data.
4. Open **Site administration → Plugins → Local plugins → Moodle Calendar event bridge**. Set the trusted receiver HTTPS URL (application route `/moodle/events`) and signing secret of at least 32 characters. Enable the bridge after the receiver is reachable.
5. Run Moodle cron and its adhoc-task workers normally. Check failed tasks under Moodle's task administration. Delivery failures throw an exception for Moodle's retry policy; disabling the bridge stops queuing new events and causes existing delivery attempts to fail. Review stopped tasks before re-enabling. Moodle 4.5 defaults to 12 attempts, after which a task stops and requires administrator retry; Moodle may purge stopped tasks after its configured retention period (default four weeks). Monitor receiver outages and retry stopped events before retention expires.
6. Validate the smoke tests below in staging, then enable production. No administrator installation or production Moodle configuration has been performed by this project.

Suggested packaging from the repository root on a machine with Python:

```sh
python -c "from pathlib import Path; from zipfile import ZipFile, ZIP_DEFLATED; p = Path('moodle-plugin/local_moodlecalendar'); z = ZipFile('local_moodlecalendar.zip', 'w', ZIP_DEFLATED); [z.write(f, Path('moodlecalendar') / f.relative_to(p)) for f in p.rglob('*') if f.is_file()]; z.close()"
```

That command produces `local_moodlecalendar.zip` with the correct `moodlecalendar/` top-level folder for Moodle's ZIP installer. A direct server copy as described above also works.

## Delivery contract

The bridge posts UTF-8 JSON to the configured endpoint:

```json
{"eventId":"a9d6a0d4be0849ae8b9df84b5af59b8e","eventName":"\\core\\event\\course_module_updated","courseId":42,"occurredAt":1792108800}
```

| Field | Meaning |
| --- | --- |
| `eventId` | Random 16-byte lowercase hexadecimal ID; unchanged on delivery retries |
| `eventName` | Moodle's fully qualified event class name |
| `courseId` | Integer Moodle course ID; `0` for relevant events without course scope |
| `occurredAt` | Original Moodle event time in Unix seconds |

Headers:

```text
Content-Type: application/json
X-Moodle-Calendar-Timestamp: <current Unix seconds at delivery attempt>
X-Moodle-Calendar-Signature: <lowercase hex HMAC-SHA256>
```

The signature is `HMAC_SHA256(secret, timestamp + "." + rawRequestBody)`. Verify against the **exact raw body**, compare with constant-time equality, allow only a short timestamp skew, reject malformed payloads and deduplicate by `eventId`. Each retry uses a fresh signed delivery timestamp with the same event ID and original occurrence time. Preserve the raw request body through the reverse proxy; do not parse/re-encode it before signature verification. The receiver should return a 2xx response only after it durably accepts the event for processing, or after finding that ID already accepted. Non-2xx status, redirects, and transport failure throw for Moodle's retry policy. TLS certificate verification stays enabled, redirects are disabled, and Moodle's native HTTP security/proxy configuration applies.

No student Moodle username, user ID, related-user ID, password, token, IP address, filename, file contents, title, grade or submission text is included. The bot verifies each connected student's current access when refreshing a course. A course ID/event time/type can still disclose activity metadata, so the plugin declares external processing through Moodle's Privacy API. Administrators should review the bot's separate student data handling and destination access controls before enabling it.

## Events covered

The wildcard observer first rejects all reads (`crud = r`) and then applies the allowlist in `classes/observer.php`. Relevant writes include:

- Core course, course module and course section creation/update/deletion: new activities/resources, editing a deadline, changes to visibility or restriction settings, and deletion.
- Core calendar event creation/update/deletion.
- Core activity-completion changes, course-completion requirements/completion, user grading and grade deletion.
- User enrolment changes, group/grouping changes and membership changes, and role assignments/removals. These can change a student's availability and access.
- Assignment C/U/D events from `mod_assign`, `assignsubmission_*`, and `assignfeedback_*`, including submitted/draft status transitions, grading, extensions and submission file/online-text changes.
- `mod_folder\event\folder_updated`, which covers edits to a folder's files without changing the surrounding course-module settings.

Other module-specific writes, third-party availability condition implementations, and server-side database changes that do not emit these Moodle events are outside this version's coverage. Reading courses or assignments and HTTP diagnostics do not create outbound delivery, which prevents refresh loops. Multiple Moodle events from one teacher action can result in several envelopes; the bot compares refreshed state before notifying a student.

## Timing and assignment availability

An event queues delivery when the Moodle change commits. Actual latency depends on **Moodle cron/adhoc worker availability**, the receiver and Telegram. This is event-triggered delivery with queue latency, not a promise of instantaneous delivery. No repeating Moodle-fetch job is required by this bridge.

Setting a future opening date is a Moodle update and is covered. **The clock reaching that date does not necessarily emit a Moodle event.** Moodle evaluates many date-based availability restrictions on access. This initial plugin does not schedule extra release-time events. A new task that unlocks solely because time passes may therefore be discovered on the next relevant event or a student's manual refresh. Reliable release-time notifications require a one-off reevaluation scheduled from a known opening time, or a Moodle-side release scheduler; fixed-interval Moodle requests are not needed, but this boundary must be implemented and tested separately. Completion/submission-based unlocking is refreshed after the corresponding completion/submission event. The bot must preserve Moodle's own availability result and must not assume every unsubmitted assignment is currently active.

A private external-calendar subscription has another independent delay: Google Calendar, Apple Calendar or Outlook chooses when it refreshes the subscription. Telegram can notify after event processing, while that calendar provider may display the same change later.

## Staging smoke tests

1. Connect two test students from different courses, then create or edit an assignment deadline in one course. Confirm that only eligible students in that course are refreshed/notified and that inactive assignments are not advertised as active.
2. Upload a resource, change a resource document, and edit a folder's files. Confirm student-visible changes cause notifications without a Telegram command. View the same resources repeatedly and confirm reads do not queue deliveries.
3. Submit an assignment that unlocks the next one, then grade it. Verify the student's active/pending/graded views and any newly available activity. Test restrictions on completion, groups, hidden sections and future opening time separately.
4. Replay an accepted signed event ID: it must not duplicate notifications. Send a wrong signature or stale timestamp: it must be rejected. Temporarily return HTTP 503, then restore the endpoint: Moodle must retry the same event ID successfully.
5. Confirm Moodle cron/adhoc-task failures are visible, secrets are absent from logs, and the bot never notifies another student's grade/submission based on the event envelope alone.

The included PHPUnit test covers filtering, the minimal queued envelope and destination URL policy. A local PHP/Moodle runtime is needed to execute it; Node application tests do not validate a Moodle installation.

## Official references

- [Moodle event observers and common files](https://moodledev.io/docs/4.5/apis/commonfiles#dbeventsphp).
- [Moodle Task API: adhoc execution and automatic retry on exceptions](https://moodledev.io/docs/4.5/apis/subsystems/task).
- [Moodle 4.5 adhoc-task implementation](https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/lib/classes/task/adhoc_task.php).
- [Moodle 4.5 native curl implementation](https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/lib/filelib.php).
- [Moodle Privacy API FAQ: external data processing](https://moodledev.io/docs/4.5/apis/subsystems/privacy/faq).
