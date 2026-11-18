import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { artifactIdentity, sha256 } from './artifact-identity.mjs';

const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
const entry = new URL('../packages/omreq/dist/index.mjs', import.meta.url).href;
const runtime = process.versions.bun ? 'bun' : 'node';
const uploadChunk = Buffer.alloc(65536, 0x75);
const downloadChunk = Buffer.alloc(65536, 0x64);
const acknowledgement = Buffer.from('upload complete\n');
const protocols = ['h1', 'h1-tls', 'h2-tls'];
const engines = ['omreq', 'runtime-lowlevel'];
const expectedVersion = (protocol) => (protocol === 'h2-tls' ? '2' : '1.1');

function configuration(args) {
  const config = {
    iterations: 100,
    warmup: 20,
    rounds: 3,
    cold: 20,
    concurrency: [1, 8],
    seed: 20261115,
  };
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, '');
    assert(Object.hasOwn(config, name), `Unknown argument ${args[i]}; use --help`);
    const values = String(args[i + 1] ?? '')
      .split(',')
      .map(Number);
    assert(
      values.every((n) => Number.isSafeInteger(n) && n >= 1),
      `${args[i]} requires positive integers`,
    );
    assert(name === 'concurrency' || values.length === 1, `${args[i]} accepts one integer`);
    config[name] = name === 'concurrency' ? [...new Set(values)] : values[0];
  }
  assert(
    config.concurrency.every((n) => n <= 8),
    'This matched pool configuration supports concurrency 1–8',
  );
  assert(
    config.iterations <= 100000 && config.rounds <= 100 && config.cold <= 1000,
    'Excessive benchmark repetition count',
  );
  assert(config.warmup <= 100000 && config.seed <= 0xffffffff, 'Invalid warmup or seed');
  return config;
}

function quantiles(values) {
  if (!values.length)
    return { count: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
  return {
    count: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1),
    mean: sorted.reduce((sum, n) => sum + n, 0) / sorted.length,
  };
}

function shuffled(values, seed) {
  const result = [...values];
  let state = seed >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function fdCount() {
  try {
    if (process.platform === 'linux')
      return { count: readdirSync('/proc/self/fd').length, method: '/proc/self/fd' };
    const output = execFileSync('lsof', ['-a', '-p', String(process.pid), '-F', 'f'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return {
      count: output.split('\n').filter((line) => /^f\d+$/.test(line)).length,
      method: 'lsof numeric descriptors',
    };
  } catch {
    return { count: null, method: 'unavailable' };
  }
}

function hardware() {
  let macOS = null;
  if (process.platform === 'darwin') {
    const inspect = (bin, args) =>
      execFileSync(bin, args, { encoding: 'utf8', timeout: 2000 }).trim();
    macOS = {
      version: inspect('sw_vers', ['-productVersion']),
      model: inspect('sysctl', ['-n', 'hw.model']),
    };
  }
  return {
    platform: process.platform,
    architecture: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    osVersion: os.version(),
    macOS,
    cpu: os.cpus().map(({ model, speed }) => ({ model, reportedMHz: speed })),
    logicalCpus: os.cpus().length,
    availableParallelism: os.availableParallelism?.() ?? null,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytesAtStart: os.freemem(),
    loadAverageAtStart: os.loadavg(),
  };
}

async function* uploadSource(bytes) {
  for (let remaining = bytes; remaining > 0; remaining -= uploadChunk.length)
    yield uploadChunk.subarray(0, Math.min(remaining, uploadChunk.length));
}

function route(req, res) {
  const match = /^\/bench\/(download|upload)\/(\d+)$/.exec(req.url);
  if (!match) return false;
  const [, kind, size] = match;
  const bytes = Number(size);
  assert(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 1048576);
  const respond = (bodyBytes, extra = {}) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': bodyBytes,
      'x-bench-http-version': req.httpVersion === '2.0' ? '2' : req.httpVersion,
      ...extra,
    });
  };
  if (kind === 'upload') {
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
    });
    req.on('end', () => {
      assert.equal(received, bytes, 'Fixture received an incomplete upload');
      respond(acknowledgement.length, { 'x-bench-upload-bytes': received });
      res.end(acknowledgement);
    });
  } else {
    req.resume();
    respond(bytes);
    let remaining = bytes;
    const write = () => {
      while (remaining > 0 && !res.destroyed) {
        const chunk = downloadChunk.subarray(0, Math.min(remaining, downloadChunk.length));
        remaining -= chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', write);
          return;
        }
      }
      if (!res.destroyed) res.end();
    };
    write();
  }
  return true;
}

