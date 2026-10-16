import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {migratePlaintextBackups} from '../src/backups.ts';

try{
  process.umask(0o077);
  if(existsSync('.env'))loadEnvFile('.env');
  const result=await migratePlaintextBackups(process.env.DATABASE_PATH||'./data/moodle-calendar.sqlite',process.env.ENCRYPTION_KEY||'');
  console.log(JSON.stringify({legacyBackupsSecured:true,...result}));
}catch{
  console.error('Legacy backup migration failed. Unverified plaintext sources were preserved. Check the matching key, backup integrity, SQLite companion files and storage permissions.');
  process.exitCode=1;
}
