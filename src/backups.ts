import {backup,DatabaseSync} from 'node:sqlite';
import {createReadStream,createWriteStream,existsSync,mkdirSync,openSync,closeSync,readSync,writeSync,fstatSync,fsyncSync,lstatSync,statSync,unlinkSync,readdirSync,linkSync} from 'node:fs';
import {dirname,join,basename,resolve} from 'node:path';
import {randomBytes,randomUUID,hkdfSync,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import type {CipherGCM,DecipherGCM} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform,Writable} from 'node:stream';

const MAGIC=Buffer.from('MCAL-BACKUP-1\n'),HEADER=MAGIC.length+16+12;
const BACKUP_STEM='moodle-calendar-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-[a-f\\d]{8}';
const BACKUP_NAME=new RegExp(`^${BACKUP_STEM}\\.sqlite\\.enc$`);
const PLAINTEXT_BACKUP_NAME=new RegExp(`^${BACKUP_STEM}\\.sqlite$`);
const UUID='[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}';
const STAGING_NAME=new RegExp(`^\\.pending-${BACKUP_STEM}\\.sqlite(?:\\.enc-${UUID})?(?:-(?:wal|shm|journal))?$`);
const STALE_STAGE_MS=24*60*60*1000;

function generatedTimestamp(name:string):boolean{
  const match=/moodle-calendar-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(name);
  if(!match)return false;
  const iso=`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`,time=new Date(iso);
  return Number.isFinite(time.getTime())&&time.toISOString()===iso;
}

