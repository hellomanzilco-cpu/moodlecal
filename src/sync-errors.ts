import { MoodleError } from './moodle.ts';
export function syncFailure(error:unknown):string {
  if(error instanceof MoodleError){
    if(error.reason==='network')return 'UWED Moodle is not responding. Try 🔄 Sync again when the website is available. Your saved data and last successful update time are unchanged.';
    if(error.reason==='authentication')return 'Moodle rejected this connection. Open Settings → Reconnect Moodle. Your saved data is preserved.';
    if(error.reason==='permission')return 'Moodle does not allow the requested student API access. University IT may need to enable it. Your saved data is preserved.';
  }
  return 'Moodle could not be synced. Your saved data is preserved. Try 🔄 Sync again later; check Status for the last successful update.';
}