const pathFor = (scenario) => `/bench/${scenario.kind}/${scenario.payloadBytes}`;
const responseBytesFor = (scenario) =>
  scenario.kind === 'upload' ? acknowledgement.length : scenario.payloadBytes;
const uploadBytesFor = (scenario) => (scenario.kind === 'upload' ? scenario.payloadBytes : 0);

async function loadEngine(engine, protocol) {
  return engine === 'omreq'
    ? await import(entry)
    : await import(
        protocol === 'h2-tls' ? 'node:http2' : protocol === 'h1-tls' ? 'node:https' : 'node:http'
      );
}

function profileFor(api, protocol) {
  return api.defineProfile({
    ...api.getProfile('omreq/custom-default'),
    transport: { httpVersion: expectedVersion(protocol) },
  });
}

function verifyResponse(version, status, header, bytes, protocol, scenario) {
  assert.equal(version, expectedVersion(protocol), 'Client negotiated the wrong HTTP protocol');
  assert.equal(status, 200);
  assert.equal(
    String(header('x-bench-http-version')),
    expectedVersion(protocol),
    'Fixture observed the wrong protocol',
  );
  assert.equal(bytes, responseBytesFor(scenario), 'Response byte count differs');
  if (scenario.kind === 'upload')
    assert.equal(
      String(header('x-bench-upload-bytes')),
      String(scenario.payloadBytes),
      'Upload byte count differs',
    );
}

async function consume(stream) {
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.length;
  return bytes;
}

async function writeBody(stream, scenario) {
  if (scenario.kind === 'upload')
    for await (const chunk of uploadSource(scenario.payloadBytes)) {
      if (!stream.write(chunk))
        await new Promise((resolve, reject) => {
          const drain = () => {
            clear();
            resolve();
          };
          const error = (failure) => {
            clear();
            reject(failure);
          };
          const close = () => {
            clear();
            reject(Error('Upload stream closed before drain'));
          };
          const clear = () => {
            stream.off('drain', drain);
            stream.off('error', error);
            stream.off('close', close);
          };
          stream.once('drain', drain);
          stream.once('error', error);
          stream.once('close', close);
        });
    }
  stream.end();
}

