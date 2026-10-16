<?php
// This file is part of Moodle - http://moodle.org/
// SPDX-License-Identifier: GPL-3.0-or-later

namespace local_moodlecalendar\task;

defined('MOODLE_INTERNAL') || die();

/**
 * Deliver one stable event envelope; let Moodle retry every failed HTTP attempt.
 *
 * @package local_moodlecalendar
 * @copyright 2026 Moodle Calendar contributors
 * @license http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
final class deliver_event extends \core\task\adhoc_task {
    /** @return string Administrator-facing task name */
    public function get_name(): string {
        return get_string('taskname', 'local_moodlecalendar');
    }

    /**
     * POST the stored payload with a fresh timestamp on every attempt.
     *
     * @throws \RuntimeException Moodle cron retains and retries the task on failure
     */
    public function execute(): void {
        global $CFG;
        require_once($CFG->libdir . '/filelib.php');

        $config = \local_moodlecalendar\configuration::delivery();
        // Persisted JSON makes eventId and the raw payload identical across retries.
        $body = $this->get_custom_data_as_string();
        $timestamp = (string)time();
        $signature = hash_hmac('sha256', $timestamp . '.' . $body, $config['secret']);
        $curl = new \curl();
        $curl->setHeader([
            'Content-Type: application/json',
            'Accept: application/json',
            'X-Moodle-Calendar-Timestamp: ' . $timestamp,
            'X-Moodle-Calendar-Signature: ' . $signature,
        ]);
        $curl->post($config['endpoint'], $body, [
            'CURLOPT_CONNECTTIMEOUT' => 5,
            'CURLOPT_TIMEOUT' => 20,
            'CURLOPT_FOLLOWLOCATION' => false,
            'CURLOPT_MAXREDIRS' => 0,
            'CURLOPT_SSL_VERIFYPEER' => true,
            'CURLOPT_SSL_VERIFYHOST' => 2,
        ]);
        $status = (int)($curl->get_info()['http_code'] ?? 0);
        if ($curl->get_errno() !== 0 || $status < 200 || $status >= 300) {
            // Never log the response, URL, signature or configuration: those can contain secrets.
            throw new \RuntimeException('Moodle Calendar event delivery failed (HTTP ' . $status . '); retry required.');
        }
    }

    /** @return bool Permit Moodle's normal retry policy after failure */
    public function retry_until_success(): bool {
        return true;
    }
}
