import { loadEnvFile } from 'node:process';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { Vault } from '../src/security.ts';
import { MoodleClient } from '../src/moodle.ts';
import { SyncService } from '../src/sync.ts';
let store;
try {
  loadEnvFile('.env');const config=loadConfig();store=new Store(config.databasePath);
  const service=new SyncService(store,new Vault(config.encryptionKey),new MoodleClient(config.moodleUrl),{async send(){throw new Error('Use the running bot to deliver notices.');}},config.publicUrl,config.pollSeconds);
  let refreshed=0,failed=0;
  for(const row of store.db.prepare('SELECT id FROM students WHERE moodleCipher IS NOT NULL').all()) {
    try {await service.sync(Number(row.id));refreshed++;}catch{failed++;}
  }
  console.log(JSON.stringify({refreshed,failed,periodicChecks:false}));if(failed)process.exitCode=1;
}catch{console.error('One-off refresh could not complete. Check configuration and connectivity.');process.exitCode=1;}
finally{store?.close();}