function keyFor(value:string,salt:Buffer):Buffer{
  const root=Buffer.from(value,'base64');
  try{
    if(root.length!==32)throw new Error('A valid backup encryption key is required.');
    return Buffer.from(hkdfSync('sha256',root,salt,'moodle-calendar-database-backup-v1',32));
  }finally{root.fill(0);}
}
function regularFile(path:string):void{
  const info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink())throw new Error('A regular file is required.');
}
function backupDirectory(databasePath:string,create=false):string|null{
  const directory=join(dirname(resolve(databasePath)),'backups');
  let info:ReturnType<typeof lstatSync>;
  try{info=lstatSync(directory);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    if(!create)return null;
    mkdirSync(directory,{recursive:true,mode:0o700});info=lstatSync(directory);
  }
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Backup directory must be a real directory.');
  return directory;
}
async function fileHash(path:string):Promise<string>{
  regularFile(path);
  const hash=createHash('sha256');
  await pipeline(createReadStream(path),new Writable({write(chunk,_encoding,done){hash.update(chunk);done();}}));
  return hash.digest('hex');
}
function exactRead(descriptor:number,buffer:Buffer,position:number):void{
  let offset=0;
  while(offset<buffer.length){
    const bytes=readSync(descriptor,buffer,offset,buffer.length-offset,position+offset);
    if(!bytes)throw new Error('Truncated encrypted backup.');
    offset+=bytes;
  }
}
function exactWrite(descriptor:number,buffer:Buffer):void{
  let offset=0;
  while(offset<buffer.length){
    const bytes=writeSync(descriptor,buffer,offset,buffer.length-offset);
    if(!bytes)throw new Error('Backup storage write failed.');
    offset+=bytes;
  }
}
function decoder(path:string,encryptionKey:string){
  regularFile(path);
  const descriptor=openSync(path,'r');
  try{
    const size=fstatSync(descriptor).size;
    if(size<HEADER+16)throw new Error('Invalid encrypted backup.');
    const header=Buffer.alloc(HEADER),tag=Buffer.alloc(16);
    exactRead(descriptor,header,0);exactRead(descriptor,tag,size-16);
    if(!header.subarray(0,MAGIC.length).equals(MAGIC))throw new Error('Invalid encrypted backup.');
    const key=keyFor(encryptionKey,header.subarray(MAGIC.length,MAGIC.length+16));
    let decipher:DecipherGCM;
    try{decipher=createDecipheriv('aes-256-gcm',key,header.subarray(MAGIC.length+16));}finally{key.fill(0);}
    decipher.setAAD(header);decipher.setAuthTag(tag);
    return {stream:createReadStream('',{fd:descriptor,autoClose:true,start:HEADER,end:size-17}),decipher};
  }catch(error){closeSync(descriptor);throw error;}
}
function temporaryPath(target:string):string{
  return join(dirname(resolve(target)),`.pending-${basename(target)}-${randomUUID()}`);
}
function discard(path:string):void{
  // Only randomly named files created by this operation are ever passed here.
  if(existsSync(path))unlinkSync(path);
}
function discardSQLite(path:string):void{
  // Opening a WAL-mode snapshot read-only can still create SQLite companions.
  // All these paths belong to the same random private staging file.
  for(const suffix of ['','-wal','-shm','-journal'])discard(path+suffix);
}
function publish(temporary:string,target:string):void{
  // A hard link publishes the already verified file atomically and fails if any
  // file (including a symlink) already occupies the destination. rename() could
  // overwrite a live database on POSIX, so it must not be used for restoration.
  linkSync(temporary,target);
}
export async function verifyEncryptedBackup(path:string,encryptionKey:string):Promise<string>{
  const {stream,decipher}=decoder(path,encryptionKey),hash=createHash('sha256');
  await pipeline(stream,decipher,new Writable({write(chunk,_encoding,done){hash.update(chunk);done();}}));
  return hash.digest('hex');
}
export async function encryptBackupFile(source:string,target:string,encryptionKey:string):Promise<void>{
  regularFile(source);
  const salt=randomBytes(16),iv=randomBytes(12),header=Buffer.concat([MAGIC,salt,iv]),key=keyFor(encryptionKey,salt);
  let cipher:CipherGCM;
  try{cipher=createCipheriv('aes-256-gcm',key,iv);}finally{key.fill(0);}
  cipher.setAAD(header);
  if(existsSync(target))throw new Error('Backup target already exists.');
  const temporary=temporaryPath(target),descriptor=openSync(temporary,'wx',0o600);
  let closed=false;
  try{
    exactWrite(descriptor,header);
    const expected=createHash('sha256');
    const hashing=new Transform({transform(chunk,_encoding,done){expected.update(chunk);done(null,chunk);}});
    await pipeline(createReadStream(source),hashing,cipher,createWriteStream('',{fd:descriptor,autoClose:false}));
    exactWrite(descriptor,cipher.getAuthTag());fsyncSync(descriptor);closeSync(descriptor);closed=true;
    if(await verifyEncryptedBackup(temporary,encryptionKey)!==expected.digest('hex'))throw new Error('Encrypted backup verification failed.');
    publish(temporary,target);
  }finally{
    if(!closed)try{closeSync(descriptor);}catch{}
    discard(temporary);
  }
}
export async function restoreEncryptedBackup(source:string,target:string,encryptionKey:string):Promise<void>{
  if(existsSync(target))throw new Error('Restore target already exists.');
  // Validate metadata before creating even the private plaintext staging file.
  const {stream,decipher}=decoder(source,encryptionKey);
  const temporary=temporaryPath(target);
  let descriptor:number|undefined,database:DatabaseSync|undefined;
  try{
    descriptor=openSync(temporary,'wx',0o600);
    await pipeline(stream,decipher,createWriteStream('',{fd:descriptor,autoClose:false}));
    fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;
    database=new DatabaseSync(temporary,{readOnly:true});
    if(Object.values(database.prepare('PRAGMA integrity_check').get()||{})[0]!=='ok')throw new Error('Restored database integrity check failed.');
    database.close();database=undefined;
    publish(temporary,target);
  }finally{
    stream.destroy();decipher.destroy();database?.close();
    if(descriptor!==undefined)try{closeSync(descriptor);}catch{}
    discardSQLite(temporary);
  }
}
export async function createEncryptedBackup(databasePath:string,encryptionKey:string){
  // Reject a bad key before making a plaintext SQLite snapshot.
  keyFor(encryptionKey,Buffer.alloc(16)).fill(0);
  const sourcePath=resolve(databasePath);regularFile(sourcePath);
  const directory=backupDirectory(sourcePath,true)!;
  cleanupStaleBackupStages(sourcePath);
  const name=`moodle-calendar-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.sqlite`;
  const temporary=join(directory,'.pending-'+name),target=join(directory,name+'.enc');
  let source:DatabaseSync|undefined,verification:DatabaseSync|undefined;
  try{
    closeSync(openSync(temporary,'wx',0o600));
    source=new DatabaseSync(sourcePath,{readOnly:true});await backup(source,temporary);source.close();source=undefined;
    verification=new DatabaseSync(temporary,{readOnly:true});
    if(Object.values(verification.prepare('PRAGMA integrity_check').get()||{})[0]!=='ok')throw new Error('Backup integrity check failed.');
    verification.close();verification=undefined;
    await encryptBackupFile(temporary,target,encryptionKey);
    return {backup:target,bytes:statSync(target).size,verified:true,encrypted:true};
  }finally{verification?.close();source?.close();discardSQLite(temporary);}
}
export function pruneEncryptedBackups(databasePath:string,keep=14):void{
  if(!Number.isSafeInteger(keep)||keep<1)throw new Error('Keep at least one encrypted backup.');
  const directory=backupDirectory(databasePath);if(!directory)return;
  const paths=readdirSync(directory).filter(name=>BACKUP_NAME.test(name)&&generatedTimestamp(name)&&lstatSync(join(directory,name)).isFile()).sort().reverse();
  for(const name of paths.slice(keep)){
    const target=join(directory,basename(name));
    if(dirname(target)!==directory)throw new Error('Invalid backup path.');
    // Never follow a replaced file or symlink while deleting retained backups.
    const info=lstatSync(target);if(info.isFile()&&!info.isSymbolicLink())unlinkSync(target);
  }
}

