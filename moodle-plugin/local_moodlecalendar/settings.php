<?php
// This file is part of Moodle - http://moodle.org/
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Administrator-only settings for the outbound event bridge.
 *
 * @package local_moodlecalendar
 * @copyright 2026 Moodle Calendar contributors
 * @license http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

if ($hassiteconfig) {
    $settings = new admin_settingpage('local_moodlecalendar', get_string('pluginname', 'local_moodlecalendar'));
    $ADMIN->add('localplugins', $settings);

    $settings->add(new admin_setting_configcheckbox(
        'local_moodlecalendar/enabled',
        get_string('enabled', 'local_moodlecalendar'),
        get_string('enabled_desc', 'local_moodlecalendar'),
        0
    ));
    $settings->add(new admin_setting_configtext(
        'local_moodlecalendar/endpoint',
        get_string('endpoint', 'local_moodlecalendar'),
        get_string('endpoint_desc', 'local_moodlecalendar'),
        '',
        PARAM_RAW_TRIMMED,
        80
    ));
    $settings->add(new admin_setting_configpasswordunmask(
        'local_moodlecalendar/secret',
        get_string('secret', 'local_moodlecalendar'),
        get_string('secret_desc', 'local_moodlecalendar'),
        ''
    ));
}
