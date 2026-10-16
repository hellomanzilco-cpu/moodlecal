import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {loadConfig} from '../src/config.ts';
import {Store} from '../src/store.ts';
if(existsSync('.env'))loadEnvFile('.env');
const store=new Store(loadConfig().databasePath);try{console.log(JSON.stringify(store.statistics(),null,2));}finally{store.close();}
