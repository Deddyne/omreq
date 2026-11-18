// Count new TCP connections the server sees during c=N load, per engine.
import { execSync, spawn } from 'node:child_process';

const SCRATCH = process.env.WREQ_JS_DIR ?? new URL('.', import.meta.url).pathname;
const api = await import(new URL('../../packages/omreq/dist/index.mjs', import.meta.url).href);
const wreq = await import(`${SCRATCH}/wreqjs-install/node_modules/wreq-js/dist/wreq-js.js`);
const srv = spawn('node', [new URL('./server.mjs', import.meta.url).pathname], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const info = await new Promise((r) => srv.stdout.once('data', (d) => r(JSON.parse(d))));
const conns = async () => (await (await fetch(`${info.plain}/stats`)).json()).connections;
const tw = () =>
  Number(execSync('netstat -an -p tcp | grep -c TIME_WAIT || true').toString().trim());
const conc = Number(process.argv[2] ?? 20);
const om = api.createClient();
const wq = await wreq.createSession();
const engines = {
  omreq: async (u) => {
    const r = await om.get(u);
    await r.bytes();
    await r.dispose();
  },
  'wreq-js': async (u) => {
    await (await wq.fetch(u)).arrayBuffer();
  },
};
for (const [name, fn] of Object.entries(engines)) {
  const c0 = await conns();
  const tw0 = tw();
  let n = 0;
  let err = null;
  const end = Date.now() + 2000;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (Date.now() < end && !err) {
        try {
          await fn(`${info.plain}/small`);
          n++;
        } catch (e) {
          err = `${e.code}: ${e.message}`;
        }
      }
    }),
  );
  const c1 = await conns();
  console.log(
    JSON.stringify({
      engine: name,
      concurrency: conc,
      requests: n,
      newConnections: c1 - c0 - 1,
      connectionsPer1kRequests: Math.round(((c1 - c0 - 1) / n) * 1000),
      timeWaitBefore: tw0,
      timeWaitAfter: tw(),
      firstError: err,
    }),
  );
}
await om.close();
await wq.close();
srv.kill();
process.exit(0);
