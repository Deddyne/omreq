import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { fixture } from '../fixtures/server.mjs';
import { nativePackage } from './native-package.mjs';

const entry = new URL('../packages/omreq/dist/index.mjs', import.meta.url).href;
async function child(code, timeout = 4000, entryUrl = entry) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {createClient,getRuntimeInfo} from ${JSON.stringify(entryUrl)};\n${code}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    proc.stdout.on('data', (v) => (stdout += v));
    proc.stderr.on('data', (v) => (stderr += v));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(Error(`Subprocess deadline exceeded\n${stdout}\n${stderr}`));
    }, timeout);
    proc.on('error', reject);
    proc.on('exit', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}
test('T19: importing and idle initialized clients allow process exit', async () => {
  const a = await child('const c=createClient();console.log(getRuntimeInfo().nativeReady);');
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /false/);
  const s = await fixture();
  try {
    const b = await child(
      `const c=createClient();await(await c.get(${JSON.stringify(s.url)})).bytes();console.log('idle');`,
    );
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /idle/);
  } finally {
    await s.close();
  }
});
test('T19: active native operation keeps process alive until explicit close', async () => {
  const s = await fixture();
  try {
    const result = await child(
      `const c=createClient();const r=await c.get(${JSON.stringify(`${s.url}/slow`)});const read=r.bytes().catch(e=>console.log(e.code));setTimeout(()=>c.close(),100).unref();await read;await c.close();console.log('closed');`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ERR_CLIENT_CLOSED/);
    assert.match(result.stdout, /closed/);
  } finally {
    await s.close();
  }
});
test('T21: lazy missing/mismatched native errors in isolated packages', async () => {
  const require = createRequire(new URL('../packages/omreq/dist/index.js', import.meta.url));
  for (const kind of ['missing', 'mismatch', 'old-bridge', 'previous-bridge', 'linker']) {
    const dir = mkdtempSync(join(tmpdir(), 'omreq-loader-'));
    try {
      cpSync(new URL('../packages/omreq/dist/', import.meta.url), join(dir, 'dist'), {
        recursive: true,
      });
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      for (const dep of ['jsonc-parser'])
        symlinkSync(
          dirname(require.resolve(`${dep}/package.json`)),
          join(dir, 'node_modules', dep),
          'junction',
        );
      if (kind !== 'missing') {
        const native = join(dir, 'node_modules', nativePackage);
        mkdirSync(native, { recursive: true });
        writeFileSync(
          join(native, 'package.json'),
          JSON.stringify({ name: nativePackage, main: 'index.cjs' }),
        );
        writeFileSync(
          join(native, 'index.cjs'),
          kind === 'mismatch'
            ? 'exports.buildInfo=()=>JSON.stringify({version:"wrong",bridgeAbi:99,nodeApi:8});'
            : kind === 'old-bridge'
              ? 'exports.buildInfo=()=>JSON.stringify({version:"0.1.0",bridgeAbi:1,nodeApi:8,capabilities:[],bundledTrustStores:[]});'
              : kind === 'previous-bridge'
                ? 'exports.buildInfo=()=>JSON.stringify({version:"0.1.0",bridgeAbi:6,nodeApi:8,capabilities:[],bundledTrustStores:[]});'
                : 'throw new Error("dlopen failure");',
        );
      }
      const result = await child(
        `const c=createClient();console.log(c.getInfo().nativeReady);try{await c.get('http://127.0.0.1:1');}catch(e){console.log(e.code);}await c.close();`,
        4000,
        pathToFileURL(join(dir, 'dist/index.mjs')).href,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /false/);
      assert.match(
        result.stdout,
        new RegExp(
          {
            missing: 'ERR_NATIVE_NOT_FOUND',
            mismatch: 'ERR_NATIVE_VERSION_MISMATCH',
            'old-bridge': 'ERR_NATIVE_VERSION_MISMATCH',
            'previous-bridge': 'ERR_NATIVE_VERSION_MISMATCH',
            linker: 'ERR_NATIVE_LOAD',
          }[kind],
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
