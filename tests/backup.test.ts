import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';

test('migration backup is a verified independent SQLite snapshot including student state',t=>{
  const directory=mkdtempSync(join(tmpdir(),'moodle-backup-'));const path=join(directory,'app.sqlite');
  const store=new Store(path);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.ensureStudent(101,101);store.setMeta('migration-test','preserved');
  const result=spawnSync(process.execPath,['scripts/backup.mjs'],{encoding:'utf8',env:{...process.env,DATABASE_PATH:path}});
  assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout.split(/\r?\n/)[0]);assert.equal(report.verified,true);
  const backup=new DatabaseSync(report.backup,{readOnly:true});
  try{assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM students').get()!.count,1);assert.equal(backup.prepare('SELECT value FROM meta WHERE key=?').get('migration-test')!.value,'preserved');}
  finally{backup.close();}
});