function createAdapter(engine, protocol, url, ca, module) {
  if (engine === 'omreq') {
    const client = module.createClient({
      profile: profileFor(module, protocol),
      ca,
      maxConnections: 8,
      maxConnectionsPerOrigin: 8,
      timeouts: { totalMs: 10000 },
    });
    return {
      initialize: async () => {
        await client.cookies.getCookies(url);
      },
      info: () => client.getInfo(),
      stats: () => client.getStats(),
      async request(scenario) {
        const response = await client.request(url + pathFor(scenario), {
          method: scenario.kind === 'upload' ? 'POST' : 'GET',
          ...(scenario.kind === 'upload' ? { body: uploadSource(scenario.payloadBytes) } : {}),
        });
        try {
          const bytes = await consume(response.body);
          verifyResponse(
            response.httpVersion,
            response.status,
            (name) => response.headers.get(name),
            bytes,
            protocol,
            scenario,
          );
        } finally {
          await response.dispose();
        }
      },
      async close() {
        await client.close();
        const stats = client.getStats();
        for (const name of [
          'activeOperations',
          'queuedOperations',
          'openBodies',
          'nativeTasks',
          'uploadBridgeBytes',
          'downloadBridgeBytes',
          'retainedRequestBodyBytes',
          'bufferedResponseBytes',
          'connections',
          'creatingConnections',
          'waitingConnections',
          'cookieCount',
          'cookieBytes',
        ])
          assert.equal(stats[name], 0, `Native ${name} survived close`);
        assert.deepEqual(stats.origins, []);
        assert.deepEqual(stats.connectionOrigins, []);
      },
    };
  }
  if (protocol === 'h2-tls') {
    let session,
      activeStreams = 0;
    const getSession = () => {
      if (!session) {
        session = module.connect(url, { ca, rejectUnauthorized: true, ALPNProtocols: ['h2'] });
        // Individual requests own their failures; avoid an unhandled session error.
        session.on('error', () => {});
      }
      return session;
    };
    return {
      initialize: async () => {},
      info: () => ({ api: 'node:http2.connect', certificateVerification: true }),
      stats: () => ({
        activeStreams,
        sessionClosed: !session || session.closed || session.destroyed,
        state: session && !session.destroyed ? session.state : null,
      }),
      async request(scenario) {
        const transport = getSession();
        const request = transport.request({
          ':path': pathFor(scenario),
          ':method': scenario.kind === 'upload' ? 'POST' : 'GET',
        });
        activeStreams++;
        const timeout = setTimeout(
          () => request.destroy(Error('HTTP2 benchmark request deadline exceeded')),
          10000,
        );
        const reading = new Promise((resolve, reject) => {
          request.once('error', reject);
          request.once('response', async (headers) => {
            try {
              const bytes = await consume(request);
              assert.equal(transport.alpnProtocol, 'h2');
              verifyResponse(
                '2',
                headers[':status'],
                (name) => headers[name],
                bytes,
                protocol,
                scenario,
              );
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });
        try {
          await Promise.all([
            reading,
            scenario.kind === 'upload' ? writeBody(request, scenario) : Promise.resolve(),
          ]);
        } finally {
          clearTimeout(timeout);
          request.close();
          activeStreams--;
        }
      },
      async close() {
        if (!session || session.destroyed) return;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            session.destroy();
            reject(Error('HTTP2 session cleanup deadline exceeded'));
          }, 5000);
          session.once('close', () => {
            clearTimeout(timeout);
            resolve();
          });
          session.close();
        });
        assert.equal(activeStreams, 0);
      },
    };
  }
  const agent = new module.Agent({
    keepAlive: true,
    maxSockets: 8,
    maxFreeSockets: 2,
    ...(ca ? { ca, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] } : {}),
  });
  const sockets = (groups) => Object.values(groups).flat();
  return {
    initialize: async () => {},
    info: () => ({
      api: protocol === 'h1-tls' ? 'node:https.request' : 'node:http.request',
      certificateVerification: protocol === 'h1-tls',
    }),
    stats: () => ({
      activeSockets: sockets(agent.sockets).length,
      freeSockets: sockets(agent.freeSockets).length,
      queuedRequests: sockets(agent.requests).length,
    }),
    async request(scenario) {
      let request;
      const reading = new Promise((resolve, reject) => {
        request = module.request(
          url + pathFor(scenario),
          { agent, method: scenario.kind === 'upload' ? 'POST' : 'GET' },
          async (response) => {
            try {
              const bytes = await consume(response);
              verifyResponse(
                response.httpVersion,
                response.statusCode,
                (name) => response.headers[name],
                bytes,
                protocol,
                scenario,
              );
              resolve();
            } catch (error) {
              reject(error);
            }
          },
        );
        request.once('error', reject);
      });
      const timeout = setTimeout(
        () => request.destroy(Error('HTTP1 benchmark request deadline exceeded')),
        10000,
      );
      try {
        await Promise.all([reading, writeBody(request, scenario)]);
      } finally {
        clearTimeout(timeout);
        if (!request.writableFinished) request.destroy();
      }
    },
    async close() {
      const closed = sockets(agent.sockets)
        .concat(sockets(agent.freeSockets))
        .map(
          (socket) =>
            new Promise((resolve) => {
              if (socket.closed) return resolve();
              socket.once('close', resolve);
            }),
        );
      agent.destroy();
      await Promise.all(closed);
    },
  };
}

function sampler(adapter) {
  const started = performance.now();
  let previous = started;
  let ticks = 0;
  const lag = [],
    samples = [];
  const sample = () =>
    samples.push({
      elapsedMs: performance.now() - started,
      memory: process.memoryUsage(),
      client: adapter.stats(),
    });
  sample();
  const timer = setInterval(() => {
    const now = performance.now();
    lag.push(Math.max(0, now - previous - 10));
    previous = now;
    if (++ticks % 5 === 0) sample();
  }, 10);
  return () => {
    clearInterval(timer);
    sample();
    const memoryKeys = Object.keys(samples[0].memory);
    const counterKeys = Object.keys(samples[0].client).filter(
      (key) => typeof samples[0].client[key] === 'number',
    );
    return {
      eventLoopDelayMs: quantiles(lag),
      sampledPeakRssBytes: Math.max(...samples.map(({ memory }) => memory.rss)),
      sampledMemoryMaxima: Object.fromEntries(
        memoryKeys.map((key) => [key, Math.max(...samples.map(({ memory }) => memory[key]))]),
      ),
      sampledClientCounterMaxima: Object.fromEntries(
        counterKeys.map((key) => [key, Math.max(...samples.map(({ client }) => client[key]))]),
      ),
      samples,
    };
  };
}

