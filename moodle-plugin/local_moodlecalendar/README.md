# Moodle Calendar event bridge

Administrator-reviewable Moodle 4.5+ local plugin. This is an alpha integration; it has not been installed or exercised against the university's Moodle server.

Install this directory as `<moodle-root>/local/moodlecalendar` (the installed directory name is `moodlecalendar`, not `local_moodlecalendar`). A plugin ZIP must have `moodlecalendar/` as its single top-level directory. See [the deployment and event contract](../../docs/MOODLE_EVENTS.md) in the application repository before enabling it.

The plugin observes selected course changes, queues Moodle adhoc tasks, and signs a minimal JSON event envelope for the bot. It does not install a periodic task, fetch student accounts, expose a Moodle web service, or include a student's identity/content in the event payload. Moodle cron must be running to deliver queued events. HTTP failures throw so Moodle can retry; event IDs stay the same on retries. Administrators must monitor stopped/failed tasks because Moodle bounds retry attempts and applies its own retention policy.

Configuration: **Site administration → Plugins → Local plugins → Moodle Calendar event bridge**. Set the trusted public HTTPS endpoint and random shared signing secret before enabling the bridge. Default is disabled. Enabling requires a UWED Moodle administrator; a student account cannot activate this functionality.

Run the included integration tests within a configured Moodle PHPUnit environment:

```sh
vendor/bin/phpunit local/moodlecalendar/tests/observer_test.php
```

PHP and a Moodle test environment are required. Review/staging installation and the smoke tests in the deployment document are still necessary before production use.
