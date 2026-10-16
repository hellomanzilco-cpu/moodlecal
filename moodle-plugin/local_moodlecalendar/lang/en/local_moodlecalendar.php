<?php
// This file is part of Moodle - http://moodle.org/
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * English language strings.
 *
 * @package local_moodlecalendar
 * @copyright 2026 Moodle Calendar contributors
 * @license http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

$string['pluginname'] = 'Moodle Calendar event bridge';
$string['enabled'] = 'Enable outbound course events';
$string['enabled_desc'] = 'Queue relevant course changes for the Moodle Calendar receiver. Delivery depends on Moodle cron. Disabling stops new events; existing events fail without delivery. Review failed tasks before re-enabling.';
$string['endpoint'] = 'Trusted receiver HTTPS URL';
$string['endpoint_desc'] = 'The public HTTPS Moodle Calendar event receiver, for example https://calendar.example.edu/moodle/events. Select a trusted host. URL credentials, query parameters and fragments are rejected. Redirects are not followed.';
$string['secret'] = 'Webhook signing secret';
$string['secret_desc'] = 'A random secret of at least 32 characters, shared only with the Moodle Calendar server. Use the same value as MOODLE_EVENT_SECRET in the bot environment. Never use a Moodle password or include the secret in the URL.';
$string['taskname'] = 'Deliver Moodle Calendar course event';
$string['privacy:metadata:eventid'] = 'Random event identifier retained across retries for deduplication.';
$string['privacy:metadata:eventname'] = 'The event class describing a relevant course change; no user identifier is included.';
$string['privacy:metadata:courseid'] = 'The course identifier, or zero for a site-wide event.';
$string['privacy:metadata:occurredat'] = 'The Unix timestamp at which the course event occurred.';
$string['privacy:metadata:external'] = 'Moodle Calendar receives minimal signed course invalidations and retrieves only the course data each connected student can access. No name, user ID, IP address, document content, grade, password or token is included in the event envelope.';
$string['privacy:metadata:task'] = 'Moodle core retains pending minimal event envelopes for delivery and applies its failed-task retention policy. Plugin administrator settings store the receiver URL and signing secret.';
