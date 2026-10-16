<?php
// This file is part of Moodle - http://moodle.org/
// SPDX-License-Identifier: GPL-3.0-or-later

namespace local_moodlecalendar\privacy;

defined('MOODLE_INTERNAL') || die();

/**
 * Declare the external event bridge and the Moodle task subsystem.
 *
 * The bridge omits all user identifiers and content. An event type and timestamp
 * can nevertheless describe activity by a person, so the external processing is
 * declared explicitly rather than claiming a null provider.
 *
 * @package local_moodlecalendar
 * @copyright 2026 Moodle Calendar contributors
 * @license http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
final class provider implements
        \core_privacy\local\metadata\provider,
        \core_privacy\local\request\plugin\provider,
        \core_privacy\local\request\core_userlist_provider {
    /**
     * Describe the data delivered and the subsystem retaining pending envelopes.
     *
     * There is no plugin-owned user table or user preference to export/delete.
     * Moodle manages adhoc-task storage; the bot manages its own student data.
     *
     * @param \core_privacy\local\metadata\collection $collection Metadata collection
     * @return \core_privacy\local\metadata\collection
     */
    public static function get_metadata(\core_privacy\local\metadata\collection $collection): \core_privacy\local\metadata\collection {
        $collection->add_external_location_link('moodlecalendar', [
            'eventId' => 'privacy:metadata:eventid',
            'eventName' => 'privacy:metadata:eventname',
            'courseId' => 'privacy:metadata:courseid',
            'occurredAt' => 'privacy:metadata:occurredat',
        ], 'privacy:metadata:external');
        $collection->add_subsystem_link('core', [], 'privacy:metadata:task');
        return $collection;
    }

    /**
     * No user identifier is retained, so there are no user-owned plugin contexts.
     *
     * @param int $userid User identifier
     * @return \core_privacy\local\request\contextlist
     */
    public static function get_contexts_for_userid(int $userid): \core_privacy\local\request\contextlist {
        return new \core_privacy\local\request\contextlist();
    }

    /**
     * No user identifier exists to match in any context.
     *
     * @param \core_privacy\local\request\userlist $userlist User list to populate
     */
    public static function get_users_in_context(\core_privacy\local\request\userlist $userlist): void {
    }

    /**
     * The bridge cannot retrieve data from the external bot and stores no user records.
     *
     * @param \core_privacy\local\request\approved_contextlist $contextlist Contexts to export
     */
    public static function export_user_data(\core_privacy\local\request\approved_contextlist $contextlist): void {
    }

    /**
     * No plugin user records exist; core owns the unassociated adhoc task queue.
     *
     * @param \context $context Context to delete
     */
    public static function delete_data_for_all_users_in_context(\context $context): void {
    }

    /**
     * No user identifiers exist in the plugin's data.
     *
     * @param \core_privacy\local\request\approved_contextlist $contextlist Contexts to delete
     */
    public static function delete_data_for_user(\core_privacy\local\request\approved_contextlist $contextlist): void {
    }

    /**
     * No user identifiers exist in the plugin's data.
     *
     * @param \core_privacy\local\request\approved_userlist $userlist Users to delete
     */
    public static function delete_data_for_users(\core_privacy\local\request\approved_userlist $userlist): void {
    }
}
