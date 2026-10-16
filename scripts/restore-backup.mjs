import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {restoreEncryptedBackup} from '../src/backups.ts';
try{
  process.umask(0o077);if(existsSync('.env'))loadEnvFile('.env');
  const [source,target]=process.argv.slice(2);if(!source||!target)throw new Error('Source and new target paths are required.');
  await restoreEncryptedBackup(source,target,process.env.ENCRYPTION_KEY||'');console.log('Backup authenticated and restored to the new database path. Integrity check passed.');
}catch{console.error('Restore failed. The target must be a new file and the matching backup key is required. Existing files were not overwritten.');process.exitCode=1;}
