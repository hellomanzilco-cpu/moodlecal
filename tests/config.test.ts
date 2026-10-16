import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.ts';

test('Railway public domain configures reachable calendar URLs and public binding',()=>{
  const config=loadConfig({ENCRYPTION_KEY:randomBytes(32).toString('base64'),RAILWAY_PUBLIC_DOMAIN:'moodle-calendar.up.railway.app',PORT:'8080'});
  assert.equal(config.publicUrl,'https://moodle-calendar.up.railway.app');
  assert.equal(config.host,'0.0.0.0');
  assert.equal(config.port,8080);
});

test('explicit settings override Railway defaults and private-only services bind publicly',()=>{
  const key=randomBytes(32).toString('base64');
  const config=loadConfig({ENCRYPTION_KEY:key,RAILWAY_ENVIRONMENT_ID:'environment',RAILWAY_PUBLIC_DOMAIN:'default.up.railway.app',PUBLIC_URL:'https://calendar.example.com/',HOST:'::'});
  assert.equal(config.publicUrl,'https://calendar.example.com');
  assert.equal(config.host,'::');
  assert.equal(loadConfig({ENCRYPTION_KEY:key,RAILWAY_ENVIRONMENT_ID:'environment'}).host,'0.0.0.0');
});
