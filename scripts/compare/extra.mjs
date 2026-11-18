// Supplemental audit benchmarks: cold-start breakdown, fetch(undici) comparison, per-client cost.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const ENTRY = `${ROOT}/packages/omreq/dist/index.mjs`;
const NATIVE = `${ROOT}/native/omreq-darwin-arm64/omreq.node`;
const runtime = process.versions.bun ? 'bun' : 'node';
const N = Number(process.env.COLD_N ?? 30);

const q = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const at = (f) => s[Math.max(0, Math.ceil(f * s.length) - 1)];
  const r = (n) => Math.round(n * 100) / 100;
  return {
    n: s.length,
    min: r(s[0]),
    p50: r(at(0.5)),
    p95: r(at(0.95)),
    max: r(s.at(-1)),
    mean: r(s.reduce((a, b) => a + b, 0) / s.length),
  };
};

// ---------- child modes ----------
const mode = process.argv[2];
if (mode === '--child') {
  const kind = process.argv[3];
  const url = process.argv[4];
  const t0 = performance.now();
  const out = { kind };
  const rss0 = process.memoryUsage().rss;
  if (kind === 'empty') {
  } else if (kind === 'import-js') {
    await import(ENTRY);
    out.importMs = performance.now() - t0;
  } else if (kind === 'dlopen') {
    const m = { exports: {} };
    process.dlopen(m, NATIVE);
    out.dlopenMs = performance.now() - t0;
    const t1 = performance.now();
    m.exports.buildInfo();
    out.buildInfoMs = performance.now() - t1;
  } else if (kind === 'omreq-first') {
    const api = await import(ENTRY);
    out.importMs = performance.now() - t0;
    let t = performance.now();
    const client = api.createClient();
    out.createMs = performance.now() - t;
    t = performance.now();
    const res = await client.get(url);
    await res.text();
    await res.dispose();
    out.firstRequestMs = performance.now() - t; // includes lazy native load + runtime init
    t = performance.now();
    const res2 = await client.get(url);
    await res2.text();
    await res2.dispose();
    out.secondRequestMs = performance.now() - t;
    t = performance.now();
    await client.close();
    out.closeMs = performance.now() - t;
  } else if (kind === 'fetch-first') {
    let t = performance.now();
    const res = await fetch(url);
    await res.text();
    out.firstRequestMs = performance.now() - t;
    t = performance.now();
    const res2 = await fetch(url);
    await res2.text();
    out.secondRequestMs = performance.now() - t;
  } else if (kind === 'http-first') {
    const agent = new http.Agent({ keepAlive: true });
    const get = () =>
      new Promise((resolve, reject) => {
        http
          .get(url, { agent }, (r) => {
            r.resume();
            r.on('end', resolve);
          })
          .on('error', reject);
      });
    let t = performance.now();
    await get();
    out.firstRequestMs = performance.now() - t;
    t = performance.now();
    await get();
    out.secondRequestMs = performance.now() - t;
    agent.destroy();
  }
  out.totalInProcessMs = performance.now() - t0;
  out.rssDeltaMiB = (process.memoryUsage().rss - rss0) / 1048576;
  out.rssMiB = process.memoryUsage().rss / 1048576;
  console.log(JSON.stringify(out));
  process.exit(0);
}

function child(kind, url) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const c = spawn(process.execPath, [process.argv[1], '--child', kind, url ?? ''], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', (code) => {
      if (code !== 0) return reject(Error(`${kind} exited ${code}`));
      resolve({ ...JSON.parse(out), wallMs: performance.now() - started });
    });
  });
}

// ---------- parent ----------
const server = http.createServer({ keepAlive: true }, (req, res) => {
  const m = /^\/bytes\/(\d+)$/.exec(req.url);
  const n = m ? Number(m[1]) : 1024;
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': n });
  res.end(Buffer.alloc(n, 0x61));
});
server.keepAliveTimeout = 60000;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const report = {
  runtime,
  version: process.versions.bun ?? process.versions.node,
  N,
  cold: {},
  warm: {},
  perClient: {},
};

