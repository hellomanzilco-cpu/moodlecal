# Moodle connection diagnostics

The application keeps named records for failed, blocked or limited-coverage Moodle connection attempts. Each record includes the Telegram display name, start and finish times, last connection stage, a safe failure category and message, and the Moodle API operation and error code when available. Passwords, Moodle usernames, access tokens, request bodies, IP addresses and raw Moodle responses are excluded.

The Telegram display name is held encrypted in the database only while its private connection link is valid, then copied in encrypted form into a failed/limited-attempt record. Names are decrypted only by the operator report and sanitized owner alerts. Fully successful attempts are deleted from the diagnostic table. Records expire after 90 days and are removed when the student disconnects. Encrypted backups may keep prior copies until backup rotation. When `OWNER_TELEGRAM_ID` is configured, operational failures and limited coverage trigger a private alert with the Telegram name, failing step, safe category, operation, API/HTTP status when available, and diagnostic ID. Credentials, Moodle usernames and raw upstream messages are never sent.

Run `npm run connections:report` locally or `node /app/scripts/connection-report.mjs` in authenticated Railway SSH to inspect the last seven days. Use `--days=1` through `--days=90` to select a window. Reports contain Telegram display names, not verified Moodle names. Older aggregate failure counters do not contain per-student reasons and cannot be backfilled.

HTTP access logs are written to application stdout. They contain only method, matched route template, response status and duration. Request URLs, query strings, headers, bodies, IP addresses and Telegram names are not logged.
