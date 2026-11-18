import { spawn } from 'node:child_process';
export async function runProfileClient(
  runtime,
  { profile, ca, url, paths = ['/probe', '/probe?reuse=1'] },
) {
  const entry = new URL('../packages/omreq/dist/index.mjs', import.meta.url).href;
  const code = `import {createClient,getRuntimeInfo} from ${JSON.stringify(entry)};
const c=createClient(${JSON.stringify({ profile, ca, trustStore: 'chromium' })});const versions=[];const lengths=[];
try{for(const path of ${JSON.stringify(paths)}){const r=await c.get(${JSON.stringify(url)}+path);versions.push(r.httpVersion);lengths.push((await r.bytes()).length);}}finally{await c.close();}
console.log(JSON.stringify({runtime:getRuntimeInfo(),info:c.getInfo(),versions,lengths,stats:c.getStats()}));`;
  return await new Promise((resolve, reject) => {
    const executable = runtime === 'bun' ? 'bun' : process.execPath;
    const args = runtime === 'bun' ? ['--eval', code] : ['--input-type=module', '--eval', code];
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('Profile client deadline'));
    }, 15000);
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (status) => {
      clearTimeout(timer);
      if (status !== 0) {
        reject(Error(stderr));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}
