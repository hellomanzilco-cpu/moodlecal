import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, openSync, closeSync, statSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

let source,verification;
try {
  if(existsSync('.env'))loadEnvFile('.env');
  const sourcePath=resolve(process.env.DATABASE_PATH || './data/moodle-calendar.sqlite');
  if(!existsSync(sourcePath))throw new Error('No source database');
  const directory=join(dirname(sourcePath),'backups');mkdirSync(directory,{recursive:true});
  const target=join(directory,`moodle-calendar-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.sqlite`);
  closeSync(openSync(target,'wx',0o600));
  source=new DatabaseSync(sourcePath,{readOnly:true});
  await backup(source,target);
  verification=new DatabaseSync(target,{readOnly:true});
  const result=verification.prepare('PRAGMA integrity_check').get();
  if(Object.values(result || {})[0]!=='ok')throw new Error('Backup verification failed');
  console.log(JSON.stringify({backup:target,bytes:statSync(target).size,verified:true}));
  console.log('Keep the matching ENCRYPTION_KEY separately. No credentials were printed.');
}catch{console.error('Database backup failed. Check database path, permissions and available storage.');process.exitCode=1;}
finally{verification?.close();source?.close();}
