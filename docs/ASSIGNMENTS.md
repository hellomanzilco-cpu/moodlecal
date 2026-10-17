# Assignment submission and trustworthy refresh reports

## Student flow

Open Assignments, choose a category, and tap a 📄 assignment button. Each button creates a private 30-minute session scoped to this student, assignment, and encrypted Moodle connection. Reconnection invalidates previous windows. Opening a task or pressing Check Moodle explicitly requests fresh data; no periodic Moodle fetch is introduced.

The task window shows the professor's text and attachments, effective opening/cutoff/access rules, deadline extensions, current uploaded files, draft/submitted status, and visible grade. Attachments can be downloaded in the window or sent as document bytes to the connected student's Telegram chat. Private Moodle URLs and tokens remain server-side. Files outside the trusted Moodle origin or protected file endpoint cannot be proxied, and redirects are rejected.

Uploads support standard individual file and online-text submission plugins. The student chooses files, accepts the exact required teacher statement when supplied, reviews the selection, and explicitly confirms the grading action. Replacing existing files or text requires a separate replacement acknowledgement. Personal Done marks have no role in submission.

## Write and verification sequence

1. Authenticate the private assignment session and consume bounded multipart data. The selected files stay in server memory, not a local upload directory.
2. Insert a durable operation receipt with a random operation ID, current connection binding, filenames, byte counts and SHA-256 hashes. Repeated operation IDs return the same operation without repeating writes. An active or uncertain operation blocks another write to this assignment.
3. Read current Moodle requirements and evaluated permissions. Reject a changed revision, teacher restriction, missing statement, unsupported plugin, invalid filename/type/count/size or word limit before uploading.
4. Upload selected files to Moodle's draft area using `/webservice/upload.php`. Re-read requirements before saving the assignment record, so a change during upload cannot silently bypass review.
5. Call `mod_assign_save_submission` and reject warning arrays. Read the saved files and verify their contents. When Moodle requires a separate final-submit step and permits it, call `mod_assign_submit_for_grading` with the student's statement acceptance.
6. Read the official status and saved file contents again. Only a submitted status with matching selected contents earns a green submitted receipt. A draft remains outstanding; an unverifiable result remains uncertain. The receipt tells the student to check the files and “Submitted for grading” status directly in Moodle and keep a copy.

An accepted upload request returns HTTP 202 immediately; browser progress reads the local operation receipt. A lost response, crash or restart never triggers an automatic submission retry. On startup, unfinished operations become uncertain. A fresh private window can inspect the previous receipt and explicitly verify Moodle. A student may close an uncertain attempt only after acknowledging a direct Moodle check and a fresh server read confirming editable, unsubmitted work. Closing it does not resubmit anything.

Official endpoint and draft-area behavior: [Moodle file handling](https://moodledev.io/docs/5.0/apis/subsystems/external/files). Save/submit parameters and warning return values: [Moodle assignment external API source](https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/assign/externallib.php). Runtime API availability and evaluated permissions remain authoritative for each account.

## Supported limits

- At most 10 selected files and 20 MiB total per request, with any stricter teacher count or per-file maximum applied. Task-file downloads through the bot also have a 20 MiB limit. Use Moodle for larger transfers.
- Two submission jobs and two multipart parses can run concurrently in this single process. Requests have bounded files/parts/fields and session-scoped rate limits. A student can create at most 10 submission attempts per hour.
- File extensions and supported MIME selections, teacher word limits, opening/cutoff dates, effective edit permission and explicit replacement consent are validated. Moodle still enforces its own site/course permissions and quotas.
- Group submissions, timed assignments, additional submission plugins, unresolved file-type groups and some statement configurations remain read-only. This avoids bypassing member confirmations, starting a timed task accidentally, or dropping unsupported plugin data.
- Existing file sets must be selected again when replaced. The UI explicitly explains that unselected previous files will be removed. To edit an existing file set without re-uploading it, use Moodle.
- A local receipt is not a guarantee of university uptime, future grading, or changes made later in another Moodle session. Native mobile download behavior can vary; Send to Telegram provides a separate file-delivery option.

## Sync reports

Explicit Sync always calls the Moodle adapter. The report lists courses/assignments/materials inspected, every observed change, exact old/new times and grades, renamed courses, added/removed/revised filenames and changed instruction excerpts. Calendar start/end, opening/cutoff and edit/final-submit permissions are compared as well. Limited API coverage is printed even when no differences are found. A failed endpoint is named when known; failures preserve the last complete snapshot and timestamp. Losing assignment-detail API access cannot replace known assignments with generic activities.

File-change discovery uses metadata Moodle exposes. A replacement with identical exposed name, size and modification metadata can remain undetectable during ordinary Sync. Submission verification is stronger: it downloads the student's newly saved files and compares their SHA-256 hashes. Neither mechanism claims to see hidden teacher content or every possible internal LMS change. Automatic discovery still requires the university event bridge.

## Aggregate analytics and privacy

`usage_daily` stores only date, event type and count, using Asia/Tashkent calendar dates and a 90-day retention window. It has no student identifiers, names, Moodle usernames, cookies, passwords, filenames or event payloads. Separately, failed or blocked Moodle connection attempts retain an encrypted Telegram display name, step, safe failure category, Moodle operation/error code when available, and a sanitized explanation. Those named records are retained for up to 90 days, cascade-delete when the student disconnects, and are available only through authenticated operator access (`npm run connections:report` or `node /app/scripts/connection-report.mjs` in Railway SSH). The report defaults to seven days and can select up to 90 days with `--days=N`. Access logs contain route templates, method, status and duration only; they omit IP addresses, URLs, headers and bodies.

Passwords entered in the Telegram Web App remain temporary sign-in inputs; Moodle session cookies are never collected. Existing encrypted Moodle tokens authorize each account. Submission receipts and course snapshots are operational student data, separate from anonymous analytics, and are deleted when the student disconnects. Already submitted Moodle work, Telegram messages, backups and third-party calendar caches follow their respective retention. `/privacy` and the Connect Moodle window explain these boundaries.
