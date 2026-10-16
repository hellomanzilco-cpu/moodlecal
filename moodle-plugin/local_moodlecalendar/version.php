<?php
// This file is part of Moodle - http://moodle.org/
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Version information for the Moodle Calendar event bridge.
 *
 * @package local_moodlecalendar
 * @copyright 2026 Moodle Calendar contributors
 * @license http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

$plugin->component = 'local_moodlecalendar';
$plugin->version = 2026101600;
$plugin->requires = 2024100700; // Moodle 4.5.
$plugin->maturity = MATURITY_ALPHA;
$plugin->release = '0.1.0';
$plugin->dependencies = ['mod_assign' => 2024100700];
