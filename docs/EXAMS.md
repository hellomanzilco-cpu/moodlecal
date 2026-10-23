# Exams and preparation

More → Exams lists the requesting student's enrolled, unmuted subjects. Choose a subject to view midterm controls, final controls, other explicitly labelled exams, their Moodle activity windows/deadlines and preparation links. The four-button main menu is unchanged. English, Uzbek and Russian are supported. `/exams`, `/exam COURSE_ID`, and `/examfiles COURSE_ID` are also accepted; buttons do not require typing commands.

Classification uses explicit English, Uzbek or Russian labels in the activity title, course section or attachment filenames. Regular `joriy nazorat` / `ЖН` activities, attendance events, generic control questions and dates alone do not become exams. Preparation resources are listed as materials, never as exam appointments. Missing dates remain unpublished. No date from an individual student's account is hardcoded or shared with another student.

Moodle assignment due dates are labelled **submission deadlines**; quiz opening/closing times stay separate. Teacher titles, retakes and distinct activities are preserved rather than merging different attempts into a guessed date. Local Done flags do not claim completion in Moodle. Assignment links use the existing private task window; quiz links open Moodle and do not start or answer a quiz.

The view reads the saved verified snapshot. Sync still performs all required submission-status/grade checks and preserves the previous snapshot on failure. Course section metadata is saved in existing item JSON without a schema migration. Its first appearance does not generate false teacher-change alerts; later section renames are reported.

## Preparation files

Send preparation files is an explicit student action. It rechecks current Moodle enrolment and module/section visibility with that student's own token before resolving file metadata. Assignment attachments use the existing authenticated assignment reader. Resource downloads accept only same-origin HTTPS Moodle pluginfile URLs with no embedded token; the token is attached only to the outbound download request. Redirects and external file hosts are rejected.

Files are held temporarily in memory and delivered to the requesting student's private Telegram chat. File URLs and tokens are not stored in snapshots or replies. The service rechecks the connection before downloading and sending, so a disconnected or replaced connection cannot continue delivery. It does not refresh the full snapshot, update its timestamp, consume a full-sync allowance, change grades, submit coursework or request an exam attempt.

Requests have a 60-second per-student cooldown, two concurrent file batches, a bounded waiting queue, at most 12 candidate files per batch, a 20 MiB per-file cap and a 30 MiB total cap. A batch stops starting new downloads after 90 seconds; the in-flight operation has its own bounded timeout. Skipped and failed deliveries are counted explicitly, with Moodle links available for remaining materials. Download requests use the network worker lane, including translated buttons, keeping menu capacity separate.

## Live read-only verification, 23 October 2026

The owner's configured Moodle account returned a full snapshot with no coverage warnings. There were 15 explicitly labelled controls: nine midterms and six finals. These are activities, not necessarily 15 separate exam appointments. The inspection verified accessible preparation files in International Competitiveness, Economic Diplomacy and International Political Economy. One preparation PDF was downloaded in memory and its expected size and PDF signature were verified. No Telegram messages were sent and no Moodle work was submitted.

The private report is `data/exam-report.md` (ignored by Git). It includes teacher-provided resource links and filenames. It is specific to the inspected account and must not be committed or used as another student's data.

## Talaba UWED timetable: pending integration

The owner clarified that the exams on **9 and 10 December 2026** appear in Talaba UWED. Those appointments were not present as explicitly labelled exams in the inspected Moodle data and have not been imported or verified.

Verified public sources:

- Official Talaba landing page: https://talaba.uwed.uz/ — describes daily classes and exams and states the web version has been discontinued in favour of the mobile app.
- Official Android listing: https://play.google.com/store/apps/details?id=com.talaba.uwed — lists UWED as publisher and `itc@uwed.uz` as support.
- iOS listing: https://apps.apple.com/us/app/talaba/id6749435277.

No supported timetable API or API authentication documentation was found in these sources. The previously published public timetable URL `https://manage.uwed.uz/public/pages/inf-tt` returned an access warning during inspection; exploration of that service stopped. No endpoints were guessed, access controls bypassed, private mobile traffic intercepted or Moodle credentials sent to Talaba.

The owner confirmed that Talaba does not offer an export option. To implement the timetable source, obtain supported read-only API documentation and a student-authorized login/token flow from UWED IT. Required data include stable exam IDs, subject identifiers, midterm/final type, date/time/timezone, location, cancellations and update timestamps. Preserve Talaba appointments separately from Moodle assignment deadlines. Match courses only through confirmed identifiers or student confirmation; show source and last successful check, preserve data on errors and keep account access isolated. Exclude attendance check-in, Face ID, administrative writes and unrelated student records.

Suggested request to `itc@uwed.uz` (not sent): “I am developing an independent student-authorized Moodle Calendar bot. Does UWED provide a supported read-only Talaba timetable/exam API? Please share the API base URL, documentation, login/authorization flow for third-party applications, rate limits, and stable subject/exam identifiers. The integration needs each consenting student's own exam dates, times and locations only; it will not mark attendance or modify university records.”

The Talaba integration is **not connected**; no placeholder endpoint or fabricated timetable is shipped. The Moodle Exams release requires a production health check and verification that existing Moodle connections are preserved after deployment.
