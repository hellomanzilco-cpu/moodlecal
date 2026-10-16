import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync,mkdirSync,symlinkSync,statSync,copyFileSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.ts';
import {cleanupStaleBackupStages,createEncryptedBackup,encryptBackupFile,migratePlaintextBackups,pruneEncryptedBackups,restoreEncryptedBackup,verifyEncryptedBackup} from '../src/backups.ts';

const key=randomBytes(32).toString('base64');
function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'moodle-backup-')),path=join(directory,'app.sqlite');
  const store=new Store(path);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.ensureStudent(101,101);store.setMeta('migration-test','preserved');
  return {directory,path,store};
}
function snapshotValue(path:string):string{
  const database=new DatabaseSync(path,{readOnly:true});
  try{
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM students').get()!.count,1);
    assert.equal(Object.values(database.prepare('PRAGMA integrity_check').get()!)[0],'ok');
    return String(database.prepare('SELECT value FROM meta WHERE key=?').get('migration-test')!.value);
  }finally{database.close();}
}
function assertClean(directory:string){
  assert.deepEqual(readdirSync(directory).filter(name=>name.startsWith('.pending-')),[]);
}
function legacyBackup(path:string,directory:string,index='abcdef01'){
  const source=new DatabaseSync(path);source.exec('PRAGMA wal_checkpoint(TRUNCATE)');source.close();
  const backups=join(directory,'backups');mkdirSync(backups,{recursive:true});
  const legacy=join(backups,`moodle-calendar-2026-10-01T07-00-00-000Z-${index}.sqlite`);
  copyFileSync(path,legacy);
  const snapshot=new DatabaseSync(legacy);snapshot.exec('PRAGMA journal_mode=DELETE');snapshot.close();
  return legacy;
}

test('backup command creates an authenticated encrypted independent SQLite snapshot',async t=>{
  const {directory,path,store}=fixture(t);
  const result=spawnSync(process.execPath,['scripts/backup.mjs'],{encoding:'utf8',env:{...process.env,DATABASE_PATH:path,ENCRYPTION_KEY:key}});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout.split(/\r?\n/)[0]);
  assert.equal(report.verified,true);assert.equal(report.encrypted,true);assert.match(report.backup,/\.sqlite\.enc$/);
  assert.equal(report.bytes,statSync(report.backup).size);
  const ciphertext=readFileSync(report.backup);
  assert.notEqual(ciphertext.subarray(0,16).toString(),'SQLite format 3\0');
  assert.equal(ciphertext.includes(Buffer.from('preserved')),false);
  assert.equal(ciphertext.includes(Buffer.from(key)),false);
  assert.equal(result.stdout.includes(key),false);assert.equal(result.stderr.includes(key),false);
  await verifyEncryptedBackup(report.backup,key);
  store.setMeta('migration-test','changed after snapshot');
  const restored=join(directory,'restored.sqlite');
  const restoreResult=spawnSync(process.execPath,['scripts/restore-backup.mjs',report.backup,restored],{encoding:'utf8',env:{...process.env,ENCRYPTION_KEY:key}});
  assert.equal(restoreResult.status,0,restoreResult.stderr);
  assert.equal(snapshotValue(restored),'preserved');
  assert.equal(store.getMeta('migration-test'),'changed after snapshot');
  assertClean(directory);assertClean(join(directory,'backups'));
});

test('backups use fresh salt and IV and decrypt to the original bytes',async t=>{
  const {directory,path}=fixture(t),first=join(directory,'first.enc'),second=join(directory,'second.enc');
  // Take an ordinary SQLite file for this low-level encryption test.
  const source=new DatabaseSync(path);source.exec('PRAGMA wal_checkpoint(TRUNCATE)');source.close();
  const original=readFileSync(path),digest=createHash('sha256').update(original).digest('hex');
  await encryptBackupFile(path,first,key);await encryptBackupFile(path,second,key);
  assert.notDeepEqual(readFileSync(first),readFileSync(second));
  assert.equal(await verifyEncryptedBackup(first,key),digest);
  assert.equal(await verifyEncryptedBackup(second,key),digest);
  assert.deepEqual(readFileSync(path),original);assertClean(directory);
});

