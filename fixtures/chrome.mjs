import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function launchReferenceChrome({
  spki,
  headless = true,
  language = 'en-US,en',
  extraArgs = [],
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'omreq-reference-cdp-'));
  const child = spawn(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    [
      ...(headless
        ? ['--headless=new']
        : ['--no-startup-window', '--window-position=-10000,-10000', '--window-size=800,600']),
      `--accept-lang=${language}`,
      '--lang=en-US',
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      ...(spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : []),
      `--user-data-dir=${dir}`,
      ...extraArgs,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true },
  );
  let sequence = 0;
  let buffered = Buffer.alloc(0);
  const pending = new Map();
  const waiters = [];
  const rejectAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.on('error', rejectAll);
  child.on('exit', () => rejectAll(Error('Reference Chrome exited')));
  child.stdio[4].on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.includes(0)) {
      const end = buffered.indexOf(0);
      const message = JSON.parse(buffered.subarray(0, end).toString());
      buffered = buffered.subarray(end + 1);
      if (message.id) {
        const request = pending.get(message.id);
        if (request) {
          clearTimeout(request.timer);
          pending.delete(message.id);
          if (message.error) request.reject(Error(JSON.stringify(message.error)));
          else request.resolve(message.result);
        }
      } else
        for (const waiter of [...waiters])
          if (waiter.method === message.method && waiter.sessionId === message.sessionId) {
            waiters.splice(waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(message.params);
          }
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`CDP deadline: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdio[3].write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  const wait = (method, sessionId) =>
    new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve, timer: undefined };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(Error(`CDP event deadline: ${method}`));
      }, 15000);
      waiters.push(waiter);
    });
  const version = await send('Browser.getVersion');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  return {
    version,
    async navigate(url) {
      const loaded = wait('Page.loadEventFired', sessionId);
      const result = await send('Page.navigate', { url }, sessionId);
      if (result.errorText) throw Error(result.errorText);
      await loaded;
    },
    async close() {
      try {
        await send('Browser.close');
      } catch {}
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      rejectAll(Error('Reference Chrome closed'));
      for (const waiter of waiters) clearTimeout(waiter.timer);
      if (child.exitCode === null)
        await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 1000))]);
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
