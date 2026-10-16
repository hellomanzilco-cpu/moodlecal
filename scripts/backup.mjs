import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {createEncryptedBackup} from '../src/backups.ts';
try{
  process.umask(0o077);if(existsSync('.env'))loadEnvFile('.env');
  console.log(JSON.stringify(await createEncryptedBackup(process.env.DATABASE_PATH||'./data/moodle-calendar.sqlite',process.env.ENCRYPTION_KEY||'')));
  console.log('Keep the matching ENCRYPTION_KEY separately. No credentials were printed.');
}catch{console.error('Encrypted database backup failed. Check the key, source path, permissions and storage.');process.exitCode=1;}