test('wrong keys and tampered headers, ciphertext, tags or truncation never publish restored plaintext',async t=>{
  const {directory,path}=fixture(t),report=await createEncryptedBackup(path,key),encrypted=readFileSync(report.backup);
  const wrongKey=randomBytes(32).toString('base64'),wrongTarget=join(directory,'wrong-key.sqlite');
  await assert.rejects(verifyEncryptedBackup(report.backup,wrongKey));
  await assert.rejects(restoreEncryptedBackup(report.backup,wrongTarget,wrongKey));
  assert.equal(existsSync(wrongTarget),false);assertClean(directory);
  const variants=[0,14,40,Math.floor(encrypted.length/2),encrypted.length-1];
  for(const [index,position] of variants.entries()){
    const tampered=Buffer.from(encrypted);tampered[position]^=0x01;
    const corrupt=join(directory,`tampered-${index}.enc`),target=join(directory,`tampered-${index}.sqlite`);
    writeFileSync(corrupt,tampered);
    await assert.rejects(verifyEncryptedBackup(corrupt,key));
    await assert.rejects(restoreEncryptedBackup(corrupt,target,key));
    assert.equal(existsSync(target),false);assertClean(directory);
  }
  for(const length of [0,16,encrypted.length-1]){
    const corrupt=join(directory,`truncated-${length}.enc`),target=join(directory,`truncated-${length}.sqlite`);
    writeFileSync(corrupt,encrypted.subarray(0,length));
    await assert.rejects(restoreEncryptedBackup(corrupt,target,key));
    assert.equal(existsSync(target),false);assertClean(directory);
  }
});

test('an authenticated non-SQLite payload fails integrity validation and is removed',async t=>{
  const {directory}=fixture(t),source=join(directory,'not-sqlite'),encrypted=join(directory,'not-sqlite.enc'),target=join(directory,'restored.sqlite');
  writeFileSync(source,'not a database; must not be published');
  await encryptBackupFile(source,encrypted,key);
  const restoring=restoreEncryptedBackup(encrypted,target,key);
  assert.equal(existsSync(target),false);
  await assert.rejects(restoring);
  assert.equal(existsSync(target),false);assertClean(directory);
});

test('encryption and restoration never overwrite existing targets, including a creation race',async t=>{
  const {directory,path}=fixture(t),report=await createEncryptedBackup(path,key),target=join(directory,'existing');
  writeFileSync(target,'existing data');
  await assert.rejects(encryptBackupFile(path,target,key));
  await assert.rejects(restoreEncryptedBackup(report.backup,target,key));
  assert.equal(readFileSync(target,'utf8'),'existing data');
  const encryptRace=join(directory,'encrypt-race.enc'),encrypting=encryptBackupFile(path,encryptRace,key);
  assert.equal(existsSync(encryptRace),false);writeFileSync(encryptRace,'created concurrently');
  await assert.rejects(encrypting);assert.equal(readFileSync(encryptRace,'utf8'),'created concurrently');
  const restoreRace=join(directory,'restore-race.sqlite'),restoring=restoreEncryptedBackup(report.backup,restoreRace,key);
  assert.equal(existsSync(restoreRace),false);writeFileSync(restoreRace,'created concurrently');
  await assert.rejects(restoring);assert.equal(readFileSync(restoreRace,'utf8'),'created concurrently');assertClean(directory);
});

test('invalid keys and invalid source databases leave no plaintext or encrypted partial backups',async t=>{
  const {directory,path}=fixture(t);
  await assert.rejects(createEncryptedBackup(path,''));
  assert.equal(existsSync(join(directory,'backups')),false);
  const invalid=join(directory,'invalid.sqlite');writeFileSync(invalid,'not sqlite');
  await assert.rejects(createEncryptedBackup(invalid,key));
  assert.deepEqual(readdirSync(join(directory,'backups')),[]);
  assert.equal(readFileSync(invalid,'utf8'),'not sqlite');
  await assert.rejects(createEncryptedBackup(join(directory,'missing.sqlite'),key));
  assert.equal(existsSync(join(directory,'missing.sqlite')),false);
});

test('retention removes only matching regular encrypted backups and preserves newest files',t=>{
  const {directory,path}=fixture(t),backups=join(directory,'backups');mkdirSync(backups);
  const names=Array.from({length:4},(_,index)=>`moodle-calendar-2026-10-${String(index+1).padStart(2,'0')}T07-00-00-000Z-abcdef01.sqlite.enc`);
  for(const name of names)writeFileSync(join(backups,name),'encrypted placeholder');
  const unrelated=['moodle-calendar-2026-10-01T07-00-00-000Z-abcdef01.sqlite','other.enc','.pending-old','moodle-calendar-not-a-date-abcdef01.sqlite.enc','moodle-calendar-2026-99-01T07-00-00-000Z-abcdef01.sqlite.enc'];
  for(const name of unrelated)writeFileSync(join(backups,name),'must remain');
  const folder='moodle-calendar-2026-09-01T07-00-00-000Z-abcdef01.sqlite.enc';mkdirSync(join(backups,folder));
  pruneEncryptedBackups(path,2);
  for(const name of names.slice(0,2))assert.equal(existsSync(join(backups,name)),false);
  for(const name of [...names.slice(2),...unrelated,folder])assert.equal(existsSync(join(backups,name)),true);
  for(const count of [0,-1,1.5,NaN,Infinity])assert.throws(()=>pruneEncryptedBackups(path,count));
  assertClean(directory);
});