export function cleanupStaleBackupStages(databasePath:string,now=Date.now()):number{
  if(!Number.isFinite(now))throw new Error('Invalid cleanup time.');
  const directory=backupDirectory(databasePath);if(!directory)return 0;
  let removed=0;
  for(const name of readdirSync(directory)){
    if(!STAGING_NAME.test(name)||!generatedTimestamp(name))continue;
    const target=join(directory,name),info=lstatSync(target);
    if(!info.isFile()||info.isSymbolicLink()||now-info.mtimeMs<=STALE_STAGE_MS)continue;
    const root=target.replace(/-(?:wal|shm|journal)$/,'');
    // A recently touched SQLite companion means the snapshot may still be in use.
    const active=['','-wal','-shm','-journal'].some(suffix=>{
      try{const companion=lstatSync(root+suffix);return companion.isSymbolicLink()||!companion.isFile()||now-companion.mtimeMs<=STALE_STAGE_MS;}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
    });
    if(active)continue;
    unlinkSync(target);removed++;
  }
  return removed;
}

export async function migratePlaintextBackups(databasePath:string,encryptionKey:string){
  keyFor(encryptionKey,Buffer.alloc(16)).fill(0);
  const directory=backupDirectory(databasePath);
  if(!directory)return {migrated:0,alreadyEncrypted:0,skipped:0,stagingRemoved:0};
  const stagingRemoved=cleanupStaleBackupStages(databasePath);
  let migrated=0,alreadyEncrypted=0,skipped=0;
  for(const name of readdirSync(directory).sort()){
    if(!PLAINTEXT_BACKUP_NAME.test(name)||!generatedTimestamp(name))continue;
    const sourcePath=join(directory,name),info=lstatSync(sourcePath);
    if(!info.isFile()||info.isSymbolicLink()){skipped++;continue;}
    const target=sourcePath+'.enc',companions=new Map<string,boolean>();
    for(const suffix of ['-wal','-shm','-journal']){
      const path=sourcePath+suffix;
      let existing:ReturnType<typeof lstatSync>|undefined;
      try{existing=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      companions.set(path,Boolean(existing));
      if(existing&&(existing.isSymbolicLink()||!existing.isFile()||((suffix==='-wal'||suffix==='-journal')&&existing.size>0)))throw new Error('Legacy backup has unresolved SQLite companions; plaintext was preserved.');
    }
    let database:DatabaseSync|undefined;
    try{
      database=new DatabaseSync(sourcePath,{readOnly:true});
      if(Object.values(database.prepare('PRAGMA integrity_check').get()||{})[0]!=='ok')throw new Error('Legacy backup integrity check failed.');
      database.close();database=undefined;
      const originalHash=await fileHash(sourcePath),existed=existsSync(target);
      if(!existed)await encryptBackupFile(sourcePath,target,encryptionKey);
      const encryptedHash=await verifyEncryptedBackup(target,encryptionKey);
      // Never discard the plaintext when the replacement contains different data,
      // or when another process has modified/replaced the source during migration.
      const current=lstatSync(sourcePath);
      if(!current.isFile()||current.isSymbolicLink()||current.dev!==info.dev||current.ino!==info.ino||current.size!==info.size||encryptedHash!==originalHash||await fileHash(sourcePath)!==originalHash)throw new Error('Legacy backup verification mismatch; plaintext was preserved.');
      for(const suffix of ['-wal','-journal']){
        try{
          const companion=lstatSync(sourcePath+suffix);
          if(!companion.isFile()||companion.isSymbolicLink()||companion.size>0)throw new Error('Legacy backup has unresolved SQLite companions; plaintext was preserved.');
        }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
      unlinkSync(sourcePath);
      if(existed)alreadyEncrypted++;else migrated++;
    }finally{
      database?.close();
      // Read-only access to a WAL-mode snapshot may create companions. Remove
      // only those created by this operation; pre-existing files remain untouched.
      const unresolved=['-wal','-journal'].some(suffix=>{
        try{const companion=lstatSync(sourcePath+suffix);return !companion.isFile()||companion.isSymbolicLink()||companion.size>0;}
        catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
      });
      if(!unresolved)for(const [path,existed] of companions)if(!existed&&existsSync(path)){
        const companion=lstatSync(path);if(companion.isFile()&&!companion.isSymbolicLink())unlinkSync(path);
      }
    }
  }
  return {migrated,alreadyEncrypted,skipped,stagingRemoved};
}
