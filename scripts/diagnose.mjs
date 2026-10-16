import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);

export async function diagnose(base = process.env.MOODLE_URL || 'https://moodle.uwed.uz', request = fetch) {
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('MOODLE_URL must be an HTTPS site URL without credentials, query parameters, or a fragment.');
  }
  const endpoint = `${url.href.replace(/\/$/, '')}/lib/ajax/service.php?info=tool_mobile_get_public_config`;
  const response = await request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ index: 0, methodname: 'tool_mobile_get_public_config', args: {} }]),
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Public configuration request returned HTTP ${response.status}.`);
  const result = await response.json();
  const config = Array.isArray(result) && !result[0]?.error ? result[0]?.data : null;
  if (!config || typeof config !== 'object') throw new Error('Moodle did not return public mobile configuration.');
  const enabled = value => value === true || value === 1 || value === '1';
  return {
    webServices: enabled(config.enablewebservices),
    mobileService: enabled(config.enablemobilewebservice),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await diagnose();
    console.log(`Public Moodle configuration: web services ${result.webServices ? 'enabled' : 'disabled or not advertised'}; mobile service ${result.mobileService ? 'enabled' : 'disabled or not advertised'}.`);
    console.log('This anonymous check does not verify student login, token access, or permission to read any courses.');
    if (!result.webServices || !result.mobileService) process.exitCode = 1;
  } catch (error) {
    console.error('Moodle public configuration check failed. Check MOODLE_URL, network access, and site availability; no credentials were sent.');
    const code=error?.cause?.code;
    if (typeof code==='string' && /^[A-Z0-9_]+$/.test(code)) console.error(`Network error code: ${code}`);
    process.exitCode = 1;
  }
}
