import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.ts';
import {Vault} from '../src/security.ts';
import {ProfileSharingService} from '../src/profile-sharing.ts';
import {SyncService} from '../src/sync.ts';
import type {MoodleProfile,MoodleGateway} from '../src/types.ts';

function fixture(t:{after(fn:()=>void):void}){
  const store=new Store(':memory:');t.after(()=>store.close());const vault=new Vault(randomBytes(32).toString('base64'));
  const alice=store.ensureStudent(101,101),bob=store.ensureStudent(202,202);
  for(const student of [alice,bob])store.patchStudent(student.id,{moodleCipher:vault.seal('token-'+student.id,`moodle:${student.id}`)});
  const reads:number[]=[];
  const sharing=new ProfileSharingService(store,vault,async id=>{reads.push(id);return {firstName:id===alice.id?'Alice':'Bob',lastName:'Student',username:'user-'+id};},303,()=>1_800_000_000);
  return {store,vault,alice,bob,reads,sharing};
}

test('named profiles default to private and require explicit consent; owner views never fetch unconsented Moodle profiles',async t=>{
  const f=fixture(t);assert.equal(f.sharing.status(f.alice.id).enabled,false);
  assert.deepEqual(f.sharing.list(303).profiles,[]);assert.deepEqual(f.reads,[]);
  await assert.rejects(f.sharing.share(f.alice.id,false),/Explicit/);assert.deepEqual(f.reads,[]);
  assert.throws(()=>f.sharing.list(202),/Only the configured owner/);
  await f.sharing.share(f.alice.id,true);
  const page=f.sharing.list(303);assert.equal(page.total,1);assert.equal(page.registered,2);assert.deepEqual(f.reads,[f.alice.id]);assert.equal(page.profiles[0].firstName,'Alice');assert.equal(page.profiles[0].username,'user-'+f.alice.id);
  assert.equal(f.sharing.status(f.bob.id).enabled,false);
  const stored=JSON.stringify(f.store.db.prepare('SELECT * FROM profile_shares').all());assert.doesNotMatch(stored,/Alice|Student|user-/);
  assert.doesNotMatch(JSON.stringify(f.store.statistics()),/Alice|user-/);
  f.sharing.revoke(f.alice.id);assert.equal(f.sharing.list(303).total,0);assert.equal(f.sharing.status(f.alice.id).enabled,false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM profile_shares').get()!.count,0);
});

test('profile sharing is bound to connection, student and configured owner, and is removed by disconnect',async t=>{
  const f=fixture(t);await f.sharing.share(f.alice.id,true);
  const newOwner=new ProfileSharingService(f.store,f.vault,async()=>({firstName:'',lastName:'',username:''}),404);
  assert.equal(newOwner.status(f.alice.id).enabled,false);assert.equal(newOwner.list(404).total,0);
  f.store.patchStudent(f.alice.id,{moodleCipher:f.vault.seal('different-token',`moodle:${f.alice.id}`)});
  assert.equal(f.sharing.status(f.alice.id).enabled,false);assert.deepEqual(f.sharing.list(303).profiles,[]);
  f.store.deleteStudent(f.alice.id);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM profile_shares').get()!.count,0);
  const disabled=new ProfileSharingService(f.store,f.vault,async()=>({firstName:'',lastName:'',username:''}),null);
  assert.throws(()=>disabled.list(303),/Only the configured owner/);await assert.rejects(disabled.share(f.bob.id,true),/Explicit/);
});

test('revoke and disconnect during an in-flight profile read cannot recreate sharing consent',async t=>{
  const f=fixture(t);let resolve!:(value:MoodleProfile)=>void;
  const sharing=new ProfileSharingService(f.store,f.vault,()=>new Promise(r=>{resolve=r;}),303);
  const attempt=sharing.share(f.alice.id,true);sharing.revoke(f.alice.id);resolve({firstName:'Alice',lastName:'Student',username:'alice'});
  await assert.rejects(attempt,/preference changed/);assert.equal(sharing.status(f.alice.id).enabled,false);
  const other=sharing.share(f.bob.id,true);f.store.deleteStudent(f.bob.id);resolve({firstName:'Bob',lastName:'Student',username:'bob'});
  await assert.rejects(other,/preference changed/);assert.equal(sharing.list(303).total,0);
});

test('reconnect clears profile sharing even when the same Moodle token is reused',async t=>{
  const f=fixture(t);await f.sharing.share(f.alice.id,true);
  const moodle:MoodleGateway={async identify(){return {userId:1,name:'Alice Student',functions:[]};},async login(){return 'token-1';},async snapshot(){return {courses:[],items:[],warnings:[]};}};
  const service=new SyncService(f.store,f.vault,moodle,{async send(){}},'https://test.invalid',300,undefined,303);
  const link=new URL(service.connectLink(f.alice.id));await service.connect(new URLSearchParams(link.hash.slice(1)).get('token')!,'token-1');
  assert.equal(service.sharingStatus(f.alice.id).enabled,false);assert.equal(service.sharedProfiles(303).total,0);
});

test('shared profiles paginate six records at a time and reject invalid offsets',async t=>{
  const f=fixture(t);await f.sharing.share(f.alice.id,true);await f.sharing.share(f.bob.id,true);
  for(let index=0;index<6;index++){const student=f.store.ensureStudent(500+index,500+index);f.store.patchStudent(student.id,{moodleCipher:f.vault.seal('synthetic',`moodle:${student.id}`)});await f.sharing.share(student.id,true);}
  const first=f.sharing.list(303);assert.equal(first.total,8);assert.equal(first.profiles.length,6);
  const second=f.sharing.list(303,6);assert.equal(second.profiles.length,2);assert.equal(second.offset,6);
  assert.equal(f.sharing.list(303,999).offset,6);assert.throws(()=>f.sharing.list(303,-1),/Invalid/);
});
