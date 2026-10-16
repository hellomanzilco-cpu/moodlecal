import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import type { Item } from './types.ts';
import { isFocusItem } from './planning.ts';

function text(value: string): string { return value.replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,'); }
function stamp(seconds: number): string { return DateTime.fromSeconds(seconds, {zone:'utc'}).toFormat("yyyyLLdd'T'HHmmss'Z'"); }
// RFC 5545 limits physical lines to 75 octets. Preserve UTF-8 code points.
export function foldLine(value: string): string {
  const lines: string[] = []; let current = ''; let bytes = 0;
  for (const char of value) {
    const length = Buffer.byteLength(char);
    if (bytes + length > 75) { lines.push(current); current = ' '; bytes = 1; }
    current += char; bytes += length;
  }
  lines.push(current); return lines.join('\r\n');
}
export function renderCalendar(items: Item[], tenantId: number, now: number): string {
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Moodle Calendar//UWED Student Planner//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:Moodle Calendar','REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  const seen = new Set<string>();
  for (const i of items) {
    const start = i.startsAt ?? i.dueAt;
    if (start === null || !Number.isFinite(start) || i.completed || !isFocusItem(i,items,now) || seen.has(i.key)) continue;
    if (start < now - 30 * 86400 || start > now + 370 * 86400) continue;
    seen.add(i.key);
    const hash = createHash('sha256').update(`${tenantId}:${i.key}`).digest('hex');
    // Sequence is stable for identical snapshots; time-based revisions increase monotonically.
    lines.push('BEGIN:VEVENT',`UID:${hash}@moodle-calendar`, `DTSTAMP:${stamp(now)}`,
      `LAST-MODIFIED:${stamp(i.modifiedAt || now)}`,`DTSTART:${stamp(start)}`,
      `DTEND:${stamp(Math.max(start+60, i.endsAt ?? start+900))}`,
      `SUMMARY:${text(`${i.courseName}: ${i.title}${i.dueAt !== null && i.startsAt === null ? ' (deadline)' : ''}`)}`,
      `DESCRIPTION:${text(`${i.description}${i.url ? '\n'+i.url : ''}`)}`);
    if (i.url && /^https:\/\//i.test(i.url) && !/[\r\n]/.test(i.url)) lines.push(`URL:${i.url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR'); return lines.map(foldLine).join('\r\n')+'\r\n';
}