try {
  // Cold: interleave kinds each repetition to spread system noise.
  const kinds = ['empty', 'import-js', 'dlopen', 'omreq-first', 'fetch-first', 'http-first'];
  const samples = Object.fromEntries(kinds.map((k) => [k, []]));
  for (let i = 0; i < N; i++)
    for (const k of kinds) samples[k].push(await child(k, `${base}/bytes/1024`));
  for (const k of kinds) {
    const fields = Object.keys(samples[k][0]).filter((f) => typeof samples[k][0][f] === 'number');
    report.cold[k] = Object.fromEntries(fields.map((f) => [f, q(samples[k].map((s) => s[f]))]));
  }

  // Warm: omreq vs fetch vs node:http, serial and c=8.
  const api = await import(ENTRY);
  const client = api.createClient({ maxConnectionsPerOrigin: 8 });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  const engines = {
    omreq: async (u) => {
      const r = await client.get(u);
      try {
        return (await r.bytes()).length;
      } finally {
        await r.dispose();
      }
    },
    'omreq-stream': async (u) => {
      const r = await client.get(u);
      let n = 0;
      try {
        for await (const c of r.body) n += c.length;
      } finally {
        await r.dispose();
      }
      return n;
    },
    fetch: async (u) => (await (await fetch(u)).arrayBuffer()).byteLength,
    'node:http': (u) =>
      new Promise((resolve, reject) => {
        http
          .get(u, { agent }, (r) => {
            let n = 0;
            r.on('data', (c) => (n += c.length));
            r.on('end', () => resolve(n));
          })
          .on('error', reject);
      }),
  };
  const ITER = Number(process.env.WARM_ITER ?? 2000);
  for (const size of [1024, 65536, 1048576]) {
    for (const conc of [1, 8]) {
      for (const [name, fn] of Object.entries(engines)) {
        const url = `${base}/bytes/${size}`;
        const iters = size >= 1048576 ? Math.ceil(ITER / 10) : ITER;
        for (let i = 0; i < 50; i++) await fn(url); // warmup
        const lat = [];
        let next = 0;
        const cpu0 = process.cpuUsage();
        const t0 = performance.now();
        await Promise.all(
          Array.from({ length: conc }, async () => {
            while (next++ < iters) {
              const s = performance.now();
              const n = await fn(url);
              if (n !== size) throw Error(`${name} got ${n}`);
              lat.push(performance.now() - s);
            }
          }),
        );
        const dur = performance.now() - t0;
        const cpu = process.cpuUsage(cpu0);
        report.warm[`${size}B c=${conc} ${name}`] = {
          rps: Math.round((iters * 1000) / dur),
          MiBps: Math.round(((size * iters) / 1048576 / (dur / 1000)) * 10) / 10,
          latencyMs: q(lat),
          cpuMsPerReq: Math.round(((cpu.user + cpu.system) / 1000 / iters) * 1000) / 1000,
        };
        console.error(
          `warm ${size} c=${conc} ${name}: ${report.warm[`${size}B c=${conc} ${name}`].rps} rps`,
        );
      }
    }
  }
  await client.close();
  agent.destroy();

  // Per-client cost: create + lazy init (cookies call) + first request on 50 clients.
  const rss0 = process.memoryUsage().rss;
  const clients = [];
  const tCreate = [];
  const tInit = [];
  const tFirst = [];
  for (let i = 0; i < 50; i++) {
    let t = performance.now();
    const c = api.createClient();
    tCreate.push(performance.now() - t);
    t = performance.now();
    await c.cookies.getCookies(base);
    tInit.push(performance.now() - t);
    t = performance.now();
    const r = await c.get(`${base}/bytes/1024`);
    await r.bytes();
    await r.dispose();
    tFirst.push(performance.now() - t);
    clients.push(c);
  }
  const rss1 = process.memoryUsage().rss;
  const tClose = [];
  for (const c of clients) {
    const t = performance.now();
    await c.close();
    tClose.push(performance.now() - t);
  }
  report.perClient = {
    createMs: q(tCreate),
    lazyInitMs: q(tInit),
    firstRequestMs: q(tFirst),
    closeMs: q(tClose),
    rssPerClientKiB: Math.round((rss1 - rss0) / 50 / 1024),
  };
} finally {
  server.closeAllConnections?.();
  server.close();
}
const out = process.env.OUT ?? `/dev/stdout`;
writeFileSync(out, JSON.stringify(report, null, 2));
