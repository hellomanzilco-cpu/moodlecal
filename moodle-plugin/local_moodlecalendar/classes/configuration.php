<?php
// This file is part of Moodle - http://moodle.org/
// SPDX-License-Identifier: GPL-3.0-or-later

namespace local_moodlecalendar;

defined('MOODLE_INTERNAL') || die();

/**
 * Validate the trusted administrator-provided delivery destination.
 *
 * @package local_moodlecalendar
 * @copyright 2026 Moodle Calendar contributors
 * @license http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
final class configuration {
    /**
     * Read validated configuration. Misconfiguration must fail the task for retry.
     *
     * @return array{endpoint: string, secret: string}
     */
    public static function delivery(): array {
        $config = get_config('local_moodlecalendar');
        if (empty($config->enabled)) {
            throw new \RuntimeException('Moodle Calendar delivery is disabled; check queued and failed tasks before re-enabling.');
        }
        $endpoint = trim((string)($config->endpoint ?? ''));
        $secret = (string)($config->secret ?? '');
        if (!self::valid_endpoint($endpoint)) {
            throw new \RuntimeException('Moodle Calendar needs a trusted HTTPS endpoint without credentials, query or fragment.');
        }
        if (strlen($secret) < 32 || preg_match('/[\r\n]/', $secret)) {
            throw new \RuntimeException('Moodle Calendar needs a signing secret of at least 32 characters.');
        }
        return ['endpoint' => $endpoint, 'secret' => $secret];
    }

    /**
     * Endpoint URLs may not carry a token or HTTP basic authentication.
     *
     * The native Moodle curl client additionally applies site HTTP security and proxy settings.
     * The administrator must select a trusted public host; students cannot configure this setting.
     *
     * @param string $endpoint Destination URL
     * @return bool
     */
    public static function valid_endpoint(string $endpoint): bool {
        if (!filter_var($endpoint, FILTER_VALIDATE_URL) || preg_match('/[\x00-\x20\x7f]/', $endpoint)) {
            return false;
        }
        $parts = parse_url($endpoint);
        return $parts !== false
            && strtolower($parts['scheme'] ?? '') === 'https'
            && !empty($parts['host'])
            && !isset($parts['user'])
            && !isset($parts['pass'])
            && !isset($parts['query'])
            && !isset($parts['fragment']);
    }
}
