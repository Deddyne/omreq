// omreq vs wreq-js 3.2.0 vs runtime fetch — wreq-js scenarios on one machine, server in a separate process.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const OMREQ = new URL('../../packages/omreq/dist/index.mjs', import.meta.url).href;
const SCRATCH = process.env.WREQ_JS_DIR ?? new URL('.', import.meta.url).pathname;
const WREQ = `${SCRATCH}/wreqjs-install/node_modules/wreq-js/dist/wreq-js.js`;
const runtime = process.versions.bun ? 'bun' : 'node';
const DURATION = Number(process.env.DURATION_MS ?? 1500);
const SAMPLES = Number(process.env.SAMPLES ?? 5);
const COLD_N = Number(process.env.COLD_N ?? 20);

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, s.length - 1));
  const t = [12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26][s.length - 2] ?? 2.0;
  const at = (f) => s[Math.max(0, Math.ceil(f * s.length) - 1)];
  const r = (n) => Math.round(n * 100) / 100;
  return {
    n: s.length,
    mean: r(mean),
    ci95pct: r(((t * sd) / Math.sqrt(s.length) / mean) * 100),
    p50: r(at(0.5)),
    p95: r(at(0.95)),
    p99: r(at(0.99)),
    min: r(s[0]),
    max: r(s.at(-1)),
  };
};

// ---------------- cold child ----------------
if (process.argv[2] === '--cold') {
  const [, , , engine, url, ca] = process.argv;
  const out = { engine };
  const t0 = performance.now();
  let t = t0;
  const lap = (k) => {
    const n = performance.now();
    out[k] = n - t;
    t = n;
  };
  if (engine === 'omreq') {
    const api = await import(OMREQ);
    lap('importMs');
    const c = api.createClient(url.startsWith('https') ? { ca } : {});
    lap('createMs');
    const r = await c.get(url);
    await r.bytes();
    await r.dispose();
    lap('firstRequestMs');
    out.totalMs = performance.now() - t0;
    await c.close();
  } else if (engine === 'wreq-js') {
    const api = await import(WREQ);
    lap('importMs');
    const s = await api.createSession(url.startsWith('https') ? { insecure: true } : {});
    lap('createMs');
    const r = await s.fetch(url);
    await r.arrayBuffer();
    lap('firstRequestMs');
    out.totalMs = performance.now() - t0;
    await s.close();
  } else {
    out.importMs = 0;
    out.createMs = 0;
    const r = await fetch(url);
    await r.arrayBuffer();
    lap('firstRequestMs');
    out.totalMs = performance.now() - t0;
  }
  out.rssMiB = process.memoryUsage().rss / 1048576;
  console.log(JSON.stringify(out));
  process.exit(0);
}
const child = (args) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const c = spawn(process.execPath, [process.argv[1], ...args], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', (code) =>
      code
        ? reject(Error(`child ${args} exit ${code}`))
        : resolve({ ...JSON.parse(out), processWallMs: performance.now() - started }),
    );
  });

// ---------------- parent ----------------
const { execSync } = await import('node:child_process');
const timeWait = () =>
  Number(execSync('netstat -an -p tcp | grep -c TIME_WAIT || true').toString().trim());