test('backup creation and retention refuse a linked backup directory',async t=>{
  const {directory,path}=fixture(t),outside=join(directory,'outside');mkdirSync(outside);
  const marker=join(outside,'moodle-calendar-2026-10-01T07-00-00-000Z-abcdef01.sqlite.enc');writeFileSync(marker,'do not alter');
  const linked=join(directory,'backups');
  symlinkSync(outside,linked,process.platform==='win32'?'junction':'dir');
  await assert.rejects(createEncryptedBackup(path,key),/real directory/);
  assert.throws(()=>pruneEncryptedBackups(path,1),/real directory/);
  await assert.rejects(migratePlaintextBackups(path,key),/real directory/);
  assert.throws(()=>cleanupStaleBackupStages(path),/real directory/);
  assert.equal(readFileSync(marker,'utf8'),'do not alter');assert.deepEqual(readdirSync(outside),[marker.split(/[\\/]/).at(-1)]);
});

test('legacy migration encrypts and verifies a complete snapshot before removing plaintext',async t=>{
  const {directory,path,store}=fixture(t),legacy=legacyBackup(path,directory),original=readFileSync(legacy);
  const result=await migratePlaintextBackups(path,key);
  assert.deepEqual(result,{migrated:1,alreadyEncrypted:0,skipped:0,stagingRemoved:0});
  assert.equal(existsSync(legacy),false);assert.equal(existsSync(legacy+'.enc'),true);
  assert.equal(await verifyEncryptedBackup(legacy+'.enc',key),createHash('sha256').update(original).digest('hex'));
  const restored=join(directory,'legacy-restored.sqlite');await restoreEncryptedBackup(legacy+'.enc',restored,key);
  assert.equal(snapshotValue(restored),'preserved');assert.equal(store.getMeta('migration-test'),'preserved');
  assert.deepEqual(await migratePlaintextBackups(path,key),{migrated:0,alreadyEncrypted:0,skipped:0,stagingRemoved:0});
  assertClean(join(directory,'backups'));
});

test('legacy migration authenticates an existing matching encrypted replacement without overwriting it',async t=>{
  const {directory,path}=fixture(t),legacy=legacyBackup(path,directory);
  await encryptBackupFile(legacy,legacy+'.enc',key);const originalEncrypted=readFileSync(legacy+'.enc');
  const result=await migratePlaintextBackups(path,key);
  assert.equal(result.alreadyEncrypted,1);assert.equal(result.migrated,0);assert.equal(existsSync(legacy),false);
  assert.deepEqual(readFileSync(legacy+'.enc'),originalEncrypted);assertClean(join(directory,'backups'));
});

test('wrong-key, tampered or mismatched existing replacements always preserve the original legacy file',async t=>{
  const {directory,path}=fixture(t),legacy=legacyBackup(path,directory),original=readFileSync(legacy);
  await encryptBackupFile(legacy,legacy+'.enc',key);
  await assert.rejects(migratePlaintextBackups(path,randomBytes(32).toString('base64')));
  assert.deepEqual(readFileSync(legacy),original);
  const valid=readFileSync(legacy+'.enc'),tampered=Buffer.from(valid);tampered[tampered.length-1]^=1;
  writeFileSync(legacy+'.enc',tampered);await assert.rejects(migratePlaintextBackups(path,key));assert.deepEqual(readFileSync(legacy),original);
  rmSync(legacy+'.enc');
  const different=join(directory,'different.sqlite');writeFileSync(different,'authenticated but different');
  await encryptBackupFile(different,legacy+'.enc',key);
  await assert.rejects(migratePlaintextBackups(path,key),/verification mismatch/);
  assert.deepEqual(readFileSync(legacy),original);assertClean(join(directory,'backups'));
});

test('legacy migration refuses corrupt SQLite and unresolved journals without deleting source data',async t=>{
  const {directory,path}=fixture(t),legacy=legacyBackup(path,directory),original=readFileSync(legacy);
  writeFileSync(legacy+'-wal','uncheckpointed data');
  await assert.rejects(migratePlaintextBackups(path,key),/unresolved SQLite/);
  assert.deepEqual(readFileSync(legacy),original);assert.equal(readFileSync(legacy+'-wal','utf8'),'uncheckpointed data');
  assert.equal(existsSync(legacy+'.enc'),false);rmSync(legacy+'-wal');
  writeFileSync(legacy,'corrupt backup');await assert.rejects(migratePlaintextBackups(path,key));
  assert.equal(readFileSync(legacy,'utf8'),'corrupt backup');assert.equal(existsSync(legacy+'.enc'),false);
  assertClean(join(directory,'backups'));
});

