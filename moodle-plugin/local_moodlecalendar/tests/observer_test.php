<?php
// This file is part of Moodle - http://moodle.org/
// SPDX-License-Identifier: GPL-3.0-or-later

namespace local_moodlecalendar;

defined('MOODLE_INTERNAL') || die();

/**
 * Verify relevant writes are queued without forwarding personal data or reads.
 *
 * @package local_moodlecalendar
 * @copyright 2026 Moodle Calendar contributors
 * @license http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 * @covers \local_moodlecalendar\observer
 * @covers \local_moodlecalendar\configuration
 */
final class observer_test extends \advanced_testcase {
    public function test_reads_and_unrelated_writes_are_ignored(): void {
        $this->assertFalse(observer::is_relevant('\\core\\event\\course_viewed', 'r'));
        $this->assertFalse(observer::is_relevant('\\mod_assign\\event\\submission_status_viewed', 'r'));
        $this->assertFalse(observer::is_relevant('\\core\\event\\user_loggedin', 'r'));
        $this->assertFalse(observer::is_relevant('\\core\\event\\url_blocked', 'c'));
        $this->assertFalse(observer::is_relevant('\\local_moodlecalendar\\event\\sent', 'c'));
        $this->assertFalse(observer::is_relevant('\\unrelated\\event\\submission_created', 'c'));
    }

    public function test_completion_submission_and_course_writes_are_relevant(): void {
        $this->assertTrue(observer::is_relevant('\\core\\event\\course_module_updated', 'u'));
        $this->assertTrue(observer::is_relevant('\\core\\event\\course_module_completion_updated', 'u'));
        $this->assertTrue(observer::is_relevant('\\core\\event\\calendar_event_updated', 'u'));
        $this->assertTrue(observer::is_relevant('\\core\\event\\group_member_added', 'c'));
        $this->assertTrue(observer::is_relevant('\\mod_assign\\event\\submission_graded', 'u'));
        $this->assertTrue(observer::is_relevant('\\mod_assign\\event\\assessable_submitted', 'u'));
        $this->assertTrue(observer::is_relevant('\\assignsubmission_file\\event\\submission_created', 'c'));
        $this->assertTrue(observer::is_relevant('\\assignsubmission_onlinetext\\event\\submission_updated', 'u'));
        $this->assertTrue(observer::is_relevant('\\mod_folder\\event\\folder_updated', 'u'));
    }

    public function test_observer_queues_minimal_payload_with_no_user_id(): void {
        global $DB;
        $this->resetAfterTest();
        $course = $this->getDataGenerator()->create_course();
        set_config('enabled', 1, 'local_moodlecalendar');
        $event = \core\event\course_updated::create([
            'context' => \context_course::instance($course->id),
            'objectid' => $course->id,
        ]);
        observer::changed($event);
        $tasks = $DB->get_records('task_adhoc', ['component' => 'local_moodlecalendar']);
        $this->assertCount(1, $tasks);
        $task = reset($tasks);
        $payload = json_decode($task->customdata, true, 512, JSON_THROW_ON_ERROR);
        $this->assertSame(['eventId', 'eventName', 'courseId', 'occurredAt'], array_keys($payload));
        $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/', $payload['eventId']);
        $this->assertSame((int)$course->id, $payload['courseId']);
        $this->assertSame('\\core\\event\\course_updated', $payload['eventName']);
        $this->assertEmpty($task->userid);
    }

    public function test_endpoint_refuses_plain_http_and_url_credentials(): void {
        $this->assertTrue(configuration::valid_endpoint('https://calendar.example.edu/moodle/events'));
        foreach ([
            'http://calendar.example.edu/moodle/events',
            'https://user:secret@calendar.example.edu/moodle/events',
            'https://calendar.example.edu/moodle/events?token=secret',
            'https://calendar.example.edu/moodle/events#secret',
        ] as $endpoint) {
            $this->assertFalse(configuration::valid_endpoint($endpoint));
        }
    }
}