async function requests(adapter, scenario, count, concurrency) {
  let next = 0;
  const times = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, async () => {
      while (next++ < count) {
        const started = performance.now();
        await adapter.request(scenario);
        times.push(performance.now() - started);
      }
    }),
  );
  assert.equal(times.length, count);
  return times;
}

async function warmCase(
  { engine, protocol, scenario, concurrency, round },
  config,
  server,
  module,
) {
  const adapter = createAdapter(engine, protocol, server.url, server.ca, module);
  const warmup = Math.max(config.warmup, concurrency);
  let result;
  try {
    await adapter.initialize();
    await requests(adapter, scenario, warmup, concurrency);
    const before = {
      memory: process.memoryUsage(),
      fds: fdCount(),
      fixtureConnections: server.stats.connections,
      fixtureOpenSockets: server.stats.connections - server.stats.closed,
      client: adapter.stats(),
    };
    const stopSampling = sampler(adapter);
    const cpu = process.cpuUsage();
    const started = performance.now();
    let samples, cpuUsage, durationMs, latencies;
    try {
      latencies = await requests(adapter, scenario, config.iterations, concurrency);
    } finally {
      durationMs = performance.now() - started;
      cpuUsage = process.cpuUsage(cpu);
      samples = stopSampling();
    }
    const after = {
      memory: process.memoryUsage(),
      fds: fdCount(),
      fixtureConnections: server.stats.connections,
      fixtureOpenSockets: server.stats.connections - server.stats.closed,
      client: adapter.stats(),
    };
    const newConnections = after.fixtureConnections - before.fixtureConnections;
    if (concurrency === 1 || protocol === 'h2-tls')
      assert.equal(
        newConnections,
        0,
        'Serial warm reuse / shared HTTP2 unexpectedly opened a new TCP connection',
      );
    result = {
      engine,
      protocol,
      scenario: scenario.name,
      payloadBytes: scenario.payloadBytes,
      concurrency,
      round,
      warmupRequests: warmup,
      requests: config.iterations,
      durationMs,
      latencyMs: quantiles(latencies),
      rawLatencyMs: latencies,
      throughput: {
        requestsPerSecond: (config.iterations * 1000) / durationMs,
        downloadedMiBPerSecond:
          (responseBytesFor(scenario) * config.iterations * 1000) / durationMs / 1048576,
        uploadedMiBPerSecond:
          (uploadBytesFor(scenario) * config.iterations * 1000) / durationMs / 1048576,
      },
      cpuUsageMicroseconds: cpuUsage,
      cpuCoreEquivalentPercent: ((cpuUsage.user + cpuUsage.system) / (durationMs * 1000)) * 100,
      ...samples,
      newConnections,
      before,
      after,
      clientInfo: adapter.info(),
    };
  } finally {
    await adapter.close();
  }
  await delay(0);
  result.afterClose = {
    memory: process.memoryUsage(),
    fds: fdCount(),
    client: adapter.stats(),
    fixtureOpenSockets: server.stats.connections - server.stats.closed,
  };
  return result;
}

async function coldChild({ engine, protocol, url, ca }) {
  const before = { memory: process.memoryUsage(), cpu: process.cpuUsage() };
  const phases = {},
    memory = {};
  let started = performance.now();
  const module = await loadEngine(engine, protocol);
  phases.importMs = performance.now() - started;
  memory.afterImport = process.memoryUsage();
  phases.nativeLoadAndProfileCheckMs = null;
  if (engine === 'omreq') {
    started = performance.now();
    await module.checkProfile(profileFor(module, protocol));
    phases.nativeLoadAndProfileCheckMs = performance.now() - started;
    memory.afterNativeLoad = process.memoryUsage();
  }
  started = performance.now();
  const adapter = createAdapter(engine, protocol, url, ca, module);
  phases.clientConstructionMs = performance.now() - started;
  try {
    started = performance.now();
    await adapter.initialize();
    phases.clientInitializationMs = performance.now() - started;
    memory.afterInitialization = process.memoryUsage();
    started = performance.now();
    await adapter.request({ name: 'small-download', kind: 'download', payloadBytes: 1024 });
    phases.firstRequestMs = performance.now() - started;
    memory.afterFirstRequest = process.memoryUsage();
  } finally {
    await adapter.close();
  }
  console.log(
    JSON.stringify({
      engine,
      protocol,
      phases,
      memory,
      before,
      cpuUsageMicroseconds: process.cpuUsage(before.cpu),
      afterClose: { memory: process.memoryUsage(), fds: fdCount(), client: adapter.stats() },
      clientInfo: adapter.info(),
    }),
  );
}

