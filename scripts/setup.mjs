import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Exported to allow verification in an isolated temporary directory.
export function createEnvironment(targetDirectory = projectRoot) {
  const target = resolve(targetDirectory, '.env');
  const template = readFileSync(resolve(projectRoot, '.env.example'), 'utf8');
  const contents = template
    .replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`)
    .replace(/^MOODLE_EVENT_SECRET=.*$/m, `MOODLE_EVENT_SECRET=${randomBytes(32).toString('base64url')}`)
    .replace(/^WEBHOOK_SECRET=.*$/m, `WEBHOOK_SECRET=${randomBytes(32).toString('base64url')}`);
  if (existsSync(target) && readFileSync(target).length === 0) {
    writeFileSync(target, contents, { mode: 0o600 });
    return true;
  }
  try {
    writeFileSync(target, contents, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export function completeEnvironment(targetDirectory = projectRoot) {
  const target=resolve(targetDirectory,'.env');
  if(!existsSync(target) || readFileSync(target).length===0) return createEnvironment(targetDirectory);
  let contents=readFileSync(target,'utf8');
  const template=readFileSync(resolve(projectRoot,'.env.example'),'utf8')
    .replace(/^ENCRYPTION_KEY=.*$/m,`ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`)
    .replace(/^MOODLE_EVENT_SECRET=.*$/m,`MOODLE_EVENT_SECRET=${randomBytes(32).toString('base64url')}`)
    .replace(/^WEBHOOK_SECRET=.*$/m,`WEBHOOK_SECRET=${randomBytes(32).toString('base64url')}`);
  const known=new Set(contents.split(/\r?\n/).map(line=>/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1].toLowerCase()).filter(Boolean));
  if(known.has('bot_token')) known.add('telegram_bot_token');
  const additions=template.split(/\r?\n/).filter(line=>{
    const match=/^([A-Z_]+)=/.exec(line);
    return match && !known.has(match[1].toLowerCase());
  });
  if(!additions.length) return false;
  contents=contents.trimEnd()+'\n\n# Added missing application settings; existing credentials preserved.\n'+additions.join('\n')+'\n';
  writeFileSync(target,contents,{mode:0o600});
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const complete=process.argv.includes('--complete');
    const changed=complete ? completeEnvironment() : createEnvironment();
    console.log(complete && changed ? 'Added missing application settings; existing credentials were preserved.' : changed
      ? 'Created .env with fresh encryption and webhook keys. Set TELEGRAM_BOT_TOKEN and PUBLIC_URL before starting.'
      : '.env already exists; no settings or keys were changed.');
  } catch {
    console.error('Could not create .env. Check project-directory write permissions.');
    process.exitCode = 1;
  }
}
