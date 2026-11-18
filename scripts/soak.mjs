import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from '../fixtures/server.mjs';
import { createClient, getRuntimeInfo } from '../packages/omreq/dist/index.mjs';
import { artifactIdentity, sha256 } from './artifact-identity.mjs';

const identity = await artifactIdentity();
const harnessSha256 = sha256(readFileSync('scripts/soak.mjs'));
const server = await fixture({
  route(req, res) {
    if (req.url === '/soak-redirect') {
      req.resume();
      req.on('end', () => {
        res.writeHead(307, { location: '/echo', 'set-cookie': 'soak=accepted; Path=/' });
        res.end();
      });
      return true;
    }
    if (req.url !== '/buffered-stall') return false;
    res.writeHead(200);
    res.write(Buffer.alloc(32768, 0x61));
    return true;
  },
});
const samples = [];
const normalSources = { snapshot: 0, blob: 0, multipart: 0 };
function measure(label, cycle) {
  global.gc?.();
  let fds = null;
  try {
    fds = execFileSync('lsof', ['-p', String(process.pid), '-F', 'f'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => /^f\d+$/.test(l)).length;
  } catch {}
  return {
    label,
    cycle,
    memory: process.memoryUsage(),
    fds,
    fixtureSockets: server.stats.connections - server.stats.closed,
    resources: process.getActiveResourcesInfo(),
  };
}
function assertZero(c) {
  const s = c.getStats();
  for (const k of [
    'activeOperations',
    'queuedOperations',
    'openBodies',
    'nativeTasks',
    'uploadBridgeBytes',
    'downloadBridgeBytes',
    'retainedRequestBodyBytes',
    'bufferedResponseBytes',
    'originWaitOperations',
    'initializingOperations',
    'connections',
    'creatingConnections',
    'waitingConnections',
    'cookieCount',
    'cookieBytes',
  ])
    if (s[k] !== 0) throw Error(`Nonzero ${k}: ${JSON.stringify(s)}`);
  assert.deepEqual(s.origins, [], 'Origin metadata survived terminal cleanup');
  assert.deepEqual(s.connectionOrigins, [], 'Socket origin metadata survived shutdown');
}
try {
  for (const phase of ['normal', 'abort']) {
    for (let i = 0; i < 100; i++) {
      const c = createClient();
      await (await c.get(`${server.url}/empty`)).bytes();
      await c.close();
    }
    await delay(20);
    samples.push(measure(`${phase}-warm`, 0));
    for (let i = 1; i <= 10000; i++) {
      const c = createClient({ timeouts: { totalMs: 3000 } });
      try {
        if (phase === 'normal') {
          if (i % 3 === 1) {
            normalSources.snapshot++;
            await (await c.post(`${server.url}/echo`, { body: 'soak snapshot' })).bytes();
          } else {
            let body;
            if (i % 3 === 2) {
              normalSources.blob++;
              body = new Blob(['soak blob'], { type: 'text/plain' });
            } else {
              normalSources.multipart++;
              body = new FormData();
              body.append('text', 'soak multipart');
              body.append('file', new Blob(['soak blob']), 'soak.txt');
            }
            const response = await c.post(`${server.url}/soak-redirect`, { body });
            assert.equal(response.redirects.length, 1);
            const echo = await response.json();
            assert.equal(echo.headers.cookie, 'soak=accepted');
            assert(Buffer.from(echo.body, 'base64').includes(Buffer.from('soak blob')));
            assert.equal(c.getStats().cookieCount, 1);
          }
        } else {
          const controller = new AbortController();
          if (i % 2) {
            const arrived = server.wait('/headers-wait');
            const request = c
              .get(`${server.url}/headers-wait`, { signal: controller.signal })
              .catch((e) => e);
            await Promise.race([
              arrived,
              request.then((result) => {
                throw result;
              }),
            ]);
            controller.abort();
            const result = await request;
            if (result.code !== 'ERR_ABORTED') throw result;
          } else {
            const response = await c.get(`${server.url}/buffered-stall`, {
              signal: controller.signal,
            });
            const reading = response.bytes().catch((e) => e);
            for (
              let attempt = 0;
              c.getStats().bufferedResponseBytes === 0 && attempt < 100;
              attempt++
            )
              await delay(1);
            if (c.getStats().bufferedResponseBytes === 0)
              throw Error('Buffered abort did not reserve credits');
            controller.abort();
            const result = await reading;
            if (result.code !== 'ERR_ABORTED') throw result;
          }
        }
      } finally {
        await c.close();
      }
      assertZero(c);
      // Pace fresh connections so the harness does not exhaust macOS ephemeral ports.
      await delay(6);
      if (i % 1000 === 0) {
        await delay(20);
        const sample = measure(phase, i);
        samples.push(sample);
        console.log(phase, i, sample.memory.rss, sample.fds, sample.fixtureSockets);
      }
    }
  }
  const c = createClient();
  let received = 0,
    maxUpload = 0,
    maxDownload = 0,
    maxTasks = 0,
    maxRss = 0;
  const start = performance.now();
  try {
    const response = await c.get(`${server.url}/large`);
    for await (const chunk of response.body) {
      received += chunk.length;
      const s = c.getStats();
      maxUpload = Math.max(maxUpload, s.uploadBridgeBytes);
      maxDownload = Math.max(maxDownload, s.downloadBridgeBytes);
      maxTasks = Math.max(maxTasks, s.nativeTasks);
      maxRss = Math.max(maxRss, process.memoryUsage().rss);
      if (maxUpload > 65536 || maxDownload > 262144 || maxTasks > 3)
        throw Error('Bridge/task budget exceeded');
      if (received % 1048576 === 0) await delay(1);
    }
    if (received !== 1073741824) throw Error(`Expected 1 GiB; got ${received}`);
  } finally {
    await c.close();
  }
  assertZero(c);
  await delay(20);
  samples.push(measure('after-1gib', 10000));
  assert.deepEqual(
    await artifactIdentity(),
    identity,
    'Native or JavaScript artifact changed during soak',
  );
  assert.equal(
    sha256(readFileSync('scripts/soak.mjs')),
    harnessSha256,
    'Soak harness changed during measurement',
  );
  const report = {
    ...identity,
    harnessSha256,
    runtime: getRuntimeInfo(),
    recordedAt: new Date().toISOString(),
    cycles: { normal: 10000, abort: 10000 },
    normalSources,
    abortPhases: { headers: 5000, bufferedBody: 5000 },
    warmupPerPhase: 100,
    freshConnectionPacingMs: 6,
    stream: {
      bytes: received,
      durationMs: performance.now() - start,
      maxUploadBridgeBytes: maxUpload,
      maxDownloadBridgeBytes: maxDownload,
      maxNativeTasks: maxTasks,
      maxRss,
    },
    forcedGc: typeof global.gc === 'function',
    samples,
    assessment:
      'Own operation/bridge/initialization/origin/buffer-credit/TCP/cookie counters and origin/socket metadata returned to zero after every cycle. Normal cycles alternate byte snapshots, streaming Blob and streaming multipart; Blob/multipart replay across 307 observes an intermediate cookie. Full reads exercise native buffer-credit handles; half of aborts hold those credits. TCP capacity releases after socket drop. This is a development baseline; idle/protocol-task/DNS/decoder and final alpha resource acceptance remain open.',
  };
  mkdirSync('artifacts/qualification', { recursive: true });
  writeFileSync(
    `artifacts/qualification/soak-${process.versions.bun ? 'bun' : 'node'}.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
} finally {
  await server.close();
}