async function coldSample(input) {
  const started = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--cold-child', JSON.stringify(input)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error(`Cold benchmark deadline exceeded: ${stderr}`));
    }, 30000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      if (status !== 0)
        return reject(Error(`Cold benchmark failed (${status}/${signal}): ${stderr}\n${stdout}`));
      try {
        resolve({ ...JSON.parse(stdout), processWallMs: performance.now() - started, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
  return result;
}

async function main() {
  process.chdir(root);
  const config = configuration(process.argv.slice(2));
  const identity = await artifactIdentity();
  const harnessSha256 = sha256(readFileSync(script));
  const fixtureSha256 = sha256(readFileSync('fixtures/server.mjs'));
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const machine = hardware();
  const { fixture } = await import('../fixtures/server.mjs');
  const plain = await fixture({ route });
  let secure;
  const warm = [],
    cold = [];
  try {
    secure = await fixture({ tls: true, route });
    const serverFor = (protocol) => (protocol === 'h1' ? plain : secure);
    for (let repetition = 0; repetition < config.cold; repetition++)
      for (const { engine, protocol } of shuffled(
        protocols.flatMap((protocol) => engines.map((engine) => ({ engine, protocol }))),
        config.seed + repetition,
      )) {
        const server = serverFor(protocol);
        cold.push({
          repetition,
          ...(await coldSample({ engine, protocol, url: server.url, ca: server.ca })),
        });
      }
    console.log(`Cold process samples completed: ${cold.length}`);
    const scenarios = [
      { name: 'small-download', kind: 'download', payloadBytes: 1024 },
      { name: 'one-mib-download', kind: 'download', payloadBytes: 1048576 },
      { name: 'one-mib-streaming-upload', kind: 'upload', payloadBytes: 1048576 },
    ];
    for (let round = 0; round < config.rounds; round++) {
      const cases = protocols.flatMap((protocol) =>
        engines.flatMap((engine) =>
          scenarios.flatMap((scenario) =>
            config.concurrency.map((concurrency) => ({
              engine,
              protocol,
              scenario,
              concurrency,
              round,
            })),
          ),
        ),
      );
      for (const item of shuffled(cases, config.seed + 10000 + round)) {
        const module = await loadEngine(item.engine, item.protocol);
        warm.push(await warmCase(item, config, serverFor(item.protocol), module));
        console.log(
          `Measured ${item.engine} ${item.protocol} ${item.scenario.name} concurrency=${item.concurrency} round=${round + 1}`,
        );
      }
    }
  } finally {
    await Promise.all([plain.close(), secure?.close()]);
  }
  assert.deepEqual(
    await artifactIdentity(),
    identity,
    'Native/JS artifacts changed during benchmarks',
  );
  assert.equal(
    sha256(readFileSync(script)),
    harnessSha256,
    'Benchmark harness changed during measurement',
  );
  assert.equal(
    sha256(readFileSync('fixtures/server.mjs')),
    fixtureSha256,
    'Benchmark fixture changed during measurement',
  );
  const api = await import(entry);
  const report = {
    schemaVersion: 1,
    status: 'development-baseline-only',
    recordedAt: new Date().toISOString(),
    startedAt,
    durationMs: performance.now() - started,
    ...identity,
    harnessSha256,
    fixtureSha256,
    runtime: api.getRuntimeInfo(),
    runtimeVersions: process.versions,
    command: [process.execPath, ...process.execArgv, script, ...process.argv.slice(2)],
    hardware: machine,
    configuration: config,
    methodology: {
      topology:
        'Client and loopback fixture share one process for warm cases; cold clients run in fresh subprocesses against the parent fixture.',
      protocolMatching:
        'Plain HTTP1.1, TLS HTTP1.1 and TLS HTTP2 are measured separately; client metadata, fixture protocol and upload/download byte counts are asserted for every request.',
      certificateVerification:
        'Enabled for both clients, using only the supplied fixture CA in the low-level baseline and additive fixture CA in Omreq; target IP SAN is checked.',
      profile:
        'Custom default with explicit HTTP version, no Chrome-fidelity claim; empty automatic cookie jar; no compressed data or redirects.',
      pools: {
        maxSockets: 8,
        maxSocketsPerOrigin: 8,
        maxIdlePerOrigin: 2,
        HTTP2: 'One shared session per client; requested concurrency 1–8',
      },
      warmup:
        'Initialized client and primed pool before measurement; parallel HTTP1 may open sockets after idle-cap reduction, and all new TCP connections are reported. Serial reuse and HTTP2 reuse must open none.',
      ordering:
        'One case at a time; deterministic seeded shuffle of cases each round and client/protocol pairs each cold repetition.',
      latency:
        'Full upload (when applicable) and consumed response body per operation; nearest-rank quantiles, raw values retained. Small sample p99 is descriptive, not a statistical confidence bound.',
      cpu: 'Warm CPU includes client, native workers, fixture and harness in the measured process. Cold CPU is client subprocess only. Core-equivalent percent may exceed 100.',
      memory:
        'RSS/heap/external are process-wide. Sampled memory and own client counters every ~50ms, plus endpoints; sampled peaks can miss shorter spikes. No forced GC.',
      eventLoop:
        'Nonnegative lateness of a 10ms interval in the client process; empty sample sets remain null. Instrumentation overhead is included.',
      descriptors:
        'FD counts before/after cases and after close are collected outside timed request loops; fixture socket counts are separate.',
      coldPhases:
        'Import from fresh process cache; Omreq native load plus profile validation via checkProfile; synchronous client construction; lazy client initialization via empty getCookies; then first complete request on a fresh TCP connection. Loopback IP does not benchmark remote DNS. Process wall includes reporting and exit, not only startup.',
      baseline:
        'node:http, node:https and node:http2 low-level APIs from the current runtime; Bun results use Bun compatibility implementations, not a separate Node process.',
      acceptance:
        'No timing threshold or performance-quality claim. Use repeated runs on a fixed, otherwise idle machine before choosing a regression baseline.',
    },
    coldSummary: protocols.flatMap((protocol) =>
      engines.map((engine) => {
        const samples = cold.filter(
          (sample) => sample.protocol === protocol && sample.engine === engine,
        );
        return {
          engine,
          protocol,
          phases: Object.fromEntries(
            [
              'importMs',
              'nativeLoadAndProfileCheckMs',
              'clientConstructionMs',
              'clientInitializationMs',
              'firstRequestMs',
            ].map((phase) => [
              phase,
              quantiles(
                samples.map((sample) => sample.phases[phase]).filter((value) => value !== null),
              ),
            ]),
          ),
          processWallMs: quantiles(samples.map((sample) => sample.processWallMs)),
        };
      }),
    ),
    cold,
    warm,
    remaining: [
      'Rust core without N-API baseline',
      'Bridge transition/copy instrumentation independent of transport work',
      'Simultaneous duplex and early-response upload measurements',
      'Slow consumer and decompression scenarios',
      'Multi-origin and final alpha/minimum-OS runs',
      'Independent repeated-machine baseline review and regression limits',
    ],
  };
  await mkdir('artifacts/benchmarks', { recursive: true });
  const destination = join('artifacts/benchmarks', `${runtime}.json`);
  const staging = `${destination}.${process.pid}.staging`;
  await writeFile(staging, `${JSON.stringify(report, null, 2)}\n`);
  await rename(staging, destination);
  console.log(`Saved ${destination}; development baseline only`);
}

if (process.argv[2] === '--help') {
  console.log(
    'Usage: node scripts/benchmark.mjs [--iterations 100] [--warmup 20] [--rounds 3] [--cold 20] [--concurrency 1,8] [--seed 20261115]\nRun Bun with the same arguments. Run each runtime sequentially on an otherwise idle machine. Smoke checks can use --iterations 2 --warmup 1 --rounds 1 --cold 1 --concurrency 1. Results are written to artifacts/benchmarks/{node,bun}.json.',
  );
} else if (process.argv[2] === '--cold-child') {
  await coldChild(JSON.parse(process.argv[3]));
} else {
  await main();
}
