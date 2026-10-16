<?php
// This file is part of Moodle - http://moodle.org/
// SPDX-License-Identifier: GPL-3.0-or-later

namespace local_moodlecalendar;

defined('MOODLE_INTERNAL') || die();

/**
 * Queue course invalidations without HTTP inside the student's web request.
 *
 * @package local_moodlecalendar
 * @copyright 2026 Moodle Calendar contributors
 * @license http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
final class observer {
    /** @var string[] Core event names that can alter student-visible course state. */
    private const CORE_EVENTS = [
        'course_created', 'course_updated', 'course_deleted',
        'course_module_created', 'course_module_updated', 'course_module_deleted',
        'course_section_created', 'course_section_updated', 'course_section_deleted',
        'calendar_event_created', 'calendar_event_updated', 'calendar_event_deleted',
        'course_module_completion_updated', 'course_completion_updated', 'course_completed',
        'user_graded', 'grade_deleted',
        'user_enrolment_created', 'user_enrolment_updated', 'user_enrolment_deleted',
        'group_created', 'group_updated', 'group_deleted',
        'group_member_added', 'group_member_removed',
        'grouping_created', 'grouping_updated', 'grouping_deleted',
        'grouping_group_assigned', 'grouping_group_unassigned',
        'role_assigned', 'role_unassigned',
    ];

    /**
     * Observe relevant writes only. Read requests cannot recursively trigger delivery.
     *
     * @param \core\event\base $event Triggered Moodle event
     */
    public static function changed(\core\event\base $event): void {
        if (!get_config('local_moodlecalendar', 'enabled')
                || !self::is_relevant($event->eventname, $event->crud)) {
            return;
        }
        $task = new \local_moodlecalendar\task\deliver_event();
        $task->set_component('local_moodlecalendar');
        // Do not include userid, relateduserid, IP, names, grades, URLs, credentials or event->other.
        $task->set_custom_data((object)[
            'eventId' => bin2hex(random_bytes(16)),
            'eventName' => (string)$event->eventname,
            'courseId' => max(0, (int)$event->courseid),
            'occurredAt' => (int)$event->timecreated,
        ]);
        \core\task\manager::queue_adhoc_task($task);
    }

    /**
     * Explicitly filter wildcard subscriptions; incidental log events are excluded.
     *
     * Assignment submission and feedback subplugins emit their own concrete event classes.
     * No event class needs to be instantiated to make the filter work.
     *
     * @param string $eventname Fully qualified Moodle event name
     * @param string $crud Event CRUD operation
     * @return bool
     */
    public static function is_relevant(string $eventname, string $crud): bool {
        if (!in_array($crud, ['c', 'u', 'd'], true)) {
            return false;
        }
        $name = ltrim($eventname, '\\');
        $coreprefix = 'core\\event\\';
        if (str_starts_with($name, $coreprefix)) {
            return in_array(substr($name, strlen($coreprefix)), self::CORE_EVENTS, true);
        }
        if ($name === 'mod_folder\\event\\folder_updated') {
            return true;
        }
        return (bool)preg_match('/^(mod_assign|assignsubmission_[a-z0-9_]+|assignfeedback_[a-z0-9_]+)\\\\event\\\\[a-z0-9_]+$/', $name);
    }
}
