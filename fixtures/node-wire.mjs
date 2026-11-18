// Keep the TLS peer implementation fixed across Node and Bun client tests:
// server-issued opaque tickets differ between OpenSSL and Bun's BoringSSL.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { http2WireFixture } from './http2-wire.mjs';

if (process.argv[2] === '--wire-server') {
  const fixture = await http2WireFixture(JSON.parse(process.argv[3]));
  const input = createInterface({ input: process.stdin });
  let closed = false;
  console.log(JSON.stringify({ ready: true, url: fixture.url, ca: fixture.ca }));
  for await (const line of input) {
    const { id, method, value } = JSON.parse(line);
    if (method === 'label') fixture.label(value);
    else if (method === 'snapshot') {
      console.log(
        JSON.stringify({
          id,
          value: {
            connections: fixture.connections.map(({ raw, ...record }) => record),
            handshakes: fixture.handshakes.map(({ raw, ...record }) => record),
          },
        }),
      );
      continue;
    } else if (method === 'close') {
      await fixture.close();
      closed = true;
      console.log(JSON.stringify({ id }));
      input.close();
      break;
    } else throw Error('Unknown fixture command');
    console.log(JSON.stringify({ id }));
  }
  // An interrupted parent must not leave listeners or sockets alive.
  if (!closed) await fixture.close();
}

export async function nodeWireFixture(options) {
  const child = spawn(
    'node',
    [fileURLToPath(import.meta.url), '--wire-server', JSON.stringify(options)],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let sequence = 0,
    stderr = '';
  const pending = new Map();
  const fail = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.on('error', fail);
  child.on('exit', () => fail(Error(`Node wire fixture exited: ${stderr}`)));
  const waiting = (id) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        child.kill('SIGKILL');
        reject(Error('Node wire fixture deadline'));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
    });
  const ready = waiting(0);
  const output = createInterface({ input: child.stdout });
  output.on('line', (line) => {
    const message = JSON.parse(line);
    const id = message.ready ? 0 : message.id;
    const request = pending.get(id);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(id);
      request.resolve(message.ready ? message : message.value);
    }
  });
  const call = (method, value) => {
    const id = ++sequence;
    const result = waiting(id);
    child.stdin.write(`${JSON.stringify({ id, method, value })}\n`);
    return result;
  };
  const info = await ready;
  let closed;
  return {
    url: info.url,
    ca: info.ca,
    label: (value) => call('label', value),
    snapshot: () => call('snapshot'),
    close() {
      closed ??= (async () => {
        try {
          await call('close');
        } finally {
          child.stdin.end();
          output.close();
          child.kill('SIGTERM');
        }
      })();
      return closed;
    },
  };
}
