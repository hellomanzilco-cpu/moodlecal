import { MoodleError } from './moodle.ts';
import {SyncLimitError} from './sync-quota.ts';
export function syncFailure(error:unknown):string {
  if(error instanceof SyncLimitError)return '🔄 Daily sync limit reached\n\n'+error.message;
  let step='';
  if(error instanceof MoodleError){
    const operations:Record<string,string>={core_webservice_get_site_info:'checking the Moodle connection',core_enrol_get_users_courses:'reading your enrolled courses',core_course_get_contents:'reading course activities and documents',mod_assign_get_assignments:'reading assignment requirements',mod_assign_get_submission_status:'reading submission status and grades',mod_quiz_get_quizzes_by_courses:'reading quizzes',mod_quiz_get_user_attempts:'reading quiz attempts',core_calendar_get_calendar_events:'reading calendar events',core_group_get_course_user_groups:'reading your course groups'};
    step=error.operation&&operations[error.operation]?`\nFailed check: ${operations[error.operation]}.`:'';
    const diagnostic=error.apiErrorCode?`\nMoodle API code: ${error.apiErrorCode}.`:error.reason==='network'?'\nMoodle returned no API error code (connection failure or timeout).':'';
    if(error.apiErrorCode==='missing_lastattempt')return 'Moodle responded, but did not return this student’s assignment submission details. University Moodle support should check the student role’s mod/assign:viewownsubmissionsummary capability.'+step+diagnostic;
    if(error.reason==='network')return 'UWED Moodle is not responding. Try 🔄 Sync again when the website is available. Your saved data and last successful update time are unchanged.'+step+diagnostic;
    if(error.reason==='authentication')return 'Moodle rejected this connection. Open Settings → Reconnect Moodle. Your saved data is preserved.'+step+diagnostic;
    if(error.reason==='permission')return 'Moodle does not allow the requested student API access. University IT may need to enable it. Your saved data is preserved.'+step+diagnostic;
    if(error.warningCodes?.length)return 'Moodle returned incomplete data. Your last successful snapshot is preserved.'+step+'\nMoodle warning codes: '+error.warningCodes.join(', ')+'.'+diagnostic;
    if(error.apiErrorCode)return 'Moodle returned an API error. Your last successful snapshot is preserved.'+step+diagnostic;
  }
  return 'Moodle could not be synced. Your saved data is preserved. Try 🔄 Sync again later; check Status for the last successful update.'+step;
}