test('legacy migration touches only directly contained, exactly named regular files',async t=>{
  const {directory,path}=fixture(t),legacy=legacyBackup(path,directory),backups=join(directory,'backups');
  const unrelated=['another.sqlite','moodle-calendar-invalid-abcdef01.sqlite','moodle-calendar-2026-02-31T07-00-00-000Z-abcdef01.sqlite'];
  for(const name of unrelated)writeFileSync(join(backups,name),'must remain');
  const nested=join(backups,'nested');mkdirSync(nested);const nestedFile=join(nested,'moodle-calendar-2026-10-01T07-00-00-000Z-11111111.sqlite');writeFileSync(nestedFile,'must remain');
  const linkedName=join(backups,'moodle-calendar-2026-10-01T07-00-00-000Z-22222222.sqlite');
  symlinkSync(nested,linkedName,process.platform==='win32'?'junction':'dir');
  const result=await migratePlaintextBackups(path,key);
  assert.equal(result.migrated,1);assert.equal(result.skipped,1);assert.equal(existsSync(legacy),false);
  for(const name of unrelated)assert.equal(readFileSync(join(backups,name),'utf8'),'must remain');
  assert.equal(readFileSync(nestedFile,'utf8'),'must remain');assert.equal(existsSync(linkedName),true);
});

test('stale staging cleanup removes only known old direct files and preserves active groups and unrelated paths',async t=>{
  const {directory,path}=fixture(t),backups=join(directory,'backups');mkdirSync(backups);
  const now=Date.now(),old=new Date(now-25*60*60*1000),fresh=new Date(now-23*60*60*1000);
  const stem='.pending-moodle-calendar-2026-10-01T07-00-00-000Z-abcdef01.sqlite';
  const encrypted=stem+'.enc-12345678-1234-1234-1234-123456789abc';
  const obsolete=[stem,stem+'-wal',stem+'-shm',encrypted];
  for(const name of obsolete){writeFileSync(join(backups,name),'old private staging data');utimesSync(join(backups,name),old,old);}
  const recent='.pending-moodle-calendar-2026-10-02T07-00-00-000Z-abcdef01.sqlite';
  writeFileSync(join(backups,recent),'recent');utimesSync(join(backups,recent),fresh,fresh);
  const active='.pending-moodle-calendar-2026-10-03T07-00-00-000Z-abcdef01.sqlite';
  writeFileSync(join(backups,active),'old snapshot, active companion');utimesSync(join(backups,active),old,old);writeFileSync(join(backups,active+'-wal'),'fresh companion');
  const unrelated=['.pending-do-not-delete','.pending-moodle-calendar-invalid-abcdef01.sqlite','.pending-moodle-calendar-2026-10-01T25-00-00-000Z-abcdef01.sqlite','moodle-calendar-2026-10-01T07-00-00-000Z-abcdef01.sqlite.enc'];
  for(const name of unrelated){writeFileSync(join(backups,name),'unrelated');utimesSync(join(backups,name),old,old);}
  const nested=join(backups,'nested');mkdirSync(nested);writeFileSync(join(nested,stem),'nested');utimesSync(join(nested,stem),old,old);
  const linked='.pending-moodle-calendar-2026-10-04T07-00-00-000Z-abcdef01.sqlite';symlinkSync(nested,join(backups,linked),process.platform==='win32'?'junction':'dir');
  assert.equal(cleanupStaleBackupStages(path,now),obsolete.length);
  for(const name of obsolete)assert.equal(existsSync(join(backups,name)),false);
  for(const name of [recent,active,active+'-wal',...unrelated,linked])assert.equal(existsSync(join(backups,name)),true);
  assert.equal(readFileSync(join(nested,stem),'utf8'),'nested');
  assert.throws(()=>cleanupStaleBackupStages(path,NaN));
});

test('regular backup creation clears stale owned stages automatically',async t=>{
  const {directory,path}=fixture(t),backups=join(directory,'backups');mkdirSync(backups);
  const stale=join(backups,'.pending-moodle-calendar-2026-10-01T07-00-00-000Z-abcdef01.sqlite');writeFileSync(stale,'old plaintext');
  const old=new Date(Date.now()-25*60*60*1000);utimesSync(stale,old,old);
  await createEncryptedBackup(path,key);assert.equal(existsSync(stale),false);assertClean(backups);
});

test('legacy migration command reports only aggregate progress without exposing its key',t=>{
  const {directory,path}=fixture(t);legacyBackup(path,directory);
  const result=spawnSync(process.execPath,['scripts/secure-legacy-backups.mjs'],{encoding:'utf8',env:{...process.env,DATABASE_PATH:path,ENCRYPTION_KEY:key}});
  assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);
  assert.deepEqual(report,{legacyBackupsSecured:true,migrated:1,alreadyEncrypted:0,skipped:0,stagingRemoved:0});
  assert.equal(result.stdout.includes(key),false);assert.equal(result.stderr.includes(key),false);
  assertClean(join(directory,'backups'));
});
