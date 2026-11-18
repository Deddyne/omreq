// Controlled local qualification only. This records first-flight TLS, not browser fidelity.

import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { launchReferenceChrome } from '../fixtures/chrome.mjs';
import { normalizedClientHello, parseClientHello } from '../fixtures/clienthello.mjs';
import { createClient, getRuntimeInfo, parseProfile } from '../packages/omreq/dist/index.mjs';

const out = process.argv[3] ?? 'artifacts/qualification/reference';
const profile = process.argv[2] ? parseProfile(await readFile(process.argv[2], 'utf8')) : undefined;
await mkdir(out, { recursive: true });
async function capture(run) {
  let resolve;
  const first = new Promise((r) => {
    resolve = r;
  });
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let all = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      all = Buffer.concat([all, chunk]);
      if (all.length > 65536) {
        socket.destroy();
        return;
      }
      const parsed = parseClientHello(all);
      if (parsed) {
        resolve({ raw: all, parsed });
        socket.destroy();
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `https://localhost:${server.address().port}/`;
  let stop;
  let timer;
  try {
    stop = await run(url);
    return await Promise.race([
      first,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('No ClientHello before deadline')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await stop?.();
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  }
}
const reference = await capture(async (url) => {
  const browser = await launchReferenceChrome({ headless: false });
  void browser.navigate(url).catch(() => {});
  return () => browser.close();
});
const client = createClient({
  ...(profile ? { profile, trustStore: 'chromium' } : {}),
  timeouts: { totalMs: 5000 },
});
const candidate = await capture(async (url) => {
  void client
    .get(url)
    .then((r) => r.dispose())
    .catch(() => {});
  return () => client.close();
});
await writeFile(join(out, 'chrome-clienthello.bin'), reference.raw);
await writeFile(join(out, 'custom-clienthello.bin'), candidate.raw);
const isGrease = (n) => (n & 0x0f0f) === 0x0a0a && ((n >> 8) & 255) === (n & 255);
const ids = (h) => h.extensions.map((e) => e.id).filter((n) => !isGrease(n));
const report = {
  capturedAt: new Date().toISOString(),
  scenario:
    'First connection to controlled loopback TCP listener; no TLS session, no external origin, no browser certificate bypass',
  chromeVersion: execFileSync(
    'defaults',
    ['read', '/Applications/Google Chrome.app/Contents/Info', 'CFBundleShortVersionString'],
    { encoding: 'utf8' },
  ).trim(),
  runtime: getRuntimeInfo(),
  reference: reference.parsed,
  candidate: candidate.parsed,
  comparison: {
    referenceOnlyExtensions: ids(reference.parsed).filter(
      (id) => !ids(candidate.parsed).includes(id),
    ),
    candidateOnlyExtensions: ids(candidate.parsed).filter(
      (id) => !ids(reference.parsed).includes(id),
    ),
  },
  normalizedReference: normalizedClientHello(reference.parsed),
  normalizedCandidate: normalizedClientHello(candidate.parsed),
  tlsFirstFlightMatch:
    JSON.stringify(normalizedClientHello(reference.parsed)) ===
    JSON.stringify(normalizedClientHello(candidate.parsed)),
  qualification:
    'TLS first-flight comparison only; full browser profile qualification requires HTTP/2 and headers',
  limitations: [
    'Only first-flight TLS collected. HTTP/2 and request-header comparison against Chrome remain required.',
    'Differences identify missing adapter coverage; they do not prove that the underlying engine cannot express it.',
    'No chrome alias or verified manifest is shipped.',
  ],
};
await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    chromeVersion: report.chromeVersion,
    tlsFirstFlightMatch: report.tlsFirstFlightMatch,
    referenceBytes: reference.parsed.clientHelloBytes,
    candidateBytes: candidate.parsed.clientHelloBytes,
    out,
  }),
);
if (profile && !report.tlsFirstFlightMatch) process.exitCode = 1;