async function drain() {
  for (let i = 0; i < 80 && timeWait() > 1000; i++) await new Promise((r) => setTimeout(r, 500));
}
const srv = spawn('node', [new URL('./server.mjs', import.meta.url).pathname], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const info = await new Promise((resolve) => {
  let buf = '';
  srv.stdout.on('data', (d) => {
    buf += d;
    if (buf.includes('\n')) resolve(JSON.parse(buf));
  });
});
const report = {
  runtime,
  version: process.versions.bun ?? process.versions.node,
  durationMs: DURATION,
  samples: SAMPLES,
  cold: {},
  warm: {},
};
try {
  // ---- cold start ----
  for (const target of process.env.SKIP_COLD ? [] : ['plain', 'tls']) {
    await drain();
    const url = `${info[target]}/small`;
    const engines = target === 'plain' ? ['omreq', 'wreq-js', 'fetch'] : ['omreq', 'wreq-js'];
    const acc = Object.fromEntries(engines.map((e) => [e, []]));
    for (let i = 0; i < COLD_N; i++)
      for (const e of engines) acc[e].push(await child(['--cold', e, url, info.ca]));
    for (const e of engines)
      report.cold[`${target} ${e}`] = Object.fromEntries(
        ['importMs', 'createMs', 'firstRequestMs', 'totalMs', 'processWallMs', 'rssMiB'].map(
          (k) => [k, stats(acc[e].map((x) => x[k]))],
        ),
      );
    console.error('cold', target, 'done');
  }

  // ---- warm throughput ----
  const omreqApi = await import(OMREQ);
  const wreqApi = await import(WREQ);
  const omPlain = omreqApi.createClient();
  const omTls = omreqApi.createClient({ ca: info.ca });
  const wqPlain = await wreqApi.createSession();
  const wqTls = await wreqApi.createSession({ insecure: true });
  const post = Buffer.alloc(32, 1);
  const check = (cond, msg) => {
    if (!cond) throw Error(msg);
  };
  const om = (client) => ({
    get: async (url, len) => {
      const r = await client.get(url);
      try {
        check(r.status === 200 && (await r.bytes()).length === len, 'omreq bad');
      } finally {
        await r.dispose();
      }
    },
    post: async (url) => {
      const r = await client.request(url, {
        method: 'POST',
        body: post,
        headers: { 'content-type': 'application/octet-stream' },
      });
      try {
        check(r.status === 204, `omreq post ${r.status}`);
        await r.bytes();
      } finally {
        await r.dispose();
      }
    },
  });
  const wq = (session) => ({
    get: async (url, len) => {
      const r = await session.fetch(url);
      check(r.status === 200 && (await r.arrayBuffer()).byteLength === len, 'wreq bad');
    },
    post: async (url) => {
      const r = await session.fetch(url, {
        method: 'POST',
        body: post,
        headers: { 'content-type': 'application/octet-stream' },
      });
      check(r.status === 204, `wreq post ${r.status}`);
      await r.arrayBuffer();
    },
  });
  const nf = {
    get: async (url, len) => {
      const r = await fetch(url);
      check(r.status === 200 && (await r.arrayBuffer()).byteLength === len, 'fetch bad');
    },
    post: async (url) => {
      const r = await fetch(url, {
        method: 'POST',
        body: post,
        headers: { 'content-type': 'application/octet-stream' },
      });
      check(r.status === 204, 'fetch post');
      await r.arrayBuffer();
    },
  };
  const isolated = {
    omreq: async (url) => {
      const c = omreqApi.createClient();
      const r = await c.get(url);
      await r.bytes();
      await r.dispose();
      await c.close();
    },
    'wreq-js': async (url) => {
      const r = await wreqApi.fetch(url);
      await r.arrayBuffer();
    },
  };
  const P = info.plain;
  const T = info.tls;
  const scenarios = [
    {
      name: 'get.small (2 B)',
      run: (e) => e.get(`${P}/small`, 2),
      engines: { omreq: om(omPlain), 'wreq-js': wq(wqPlain), fetch: nf },
    },
    {
      name: 'get.4kb',
      run: (e) => e.get(`${P}/binary?len=4096`, 4096),
      engines: { omreq: om(omPlain), 'wreq-js': wq(wqPlain), fetch: nf },
    },
    {
      name: 'get.1mib',
      run: (e) => e.get(`${P}/binary?len=1048576`, 1048576),
      engines: { omreq: om(omPlain), 'wreq-js': wq(wqPlain), fetch: nf },
    },
    {
      name: 'post.32b',
      run: (e) => e.post(`${P}/echo-len?len=32`),
      engines: { omreq: om(omPlain), 'wreq-js': wq(wqPlain), fetch: nf },
    },
    {
      name: 'tls get.small (h2 ALPN)',
      run: (e) => e.get(`${T}/small`, 2),
      engines: { omreq: om(omTls), 'wreq-js': wq(wqTls) },
    },
    {
      name: 'tls get.4kb (h2 ALPN)',
      run: (e) => e.get(`${T}/binary?len=4096`, 4096),
      engines: { omreq: om(omTls), 'wreq-js': wq(wqTls) },
    },
    {
      name: 'isolated get.small (new connection per request)',
      run: (fn) => fn(`${P}/small`),
      engines: isolated,
      concurrency: [1],
    },
  ];
  const burst = async (fn, conc, ms) => {
    const lat = [];
    let done = 0;
    let errors = 0;
    let firstError = null;
    const end = performance.now() + ms;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: conc }, async () => {
        while (performance.now() < end) {
          const s = performance.now();
          try {
            await fn();
          } catch (e) {
            errors++;
            firstError ??= `${e.code ?? ''} ${e.message} ${e.cause?.code ?? ''}`;
            await new Promise((r) => setTimeout(r, 5));
            continue;
          }
          lat.push(performance.now() - s);
          done++;
        }
      }),
    );
    return { rps: (done * 1000) / (performance.now() - t0), lat, errors, firstError };
  };
  for (const sc of scenarios.filter(
    (x) => !process.env.ONLY || new RegExp(process.env.ONLY).test(x.name),
  )) {
    for (const conc of sc.concurrency ?? [1, 20]) {
      const names = Object.keys(sc.engines);
      for (const n of names) await burst(() => sc.run(sc.engines[n]), conc, 400); // warmup
      await drain();
      const rps = Object.fromEntries(names.map((n) => [n, []]));
      const errs = Object.fromEntries(names.map((n) => [n, { errors: 0, firstError: null }]));
      const lat = Object.fromEntries(names.map((n) => [n, []]));
      for (let i = 0; i < SAMPLES; i++) {
        const order = names.map((_, k) => names[(k + i) % names.length]);
        for (const n of order) {
          const r = await burst(() => sc.run(sc.engines[n]), conc, DURATION);
          rps[n].push(r.rps);
          errs[n].errors += r.errors;
          errs[n].firstError ??= r.firstError;
          for (const v of r.lat) if (lat[n].length < 300000) lat[n].push(v);
        }
      }
      for (const n of names) {
        report.warm[`${sc.name} | c=${conc} | ${n}`] = {
          rps: stats(rps[n]),
          latencyMs: stats(lat[n]),
          ...errs[n],
        };
        console.error(
          sc.name,
          `c=${conc}`,
          n,
          Math.round(stats(rps[n]).mean),
          'rps ±',
          stats(rps[n]).ci95pct,
          '%',
          'errors',
          errs[n].errors,
          errs[n].firstError ?? '',
        );
      }
    }
  }
  await Promise.all([omPlain.close(), omTls.close(), wqPlain.close(), wqTls.close()]);
} finally {
  srv.kill();
}
writeFileSync(process.env.OUT ?? '/dev/stdout', JSON.stringify(report, null, 2));
process.exit(0);
